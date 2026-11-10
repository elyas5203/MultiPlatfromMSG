import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { assertValidTenantId } from '../tenant/tenant-scope';
import {
  SenderAccount,
  SenderStatus,
  SenderType,
  SenderNotFoundError,
  SenderAlreadyExistsError,
} from './types';

export interface CreateSenderAccountInput {
  id?: string;
  name?: string | null;
  platform: string;
  ownershipType?: SenderType | string;
  status?: SenderStatus | string;
  dailyQuota?: number;
  sentTodayCount?: number;
  sessionEncrypted?: string | null;
  cooldownUntil?: Date | null;
  cooldownReason?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface UpdateSenderHealthData {
  status: SenderStatus | string;
  cooldownUntil?: Date | null;
  cooldownReason?: string | null;
}

export interface ListSendersFilter {
  platform?: string;
  status?: SenderStatus | string;
  ownershipType?: SenderType | string;
}

@Injectable()
export class SendersRepository {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Creates a new sender account within the given tenant scope.
   */
  async create(tenantId: unknown, input: CreateSenderAccountInput): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);

    if (input.id) {
      const existing = await this.findById(validTenantId, input.id);
      if (existing) {
        throw new SenderAlreadyExistsError(input.id);
      }
    }

    try {
      const record = await this.prisma.senderAccount.create({
        data: {
          id: input.id,
          tenantId: validTenantId,
          name: input.name ?? null,
          platform: input.platform,
          ownershipType: input.ownershipType ?? 'CUSTOMER_CONNECTED',
          status: input.status ?? 'ACTIVE',
          dailyQuota: input.dailyQuota ?? 50,
          sentTodayCount: input.sentTodayCount ?? 0,
          sessionEncrypted: input.sessionEncrypted ?? null,
          cooldownUntil: input.cooldownUntil ?? null,
          cooldownReason: input.cooldownReason ?? null,
          metadata: (input.metadata as any) ?? undefined,
        },
      });
      return this.mapToDomain(record);
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new SenderAlreadyExistsError(input.id || 'duplicate');
      }
      throw err;
    }
  }

  /**
   * Finds a sender account by ID strictly within the tenant scope.
   */
  async findById(tenantId: unknown, id: string): Promise<SenderAccount | null> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return null;
    }

    const record = await this.prisma.senderAccount.findFirst({
      where: {
        id: id.trim(),
        tenantId: validTenantId,
      },
    });

    return record ? this.mapToDomain(record) : null;
  }

  /**
   * Lists sender accounts strictly within the tenant scope, with optional filtering.
   */
  async list(tenantId: unknown, filter?: ListSendersFilter): Promise<SenderAccount[]> {
    const validTenantId = assertValidTenantId(tenantId);
    const where: any = { tenantId: validTenantId };

    if (filter?.platform) {
      where.platform = filter.platform;
    }
    if (filter?.status) {
      where.status = filter.status;
    }
    if (filter?.ownershipType) {
      where.ownershipType = filter.ownershipType;
    }

    const records = await this.prisma.senderAccount.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });

    return records.map((r) => this.mapToDomain(r));
  }

  /**
   * Updates health status and cooldown attributes strictly within the tenant.
   */
  async updateHealth(
    tenantId: unknown,
    id: string,
    health: UpdateSenderHealthData,
  ): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    const existing = await this.findById(validTenantId, id);
    if (!existing) {
      throw new SenderNotFoundError(id, validTenantId);
    }

    const record = await this.prisma.senderAccount.update({
      where: {
        tenantId_id: {
          tenantId: validTenantId,
          id: id.trim(),
        },
      },
      data: {
        status: health.status,
        cooldownUntil: health.cooldownUntil !== undefined ? health.cooldownUntil : undefined,
        cooldownReason: health.cooldownReason !== undefined ? health.cooldownReason : undefined,
      },
    });

    return this.mapToDomain(record);
  }

  /**
   * Increments the sentTodayCount by a given amount.
   */
  async incrementSentCount(
    tenantId: unknown,
    id: string,
    incrementBy = 1,
  ): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    const existing = await this.findById(validTenantId, id);
    if (!existing) {
      throw new SenderNotFoundError(id, validTenantId);
    }

    const record = await this.prisma.senderAccount.update({
      where: {
        tenantId_id: {
          tenantId: validTenantId,
          id: id.trim(),
        },
      },
      data: {
        sentTodayCount: { increment: incrementBy },
      },
    });

    return this.mapToDomain(record);
  }

  /**
   * Resets sentTodayCount to 0 (e.g. for daily quota reset).
   */
  async resetSentCount(tenantId: unknown, id: string): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    const existing = await this.findById(validTenantId, id);
    if (!existing) {
      throw new SenderNotFoundError(id, validTenantId);
    }

    const record = await this.prisma.senderAccount.update({
      where: {
        tenantId_id: {
          tenantId: validTenantId,
          id: id.trim(),
        },
      },
      data: {
        sentTodayCount: 0,
      },
    });

    return this.mapToDomain(record);
  }

  /**
   * Updates the encrypted session envelope.
   */
  async updateSession(
    tenantId: unknown,
    id: string,
    sessionEncrypted: string,
  ): Promise<SenderAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    const existing = await this.findById(validTenantId, id);
    if (!existing) {
      throw new SenderNotFoundError(id, validTenantId);
    }

    const record = await this.prisma.senderAccount.update({
      where: {
        tenantId_id: {
          tenantId: validTenantId,
          id: id.trim(),
        },
      },
      data: {
        sessionEncrypted,
      },
    });

    return this.mapToDomain(record);
  }

  /**
   * Deletes a sender account strictly within tenant scope.
   */
  async delete(tenantId: unknown, id: string): Promise<boolean> {
    const validTenantId = assertValidTenantId(tenantId);
    const existing = await this.findById(validTenantId, id);
    if (!existing) {
      return false;
    }

    await this.prisma.senderAccount.delete({
      where: {
        tenantId_id: {
          tenantId: validTenantId,
          id: id.trim(),
        },
      },
    });
    return true;
  }

  /**
   * Clears all sender accounts belonging strictly to this tenant.
   */
  async clearTenant(tenantId: unknown): Promise<void> {
    const validTenantId = assertValidTenantId(tenantId);
    await this.prisma.senderAccount.deleteMany({
      where: { tenantId: validTenantId },
    });
  }

  private mapToDomain(record: any): SenderAccount {
    return {
      id: record.id,
      tenantId: record.tenantId,
      name: record.name ?? undefined,
      channel: record.platform,
      type: record.ownershipType as SenderType,
      status: record.status as SenderStatus,
      dailyQuota: record.dailyQuota,
      sentTodayCount: record.sentTodayCount,
      activeWorkloadCount: 0,
      sessionEncrypted: record.sessionEncrypted ?? undefined,
      cooldownUntil: record.cooldownUntil ?? undefined,
      cooldownReason: record.cooldownReason ?? undefined,
      metadata: (record.metadata as any) ?? undefined,
    };
  }
}
