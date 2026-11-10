/**
 * Campaign Management & Batch Scheduling Types (Phase 7)
 *
 * Implements architectural contracts for multi-channel mass campaigns:
 * - Audience targeting & suppression exclusion
 * - Two-phase financial credit reservation (BillingService integration)
 * - Batching, rate pacing, and execution lifecycle
 * - Pause, resume, and kill-switch safety integration
 *
 * Compliant with:
 * - docs/ai/architecture/MODULE_MAP.md (Campaigns & Scheduling module)
 * - docs/ai/architecture/DATA_MODEL.md
 * - docs/ai/governance/ABSOLUTE_PROHIBITIONS.md
 */

import { ChannelType } from '../messaging/queue.types';

export type CampaignStatus =
  | 'DRAFT'
  | 'SCHEDULED'
  | 'EXECUTING'
  | 'PAUSED'
  | 'COMPLETED'
  | 'CANCELLED'
  | 'FAILED';

export type BatchStatus = 'PENDING' | 'DISPATCHING' | 'COMPLETED' | 'FAILED' | 'ABORTED';

export interface TargetCriteria {
  readonly tags?: readonly string[];
  readonly excludeTags?: readonly string[];
  readonly onlyOptedIn?: boolean;
}

export interface Campaign {
  readonly id: string;
  readonly tenantId: string;
  readonly brandId?: string | null;
  readonly title: string;
  readonly channel: ChannelType;
  readonly status: CampaignStatus;
  readonly templateText: string;
  readonly mediaUrl?: string | null;
  readonly targetCriteria: TargetCriteria;
  readonly costPerMessage: number;
  readonly scheduledAt?: Date | null;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly totalRecipients: number;
  readonly sentCount: number;
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly reservationId?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CampaignBatch {
  readonly id: string;
  readonly tenantId: string;
  readonly campaignId: string;
  readonly batchIndex: number;
  readonly status: BatchStatus;
  readonly recipientIds: readonly string[];
  readonly size: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CampaignExecutionReport {
  readonly campaignId: string;
  readonly tenantId: string;
  readonly status: CampaignStatus;
  readonly totalRecipients: number;
  readonly sentCount: number;
  readonly failedCount: number;
  readonly reservationId?: string | null;
  readonly settledAmount: number;
  readonly releasedAmount: number;
  readonly completedAt?: Date;
  readonly errors: readonly string[];
}

export interface CampaignProgress {
  readonly campaignId: string;
  readonly status: CampaignStatus;
  readonly totalRecipients: number;
  readonly sentCount: number;
  readonly deliveredCount: number;
  readonly failedCount: number;
  readonly progressPercentage: number;
  readonly batchesTotal: number;
  readonly batchesCompleted: number;
  readonly startedAt?: Date | null;
  readonly completedAt?: Date | null;
}

export class CampaignNotFoundError extends Error {
  constructor(message = 'Campaign not found within tenant scope.') {
    super(message);
    this.name = 'CampaignNotFoundError';
  }
}

export class CampaignStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignStateError';
  }
}

export class CampaignValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CampaignValidationError';
  }
}

export class AudienceEmptyError extends Error {
  constructor(message = 'No eligible contacts found matching target criteria.') {
    super(message);
    this.name = 'AudienceEmptyError';
  }
}
