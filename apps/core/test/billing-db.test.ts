import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TenantRepository } from '../src/tenant/tenant.repository';
import {
  BillingRepository,
  AccountNotFoundError,
} from '../src/billing/billing.repository';
import { LedgerCalculator } from '../src/billing/calculator';
import {
  InvalidAmountError,
  InsufficientFundsError,
  ReservationNotFoundError,
  ReservationConflictError,
} from '../src/billing/types';
import {
  TenantScopeMissingError,
  TenantScopeInvalidError,
} from '../src/tenant/tenant-scope';

export const TEST_MARKER_TABLE = '__multiplatformmsg_test_marker__';
export const TEST_MARKER_KEY = 'TEST_ENVIRONMENT_PERMITTED';

export class InsecureDatabaseTargetError extends Error {
  constructor(message = 'Refusing to run tests: Target database is not verified as a dedicated test database.') {
    super(message);
    this.name = 'InsecureDatabaseTargetError';
  }
}

export function validateDatabaseUrlSafety(dbUrl: string | undefined): void {
  if (!dbUrl || typeof dbUrl !== 'string' || dbUrl.trim().length === 0) {
    throw new InsecureDatabaseTargetError('DATABASE_URL environment variable is missing.');
  }

  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new InsecureDatabaseTargetError('DATABASE_URL is malformed or invalid.');
  }

  const dbName = parsed.pathname.replace(/^\//, '').trim();

  const isDedicatedTestDb =
    dbName === 'multiplatformmsg_test' ||
    dbName.endsWith('_test') ||
    dbName.includes('test_') ||
    dbName.includes('synthetic');

  if (!isDedicatedTestDb) {
    throw new InsecureDatabaseTargetError(
      'Target database is not an authorized test database. Target must match dedicated test database pattern.',
    );
  }
}

export async function assertPreProvisionedTestDatabaseMarker(prisma: PrismaService): Promise<void> {
  const expectedToken = process.env.TEST_DATABASE_MARKER_TOKEN;
  if (!expectedToken || typeof expectedToken !== 'string' || expectedToken.trim().length === 0) {
    throw new InsecureDatabaseTargetError(
      'TEST_DATABASE_MARKER_TOKEN environment variable is missing or empty. Fail-closed safety guard active.',
    );
  }

  const trimmedExpectedToken = expectedToken.trim();

  let rows: { marker_key: string; marker_token: string }[] = [];
  try {
    rows = (await prisma.$queryRawUnsafe(
      `SELECT "marker_key", "marker_token" FROM "${TEST_MARKER_TABLE}" WHERE "marker_key" = $1 LIMIT 1`,
      TEST_MARKER_KEY,
    )) as { marker_key: string; marker_token: string }[];
  } catch {
    throw new InsecureDatabaseTargetError(
      'Target database missing pre-provisioned test marker table. Test target is unverified.',
    );
  }

  if (!rows || rows.length === 0) {
    throw new InsecureDatabaseTargetError(
      'Target database missing required pre-provisioned test marker record. Refusing execution.',
    );
  }

  if (rows[0].marker_token !== trimmedExpectedToken) {
    throw new InsecureDatabaseTargetError(
      'Target database test marker token mismatch. Refusing execution.',
    );
  }
}

