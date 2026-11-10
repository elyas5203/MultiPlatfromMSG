import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  BillingLedgerEngine,
  LedgerCalculator,
  LedgerEntry,
  InvalidAmountError,
  InsufficientFundsError,
  ReservationNotFoundError,
  ReservationConflictError,
  DuplicateEntryError,
  InvalidSequenceError,
} from '../src/billing';

describe('Billing Ledger Math Engine (TASK-0021)', () => {
  describe('AC-01: LedgerEntry typing, validation and append-only sequence', () => {
    it('appends valid immutable ledger entries with sequential numbering per account', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_alpha';
      const accountId = 'wallet_main';

      const entry1 = engine.appendEntry({
        tenantId,
        accountId,
        entryType: 'CREDIT',
        amount: 50_000n,
        purpose: 'Top-up wallet via gateway',
        referenceId: 'tx_pay_001',
      });

      assert.equal(entry1.sequence, 1n);
      assert.equal(entry1.tenantId, tenantId);
      assert.equal(entry1.accountId, accountId);
      assert.equal(entry1.entryType, 'CREDIT');
      assert.equal(entry1.amount, 50_000n);
      assert.equal(entry1.purpose, 'Top-up wallet via gateway');
      assert.equal(entry1.referenceId, 'tx_pay_001');
      assert.ok(entry1.timestamp instanceof Date);
      assert.ok(Object.isFrozen(entry1));

      const entry2 = engine.appendEntry({
        tenantId,
        accountId,
        entryType: 'DEBIT',
        amount: 12_500n,
        purpose: 'SMS campaign fee',
        referenceId: 'camp_001',
      });

      assert.equal(entry2.sequence, 2n);
      assert.equal(entry2.entryType, 'DEBIT');
      assert.equal(entry2.amount, 12_500n);

      // Verify sequence is isolated per account
      const otherAccountEntry = engine.appendEntry({
        tenantId,
        accountId: 'wallet_secondary',
        entryType: 'CREDIT',
        amount: 10_000n,
        purpose: 'Bonus credit',
        referenceId: 'bonus_001',
      });

      assert.equal(otherAccountEntry.sequence, 1n);
    });

    it('rejects non-positive amounts, zero, and negative values', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_alpha';
      const accountId = 'wallet_main';

      assert.throws(
        () =>
          engine.appendEntry({
            tenantId,
            accountId,
            entryType: 'CREDIT',
            amount: 0n,
            purpose: 'Zero test',
            referenceId: 'ref_0',
          }),
        (err) => err instanceof InvalidAmountError,
      );

      assert.throws(
        () =>
          engine.appendEntry({
            tenantId,
            accountId,
            entryType: 'CREDIT',
            amount: -500n,
            purpose: 'Negative test',
            referenceId: 'ref_neg',
          }),
        (err) => err instanceof InvalidAmountError,
      );
    });

    it('rejects empty or whitespace-only required fields', () => {
      const engine = new BillingLedgerEngine();

      assert.throws(
        () =>
          engine.appendEntry({
            tenantId: '   ',
            accountId: 'acc1',
            entryType: 'CREDIT',
            amount: 100n,
            purpose: 'valid',
            referenceId: 'ref1',
          }),
        (err) => err instanceof InvalidAmountError,
      );

      assert.throws(
        () =>
          engine.appendEntry({
            tenantId: 'tenant1',
            accountId: '',
            entryType: 'CREDIT',
            amount: 100n,
            purpose: 'valid',
            referenceId: 'ref1',
          }),
        (err) => err instanceof InvalidAmountError,
      );

      assert.throws(
        () =>
          engine.appendEntry({
            tenantId: 'tenant1',
            accountId: 'acc1',
            entryType: 'CREDIT',
            amount: 100n,
            purpose: '   ',
            referenceId: 'ref1',
          }),
        (err) => err instanceof InvalidAmountError,
      );

      assert.throws(
        () =>
          engine.appendEntry({
            tenantId: 'tenant1',
            accountId: 'acc1',
            entryType: 'CREDIT',
            amount: 100n,
            purpose: 'valid',
            referenceId: ' ',
          }),
        (err) => err instanceof InvalidAmountError,
      );
    });

    it('rejects duplicate entry IDs', () => {
      const engine = new BillingLedgerEngine();
      engine.appendEntry({
        id: 'fixed_id_100',
        tenantId: 'tenant1',
        accountId: 'acc1',
        entryType: 'CREDIT',
        amount: 1000n,
        purpose: 'First entry',
        referenceId: 'ref1',
      });

      assert.throws(
        () =>
          engine.appendEntry({
            id: 'fixed_id_100',
            tenantId: 'tenant1',
            accountId: 'acc1',
            entryType: 'CREDIT',
            amount: 2000n,
            purpose: 'Duplicate id entry',
            referenceId: 'ref2',
          }),
        (err) => err instanceof DuplicateEntryError,
      );
    });

    it('validates sequence integrity and detects gaps or tampering', () => {
      const validEntries: LedgerEntry[] = [
        {
          id: '1',
          tenantId: 't1',
          accountId: 'a1',
          sequence: 1n,
          entryType: 'CREDIT',
          amount: 100n,
          purpose: 'p',
          referenceId: 'r',
          timestamp: new Date(),
        },
        {
          id: '2',
          tenantId: 't1',
          accountId: 'a1',
          sequence: 2n,
          entryType: 'DEBIT',
          amount: 50n,
          purpose: 'p',
          referenceId: 'r',
          timestamp: new Date(),
        },
      ];
      LedgerCalculator.verifySequenceIntegrity(validEntries);

      const gappedEntries: LedgerEntry[] = [
        validEntries[0],
        {
          id: '3',
          tenantId: 't1',
          accountId: 'a1',
          sequence: 3n, // Gap: sequence 2 is missing
          entryType: 'DEBIT',
          amount: 10n,
          purpose: 'p',
          referenceId: 'r',
          timestamp: new Date(),
        },
      ];
      assert.throws(
        () => LedgerCalculator.verifySequenceIntegrity(gappedEntries),
        (err) => err instanceof InvalidSequenceError,
      );
    });
  });

  describe('AC-02: LedgerCalculator algebraic balance calculation (zero mutable fields)', () => {
    it('computes net balance deterministically across hundreds of random transactions', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_stress';
      const accountId = 'wallet_test';

      let expectedNet = 0n;
      let expectedCreditSum = 0n;
      let expectedDebitSum = 0n;

      // Seed-based pseudo-random generator for reproducible test
      let seed = 42;
      const pseudoRandom = () => {
        seed = (seed * 9301 + 49297) % 233280;
        return seed / 233280;
      };

      for (let i = 0; i < 500; i++) {
        const isCredit = pseudoRandom() > 0.4;
        const amount = BigInt(Math.floor(pseudoRandom() * 100_000) + 1);

        if (isCredit) {
          expectedCreditSum += amount;
          expectedNet += amount;
          engine.appendEntry({
            tenantId,
            accountId,
            entryType: 'CREDIT',
            amount,
            purpose: `Random credit ${i}`,
            referenceId: `ref_c_${i}`,
          });
        } else {
          expectedDebitSum += amount;
          expectedNet -= amount;
          engine.appendEntry({
            tenantId,
            accountId,
            entryType: 'DEBIT',
            amount,
            purpose: `Random debit ${i}`,
            referenceId: `ref_d_${i}`,
          });
        }
      }

      const balance = engine.getBalance(tenantId, accountId);
      assert.equal(balance.creditSum, expectedCreditSum);
      assert.equal(balance.debitSum, expectedDebitSum);
      assert.equal(balance.netBalance, expectedNet);
      assert.equal(balance.availableBalance, expectedNet); // no reservations or credit limit

      // Check entries array immutability
      const entries = engine.getEntries(tenantId, accountId);
      assert.equal(entries.length, 500);
      assert.throws(() => {
        (entries as unknown as LedgerEntry[]).push({} as LedgerEntry);
      });
    });

    it('records balanced double-entry transactions and verifies equality', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_double_entry';
      const debitAccount = 'bank_holding';
      const creditAccount = 'customer_wallet';

      const tx = engine.recordDoubleEntryTransaction({
        transactionId: 'tx_topup_999',
        tenantId,
        debitAccountId: debitAccount,
        creditAccountId: creditAccount,
        amount: 250_000n,
        purpose: 'Direct bank top-up',
        referenceId: 'bank_ref_123',
      });

      assert.equal(tx.debitEntry.amount, 250_000n);
      assert.equal(tx.creditEntry.amount, 250_000n);
      assert.equal(tx.debitEntry.entryType, 'DEBIT');
      assert.equal(tx.creditEntry.entryType, 'CREDIT');

      const allEntries = engine.getEntries(tenantId);
      assert.equal(LedgerCalculator.isBalancedDoubleEntry(allEntries), true);
    });
  });

  describe('AC-03: Two-phase credit reservation workflow (Reserve, Settle, Release)', () => {
    it('executes full reservation, settle, and verify no credit leak', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_camp';
      const accountId = 'wallet_camp';

      // 1. Initial deposit of 100,000 Rials
      engine.appendEntry({
        tenantId,
        accountId,
        entryType: 'CREDIT',
        amount: 100_000n,
        purpose: 'Initial top-up',
        referenceId: 'dep_001',
      });

      const initialBalance = engine.getBalance(tenantId, accountId);
      assert.equal(initialBalance.netBalance, 100_000n);
      assert.equal(initialBalance.availableBalance, 100_000n);

      // 2. Reserve 40,000 Rials for Campaign #1
      const reservation = engine.reserve({
        reservationId: 'res_camp_01',
        tenantId,
        accountId,
        amount: 40_000n,
        purpose: 'Telegram bulk broadcast reservation',
        referenceId: 'camp_tg_101',
      });

      assert.equal(reservation.status, 'ACTIVE');
      assert.equal(reservation.amount, 40_000n);
      assert.equal(reservation.settledAmount, 0n);
      assert.equal(reservation.releasedAmount, 0n);

      // Net balance is still 100,000n (no premature debit!), but available balance is 60,000n
      const postReserveBalance = engine.getBalance(tenantId, accountId);
      assert.equal(postReserveBalance.netBalance, 100_000n);
      assert.equal(postReserveBalance.activeReservationsSum, 40_000n);
      assert.equal(postReserveBalance.availableBalance, 60_000n);

      // 3. Settle full 40,000 Rials
      const settleResult = engine.settle({
        reservationId: 'res_camp_01',
        settleAmount: 40_000n,
        purpose: 'Completed campaign dispatch',
      });

      assert.equal(settleResult.reservation.status, 'SETTLED');
      assert.equal(settleResult.reservation.settledAmount, 40_000n);
      assert.equal(settleResult.remainingReserved, 0n);
      assert.equal(settleResult.entry.entryType, 'DEBIT');
      assert.equal(settleResult.entry.amount, 40_000n);

      // Post-settle balance: net balance is 60,000n, available is 60,000n
      const postSettleBalance = engine.getBalance(tenantId, accountId);
      assert.equal(postSettleBalance.netBalance, 60_000n);
      assert.equal(postSettleBalance.activeReservationsSum, 0n);
      assert.equal(postSettleBalance.availableBalance, 60_000n);
    });

    it('executes partial settle and releases remaining unconsumed funds immediately', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_partial';
      const accountId = 'wallet_partial';

      // Deposit 100,000
      engine.appendEntry({
        tenantId,
        accountId,
        entryType: 'CREDIT',
        amount: 100_000n,
        purpose: 'Deposit',
        referenceId: 'dep_p',
      });

      // Reserve 50,000 for estimated 1,000 messages
      engine.reserve({
        reservationId: 'res_partial_1',
        tenantId,
        accountId,
        amount: 50_000n,
        purpose: 'Campaign reserve',
        referenceId: 'camp_p',
      });

      // Settle 30,000 (only 600 messages actually sent successfully)
      const settleResult = engine.settle({
        reservationId: 'res_partial_1',
        settleAmount: 30_000n,
      });

      assert.equal(settleResult.reservation.status, 'ACTIVE');
      assert.equal(settleResult.reservation.settledAmount, 30_000n);
      assert.equal(settleResult.remainingReserved, 20_000n);

      // Mid-campaign balance: Net = 70,000, ActiveReserved = 20,000, Available = 50,000
      const midBalance = engine.getBalance(tenantId, accountId);
      assert.equal(midBalance.netBalance, 70_000n);
      assert.equal(midBalance.activeReservationsSum, 20_000n);
      assert.equal(midBalance.availableBalance, 50_000n);

      // Release unconsumed remainder (20,000)
      const releaseResult = engine.release({
        reservationId: 'res_partial_1',
        reason: 'Campaign stopped by user; 400 contacts remaining uncontacted',
      });

      assert.equal(releaseResult.releasedAmount, 20_000n);
      assert.equal(releaseResult.reservation.status, 'RELEASED');
      assert.equal(releaseResult.reservation.releasedAmount, 20_000n);

      // Mathematical conservation invariant: settled + released == original amount
      assert.equal(
        releaseResult.reservation.settledAmount + releaseResult.reservation.releasedAmount,
        releaseResult.reservation.amount,
      );

      // Final balance: exactly 70,000 net, zero reserved, exactly 70,000 available
      const finalBalance = engine.getBalance(tenantId, accountId);
      assert.equal(finalBalance.netBalance, 70_000n);
      assert.equal(finalBalance.activeReservationsSum, 0n);
      assert.equal(finalBalance.availableBalance, 70_000n);
    });

    it('rejects reservation when available balance is insufficient (overdraft prevention)', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_broke';
      const accountId = 'wallet_broke';

      engine.appendEntry({
        tenantId,
        accountId,
        entryType: 'CREDIT',
        amount: 10_000n,
        purpose: 'Small balance',
        referenceId: 'dep_small',
      });

      // Attempting to reserve 10,001n
      assert.throws(
        () =>
          engine.reserve({
            reservationId: 'res_fail_1',
            tenantId,
            accountId,
            amount: 10_001n,
            purpose: 'Too expensive',
            referenceId: 'camp_x',
          }),
        (err) => {
          assert.ok(err instanceof InsufficientFundsError);
          assert.equal(err.requested, 10_001n);
          assert.equal(err.available, 10_000n);
          assert.equal(err.creditLimit, 0n);
          return true;
        },
      );
    });

    it('supports authorized credit limits (postpaid ceiling) with strict boundary enforcement', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_postpaid';
      const accountId = 'wallet_postpaid';

      // 0 initial balance, but SuperAdmin grants 500,000 Rials credit limit
      engine.setCreditLimit(tenantId, accountId, 500_000n, 'Approved corporate postpaid contract');
      assert.equal(engine.getCreditLimit(tenantId, accountId), 500_000n);

      const bal0 = engine.getBalance(tenantId, accountId);
      assert.equal(bal0.netBalance, 0n);
      assert.equal(bal0.availableBalance, 500_000n);

      // Can reserve within credit limit
      engine.reserve({
        reservationId: 'res_postpaid_1',
        tenantId,
        accountId,
        amount: 400_000n,
        purpose: 'Postpaid campaign reserve',
        referenceId: 'camp_postpaid',
      });

      const bal1 = engine.getBalance(tenantId, accountId);
      assert.equal(bal1.availableBalance, 100_000n);

      // Settle full 400,000n -> netBalance drops to -400,000n
      engine.settle({
        reservationId: 'res_postpaid_1',
        settleAmount: 400_000n,
      });

      const bal2 = engine.getBalance(tenantId, accountId);
      assert.equal(bal2.netBalance, -400_000n);
      assert.equal(bal2.availableBalance, 100_000n);

      // Attempting to reserve 100,001n exceeds allowed credit limit
      assert.throws(
        () =>
          engine.reserve({
            reservationId: 'res_postpaid_2',
            tenantId,
            accountId,
            amount: 100_001n,
            purpose: 'Exceeding limit',
            referenceId: 'camp_over',
          }),
        (err) => err instanceof InsufficientFundsError,
      );
    });

    it('rejects settle amount exceeding uncommitted reservation amount', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_overflow';
      const accountId = 'wallet_1';

      engine.appendEntry({
        tenantId,
        accountId,
        entryType: 'CREDIT',
        amount: 100_000n,
        purpose: 'Dep',
        referenceId: 'r',
      });

      engine.reserve({
        reservationId: 'res_limit',
        tenantId,
        accountId,
        amount: 20_000n,
        purpose: 'Reserve 20k',
        referenceId: 'ref_lim',
      });

      assert.throws(
        () =>
          engine.settle({
            reservationId: 'res_limit',
            settleAmount: 20_001n,
          }),
        (err) => err instanceof InvalidAmountError,
      );
    });

    it('handles idempotent reservation and release calls safely', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_idempotency';
      const accountId = 'wallet_idem';

      engine.appendEntry({
        tenantId,
        accountId,
        entryType: 'CREDIT',
        amount: 50_000n,
        purpose: 'Dep',
        referenceId: 'r',
      });

      const res1 = engine.reserve({
        reservationId: 'res_idem',
        tenantId,
        accountId,
        amount: 15_000n,
        purpose: 'Test idem',
        referenceId: 'ref_same',
      });

      // Repeated call with same parameters returns existing reservation
      const res2 = engine.reserve({
        reservationId: 'res_idem',
        tenantId,
        accountId,
        amount: 15_000n,
        purpose: 'Test idem',
        referenceId: 'ref_same',
      });
      assert.equal(res1, res2);

      // Conflicting parameters with same reservationId throws conflict error
      assert.throws(
        () =>
          engine.reserve({
            reservationId: 'res_idem',
            tenantId,
            accountId,
            amount: 20_000n,
            purpose: 'Conflict',
            referenceId: 'ref_conflict',
          }),
        (err) => err instanceof ReservationConflictError,
      );

      // Release twice is safe and idempotent
      const rel1 = engine.release({ reservationId: 'res_idem', reason: 'Done' });
      assert.equal(rel1.releasedAmount, 15_000n);

      const rel2 = engine.release({ reservationId: 'res_idem' });
      assert.equal(rel2.releasedAmount, 0n);
    });

    it('guarantees tenant isolation for balance and reservations', () => {
      const engine = new BillingLedgerEngine();
      const tenantA = 'org_alpha';
      const tenantB = 'org_beta';
      const accountId = 'wallet_main';

      engine.appendEntry({
        tenantId: tenantA,
        accountId,
        entryType: 'CREDIT',
        amount: 100_000n,
        purpose: 'Tenant A deposit',
        referenceId: 'dep_a',
      });

      // Tenant B has 0 balance
      const balB = engine.getBalance(tenantB, accountId);
      assert.equal(balB.netBalance, 0n);
      assert.equal(balB.availableBalance, 0n);

      // Tenant B cannot reserve funds using Tenant A's balance
      assert.throws(
        () =>
          engine.reserve({
            reservationId: 'res_b',
            tenantId: tenantB,
            accountId,
            amount: 10_000n,
            purpose: 'Illegal spend',
            referenceId: 'ref_b',
          }),
        (err) => err instanceof InsufficientFundsError,
      );
    });

    it('records SuperAdmin manual adjustments with audit metadata', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_adj';
      const accountId = 'wallet_adj';

      const entry = engine.adjustCredit({
        tenantId,
        accountId,
        amount: 75_000n,
        entryType: 'CREDIT',
        reason: 'Compensation for channel outage incident INC-492',
        adminId: 'admin_super_01',
        referenceId: 'ticket_inc_492',
      });

      assert.equal(entry.amount, 75_000n);
      assert.equal(entry.metadata?.adminId, 'admin_super_01');
      assert.equal(entry.metadata?.adjustmentReason, 'Compensation for channel outage incident INC-492');

      const bal = engine.getBalance(tenantId, accountId);
      assert.equal(bal.netBalance, 75_000n);
    });
  });

  describe('AC-04: Integer/BigInt precision and zero floating-point leaks', () => {
    it('handles astronomical BigInt values without precision degradation or overflow', () => {
      const engine = new BillingLedgerEngine();
      const tenantId = 'tenant_astronomical';
      const accountId = 'wallet_rial';

      // 100 quadrillion Rials (exceeds Number.MAX_SAFE_INTEGER: 9_007_199_254_740_991)
      const hugeCredit = 100_000_000_000_000_000_000n;
      const hugeDebit = 1n;

      engine.appendEntry({
        tenantId,
        accountId,
        entryType: 'CREDIT',
        amount: hugeCredit,
        purpose: 'Huge deposit',
        referenceId: 'huge_dep',
      });

      engine.appendEntry({
        tenantId,
        accountId,
        entryType: 'DEBIT',
        amount: hugeDebit,
        purpose: 'Single rial deduction',
        referenceId: 'huge_deb',
      });

      const balance = engine.getBalance(tenantId, accountId);
      const expectedDiff = 99_999_999_999_999_999_999n;
      assert.equal(balance.netBalance, expectedDiff);
    });

    it('strictly rejects floating-point numbers, decimals, NaN and Infinity', () => {
      const invalidAmounts = [
        12.34,
        0.1 + 0.2,
        NaN,
        Infinity,
        -Infinity,
        '100.50',
        '1e6',
        '0x10',
        null,
        undefined,
        {},
      ];

      for (const invalid of invalidAmounts) {
        assert.throws(
          () => LedgerCalculator.validateAmount(invalid),
          (err) => err instanceof InvalidAmountError,
          `Expected ${String(invalid)} to be rejected by validateAmount`,
        );
      }
    });
  });
});
