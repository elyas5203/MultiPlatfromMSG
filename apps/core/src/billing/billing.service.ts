import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
} from '@nestjs/common';
import { TenantContext } from '../tenant/tenant-context';
import {
  BillingRepository,
  AccountNotFoundError,
} from './billing.repository';
import {
  InsufficientFundsError,
  ReservationNotFoundError,
  ReservationConflictError,
  InvalidAmountError,
  AccountBalance,
  LedgerEntry,
  Reservation,
} from './types';
import {
  TopUpInput,
  ReserveCreditInput,
  SettleReservationInput,
  ReleaseReservationInput,
  CreateWalletAccountInput,
} from './dto/billing.dto';

export interface SerializedBalance {
  accountId: string;
  currency: string;
  settledBalance: string;
  reservedAmount: string;
  availableBalance: string;
  creditLimit: string;
}

export interface SerializedLedgerEntry {
  id: string;
  tenantId: string;
  accountId: string;
  sequence: string;
  entryType: string;
  amount: string;
  purpose: string;
  referenceId: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

export interface SerializedReservation {
  id: string;
  tenantId: string;
  accountId: string;
  amount: string;
  settledAmount: string;
  releasedAmount: string;
  status: string;
  purpose: string;
  referenceId: string;
  releaseReason?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

function serializeBalance(balance: AccountBalance, currency = 'IRR'): SerializedBalance {
  return {
    accountId: balance.accountId,
    currency,
    settledBalance: balance.netBalance.toString(),
    reservedAmount: balance.activeReservationsSum.toString(),
    availableBalance: balance.availableBalance.toString(),
    creditLimit: balance.creditLimit.toString(),
  };
}

function serializeEntry(entry: LedgerEntry): SerializedLedgerEntry {
  return {
    id: entry.id,
    tenantId: entry.tenantId,
    accountId: entry.accountId,
    sequence: entry.sequence.toString(),
    entryType: entry.entryType,
    amount: entry.amount.toString(),
    purpose: entry.purpose,
    referenceId: entry.referenceId,
    timestamp: entry.timestamp.toISOString(),
    metadata: entry.metadata as Record<string, unknown> | undefined,
  };
}

function serializeReservation(res: Reservation): SerializedReservation {
  return {
    id: res.id,
    tenantId: res.tenantId,
    accountId: res.accountId,
    amount: res.amount.toString(),
    settledAmount: res.settledAmount.toString(),
    releasedAmount: res.releasedAmount.toString(),
    status: res.status,
    purpose: res.purpose,
    referenceId: res.referenceId,
    releaseReason: res.releaseReason,
    metadata: res.metadata as Record<string, unknown> | undefined,
    createdAt: res.createdAt.toISOString(),
    updatedAt: res.updatedAt.toISOString(),
  };
}

@Injectable()
export class BillingService {
  constructor(private readonly billingRepository: BillingRepository) {}

  /**
   * Helper to resolve accountId or get/create default tenant account.
   */
  async resolveAccount(tenantId: string, requestedAccountId?: string): Promise<{ id: string; currency: string }> {
    if (requestedAccountId) {
      const account = await this.billingRepository.findAccountById(tenantId, requestedAccountId);
      if (!account) {
        throw new NotFoundException(`Account '${requestedAccountId}' not found in tenant scope.`);
      }
      return { id: account.id, currency: account.currency };
    }

    const accounts = await this.billingRepository.listAccounts(tenantId);
    if (accounts.length > 0) {
      return { id: accounts[0].id, currency: accounts[0].currency };
    }

    // Auto-create default wallet account for tenant
    const defaultAcc = await this.billingRepository.createAccount(tenantId, {
      name: 'Default Wallet',
      type: 'CUSTOMER',
      currency: 'IRR',
      creditLimit: 0n,
    });
    return { id: defaultAcc.id, currency: defaultAcc.currency };
  }

  async getWalletBalance(accountId?: string): Promise<SerializedBalance> {
    const tenantId = TenantContext.getTenantId();
    const account = await this.resolveAccount(tenantId, accountId);
    const balance = await this.billingRepository.getBalance(tenantId, account.id);
    return serializeBalance(balance, account.currency);
  }

  async listAccounts() {
    const tenantId = TenantContext.getTenantId();
    const accounts = await this.billingRepository.listAccounts(tenantId);
    return accounts.map((acc) => ({
      id: acc.id,
      tenantId: acc.tenantId,
      name: acc.name,
      type: acc.type,
      currency: acc.currency,
      creditLimit: acc.creditLimit.toString(),
      status: acc.status,
      createdAt: acc.createdAt.toISOString(),
      updatedAt: acc.updatedAt.toISOString(),
    }));
  }

