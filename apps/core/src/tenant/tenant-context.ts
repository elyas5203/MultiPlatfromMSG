import { AsyncLocalStorage } from 'node:async_hooks';
import { assertValidTenantId, TenantScopeMissingError } from './tenant-scope';

export interface TenantContextStore {
  tenantId: string;
}

export class TenantContextMissingError extends TenantScopeMissingError {
  constructor(
    message = 'Tenant context is missing. Execution occurred outside of a valid runWithTenant context.',
  ) {
    super(message);
    this.name = 'TenantContextMissingError';
  }
}

/**
 * Standard Node.js AsyncLocalStorage-based tenant context carrier.
 * Guarantees execution isolation per asynchronous request execution flow.
 * Fail-closed: getTenantId() throws if accessed outside active tenant context.
 */
export class TenantContext {
  private static readonly storage = new AsyncLocalStorage<TenantContextStore>();

  /**
   * Executes the provided callback within the scope of the validated tenantId.
   */
  static runWithTenant<T>(tenantId: unknown, callback: () => T): T {
    const validTenantId = assertValidTenantId(tenantId);
    return this.storage.run({ tenantId: validTenantId }, callback);
  }

  /**
   * Retrieves the current validated tenantId from the active async context.
   * Throws TenantContextMissingError if no active context exists (Fail-closed).
   */
  static getTenantId(): string {
    const store = this.storage.getStore();
    if (!store || !store.tenantId) {
      throw new TenantContextMissingError();
    }
    return store.tenantId;
  }

  /**
   * Returns current tenantId if present in store, or undefined without throwing.
   */
  static getOptionalTenantId(): string | undefined {
    const store = this.storage.getStore();
    return store?.tenantId;
  }

  /**
   * Checks whether code is currently executing inside an active tenant context.
   */
  static hasContext(): boolean {
    const store = this.storage.getStore();
    return Boolean(store && store.tenantId);
  }
}
