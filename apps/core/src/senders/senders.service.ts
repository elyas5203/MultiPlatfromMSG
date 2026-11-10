import { Injectable, Optional } from '@nestjs/common';
import { KeyRing } from '../security/key-ring';
import { assertValidTenantId } from '../tenant/tenant-scope';
import { SendersRepository, CreateSenderAccountInput, ListSendersFilter } from './senders.repository';
import {
  SenderAccount,
  SenderStatus,
  SenderType,
  SenderRoutingError,
  SenderNotFoundError,
  InvalidSenderConfigError,
} from './types';

export class SenderQuotaExceededError extends SenderRoutingError {
  constructor(senderId: string, dailyQuota: number, sentTodayCount: number) {
    super(
      `Daily quota (${dailyQuota}) exceeded for sender '${senderId}'. Sent today: ${sentTodayCount}.`,
      'SENDER_QUOTA_EXCEEDED',
    );
    this.name = 'SenderQuotaExceededError';
  }
}

export class SenderInactiveError extends SenderRoutingError {
  constructor(senderId: string, status: string, reason?: string) {
    super(
      `Sender '${senderId}' is not active (current status: ${status}${reason ? ', reason: ' + reason : ''}).`,
      'SENDER_INACTIVE',
    );
    this.name = 'SenderInactiveError';
  }
}

export interface RegisterSenderServiceInput {
  id?: string;
  name?: string;
  channel?: string;
  platform?: string;
  type?: SenderType | string;
  ownershipType?: SenderType | string;
  status?: SenderStatus;
  dailyQuota?: number;
  sentTodayCount?: number;
  sessionData?: string | Buffer | Record<string, unknown>;
  sessionEncrypted?: string;
  cooldownUntil?: Date | null;
  cooldownReason?: string | null;
  metadata?: Record<string, unknown>;
}

export interface QuotaCheckResult {
  readonly allowed: boolean;
  readonly status: SenderStatus;
  readonly dailyQuota: number;
  readonly sentTodayCount: number;
  readonly remainingQuota: number;
  readonly reason?: string;
}

export const SENDER_SESSION_CRYPTO_PURPOSE = 'senders:session';

@Injectable()
export class SendersService {
  private readonly keyRing: KeyRing;

  constructor(
    private readonly repository: SendersRepository,
    @Optional() keyRing?: KeyRing,
  ) {
    if (keyRing) {
      this.keyRing = keyRing;
    } else if (process.env.KEY_RING_CONFIG) {
      this.keyRing = KeyRing.fromEnv(process.env.KEY_RING_CONFIG);
    } else {
      // Synthetic fallback key ring for testing/dev environments
      this.keyRing = new KeyRing({
        activeKeyId: 'k1',
        keys: [{ id: 'k1', key: Buffer.alloc(32, 0x5a) }],
      });
    }
  }