  async createAccount(input: CreateWalletAccountInput) {
    const tenantId = TenantContext.getTenantId();
    const acc = await this.billingRepository.createAccount(tenantId, input);
    return {
      id: acc.id,
      tenantId: acc.tenantId,
      name: acc.name,
      type: acc.type,
      currency: acc.currency,
      creditLimit: acc.creditLimit.toString(),
      status: acc.status,
      createdAt: acc.createdAt.toISOString(),
      updatedAt: acc.updatedAt.toISOString(),
    };
  }

  async topUpWallet(input: TopUpInput): Promise<SerializedLedgerEntry> {
    const tenantId = TenantContext.getTenantId();
    const account = await this.resolveAccount(tenantId, input.accountId);

    try {
      const entry = await this.billingRepository.appendEntry(tenantId, {
        tenantId,
        accountId: account.id,
        entryType: 'CREDIT',
        amount: input.amount,
        purpose: input.purpose,
        referenceId: input.referenceId,
        metadata: input.metadata,
      });
      return serializeEntry(entry);
    } catch (err: unknown) {
      if (err instanceof InvalidAmountError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  async listLedgerEntries(accountId?: string): Promise<SerializedLedgerEntry[]> {
    const tenantId = TenantContext.getTenantId();
    let targetAccountId: string | undefined = accountId;
    if (accountId) {
      const account = await this.billingRepository.findAccountById(tenantId, accountId);
      if (!account) {
        throw new NotFoundException(`Account '${accountId}' not found.`);
      }
      targetAccountId = account.id;
    }
    const entries = await this.billingRepository.listEntries(tenantId, targetAccountId);
    return entries.map(serializeEntry);
  }

  async reserveCredit(input: ReserveCreditInput): Promise<SerializedReservation> {
    const tenantId = TenantContext.getTenantId();
    const account = await this.resolveAccount(tenantId, input.accountId);
    const reservationId = `res_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    try {
      const reservation = await this.billingRepository.createReservation(tenantId, {
        reservationId,
        tenantId,
        accountId: account.id,
        amount: input.amount,
        purpose: input.purpose,
        referenceId: input.referenceId,
        metadata: input.metadata,
      });
      return serializeReservation(reservation);
    } catch (err: unknown) {
      if (err instanceof InsufficientFundsError) {
        throw new BadRequestException(err.message);
      }
      if (err instanceof InvalidAmountError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  async settleReservation(input: SettleReservationInput): Promise<SerializedReservation> {
    const tenantId = TenantContext.getTenantId();
    const reservation = await this.billingRepository.findReservationById(tenantId, input.reservationId);
    if (!reservation) {
      throw new NotFoundException(`Reservation '${input.reservationId}' not found in tenant scope.`);
    }

    const settleAmount = input.settledAmount ?? (reservation.amount - reservation.settledAmount - reservation.releasedAmount);

    try {
      const result = await this.billingRepository.settleReservation(tenantId, {
        reservationId: input.reservationId,
        settleAmount,
      });
      return serializeReservation(result.reservation);
    } catch (err: unknown) {
      if (err instanceof ReservationNotFoundError) {
        throw new NotFoundException(err.message);
      }
      if (err instanceof ReservationConflictError) {
        throw new ConflictException(err.message);
      }
      if (err instanceof InvalidAmountError) {
        throw new BadRequestException(err.message);
      }
      throw err;
    }
  }

  async releaseReservation(input: ReleaseReservationInput): Promise<SerializedReservation> {
    const tenantId = TenantContext.getTenantId();
    try {
      const result = await this.billingRepository.releaseReservation(tenantId, {
        reservationId: input.reservationId,
        reason: input.releaseReason,
      });
      return serializeReservation(result.reservation);
    } catch (err: unknown) {
      if (err instanceof ReservationNotFoundError) {
        throw new NotFoundException(err.message);
      }
      if (err instanceof ReservationConflictError) {
        throw new ConflictException(err.message);
      }
      throw err;
    }
  }

  async listActiveReservations(accountId?: string): Promise<SerializedReservation[]> {
    const tenantId = TenantContext.getTenantId();
    const reservations = await this.billingRepository.listActiveReservations(tenantId, accountId);
    return reservations.map(serializeReservation);
  }
}
