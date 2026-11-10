import { BadRequestException } from '@nestjs/common';
import { normalizeIranianMobile } from '../../contacts-import/phone-normalizer';
import {
  CreateContactInput,
  UpdateContactInput,
  ListContactsOptions,
  CreateTagInput,
  AddSuppressionInput,
} from '../types';

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

export class CreateContactDto {
  static readonly ALLOWED_KEYS = [
    'phone',
    'phoneNormalized',
    'phoneRaw',
    'firstName',
    'lastName',
    'attributes',
    'isSuppressed',
    'id',
  ] as const;

  static parse(body: unknown): CreateContactInput {
    const raw = assertNoUnknownFields(body, CreateContactDto.ALLOWED_KEYS);

    const rawPhone = (raw.phone ?? raw.phoneNormalized ?? raw.phoneRaw) as string | undefined;
    if (!rawPhone || typeof rawPhone !== 'string' || rawPhone.trim().length === 0) {
      throw new BadRequestException('A valid phone number is required.');
    }

    const normResult = normalizeIranianMobile(rawPhone);
    if (!normResult.success) {
      throw new BadRequestException(`Invalid phone number: ${normResult.message}`);
    }

    let firstName: string | undefined = undefined;
    if (raw.firstName !== undefined && raw.firstName !== null) {
      if (typeof raw.firstName !== 'string') {
        throw new BadRequestException('firstName must be a string.');
      }
      firstName = raw.firstName.trim();
    }

    let lastName: string | undefined = undefined;
    if (raw.lastName !== undefined && raw.lastName !== null) {
      if (typeof raw.lastName !== 'string') {
        throw new BadRequestException('lastName must be a string.');
      }
      lastName = raw.lastName.trim();
    }

    let attributes: Record<string, unknown> | null | undefined = undefined;
    if (raw.attributes !== undefined && raw.attributes !== null) {
      if (typeof raw.attributes !== 'object' || Array.isArray(raw.attributes)) {
        throw new BadRequestException('attributes must be a valid JSON object.');
      }
      attributes = raw.attributes as Record<string, unknown>;
    } else if (raw.attributes === null) {
      attributes = null;
    }

    let isSuppressed: boolean | undefined = undefined;
    if (raw.isSuppressed !== undefined) {
      if (typeof raw.isSuppressed !== 'boolean') {
        throw new BadRequestException('isSuppressed must be a boolean.');
      }
      isSuppressed = raw.isSuppressed;
    }

    let id: string | undefined = undefined;
    if (raw.id !== undefined && raw.id !== null) {
      if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
        throw new BadRequestException('id must be a non-empty string.');
      }
      id = raw.id.trim();
    }

    return {
      id,
      phoneNormalized: normResult.normalized,
      phoneRaw: typeof raw.phoneRaw === 'string' ? raw.phoneRaw.trim() : rawPhone.trim(),
      firstName,
      lastName,
      attributes,
      isSuppressed,
    };
  }
}

export class UpdateContactDto {
  static readonly ALLOWED_KEYS = [
    'phone',
    'phoneNormalized',
    'phoneRaw',
    'firstName',
    'lastName',
    'attributes',
    'isSuppressed',
  ] as const;

  static parse(body: unknown): UpdateContactInput {
    const raw = assertNoUnknownFields(body, UpdateContactDto.ALLOWED_KEYS);

    const result: UpdateContactInput = {};

    const rawPhone = (raw.phone ?? raw.phoneNormalized ?? raw.phoneRaw) as string | undefined;
    if (rawPhone !== undefined) {
      if (typeof rawPhone !== 'string' || rawPhone.trim().length === 0) {
        throw new BadRequestException('phone must be a non-empty string.');
      }
      const normResult = normalizeIranianMobile(rawPhone);
      if (!normResult.success) {
        throw new BadRequestException(`Invalid phone number: ${normResult.message}`);
      }
      result.phoneNormalized = normResult.normalized;
      result.phoneRaw = typeof raw.phoneRaw === 'string' ? raw.phoneRaw.trim() : rawPhone.trim();
    }

    if (raw.firstName !== undefined) {
      if (raw.firstName !== null && typeof raw.firstName !== 'string') {
        throw new BadRequestException('firstName must be a string or null.');
      }
      result.firstName = raw.firstName !== null ? (raw.firstName as string).trim() : undefined;
    }

    if (raw.lastName !== undefined) {
      if (raw.lastName !== null && typeof raw.lastName !== 'string') {
        throw new BadRequestException('lastName must be a string or null.');
      }
      result.lastName = raw.lastName !== null ? (raw.lastName as string).trim() : undefined;
    }

    if (raw.attributes !== undefined) {
      if (raw.attributes !== null && (typeof raw.attributes !== 'object' || Array.isArray(raw.attributes))) {
        throw new BadRequestException('attributes must be a valid JSON object or null.');
      }
      result.attributes = raw.attributes as Record<string, unknown> | null;
    }

    if (raw.isSuppressed !== undefined) {
      if (typeof raw.isSuppressed !== 'boolean') {
        throw new BadRequestException('isSuppressed must be a boolean.');
      }
      result.isSuppressed = raw.isSuppressed;
    }

    return result;
  }
}