describe('PostgreSQL Billing Ledger & Double-Entry Integration Tests (TASK-0024)', () => {
  let app: any;
  let tenantRepo: TenantRepository;
  let prisma: PrismaService;
  let billingRepo: BillingRepository;
  let isTargetVerified = false;

  const RUN_SEED = crypto.randomBytes(4).toString('hex');
  const TENANT_ALPHA = `org_bil_alpha_${RUN_SEED}`;
  const TENANT_BETA = `org_bil_beta_${RUN_SEED}`;
  const SLUG_ALPHA = `slug-bil-alpha-${RUN_SEED}`;
  const SLUG_BETA = `slug-bil-beta-${RUN_SEED}`;

  before(async () => {
    isTargetVerified = false;

    // 1. Fail-closed target validation
    validateDatabaseUrlSafety(process.env.DATABASE_URL);

    // 2. Initialize Nest Application Context
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    tenantRepo = app.get(TenantRepository);
    prisma = app.get(PrismaService);
    billingRepo = new BillingRepository(prisma);

    // 3. Confirm connectivity
    let connected = false;
    for (let i = 0; i < 30; i++) {
      try {
        await prisma.$queryRawUnsafe('SELECT 1');
        connected = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 200));
      }
    }
    if (!connected) {
      throw new InsecureDatabaseTargetError('Unable to connect to target test database.');
    }

    // 4. Verify test database safety marker
    await assertPreProvisionedTestDatabaseMarker(prisma);
    isTargetVerified = true;

    // 5. Seed synthetic tenants
    await tenantRepo.createTenant({ id: TENANT_ALPHA, name: 'Billing Tenant Alpha', slug: SLUG_ALPHA });
    await tenantRepo.createTenant({ id: TENANT_BETA, name: 'Billing Tenant Beta', slug: SLUG_BETA });
  });

  after(async () => {
    if (isTargetVerified && prisma) {
      try {
        await billingRepo.clearTenant(TENANT_ALPHA);
        await billingRepo.clearTenant(TENANT_BETA);
        await prisma.tenant.deleteMany({
          where: { id: { in: [TENANT_ALPHA, TENANT_BETA] } },
        });
      } catch {
        // Best-effort cleanup
      }
    }
    if (app) {
      await app.close();
    }
  });

  // =========================================================================
  // AC-01 & AC-02: Account Lifecycle & Tenant Scoping
  // =========================================================================
  describe('1. Account Lifecycle & Scoping', () => {
    it('creates an account with default settings (CUSTOMER, IRR, 0 credit limit)', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, {
        name: 'Main Customer Wallet',
      });

      assert.equal(account.tenantId, TENANT_ALPHA);
      assert.equal(account.name, 'Main Customer Wallet');
      assert.equal(account.type, 'CUSTOMER');
      assert.equal(account.currency, 'IRR');
      assert.equal(account.creditLimit, 0n);
      assert.equal(account.status, 'ACTIVE');
      assert.ok(account.id);
    });

    it('creates an account with custom parameters', async () => {
      const customId = `acc_custom_${RUN_SEED}`;
      const account = await billingRepo.createAccount(TENANT_ALPHA, {
        id: customId,
        name: 'Escrow Reserve',
        type: 'ESCROW',
        currency: 'IRR',
        creditLimit: 50000000n,
      });

      assert.equal(account.id, customId);
      assert.equal(account.type, 'ESCROW');
      assert.equal(account.creditLimit, 50000000n);
    });

    it('rejects account creation with empty or whitespace name', async () => {
      await assert.rejects(
        billingRepo.createAccount(TENANT_ALPHA, { name: '   ' }),
        /Account name is required/i,
      );
    });

    it('rejects account creation with negative creditLimit', async () => {
      await assert.rejects(
        billingRepo.createAccount(TENANT_ALPHA, { name: 'Bad Limit', creditLimit: -100n }),
        InvalidAmountError,
      );
    });

    it('enforces assertValidTenantId on account creation', async () => {
      await assert.rejects(
        billingRepo.createAccount('', { name: 'No Tenant' }),
        TenantScopeMissingError,
      );
      await assert.rejects(
        billingRepo.createAccount('   ', { name: 'Blank Tenant' }),
        TenantScopeMissingError,
      );
      await assert.rejects(
        billingRepo.createAccount(null, { name: 'Null Tenant' }),
        TenantScopeMissingError,
      );
    });

    it('findAccountById retrieves account strictly within tenant scope', async () => {
      const created = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Searchable' });

      const foundAlpha = await billingRepo.findAccountById(TENANT_ALPHA, created.id);
      assert.ok(foundAlpha);
      assert.equal(foundAlpha.id, created.id);

      // Attempting to find Tenant Alpha account from Tenant Beta returns null
      const foundBeta = await billingRepo.findAccountById(TENANT_BETA, created.id);
      assert.equal(foundBeta, null);
    });

    it('listAccounts isolates accounts strictly by tenant', async () => {
      await billingRepo.createAccount(TENANT_BETA, { name: 'Beta Only Account' });

      const alphaList = await billingRepo.listAccounts(TENANT_ALPHA);
      const betaList = await billingRepo.listAccounts(TENANT_BETA);

      assert.ok(alphaList.length >= 2);
      assert.ok(betaList.length >= 1);
      assert.ok(alphaList.every((a) => a.tenantId === TENANT_ALPHA));
      assert.ok(betaList.every((b) => b.tenantId === TENANT_BETA));
    });

    it('setCreditLimit modifies credit limit within tenant scope', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Overdraft Account' });
      assert.equal(account.creditLimit, 0n);

      const updated = await billingRepo.setCreditLimit(TENANT_ALPHA, account.id, 25000000n);
      assert.equal(updated.creditLimit, 25000000n);

      // Rejects negative limit
      await assert.rejects(
        billingRepo.setCreditLimit(TENANT_ALPHA, account.id, -1000n),
        InvalidAmountError,
      );

      // Rejects cross-tenant update
      await assert.rejects(
        billingRepo.setCreditLimit(TENANT_BETA, account.id, 999999n),
        AccountNotFoundError,
      );
    });
  });

  // =========================================================================
  // AC-02: Append-Only Ledger Operations & Monotonic Sequencing
  // =========================================================================
  describe('2. Append-Only Ledger Operations & Sequencing', () => {
    it('appends ledger entries with automatic monotonic sequences (1n, 2n, 3n...)', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Sequence Test Account' });

      const e1 = await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        entryType: 'CREDIT',
        amount: 1000000n,
        purpose: 'INITIAL_DEPOSIT',
        referenceId: `ref_dep_1_${RUN_SEED}`,
      });
      assert.equal(e1.sequence, 1n);
      assert.equal(e1.entryType, 'CREDIT');
      assert.equal(e1.amount, 1000000n);

      const e2 = await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        entryType: 'DEBIT',
        amount: 300000n,
        purpose: 'FEE_DEDUCTION',
        referenceId: `ref_fee_1_${RUN_SEED}`,
      });
      assert.equal(e2.sequence, 2n);
      assert.equal(e2.entryType, 'DEBIT');
      assert.equal(e2.amount, 300000n);

      const e3 = await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        entryType: 'CREDIT',
        amount: 500000n,
        purpose: 'TOPUP',
        referenceId: `ref_top_1_${RUN_SEED}`,
      });
      assert.equal(e3.sequence, 3n);
    });

    it('rejects entries with non-positive amounts', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Validation Account' });

      await assert.rejects(
        billingRepo.appendEntry(TENANT_ALPHA, {
          tenantId: TENANT_ALPHA,
          accountId: account.id,
          entryType: 'CREDIT',
          amount: 0n,
          purpose: 'ZERO',
          referenceId: 'ref_zero',
        }),
        InvalidAmountError,
      );

      await assert.rejects(
        billingRepo.appendEntry(TENANT_ALPHA, {
          tenantId: TENANT_ALPHA,
          accountId: account.id,
          entryType: 'CREDIT',
          amount: -500n,
          purpose: 'NEGATIVE',
          referenceId: 'ref_neg',
        }),
        InvalidAmountError,
      );
    });

    it('rejects appending to non-existent account or account of another tenant', async () => {
      const betaAcc = await billingRepo.createAccount(TENANT_BETA, { name: 'Beta Account' });

      await assert.rejects(
        billingRepo.appendEntry(TENANT_ALPHA, {
          tenantId: TENANT_ALPHA,
          accountId: 'non_existent_account_id',
          entryType: 'CREDIT',
          amount: 1000n,
          purpose: 'TEST',
          referenceId: 'ref_1',
        }),
        AccountNotFoundError,
      );

      // Attempting to append from Alpha to Beta account
      await assert.rejects(
        billingRepo.appendEntry(TENANT_ALPHA, {
          tenantId: TENANT_ALPHA,
          accountId: betaAcc.id,
          entryType: 'CREDIT',
          amount: 1000n,
          purpose: 'CROSS_ATTEMPT',
          referenceId: 'ref_2',
        }),
        AccountNotFoundError,
      );
    });

    it('enforces composite unique constraint (tenant_id, account_id, sequence) at DB level', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Unique Seq Account' });

      await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        entryType: 'CREDIT',
        amount: 1000n,
        purpose: 'SEQ1',
        referenceId: 'ref_seq_1',
      });

      // Raw attempt to insert duplicate sequence = 1n for this account
      await assert.rejects(
        prisma.ledgerEntry.create({
          data: {
            tenantId: TENANT_ALPHA,
            accountId: account.id,
            sequence: 1n,
            entryType: 'DEBIT',
            amount: 500n,
            purpose: 'DUPLICATE_SEQ',
            referenceId: 'ref_dup_seq',
          },
        }),
        (err: any) => {
          assert.equal(err.code, 'P2002');
          return true;
        },
      );
    });
  });

  // =========================================================================
  // AC-02: Double-Entry Transactions & Atomicity
  // =========================================================================
  describe('3. Atomic Double-Entry Transactions', () => {
    it('executes balanced double-entry transaction atomically', async () => {
      const payer = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Payer Account' });
      const payee = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Payee Account' });

      // Fund payer
      await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: payer.id,
        entryType: 'CREDIT',
        amount: 2000000n,
        purpose: 'SEED',
        referenceId: `ref_seed_${RUN_SEED}`,
      });

      const txResult = await billingRepo.executeDoubleEntry(TENANT_ALPHA, {
        transactionId: `tx_de_${RUN_SEED}`,
        tenantId: TENANT_ALPHA,
        debitAccountId: payer.id,
        creditAccountId: payee.id,
        amount: 750000n,
        purpose: 'INTERNAL_TRANSFER',
        referenceId: `ref_tx_de_${RUN_SEED}`,
      });

      assert.equal(txResult.debitEntry.accountId, payer.id);
      assert.equal(txResult.debitEntry.entryType, 'DEBIT');
      assert.equal(txResult.debitEntry.amount, 750000n);

      assert.equal(txResult.creditEntry.accountId, payee.id);
      assert.equal(txResult.creditEntry.entryType, 'CREDIT');
      assert.equal(txResult.creditEntry.amount, 750000n);

      // Verify balances
      const payerBal = await billingRepo.getBalance(TENANT_ALPHA, payer.id);
      const payeeBal = await billingRepo.getBalance(TENANT_ALPHA, payee.id);

      assert.equal(payerBal.netBalance, 1250000n); // 2000000 - 750000
      assert.equal(payeeBal.netBalance, 750000n);
    });

    it('rejects double-entry transaction where debit and credit accounts are identical', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Self Transfer' });

      await assert.rejects(
        billingRepo.executeDoubleEntry(TENANT_ALPHA, {
          transactionId: 'tx_self',
          tenantId: TENANT_ALPHA,
          debitAccountId: account.id,
          creditAccountId: account.id,
          amount: 1000n,
          purpose: 'SELF',
          referenceId: 'ref_self',
        }),
        /must be different accounts/i,
      );
    });

    it('rejects cross-tenant double-entry transaction', async () => {
      const alphaAcc = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Alpha Account' });
      const betaAcc = await billingRepo.createAccount(TENANT_BETA, { name: 'Beta Account' });

      await assert.rejects(
        billingRepo.executeDoubleEntry(TENANT_ALPHA, {
          transactionId: 'tx_cross',
          tenantId: TENANT_ALPHA,
          debitAccountId: alphaAcc.id,
          creditAccountId: betaAcc.id,
          amount: 1000n,
          purpose: 'CROSS',
          referenceId: 'ref_cross',
        }),
        AccountNotFoundError,
      );
    });
  });

  // =========================================================================
  // AC-02: Two-Phase Credit Reservations
  // =========================================================================
  describe('4. Two-Phase Credit Reservations (Reserve, Settle, Release)', () => {
    it('creates reservation, reduces availableBalance, then settles partially and fully', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Campaign Wallet' });

      // Deposit 1,000,000
      await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        entryType: 'CREDIT',
        amount: 1000000n,
        purpose: 'DEPOSIT',
        referenceId: `ref_dep_${RUN_SEED}`,
      });

      // 1. Phase 1: Reserve 400,000
      const resId = `res_camp_${RUN_SEED}`;
      const reservation = await billingRepo.createReservation(TENANT_ALPHA, {
        reservationId: resId,
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        amount: 400000n,
        purpose: 'CAMPAIGN_BATCH_1',
        referenceId: `camp_ref_1_${RUN_SEED}`,
      });

      assert.equal(reservation.id, resId);
      assert.equal(reservation.status, 'ACTIVE');
      assert.equal(reservation.amount, 400000n);
      assert.equal(reservation.settledAmount, 0n);
      assert.equal(reservation.releasedAmount, 0n);

      // Check balance: netBalance remains 1,000,000; activeReservationsSum is 400,000; availableBalance is 600,000
      let bal = await billingRepo.getBalance(TENANT_ALPHA, account.id);
      assert.equal(bal.netBalance, 1000000n);
      assert.equal(bal.activeReservationsSum, 400000n);
      assert.equal(bal.availableBalance, 600000n);

      // 2. Phase 2a: Settle partial 250,000
      const settle1 = await billingRepo.settleReservation(TENANT_ALPHA, {
        reservationId: resId,
        settleAmount: 250000n,
        purpose: 'MSG_DELIVERED_BATCH_1',
        referenceId: `deliv_1_${RUN_SEED}`,
      });

      assert.equal(settle1.entry.entryType, 'DEBIT');
      assert.equal(settle1.entry.amount, 250000n);
      assert.equal(settle1.reservation.settledAmount, 250000n);
      assert.equal(settle1.reservation.status, 'ACTIVE');
      assert.equal(settle1.remainingReserved, 150000n);

      // Check balance: netBalance is 750,000; activeReservationsSum is 150,000; availableBalance is 600,000
      bal = await billingRepo.getBalance(TENANT_ALPHA, account.id);
      assert.equal(bal.netBalance, 750000n);
      assert.equal(bal.activeReservationsSum, 150000n);
      assert.equal(bal.availableBalance, 600000n);

      // 3. Phase 2a: Settle remaining 150,000 -> status transitions to SETTLED
      const settle2 = await billingRepo.settleReservation(TENANT_ALPHA, {
        reservationId: resId,
        settleAmount: 150000n,
        purpose: 'MSG_DELIVERED_BATCH_2',
        referenceId: `deliv_2_${RUN_SEED}`,
      });

      assert.equal(settle2.reservation.settledAmount, 400000n);
      assert.equal(settle2.reservation.status, 'SETTLED');
      assert.equal(settle2.remainingReserved, 0n);

      bal = await billingRepo.getBalance(TENANT_ALPHA, account.id);
      assert.equal(bal.netBalance, 600000n);
      assert.equal(bal.activeReservationsSum, 0n);
      assert.equal(bal.availableBalance, 600000n);
    });

    it('releases unused reservation credit back to availableBalance', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Release Wallet' });

      // Deposit 500,000
      await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        entryType: 'CREDIT',
        amount: 500000n,
        purpose: 'DEPOSIT',
        referenceId: `ref_dep_rel_${RUN_SEED}`,
      });

      // Reserve 300,000
      const resId = `res_rel_${RUN_SEED}`;
      await billingRepo.createReservation(TENANT_ALPHA, {
        reservationId: resId,
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        amount: 300000n,
        purpose: 'PARTIAL_FAIL_CAMPAIGN',
        referenceId: `ref_rel_camp_${RUN_SEED}`,
      });

      // Settle 100,000
      await billingRepo.settleReservation(TENANT_ALPHA, {
        reservationId: resId,
        settleAmount: 100000n,
      });

      // Release remaining 200,000
      const relResult = await billingRepo.releaseReservation(TENANT_ALPHA, {
        reservationId: resId,
        reason: 'CAMPAIGN_STOPPED_BY_USER',
      });

      assert.equal(relResult.releasedAmount, 200000n);
      assert.equal(relResult.reservation.status, 'RELEASED');
      assert.equal(relResult.reservation.releasedAmount, 200000n);

      // Verify balance: netBalance = 400,000, activeReservationsSum = 0n, availableBalance = 400,000
      const bal = await billingRepo.getBalance(TENANT_ALPHA, account.id);
      assert.equal(bal.netBalance, 400000n);
      assert.equal(bal.activeReservationsSum, 0n);
      assert.equal(bal.availableBalance, 400000n);

      // Releasing already RELEASED reservation is idempotent and returns 0n
      const idempotentRel = await billingRepo.releaseReservation(TENANT_ALPHA, {
        reservationId: resId,
      });
      assert.equal(idempotentRel.releasedAmount, 0n);
    });

    it('rejects reservation when requested amount exceeds availableBalance + creditLimit', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, {
        name: 'Broke Wallet',
        creditLimit: 50000n,
      });

      // Available balance is 50,000n (due to overdraft credit limit)
      // Attempting to reserve 60,000n throws InsufficientFundsError
      await assert.rejects(
        billingRepo.createReservation(TENANT_ALPHA, {
          reservationId: `res_broke_${RUN_SEED}`,
          tenantId: TENANT_ALPHA,
          accountId: account.id,
          amount: 60000n,
          purpose: 'OVERDRAFT_FAIL',
          referenceId: 'ref_fail',
        }),
        InsufficientFundsError,
      );

      // Reserving 40,000n succeeds within creditLimit
      const successRes = await billingRepo.createReservation(TENANT_ALPHA, {
        reservationId: `res_broke_${RUN_SEED}`,
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        amount: 40000n,
        purpose: 'OVERDRAFT_SUCCESS',
        referenceId: 'ref_pass',
      });
      assert.equal(successRes.status, 'ACTIVE');
    });

    it('supports idempotent reservation recreation with identical parameters', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Idempotency Account' });
      await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        entryType: 'CREDIT',
        amount: 100000n,
        purpose: 'TOPUP',
        referenceId: 'ref_top',
      });

      const resId = `res_idem_${RUN_SEED}`;
      const params = {
        reservationId: resId,
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        amount: 50000n,
        purpose: 'IDEMPOTENT_RES',
        referenceId: 'ref_idem_1',
      };

      const res1 = await billingRepo.createReservation(TENANT_ALPHA, params);
      const res2 = await billingRepo.createReservation(TENANT_ALPHA, params);

      assert.equal(res1.id, res2.id);
      assert.equal(res1.amount, res2.amount);

      // Attempting to create with same reservationId but different amount throws conflict
      await assert.rejects(
        billingRepo.createReservation(TENANT_ALPHA, {
          ...params,
          amount: 60000n,
        }),
        ReservationConflictError,
      );
    });

    it('rejects over-settlement beyond remaining uncommitted amount', async () => {
      const account = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Over Settle' });
      await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        entryType: 'CREDIT',
        amount: 100000n,
        purpose: 'DEP',
        referenceId: 'ref_dep',
      });

      const resId = `res_over_${RUN_SEED}`;
      await billingRepo.createReservation(TENANT_ALPHA, {
        reservationId: resId,
        tenantId: TENANT_ALPHA,
        accountId: account.id,
        amount: 50000n,
        purpose: 'RES',
        referenceId: 'ref_res',
      });

      // Attempting to settle 50,001n throws InvalidAmountError
      await assert.rejects(
        billingRepo.settleReservation(TENANT_ALPHA, {
          reservationId: resId,
          settleAmount: 50001n,
        }),
        InvalidAmountError,
      );
    });
  });

  // =========================================================================
  // AC-03: Multi-Tenant Boundary & Cross-Tenant Isolation
  // =========================================================================
  describe('5. Multi-Tenant Boundary & Cross-Tenant Isolation', () => {
    let alphaAcc: any;
    let betaAcc: any;

    beforeEach(async () => {
      alphaAcc = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Alpha Boundary Account' });
      betaAcc = await billingRepo.createAccount(TENANT_BETA, { name: 'Beta Boundary Account' });
    });

    it('strictly enforces composite foreign key (tenant_id, account_id) on ledger_entries at DB level', async () => {
      // Raw attempt to insert ledger entry with tenantId = TENANT_ALPHA referencing accountId of TENANT_BETA
      await assert.rejects(
        prisma.ledgerEntry.create({
          data: {
            tenantId: TENANT_ALPHA,
            accountId: betaAcc.id,
            sequence: 1n,
            entryType: 'CREDIT',
            amount: 5000n,
            purpose: 'ILLEGAL_CROSS_ENTRY',
            referenceId: 'ref_illegal_1',
          },
        }),
        (err: any) => {
          assert.ok(err.code === 'P2003' || /foreign key/i.test(err.message));
          return true;
        },
      );
    });

    it('strictly enforces composite foreign key (tenant_id, account_id) on credit_reservations at DB level', async () => {
      // Raw attempt to insert credit reservation with tenantId = TENANT_ALPHA referencing accountId of TENANT_BETA
      await assert.rejects(
        prisma.creditReservation.create({
          data: {
            id: `res_illegal_${RUN_SEED}`,
            tenantId: TENANT_ALPHA,
            accountId: betaAcc.id,
            amount: 5000n,
            purpose: 'ILLEGAL_CROSS_RES',
            referenceId: 'ref_illegal_2',
          },
        }),
        (err: any) => {
          assert.ok(err.code === 'P2003' || /foreign key/i.test(err.message));
          return true;
        },
      );
    });

    it('prevents Tenant Beta from settling or releasing Tenant Alpha reservation', async () => {
      // Fund Alpha
      await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: alphaAcc.id,
        entryType: 'CREDIT',
        amount: 100000n,
        purpose: 'FUND',
        referenceId: 'ref_fund',
      });

      const resId = `res_alpha_cross_${RUN_SEED}`;
      await billingRepo.createReservation(TENANT_ALPHA, {
        reservationId: resId,
        tenantId: TENANT_ALPHA,
        accountId: alphaAcc.id,
        amount: 20000n,
        purpose: 'ALPHA_RES',
        referenceId: 'ref_alpha_res',
      });

      // Tenant Beta attempts to settle Alpha reservation -> ReservationNotFoundError
      await assert.rejects(
        billingRepo.settleReservation(TENANT_BETA, {
          reservationId: resId,
          settleAmount: 10000n,
        }),
        ReservationNotFoundError,
      );

      // Tenant Beta attempts to release Alpha reservation -> ReservationNotFoundError
      await assert.rejects(
        billingRepo.releaseReservation(TENANT_BETA, {
          reservationId: resId,
        }),
        ReservationNotFoundError,
      );

      // findReservationById from Tenant Beta returns null
      const checkBeta = await billingRepo.findReservationById(TENANT_BETA, resId);
      assert.equal(checkBeta, null);

      // findReservationById from Tenant Alpha returns the reservation
      const checkAlpha = await billingRepo.findReservationById(TENANT_ALPHA, resId);
      assert.ok(checkAlpha);
      assert.equal(checkAlpha.id, resId);
    });

    it('prevents Tenant Beta from retrieving balance of Tenant Alpha account', async () => {
      await assert.rejects(
        billingRepo.getBalance(TENANT_BETA, alphaAcc.id),
        AccountNotFoundError,
      );
    });

    it('isolates listEntries and listActiveReservations strictly by tenant', async () => {
      await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: alphaAcc.id,
        entryType: 'CREDIT',
        amount: 10000n,
        purpose: 'ALPHA_P',
        referenceId: 'ref_a',
      });

      await billingRepo.appendEntry(TENANT_BETA, {
        tenantId: TENANT_BETA,
        accountId: betaAcc.id,
        entryType: 'CREDIT',
        amount: 20000n,
        purpose: 'BETA_P',
        referenceId: 'ref_b',
      });

      const alphaEntries = await billingRepo.listEntries(TENANT_ALPHA);
      const betaEntries = await billingRepo.listEntries(TENANT_BETA);

      assert.ok(alphaEntries.every((e) => e.tenantId === TENANT_ALPHA));
      assert.ok(betaEntries.every((e) => e.tenantId === TENANT_BETA));
      assert.ok(alphaEntries.some((e) => e.accountId === alphaAcc.id));
      assert.ok(!alphaEntries.some((e) => e.accountId === betaAcc.id));
      assert.ok(betaEntries.some((e) => e.accountId === betaAcc.id));
      assert.ok(!betaEntries.some((e) => e.accountId === alphaAcc.id));
    });
  });

  // =========================================================================
  // AC-03: Strict Per-Tenant Cleanup (Never Global Wipe)
  // =========================================================================
  describe('6. Strict Per-Tenant Cleanup (Never Global Wipe)', () => {
    it('clearTenant clears ONLY the specified tenant billing records', async () => {
      const alphaAcc = await billingRepo.createAccount(TENANT_ALPHA, { name: 'Clear Test Alpha' });
      const betaAcc = await billingRepo.createAccount(TENANT_BETA, { name: 'Clear Test Beta' });

      await billingRepo.appendEntry(TENANT_ALPHA, {
        tenantId: TENANT_ALPHA,
        accountId: alphaAcc.id,
        entryType: 'CREDIT',
        amount: 10000n,
        purpose: 'ALPHA_CRED',
        referenceId: 'ref_cl_a',
      });

      await billingRepo.appendEntry(TENANT_BETA, {
        tenantId: TENANT_BETA,
        accountId: betaAcc.id,
        entryType: 'CREDIT',
        amount: 20000n,
        purpose: 'BETA_CRED',
        referenceId: 'ref_cl_b',
      });

      // Clear Tenant Alpha
      await billingRepo.clearTenant(TENANT_ALPHA);

      // Alpha records wiped
      const alphaAccounts = await billingRepo.listAccounts(TENANT_ALPHA);
      const alphaEntries = await billingRepo.listEntries(TENANT_ALPHA);
      assert.equal(alphaAccounts.length, 0);
      assert.equal(alphaEntries.length, 0);

      // Beta records completely intact!
      const betaAccounts = await billingRepo.listAccounts(TENANT_BETA);
      const betaEntries = await billingRepo.listEntries(TENANT_BETA);
      assert.ok(betaAccounts.length >= 1);
      assert.ok(betaEntries.length >= 1);
    });
  });
});
