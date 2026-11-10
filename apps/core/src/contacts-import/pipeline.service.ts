/**
 * Contacts CSV Import Pipeline Service
 *
 * Implements AC-01, AC-02, AC-03 for TASK-0025:
 * - High-throughput streaming import from CSV into ContactsRepository.
 * - Strict tenant boundary enforcement (assertValidTenantId).
 * - Configurable batch processing (default batchSize: 1000).
 * - Real-time suppression / opt-out checking with configurable policies (SKIP or IMPORT_AS_SUPPRESSED).
 * - Optional default organization tag resolution and attachment.
 * - Comprehensive structured report without exposing full phone numbers in logs.
 */

import { Injectable, Logger, Optional } from '@nestjs/common';
import { ContactsRepository } from '../contacts/contacts.repository';
import { Tag } from '../contacts/types';
import { assertValidTenantId } from '../tenant/tenant-scope';
import { importContactsStream } from './contacts-importer';
import { maskPhoneNumber } from './phone-normalizer';
import { RejectionReasonCode, ImportRow } from './types';

export type SuppressionPolicy = 'SKIP' | 'IMPORT_AS_SUPPRESSED';

export interface PipelineErrorDetail {
  readonly rowNumber: number;
  readonly reasonCode: string;
  readonly message: string;
  readonly maskedPhone?: string;
}

export interface BatchProgressInfo {
  readonly processedRows: number;
  readonly importedCount: number;
  readonly batchIndex: number;
}

export interface PipelineOptions {
  /**
   * Mandatory tenant ID for multi-tenant data isolation.
   */
  readonly tenantId: string;

  /**
   * Batch size for streaming chunks. Defaults to 1000.
   */
  readonly batchSize?: number;

  /**
   * Custom CSV delimiter (',' | ';' | '\t', etc.).
   */
  readonly delimiter?: string;

  /**
   * Whether the CSV has a header row. If undefined, auto-detected.
   */
  readonly hasHeader?: boolean;

  /**
   * Explicit 0-indexed column or column name for phone number.
   */
  readonly phoneColumn?: string | number;

  /**
   * Explicit 0-indexed column or column name for full name.
   */
  readonly nameColumn?: string | number;

  /**
   * Explicit 0-indexed column or column name for first name.
   */
  readonly firstNameColumn?: string | number;

  /**
   * Explicit 0-indexed column or column name for last name.
   */
  readonly lastNameColumn?: string | number;

  /**
   * Maximum data rows to process before stopping or rejecting.
   */
  readonly maxRows?: number;

  /**
   * Stop processing immediately when maxRows is reached. Defaults to false.
   */
  readonly stopOnMaxRows?: boolean;

  /**
   * Policy for handling numbers found in suppression_entries.
   * 'SKIP': (default) Do not insert contact, count as suppressed, add to report.
   * 'IMPORT_AS_SUPPRESSED': Insert contact with isSuppressed=true, count as suppressed and imported.
   */
  readonly suppressionPolicy?: SuppressionPolicy;

  /**
   * Optional tag name to create/find and attach to all imported contacts.
   */
  readonly defaultTagName?: string;

  /**
   * Optional existing tag ID to attach to all imported contacts.
   */
  readonly defaultTagId?: string;

  /**
   * Optional progress callback invoked after each batch is processed.
   */
  readonly onBatchProgress?: (progress: BatchProgressInfo) => void | Promise<void>;
}

export interface PipelineReport {
  readonly tenantId: string;
  readonly totalRows: number;
  readonly processedRows: number;
  readonly importedCount: number;
  readonly duplicateSkippedCount: number;
  readonly suppressedCount: number;
  readonly invalidCount: number;
  readonly errors: readonly PipelineErrorDetail[];
  readonly durationMs: number;
  readonly tagApplied?: {
    readonly id: string;
    readonly name: string;
  } | null;
}

/**
 * Minimal structural interface for ContactsRepository to facilitate unit testing
 * with in-memory or stubbed implementations.
 */
export type IContactsRepository = Pick<
  ContactsRepository,
  | 'createContact'
  | 'findContactByPhone'
  | 'isSuppressed'
  | 'findTagByName'
  | 'findTagById'
  | 'createTag'
  | 'addTagToContact'
>;

@Injectable()
export class ContactsCsvPipelineService {
  private readonly logger = new Logger(ContactsCsvPipelineService.name);

  constructor(@Optional() private readonly defaultRepo?: ContactsRepository) {}