export class ListContactsQueryDto {
  static parse(query: Record<string, string | undefined>): ListContactsOptions {
    const options: ListContactsOptions = {};

    if (query.isSuppressed !== undefined) {
      const lower = query.isSuppressed.toLowerCase().trim();
      if (lower === 'true' || lower === '1') {
        options.isSuppressed = true;
      } else if (lower === 'false' || lower === '0') {
        options.isSuppressed = false;
      }
    }

    if (query.take !== undefined) {
      const parsed = parseInt(query.take, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        options.take = Math.min(parsed, 100);
      }
    }

    if (query.skip !== undefined) {
      const parsed = parseInt(query.skip, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        options.skip = parsed;
      }
    }

    if (query.tagId && typeof query.tagId === 'string' && query.tagId.trim().length > 0) {
      options.tagId = query.tagId.trim();
    }

    if (query.searchPhone && typeof query.searchPhone === 'string' && query.searchPhone.trim().length > 0) {
      options.searchPhone = query.searchPhone.trim();
    }

    return options;
  }
}

export class CreateTagDto {
  static readonly ALLOWED_KEYS = ['name', 'color', 'description', 'id'] as const;

  static parse(body: unknown): CreateTagInput {
    const raw = assertNoUnknownFields(body, CreateTagDto.ALLOWED_KEYS);

    if (!raw.name || typeof raw.name !== 'string' || raw.name.trim().length === 0) {
      throw new BadRequestException('Tag name is required and must be a non-empty string.');
    }

    let color: string | undefined = undefined;
    if (raw.color !== undefined && raw.color !== null) {
      if (typeof raw.color !== 'string') {
        throw new BadRequestException('color must be a string.');
      }
      color = raw.color.trim();
    }

    let description: string | undefined = undefined;
    if (raw.description !== undefined && raw.description !== null) {
      if (typeof raw.description !== 'string') {
        throw new BadRequestException('description must be a string.');
      }
      description = raw.description.trim();
    }

    let id: string | undefined = undefined;
    if (raw.id !== undefined && raw.id !== null) {
      if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
        throw new BadRequestException('id must be a non-empty string.');
      }
      id = raw.id.trim();
    }

    return {
      id,
      name: raw.name.trim(),
      color,
      description,
    };
  }
}

export class AddTagToContactDto {
  static readonly ALLOWED_KEYS = ['tagId'] as const;

  static parse(body: unknown): { tagId: string } {
    const raw = assertNoUnknownFields(body, AddTagToContactDto.ALLOWED_KEYS);

    if (!raw.tagId || typeof raw.tagId !== 'string' || raw.tagId.trim().length === 0) {
      throw new BadRequestException('tagId is required and must be a non-empty string.');
    }

    return { tagId: raw.tagId.trim() };
  }
}

export class AddSuppressionDto {
  static readonly ALLOWED_KEYS = ['phone', 'phoneNormalized', 'reason', 'source', 'id'] as const;

  static parse(body: unknown): AddSuppressionInput {
    const raw = assertNoUnknownFields(body, AddSuppressionDto.ALLOWED_KEYS);

    const rawPhone = (raw.phone ?? raw.phoneNormalized) as string | undefined;
    if (!rawPhone || typeof rawPhone !== 'string' || rawPhone.trim().length === 0) {
      throw new BadRequestException('phone is required for suppression.');
    }

    const normResult = normalizeIranianMobile(rawPhone);
    if (!normResult.success) {
      throw new BadRequestException(`Invalid phone number: ${normResult.message}`);
    }

    let reason: string | undefined = undefined;
    if (raw.reason !== undefined && raw.reason !== null) {
      if (typeof raw.reason !== 'string') {
        throw new BadRequestException('reason must be a string.');
      }
      reason = raw.reason.trim();
    }

    let source: string | undefined = undefined;
    if (raw.source !== undefined && raw.source !== null) {
      if (typeof raw.source !== 'string') {
        throw new BadRequestException('source must be a string.');
      }
      source = raw.source.trim();
    }

    let id: string | undefined = undefined;
    if (raw.id !== undefined && raw.id !== null) {
      if (typeof raw.id !== 'string' || raw.id.trim().length === 0) {
        throw new BadRequestException('id must be a non-empty string.');
      }
      id = raw.id.trim();
    }

    return {
      id,
      phoneNormalized: normResult.normalized,
      reason,
      source,
    };
  }
}
