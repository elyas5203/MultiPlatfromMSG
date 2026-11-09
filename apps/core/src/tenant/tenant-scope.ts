import { Injectable } from '@nestjs/common';

export class TenantScopeMissingError extends Error {
  constructor(message = 'Tenant scope identifier (tenant_id) is required and cannot be empty.') {
    super(message);
    this.name = 'TenantScopeMissingError';
  }
}

export class TenantScopeInvalidError extends Error {
  constructor(message = 'Tenant scope identifier (tenant_id) is invalid.') {
    super(message);
    this.name = 'TenantScopeInvalidError';
  }
}

export interface TenantScopedRecord {
  id: string;
  tenantId: string;
  payload: Record<string, unknown>;
  createdAt: Date;
}

const VALID_TENANT_ID_REGEX = /^[a-zA-Z0-9_-]{1,64}$/;

export function assertValidTenantId(tenantId: unknown): string {
  if (tenantId === null || tenantId === undefined) {
    throw new TenantScopeMissingError();
  }

  if (typeof tenantId !== 'string') {
    throw new TenantScopeInvalidError('tenant_id must be a string.');
  }

  const trimmed = tenantId.trim();
  if (trimmed.length === 0) {
    throw new TenantScopeMissingError();
  }

  if (!VALID_TENANT_ID_REGEX.test(trimmed)) {
    throw new TenantScopeInvalidError(
      `tenant_id contains invalid characters or exceeds 64 characters: "${trimmed}".`,
    );
  }

  return trimmed;
}

/**
 * Deep clones serializable records / payloads using structuredClone or fallback.
 * Guarantees that internal storage and returned records never share mutable references across calls or tenants.
 */
function deepClone<T>(val: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(val);
  }
  return JSON.parse(JSON.stringify(val)) as T;
}

@Injectable()
export class InMemoryTenantScopeRepository {
  private readonly records = new Map<string, TenantScopedRecord>();

  save(tenantId: unknown, id: string, payload: Record<string, unknown>): TenantScopedRecord {
    const validTenantId = assertValidTenantId(tenantId);

    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      throw new Error('Record id is required.');
    }

    const trimmedId = id.trim();
    const record: TenantScopedRecord = {
      id: trimmedId,
      tenantId: validTenantId,
      payload: deepClone(payload),
      createdAt: new Date(),
    };

    // Stored uniquely by tenantId:id composite key to guarantee complete in-memory isolation
    this.records.set(this.compositeKey(validTenantId, trimmedId), record);
    return {
      ...record,
      payload: deepClone(record.payload),
    };
  }

  findById(tenantId: unknown, id: string): TenantScopedRecord | null {
    const validTenantId = assertValidTenantId(tenantId);

    if (!id || typeof id !== 'string') {
      return null;
    }

    const trimmedId = id.trim();
    const key = this.compositeKey(validTenantId, trimmedId);
    const found = this.records.get(key);

    if (!found) {
      return null;
    }

    // Defensive check to ensure isolation
    if (found.tenantId !== validTenantId) {
      return null;
    }

    return {
      ...found,
      payload: deepClone(found.payload),
    };
  }

  findAll(tenantId: unknown): TenantScopedRecord[] {
    const validTenantId = assertValidTenantId(tenantId);

    const results: TenantScopedRecord[] = [];
    for (const record of this.records.values()) {
      if (record.tenantId === validTenantId) {
        results.push({
          ...record,
          payload: deepClone(record.payload),
        });
      }
    }

    return results;
  }

  countByTenant(tenantId: unknown): number {
    const validTenantId = assertValidTenantId(tenantId);
    let count = 0;
    for (const record of this.records.values()) {
      if (record.tenantId === validTenantId) {
        count++;
      }
    }
    return count;
  }

  /**
   * Clears records strictly within the boundary of the specified tenant.
   * Cross-tenant wipe without tenantId is strictly prohibited.
   */
  clear(tenantId: unknown): void {
    this.clearTenant(tenantId);
  }

  /**
   * Clears records strictly within the boundary of a specific tenant.
   * Cross-tenant wipe is strictly prohibited by architectural governance.
   */
  clearTenant(tenantId: unknown): void {
    const validTenantId = assertValidTenantId(tenantId);
    for (const [key, record] of this.records.entries()) {
      if (record.tenantId === validTenantId) {
        this.records.delete(key);
      }
    }
  }

  private compositeKey(tenantId: string, id: string): string {
    return `${tenantId}::${id}`;
  }
}
