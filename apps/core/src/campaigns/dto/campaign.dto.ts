/**
 * Campaign DTOs & Validation Schemas (Phase 7)
 */

import { ChannelType } from '../../messaging/queue.types';
import { TargetCriteria } from '../types';

export class CreateCampaignDto {
  title!: string;
  channel!: ChannelType;
  templateText!: string;
  mediaUrl?: string;
  brandId?: string;
  targetCriteria?: TargetCriteria;
  costPerMessage?: number;
  metadata?: Record<string, unknown>;
}

export class UpdateCampaignDto {
  title?: string;
  templateText?: string;
  mediaUrl?: string;
  targetCriteria?: TargetCriteria;
  costPerMessage?: number;
  metadata?: Record<string, unknown>;
}

export class ScheduleCampaignDto {
  scheduledAt?: string | Date;
  batchSize?: number;
}

export class ExecuteCampaignDto {
  maxBatches?: number;
}

export class ListCampaignsFilterDto {
  status?: string;
  channel?: string;
  limit?: number;
  offset?: number;
}
