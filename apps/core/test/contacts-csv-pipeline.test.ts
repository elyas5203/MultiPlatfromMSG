import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import {
  ContactsCsvPipelineService,
  IContactsRepository,
  PipelineOptions,
  PipelineReport,
  maskPhoneNumber,
} from '../src/contacts-import';
import {
  Contact,
  Tag,
  ContactTag,
  SuppressionEntry,
  CreateContactInput,
  CreateTagInput,
} from '../src/contacts/types';
import {
  TenantScopeMissingError,
  TenantScopeInvalidError,
} from '../src/tenant/tenant-scope';

/**
 * In-memory test implementation of IContactsRepository.
 * Provides isolated, deterministic storage for pipeline unit tests.
 */
class InMemoryContactsRepository implements IContactsRepository {
  public contacts: Contact[] = [];
  public tags: Tag[] = [];
  public contactTags: ContactTag[] = [];
  public suppressions: SuppressionEntry[] = [];

  async createContact(tenantId: unknown, input: CreateContactInput): Promise<Contact> {
    const contact: Contact = {
      id: input.id ?? `contact_${this.contacts.length + 1}`,
      tenantId: String(tenantId),
      phoneNormalized: input.phoneNormalized,
      phoneRaw: input.phoneRaw ?? null,
      firstName: input.firstName ?? null,
      lastName: input.lastName ?? null,
      attributes: (input.attributes as any) ?? null,
      isSuppressed: input.isSuppressed ?? false,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.contacts.push(contact);
    return contact;
  }

  async findContactByPhone(tenantId: unknown, phoneNormalized: string): Promise<Contact | null> {
    const found = this.contacts.find(
      (c) => c.tenantId === String(tenantId) && c.phoneNormalized === phoneNormalized,
    );
    return found ?? null;
  }

  async isSuppressed(tenantId: unknown, phoneNormalized: string): Promise<boolean> {
    const found = this.suppressions.find(
      (s) => s.tenantId === String(tenantId) && s.phoneNormalized === phoneNormalized,
    );
    return found !== undefined;
  }

  async findTagByName(tenantId: unknown, name: string): Promise<Tag | null> {
    const found = this.tags.find((t) => t.tenantId === String(tenantId) && t.name === name);
    return found ?? null;
  }

  async findTagById(tenantId: unknown, tagId: string): Promise<Tag | null> {
    const found = this.tags.find((t) => t.tenantId === String(tenantId) && t.id === tagId);
    return found ?? null;
  }

  async createTag(tenantId: unknown, input: CreateTagInput): Promise<Tag> {
    const tag: Tag = {
      id: input.id ?? `tag_${this.tags.length + 1}`,
      tenantId: String(tenantId),
      name: input.name,
      color: input.color ?? null,
      description: input.description ?? null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    this.tags.push(tag);
    return tag;
  }

  async addTagToContact(tenantId: unknown, contactId: string, tagId: string): Promise<ContactTag> {
    const contactTag: ContactTag = {
      id: `ct_${this.contactTags.length + 1}`,
      tenantId: String(tenantId),
      contactId,
      tagId,
      createdAt: new Date(),
    };
    this.contactTags.push(contactTag);
    return contactTag;
  }
}

describe('Contacts CSV Import Pipeline Service (TASK-0025)', () => {
  const TENANT_ID = 'org_test_pipeline';

  describe('AC-01: Streaming import, tenant_id enforcement, batching', () => {
    it('successfully imports contacts from a CSV stream with default batch size', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      const csvData = [
        'phone,first_name,last_name,city',
        '09121111111,Ali,Alavi,Tehran',
        '09122222222,Sara,Saravi,Shiraz',
        '09123333333,Reza,Razavi,Isfahan',
      ].join('\n');

      const stream = Readable.from([csvData]);

      const report = await service.importStreamIntoRepository(stream, {
        tenantId: TENANT_ID,
      });

      assert.equal(report.tenantId, TENANT_ID);
      assert.equal(report.totalRows, 3);
      assert.equal(report.processedRows, 3);
      assert.equal(report.importedCount, 3);
      assert.equal(report.duplicateSkippedCount, 0);
      assert.equal(report.suppressedCount, 0);
      assert.equal(report.invalidCount, 0);
      assert.equal(report.errors.length, 0);
      assert.equal(repo.contacts.length, 3);

      const contact1 = repo.contacts.find((c) => c.phoneNormalized === '+989121111111');
      assert.ok(contact1);
      assert.equal(contact1.tenantId, TENANT_ID);
      assert.equal(contact1.firstName, 'Ali');
      assert.equal(contact1.lastName, 'Alavi');
      assert.deepEqual(contact1.attributes, { city: 'Tehran' });
    });

    it('rejects missing or empty tenant_id with TenantScopeMissingError', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);
      const csv = 'phone\n09121111111\n';

      await assert.rejects(
        () => service.importStreamIntoRepository(csv, { tenantId: '' }),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      await assert.rejects(
        () => service.importStreamIntoRepository(csv, { tenantId: null as any }),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      await assert.rejects(
        () => service.importStreamIntoRepository(csv, { tenantId: '   ' }),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );
    });

    it('rejects illegal characters in tenant_id with TenantScopeInvalidError', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);
      const csv = 'phone\n09121111111\n';

      await assert.rejects(
        () => service.importStreamIntoRepository(csv, { tenantId: 'invalid tenant id with spaces' }),
        (err: unknown) => err instanceof TenantScopeInvalidError,
      );

      await assert.rejects(
        () => service.importStreamIntoRepository(csv, { tenantId: 'tenant;DROP TABLE;' }),
        (err: unknown) => err instanceof TenantScopeInvalidError,
      );
    });

    it('batches insertion in chunks and invokes onBatchProgress callback correctly', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      // Generate 7 rows with batchSize = 3 (expecting 3 batches: 3, 3, 1)
      const rows = ['phone,name'];
      for (let i = 1; i <= 7; i++) {
        rows.push(`0912000000${i},User ${i}`);
      }
      const csv = rows.join('\n');

      const batchProgressCalls: any[] = [];

      const report = await service.importStreamIntoRepository(csv, {
        tenantId: TENANT_ID,
        batchSize: 3,
        onBatchProgress: (progress) => {
          batchProgressCalls.push({ ...progress });
        },
      });

      assert.equal(report.importedCount, 7);
      assert.equal(batchProgressCalls.length, 3);
      assert.deepEqual(batchProgressCalls, [
        { processedRows: 3, importedCount: 3, batchIndex: 1 },
        { processedRows: 6, importedCount: 6, batchIndex: 2 },
        { processedRows: 7, importedCount: 7, batchIndex: 3 },
      ]);
    });

    it('handles stream of 2,000 rows efficiently without memory leak or buffer backlog', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      // Async generator to stream chunks without holding massive string in memory
      async function* generateMassiveCsv() {
        yield 'phone,name\n';
        for (let i = 1000; i < 3000; i++) {
          yield `0912000${i},Contact ${i}\n`;
        }
      }

      const report = await service.importStreamIntoRepository(generateMassiveCsv(), {
        tenantId: TENANT_ID,
        batchSize: 500,
      });

      assert.equal(report.totalRows, 2000);
      assert.equal(report.importedCount, 2000);
      assert.equal(report.invalidCount, 0);
      assert.equal(repo.contacts.length, 2000);
    });
  });

  describe('AC-02: Suppression (Opt-out / Blacklist) checking and policies', () => {
    it('skips suppressed numbers and logs structured error with masked phone when policy is SKIP (default)', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      // Pre-seed suppression entry for 09122222222 (+989122222222)
      repo.suppressions.push({
        id: 'supp_1',
        tenantId: TENANT_ID,
        phoneNormalized: '+989122222222',
        reason: 'Customer opted out via SMS STOP',
        source: 'SMS_GATEWAY',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const csv = [
        'phone,name',
        '09121111111,Active User 1',
        '09122222222,Suppressed User',
        '09123333333,Active User 2',
      ].join('\n');

      const report = await service.importStreamIntoRepository(csv, {
        tenantId: TENANT_ID,
        suppressionPolicy: 'SKIP',
      });

      assert.equal(report.totalRows, 3);
      assert.equal(report.importedCount, 2);
      assert.equal(report.suppressedCount, 1);
      assert.equal(report.errors.length, 1);
      assert.equal(report.errors[0].reasonCode, 'SUPPRESSED_PHONE');
      assert.equal(report.errors[0].maskedPhone, maskPhoneNumber('+989122222222'));

      // Ensure suppressed contact was NOT created in repository
      const createdPhones = repo.contacts.map((c) => c.phoneNormalized);
      assert.deepEqual(createdPhones, ['+989121111111', '+989123333333']);
    });

    it('imports suppressed numbers with isSuppressed=true when policy is IMPORT_AS_SUPPRESSED', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      repo.suppressions.push({
        id: 'supp_1',
        tenantId: TENANT_ID,
        phoneNormalized: '+989122222222',
        reason: 'Legal compliance hold',
        source: 'ADMIN',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const csv = [
        'phone,name',
        '09121111111,Active User',
        '09122222222,Suppressed User',
      ].join('\n');

      const report = await service.importStreamIntoRepository(csv, {
        tenantId: TENANT_ID,
        suppressionPolicy: 'IMPORT_AS_SUPPRESSED',
      });

      assert.equal(report.totalRows, 2);
      assert.equal(report.importedCount, 2);
      assert.equal(report.suppressedCount, 1);
      assert.equal(repo.contacts.length, 2);

      const activeContact = repo.contacts.find((c) => c.phoneNormalized === '+989121111111');
      assert.equal(activeContact?.isSuppressed, false);

      const suppressedContact = repo.contacts.find((c) => c.phoneNormalized === '+989122222222');
      assert.equal(suppressedContact?.isSuppressed, true);
    });

    it('isolates suppression list strictly by tenant', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      // Number is suppressed in OTHER tenant, but NOT in TENANT_ID
      repo.suppressions.push({
        id: 'supp_other',
        tenantId: 'other_tenant',
        phoneNormalized: '+989121111111',
        reason: 'Other tenant unsubscribe',
        source: 'PORTAL',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const csv = 'phone,name\n09121111111,User In Current Tenant\n';

      const report = await service.importStreamIntoRepository(csv, {
        tenantId: TENANT_ID,
        suppressionPolicy: 'SKIP',
      });

      assert.equal(report.importedCount, 1);
      assert.equal(report.suppressedCount, 0);
      assert.equal(repo.contacts[0].isSuppressed, false);
    });
  });

  describe('AC-03: Structured reporting and privacy (no phone leakage)', () => {
    it('accurately categorizes duplicates, invalid rows, and suppressed rows in the report', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      // Pre-seed an existing contact in DB to test DB-level duplication
      repo.contacts.push({
        id: 'existing_c1',
        tenantId: TENANT_ID,
        phoneNormalized: '+989120000001',
        phoneRaw: '09120000001',
        firstName: 'Old',
        lastName: 'Contact',
        attributes: null,
        isSuppressed: false,
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      // Pre-seed a suppressed phone
      repo.suppressions.push({
        id: 'supp_99',
        tenantId: TENANT_ID,
        phoneNormalized: '+989120000002',
        reason: 'Unsubscribed',
        source: 'WEB',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const csv = [
        'phone,name',
        '09120000001,Existing Contact in DB', // DB Duplicate
        '09120000002,Suppressed User',       // Suppressed
        '09129999999,Valid Fresh Contact',   // Valid
        '09129999999,Repeated in same CSV',  // In-file duplicate
        'invalid_phone_number,Invalid Format', // Invalid phone
        '02188888888,Landline Not Mobile',     // Non-mobile Iranian phone
      ].join('\n');

      const report = await service.importStreamIntoRepository(csv, {
        tenantId: TENANT_ID,
        suppressionPolicy: 'SKIP',
      });

      assert.equal(report.totalRows, 6);
      assert.equal(report.importedCount, 1); // only 09129999999
      assert.equal(report.duplicateSkippedCount, 2); // 1 DB duplicate + 1 in-file duplicate
      assert.equal(report.suppressedCount, 1);
      assert.equal(report.invalidCount, 2); // invalid_phone_number + landline
      assert.equal(report.errors.length, 5); // 2 duplicates + 1 suppressed + 2 invalid

      // Verify mathematical balance: imported + duplicateSkipped + suppressed + invalid === totalRows
      assert.equal(
        report.importedCount + report.duplicateSkippedCount + report.suppressedCount + report.invalidCount,
        report.totalRows,
      );
    });

    it('strictly guarantees NO unmasked phone numbers appear in reports or error messages', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      const secretRawPhone = '09129876543';
      const secretNormalizedPhone = '+989129876543';

      const csv = [
        'phone,name',
        `${secretRawPhone},User 1`,
        `${secretRawPhone},Duplicate User`,
      ].join('\n');

      const report = await service.importStreamIntoRepository(csv, {
        tenantId: TENANT_ID,
      });

      const reportSerialized = JSON.stringify(report);

      // Verify that raw and normalized phone numbers never appear in error messages or report
      assert.equal(reportSerialized.includes(secretRawPhone), false);
      assert.equal(reportSerialized.includes(secretNormalizedPhone), false);

      // Verify that masked phone numbers ARE present
      const expectedMask = maskPhoneNumber(secretNormalizedPhone);
      assert.equal(reportSerialized.includes(expectedMask), true);
    });

    it('attaches default tag to all imported contacts when defaultTagName is specified', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      const csv = [
        'phone,name',
        '09121111111,User A',
        '09122222222,User B',
      ].join('\n');

      const report = await service.importStreamIntoRepository(csv, {
        tenantId: TENANT_ID,
        defaultTagName: 'Spring Campaign 2026',
      });

      assert.equal(report.importedCount, 2);
      assert.ok(report.tagApplied);
      assert.equal(report.tagApplied.name, 'Spring Campaign 2026');

      // Check tag was created
      assert.equal(repo.tags.length, 1);
      assert.equal(repo.tags[0].name, 'Spring Campaign 2026');

      // Check both contacts received the tag
      assert.equal(repo.contactTags.length, 2);
      assert.equal(repo.contactTags[0].tagId, repo.tags[0].id);
      assert.equal(repo.contactTags[1].tagId, repo.tags[0].id);
    });

    it('reuses existing tag when defaultTagId is specified', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      const existingTag = await repo.createTag(TENANT_ID, {
        id: 'tag_existing_vip',
        name: 'VIP Customers',
      });

      const csv = 'phone,name\n09121111111,VIP 1\n';

      const report = await service.importStreamIntoRepository(csv, {
        tenantId: TENANT_ID,
        defaultTagId: existingTag.id,
      });

      assert.equal(report.importedCount, 1);
      assert.equal(report.tagApplied?.id, 'tag_existing_vip');
      assert.equal(repo.contactTags.length, 1);
      assert.equal(repo.contactTags[0].tagId, 'tag_existing_vip');
    });

    it('respects maxRows and stopOnMaxRows limits', async () => {
      const repo = new InMemoryContactsRepository();
      const service = new ContactsCsvPipelineService(repo as any);

      const csv = [
        'phone,name',
        '09120000001,User 1',
        '09120000002,User 2',
        '09120000003,User 3',
        '09120000004,User 4',
      ].join('\n');

      const report = await service.importStreamIntoRepository(csv, {
        tenantId: TENANT_ID,
        maxRows: 2,
        stopOnMaxRows: true,
      });

      assert.equal(report.importedCount, 2);
      assert.equal(repo.contacts.length, 2);
    });
  });
});
