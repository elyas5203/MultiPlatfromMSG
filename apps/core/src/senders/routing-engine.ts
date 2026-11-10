/**
 * Sender Routing Engine
 *
 * Implements intelligent dispatch routing and load balancing for sender accounts.
 *
 * AC-01: Multi-tiered ranking algorithm (Mutual contact -> Remaining quota -> Lower workload).
 * AC-02: Strict health status & quota filtering (exclusion of BANNED, COOLDOWN, quota-exhausted).
 * AC-03: Zero-exception tenant isolation via assertValidTenantId.
 */

import { Injectable, Logger } from '@nestjs/common';
import { assertValidTenantId } from '../tenant/tenant-scope';
import {
  SenderAccount,
  RegisterSenderInput,
  RouteMessageRequest,
  RoutingDecision,
  NoEligibleSenderError,
  SenderNotFoundError,
  SenderAlreadyExistsError,
  InvalidSenderConfigError,
} from './types';

@Injectable()
export class SenderRoutingEngine {
  private readonly logger = new Logger(SenderRoutingEngine.name);

  /**
   * Registered senders indexed by `${tenantId}:${senderId}`.
   */
  private readonly senders = new Map<string, SenderAccount>();

  /**
   * Mutual contact relations indexed by `${tenantId}:${senderId}:${normalizedPhone}`.
   */
  private readonly mutualContacts = new Set<string>();

  private getSenderKey(tenantId: string, senderId: string): string {
    return `${tenantId}:${senderId}`;
  }

  private getMutualKey(tenantId: string, senderId: string, phone: string): string {
    return `${tenantId}:${senderId}:${phone.trim()}`;
  }

  /**
   * Registers a new sender account into the engine.
   */
  public registerSender(input: RegisterSenderInput): SenderAccount {
    const validTenantId = assertValidTenantId(input.tenantId);

    if (!input.id || typeof input.id !== 'string' || input.id.trim().length === 0) {
      throw new InvalidSenderConfigError('Sender id must be a non-empty string.');
    }
    const senderId = input.id.trim();

    if (input.dailyQuota < 0 || !Number.isInteger(input.dailyQuota)) {
      throw new InvalidSenderConfigError(`dailyQuota must be a non-negative integer: ${input.dailyQuota}`);
    }

    const key = this.getSenderKey(validTenantId, senderId);
    if (this.senders.has(key)) {
      throw new SenderAlreadyExistsError(senderId);
    }

    const sender: SenderAccount = Object.freeze({
      id: senderId,
      tenantId: validTenantId,
      name: input.name?.trim(),
      channel: input.channel,
      type: input.type,
      status: input.status ?? 'ACTIVE',
      dailyQuota: input.dailyQuota,
      sentTodayCount: input.sentTodayCount ?? 0,
      activeWorkloadCount: input.activeWorkloadCount ?? 0,
      cooldownUntil: input.cooldownUntil ?? null,
      cooldownReason: input.cooldownReason ?? null,
      tags: input.tags ? Object.freeze([...input.tags]) : undefined,
      metadata: input.metadata ? Object.freeze({ ...input.metadata }) : undefined,
    });

    this.senders.set(key, sender);
    return sender;
  }

  /**
   * Retrieves a sender account by ID within the tenant scope.
   */
  public getSender(tenantId: string, senderId: string): SenderAccount | undefined {
    const validTenantId = assertValidTenantId(tenantId);
    return this.senders.get(this.getSenderKey(validTenantId, senderId.trim()));
  }

  /**
   * Lists all sender accounts belonging to the specified tenant.
   */
  public listSenders(tenantId: string): SenderAccount[] {
    const validTenantId = assertValidTenantId(tenantId);
    const prefix = `${validTenantId}:`;
    const result: SenderAccount[] = [];

    for (const [key, sender] of this.senders.entries()) {
      if (key.startsWith(prefix) && sender.tenantId === validTenantId) {
        result.push(sender);
      }
    }

    return result;
  }

  /**
   * Records a mutual contact relationship between a sender account and a recipient phone.
   */
  public recordMutualContact(tenantId: string, senderId: string, contactPhone: string): void {
    const validTenantId = assertValidTenantId(tenantId);
    if (!contactPhone || typeof contactPhone !== 'string' || contactPhone.trim().length === 0) {
      return;
    }
    const key = this.getMutualKey(validTenantId, senderId.trim(), contactPhone.trim());
    this.mutualContacts.add(key);
  }

  /**
   * Checks whether a mutual contact relationship exists.
   */
  public isMutualContact(tenantId: string, senderId: string, contactPhone: string): boolean {
    const validTenantId = assertValidTenantId(tenantId);
    if (!contactPhone || typeof contactPhone !== 'string' || contactPhone.trim().length === 0) {
      return false;
    }
    const key = this.getMutualKey(validTenantId, senderId.trim(), contactPhone.trim());
    return this.mutualContacts.has(key);
  }

