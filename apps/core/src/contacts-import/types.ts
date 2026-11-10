export enum RejectionReasonCode {
  EMPTY_PHONE = 'EMPTY_PHONE',
  INVALID_CHARACTERS = 'INVALID_CHARACTERS',
  INVALID_LENGTH = 'INVALID_LENGTH',
  NOT_IRANIAN_MOBILE = 'NOT_IRANIAN_MOBILE',
  DUPLICATE_PHONE = 'DUPLICATE_PHONE',
  MAX_ROWS_EXCEEDED = 'MAX_ROWS_EXCEEDED',
  NO_PHONE_COLUMN = 'NO_PHONE_COLUMN',
  MALFORMED_ROW = 'MALFORMED_ROW',
}

export interface ImportRow {
  rowNumber: number;
  rawPhone: string;
  normalizedPhone: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  attributes?: Record<string, string>;
}

export interface RejectedRow {
  rowNumber: number;
  reasonCode: RejectionReasonCode;
  message: string;
  maskedPhone?: string;
}

export interface ImportSummary {
  totalRows: number;
  validCount: number;
  duplicateCount: number;
  invalidCount: number;
}

export interface ImportResult {
  validRows: ImportRow[];
  rejectedRows: RejectedRow[];
  summary: ImportSummary;
}

export interface ImportOptions {
  delimiter?: ',' | ';' | string;
  maxRows?: number;
  hasHeader?: boolean;
  phoneColumn?: string | number;
  nameColumn?: string | number;
  firstNameColumn?: string | number;
  lastNameColumn?: string | number;
  stopOnMaxRows?: boolean;
}

export interface CsvParserOptions {
  delimiter?: string;
  skipEmptyLines?: boolean;
}

export type StreamImportItem =
  | { type: 'valid'; row: ImportRow }
  | { type: 'rejected'; rejection: RejectedRow };
