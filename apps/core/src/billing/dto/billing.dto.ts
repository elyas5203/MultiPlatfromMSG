import { BadRequestException } from '@nestjs/common';

export function assertNoUnknownFields(
  body: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new BadRequestException('Request body must be a valid JSON object.');
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys) {
    if (!allowedKeys.includes(key)) {
      throw new BadRequestException(`Unknown field '${key}' is not permitted.`);
    }
  }
  return record;
}

export function parsePositiveBigInt(value: unknown, fieldName: string): bigint {
  if (value === undefined || value === null) {
    throw new BadRequestException(`Field '${fieldName}' is required.`);
  }
  try {
    const b = BigInt(value as string | number | bigint);
    if (b <= 0n) {
      throw new BadRequestException(`Field '${fieldName}' must be a strictly positive integer (> 0).`);
    }
    return b;
  } catch (err: unknown) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException(`Field '${fieldName}' must be a valid integer string or number.`);
  }
}

export function parseNonNegativeBigInt(value: unknown, fieldName: string): bigint {
  if (value === undefined || value === null) {
    throw new BadRequestException(`Field '${fieldName}' is required.`);
  }
  try {
    const b = BigInt(value as string | number | bigint);
    if (b < 0n) {
      throw new BadRequestException(`Field '${fieldName}' must be non-negative (>= 0).`);
    }
    return b;
  } catch (err: unknown) {
    if (err instanceof BadRequestException) throw err;
    throw new BadRequestException(`Field '${fieldName}' must be a valid integer string or number.`);
  }
}

export interface TopUpInput {
  accountId?: string;
  amount: bigint;
  purpose: string;
  referenceId: string;
  metadata?: Record<string, unknown>;
}

export class TopUpDto {
  static readonly ALLOWED_KEYS = ['accountId', 'amount', 'purpose', 'referenceId', 'metadata'] as const;

