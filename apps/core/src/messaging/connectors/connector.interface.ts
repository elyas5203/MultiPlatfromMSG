/**
 * Channel Connector Interface & Delivery Models (Phase 6)
 *
 * Implements architectural contracts for multi-channel message dispatchers (Telegram, Bale).
 * Compliant with:
 * - docs/ai/architecture/MODULE_MAP.md (Connectors module)
 * - docs/ai/product/CHANNEL_RESEARCH.md (FloodWait, Anti-spam, Jitter, Cooldown)
 * - docs/ai/governance/ABSOLUTE_PROHIBITIONS.md
 */

import { MessageQueueEnvelope, ChannelType, MessageDeliveryStatus } from '../queue.types';
import { SenderAccount } from '../../senders/types';

export interface DeliveryResult {
  readonly success: boolean;
  readonly messageId: string;
  readonly channel: ChannelType;
  readonly senderAccountId: string;
  readonly recipient: string;
  readonly status: MessageDeliveryStatus;
  readonly externalMessageId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly isPermanentFailure?: boolean;
  readonly isFloodWait?: boolean;
  readonly retryAfterSeconds?: number;
  readonly dispatchedAt: Date;
  readonly durationMs: number;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ConnectorParsedError {
  readonly isFloodWait: boolean;
  readonly floodWaitSeconds?: number;
  readonly isBanned: boolean;
  readonly isPermanent: boolean;
  readonly isRateLimited: boolean;
  readonly code: string;
  readonly message: string;
}

export interface IChannelConnector {
  readonly channel: ChannelType;

  /**
   * Validates whether recipient format is valid for this channel.
   */
  validateRecipient(recipient: string): boolean;

  /**
   * Normalizes recipient for platform dispatch (e.g., stripping spaces/hyphens, resolving prefixes).
   */
  normalizeRecipient(recipient: string): string;

  /**
   * Sends a message envelope using the designated sender account.
   */
  send(
    envelope: MessageQueueEnvelope,
    sender: SenderAccount,
    signal?: AbortSignal,
  ): Promise<DeliveryResult>;

  /**
   * Parses platform-specific raw errors into a standardized connector error descriptor.
   */
  parseError(error: unknown): ConnectorParsedError;
}
