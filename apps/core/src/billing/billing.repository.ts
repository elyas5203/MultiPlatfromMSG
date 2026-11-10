import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { assertValidTenantId } from '../tenant/tenant-scope';
import {
  Account as PrismaAccount,
  LedgerEntry as PrismaLedgerEntry,
  CreditReservation as PrismaCreditReservation,
  Prisma,
} from '@prisma/client';
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
  ReservationStatus,
  InvalidAmountError,
  InsufficientFundsError,
  ReservationNotFoundError,
  ReservationConflictError,
} from './types';
import { LedgerCalculator } from './calculator';

export interface CreateAccountInput {
  id?: string;
  name: string;
  type?: 'CUSTOMER' | 'SYSTEM' | 'ESCROW' | 'REVENUE' | string;
  currency?: string;
  creditLimit?: bigint;
  status?: 'ACTIVE' | 'SUSPENDED' | 'CLOSED' | string;
}

export class AccountNotFoundError extends Error {
  constructor(message = 'Account not found within tenant scope.') {
    super(message);
    this.name = 'AccountNotFoundError';
  }
}

function mapPrismaLedgerEntry(entry: PrismaLedgerEntry): LedgerEntry {
  return Object.freeze({
    id: entry.id,
    tenantId: entry.tenantId,
    accountId: entry.accountId,
    sequence: entry.sequence,
    entryType: entry.entryType as EntryType,
    amount: entry.amount,
    purpose: entry.purpose,
    referenceId: entry.referenceId,
    timestamp: entry.timestamp,
    metadata: entry.metadata ? Object.freeze(entry.metadata as Record<string, unknown>) : undefined,
  });
}

function mapPrismaReservation(res: PrismaCreditReservation): Reservation {
  return Object.freeze({
    id: res.id,
    tenantId: res.tenantId,
    accountId: res.accountId,
    amount: res.amount,
    settledAmount: res.settledAmount,
    releasedAmount: res.releasedAmount,
    status: res.status as ReservationStatus,
    purpose: res.purpose,
    referenceId: res.referenceId,
    releaseReason: res.releaseReason ?? undefined,
    createdAt: res.createdAt,
    updatedAt: res.updatedAt,
    metadata: res.metadata ? Object.freeze(res.metadata as Record<string, unknown>) : undefined,
  });
}

