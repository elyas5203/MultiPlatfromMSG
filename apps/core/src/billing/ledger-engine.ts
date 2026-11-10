/**
 * Billing Ledger Engine
 *
 * In-memory double-entry append-only accounting ledger and two-phase
 * credit reservation engine for MultiPlatformMsg.
 *
 * Adheres strictly to:
 * - AC-01: Append-only immutable LedgerEntry records with sequence, purpose, referenceId.
 * - AC-02: Deterministic algebraic net balance derivation; no mutable balance property.
 * - AC-03: Two-phase reservation workflow (reserve, settle, release) with overdraft prevention.
 * - AC-04: Integer/BigInt precision without any floating-point leaks.
 */

import { randomUUID } from 'node:crypto';
import {
  LedgerEntry,
  NewLedgerEntryInput,
  DoubleEntryTransactionInput,
  Reservation,
  ReserveCreditParams,
  SettleReservationParams,
  ReleaseReservationParams,
  AccountBalance,
  EntryType,
  InvalidAmountError,
  InsufficientFundsError,
  ReservationNotFoundError,
  ReservationConflictError,
  DuplicateEntryError,
} from './types';
import { LedgerCalculator } from './calculator';

export class BillingLedgerEngine {
  /**
   * Append-only ledger entries list.
   */
  private readonly entries: LedgerEntry[] = [];

  /**
   * Index of entry IDs for idempotency and uniqueness.
   */
  private readonly entryIds = new Set<string>();

  /**
   * Next sequence number per tenant:accountId.
   */
  private readonly sequenceCounters = new Map<string, bigint>();

  /**
   * Active and historical credit reservations indexed by reservationId.
   */
  private readonly reservations = new Map<string, Reservation>();

  /**
   * Configured credit limit (authorized overdraft ceiling) per tenant:accountId.
   * Default is 0n.
   */
  private readonly creditLimits = new Map<string, bigint>();

  private getAccountKey(tenantId: string, accountId: string): string {
    return `${tenantId}:${accountId}`;
  }

  /**
   * Appends an immutable ledger entry.
   * AC-01: Append-only with sequence, strictly positive amount, non-empty fields.
   */
  public appendEntry(input: NewLedgerEntryInput): LedgerEntry {
    if (!input.tenantId || typeof input.tenantId !== 'string' || input.tenantId.trim() === '') {
      throw new InvalidAmountError('tenantId must be a non-empty string.');
    }
    if (!input.accountId || typeof input.accountId !== 'string' || input.accountId.trim() === '') {
      throw new InvalidAmountError('accountId must be a non-empty string.');
    }
    if (input.entryType !== 'DEBIT' && input.entryType !== 'CREDIT') {
      throw new InvalidAmountError(`entryType must be 'DEBIT' or 'CREDIT', received: ${input.entryType}`);
    }
    if (!input.purpose || typeof input.purpose !== 'string' || input.purpose.trim() === '') {
      throw new InvalidAmountError('purpose must be a non-empty string.');
    }
    if (!input.referenceId || typeof input.referenceId !== 'string' || input.referenceId.trim() === '') {
      throw new InvalidAmountError('referenceId must be a non-empty string.');
    }

    const amount = LedgerCalculator.validateAmount(input.amount);

    const id = input.id ?? randomUUID();
    if (this.entryIds.has(id)) {
      throw new DuplicateEntryError(`Ledger entry with ID '${id}' already exists.`);
    }

    const accountKey = this.getAccountKey(input.tenantId, input.accountId);
    const nextSeq = (this.sequenceCounters.get(accountKey) ?? 0n) + 1n;
    this.sequenceCounters.set(accountKey, nextSeq);

    const entry: LedgerEntry = Object.freeze({
      id,
      tenantId: input.tenantId.trim(),
      accountId: input.accountId.trim(),
      sequence: nextSeq,
      entryType: input.entryType,
      amount,
      purpose: input.purpose.trim(),
      referenceId: input.referenceId.trim(),
      timestamp: input.timestamp ? new Date(input.timestamp.getTime()) : new Date(),
      metadata: input.metadata ? Object.freeze({ ...input.metadata }) : undefined,
    });

    this.entries.push(entry);
    this.entryIds.add(id);

    return entry;
  }

