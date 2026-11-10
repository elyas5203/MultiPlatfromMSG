/**
 * Multi-Channel Dispatcher Service (Phase 6)
 *
 * Orchestrates multi-platform message delivery with:
 * - KillSwitch protection (Global, Tenant, Channel scopes)
 * - Strict multi-tenant isolation (assertValidTenantId)
 * - Rate limiting, jitter calculation, and automatic FloodWait cooldown
 * - Telegram & Bale platform connectors
 *
 * Compliant with:
 * - docs/ai/architecture/MODULE_MAP.md
 * - docs/ai/product/CHANNEL_RESEARCH.md
 * - docs/ai/governance/ABSOLUTE_PROHIBITIONS.md
 */

import { Injectable, Logger } from '@nestjs/common';
import { assertValidTenantId } from '../tenant/tenant-scope';
import { MessageQueueEnvelope, ChannelType } from './queue.types';
import { SenderAccount } from '../senders/types';
import { KillSwitchService, KillSwitchActiveError } from './kill-switch.service';
import { DispatchRateLimiter } from './rate-limiter';
import { TelegramConnector } from './connectors/telegram.connector';
import { BaleConnector } from './connectors/bale.connector';
import { DeliveryResult, IChannelConnector } from './connectors/connector.interface';

export interface DispatchOptions {
  readonly abortSignal?: AbortSignal;
  readonly bypassRateLimit?: boolean;
}

@Injectable()
export class DispatcherService {
  private readonly logger = new Logger(DispatcherService.name);
  private readonly connectors = new Map<ChannelType, IChannelConnector>();

  constructor(
    private readonly killSwitchService: KillSwitchService,
    private readonly rateLimiter: DispatchRateLimiter,
    private readonly telegramConnector: TelegramConnector,
    private readonly baleConnector: BaleConnector,
  ) {
    this.connectors.set('TELEGRAM', this.telegramConnector);
    this.connectors.set('BALE', this.baleConnector);
  }

  /**
   * Registers or overrides a channel connector (for custom plugins/transports).
   */
  public registerConnector(connector: IChannelConnector): void {
    this.connectors.set(connector.channel, connector);
  }

  /**
   * Returns connector for a specific channel type.
   */
  public getConnector(channel: ChannelType): IChannelConnector | undefined {
    return this.connectors.get(channel);
  }

  /**
   * Dispatches a message envelope with complete safety checks and telemetry.
   */
  public async dispatch(
    envelope: MessageQueueEnvelope,
    sender: SenderAccount,
    options?: DispatchOptions,
  ): Promise<DeliveryResult> {
    const startTime = Date.now();

    // 1. Strict Tenant Isolation Verification
    const validTenantId = assertValidTenantId(envelope.tenantId);
    if (sender.tenantId && sender.tenantId !== validTenantId) {
      throw new Error(
        `Cross-tenant dispatch violation: envelope tenant (${validTenantId}) does not match sender tenant (${sender.tenantId})`,
      );
    }

    // 2. Kill Switch Verification (Global, Tenant, or Channel scope)
    try {
      this.killSwitchService.assertCanAdmit(validTenantId, envelope.channel);
    } catch (err: unknown) {
      if (err instanceof KillSwitchActiveError) {
        this.logger.warn(`Dispatch blocked by kill switch: ${err.message}`);
        return {
          success: false,
          messageId: envelope.messageId,
          channel: envelope.channel,
          senderAccountId: sender.id,
          recipient: envelope.recipientPhone || envelope.recipientContactId || 'UNKNOWN',
          status: 'KILLED_ABORTED',
          errorCode: 'KILL_SWITCH_ACTIVE',
          errorMessage: err.message,
          isPermanentFailure: false,
          dispatchedAt: new Date(startTime),
          durationMs: Date.now() - startTime,
        };
      }
      throw err;
    }

    // 3. Resolve Connector
    const connector = this.connectors.get(envelope.channel);
    if (!connector) {
      return {
        success: false,
        messageId: envelope.messageId,
        channel: envelope.channel,
        senderAccountId: sender.id,
        recipient: envelope.recipientPhone || envelope.recipientContactId || 'UNKNOWN',
        status: 'FAILED',
        errorCode: 'UNSUPPORTED_CHANNEL',
        errorMessage: `No connector registered for channel '${envelope.channel}'`,
        isPermanentFailure: true,
        dispatchedAt: new Date(startTime),
        durationMs: Date.now() - startTime,
      };
    }

    // 4. Rate Limiting & Cooldown Check
    if (!options?.bypassRateLimit) {
      const rateCheck = this.rateLimiter.canDispatch(sender.id);
      if (!rateCheck.allowed) {
        return {
          success: false,
          messageId: envelope.messageId,
          channel: envelope.channel,
          senderAccountId: sender.id,
          recipient: envelope.recipientPhone || envelope.recipientContactId || 'UNKNOWN',
          status: 'REJECTED',
          errorCode: rateCheck.isCooldown ? 'SENDER_IN_COOLDOWN' : 'RATE_LIMITED',
          errorMessage: rateCheck.reason || 'Rate limit exceeded',
          isPermanentFailure: false,
          isFloodWait: rateCheck.isCooldown,
          retryAfterSeconds: Math.ceil(rateCheck.waitTimeMs / 1000),
          dispatchedAt: new Date(startTime),
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 5. Acquire Dispatch Slot
    const slotAcquired = this.rateLimiter.acquireSlot(sender.id);
    if (!slotAcquired && !options?.bypassRateLimit) {
      return {
        success: false,
        messageId: envelope.messageId,
        channel: envelope.channel,
        senderAccountId: sender.id,
        recipient: envelope.recipientPhone || envelope.recipientContactId || 'UNKNOWN',
        status: 'REJECTED',
        errorCode: 'CONCURRENCY_LIMIT_EXCEEDED',
        errorMessage: 'Sender reached maximum concurrent in-flight dispatches',
        isPermanentFailure: false,
        dispatchedAt: new Date(startTime),
        durationMs: Date.now() - startTime,
      };
    }

    // 6. Perform Dispatch via Platform Connector
    try {
      const result = await connector.send(envelope, sender, options?.abortSignal);

      // Post-dispatch handling:
      if (!result.success && result.isFloodWait && result.retryAfterSeconds) {
        this.rateLimiter.applyCooldown(sender.id, result.retryAfterSeconds, 'Platform FloodWait returned');
      }

      this.rateLimiter.recordDispatch(sender.id);
      return result;
    } finally {
      this.rateLimiter.releaseSlot(sender.id);
    }
  }
}
