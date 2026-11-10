import { detectColumnMapping, ColumnMapping } from './column-detector';
import { parseCsvStream } from './csv-parser';
import { normalizeIranianMobile, maskPhoneNumber } from './phone-normalizer';
import {
  ImportOptions,
  ImportResult,
  ImportRow,
  ImportSummary,
  RejectedRow,
  RejectionReasonCode,
  StreamImportItem,
} from './types';

/**
 * Streaming generator that processes contacts row-by-row from a CSV input.
 * Does not accumulate raw rows or excess objects in memory.
 */
export async function* importContactsStream(
  input: string | Buffer | NodeJS.ReadableStream | AsyncIterable<string | Buffer>,
  options?: ImportOptions
): AsyncGenerator<StreamImportItem> {
  const rowIterator = parseCsvStream(input, {
    delimiter: options?.delimiter,
    skipEmptyLines: true,
  });

  let mapping: ColumnMapping | null = null;
  const seenPhones = new Set<string>();
  let fileLineNumber = 0;
  let totalDataRows = 0;

  for await (const row of rowIterator) {
    fileLineNumber++;

    if (mapping === null) {
      mapping = detectColumnMapping(row, options);
      if (mapping.isHeaderRow) {
        // Skip processing header row as contact data
        continue;
      }
    }

    totalDataRows++;

    // Check maxRows limit if configured
    if (options?.maxRows !== undefined && totalDataRows > options.maxRows) {
      if (options.stopOnMaxRows) {
        break;
      }
      yield {
        type: 'rejected',
        rejection: {
          rowNumber: fileLineNumber,
          reasonCode: RejectionReasonCode.MAX_ROWS_EXCEEDED,
          message: 'Maximum row limit exceeded.',
        },
      };
      continue;
    }

    const rawPhone = row[mapping.phoneIndex]?.trim() ?? '';
    const normResult = normalizeIranianMobile(rawPhone);

    if (!normResult.success) {
      yield {
        type: 'rejected',
        rejection: {
          rowNumber: fileLineNumber,
          reasonCode: normResult.reasonCode,
          message: normResult.message,
          maskedPhone: normResult.maskedPhone,
        },
      };
      continue;
    }

    const normalizedPhone = normResult.normalized;

    // Check duplicate
    if (seenPhones.has(normalizedPhone)) {
      yield {
        type: 'rejected',
        rejection: {
          rowNumber: fileLineNumber,
          reasonCode: RejectionReasonCode.DUPLICATE_PHONE,
          message: `Duplicate phone number: ${maskPhoneNumber(normalizedPhone)}`,
          maskedPhone: maskPhoneNumber(normalizedPhone),
        },
      };
      continue;
    }

    seenPhones.add(normalizedPhone);

    // Extract names and extra attributes
    let name: string | undefined;
    let firstName: string | undefined;
    let lastName: string | undefined;
    let attributes: Record<string, string> | undefined;

    if (mapping.nameIndex !== undefined && row[mapping.nameIndex] !== undefined) {
      const val = row[mapping.nameIndex].trim();
      if (val.length > 0) name = val;
    }

    if (mapping.firstNameIndex !== undefined && row[mapping.firstNameIndex] !== undefined) {
      const val = row[mapping.firstNameIndex].trim();
      if (val.length > 0) firstName = val;
    }

    if (mapping.lastNameIndex !== undefined && row[mapping.lastNameIndex] !== undefined) {
      const val = row[mapping.lastNameIndex].trim();
      if (val.length > 0) lastName = val;
    }

    if (mapping.headers && mapping.headers.length > 0) {
      for (let col = 0; col < row.length; col++) {
        if (
          col !== mapping.phoneIndex &&
          col !== mapping.nameIndex &&
          col !== mapping.firstNameIndex &&
          col !== mapping.lastNameIndex
        ) {
          const colHeader = mapping.headers[col] ?? `col_${col}`;
          const colVal = row[col]?.trim() ?? '';
          if (colVal.length > 0) {
            if (!attributes) attributes = {};
            attributes[colHeader] = colVal;
          }
        }
      }
    }

    const validRow: ImportRow = {
      rowNumber: fileLineNumber,
      rawPhone,
      normalizedPhone,
      ...(name ? { name } : {}),
      ...(firstName ? { firstName } : {}),
      ...(lastName ? { lastName } : {}),
      ...(attributes ? { attributes } : {}),
    };

    yield {
      type: 'valid',
      row: validRow,
    };
  }
}

/**
 * Complete CSV contacts import function.
 * Processes CSV stream and returns validRows, rejectedRows, and counts summary.
 */
export async function importContacts(
  input: string | Buffer | NodeJS.ReadableStream | AsyncIterable<string | Buffer>,
  options?: ImportOptions
): Promise<ImportResult> {
  const validRows: ImportRow[] = [];
  const rejectedRows: RejectedRow[] = [];

  let duplicateCount = 0;
  let invalidCount = 0;

  for await (const item of importContactsStream(input, options)) {
    if (item.type === 'valid') {
      validRows.push(item.row);
    } else {
      rejectedRows.push(item.rejection);
      if (item.rejection.reasonCode === RejectionReasonCode.DUPLICATE_PHONE) {
        duplicateCount++;
      } else {
        invalidCount++;
      }
    }
  }

  const validCount = validRows.length;
  const totalRows = validCount + duplicateCount + invalidCount;

  const summary: ImportSummary = {
    totalRows,
    validCount,
    duplicateCount,
    invalidCount,
  };

  return {
    validRows,
    rejectedRows,
    summary,
  };
}