  /**
   * Records a balanced double-entry transaction between two accounts.
   * Atomically appends a DEBIT to debitAccountId and a CREDIT to creditAccountId.
   */
  public recordDoubleEntryTransaction(input: DoubleEntryTransactionInput): {
    debitEntry: LedgerEntry;
    creditEntry: LedgerEntry;
  } {
    const amount = LedgerCalculator.validateAmount(input.amount);
    if (!input.tenantId || !input.debitAccountId || !input.creditAccountId) {
      throw new InvalidAmountError('tenantId, debitAccountId, and creditAccountId are required.');
    }
    if (input.debitAccountId === input.creditAccountId) {
      throw new InvalidAmountError('debitAccountId and creditAccountId must be different accounts.');
    }

    const timestamp = input.timestamp ? new Date(input.timestamp.getTime()) : new Date();

    const debitEntry = this.appendEntry({
      id: `${input.transactionId}:debit`,
      tenantId: input.tenantId,
      accountId: input.debitAccountId,
      entryType: 'DEBIT',
      amount,
      purpose: input.purpose,
      referenceId: input.referenceId,
      timestamp,
      metadata: {
        ...input.metadata,
        transactionId: input.transactionId,
        counterpartyAccountId: input.creditAccountId,
      },
    });

    const creditEntry = this.appendEntry({
      id: `${input.transactionId}:credit`,
      tenantId: input.tenantId,
      accountId: input.creditAccountId,
      entryType: 'CREDIT',
      amount,
      purpose: input.purpose,
      referenceId: input.referenceId,
      timestamp,
      metadata: {
        ...input.metadata,
        transactionId: input.transactionId,
        counterpartyAccountId: input.debitAccountId,
      },
    });

    return { debitEntry, creditEntry };
  }

  /**
   * Computes the current balance summary for an account.
   * AC-02: Balance is computed dynamically; zero mutable balance fields.
   */
  public getBalance(tenantId: string, accountId: string): AccountBalance {
    const creditLimit = this.getCreditLimit(tenantId, accountId);
    return LedgerCalculator.summarizeAccount({
      tenantId,
      accountId,
      entries: this.entries,
      reservations: Array.from(this.reservations.values()),
      creditLimit,
    });
  }

  /**
   * Sets an authorized credit limit (overdraft ceiling) for an account.
   * Must have an audit reason.
   */
  public setCreditLimit(tenantId: string, accountId: string, limit: bigint, reason: string): void {
    if (typeof limit !== 'bigint' || limit < 0n) {
      throw new InvalidAmountError(`Credit limit must be a non-negative BigInt (>= 0n), received: ${limit}`);
    }
    if (!reason || typeof reason !== 'string' || reason.trim() === '') {
      throw new InvalidAmountError('A valid audit reason is required when modifying credit limits.');
    }
    const key = this.getAccountKey(tenantId, accountId);
    this.creditLimits.set(key, limit);
  }

  /**
   * Retrieves the credit limit for an account (defaults to 0n).
   */
  public getCreditLimit(tenantId: string, accountId: string): bigint {
    const key = this.getAccountKey(tenantId, accountId);
    return this.creditLimits.get(key) ?? 0n;
  }

  /**
   * AC-03: Two-phase reservation - Phase 1: Reserve
   * Holds credit for a campaign or operation without creating a premature debit entry.
   * Prevents overdraft beyond allowed creditLimit.
   */
  public reserve(params: ReserveCreditParams): Reservation {
    if (!params.reservationId || params.reservationId.trim() === '') {
      throw new InvalidAmountError('reservationId must be a non-empty string.');
    }
    const amount = LedgerCalculator.validateAmount(params.amount);

    const existing = this.reservations.get(params.reservationId);
    if (existing) {
      // Idempotency check: if identical parameters, return existing reservation
      if (
        existing.tenantId === params.tenantId &&
        existing.accountId === params.accountId &&
        existing.amount === amount &&
        existing.referenceId === params.referenceId
      ) {
        return existing;
      }
      throw new ReservationConflictError(
        `Reservation with ID '${params.reservationId}' already exists with different parameters.`,
      );
    }

    const balance = this.getBalance(params.tenantId, params.accountId);
    if (balance.availableBalance < amount) {
      throw new InsufficientFundsError({
        tenantId: params.tenantId,
        accountId: params.accountId,
        requested: amount,
        available: balance.availableBalance,
        creditLimit: balance.creditLimit,
      });
    }

    const now = new Date();
    const reservation: Reservation = Object.freeze({
      id: params.reservationId.trim(),
      tenantId: params.tenantId.trim(),
      accountId: params.accountId.trim(),
      amount,
      settledAmount: 0n,
      releasedAmount: 0n,
      status: 'ACTIVE',
      purpose: params.purpose.trim(),
      referenceId: params.referenceId.trim(),
      createdAt: now,
      updatedAt: now,
      metadata: params.metadata ? Object.freeze({ ...params.metadata }) : undefined,
    });

    this.reservations.set(reservation.id, reservation);
    return reservation;
  }

