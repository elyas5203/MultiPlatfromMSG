/**
 * Telegram Channel Connector (Phase 6)
 *
 * Implements Telegram message dispatch with support for Bot API and MTProto client patterns.
 * Compliant with:
 * - docs/ai/architecture/MODULE_MAP.md (Connectors module)
 * - docs/ai/product/CHANNEL_RESEARCH.md (MTProto/Bot FloodWait_X handling & zero unhandled bans)
 */

import { Injectable, Logger } from '@nestjs/common';
import { IChannelConnector, DeliveryResult, ConnectorParsedError } from './connector.interface';
import { MessageQueueEnvelope } from '../queue.types';
import { SenderAccount } from '../../senders/types';

export interface TelegramTransportAdapter {
  sendMessage(params: {
    recipient: string;
    text: string;
    senderId: string;
    mediaUrl?: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: string; date?: number }>;
}

export class DefaultTelegramTransport implements TelegramTransportAdapter {
  async sendMessage(params: {
    recipient: string;
    text: string;
    senderId: string;
    mediaUrl?: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: string; date?: number }> {
    if (params.signal?.aborted) {
      throw new Error('Telegram dispatch aborted before network transport');
    }
    // Simulation / stub for testing when real external network is mocked
    return {
      messageId: `tg_msg_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      date: Math.floor(Date.now() / 1000),
    };
  }
}

@Injectable()
export class TelegramConnector implements IChannelConnector {
  public readonly channel = 'TELEGRAM';
  private readonly logger = new Logger(TelegramConnector.name);
  private transport: TelegramTransportAdapter;

  constructor(transport?: TelegramTransportAdapter) {
    this.transport = transport || new DefaultTelegramTransport();
  }

  public setTransport(transport: TelegramTransportAdapter): void {
    this.transport = transport;
  }

  public validateRecipient(recipient: string): boolean {
    if (!recipient || typeof recipient !== 'string') return false;
    const trimmed = recipient.trim();
    // International phone number (+1234567890), User ID (123456789), or username (@username)
    const phoneRegex = /^\+?[1-9]\d{6,14}$/;
    const userIdRegex = /^\d{5,16}$/;
    const usernameRegex = /^@[a-zA-Z0-9_]{4,32}$/;

    return phoneRegex.test(trimmed) || userIdRegex.test(trimmed) || usernameRegex.test(trimmed);
  }

  public normalizeRecipient(recipient: string): string {
    const trimmed = recipient.trim();
    if (trimmed.startsWith('@')) return trimmed.toLowerCase();
    if (/^\+?\d+$/.test(trimmed)) {
      return trimmed.startsWith('+') ? trimmed : `+${trimmed}`;
    }
    return trimmed;
  }

  public parseError(error: unknown): ConnectorParsedError {
    const message = error instanceof Error ? error.message : String(error);
    const errObj = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};

    // 1. FloodWait detection (e.g. "FLOOD_WAIT_300", "429: Too Many Requests: retry after 30")
    const floodMatch = message.match(/FLOOD_WAIT_(\d+)/i);
    const retryAfterMatch = message.match(/retry\s+after\s+(\d+)/i);

    let floodWaitSeconds: number | undefined;
    if (floodMatch) {
      floodWaitSeconds = parseInt(floodMatch[1], 10);
    } else if (retryAfterMatch) {
      floodWaitSeconds = parseInt(retryAfterMatch[1], 10);
    } else if (typeof errObj.retry_after === 'number') {
      floodWaitSeconds = errObj.retry_after;
    }

    const isFloodWait = floodWaitSeconds !== undefined && floodWaitSeconds > 0;

    // 2. Account Ban & Deactivation detection
    const isBanned =
      /USER_DEACTIVATED|USER_DEACTIVATED_BAN|AUTH_KEY_UNREGISTERED|SESSION_REVOKED|BANNED|ACCOUNT_BLOCKED/i.test(
        message,
      );

    // 3. Permanent recipient failure
    const isPermanent =
      isBanned ||
      /PEER_ID_INVALID|USER_NOT_FOUND|BOT_BLOCKED_BY_USER|INPUT_USER_DEACTIVATED|CHAT_WRITE_FORBIDDEN|CONTACT_NOT_FOUND/i.test(
        message,
      );

    // 4. Rate limited (non-flood or general throttle)
    const isRateLimited = isFloodWait || /SLOWMODE_WAIT|TOO_MANY_REQUESTS|RATE_LIMIT/i.test(message);

    let code = 'TELEGRAM_DISPATCH_ERROR';
    if (isFloodWait) code = 'FLOOD_WAIT';
    else if (isBanned) code = 'SENDER_BANNED';
    else if (isPermanent) code = 'PERMANENT_DISPATCH_FAILURE';
    else if (isRateLimited) code = 'RATE_LIMITED';

    return {
      isFloodWait,
      floodWaitSeconds,
      isBanned,
      isPermanent,
      isRateLimited,
      code,
      message,
    };
  }

  public async send(
    envelope: MessageQueueEnvelope,
    sender: SenderAccount,
    signal?: AbortSignal,
  ): Promise<DeliveryResult> {
    const startTime = Date.now();
    const rawRecipient = envelope.recipientPhone || envelope.recipientContactId || '';

    if (!this.validateRecipient(rawRecipient)) {
      return {
        success: false,
        messageId: envelope.messageId,
        channel: this.channel,
        senderAccountId: sender.id,
        recipient: rawRecipient,
        status: 'FAILED',
        errorCode: 'INVALID_RECIPIENT',
        errorMessage: `Invalid Telegram recipient format: '${rawRecipient}'`,
        isPermanentFailure: true,
        dispatchedAt: new Date(startTime),
        durationMs: Date.now() - startTime,
      };
    }

    const normalizedRecipient = this.normalizeRecipient(rawRecipient);
    const textContent = envelope.payload.text || '';

    try {
      if (signal?.aborted) {
        throw new Error('Telegram message dispatch cancelled via signal');
      }

      const res = await this.transport.sendMessage({
        recipient: normalizedRecipient,
        text: textContent,
        senderId: sender.id,
        mediaUrl: envelope.payload.mediaUrl,
        signal,
      });

      return {
        success: true,
        messageId: envelope.messageId,
        channel: this.channel,
        senderAccountId: sender.id,
        recipient: normalizedRecipient,
        status: 'SENT',
        externalMessageId: res.messageId,
        dispatchedAt: new Date(startTime),
        durationMs: Date.now() - startTime,
        metadata: {
          telegramDate: res.date,
        },
      };
    } catch (err: unknown) {
      const parsed = this.parseError(err);
      this.logger.warn(
        `Telegram dispatch error for sender ${sender.id} to ${normalizedRecipient}: [${parsed.code}] ${parsed.message}`,
      );

      return {
        success: false,
        messageId: envelope.messageId,
        channel: this.channel,
        senderAccountId: sender.id,
        recipient: normalizedRecipient,
        status: parsed.isPermanent ? 'FAILED' : 'REJECTED',
        errorCode: parsed.code,
        errorMessage: parsed.message,
        isPermanentFailure: parsed.isPermanent,
        isFloodWait: parsed.isFloodWait,
        retryAfterSeconds: parsed.floodWaitSeconds,
        dispatchedAt: new Date(startTime),
        durationMs: Date.now() - startTime,
      };
    }
  }
}
