import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TenantRepository } from '../src/tenant/tenant.repository';
import { ContactsRepository, ContactNotFoundError, TagNotFoundError } from '../src/contacts/contacts.repository';
import {
  TenantScopeMissingError,
  TenantScopeInvalidError,
} from '../src/tenant/tenant-scope';
import {
  TEST_MARKER_TABLE,
  TEST_MARKER_KEY,
  validateDatabaseUrlSafety,
  validateDatabaseName,
  InsecureDatabaseTargetError,
} from './tenant-db-isolation.test';

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

describe('PostgreSQL Contacts, Tags & Suppression Integration Tests (TASK-0020)', () => {
  let app: any;
  let tenantRepo: TenantRepository;
  let prisma: PrismaService;
  let contactsRepo: ContactsRepository;
  let isTargetVerified = false;

  const RUN_SEED = crypto.randomBytes(4).toString('hex');
  const TENANT_ALPHA = `org_cnt_alpha_${RUN_SEED}`;
  const TENANT_BETA = `org_cnt_beta_${RUN_SEED}`;
  const SLUG_ALPHA = `slug-cnt-alpha-${RUN_SEED}`;
  const SLUG_BETA = `slug-cnt-beta-${RUN_SEED}`;

  before(async () => {
    isTargetVerified = false;

    // 1. Fail-closed target validation
    validateDatabaseUrlSafety(process.env.DATABASE_URL);

    // 2. Initialize Nest Application Context
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    tenantRepo = app.get(TenantRepository);
    prisma = app.get(PrismaService);
    contactsRepo = new ContactsRepository(prisma);

    // 3. Verify database connectivity
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

    // 4. Verify DB name and marker token
    const dbNameRows = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
      'SELECT current_database()',
    );
    validateDatabaseName(dbNameRows[0]?.current_database);

    await assertPreProvisionedTestDatabaseMarker(prisma);
    isTargetVerified = true;

    // Seed test tenants
    await tenantRepo.createTenant({
      id: TENANT_ALPHA,
      name: `Alpha Contacts Corp ${RUN_SEED}`,
      slug: SLUG_ALPHA,
    });

    await tenantRepo.createTenant({
      id: TENANT_BETA,
      name: `Beta Contacts LLC ${RUN_SEED}`,
      slug: SLUG_BETA,
    });
  });

  after(async () => {
    if (!isTargetVerified) {
      if (app) await app.close();
      return;
    }

    try {
      if (contactsRepo) {
        await contactsRepo.clearTenant(TENANT_ALPHA);
        await contactsRepo.clearTenant(TENANT_BETA);
      }
      if (tenantRepo) {
        await tenantRepo.clearTenant(TENANT_ALPHA);
        await tenantRepo.clearTenant(TENANT_BETA);
      }
    } catch {
      // ignore in teardown
    }

    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    if (!isTargetVerified) return;

    await contactsRepo.clearTenant(TENANT_ALPHA);
    await contactsRepo.clearTenant(TENANT_BETA);
  });

  describe('1. Safety Guard & Fail-Closed Checks', () => {
    it('rejects undefined or non-test DATABASE_URL', () => {
      assert.throws(() => validateDatabaseUrlSafety(undefined), InsecureDatabaseTargetError);
      assert.throws(
        () => validateDatabaseUrlSafety('postgresql://user:pass@localhost:5432/production_db'),
        InsecureDatabaseTargetError,
      );
    });

    it('rejects missing or mismatched test marker token', async () => {
      const saved = process.env.TEST_DATABASE_MARKER_TOKEN;
      try {
        delete process.env.TEST_DATABASE_MARKER_TOKEN;
        await assert.rejects(
          assertPreProvisionedTestDatabaseMarker(prisma),
          InsecureDatabaseTargetError,
        );

        process.env.TEST_DATABASE_MARKER_TOKEN = 'wrong-token';
        await assert.rejects(
          assertPreProvisionedTestDatabaseMarker(prisma),
          InsecureDatabaseTargetError,
        );
      } finally {
        process.env.TEST_DATABASE_MARKER_TOKEN = saved;
      }
    });
  });

  describe('2. Multi-Tenancy Boundary & Scope Enforcement (AC-03)', () => {
    it('strictly rejects operations when tenant_id is missing', async () => {
      await assert.rejects(
        contactsRepo.createContact(null, { phoneNormalized: '+989121111111' }),
        TenantScopeMissingError,
      );
      await assert.rejects(
        contactsRepo.createContact(undefined, { phoneNormalized: '+989121111111' }),
        TenantScopeMissingError,
      );
      await assert.rejects(
        contactsRepo.createContact('   ', { phoneNormalized: '+989121111111' }),
        TenantScopeMissingError,
      );
      await assert.rejects(
        contactsRepo.findContactById(null, 'some-id'),
        TenantScopeMissingError,
      );
      await assert.rejects(
        contactsRepo.findContactByPhone(undefined, '+989121111111'),
        TenantScopeMissingError,
      );
      await assert.rejects(
        contactsRepo.listContacts(''),
        TenantScopeMissingError,
      );
      await assert.rejects(
        contactsRepo.countContacts(null),
        TenantScopeMissingError,
      );
    });

    it('strictly rejects operations when tenant_id contains invalid characters or exceeds 64 chars', async () => {
      await assert.rejects(
        contactsRepo.createContact('org with spaces', { phoneNormalized: '+989121111111' }),
        TenantScopeInvalidError,
      );
      await assert.rejects(
        contactsRepo.createContact('a'.repeat(65), { phoneNormalized: '+989121111111' }),
        TenantScopeInvalidError,
      );
      await assert.rejects(
        contactsRepo.createTag('tenant;drop table', { name: 'VIP' }),
        TenantScopeInvalidError,
      );
    });

    it('guarantees complete cross-tenant read isolation', async () => {
      const alphaContact = await contactsRepo.createContact(TENANT_ALPHA, {
        phoneNormalized: '+989121112233',
        firstName: 'Ali',
        lastName: 'Alavi',
      });

      // Tenant Alpha can find it
      const foundAlpha = await contactsRepo.findContactById(TENANT_ALPHA, alphaContact.id);
      assert.ok(foundAlpha);
      assert.strictEqual(foundAlpha.id, alphaContact.id);
      assert.strictEqual(foundAlpha.firstName, 'Ali');

      // Tenant Beta CANNOT find it by ID
      const foundBeta = await contactsRepo.findContactById(TENANT_BETA, alphaContact.id);
      assert.strictEqual(foundBeta, null);

      // Tenant Beta CANNOT find it by phone
      const phoneBeta = await contactsRepo.findContactByPhone(TENANT_BETA, '+989121112233');
      assert.strictEqual(phoneBeta, null);

      // Tenant Beta listing returns 0 contacts
      const listBeta = await contactsRepo.listContacts(TENANT_BETA);
      assert.strictEqual(listBeta.length, 0);

      // Tenant Beta count is 0
      const countBeta = await contactsRepo.countContacts(TENANT_BETA);
      assert.strictEqual(countBeta, 0);

      // Tenant Alpha count is 1
      const countAlpha = await contactsRepo.countContacts(TENANT_ALPHA);
      assert.strictEqual(countAlpha, 1);
    });

    it('guarantees cross-tenant update and delete isolation', async () => {
      const contact = await contactsRepo.createContact(TENANT_ALPHA, {
        phoneNormalized: '+989124445566',
        firstName: 'Maryam',
      });

      // Tenant Beta attempts to update Tenant Alpha contact -> fails with ContactNotFoundError
      await assert.rejects(
        contactsRepo.updateContact(TENANT_BETA, contact.id, { firstName: 'Hacked' }),
        ContactNotFoundError,
      );

      // Verify contact was not modified
      const unchanged = await contactsRepo.findContactById(TENANT_ALPHA, contact.id);
      assert.strictEqual(unchanged?.firstName, 'Maryam');

      // Tenant Beta attempts to delete Tenant Alpha contact -> fails with ContactNotFoundError
      await assert.rejects(
        contactsRepo.deleteContact(TENANT_BETA, contact.id),
        ContactNotFoundError,
      );

      // Verify contact still exists in Tenant Alpha
      const stillThere = await contactsRepo.findContactById(TENANT_ALPHA, contact.id);
      assert.ok(stillThere);
    });
  });

  describe('3. Composite Unique Constraints (AC-02)', () => {
    it('enforces composite uniqueness [tenantId, phoneNormalized] within the same tenant', async () => {
      await contactsRepo.createContact(TENANT_ALPHA, {
        phoneNormalized: '+989129990011',
        firstName: 'First',
      });

      // Duplicate phone in SAME tenant must be rejected by database unique constraint
      await assert.rejects(
        contactsRepo.createContact(TENANT_ALPHA, {
          phoneNormalized: '+989129990011',
          firstName: 'Second',
        }),
        (err: any) => {
          assert.ok(err.code === 'P2002' || /unique/i.test(err.message));
          return true;
        },
      );
    });

    it('allows identical phoneNormalized across DIFFERENT tenants', async () => {
      const alphaContact = await contactsRepo.createContact(TENANT_ALPHA, {
        phoneNormalized: '+989123334455',
        firstName: 'Alpha User',
      });

      const betaContact = await contactsRepo.createContact(TENANT_BETA, {
        phoneNormalized: '+989123334455',
        firstName: 'Beta User',
      });

      assert.ok(alphaContact);
      assert.ok(betaContact);
      assert.notStrictEqual(alphaContact.id, betaContact.id);
      assert.strictEqual(alphaContact.phoneNormalized, betaContact.phoneNormalized);
      assert.strictEqual(alphaContact.tenantId, TENANT_ALPHA);
      assert.strictEqual(betaContact.tenantId, TENANT_BETA);
    });

    it('enforces composite uniqueness [tenantId, phoneNormalized] on SuppressionEntry', async () => {
      await contactsRepo.addSuppression(TENANT_ALPHA, {
        phoneNormalized: '+989127778899',
        reason: 'STOP keyword',
      });

      // Adding suppression again for the same phone in the same tenant performs an upsert (idempotent)
      const updated = await contactsRepo.addSuppression(TENANT_ALPHA, {
        phoneNormalized: '+989127778899',
        reason: 'Updated complaint',
      });
      assert.strictEqual(updated.reason, 'Updated complaint');

      // Direct raw insert to verify DB-level unique constraint
      await assert.rejects(
        prisma.suppressionEntry.create({
          data: {
            tenantId: TENANT_ALPHA,
            phoneNormalized: '+989127778899',
            reason: 'Direct duplicate',
          },
        }),
        (err: any) => {
          assert.strictEqual(err.code, 'P2002');
          return true;
        },
      );

      // Same phone CAN be suppressed in Tenant Beta without conflict
      const betaSuppression = await contactsRepo.addSuppression(TENANT_BETA, {
        phoneNormalized: '+989127778899',
        reason: 'Beta complaint',
      });
      assert.strictEqual(betaSuppression.tenantId, TENANT_BETA);
    });
  });

  describe('4. Foreign Key Constraints & Data Model Integrity (AC-01)', () => {
    it('fails when inserting contact for a non-existent tenant', async () => {
      await assert.rejects(
        contactsRepo.createContact('non-existent-tenant-id', {
          phoneNormalized: '+989120000000',
        }),
        (err: any) => {
          assert.ok(err.code === 'P2003' || /foreign key/i.test(err.message));
          return true;
        },
      );
    });

    it('fails when inserting tag for a non-existent tenant', async () => {
      await assert.rejects(
        contactsRepo.createTag('non-existent-tenant-id', {
          name: 'InvalidTag',
        }),
        (err: any) => {
          assert.ok(err.code === 'P2003' || /foreign key/i.test(err.message));
          return true;
        },
      );
    });

    it('fails when inserting suppression entry for a non-existent tenant', async () => {
      await assert.rejects(
        contactsRepo.addSuppression('non-existent-tenant-id', {
          phoneNormalized: '+989120000000',
        }),
        (err: any) => {
          assert.ok(err.code === 'P2003' || /foreign key/i.test(err.message));
          return true;
        },
      );
    });

    it('strictly prevents associating Tenant Beta tag with Tenant Alpha contact', async () => {
      const alphaContact = await contactsRepo.createContact(TENANT_ALPHA, {
        phoneNormalized: '+989126667788',
      });
      const betaTag = await contactsRepo.createTag(TENANT_BETA, {
        name: 'BetaPromo',
      });

      // Attempting to attach betaTag to alphaContact within TENANT_ALPHA scope fails because tag is not in Alpha
      await assert.rejects(
        contactsRepo.addTagToContact(TENANT_ALPHA, alphaContact.id, betaTag.id),
        TagNotFoundError,
      );

      // Attempting to attach within TENANT_BETA fails because contact is not in Beta
      await assert.rejects(
        contactsRepo.addTagToContact(TENANT_BETA, alphaContact.id, betaTag.id),
        ContactNotFoundError,
      );

      // Raw attempt to insert mismatched composite FK fails at database constraint level
      await assert.rejects(
        prisma.contactTag.create({
          data: {
            tenantId: TENANT_ALPHA,
            contactId: alphaContact.id,
            tagId: betaTag.id,
          },
        }),
        (err: any) => {
          assert.ok(err.code === 'P2003' || /foreign key/i.test(err.message));
          return true;
        },
      );
    });
  });

  describe('5. Tags & ContactTag Associations', () => {
    it('creates, lists and attaches tags within tenant boundary', async () => {
      const vipTag = await contactsRepo.createTag(TENANT_ALPHA, {
        name: 'VIP Customer',
        color: '#FFD700',
        description: 'High value customers',
      });
      const leadTag = await contactsRepo.createTag(TENANT_ALPHA, {
        name: 'New Lead',
        color: '#00FF00',
      });

      // Tags are listed strictly for Tenant Alpha
      const alphaTags = await contactsRepo.listTags(TENANT_ALPHA);
      assert.strictEqual(alphaTags.length, 2);

      const betaTags = await contactsRepo.listTags(TENANT_BETA);
      assert.strictEqual(betaTags.length, 0);

      const contact = await contactsRepo.createContact(TENANT_ALPHA, {
        phoneNormalized: '+989125550000',
      });

      // Attach VIP tag
      await contactsRepo.addTagToContact(TENANT_ALPHA, contact.id, vipTag.id);
      await contactsRepo.addTagToContact(TENANT_ALPHA, contact.id, leadTag.id);

      // Verify contact tags
      const attached = await contactsRepo.listContactTags(TENANT_ALPHA, contact.id);
      assert.strictEqual(attached.length, 2);
      const names = attached.map((t) => t.name);
      assert.ok(names.includes('VIP Customer'));
      assert.ok(names.includes('New Lead'));

      // Filter contacts by tag
      const vipContacts = await contactsRepo.listContacts(TENANT_ALPHA, { tagId: vipTag.id });
      assert.strictEqual(vipContacts.length, 1);
      assert.strictEqual(vipContacts[0].id, contact.id);

      // Remove a tag
      await contactsRepo.removeTagFromContact(TENANT_ALPHA, contact.id, leadTag.id);
      const remaining = await contactsRepo.listContactTags(TENANT_ALPHA, contact.id);
      assert.strictEqual(remaining.length, 1);
      assert.strictEqual(remaining[0].name, 'VIP Customer');
    });

    it('enforces unique tag names within the same tenant', async () => {
      await contactsRepo.createTag(TENANT_ALPHA, { name: 'Promo2026' });
      await assert.rejects(
        contactsRepo.createTag(TENANT_ALPHA, { name: 'Promo2026' }),
        (err: any) => err.code === 'P2002',
      );

      // But Tenant Beta can have a tag with the same name
      const betaTag = await contactsRepo.createTag(TENANT_BETA, { name: 'Promo2026' });
      assert.strictEqual(betaTag.tenantId, TENANT_BETA);
    });
  });

  describe('6. Suppression (Opt-Out / Blacklist) Management', () => {
    it('sets isSuppressed=true on contact when phone is added to suppression list', async () => {
      const contact = await contactsRepo.createContact(TENANT_ALPHA, {
        phoneNormalized: '+989128889900',
        isSuppressed: false,
      });
      assert.strictEqual(contact.isSuppressed, false);

      // Add to suppression list
      await contactsRepo.addSuppression(TENANT_ALPHA, {
        phoneNormalized: '+989128889900',
        reason: 'User opted out via STOP',
        source: 'INBOX',
      });

      // Verify isSuppressed is now true
      const isSupp = await contactsRepo.isSuppressed(TENANT_ALPHA, '+989128889900');
      assert.strictEqual(isSupp, true);

      const refreshed = await contactsRepo.findContactById(TENANT_ALPHA, contact.id);
      assert.strictEqual(refreshed?.isSuppressed, true);
    });

    it('automatically marks new contact as suppressed if phone is already in suppression list', async () => {
      await contactsRepo.addSuppression(TENANT_ALPHA, {
        phoneNormalized: '+989127771122',
        reason: 'Prior complaints',
      });

      const contact = await contactsRepo.createContact(TENANT_ALPHA, {
        phoneNormalized: '+989127771122',
      });

      assert.strictEqual(contact.isSuppressed, true);
    });

    it('removes suppression and unsets isSuppressed on contact', async () => {
      const contact = await contactsRepo.createContact(TENANT_ALPHA, {
        phoneNormalized: '+989124440011',
      });
      await contactsRepo.addSuppression(TENANT_ALPHA, {
        phoneNormalized: '+989124440011',
      });

      let check = await contactsRepo.isSuppressed(TENANT_ALPHA, '+989124440011');
      assert.strictEqual(check, true);

      // Remove suppression
      await contactsRepo.removeSuppression(TENANT_ALPHA, '+989124440011');

      check = await contactsRepo.isSuppressed(TENANT_ALPHA, '+989124440011');
      assert.strictEqual(check, false);

      const updated = await contactsRepo.findContactById(TENANT_ALPHA, contact.id);
      assert.strictEqual(updated?.isSuppressed, false);
    });

    it('ensures suppression entries in Tenant Alpha do NOT affect Tenant Beta', async () => {
      await contactsRepo.addSuppression(TENANT_ALPHA, {
        phoneNormalized: '+989129998877',
        reason: 'Alpha blacklist',
      });

      // Tenant Beta check is false
      const betaSuppressed = await contactsRepo.isSuppressed(TENANT_BETA, '+989129998877');
      assert.strictEqual(betaSuppressed, false);

      // Contact created in Tenant Beta with same phone is NOT suppressed
      const betaContact = await contactsRepo.createContact(TENANT_BETA, {
        phoneNormalized: '+989129998877',
      });
      assert.strictEqual(betaContact.isSuppressed, false);
    });
  });

  describe('7. Strict Per-Tenant Cleanup (Never Global Wipe)', () => {
    it('clearTenant clears ONLY the specified tenant data without touching other tenants', async () => {
      await contactsRepo.createContact(TENANT_ALPHA, { phoneNormalized: '+989121110001' });
      await contactsRepo.createTag(TENANT_ALPHA, { name: 'TagA' });
      await contactsRepo.addSuppression(TENANT_ALPHA, { phoneNormalized: '+989121110002' });

      await contactsRepo.createContact(TENANT_BETA, { phoneNormalized: '+989122220001' });
      await contactsRepo.createTag(TENANT_BETA, { name: 'TagB' });
      await contactsRepo.addSuppression(TENANT_BETA, { phoneNormalized: '+989122220002' });

      // Clear Tenant Alpha
      await contactsRepo.clearTenant(TENANT_ALPHA);

      // Tenant Alpha data is wiped
      assert.strictEqual(await contactsRepo.countContacts(TENANT_ALPHA), 0);
      assert.strictEqual((await contactsRepo.listTags(TENANT_ALPHA)).length, 0);
      assert.strictEqual((await contactsRepo.listSuppressions(TENANT_ALPHA)).length, 0);

      // Tenant Beta data is completely intact!
      assert.strictEqual(await contactsRepo.countContacts(TENANT_BETA), 1);
      assert.strictEqual((await contactsRepo.listTags(TENANT_BETA)).length, 1);
      assert.strictEqual((await contactsRepo.listSuppressions(TENANT_BETA)).length, 1);
    });
  });
});