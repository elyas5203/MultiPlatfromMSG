/**
 * Campaign Management & Execution Service (Phase 7)
 *
 * Implements end-to-end campaign lifecycle:
 * - Audience resolution & strict suppression list exclusion
 * - Two-phase financial credit reservation & settlement with Billing
 * - Batching and dispatching via DispatcherService & SenderRoutingEngine
 * - Real-time Kill Switch checks, pause, resume, and cancellation
 */

import { Injectable, Logger } from '@nestjs/common';
import { assertValidTenantId } from '../tenant/tenant-scope';
import {
  Campaign,
  CampaignBatch,
  CampaignStatus,
  TargetCriteria,
  CampaignExecutionReport,
  CampaignProgress,
  CampaignNotFoundError,
  CampaignStateError,
  AudienceEmptyError,
} from './types';
import {
  CreateCampaignDto,
  UpdateCampaignDto,
  ScheduleCampaignDto,
  ExecuteCampaignDto,
  ListCampaignsFilterDto,
} from './dto/campaign.dto';
import { CampaignRepository } from './campaign.repository';
import { ContactsRepository } from '../contacts/contacts.repository';
import { BillingRepository } from '../billing/billing.repository';
import { DispatcherService } from '../messaging/dispatcher.service';
import { SenderRoutingEngine } from '../senders/routing-engine';
import { KillSwitchService } from '../messaging/kill-switch.service';
import { Contact } from '@prisma/client';
import { MessageQueueEnvelope } from '../messaging/queue.types';
import { randomUUID } from 'crypto';

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private readonly campaignRepo: CampaignRepository,
    private readonly contactsRepo: ContactsRepository,
    private readonly billingRepo: BillingRepository,
    private readonly dispatcherService: DispatcherService,
    private readonly routingEngine: SenderRoutingEngine,
    private readonly killSwitchService: KillSwitchService,
  ) {}

  public async createCampaign(tenantId: unknown, dto: CreateCampaignDto): Promise<Campaign> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!dto.title || dto.title.trim().length === 0) {
      throw new Error('Campaign title is required.');
    }
    if (!dto.channel) {
      throw new Error('Campaign channel is required.');
    }
    if (!dto.templateText || dto.templateText.trim().length === 0) {
      throw new Error('Campaign templateText is required.');
    }

    return this.campaignRepo.createCampaign(validTenantId, {
      title: dto.title,
      channel: dto.channel,
      templateText: dto.templateText,
      mediaUrl: dto.mediaUrl,
      brandId: dto.brandId,
      targetCriteria: dto.targetCriteria,
      costPerMessage: dto.costPerMessage,
      metadata: dto.metadata,
    });
  }

  public async getCampaign(tenantId: unknown, campaignId: string): Promise<Campaign> {
    const validTenantId = assertValidTenantId(tenantId);
    const campaign = await this.campaignRepo.findById(validTenantId, campaignId);
    if (!campaign) {
      throw new CampaignNotFoundError(`Campaign '${campaignId}' not found for tenant '${validTenantId}'.`);
    }
    return campaign;
  }

  public async listCampaigns(
    tenantId: unknown,
    filter?: ListCampaignsFilterDto,
  ): Promise<{ campaigns: Campaign[]; total: number }> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.campaignRepo.listCampaigns(validTenantId, {
      status: filter?.status as any,
      channel: filter?.channel,
      limit: filter?.limit,
      offset: filter?.offset,
    });
  }

  /**
   * Resolves target contacts while strictly filtering out suppressed contacts.
   */
  public async resolveAudience(
    tenantId: unknown,
    criteria?: TargetCriteria,
  ): Promise<{ eligibleContacts: Contact[]; totalCount: number; suppressedCount: number }> {
    const validTenantId = assertValidTenantId(tenantId);

    // 1. Fetch contacts
    const allContacts = await this.contactsRepo.listContacts(validTenantId);

    // 2. Fetch all suppression entries for secondary double-check
    const suppressions = await this.contactsRepo.listSuppressions(validTenantId);
    const suppressedPhones = new Set(suppressions.map((s) => s.phoneNormalized));

    let suppressedCount = 0;
    const eligible: Contact[] = [];

    for (const contact of allContacts) {
      // Must not be suppressed by flag or by phone
      if (contact.isSuppressed || suppressedPhones.has(contact.phoneNormalized)) {
        suppressedCount++;
        continue;
      }

      // Check tag matching if criteria specifies tags
      if (criteria?.tags && criteria.tags.length > 0) {
        const contactTags = await this.contactsRepo.listContactTags(validTenantId, contact.id);
        const contactTagNames = new Set(contactTags.map((t) => t.name));
        const hasMatchingTag = criteria.tags.some((tag) => contactTagNames.has(tag));
        if (!hasMatchingTag) {
          continue;
        }
      }

      // Exclude tags
      if (criteria?.excludeTags && criteria.excludeTags.length > 0) {
        const contactTags = await this.contactsRepo.listContactTags(validTenantId, contact.id);
        const contactTagNames = new Set(contactTags.map((t) => t.name));
        const hasExcludedTag = criteria.excludeTags.some((tag) => contactTagNames.has(tag));
        if (hasExcludedTag) {
          continue;
        }
      }

      eligible.push(contact);
    }

    if (eligible.length === 0) {
      throw new AudienceEmptyError('No eligible contacts found matching target criteria.');
    }

    return {
      eligibleContacts: eligible,
      totalCount: eligible.length,
      suppressedCount,
    };
  }

  /**
   * Schedules a campaign: resolves audience, creates batches, and reserves credit.
   */
  public async scheduleCampaign(
    tenantId: unknown,
    campaignId: string,
    dto?: ScheduleCampaignDto,
  ): Promise<Campaign> {
    const validTenantId = assertValidTenantId(tenantId);
    const campaign = await this.getCampaign(validTenantId, campaignId);

    if (campaign.status !== 'DRAFT') {
      throw new CampaignStateError(
        `Campaign '${campaignId}' cannot be scheduled in status '${campaign.status}' (must be DRAFT).`,
      );
    }

    // 1. Resolve audience
    const { eligibleContacts } = await this.resolveAudience(validTenantId, campaign.targetCriteria);

    // 2. Resolve wallet account
    const accounts = await this.billingRepo.listAccounts(validTenantId);
    let accountId: string;
    if (accounts.length > 0) {
      accountId = accounts[0].id;
    } else {
      const defaultAcc = await this.billingRepo.createAccount(validTenantId, {
        name: 'Primary Wallet',
        type: 'CUSTOMER_PREPAID',
        currency: 'IRR',
      });
      accountId = defaultAcc.id;
    }

    // 3. Financial Reservation via BillingRepository
    const totalRequiredCredit = BigInt(eligibleContacts.length * campaign.costPerMessage);
    const reservationId = `res_camp_${campaign.id.substring(0, 8)}_${Date.now()}`;

    await this.billingRepo.createReservation(validTenantId, {
      reservationId,
      tenantId: validTenantId,
      accountId,
      amount: totalRequiredCredit,
      purpose: 'CAMPAIGN_BATCH_RESERVATION',
      referenceId: campaign.id,
    });

    // 4. Batch Partitioning
    const batchSize = dto?.batchSize && dto.batchSize > 0 ? dto.batchSize : 50;
    let batchIndex = 0;

    for (let i = 0; i < eligibleContacts.length; i += batchSize) {
      const chunk = eligibleContacts.slice(i, i + batchSize);
      await this.campaignRepo.createBatch(validTenantId, {
        campaignId: campaign.id,
        batchIndex,
        recipientIds: chunk.map((c) => c.id),
      });
      batchIndex++;
    }

    // 5. Update Campaign Record
    const scheduledAt = dto?.scheduledAt ? new Date(dto.scheduledAt) : new Date();
    return this.campaignRepo.updateCampaign(validTenantId, campaign.id, {
      status: 'SCHEDULED',
      scheduledAt,
      totalRecipients: eligibleContacts.length,
      reservationId,
    });
  }

  /**
   * Executes campaign batches via DispatcherService.
   */
  public async executeCampaign(
    tenantId: unknown,
    campaignId: string,
    options?: ExecuteCampaignDto,
  ): Promise<CampaignExecutionReport> {
    const validTenantId = assertValidTenantId(tenantId);
    let campaign = await this.getCampaign(validTenantId, campaignId);

    if (campaign.status !== 'SCHEDULED' && campaign.status !== 'PAUSED') {
      throw new CampaignStateError(
        `Campaign '${campaignId}' cannot be executed in status '${campaign.status}'.`,
      );
    }

    // Check Kill Switch
    this.killSwitchService.assertCanAdmit(validTenantId, campaign.channel);

    // Transition to EXECUTING
    campaign = await this.campaignRepo.updateCampaign(validTenantId, campaign.id, {
      status: 'EXECUTING',
      startedAt: campaign.startedAt ?? new Date(),
    });

    const batches = await this.campaignRepo.listBatches(validTenantId, campaign.id);
    const pendingBatches = batches.filter((b) => b.status === 'PENDING');
    const batchesToRun = options?.maxBatches ? pendingBatches.slice(0, options.maxBatches) : pendingBatches;

    const errors: string[] = [];
    let newlySent = 0;
    let newlyFailed = 0;

    for (const batch of batchesToRun) {
      // Check kill switch before each batch
      try {
        this.killSwitchService.assertCanAdmit(validTenantId, campaign.channel);
      } catch (err: unknown) {
        this.logger.warn(`Campaign '${campaignId}' halted by Kill Switch: ${err}`);
        await this.campaignRepo.updateCampaign(validTenantId, campaign.id, { status: 'PAUSED' });
        errors.push(`Halted by Kill Switch: ${err instanceof Error ? err.message : String(err)}`);
        break;
      }

      await this.campaignRepo.updateBatch(validTenantId, batch.id, {
        status: 'DISPATCHING',
        startedAt: new Date(),
      });

      let batchSent = 0;
      let batchFailed = 0;

      for (const recipientId of batch.recipientIds) {
        const contact = await this.contactsRepo.findContactById(validTenantId, recipientId);
        if (!contact) {
          batchFailed++;
          continue;
        }

        try {
          // Route sender via SenderRoutingEngine
          const decision = this.routingEngine.selectOptimalSender({
            tenantId: validTenantId,
            contactPhone: contact.phoneNormalized,
            contactId: contact.id,
            channel: campaign.channel,
          });

          // Build envelope
          const envelope: MessageQueueEnvelope = {
            messageId: `msg_${randomUUID()}`,
            tenantId: validTenantId,
            channel: campaign.channel,
            origin: 'CAMPAIGN',
            campaignId: campaign.id,
            recipientPhone: contact.phoneNormalized,
            recipientContactId: contact.id,
            senderAccountId: decision.selectedSender.id,
            payload: {
              text: campaign.templateText,
              mediaUrl: campaign.mediaUrl ?? undefined,
            },
            attempts: 0,
            maxAttempts: 3,
            createdAt: new Date().toISOString(),
          };

          const result = await this.dispatcherService.dispatch(envelope, decision.selectedSender);
          if (result.success) {
            batchSent++;
          } else {
            batchFailed++;
            if (result.errorMessage) {
              errors.push(result.errorMessage);
            }
          }
        } catch (dispatchErr: unknown) {
          batchFailed++;
          errors.push(dispatchErr instanceof Error ? dispatchErr.message : String(dispatchErr));
        }
      }

      await this.campaignRepo.updateBatch(validTenantId, batch.id, {
        status: 'COMPLETED',
        sentCount: batchSent,
        failedCount: batchFailed,
        completedAt: new Date(),
      });

      newlySent += batchSent;
      newlyFailed += batchFailed;
    }

    const updatedSent = campaign.sentCount + newlySent;
    const updatedFailed = campaign.failedCount + newlyFailed;

    // Check if all batches are completed
    const allBatches = await this.campaignRepo.listBatches(validTenantId, campaign.id);
    const remainingPending = allBatches.filter((b) => b.status === 'PENDING' || b.status === 'DISPATCHING');

    let finalStatus: CampaignStatus = 'EXECUTING';
    let settledAmount = 0;
    let releasedAmount = 0;

    if (remainingPending.length === 0) {
      finalStatus = 'COMPLETED';

      // Settle financial reservation with BillingRepository
      if (campaign.reservationId) {
        const finalCost = BigInt(updatedSent * campaign.costPerMessage);
        const settleRes = await this.billingRepo.settleReservation(validTenantId, {
          reservationId: campaign.reservationId,
          settleAmount: finalCost,
        });
        settledAmount = Number(settleRes.reservation.settledAmount);
        releasedAmount = Number(settleRes.reservation.releasedAmount);
      }
    }

    campaign = await this.campaignRepo.updateCampaign(validTenantId, campaign.id, {
      status: finalStatus,
      sentCount: updatedSent,
      failedCount: updatedFailed,
      completedAt: finalStatus === 'COMPLETED' ? new Date() : null,
    });

    return {
      campaignId: campaign.id,
      tenantId: validTenantId,
      status: campaign.status,
      totalRecipients: campaign.totalRecipients,
      sentCount: campaign.sentCount,
      failedCount: campaign.failedCount,
      reservationId: campaign.reservationId,
      settledAmount,
      releasedAmount,
      completedAt: campaign.completedAt ?? undefined,
      errors,
    };
  }

  public async pauseCampaign(tenantId: unknown, campaignId: string): Promise<Campaign> {
    const validTenantId = assertValidTenantId(tenantId);
    const campaign = await this.getCampaign(validTenantId, campaignId);
    if (campaign.status !== 'EXECUTING' && campaign.status !== 'SCHEDULED') {
      throw new CampaignStateError(`Cannot pause campaign in '${campaign.status}' state.`);
    }
    return this.campaignRepo.updateCampaign(validTenantId, campaign.id, { status: 'PAUSED' });
  }

  public async resumeCampaign(tenantId: unknown, campaignId: string): Promise<Campaign> {
    const validTenantId = assertValidTenantId(tenantId);
    const campaign = await this.getCampaign(validTenantId, campaignId);
    if (campaign.status !== 'PAUSED') {
      throw new CampaignStateError(`Cannot resume campaign that is in '${campaign.status}' state.`);
    }
    return this.campaignRepo.updateCampaign(validTenantId, campaign.id, { status: 'SCHEDULED' });
  }

  public async cancelCampaign(
    tenantId: unknown,
    campaignId: string,
    reason = 'Campaign cancelled by user',
  ): Promise<Campaign> {
    const validTenantId = assertValidTenantId(tenantId);
    const campaign = await this.getCampaign(validTenantId, campaignId);

    if (campaign.status === 'COMPLETED' || campaign.status === 'CANCELLED') {
      throw new CampaignStateError(`Cannot cancel campaign in '${campaign.status}' state.`);
    }

    // Release any unused financial reservation
    if (campaign.reservationId) {
      try {
        await this.billingRepo.releaseReservation(validTenantId, {
          reservationId: campaign.reservationId,
          reason,
        });
      } catch (err: unknown) {
        this.logger.warn(`Failed releasing reservation for cancelled campaign ${campaign.id}: ${err}`);
      }
    }

    return this.campaignRepo.updateCampaign(validTenantId, campaign.id, {
      status: 'CANCELLED',
      completedAt: new Date(),
    });
  }

  public async getProgress(tenantId: unknown, campaignId: string): Promise<CampaignProgress> {
    const validTenantId = assertValidTenantId(tenantId);
    const campaign = await this.getCampaign(validTenantId, campaignId);
    const batches = await this.campaignRepo.listBatches(validTenantId, campaign.id);

    const completedBatches = batches.filter((b) => b.status === 'COMPLETED').length;
    const progress =
      campaign.totalRecipients > 0
        ? Math.min(100, Math.round(((campaign.sentCount + campaign.failedCount) / campaign.totalRecipients) * 100))
        : 0;

    return {
      campaignId: campaign.id,
      status: campaign.status,
      totalRecipients: campaign.totalRecipients,
      sentCount: campaign.sentCount,
      deliveredCount: campaign.deliveredCount,
      failedCount: campaign.failedCount,
      progressPercentage: progress,
      batchesTotal: batches.length,
      batchesCompleted: completedBatches,
      startedAt: campaign.startedAt,
      completedAt: campaign.completedAt,
    };
  }
}