@Injectable()
export class BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ==================== Account Operations ====================

  /**
   * Creates a new financial account strictly scoped to the tenant.
   */
  async createAccount(tenantId: unknown, input: CreateAccountInput): Promise<PrismaAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!input || !input.name || typeof input.name !== 'string' || input.name.trim().length === 0) {
      throw new Error('Account name is required.');
    }

    const creditLimit = input.creditLimit !== undefined ? input.creditLimit : 0n;
    if (creditLimit < 0n) {
      throw new InvalidAmountError(`creditLimit cannot be negative: ${creditLimit}`);
    }

    return this.prisma.account.create({
      data: {
        id: input.id,
        tenantId: validTenantId,
        name: input.name.trim(),
        type: input.type?.trim() ?? 'CUSTOMER',
        currency: input.currency?.trim() ?? 'IRR',
        creditLimit,
        status: input.status?.trim() ?? 'ACTIVE',
      },
    });
  }

  /**
   * Finds an account by ID strictly within tenant scope.
   */
  async findAccountById(tenantId: unknown, accountId: string): Promise<PrismaAccount | null> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!accountId || typeof accountId !== 'string' || accountId.trim().length === 0) {
      return null;
    }

    return this.prisma.account.findFirst({
      where: {
        id: accountId.trim(),
        tenantId: validTenantId,
      },
    });
  }

  /**
   * Lists all accounts strictly within tenant scope.
   */
  async listAccounts(tenantId: unknown): Promise<PrismaAccount[]> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.account.findMany({
      where: { tenantId: validTenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * Sets credit limit (overdraft allowance) for an account within tenant scope.
   */
  async setCreditLimit(
    tenantId: unknown,
    accountId: string,
    creditLimit: bigint,
    reason?: string,
  ): Promise<PrismaAccount> {
    const validTenantId = assertValidTenantId(tenantId);
    if (typeof creditLimit !== 'bigint' || creditLimit < 0n) {
      throw new InvalidAmountError(`creditLimit must be a non-negative BigInt (>= 0n), received: ${creditLimit}`);
    }

    const account = await this.findAccountById(validTenantId, accountId);
    if (!account) {
      throw new AccountNotFoundError(`Account '${accountId}' not found in tenant '${validTenantId}'.`);
    }

    return this.prisma.account.update({
      where: {
        tenantId_id: {
          tenantId: validTenantId,
          id: account.id,
        },
      },
      data: {
        creditLimit,
      },
    });
  }

  // ==================== Append-Only Ledger Entry Operations ====================

  /**
   * Appends an immutable ledger entry.
   * Strictly append-only: ensures atomic monotonic sequence per (tenantId, accountId).
   */
  async appendEntry(tenantId: unknown, input: NewLedgerEntryInput): Promise<LedgerEntry> {
    const validTenantId = assertValidTenantId(tenantId);
    if (input.tenantId && input.tenantId !== validTenantId) {
      throw new Error(`Input tenantId '${input.tenantId}' does not match context tenantId '${validTenantId}'.`);
    }

    const amount = LedgerCalculator.validateAmount(input.amount);
    const accountId = input.accountId?.trim();
    if (!accountId) {
      throw new Error('accountId is required.');
    }

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findFirst({
        where: { id: accountId, tenantId: validTenantId },
      });
      if (!account) {
        throw new AccountNotFoundError(`Account '${accountId}' not found in tenant '${validTenantId}'.`);
      }

      // Calculate next monotonic sequence for this account
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { tenantId: validTenantId, accountId: account.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });

      const nextSequence = lastEntry ? lastEntry.sequence + 1n : 1n;

      const created = await tx.ledgerEntry.create({
        data: {
          id: input.id,
          tenantId: validTenantId,
          accountId: account.id,
          sequence: nextSequence,
          entryType: input.entryType,
          amount,
          purpose: input.purpose.trim(),
          referenceId: input.referenceId.trim(),
          metadata: (input.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
          timestamp: input.timestamp ?? new Date(),
        },
      });

      return mapPrismaLedgerEntry(created);
    });
  }

  /**
   * Executes a balanced double-entry transaction atomically in PostgreSQL.
   */
  async executeDoubleEntry(
    tenantId: unknown,
    input: DoubleEntryTransactionInput,
  ): Promise<{ debitEntry: LedgerEntry; creditEntry: LedgerEntry }> {
    const validTenantId = assertValidTenantId(tenantId);
    if (input.tenantId && input.tenantId !== validTenantId) {
      throw new Error(`Transaction tenantId '${input.tenantId}' does not match context tenantId '${validTenantId}'.`);
    }

    const amount = LedgerCalculator.validateAmount(input.amount);
    const debitAccountId = input.debitAccountId?.trim();
    const creditAccountId = input.creditAccountId?.trim();

    if (!debitAccountId || !creditAccountId) {
      throw new Error('Both debitAccountId and creditAccountId are required.');
    }
    if (debitAccountId === creditAccountId) {
      throw new Error('debitAccountId and creditAccountId must be different accounts.');
    }

    return this.prisma.$transaction(async (tx) => {
      // Verify both accounts belong to the tenant
      const debitAccount = await tx.account.findFirst({
        where: { id: debitAccountId, tenantId: validTenantId },
      });
      if (!debitAccount) {
        throw new AccountNotFoundError(`Debit account '${debitAccountId}' not found in tenant '${validTenantId}'.`);
      }

      const creditAccount = await tx.account.findFirst({
        where: { id: creditAccountId, tenantId: validTenantId },
      });
      if (!creditAccount) {
        throw new AccountNotFoundError(`Credit account '${creditAccountId}' not found in tenant '${validTenantId}'.`);
      }

      // Next sequence for debit account
      const lastDebit = await tx.ledgerEntry.findFirst({
        where: { tenantId: validTenantId, accountId: debitAccount.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const debitSeq = lastDebit ? lastDebit.sequence + 1n : 1n;

      // Next sequence for credit account
      const lastCredit = await tx.ledgerEntry.findFirst({
        where: { tenantId: validTenantId, accountId: creditAccount.id },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const creditSeq = lastCredit ? lastCredit.sequence + 1n : 1n;

      const txTime = input.timestamp ?? new Date();

      const debitEntry = await tx.ledgerEntry.create({
        data: {
          tenantId: validTenantId,
          accountId: debitAccount.id,
          sequence: debitSeq,
          entryType: 'DEBIT',
          amount,
          purpose: input.purpose.trim(),
          referenceId: input.referenceId.trim(),
          metadata: {
            ...((input.metadata as Record<string, unknown>) ?? {}),
            doubleEntryTxId: input.transactionId,
            counterpartyAccountId: creditAccount.id,
          },
          timestamp: txTime,
        },
      });

      const creditEntry = await tx.ledgerEntry.create({
        data: {
          tenantId: validTenantId,
          accountId: creditAccount.id,
          sequence: creditSeq,
          entryType: 'CREDIT',
          amount,
          purpose: input.purpose.trim(),
          referenceId: input.referenceId.trim(),
          metadata: {
            ...((input.metadata as Record<string, unknown>) ?? {}),
            doubleEntryTxId: input.transactionId,
            counterpartyAccountId: debitAccount.id,
          },
          timestamp: txTime,
        },
      });

      return {
        debitEntry: mapPrismaLedgerEntry(debitEntry),
        creditEntry: mapPrismaLedgerEntry(creditEntry),
      };
    });
  }

  /**
   * Lists ledger entries for an account or all accounts in the tenant.
   */
  async listEntries(tenantId: unknown, accountId?: string): Promise<LedgerEntry[]> {
    const validTenantId = assertValidTenantId(tenantId);
    const where: Prisma.LedgerEntryWhereInput = {
      tenantId: validTenantId,
    };
    if (accountId) {
      where.accountId = accountId.trim();
    }

    const rows = await this.prisma.ledgerEntry.findMany({
      where,
      orderBy: [{ timestamp: 'asc' }, { sequence: 'asc' }],
    });

    return rows.map(mapPrismaLedgerEntry);
  }

  /**
   * Purely calculates account balance algebraically from immutable records.
   */
  async getBalance(tenantId: unknown, accountId: string): Promise<AccountBalance> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!accountId || typeof accountId !== 'string') {
      throw new Error('accountId is required.');
    }

    const account = await this.findAccountById(validTenantId, accountId);
    if (!account) {
      throw new AccountNotFoundError(`Account '${accountId}' not found in tenant '${validTenantId}'.`);
    }

    const [entries, reservations] = await Promise.all([
      this.listEntries(validTenantId, account.id),
      this.listActiveReservations(validTenantId, account.id),
    ]);

    return LedgerCalculator.summarizeAccount({
      tenantId: validTenantId,
      accountId: account.id,
      entries,
      reservations,
      creditLimit: account.creditLimit,
    });
  }

  // ==================== Two-Phase Reservation Operations ====================

  /**
   * Phase 1: Reserve credit for a campaign or operation.
   * Atomically checks available balance and creates an ACTIVE reservation record.
   */
  async createReservation(tenantId: unknown, params: ReserveCreditParams): Promise<Reservation> {
    const validTenantId = assertValidTenantId(tenantId);
    if (params.tenantId && params.tenantId !== validTenantId) {
      throw new Error(`Params tenantId '${params.tenantId}' does not match context tenantId '${validTenantId}'.`);
    }

    const reservationId = params.reservationId?.trim();
    if (!reservationId) {
      throw new InvalidAmountError('reservationId must be a non-empty string.');
    }
    const amount = LedgerCalculator.validateAmount(params.amount);
    const accountId = params.accountId?.trim();
    if (!accountId) {
      throw new Error('accountId is required.');
    }

    return this.prisma.$transaction(async (tx) => {
      const account = await tx.account.findFirst({
        where: { id: accountId, tenantId: validTenantId },
      });
      if (!account) {
        throw new AccountNotFoundError(`Account '${accountId}' not found in tenant '${validTenantId}'.`);
      }

      // Check for existing reservation with same ID (Idempotency check)
      const existing = await tx.creditReservation.findFirst({
        where: { id: reservationId, tenantId: validTenantId },
      });

      if (existing) {
        if (
          existing.accountId === account.id &&
          existing.amount === amount &&
          existing.referenceId === params.referenceId.trim()
        ) {
          return mapPrismaReservation(existing);
        }
        throw new ReservationConflictError(
          `Reservation '${reservationId}' already exists with different parameters.`,
        );
      }

      // Fetch entries and active reservations for balance calculation
      const entries = await tx.ledgerEntry.findMany({
        where: { tenantId: validTenantId, accountId: account.id },
      });
      const activeRes = await tx.creditReservation.findMany({
        where: { tenantId: validTenantId, accountId: account.id, status: 'ACTIVE' },
      });

      const balance = LedgerCalculator.summarizeAccount({
        tenantId: validTenantId,
        accountId: account.id,
        entries: entries.map(mapPrismaLedgerEntry),
        reservations: activeRes.map(mapPrismaReservation),
        creditLimit: account.creditLimit,
      });

      if (balance.availableBalance < amount) {
        throw new InsufficientFundsError({
          tenantId: validTenantId,
          accountId: account.id,
          requested: amount,
          available: balance.availableBalance,
          creditLimit: balance.creditLimit,
        });
      }

      const created = await tx.creditReservation.create({
        data: {
          id: reservationId,
          tenantId: validTenantId,
          accountId: account.id,
          amount,
          settledAmount: 0n,
          releasedAmount: 0n,
          status: 'ACTIVE',
          purpose: params.purpose.trim(),
          referenceId: params.referenceId.trim(),
          metadata: (params.metadata as Prisma.InputJsonValue) ?? Prisma.JsonNull,
        },
      });

      return mapPrismaReservation(created);
    });
  }

  /**
   * Finds a reservation by ID within tenant scope.
   */
  async findReservationById(tenantId: unknown, reservationId: string): Promise<Reservation | null> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!reservationId || typeof reservationId !== 'string') {
      return null;
    }

    const found = await this.prisma.creditReservation.findFirst({
      where: {
        id: reservationId.trim(),
        tenantId: validTenantId,
      },
    });

    return found ? mapPrismaReservation(found) : null;
  }

  /**
   * Phase 2a: Settle (Commit) reservation portion into an immutable DEBIT entry.
   */
  async settleReservation(
    tenantId: unknown,
    params: SettleReservationParams,
  ): Promise<{ entry: LedgerEntry; reservation: Reservation; remainingReserved: bigint }> {
    const validTenantId = assertValidTenantId(tenantId);
    const reservationId = params.reservationId?.trim();
    if (!reservationId) {
      throw new Error('reservationId is required.');
    }
    const settleAmount = LedgerCalculator.validateAmount(params.settleAmount);

    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.creditReservation.findFirst({
        where: { id: reservationId, tenantId: validTenantId },
      });
      if (!reservation) {
        throw new ReservationNotFoundError(reservationId);
      }

      if (reservation.status !== 'ACTIVE') {
        throw new ReservationConflictError(
          `Reservation '${reservationId}' is in status '${reservation.status}' and cannot be settled.`,
        );
      }

      const uncommitted = reservation.amount - reservation.settledAmount - reservation.releasedAmount;
      if (settleAmount > uncommitted) {
        throw new InvalidAmountError(
          `Settle amount (${settleAmount}) exceeds remaining uncommitted reservation amount (${uncommitted}).`,
        );
      }

      // Next monotonic sequence for account
      const lastEntry = await tx.ledgerEntry.findFirst({
        where: { tenantId: validTenantId, accountId: reservation.accountId },
        orderBy: { sequence: 'desc' },
        select: { sequence: true },
      });
      const nextSequence = lastEntry ? lastEntry.sequence + 1n : 1n;

      const createdEntry = await tx.ledgerEntry.create({
        data: {
          tenantId: validTenantId,
          accountId: reservation.accountId,
          sequence: nextSequence,
          entryType: 'DEBIT',
          amount: settleAmount,
          purpose: params.purpose?.trim() ?? reservation.purpose,
          referenceId: params.referenceId?.trim() ?? reservation.referenceId,
          metadata: {
            ...((params.metadata as Record<string, unknown>) ?? {}),
            reservationId: reservation.id,
            phase: 'SETTLE',
          },
        },
      });

      const newSettledAmount = reservation.settledAmount + settleAmount;
      const remainingReserved = reservation.amount - newSettledAmount - reservation.releasedAmount;
      const newStatus = remainingReserved === 0n ? 'SETTLED' : 'ACTIVE';

      const updatedReservation = await tx.creditReservation.update({
        where: { id: reservation.id },
        data: {
          settledAmount: newSettledAmount,
          status: newStatus,
        },
      });

      return {
        entry: mapPrismaLedgerEntry(createdEntry),
        reservation: mapPrismaReservation(updatedReservation),
        remainingReserved,
      };
    });
  }

  /**
   * Phase 2b: Release unconsumed reserved credit back to available balance.
   */
  async releaseReservation(
    tenantId: unknown,
    params: ReleaseReservationParams,
  ): Promise<{ reservation: Reservation; releasedAmount: bigint }> {
    const validTenantId = assertValidTenantId(tenantId);
    const reservationId = params.reservationId?.trim();
    if (!reservationId) {
      throw new Error('reservationId is required.');
    }

    return this.prisma.$transaction(async (tx) => {
      const reservation = await tx.creditReservation.findFirst({
        where: { id: reservationId, tenantId: validTenantId },
      });
      if (!reservation) {
        throw new ReservationNotFoundError(reservationId);
      }

      if (reservation.status === 'RELEASED' || reservation.status === 'SETTLED') {
        return {
          reservation: mapPrismaReservation(reservation),
          releasedAmount: 0n,
        };
      }

      const remaining = reservation.amount - reservation.settledAmount - reservation.releasedAmount;
      const newReleasedAmount = reservation.releasedAmount + remaining;

      const updated = await tx.creditReservation.update({
        where: { id: reservation.id },
        data: {
          releasedAmount: newReleasedAmount,
          status: 'RELEASED',
          releaseReason: params.reason?.trim() ?? null,
        },
      });

      return {
        reservation: mapPrismaReservation(updated),
        releasedAmount: remaining,
      };
    });
  }

  /**
   * Lists active reservations for an account or across tenant.
   */
  async listActiveReservations(tenantId: unknown, accountId?: string): Promise<Reservation[]> {
    const validTenantId = assertValidTenantId(tenantId);
    const where: Prisma.CreditReservationWhereInput = {
      tenantId: validTenantId,
      status: 'ACTIVE',
    };
    if (accountId) {
      where.accountId = accountId.trim();
    }

    const rows = await this.prisma.creditReservation.findMany({
      where,
      orderBy: { createdAt: 'desc' },
    });

    return rows.map(mapPrismaReservation);
  }

  // ==================== Strict Tenant Cleanup (Never Global Wipe) ====================

  /**
   * Strictly cleans up billing records belonging exclusively to the specified tenant.
   */
  async clearTenant(tenantId: unknown): Promise<void> {
    const validTenantId = assertValidTenantId(tenantId);
    await this.prisma.$transaction([
      this.prisma.creditReservation.deleteMany({ where: { tenantId: validTenantId } }),
      this.prisma.ledgerEntry.deleteMany({ where: { tenantId: validTenantId } }),
      this.prisma.account.deleteMany({ where: { tenantId: validTenantId } }),
    ]);
  }
}