  static parse(body: unknown): TopUpInput {
    const raw = assertNoUnknownFields(body, TopUpDto.ALLOWED_KEYS);

    const amount = parsePositiveBigInt(raw.amount, 'amount');

    let purpose = 'MANUAL_TOPUP';
    if (raw.purpose !== undefined && raw.purpose !== null) {
      if (typeof raw.purpose !== 'string' || raw.purpose.trim().length === 0) {
        throw new BadRequestException('purpose must be a non-empty string.');
      }
      purpose = raw.purpose.trim();
    }

    let referenceId = '';
    if (raw.referenceId !== undefined && raw.referenceId !== null) {
      if (typeof raw.referenceId !== 'string' || raw.referenceId.trim().length === 0) {
        throw new BadRequestException('referenceId must be a non-empty string.');
      }
      referenceId = raw.referenceId.trim();
    } else {
      referenceId = `topup_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
    }

    let accountId: string | undefined = undefined;
    if (raw.accountId !== undefined && raw.accountId !== null) {
      if (typeof raw.accountId !== 'string' || raw.accountId.trim().length === 0) {
        throw new BadRequestException('accountId must be a valid non-empty string.');
      }
      accountId = raw.accountId.trim();
    }

    let metadata: Record<string, unknown> | undefined = undefined;
    if (raw.metadata !== undefined && raw.metadata !== null) {
      if (typeof raw.metadata !== 'object' || Array.isArray(raw.metadata)) {
        throw new BadRequestException('metadata must be a JSON object.');
      }
      metadata = raw.metadata as Record<string, unknown>;
    }

    return {
      accountId,
      amount,
      purpose,
      referenceId,
      metadata,
    };
  }
}

export interface ReserveCreditInput {
  accountId?: string;
  amount: bigint;
  purpose: string;
  referenceId: string;
  metadata?: Record<string, unknown>;
}

export class ReserveCreditDto {
  static readonly ALLOWED_KEYS = ['accountId', 'amount', 'purpose', 'referenceId', 'metadata'] as const;

  static parse(body: unknown): ReserveCreditInput {
    const raw = assertNoUnknownFields(body, ReserveCreditDto.ALLOWED_KEYS);

    const amount = parsePositiveBigInt(raw.amount, 'amount');

    if (typeof raw.purpose !== 'string' || raw.purpose.trim().length === 0) {
      throw new BadRequestException('purpose is required and must be a non-empty string.');
    }

    if (typeof raw.referenceId !== 'string' || raw.referenceId.trim().length === 0) {
      throw new BadRequestException('referenceId is required and must be a non-empty string.');
    }

    let accountId: string | undefined = undefined;
    if (raw.accountId !== undefined && raw.accountId !== null) {
      if (typeof raw.accountId !== 'string' || raw.accountId.trim().length === 0) {
        throw new BadRequestException('accountId must be a valid non-empty string.');
      }
      accountId = raw.accountId.trim();
    }

    let metadata: Record<string, unknown> | undefined = undefined;
    if (raw.metadata !== undefined && raw.metadata !== null) {
      if (typeof raw.metadata !== 'object' || Array.isArray(raw.metadata)) {
        throw new BadRequestException('metadata must be a JSON object.');
      }
      metadata = raw.metadata as Record<string, unknown>;
    }

    return {
      accountId,
      amount,
      purpose: raw.purpose.trim(),
      referenceId: raw.referenceId.trim(),
      metadata,
    };
  }
}

export interface SettleReservationInput {
  reservationId: string;
  settledAmount?: bigint;
}

export class SettleReservationDto {
  static readonly ALLOWED_KEYS = ['reservationId', 'settledAmount'] as const;

  static parse(body: unknown): SettleReservationInput {
    const raw = assertNoUnknownFields(body, SettleReservationDto.ALLOWED_KEYS);

    if (typeof raw.reservationId !== 'string' || raw.reservationId.trim().length === 0) {
      throw new BadRequestException('reservationId is required and must be a non-empty string.');
    }

    let settledAmount: bigint | undefined = undefined;
    if (raw.settledAmount !== undefined && raw.settledAmount !== null) {
      settledAmount = parsePositiveBigInt(raw.settledAmount, 'settledAmount');
    }

    return {
      reservationId: raw.reservationId.trim(),
      settledAmount,
    };
  }
}

export interface ReleaseReservationInput {
  reservationId: string;
  releaseReason?: string;
}

export class ReleaseReservationDto {
  static readonly ALLOWED_KEYS = ['reservationId', 'releaseReason'] as const;

  static parse(body: unknown): ReleaseReservationInput {
    const raw = assertNoUnknownFields(body, ReleaseReservationDto.ALLOWED_KEYS);

    if (typeof raw.reservationId !== 'string' || raw.reservationId.trim().length === 0) {
      throw new BadRequestException('reservationId is required and must be a non-empty string.');
    }

    let releaseReason: string | undefined = undefined;
    if (raw.releaseReason !== undefined && raw.releaseReason !== null) {
      if (typeof raw.releaseReason !== 'string' || raw.releaseReason.trim().length === 0) {
        throw new BadRequestException('releaseReason must be a non-empty string if provided.');
      }
      releaseReason = raw.releaseReason.trim();
    }

    return {
      reservationId: raw.reservationId.trim(),
      releaseReason,
    };
  }
}

export interface CreateWalletAccountInput {
  name: string;
  type?: 'CUSTOMER' | 'SYSTEM' | 'ESCROW' | 'REVENUE' | string;
  currency?: string;
  creditLimit?: bigint;
}

export class CreateWalletAccountDto {
  static readonly ALLOWED_KEYS = ['name', 'type', 'currency', 'creditLimit'] as const;

  static parse(body: unknown): CreateWalletAccountInput {
    const raw = assertNoUnknownFields(body, CreateWalletAccountDto.ALLOWED_KEYS);

    if (typeof raw.name !== 'string' || raw.name.trim().length === 0) {
      throw new BadRequestException('Account name is required.');
    }

    let creditLimit: bigint | undefined = undefined;
    if (raw.creditLimit !== undefined && raw.creditLimit !== null) {
      creditLimit = parseNonNegativeBigInt(raw.creditLimit, 'creditLimit');
    }

    return {
      name: raw.name.trim(),
      type: typeof raw.type === 'string' ? raw.type.trim() : 'CUSTOMER',
      currency: typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : 'IRR',
      creditLimit,
    };
  }
}
