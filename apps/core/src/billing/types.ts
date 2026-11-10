/**
 * Billing Ledger Types & Interfaces
 *
 * Implements strict append-only double-entry ledger specifications
 * according to MultiPlatformMsg architecture governance (Rule 2).
 */

export type EntryType = 'DEBIT' | 'CREDIT';

export type ReservationStatus = 'ACTIVE' | 'SETTLED' | 'RELEASED';

/**
 * Immutable append-only ledger entry record.
 * AC-01: Contains tenantId, accountId, sequence, entryType, amount, purpose, referenceId, timestamp.
 */
export interface LedgerEntry {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly sequence: bigint;
  readonly entryType: EntryType;
  readonly amount: bigint;
  readonly purpose: string;
  readonly referenceId: string;
  readonly timestamp: Date;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Input structure to append a new ledger entry.
 */
export interface NewLedgerEntryInput {
  readonly id?: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly entryType: EntryType;
  readonly amount: bigint;
  readonly purpose: string;
  readonly referenceId: string;
  readonly timestamp?: Date;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Structure for balanced double-entry transactions (e.g., Transfer, Top-up, Fee).
 */
export interface DoubleEntryTransactionInput {
  readonly transactionId: string;
  readonly tenantId: string;
  readonly debitAccountId: string;
  readonly creditAccountId: string;
  readonly amount: bigint;
  readonly purpose: string;
  readonly referenceId: string;
  readonly timestamp?: Date;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Two-phase credit reservation record.
 * AC-03: Holds reserved credit during campaign execution until settled or released.
 */
export interface Reservation {
  readonly id: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly amount: bigint;
  readonly settledAmount: bigint;
  readonly releasedAmount: bigint;
  readonly status: ReservationStatus;
  readonly purpose: string;
  readonly referenceId: string;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly releaseReason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReserveCreditParams {
  readonly reservationId: string;
  readonly tenantId: string;
  readonly accountId: string;
  readonly amount: bigint;
  readonly purpose: string;
  readonly referenceId: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface SettleReservationParams {
  readonly reservationId: string;
  readonly settleAmount: bigint;
  readonly purpose?: string;
  readonly referenceId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReleaseReservationParams {
  readonly reservationId: string;
  readonly reason?: string;
}

/**
 * Calculated account balance summary.
 * Strictly calculated algebraically from immutable records; never directly mutable.
 */
export interface AccountBalance {
  readonly tenantId: string;
  readonly accountId: string;
  readonly creditSum: bigint;
  readonly debitSum: bigint;
  readonly netBalance: bigint;
  readonly activeReservationsSum: bigint;
  readonly availableBalance: bigint;
  readonly creditLimit: bigint;
}

/**
 * Custom Error hierarchy for billing operations.
 */
export class BillingError extends Error {
  public readonly code: string;

  constructor(message: string, code = 'BILLING_ERROR') {
    super(message);
    this.name = 'BillingError';
    this.code = code;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidAmountError extends BillingError {
  constructor(message: string) {
    super(message, 'INVALID_AMOUNT');
    this.name = 'InvalidAmountError';
  }
}

export class InsufficientFundsError extends BillingError {
  public readonly tenantId: string;
  public readonly accountId: string;
  public readonly requested: bigint;
  public readonly available: bigint;
  public readonly creditLimit: bigint;

  constructor(details: {
    tenantId: string;
    accountId: string;
    requested: bigint;
    available: bigint;
    creditLimit: bigint;
  }) {
    super(
      `Insufficient funds for tenant '${details.tenantId}', account '${details.accountId}'. Requested: ${details.requested}, Available: ${details.available} (Credit Limit: ${details.creditLimit})`,
      'INSUFFICIENT_FUNDS',
    );
    this.name = 'InsufficientFundsError';
    this.tenantId = details.tenantId;
    this.accountId = details.accountId;
    this.requested = details.requested;
    this.available = details.available;
    this.creditLimit = details.creditLimit;
  }
}

export class ReservationNotFoundError extends BillingError {
  constructor(reservationId: string) {
    super(`Reservation '${reservationId}' not found.`, 'RESERVATION_NOT_FOUND');
    this.name = 'ReservationNotFoundError';
  }
}

export class ReservationConflictError extends BillingError {
  constructor(message: string) {
    super(message, 'RESERVATION_CONFLICT');
    this.name = 'ReservationConflictError';
  }
}

export class DuplicateEntryError extends BillingError {
  constructor(message: string) {
    super(message, 'DUPLICATE_ENTRY');
    this.name = 'DuplicateEntryError';
  }
}

export class InvalidSequenceError extends BillingError {
  constructor(message: string) {
    super(message, 'INVALID_SEQUENCE');
    this.name = 'InvalidSequenceError';
  }
}
