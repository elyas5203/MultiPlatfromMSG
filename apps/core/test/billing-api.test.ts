import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { TenantContext } from '../src/tenant/tenant-context';
import { Role } from '../src/rbac/roles.enum';
import { BillingRepository } from '../src/billing/billing.repository';
import { BillingService } from '../src/billing/billing.service';
import { BillingController } from '../src/billing/billing.controller';
import {
  TopUpDto,
  ReserveCreditDto,
  SettleReservationDto,
  ReleaseReservationDto,
  CreateWalletAccountDto,
} from '../src/billing/dto/billing.dto';

// In-Memory Prisma Mock for Billing Tests
class InMemoryBillingPrismaMock {
  accounts: any[] = [];
  ledgerEntries: any[] = [];
  reservations: any[] = [];
  private idCounter = 1;

  reset() {
    this.accounts = [];
    this.ledgerEntries = [];
    this.reservations = [];
    this.idCounter = 1;
  }

  async $transaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
    return fn(this);
  }

  readonly account = {
    create: async ({ data }: { data: any }) => {
      const rec = {
        id: data.id || `acc_${this.idCounter++}`,
        tenantId: data.tenantId,
        name: data.name,
        type: data.type || 'CUSTOMER',
        currency: data.currency || 'IRR',
        creditLimit: data.creditLimit !== undefined ? BigInt(data.creditLimit) : 0n,
        status: data.status || 'ACTIVE',
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.accounts.push(rec);
      return { ...rec };
    },
    findFirst: async ({ where }: { where: any }) => {
      const match = this.accounts.find((a) => {
        if (where.tenantId && a.tenantId !== where.tenantId) return false;
        if (where.id && a.id !== where.id) return false;
        return true;
      });
      return match ? { ...match } : null;
    },
    findUnique: async ({ where }: { where: any }) => {
      const { tenantId, id } = where.tenantId_id;
      const match = this.accounts.find((a) => a.tenantId === tenantId && a.id === id);
      return match ? { ...match } : null;
    },
    findMany: async ({ where }: { where?: any } = {}) => {
      return this.accounts
        .filter((a) => !where?.tenantId || a.tenantId === where.tenantId)
        .map((a) => ({ ...a }));
    },
    update: async ({ where, data }: { where: any; data: any }) => {
      const { tenantId, id } = where.tenantId_id;
      const acc = this.accounts.find((a) => a.tenantId === tenantId && a.id === id);
      if (!acc) throw new Error('Account not found');
      if (data.creditLimit !== undefined) acc.creditLimit = BigInt(data.creditLimit);
      if (data.status !== undefined) acc.status = data.status;
      acc.updatedAt = new Date();
      return { ...acc };
    },
    deleteMany: async ({ where }: { where: any }) => {
      this.accounts = this.accounts.filter((a) => a.tenantId !== where.tenantId);
      return { count: 1 };
    },
  };

  readonly ledgerEntry = {
    create: async ({ data }: { data: any }) => {
      const rec = {
        id: data.id || `entry_${this.idCounter++}`,
        tenantId: data.tenantId,
        accountId: data.accountId,
        sequence: BigInt(data.sequence),
        entryType: data.entryType,
        amount: BigInt(data.amount),
        purpose: data.purpose,
        referenceId: data.referenceId,
        metadata: data.metadata || null,
        timestamp: data.timestamp || new Date(),
      };
      this.ledgerEntries.push(rec);
      return { ...rec };
    },
    findFirst: async ({ where, orderBy }: { where: any; orderBy?: any }) => {
      const filtered = this.ledgerEntries.filter(
        (e) => e.tenantId === where.tenantId && e.accountId === where.accountId,
      );
      if (filtered.length === 0) return null;
      filtered.sort((a, b) => Number(b.sequence - a.sequence));
      return { ...filtered[0] };
    },
    findMany: async ({ where }: { where?: any } = {}) => {
      let filtered = this.ledgerEntries.filter((e) => {
        if (where?.tenantId && e.tenantId !== where.tenantId) return false;
        if (where?.accountId && e.accountId !== where.accountId) return false;
        return true;
      });
      filtered.sort((a, b) => Number(a.sequence - b.sequence));
      return filtered.map((e) => ({ ...e }));
    },
    deleteMany: async ({ where }: { where: any }) => {
      this.ledgerEntries = this.ledgerEntries.filter((e) => e.tenantId !== where.tenantId);
      return { count: 1 };
    },
  };

  readonly creditReservation = {
    create: async ({ data }: { data: any }) => {
      const rec = {
        id: data.id || `res_${this.idCounter++}`,
        tenantId: data.tenantId,
        accountId: data.accountId,
        amount: BigInt(data.amount),
        settledAmount: data.settledAmount ? BigInt(data.settledAmount) : 0n,
        releasedAmount: data.releasedAmount ? BigInt(data.releasedAmount) : 0n,
        status: data.status || 'ACTIVE',
        purpose: data.purpose,
        referenceId: data.referenceId,
        releaseReason: data.releaseReason || null,
        metadata: data.metadata || null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      this.reservations.push(rec);
      return { ...rec };
    },
    findFirst: async ({ where }: { where: any }) => {
      const match = this.reservations.find((r) => {
        if (where.tenantId && r.tenantId !== where.tenantId) return false;
        if (where.id && r.id !== where.id) return false;
        if (where.status && r.status !== where.status) return false;
        return true;
      });
      return match ? { ...match } : null;
    },
    findUnique: async ({ where }: { where: any }) => {
      const { tenantId, id } = where.tenantId_id;
      const match = this.reservations.find((r) => r.tenantId === tenantId && r.id === id);
      return match ? { ...match } : null;
    },
    findMany: async ({ where }: { where?: any } = {}) => {
      return this.reservations
        .filter((r) => {
          if (where?.tenantId && r.tenantId !== where.tenantId) return false;
          if (where?.accountId && r.accountId !== where.accountId) return false;
          if (where?.status && r.status !== where.status) return false;
          return true;
        })
        .map((r) => ({ ...r }));
    },
    update: async ({ where, data }: { where: any; data: any }) => {
      let res: any;
      if (where.tenantId_id) {
        const { tenantId, id } = where.tenantId_id;
        res = this.reservations.find((r) => r.tenantId === tenantId && r.id === id);
      } else if (where.id) {
        res = this.reservations.find((r) => r.id === where.id);
      }
      if (!res) throw new Error('Reservation not found');
      if (data.status !== undefined) res.status = data.status;
      if (data.settledAmount !== undefined) res.settledAmount = BigInt(data.settledAmount);
      if (data.releasedAmount !== undefined) res.releasedAmount = BigInt(data.releasedAmount);
      if (data.releaseReason !== undefined) res.releaseReason = data.releaseReason;
      res.updatedAt = new Date();
      return { ...res };
    },
    deleteMany: async ({ where }: { where: any }) => {
      this.reservations = this.reservations.filter((r) => r.tenantId !== where.tenantId);
      return { count: 1 };
    },
  };
}

describe('TASK-0026: Billing Wallet & Ledger Endpoints Test Suite', () => {
  let prismaMock: InMemoryBillingPrismaMock;
  let repository: BillingRepository;
  let service: BillingService;
  let controller: BillingController;

  const TENANT_A = 'tenant_alpha_123';
  const TENANT_B = 'tenant_beta_456';

  beforeEach(() => {
    prismaMock = new InMemoryBillingPrismaMock();
    repository = new BillingRepository(prismaMock as any);
    service = new BillingService(repository);
    controller = new BillingController(service);
  });

  describe('DTO Validation (Billing DTOs)', () => {
    it('TopUpDto: successfully parses valid inputs and converts string amount to BigInt', () => {
      const parsed = TopUpDto.parse({
        amount: '500000',
        purpose: 'DEPOSIT',
        referenceId: 'ref_001',
      });
      assert.equal(parsed.amount, 500000n);
      assert.equal(parsed.purpose, 'DEPOSIT');
      assert.equal(parsed.referenceId, 'ref_001');
    });

    it('TopUpDto: rejects zero or negative amounts', () => {
      assert.throws(() => TopUpDto.parse({ amount: '0' }), BadRequestException);
      assert.throws(() => TopUpDto.parse({ amount: '-1000' }), BadRequestException);
    });

    it('TopUpDto: rejects unexpected fields (strict schema)', () => {
      assert.throws(
        () => TopUpDto.parse({ amount: '1000', unknownProp: 'hack' }),
        BadRequestException,
      );
    });

    it('ReserveCreditDto: parses required amount, purpose, referenceId', () => {
      const parsed = ReserveCreditDto.parse({
        amount: 25000,
        purpose: 'CAMPAIGN_BATCH',
        referenceId: 'batch_42',
      });
      assert.equal(parsed.amount, 25000n);
      assert.equal(parsed.purpose, 'CAMPAIGN_BATCH');
      assert.equal(parsed.referenceId, 'batch_42');
    });

    it('ReserveCreditDto: rejects missing purpose or referenceId', () => {
      assert.throws(() => ReserveCreditDto.parse({ amount: 100 }), BadRequestException);
      assert.throws(() => ReserveCreditDto.parse({ amount: 100, purpose: 'x' }), BadRequestException);
    });

    it('SettleReservationDto: parses reservationId and optional settledAmount', () => {
      const parsed = SettleReservationDto.parse({ reservationId: 'res_1' });
      assert.equal(parsed.reservationId, 'res_1');
      assert.equal(parsed.settledAmount, undefined);

      const parsedPartial = SettleReservationDto.parse({ reservationId: 'res_1', settledAmount: '50' });
      assert.equal(parsedPartial.settledAmount, 50n);
    });

    it('ReleaseReservationDto: parses reservationId and optional reason', () => {
      const parsed = ReleaseReservationDto.parse({
        reservationId: 'res_1',
        releaseReason: 'Campaign cancelled',
      });
      assert.equal(parsed.reservationId, 'res_1');
      assert.equal(parsed.releaseReason, 'Campaign cancelled');
    });
  });

  describe('Wallet Balance, Top-up, and Ledger Workflow', () => {
    it('should initialize default wallet account and report zero balance', async () => {
      await TenantContext.runWithTenant(TENANT_A, async () => {
        const balance = await controller.getBalance();
        assert.ok(balance.accountId);
        assert.equal(balance.settledBalance, '0');
        assert.equal(balance.reservedAmount, '0');
        assert.equal(balance.availableBalance, '0');
        assert.equal(balance.currency, 'IRR');
      });
    });

    it('should top-up wallet and accurately reflect balance and ledger entry', async () => {
      await TenantContext.runWithTenant(TENANT_A, async () => {
        const entry = await controller.topUp({
          amount: '1000000',
          purpose: 'INITIAL_DEPOSIT',
          referenceId: 'pay_tx_101',
        });

        assert.equal(entry.amount, '1000000');
        assert.equal(entry.entryType, 'CREDIT');
        assert.equal(entry.purpose, 'INITIAL_DEPOSIT');

        const balance = await controller.getBalance();
        assert.equal(balance.settledBalance, '1000000');
        assert.equal(balance.reservedAmount, '0');
        assert.equal(balance.availableBalance, '1000000');

        const ledger = await controller.listLedgerEntries();
        assert.equal(ledger.length, 1);
        assert.equal(ledger[0].amount, '1000000');
      });
    });

    it('should perform two-phase credit reservation (Reserve -> Settle)', async () => {
      await TenantContext.runWithTenant(TENANT_A, async () => {
        // Top-up 500,000
        await controller.topUp({ amount: '500000', purpose: 'TOPUP' });

        // Reserve 200,000
        const reservation = await controller.reserveCredit({
          amount: '200000',
          purpose: 'BROADCAST_RESERVATION',
          referenceId: 'camp_001',
        });
        assert.equal(reservation.status, 'ACTIVE');
        assert.equal(reservation.amount, '200000');

        // Check balance: settled is 500k, reserved is 200k, available is 300k
        let balance = await controller.getBalance();
        assert.equal(balance.settledBalance, '500000');
        assert.equal(balance.reservedAmount, '200000');
        assert.equal(balance.availableBalance, '300000');

        // Settle reservation for full amount
        const settled = await controller.settleReservation({
          reservationId: reservation.id,
        });
        assert.equal(settled.status, 'SETTLED');

        // Check balance: settled is now 300k, reserved is 0, available is 300k
        balance = await controller.getBalance();
        assert.equal(balance.settledBalance, '300000');
        assert.equal(balance.reservedAmount, '0');
        assert.equal(balance.availableBalance, '300000');
      });
    });

    it('should perform two-phase credit reservation and Release unspent funds', async () => {
      await TenantContext.runWithTenant(TENANT_A, async () => {
        await controller.topUp({ amount: '300000', purpose: 'TOPUP' });

        const reservation = await controller.reserveCredit({
          amount: '150000',
          purpose: 'BROADCAST_RESERVATION',
          referenceId: 'camp_cancel',
        });

        let balance = await controller.getBalance();
        assert.equal(balance.availableBalance, '150000');

        // Release
        const released = await controller.releaseReservation({
          reservationId: reservation.id,
          releaseReason: 'Target audience empty',
        });
        assert.equal(released.status, 'RELEASED');

        balance = await controller.getBalance();
        assert.equal(balance.settledBalance, '300000');
        assert.equal(balance.reservedAmount, '0');
        assert.equal(balance.availableBalance, '300000');
      });
    });

    it('should reject credit reservation exceeding available funds', async () => {
      await TenantContext.runWithTenant(TENANT_A, async () => {
        await controller.topUp({ amount: '10000', purpose: 'TOPUP' });

        await assert.rejects(
          async () => {
            await controller.reserveCredit({
              amount: '50000',
              purpose: 'BIG_CAMPAIGN',
              referenceId: 'ref_fail',
            });
          },
          (err: any) => err instanceof BadRequestException && /insufficient/i.test(err.message),
        );
      });
    });
  });

  describe('Multi-Tenant Isolation & Security', () => {
    it('Tenant A and Tenant B must have completely segregated balances and ledgers', async () => {
      await TenantContext.runWithTenant(TENANT_A, async () => {
        await controller.topUp({ amount: '1000000', purpose: 'ALPHA_CREDIT' });
      });

      await TenantContext.runWithTenant(TENANT_B, async () => {
        await controller.topUp({ amount: '50000', purpose: 'BETA_CREDIT' });
      });

      await TenantContext.runWithTenant(TENANT_A, async () => {
        const balance = await controller.getBalance();
        assert.equal(balance.settledBalance, '1000000');
        const ledger = await controller.listLedgerEntries();
        assert.equal(ledger.length, 1);
        assert.equal(ledger[0].purpose, 'ALPHA_CREDIT');
      });

      await TenantContext.runWithTenant(TENANT_B, async () => {
        const balance = await controller.getBalance();
        assert.equal(balance.settledBalance, '50000');
        const ledger = await controller.listLedgerEntries();
        assert.equal(ledger.length, 1);
        assert.equal(ledger[0].purpose, 'BETA_CREDIT');
      });
    });

    it('Tenant B cannot settle or release Tenant A reservation (Cross-Tenant Leak Prevention)', async () => {
      let tenantAResId = '';

      await TenantContext.runWithTenant(TENANT_A, async () => {
        await controller.topUp({ amount: '500000', purpose: 'TOPUP' });
        const res = await controller.reserveCredit({
          amount: '100000',
          purpose: 'ALPHA_RES',
          referenceId: 'alpha_ref',
        });
        tenantAResId = res.id;
      });

      await TenantContext.runWithTenant(TENANT_B, async () => {
        await assert.rejects(
          async () => {
            await controller.settleReservation({ reservationId: tenantAResId });
          },
          (err: any) => err instanceof NotFoundException,
        );

        await assert.rejects(
          async () => {
            await controller.releaseReservation({ reservationId: tenantAResId });
          },
          (err: any) => err instanceof NotFoundException,
        );
      });
    });
  });
});