  /**
   * AC-03: Two-phase reservation - Phase 2a: Settle (Commit)
   * Turns consumed portion of reservation into an immutable DEBIT ledger entry.
   */
  public settle(params: SettleReservationParams): {
    entry: LedgerEntry;
    reservation: Reservation;
    remainingReserved: bigint;
  } {
    const reservation = this.reservations.get(params.reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(params.reservationId);
    }

    if (reservation.status !== 'ACTIVE') {
      throw new ReservationConflictError(
        `Reservation '${params.reservationId}' is in status '${reservation.status}' and cannot be settled.`,
      );
    }

    const settleAmount = LedgerCalculator.validateAmount(params.settleAmount);
    const uncommitted = reservation.amount - reservation.settledAmount - reservation.releasedAmount;

    if (settleAmount > uncommitted) {
      throw new InvalidAmountError(
        `Settle amount (${settleAmount}) exceeds remaining uncommitted reservation amount (${uncommitted}).`,
      );
    }

    // Append immutable DEBIT entry
    const entry = this.appendEntry({
      tenantId: reservation.tenantId,
      accountId: reservation.accountId,
      entryType: 'DEBIT',
      amount: settleAmount,
      purpose: params.purpose ?? reservation.purpose,
      referenceId: params.referenceId ?? reservation.referenceId,
      metadata: {
        ...params.metadata,
        reservationId: reservation.id,
        phase: 'SETTLE',
      },
    });

    const newSettledAmount = reservation.settledAmount + settleAmount;
    const remainingReserved = reservation.amount - newSettledAmount - reservation.releasedAmount;
    const newStatus = remainingReserved === 0n ? 'SETTLED' : 'ACTIVE';

    const updatedReservation: Reservation = Object.freeze({
      ...reservation,
      settledAmount: newSettledAmount,
      status: newStatus,
      updatedAt: new Date(),
    });

    this.reservations.set(reservation.id, updatedReservation);

    return {
      entry,
      reservation: updatedReservation,
      remainingReserved,
    };
  }

  /**
   * AC-03: Two-phase reservation - Phase 2b: Release
   * Immediately releases any unconsumed reserved credit back to available balance without credit leak.
   */
  public release(params: ReleaseReservationParams): {
    reservation: Reservation;
    releasedAmount: bigint;
  } {
    const reservation = this.reservations.get(params.reservationId);
    if (!reservation) {
      throw new ReservationNotFoundError(params.reservationId);
    }

    if (reservation.status === 'RELEASED' || reservation.status === 'SETTLED') {
      // Idempotent no-op
      return {
        reservation,
        releasedAmount: 0n,
      };
    }

    const remaining = reservation.amount - reservation.settledAmount - reservation.releasedAmount;
    const newReleasedAmount = reservation.releasedAmount + remaining;

    const updatedReservation: Reservation = Object.freeze({
      ...reservation,
      releasedAmount: newReleasedAmount,
      status: 'RELEASED',
      releaseReason: params.reason,
      updatedAt: new Date(),
    });

    this.reservations.set(reservation.id, updatedReservation);

    return {
      reservation: updatedReservation,
      releasedAmount: remaining,
    };
  }

  /**
   * SuperAdmin manual adjustment with mandatory reason and admin audit tracking.
   */
  public adjustCredit(params: {
    tenantId: string;
    accountId: string;
    amount: bigint;
    entryType: EntryType;
    reason: string;
    adminId: string;
    referenceId: string;
  }): LedgerEntry {
    if (!params.adminId || params.adminId.trim() === '') {
      throw new InvalidAmountError('adminId is required for manual balance adjustments.');
    }
    if (!params.reason || params.reason.trim() === '') {
      throw new InvalidAmountError('reason is required for manual balance adjustments.');
    }

    return this.appendEntry({
      tenantId: params.tenantId,
      accountId: params.accountId,
      entryType: params.entryType,
      amount: params.amount,
      purpose: `SuperAdmin Adjustment: ${params.reason}`,
      referenceId: params.referenceId,
      metadata: {
        adminId: params.adminId,
        adjustmentReason: params.reason,
      },
    });
  }

  public getReservation(reservationId: string): Reservation | undefined {
    return this.reservations.get(reservationId);
  }

  public getEntries(tenantId?: string, accountId?: string): readonly LedgerEntry[] {
    let result = this.entries;
    if (tenantId) {
      result = result.filter((e) => e.tenantId === tenantId);
    }
    if (accountId) {
      result = result.filter((e) => e.accountId === accountId);
    }
    return Object.freeze([...result]);
  }

  public getActiveReservations(tenantId?: string, accountId?: string): readonly Reservation[] {
    const list = Array.from(this.reservations.values()).filter((r) => r.status === 'ACTIVE');
    let result = list;
    if (tenantId) {
      result = result.filter((r) => r.tenantId === tenantId);
    }
    if (accountId) {
      result = result.filter((r) => r.accountId === accountId);
    }
    return Object.freeze([...result]);
  }
}
