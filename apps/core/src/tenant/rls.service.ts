import { Injectable } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { assertValidTenantId, TenantScopeMissingError } from './tenant-scope';
import { TenantContext } from './tenant-context';

export class RlsConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RlsConfigurationError';
  }
}

/**
 * Service providing PostgreSQL Row-Level Security (RLS) session management.
 * Enforces SET LOCAL app.current_tenant_id within isolated transactions,
 * guaranteeing multi-tenant row isolation at the database engine level (Defense-in-Depth).
 */
@Injectable()
export class RlsSessionService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Sets the local tenant context for the current PostgreSQL transaction.
   * Parameterized via set_config to prevent SQL injection.
   * is_local=true ensures the setting is scoped strictly to the current transaction.
   */
  async setLocalTenantId(tx: PrismaClient | any, tenantId: string): Promise<void> {
    const validTenantId = assertValidTenantId(tenantId);
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_tenant_id', $1, true)`,
      validTenantId,
    );
  }

  /**
   * Resets the local tenant setting in the current PostgreSQL transaction.
   */
  async resetLocalTenantId(tx: PrismaClient | any): Promise<void> {
    await tx.$executeRawUnsafe(
      `SELECT set_config('app.current_tenant_id', '', true)`,
    );
  }

  /**
   * Executes a callback within a transactional scope with SET LOCAL app.current_tenant_id applied.
   * If explicitTenantId is provided, it is validated and used.
   * Otherwise, the tenantId is extracted from TenantContext.
   */
  async runInTenantTransaction<T>(
    callback: (tx: PrismaClient | any) => Promise<T>,
    explicitTenantId?: string,
  ): Promise<T> {
    const tenantIdToUse = explicitTenantId ?? TenantContext.getTenantId();
    const validTenantId = assertValidTenantId(tenantIdToUse);

    return this.prisma.$transaction(async (tx) => {
      await this.setLocalTenantId(tx, validTenantId);
      return callback(tx);
    });
  }
}