  /**
   * Marks a sender account in COOLDOWN (e.g. after receiving FloodWait from Telegram).
   */
  public markCooldown(
    tenantId: string,
    senderId: string,
    cooldownDurationSeconds: number,
    reason = 'FloodWait limit received',
  ): SenderAccount {
    const validTenantId = assertValidTenantId(tenantId);
    const sender = this.getSender(validTenantId, senderId);
    if (!sender) {
      throw new SenderNotFoundError(senderId, validTenantId);
    }

    const duration = Math.max(1, cooldownDurationSeconds);
    const cooldownUntil = new Date(Date.now() + duration * 1000);

    const updated: SenderAccount = Object.freeze({
      ...sender,
      status: 'COOLDOWN',
      cooldownUntil,
      cooldownReason: reason,
    });

    this.senders.set(this.getSenderKey(validTenantId, sender.id), updated);
    this.logger.warn(
      `Sender '${sender.id}' entered COOLDOWN for ${duration}s (until ${cooldownUntil.toISOString()}): ${reason}`,
    );
    return updated;
  }

  /**
   * Marks a sender account as permanently BANNED.
   */
  public markBanned(tenantId: string, senderId: string, reason = 'Account banned by platform'): SenderAccount {
    const validTenantId = assertValidTenantId(tenantId);
    const sender = this.getSender(validTenantId, senderId);
    if (!sender) {
      throw new SenderNotFoundError(senderId, validTenantId);
    }

    const updated: SenderAccount = Object.freeze({
      ...sender,
      status: 'BANNED',
      cooldownReason: reason,
    });

    this.senders.set(this.getSenderKey(validTenantId, sender.id), updated);
    this.logger.error(`Sender '${sender.id}' marked as BANNED: ${reason}`);
    return updated;
  }

  /**
   * Records that a dispatch job has been assigned to the sender.
   * Increments `sentTodayCount` and `activeWorkloadCount`.
   */
  public recordDispatch(tenantId: string, senderId: string): SenderAccount {
    const validTenantId = assertValidTenantId(tenantId);
    const sender = this.getSender(validTenantId, senderId);
    if (!sender) {
      throw new SenderNotFoundError(senderId, validTenantId);
    }

    const updated: SenderAccount = Object.freeze({
      ...sender,
      sentTodayCount: sender.sentTodayCount + 1,
      activeWorkloadCount: sender.activeWorkloadCount + 1,
      lastUsedAt: new Date(),
    });

    this.senders.set(this.getSenderKey(validTenantId, sender.id), updated);
    return updated;
  }

  /**
   * Marks a dispatch job as completed, decrementing `activeWorkloadCount`.
   */
  public completeDispatch(tenantId: string, senderId: string): SenderAccount {
    const validTenantId = assertValidTenantId(tenantId);
    const sender = this.getSender(validTenantId, senderId);
    if (!sender) {
      throw new SenderNotFoundError(senderId, validTenantId);
    }

    const updated: SenderAccount = Object.freeze({
      ...sender,
      activeWorkloadCount: Math.max(0, sender.activeWorkloadCount - 1),
    });

    this.senders.set(this.getSenderKey(validTenantId, sender.id), updated);
    return updated;
  }

  /**
   * Resets daily usage counters for senders (typically run at midnight).
   */
  public resetDailyQuotas(tenantId?: string): void {
    const targetTenant = tenantId ? assertValidTenantId(tenantId) : null;

    for (const [key, sender] of this.senders.entries()) {
      if (targetTenant && sender.tenantId !== targetTenant) {
        continue;
      }
      const updated: SenderAccount = Object.freeze({
        ...sender,
        sentTodayCount: 0,
      });
      this.senders.set(key, updated);
    }
  }