  /**
   * Streams and imports CSV contacts into ContactsRepository with batching,
   * tenant validation, suppression checking, and tag assignment.
   *
   * AC-01: Streaming import, mandatory tenant_id, configurable batching, memory efficiency.
   * AC-02: Real-time suppression handling according to configured policy.
   * AC-03: Structured report without phone number exposure in logs.
   */
  public async importStreamIntoRepository(
    input: string | Buffer | NodeJS.ReadableStream | AsyncIterable<string | Buffer>,
    options: PipelineOptions,
    customRepo?: IContactsRepository,
  ): Promise<PipelineReport> {
    const startTime = Date.now();

    // AC-01: Mandatory tenant ID validation
    const validTenantId = assertValidTenantId(options.tenantId);

    const repo = customRepo ?? this.defaultRepo;
    if (!repo) {
      throw new Error('ContactsRepository is required but was not provided via DI or arguments.');
    }

    const batchSize = options.batchSize ?? 1000;
    if (batchSize <= 0 || !Number.isInteger(batchSize)) {
      throw new Error(`Invalid batchSize: ${batchSize}. Must be a positive integer.`);
    }

    const suppressionPolicy: SuppressionPolicy = options.suppressionPolicy ?? 'SKIP';

    // Resolve default tag if configured
    let resolvedTag: Tag | null = null;
    if (options.defaultTagId) {
      resolvedTag = await repo.findTagById(validTenantId, options.defaultTagId);
      if (!resolvedTag) {
        throw new Error(`Default tag ID '${options.defaultTagId}' not found within tenant scope.`);
      }
    } else if (options.defaultTagName && options.defaultTagName.trim().length > 0) {
      const tagName = options.defaultTagName.trim();
      const existingTag = await repo.findTagByName(validTenantId, tagName);
      if (existingTag) {
        resolvedTag = existingTag;
      } else {
        resolvedTag = await repo.createTag(validTenantId, { name: tagName });
      }
    }

    let processedRows = 0;
    let importedCount = 0;
    let duplicateSkippedCount = 0;
    let suppressedCount = 0;
    let invalidCount = 0;
    const errors: PipelineErrorDetail[] = [];

    let currentBatch: ImportRow[] = [];
    let batchIndex = 0;

    /**
     * Flushes and processes a single batch of valid CSV rows.
     */
    const processBatch = async (batch: ImportRow[]): Promise<void> => {
      if (batch.length === 0) return;
      batchIndex++;

      for (const row of batch) {
        try {
          // AC-02: Check suppression
          const isSuppressed = await repo.isSuppressed(validTenantId, row.normalizedPhone);

          if (isSuppressed) {
            suppressedCount++;
            if (suppressionPolicy === 'SKIP') {
              errors.push({
                rowNumber: row.rowNumber,
                reasonCode: 'SUPPRESSED_PHONE',
                message: 'Phone number is in tenant suppression list (opted out).',
                maskedPhone: maskPhoneNumber(row.normalizedPhone),
              });
              continue;
            }
          }

          // Check DB-level duplicate
          const existing = await repo.findContactByPhone(validTenantId, row.normalizedPhone);
          if (existing) {
            duplicateSkippedCount++;
            errors.push({
              rowNumber: row.rowNumber,
              reasonCode: RejectionReasonCode.DUPLICATE_PHONE,
              message: 'Contact already exists in database for this tenant.',
              maskedPhone: maskPhoneNumber(row.normalizedPhone),
            });
            continue;
          }

          // Compute first and last names
          let firstName = row.firstName;
          let lastName = row.lastName;
          if (!firstName && !lastName && row.name) {
            const parts = row.name.split(/\s+/).filter(Boolean);
            if (parts.length > 0) {
              firstName = parts[0];
              if (parts.length > 1) {
                lastName = parts.slice(1).join(' ');
              }
            }
          }

          // Create contact
          const contact = await repo.createContact(validTenantId, {
            phoneNormalized: row.normalizedPhone,
            phoneRaw: row.rawPhone,
            firstName: firstName ?? undefined,
            lastName: lastName ?? undefined,
            attributes: row.attributes ?? null,
            isSuppressed: isSuppressed && suppressionPolicy === 'IMPORT_AS_SUPPRESSED',
          });

          // Attach tag if configured
          if (resolvedTag) {
            await repo.addTagToContact(validTenantId, contact.id, resolvedTag.id);
          }

          importedCount++;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Always mask phone numbers in errors to prevent privacy leaks
          errors.push({
            rowNumber: row.rowNumber,
            reasonCode: 'INSERT_ERROR',
            message: `Failed to insert contact: ${errMsg}`,
            maskedPhone: maskPhoneNumber(row.normalizedPhone),
          });
          invalidCount++;
        }
      }

      if (options.onBatchProgress) {
        await options.onBatchProgress({
          processedRows,
          importedCount,
          batchIndex,
        });
      }
    };

    // Iterate through the streaming CSV parser
    for await (const item of importContactsStream(input, {
      delimiter: options.delimiter,
      hasHeader: options.hasHeader,
      phoneColumn: options.phoneColumn,
      nameColumn: options.nameColumn,
      firstNameColumn: options.firstNameColumn,
      lastNameColumn: options.lastNameColumn,
      maxRows: options.maxRows,
      stopOnMaxRows: options.stopOnMaxRows,
    })) {
      processedRows++;

      if (item.type === 'valid') {
        currentBatch.push(item.row);
        if (currentBatch.length >= batchSize) {
          await processBatch(currentBatch);
          currentBatch = []; // Release references for garbage collection
        }
      } else {
        // Rejected at CSV parser level (malformed, non-Iranian mobile, in-file duplicate, etc.)
        if (item.rejection.reasonCode === RejectionReasonCode.DUPLICATE_PHONE) {
          duplicateSkippedCount++;
        } else {
          invalidCount++;
        }

        errors.push({
          rowNumber: item.rejection.rowNumber,
          reasonCode: item.rejection.reasonCode,
          message: item.rejection.message,
          maskedPhone: item.rejection.maskedPhone,
        });
      }
    }

    // Process any remaining rows in the final batch
    if (currentBatch.length > 0) {
      await processBatch(currentBatch);
      currentBatch = [];
    }

    const durationMs = Date.now() - startTime;

    // Log structured progress without exposing full phone numbers
    this.logger.log(
      `CSV import pipeline completed for tenant '${validTenantId}' in ${durationMs}ms: ` +
        `totalRows=${processedRows}, imported=${importedCount}, duplicatesSkipped=${duplicateSkippedCount}, ` +
        `suppressed=${suppressedCount}, invalid=${invalidCount}, errorsCount=${errors.length}`,
    );

    return {
      tenantId: validTenantId,
      totalRows: processedRows,
      processedRows,
      importedCount,
      duplicateSkippedCount,
      suppressedCount,
      invalidCount,
      errors: Object.freeze(errors),
      durationMs,
      tagApplied: resolvedTag
        ? {
            id: resolvedTag.id,
            name: resolvedTag.name,
          }
        : null,
    };
  }
}
