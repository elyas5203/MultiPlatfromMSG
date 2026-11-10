import { normalizeIranianMobile } from './phone-normalizer';
import { ImportOptions } from './types';

const PHONE_HEADER_PATTERNS = new Set([
  'شماره',
  'شمارهتماس',
  'شمارههمراه',
  'شمارهتلفن',
  'شمارهموبایل',
  'موبایل',
  'همراه',
  'تلفن',
  'تلفنهمراه',
  'phone',
  'phonenumber',
  'mobile',
  'mobilenumber',
  'cell',
  'cellphone',
  'telephone',
  'contactnumber',
  'tel',
]);

const FULL_NAME_HEADER_PATTERNS = new Set([
  'نامونامخانوادگی',
  'نامکامل',
  'اسم',
  'name',
  'fullname',
  'contactname',
]);

const FIRST_NAME_HEADER_PATTERNS = new Set([
  'نامکوچک',
  'firstname',
  'first',
  'fname',
]);

const LAST_NAME_HEADER_PATTERNS = new Set([
  'نامخانوادگی',
  'فامیلی',
  'فامیل',
  'شهرت',
  'lastname',
  'last',
  'lname',
  'family',
]);

function normalizeHeaderString(text: string): string {
  if (!text) return '';
  return text
    .trim()
    .toLowerCase()
    .replace(/[ي]/g, 'ی')
    .replace(/[ك]/g, 'ک')
    .replace(/[\s\-_]+/g, '');
}

export interface ColumnMapping {
  isHeaderRow: boolean;
  phoneIndex: number;
  nameIndex?: number;
  firstNameIndex?: number;
  lastNameIndex?: number;
  headers?: string[];
}

/**
 * Detects column layout from the first row and determines whether the first row is a header.
 */
export function detectColumnMapping(firstRow: string[], options?: ImportOptions): ColumnMapping {
  if (!firstRow || firstRow.length === 0) {
    return {
      isHeaderRow: false,
      phoneIndex: 0,
    };
  }

  // If options explicitly specify hasHeader:
  if (options?.hasHeader === true) {
    return mapHeaders(firstRow, true, options);
  }
  if (options?.hasHeader === false) {
    return mapNonHeader(firstRow, options);
  }

  // Auto-detection:
  // 1. Check if any column directly matches a known phone header pattern
  let hasPhoneHeader = false;
  let hasAnyHeader = false;

  for (const cell of firstRow) {
    const norm = normalizeHeaderString(cell);
    if (PHONE_HEADER_PATTERNS.has(norm)) {
      hasPhoneHeader = true;
      hasAnyHeader = true;
      break;
    }
    if (
      FULL_NAME_HEADER_PATTERNS.has(norm) ||
      FIRST_NAME_HEADER_PATTERNS.has(norm) ||
      LAST_NAME_HEADER_PATTERNS.has(norm) ||
      norm === 'نام'
    ) {
      hasAnyHeader = true;
    }
  }

  if (hasPhoneHeader || hasAnyHeader) {
    // Also verify whether the candidate phone cell is actually a phone number instead of a header name
    const candidatePhoneNorm = normalizeIranianMobile(firstRow[0]);
    if (!hasPhoneHeader && candidatePhoneNorm.success) {
      // First column is a valid phone number, treat as data row
      return mapNonHeader(firstRow, options);
    }
    return mapHeaders(firstRow, true, options);
  }

  // 2. Check if first row contains valid phone numbers in any cell
  for (let i = 0; i < firstRow.length; i++) {
    const result = normalizeIranianMobile(firstRow[i]);
    if (result.success) {
      // It's a data row!
      return {
        isHeaderRow: false,
        phoneIndex: typeof options?.phoneColumn === 'number' ? options.phoneColumn : i,
      };
    }
  }

  // 3. Fallback: If single column or non-phone strings without matching headers
  return mapNonHeader(firstRow, options);
}