  /**
   * Registers a new sender account for a tenant.
   * If sessionData is supplied, it is encrypted via KeyRing v2 with tenant binding.
   */
  async registerSender(
    tenantId: unknown,
    input: RegisterSenderServiceInput,
  ): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);

    const platform = input.platform || input.channel;
    if (!platform || typeof platform !== 'string' || platform.trim().length === 0) {
      throw new InvalidSenderConfigError('Platform/channel is required.');
    }

    const dailyQuota = input.dailyQuota ?? 50;
    if (typeof dailyQuota !== 'number' || dailyQuota < 0 || !Number.isInteger(dailyQuota)) {
      throw new InvalidSenderConfigError('Daily quota must be a non-negative integer.');
    }

    let encryptedSession = input.sessionEncrypted ?? null;
    if (input.sessionData !== undefined && input.sessionData !== null) {
      let buf: Buffer;
      if (Buffer.isBuffer(input.sessionData)) {
        buf = input.sessionData;
      } else if (typeof input.sessionData === 'string') {
        buf = Buffer.from(input.sessionData, 'utf8');
      } else {
        buf = Buffer.from(JSON.stringify(input.sessionData), 'utf8');
      }
      encryptedSession = this.keyRing.encrypt(buf, validTenantId, SENDER_SESSION_CRYPTO_PURPOSE);
    }

    const ownershipType = input.ownershipType || input.type || 'CUSTOMER_CONNECTED';
    const status = input.status ?? 'ACTIVE';

    const repoInput: CreateSenderAccountInput = {
      id: input.id?.trim(),
      name: input.name?.trim() ?? null,
      platform: platform.trim(),
      ownershipType,
      status,
      dailyQuota,
      sentTodayCount: input.sentTodayCount ?? 0,
      sessionEncrypted: encryptedSession,
      cooldownUntil: input.cooldownUntil ?? null,
      cooldownReason: input.cooldownReason ?? null,
      metadata: input.metadata ?? null,
    };

    return this.repository.create(validTenantId, repoInput);
  }

  /**
   * Updates sender health status.
   */
  async updateHealth(
    tenantId: unknown,
    id: string,
    status: SenderStatus,
    options?: { cooldownUntil?: Date | null; cooldownReason?: string | null },
  ): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    const validStatuses: SenderStatus[] = ['ACTIVE', 'COOLDOWN', 'BANNED', 'DISABLED'];
    if (!validStatuses.includes(status)) {
      throw new InvalidSenderConfigError(`Invalid sender status '${status}'.`);
    }

    return this.repository.updateHealth(validTenantId, id, {
      status,
      cooldownUntil: options?.cooldownUntil,
      cooldownReason: options?.cooldownReason,
    });
  }

  /**
   * Sets sender to ACTIVE and clears cooldown details.
   */
  async markActive(tenantId: unknown, id: string): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.repository.updateHealth(validTenantId, id, {
      status: 'ACTIVE',
      cooldownUntil: null,
      cooldownReason: null,
    });
  }

  /**
   * Temporarily puts sender in COOLDOWN for durationSeconds.
   */
  async markCooldown(
    tenantId: unknown,
    id: string,
    durationSeconds: number,
    reason?: string,
  ): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    if (typeof durationSeconds !== 'number' || durationSeconds <= 0) {
      throw new InvalidSenderConfigError('Cooldown duration must be a positive number of seconds.');
    }

    const cooldownUntil = new Date(Date.now() + durationSeconds * 1000);
    return this.repository.updateHealth(validTenantId, id, {
      status: 'COOLDOWN',
      cooldownUntil,
      cooldownReason: reason ?? 'Temporary cooldown',
    });
  }

  /**
   * Permanently marks a sender as BANNED.
   */
  async markBanned(tenantId: unknown, id: string, reason?: string): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.repository.updateHealth(validTenantId, id, {
      status: 'BANNED',
      cooldownUntil: null,
      cooldownReason: reason ?? 'Platform TOS violation',
    });
  }

  /**
   * Evaluates if a sender has capacity and is healthy to send a message.
   * Auto-restores COOLDOWN to ACTIVE if cooldown period has expired.
   */
  async checkQuota(
    tenantId: unknown,
    id: string,
    now: Date = new Date(),
  ): Promise<QuotaCheckResult> {
    const validTenantId = assertValidTenantId(tenantId);
    let sender = await this.repository.findById(validTenantId, id);
    if (!sender) {
      throw new SenderNotFoundError(id, validTenantId);
    }

    // Auto-restore expired cooldown
    if (sender.status === 'COOLDOWN' && sender.cooldownUntil && now.getTime() >= new Date(sender.cooldownUntil).getTime()) {
      sender = await this.markActive(validTenantId, id);
    }

    const remainingQuota = Math.max(0, sender.dailyQuota - sender.sentTodayCount);

    if (sender.status === 'BANNED') {
      return {
        allowed: false,
        status: sender.status,
        dailyQuota: sender.dailyQuota,
        sentTodayCount: sender.sentTodayCount,
        remainingQuota: 0,
        reason: sender.cooldownReason || 'Sender account is permanently BANNED',
      };
    }

    if (sender.status === 'DISABLED') {
      return {
        allowed: false,
        status: sender.status,
        dailyQuota: sender.dailyQuota,
        sentTodayCount: sender.sentTodayCount,
        remainingQuota: 0,
        reason: 'Sender account is DISABLED',
      };
    }

    if (sender.status === 'COOLDOWN') {
      return {
        allowed: false,
        status: sender.status,
        dailyQuota: sender.dailyQuota,
        sentTodayCount: sender.sentTodayCount,
        remainingQuota: 0,
        reason: sender.cooldownReason || 'Sender account is in COOLDOWN',
      };
    }

    if (sender.sentTodayCount >= sender.dailyQuota) {
      return {
        allowed: false,
        status: sender.status,
        dailyQuota: sender.dailyQuota,
        sentTodayCount: sender.sentTodayCount,
        remainingQuota: 0,
        reason: `Daily quota of ${sender.dailyQuota} reached`,
      };
    }

    return {
      allowed: true,
      status: sender.status,
      dailyQuota: sender.dailyQuota,
      sentTodayCount: sender.sentTodayCount,
      remainingQuota,
    };
  }

  /**
   * Records a sent message, checking health and quota first.
   * Increments sentTodayCount on success.
   */
  async recordSentMessage(
    tenantId: unknown,
    id: string,
    now: Date = new Date(),
  ): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    const quotaResult = await this.checkQuota(validTenantId, id, now);

    if (!quotaResult.allowed) {
      if (quotaResult.status !== 'ACTIVE') {
        throw new SenderInactiveError(id, quotaResult.status, quotaResult.reason);
      }
      throw new SenderQuotaExceededError(id, quotaResult.dailyQuota, quotaResult.sentTodayCount);
    }

    return this.repository.incrementSentCount(validTenantId, id, 1);
  }

  /**
   * Decrypts the session credentials for this sender using the tenant key ring.
   * Enforces GCM authenticated data (AAD) binding to the tenant.
   */
  async decryptSession(tenantId: unknown, id: string): Promise<string | null> {
    const validTenantId = assertValidTenantId(tenantId);
    const sender = await this.repository.findById(validTenantId, id);
    if (!sender) {
      throw new SenderNotFoundError(id, validTenantId);
    }

    if (!sender.sessionEncrypted) {
      return null;
    }

    const decrypted = this.keyRing.decrypt(
      sender.sessionEncrypted,
      validTenantId,
      SENDER_SESSION_CRYPTO_PURPOSE,
    );
    return decrypted.toString('utf8');
  }

  /**
   * Re-encrypts the session using the current active key in the key ring.
   */
  async reencryptSession(tenantId: unknown, id: string): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    const sender = await this.repository.findById(validTenantId, id);
    if (!sender) {
      throw new SenderNotFoundError(id, validTenantId);
    }

    if (!sender.sessionEncrypted) {
      return sender;
    }

    const reencrypted = this.keyRing.reencrypt(
      sender.sessionEncrypted,
      validTenantId,
      SENDER_SESSION_CRYPTO_PURPOSE,
    );
    return this.repository.updateSession(validTenantId, id, reencrypted);
  }

  /**
   * Finds a sender account.
   */
  async getSender(tenantId: unknown, id: string): Promise<SenderAccount | null> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.repository.findById(validTenantId, id);
  }

  /**
   * Lists senders for a tenant with optional filtering.
   */
  async listSenders(
    tenantId: unknown,
    filter?: ListSendersFilter,
  ): Promise<SenderAccount[]> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.repository.list(validTenantId, filter);
  }

  /**
   * Returns the underlying KeyRing instance.
   */
  getKeyRing(): KeyRing {
    return this.keyRing;
  }
}