  /**
   * Selects the optimal sender account for a message.
   *
   * AC-01: Multi-tiered ranking priority:
   *   1. Mutual contact status with recipient
   *   2. Preferred sender type (if specified)
   *   3. Remaining daily quota (higher is better)
   *   4. Lower active workload count (load balancing)
   *   5. Lower sentTodayCount
   *   6. Deterministic tie-breaker
   *
   * AC-02: Strict health & quota filtering:
   *   - BANNED & DISABLED accounts are excluded.
   *   - COOLDOWN accounts are excluded unless cooldown period has expired.
   *   - Accounts with remaining quota <= 0 are excluded.
   *
   * AC-03: Strict multi-tenant isolation:
   *   - Only accounts belonging to `request.tenantId` are considered.
   */
  public selectOptimalSender(request: RouteMessageRequest): RoutingDecision {
    const validTenantId = assertValidTenantId(request.tenantId);
    const contactPhone = request.contactPhone?.trim() ?? '';
    const now = request.now ?? new Date();

    // Determine candidate pool
    let candidatePool: readonly SenderAccount[];
    if (request.candidates && request.candidates.length > 0) {
      candidatePool = request.candidates;
    } else {
      candidatePool = this.listSenders(validTenantId);
    }

    const rejectionReasons: Record<string, number> = {
      WRONG_TENANT: 0,
      CHANNEL_MISMATCH: 0,
      MISSING_TAGS: 0,
      STATUS_BANNED: 0,
      STATUS_DISABLED: 0,
      STATUS_COOLDOWN: 0,
      QUOTA_EXHAUSTED: 0,
    };

    const eligibleCandidates: {
      sender: SenderAccount;
      isMutual: boolean;
      remainingQuota: number;
    }[] = [];

    for (const candidate of candidatePool) {
      // AC-03: Strict tenant boundary check
      if (candidate.tenantId !== validTenantId) {
        rejectionReasons.WRONG_TENANT++;
        continue;
      }

      // Channel filter
      if (request.channel && candidate.channel !== request.channel) {
        rejectionReasons.CHANNEL_MISMATCH++;
        continue;
      }

      // Required tags filter
      if (request.requiredTags && request.requiredTags.length > 0) {
        const candidateTags = new Set(candidate.tags ?? []);
        const hasAllTags = request.requiredTags.every((t) => candidateTags.has(t));
        if (!hasAllTags) {
          rejectionReasons.MISSING_TAGS++;
          continue;
        }
      }

      // AC-02: Health status filter
      if (candidate.status === 'BANNED') {
        rejectionReasons.STATUS_BANNED++;
        continue;
      }
      if (candidate.status === 'DISABLED') {
        rejectionReasons.STATUS_DISABLED++;
        continue;
      }

      let effectiveStatus = candidate.status;
      if (effectiveStatus === 'COOLDOWN') {
        if (candidate.cooldownUntil && candidate.cooldownUntil.getTime() > now.getTime()) {
          rejectionReasons.STATUS_COOLDOWN++;
          continue;
        }
        // Cooldown has expired, auto-recover to ACTIVE
        effectiveStatus = 'ACTIVE';
      }

      // AC-02: Quota filter
      const remainingQuota = candidate.dailyQuota - candidate.sentTodayCount;
      if (remainingQuota <= 0) {
        rejectionReasons.QUOTA_EXHAUSTED++;
        continue;
      }

      const isMutual = this.isMutualContact(validTenantId, candidate.id, contactPhone);

      eligibleCandidates.push({
        sender: candidate,
        isMutual,
        remainingQuota,
      });
    }

    if (eligibleCandidates.length === 0) {
      throw new NoEligibleSenderError({
        tenantId: validTenantId,
        channel: request.channel,
        contactPhone,
        totalEvaluated: candidatePool.length,
        rejectionReasons,
      });
    }

    // AC-01: Multi-tiered ranking comparator
    eligibleCandidates.sort((a, b) => {
      // 1. Priority 1: Mutual contact
      if (a.isMutual !== b.isMutual) {
        return a.isMutual ? -1 : 1;
      }

      // 2. Priority 2: Preferred sender type
      if (request.preferredType) {
        const aMatches = a.sender.type === request.preferredType;
        const bMatches = b.sender.type === request.preferredType;
        if (aMatches !== bMatches) {
          return aMatches ? -1 : 1;
        }
      }

      // 3. Priority 3: Remaining daily quota (higher remaining quota first)
      if (a.remainingQuota !== b.remainingQuota) {
        return b.remainingQuota - a.remainingQuota;
      }

      // 4. Priority 4: Active workload (lower workload first)
      if (a.sender.activeWorkloadCount !== b.sender.activeWorkloadCount) {
        return a.sender.activeWorkloadCount - b.sender.activeWorkloadCount;
      }

      // 5. Priority 5: Lower sentTodayCount
      if (a.sender.sentTodayCount !== b.sender.sentTodayCount) {
        return a.sender.sentTodayCount - b.sender.sentTodayCount;
      }

      // 6. Deterministic tie-breaker
      return a.sender.id.localeCompare(b.sender.id);
    });

    const chosen = eligibleCandidates[0];

    let selectionReason = 'Optimal score based on remaining quota and workload';
    if (chosen.isMutual) {
      selectionReason = 'Prioritized due to verified mutual contact with recipient';
    } else if (request.preferredType && chosen.sender.type === request.preferredType) {
      selectionReason = `Preferred sender type '${request.preferredType}' with highest remaining capacity`;
    }

    return {
      selectedSender: chosen.sender,
      isMutualContact: chosen.isMutual,
      remainingQuota: chosen.remainingQuota,
      evaluatedCandidatesCount: candidatePool.length,
      eligibleCandidatesCount: eligibleCandidates.length,
      selectionReason,
    };
  }
}