function mapNonHeader(firstRow: string[], options?: ImportOptions): ColumnMapping {
  let phoneIndex = 0;
  if (typeof options?.phoneColumn === 'number') {
    phoneIndex = options.phoneColumn;
  }
  return {
    isHeaderRow: false,
    phoneIndex,
    nameIndex: typeof options?.nameColumn === 'number' ? options.nameColumn : undefined,
    firstNameIndex: typeof options?.firstNameColumn === 'number' ? options.firstNameColumn : undefined,
    lastNameIndex: typeof options?.lastNameColumn === 'number' ? options.lastNameColumn : undefined,
  };
}

function mapHeaders(firstRow: string[], isHeaderRow: boolean, options?: ImportOptions): ColumnMapping {
  const headers = firstRow.map((h) => h.trim());
  let phoneIndex = -1;
  let nameIndex: number | undefined;
  let firstNameIndex: number | undefined;
  let lastNameIndex: number | undefined;

  // If explicit column options are provided by name:
  if (typeof options?.phoneColumn === 'string') {
    const idx = headers.findIndex((h) => normalizeHeaderString(h) === normalizeHeaderString(options.phoneColumn as string));
    if (idx !== -1) phoneIndex = idx;
  } else if (typeof options?.phoneColumn === 'number') {
    phoneIndex = options.phoneColumn;
  }

  if (typeof options?.nameColumn === 'string') {
    const idx = headers.findIndex((h) => normalizeHeaderString(h) === normalizeHeaderString(options.nameColumn as string));
    if (idx !== -1) nameIndex = idx;
  } else if (typeof options?.nameColumn === 'number') {
    nameIndex = options.nameColumn;
  }

  if (typeof options?.firstNameColumn === 'string') {
    const idx = headers.findIndex((h) => normalizeHeaderString(h) === normalizeHeaderString(options.firstNameColumn as string));
    if (idx !== -1) firstNameIndex = idx;
  } else if (typeof options?.firstNameColumn === 'number') {
    firstNameIndex = options.firstNameColumn;
  }

  if (typeof options?.lastNameColumn === 'string') {
    const idx = headers.findIndex((h) => normalizeHeaderString(h) === normalizeHeaderString(options.lastNameColumn as string));
    if (idx !== -1) lastNameIndex = idx;
  } else if (typeof options?.lastNameColumn === 'number') {
    lastNameIndex = options.lastNameColumn;
  }

  // Automatic match for headers if not explicitly specified
  for (let i = 0; i < headers.length; i++) {
    const norm = normalizeHeaderString(headers[i]);

    if (phoneIndex === -1 && PHONE_HEADER_PATTERNS.has(norm)) {
      phoneIndex = i;
      continue;
    }

    if (lastNameIndex === undefined && LAST_NAME_HEADER_PATTERNS.has(norm)) {
      lastNameIndex = i;
      continue;
    }

    if (firstNameIndex === undefined && FIRST_NAME_HEADER_PATTERNS.has(norm)) {
      firstNameIndex = i;
      continue;
    }

    if (FULL_NAME_HEADER_PATTERNS.has(norm)) {
      if (nameIndex === undefined) nameIndex = i;
      continue;
    }

    // Persian "نام" can mean full name if no separate last name, or first name if last name exists
    if (norm === 'نام') {
      const hasLastNameCol = headers.some((h) => LAST_NAME_HEADER_PATTERNS.has(normalizeHeaderString(h)));
      if (hasLastNameCol) {
        if (firstNameIndex === undefined) firstNameIndex = i;
      } else {
        if (nameIndex === undefined) nameIndex = i;
      }
    }
  }

  // If phone column wasn't detected by header name, default to 0
  if (phoneIndex === -1) {
    phoneIndex = 0;
  }

  return {
    isHeaderRow,
    phoneIndex,
    nameIndex,
    firstNameIndex,
    lastNameIndex,
    headers,
  };
}
