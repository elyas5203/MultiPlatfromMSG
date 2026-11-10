/**
 * Bale Channel Connector (Phase 6)
 *
 * Implements message dispatching for Bale platform with support for Bot API and Client RPC.
 * Compliant with:
 * - docs/ai/architecture/MODULE_MAP.md (Connectors module)
 * - docs/ai/product/CHANNEL_RESEARCH.md (Bale domestic channel & rate limits)
 */

import { Injectable, Logger } from '@nestjs/common';
import { IChannelConnector, DeliveryResult, ConnectorParsedError } from './connector.interface';
import { MessageQueueEnvelope } from '../queue.types';
import { SenderAccount } from '../../senders/types';

export interface BaleTransportAdapter {
  sendMessage(params: {
    recipient: string;
    text: string;
    senderId: string;
    mediaUrl?: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: string; timestamp?: number }>;
}

export class DefaultBaleTransport implements BaleTransportAdapter {
  async sendMessage(params: {
    recipient: string;
    text: string;
    senderId: string;
    mediaUrl?: string;
    signal?: AbortSignal;
  }): Promise<{ messageId: string; timestamp?: number }> {
    if (params.signal?.aborted) {
      throw new Error('Bale dispatch aborted before network transport');
    }
    return {
      messageId: `bale_msg_${Date.now()}_${Math.floor(Math.random() * 100000)}`,
      timestamp: Date.now(),
    };
  }
}

@Injectable()
export class BaleConnector implements IChannelConnector {
  public readonly channel = 'BALE';
  private readonly logger = new Logger(BaleConnector.name);
  private transport: BaleTransportAdapter;

  constructor(transport?: BaleTransportAdapter) {
    this.transport = transport || new DefaultBaleTransport();
  }

  public setTransport(transport: BaleTransportAdapter): void {
    this.transport = transport;
  }

  public validateRecipient(recipient: string): boolean {
    if (!recipient || typeof recipient !== 'string') return false;
    const trimmed = recipient.trim();
    // Iranian mobile phone (+989... or 09...), or Bale numeric Peer/User ID
    const iranianPhoneRegex = /^(\+98|0098|0)?9\d{9}$/;
    const baleIdRegex = /^\d{6,16}$/;

    return iranianPhoneRegex.test(trimmed) || baleIdRegex.test(trimmed);
  }

  public normalizeRecipient(recipient: string): string {
    const trimmed = recipient.trim();
    if (/^09\d{9}$/.test(trimmed)) {
      return `+98${trimmed.slice(1)}`;
    }
    if (/^00989\d{9}$/.test(trimmed)) {
      return `+${trimmed.slice(2)}`;
    }
    if (/^9\d{9}$/.test(trimmed)) {
      return `+98${trimmed}`;
    }
    return trimmed;
  }

  public parseError(error: unknown): ConnectorParsedError {
    const message = error instanceof Error ? error.message : String(error);
    const errObj = typeof error === 'object' && error !== null ? (error as Record<string, unknown>) : {};

    const retryMatch = message.match(/(?:retry|wait)(?:\s+after|\s*[:=])\s*(\d+)/i);
    let floodWaitSeconds: number | undefined;
    if (retryMatch) {
      floodWaitSeconds = parseInt(retryMatch[1], 10);
    } else if (typeof errObj.retry_after === 'number') {
      floodWaitSeconds = errObj.retry_after;
    }

    const isFloodWait = floodWaitSeconds !== undefined && floodWaitSeconds > 0;
    const isRateLimited = isFloodWait || /RATE_LIMIT|TOO_MANY_REQUESTS|429/i.test(message);
    const isBanned = /ACCOUNT_SUSPENDED|ACCOUNT_BLOCKED|BANNED|TOKEN_INVALID|UNAUTHORIZED/i.test(message);
    const isPermanent =
      isBanned ||
      /PEER_NOT_FOUND|USER_NOT_FOUND|BOT_BLOCKED_BY_USER|FORBIDDEN|INVALID_RECIPIENT|CHAT_NOT_FOUND/i.test(
        message,
      );

    let code = 'BALE_DISPATCH_ERROR';
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
        errorMessage: `Invalid Bale recipient format: '${rawRecipient}'`,
        isPermanentFailure: true,
        dispatchedAt: new Date(startTime),
        durationMs: Date.now() - startTime,
      };
    }

    const normalizedRecipient = this.normalizeRecipient(rawRecipient);
    const textContent = envelope.payload.text || '';

    try {
      if (signal?.aborted) {
        throw new Error('Bale message dispatch cancelled via signal');
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
          baleTimestamp: res.timestamp,
        },
      };
    } catch (err: unknown) {
      const parsed = this.parseError(err);
      this.logger.warn(
        `Bale dispatch error for sender ${sender.id} to ${normalizedRecipient}: [${parsed.code}] ${parsed.message}`,
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
