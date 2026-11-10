/**
 * Campaign Repository (Phase 7)
 *
 * Implements tenant-scoped data storage and retrieval for campaigns and batches.
 * Strictly adheres to AC-02 (tenant isolation) via assertValidTenantId.
 */

import { Injectable } from '@nestjs/common';
import { assertValidTenantId } from '../tenant/tenant-scope';
import {
  Campaign,
  CampaignBatch,
  CampaignStatus,
  BatchStatus,
  CampaignNotFoundError,
} from './types';
import { randomUUID } from 'crypto';

export interface CreateCampaignRepoInput {
  title: string;
  channel: string;
  templateText: string;
  mediaUrl?: string | null;
  brandId?: string | null;
  targetCriteria?: any;
  costPerMessage?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateCampaignRepoInput {
  title?: string;
  templateText?: string;
  mediaUrl?: string | null;
  targetCriteria?: any;
  costPerMessage?: number;
  status?: CampaignStatus;
  scheduledAt?: Date | null;
  startedAt?: Date | null;
  completedAt?: Date | null;
  totalRecipients?: number;
  sentCount?: number;
  deliveredCount?: number;
  failedCount?: number;
  reservationId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateBatchRepoInput {
  campaignId: string;
  batchIndex: number;
  recipientIds: readonly string[];
}

export interface UpdateBatchRepoInput {
  status?: BatchStatus;
  sentCount?: number;
  failedCount?: number;
  startedAt?: Date | null;
  completedAt?: Date | null;
}

export interface ListCampaignsRepoOptions {
  status?: CampaignStatus;
  channel?: string;
  limit?: number;
  offset?: number;
}

@Injectable()
export class CampaignRepository {
  // Keyed by `${tenantId}:${campaignId}`
  private readonly campaigns = new Map<string, Campaign>();
  // Keyed by `${tenantId}:${batchId}`
  private readonly batches = new Map<string, CampaignBatch>();

  private getCampaignKey(tenantId: string, campaignId: string): string {
    return `${tenantId}:${campaignId}`;
  }

  private getBatchKey(tenantId: string, batchId: string): string {
    return `${tenantId}:${batchId}`;
  }

  public async createCampaign(tenantId: unknown, input: CreateCampaignRepoInput): Promise<Campaign> {
    const validTenantId = assertValidTenantId(tenantId);
    const id = randomUUID();
    const now = new Date();

    const campaign: Campaign = {
      id,
      tenantId: validTenantId,
      brandId: input.brandId ?? null,
      title: input.title.trim(),
      channel: input.channel,
      status: 'DRAFT',
      templateText: input.templateText,
      mediaUrl: input.mediaUrl ?? null,
      targetCriteria: input.targetCriteria ?? {},
      costPerMessage: input.costPerMessage ?? 10,
      scheduledAt: null,
      startedAt: null,
      completedAt: null,
      totalRecipients: 0,
      sentCount: 0,
      deliveredCount: 0,
      failedCount: 0,
      reservationId: null,
      metadata: input.metadata,
      createdAt: now,
      updatedAt: now,
    };

    this.campaigns.set(this.getCampaignKey(validTenantId, id), campaign);
    return { ...campaign };
  }

  public async findById(tenantId: unknown, campaignId: string): Promise<Campaign | null> {
    const validTenantId = assertValidTenantId(tenantId);
    const campaign = this.campaigns.get(this.getCampaignKey(validTenantId, campaignId));
    return campaign ? { ...campaign } : null;
  }

  public async updateCampaign(
    tenantId: unknown,
    campaignId: string,
    updates: UpdateCampaignRepoInput,
  ): Promise<Campaign> {
    const validTenantId = assertValidTenantId(tenantId);
    const key = this.getCampaignKey(validTenantId, campaignId);
    const existing = this.campaigns.get(key);

    if (!existing) {
      throw new CampaignNotFoundError(`Campaign '${campaignId}' not found for tenant '${validTenantId}'.`);
    }

    const updated: Campaign = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };

    this.campaigns.set(key, updated);
    return { ...updated };
  }

  public async listCampaigns(
    tenantId: unknown,
    options?: ListCampaignsRepoOptions,
  ): Promise<{ campaigns: Campaign[]; total: number }> {
    const validTenantId = assertValidTenantId(tenantId);
    let items = Array.from(this.campaigns.values()).filter((c) => c.tenantId === validTenantId);

    if (options?.status) {
      items = items.filter((c) => c.status === options.status);
    }
    if (options?.channel) {
      items = items.filter((c) => c.channel === options.channel);
    }

    // Sort descending by createdAt
    items.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const total = items.length;
    const offset = options?.offset ?? 0;
    const limit = options?.limit ?? 50;
    const paginated = items.slice(offset, offset + limit);

    return {
      campaigns: paginated.map((c) => ({ ...c })),
      total,
    };
  }

  public async createBatch(tenantId: unknown, input: CreateBatchRepoInput): Promise<CampaignBatch> {
    const validTenantId = assertValidTenantId(tenantId);
    const batchId = randomUUID();
    const now = new Date();

    const batch: CampaignBatch = {
      id: batchId,
      tenantId: validTenantId,
      campaignId: input.campaignId,
      batchIndex: input.batchIndex,
      status: 'PENDING',
      recipientIds: [...input.recipientIds],
      size: input.recipientIds.length,
      sentCount: 0,
      failedCount: 0,
      startedAt: null,
      completedAt: null,
      createdAt: now,
      updatedAt: now,
    };

    this.batches.set(this.getBatchKey(validTenantId, batchId), batch);
    return { ...batch };
  }

  public async listBatches(tenantId: unknown, campaignId: string): Promise<CampaignBatch[]> {
    const validTenantId = assertValidTenantId(tenantId);
    return Array.from(this.batches.values())
      .filter((b) => b.tenantId === validTenantId && b.campaignId === campaignId)
      .sort((a, b) => a.batchIndex - b.batchIndex)
      .map((b) => ({ ...b }));
  }

  public async updateBatch(
    tenantId: unknown,
    batchId: string,
    updates: UpdateBatchRepoInput,
  ): Promise<CampaignBatch> {
    const validTenantId = assertValidTenantId(tenantId);
    const key = this.getBatchKey(validTenantId, batchId);
    const existing = this.batches.get(key);

    if (!existing) {
      throw new Error(`Batch '${batchId}' not found for tenant '${validTenantId}'.`);
    }

    const updated: CampaignBatch = {
      ...existing,
      ...updates,
      updatedAt: new Date(),
    };

    this.batches.set(key, updated);
    return { ...updated };
  }

  public resetAll(): void {
    this.campaigns.clear();
    this.batches.clear();
  }
}
