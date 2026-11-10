/**
 * Billing Ledger Calculator
 *
 * AC-02: Pure mathematical calculation of ledger balances.
 * Strictly zero editable balance fields; all balances are derived
 * algebraically from immutable ledger entries.
 * AC-04: Complete integer / BigInt precision, zero floating-point math leaks.
 */

import {
  LedgerEntry,
  Reservation,
  AccountBalance,
  InvalidAmountError,
  InvalidSequenceError,
} from './types';

export class LedgerCalculator {
  /**
   * Validates that an amount is a strictly positive BigInt integer.
   * Rejects non-integers, floats, negative values, and zero.
   */
  public static validateAmount(amount: unknown): bigint {
    if (typeof amount === 'bigint') {
      if (amount <= 0n) {
        throw new InvalidAmountError(`Amount must be strictly positive (> 0n), received: ${amount}`);
      }
      return amount;
    }

    if (typeof amount === 'number') {
      if (!Number.isInteger(amount) || !Number.isFinite(amount)) {
        throw new InvalidAmountError(
          `Floating-point numbers and NaN/Infinity are strictly prohibited for money amounts: ${amount}`,
        );
      }
      if (amount <= 0) {
        throw new InvalidAmountError(`Amount must be strictly positive (> 0), received: ${amount}`);
      }
      return BigInt(amount);
    }

    if (typeof amount === 'string') {
      const trimmed = amount.trim();
      if (!/^\d+$/.test(trimmed)) {
        throw new InvalidAmountError(
          `String amount must represent a positive integer without decimals, exponents, or signs: '${amount}'`,
        );
      }
      const parsed = BigInt(trimmed);
      if (parsed <= 0n) {
        throw new InvalidAmountError(`Amount must be strictly positive, received: '${amount}'`);
      }
      return parsed;
    }

    throw new InvalidAmountError(`Unsupported amount type: ${typeof amount}. Expected BigInt or integer string.`);
  }

  /**
   * Sums all entries matching the specified entryType.
   */
  public static sumByType(entries: readonly LedgerEntry[], type: 'CREDIT' | 'DEBIT'): bigint {
    let sum = 0n;
    for (const entry of entries) {
      if (entry.entryType === type) {
        sum += entry.amount;
      }
    }
    return sum;
  }

  /**
   * Computes the net balance from an array of immutable ledger entries.
   * Net Balance = Total Credits - Total Debits.
   */
  public static computeNetBalance(entries: readonly LedgerEntry[]): bigint {
    let balance = 0n;
    for (const entry of entries) {
      if (entry.entryType === 'CREDIT') {
        balance += entry.amount;
      } else if (entry.entryType === 'DEBIT') {
        balance -= entry.amount;
      }
    }
    return balance;
  }

  /**
   * Sums the active (unsettled & unreleased) reserved amount from reservations.
   */
  public static computeActiveReservedSum(reservations: readonly Reservation[]): bigint {
    let sum = 0n;
    for (const res of reservations) {
      if (res.status === 'ACTIVE') {
        const remaining = res.amount - res.settledAmount - res.releasedAmount;
        if (remaining > 0n) {
          sum += remaining;
        }
      }
    }
    return sum;
  }

  /**
   * Computes available balance:
   * availableBalance = netBalance + creditLimit - activeReservations
   * AC-03: Mathematical floor enforcement against allowed creditLimit.
   */
  public static computeAvailableBalance(params: {
    netBalance: bigint;
    creditLimit?: bigint;
    activeReservationsSum?: bigint;
  }): bigint {
    const limit = params.creditLimit ?? 0n;
    if (limit < 0n) {
      throw new InvalidAmountError(`Credit limit cannot be negative, received: ${limit}`);
    }
    const reserved = params.activeReservationsSum ?? 0n;
    if (reserved < 0n) {
      throw new InvalidAmountError(`Active reservations sum cannot be negative, received: ${reserved}`);
    }
    return params.netBalance + limit - reserved;
  }

  /**
   * Computes full account balance summary strictly from records.
   */
  public static summarizeAccount(params: {
    tenantId: string;
    accountId: string;
    entries: readonly LedgerEntry[];
    reservations?: readonly Reservation[];
    creditLimit?: bigint;
  }): AccountBalance {
    const relevantEntries = params.entries.filter(
      (e) => e.tenantId === params.tenantId && e.accountId === params.accountId,
    );
    const relevantReservations = (params.reservations ?? []).filter(
      (r) => r.tenantId === params.tenantId && r.accountId === params.accountId,
    );

    const creditSum = this.sumByType(relevantEntries, 'CREDIT');
    const debitSum = this.sumByType(relevantEntries, 'DEBIT');
    const netBalance = creditSum - debitSum;
    const activeReservationsSum = this.computeActiveReservedSum(relevantReservations);
    const creditLimit = params.creditLimit ?? 0n;
    const availableBalance = netBalance + creditLimit - activeReservationsSum;

    return {
      tenantId: params.tenantId,
      accountId: params.accountId,
      creditSum,
      debitSum,
      netBalance,
      activeReservationsSum,
      availableBalance,
      creditLimit,
    };
  }

  /**
   * Verifies double-entry balancing: total debits must exactly equal total credits.
   */
  public static isBalancedDoubleEntry(entries: readonly LedgerEntry[]): boolean {
    const credits = this.sumByType(entries, 'CREDIT');
    const debits = this.sumByType(entries, 'DEBIT');
    return credits === debits;
  }

  /**
   * Verifies that entries have a strictly monotonically increasing sequence (1, 2, 3...)
   * without duplicates or gaps.
   */
  public static verifySequenceIntegrity(entries: readonly LedgerEntry[]): void {
    if (entries.length === 0) {
      return;
    }

    let expected = 1n;
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.sequence !== expected) {
        throw new InvalidSequenceError(
          `Sequence violation at index ${i}: expected sequence ${expected}, but got ${entry.sequence}`,
        );
      }
      expected += 1n;
    }
  }
}
