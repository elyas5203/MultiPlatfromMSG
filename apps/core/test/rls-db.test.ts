import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TenantRepository } from '../src/tenant/tenant.repository';
import { RlsSessionService } from '../src/tenant/rls.service';
import { TenantContext } from '../src/tenant/tenant-context';
import {
  TEST_MARKER_TABLE,
  TEST_MARKER_KEY,
  validateDatabaseUrlSafety,
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

describe('PostgreSQL Row-Level Security (RLS) Database Verification (TASK-0023)', () => {
  let app: any;
  let tenantRepo: TenantRepository;
  let prisma: PrismaService;
  let rlsService: RlsSessionService;
  let isTargetVerified = false;

  const RUN_SEED = crypto.randomBytes(4).toString('hex');
  const APP_USER = `app_user_${RUN_SEED}`;
  const TENANT_ALPHA = `org_rls_alpha_${RUN_SEED}`;
  const TENANT_BETA = `org_rls_beta_${RUN_SEED}`;
  const SLUG_ALPHA = `slug-rls-alpha-${RUN_SEED}`;
  const SLUG_BETA = `slug-rls-beta-${RUN_SEED}`;

  before(async () => {
    isTargetVerified = false;

    // 1. Fail-closed target validation
    validateDatabaseUrlSafety(process.env.DATABASE_URL);

    // 2. Initialize Nest Application Context
    app = await NestFactory.createApplicationContext(AppModule, { logger: false });
    tenantRepo = app.get(TenantRepository);
    prisma = app.get(PrismaService);
    rlsService = new RlsSessionService(prisma);

    // 3. Confirm connectivity
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

    // 4. Verify test database safety marker
    await assertPreProvisionedTestDatabaseMarker(prisma);
    isTargetVerified = true;

    // 5. Create application role (non-superuser, NOBYPASSRLS) and grant permissions
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${APP_USER}') THEN
          CREATE ROLE "${APP_USER}" WITH LOGIN NOSUPERUSER NOBYPASSRLS;
        END IF;
      END
      $$;
    `);
    await prisma.$executeRawUnsafe(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO "${APP_USER}"`);
    await prisma.$executeRawUnsafe(`GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO "${APP_USER}"`);
    await prisma.$executeRawUnsafe(`GRANT ALL PRIVILEGES ON SCHEMA public TO "${APP_USER}"`);

    // 6. Seed synthetic tenants
    await tenantRepo.createTenant({ id: TENANT_ALPHA, name: 'Tenant Alpha (RLS)', slug: SLUG_ALPHA });
    await tenantRepo.createTenant({ id: TENANT_BETA, name: 'Tenant Beta (RLS)', slug: SLUG_BETA });
  });

  after(async () => {
    if (isTargetVerified && prisma) {
      try {
        await prisma.$executeRawUnsafe(
          `DELETE FROM "tenants" WHERE "id" IN ($1, $2)`,
          TENANT_ALPHA,
          TENANT_BETA,
        );
      } catch {}
      try {
        await prisma.$executeRawUnsafe(`DROP OWNED BY "${APP_USER}" CASCADE`);
        await prisma.$executeRawUnsafe(`DROP ROLE IF EXISTS "${APP_USER}"`);
      } catch {}
    }
    if (app) {
      await app.close();
    }
  });

  // Helper to run query as non-superuser app role
  async function asAppUser<T>(
    operation: (tx: any) => Promise<T>,
    tenantId?: string,
  ): Promise<T> {
    return prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL ROLE "${APP_USER}"`);
      if (tenantId) {
        await rlsService.setLocalTenantId(tx, tenantId);
      }
      return operation(tx);
    });
  }

  // =========================================================================
  // AC-01: RLS and FORCE RLS Configuration on PostgreSQL Catalog
  // =========================================================================
  describe('AC-01: PostgreSQL Catalog RLS and Policies Verification', () => {
    it('verifies that rowsecurity and forcerowsecurity are ENABLED on all 9 target tables', async () => {
      const targetTables = [
        'brands',
        'staff',
        'teams',
        'staff_teams',
        'sessions',
        'contacts',
        'tags',
        'contact_tags',
        'suppression_entries',
      ];

      const rows: { relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }[] =
        await prisma.$queryRawUnsafe(`
          SELECT relname, relrowsecurity, relforcerowsecurity
          FROM pg_class
          JOIN pg_namespace ON pg_namespace.oid = pg_class.relnamespace
          WHERE pg_namespace.nspname = 'public'
            AND relname = ANY($1::text[])
        `, targetTables);

      assert.equal(rows.length, targetTables.length, 'All 9 target tables must be present in catalog');

      for (const row of rows) {
        assert.equal(
          row.relrowsecurity,
          true,
          `Table ${row.relname} must have relrowsecurity = true`,
        );
        assert.equal(
          row.relforcerowsecurity,
          true,
          `Table ${row.relname} must have relforcerowsecurity = true (FORCE RLS)`,
        );
      }
    });

    it('verifies that tenant_isolation_policy exists with correct qualifier on target tables', async () => {
      const rows: { tablename: string; policyname: string; qual: string; with_check: string }[] =
        await prisma.$queryRawUnsafe(`
          SELECT tablename, policyname, qual, with_check
          FROM pg_policies
          WHERE schemaname = 'public'
            AND policyname = 'tenant_isolation_policy'
        `);

      assert.ok(rows.length >= 9, 'All 9 tables must have tenant_isolation_policy defined');
      for (const row of rows) {
        assert.ok(
          row.qual.includes('app.current_tenant_id'),
          `Policy for ${row.tablename} must reference app.current_tenant_id in USING expression`,
        );
        assert.ok(
          row.with_check.includes('app.current_tenant_id'),
          `Policy for ${row.tablename} must reference app.current_tenant_id in WITH CHECK expression`,
        );
      }
    });
  });

  // =========================================================================
  // AC-02: RlsSessionService Functional Verification
  // =========================================================================
  describe('AC-02: RlsSessionService Execution and Scoping', () => {
    it('applies SET LOCAL app.current_tenant_id strictly within transaction scope', async () => {
      // Outside transaction: setting is null or empty
      const outsideBefore: { val: string | null }[] = await prisma.$queryRawUnsafe(
        `SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS val`,
      );
      assert.equal(outsideBefore[0].val, null);

      // Inside transaction with explicit tenant
      await rlsService.runInTenantTransaction(async (tx) => {
        const inside: { val: string | null }[] = await tx.$queryRawUnsafe(
          `SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS val`,
        );
        assert.equal(inside[0].val, TENANT_ALPHA);
      }, TENANT_ALPHA);

      // Outside transaction after execution: setting must NOT leak across transactions
      const outsideAfter: { val: string | null }[] = await prisma.$queryRawUnsafe(
        `SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS val`,
      );
      assert.equal(outsideAfter[0].val, null);
    });

    it('picks tenantId automatically from active TenantContext', async () => {
      await TenantContext.runWithTenant(TENANT_BETA, async () => {
        await rlsService.runInTenantTransaction(async (tx) => {
          const inside: { val: string | null }[] = await tx.$queryRawUnsafe(
            `SELECT NULLIF(current_setting('app.current_tenant_id', true), '') AS val`,
          );
          assert.equal(inside[0].val, TENANT_BETA);
        });
      });
    });

    it('throws fail-closed error if runInTenantTransaction is called without context or explicit tenant', async () => {
      await assert.rejects(
        async () => {
          await rlsService.runInTenantTransaction(async (_tx) => {});
        },
        /Tenant context is missing/i,
      );
    });
  });

  // =========================================================================
  // AC-03: Fail-Closed and Cross-Tenant Row-Level Security Isolation Tests
  // =========================================================================
  describe('AC-03: Two-Tenant Database Row-Level Security Isolation', () => {
    const brandAlphaId = `brd_alpha_${RUN_SEED}`;
    const brandBetaId = `brd_beta_${RUN_SEED}`;
    const staffAlphaId = `stf_alpha_${RUN_SEED}`;
    const staffBetaId = `stf_beta_${RUN_SEED}`;

    it('DENIES insertion when app.current_tenant_id is not set (Fail-Closed WRITE)', async () => {
      // Attempting to insert into brands as app_user without setting app.current_tenant_id
      await assert.rejects(
        async () => {
          await asAppUser(async (tx) => {
            await tx.$executeRawUnsafe(
              `INSERT INTO "brands" ("id", "tenant_id", "name", "created_at", "updated_at")
               VALUES ($1, $2, 'Unscoped Brand', NOW(), NOW())`,
              brandAlphaId,
              TENANT_ALPHA,
            );
          });
        },
        /new row violates row-level security policy/i,
      );
    });

    it('DENIES insertion when tenant_id does not match app.current_tenant_id (Spoofing Prevention)', async () => {
      await assert.rejects(
        async () => {
          await asAppUser(async (tx) => {
            // Context is TENANT_ALPHA, but inserting row with TENANT_BETA
            await tx.$executeRawUnsafe(
              `INSERT INTO "brands" ("id", "tenant_id", "name", "created_at", "updated_at")
               VALUES ($1, $2, 'Spoofed Brand', NOW(), NOW())`,
              brandBetaId,
              TENANT_BETA,
            );
          }, TENANT_ALPHA);
        },
        /new row violates row-level security policy/i,
      );
    });

    it('PERMITS insertion when tenant_id matches app.current_tenant_id', async () => {
      // Insert Brand for Alpha
      await asAppUser(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "brands" ("id", "tenant_id", "name", "created_at", "updated_at")
           VALUES ($1, $2, 'Alpha Brand', NOW(), NOW())`,
          brandAlphaId,
          TENANT_ALPHA,
        );
      }, TENANT_ALPHA);

      // Insert Brand for Beta
      await asAppUser(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "brands" ("id", "tenant_id", "name", "created_at", "updated_at")
           VALUES ($1, $2, 'Beta Brand', NOW(), NOW())`,
          brandBetaId,
          TENANT_BETA,
        );
      }, TENANT_BETA);

      // Insert Staff for Alpha
      await asAppUser(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "staff" ("id", "tenant_id", "email", "full_name", "role", "status", "created_at", "updated_at")
           VALUES ($1, $2, $3, 'Staff Alpha', 'MEMBER', 'ACTIVE', NOW(), NOW())`,
          staffAlphaId,
          TENANT_ALPHA,
          `alpha_${RUN_SEED}@example.com`,
        );
      }, TENANT_ALPHA);

      // Insert Staff for Beta
      await asAppUser(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "staff" ("id", "tenant_id", "email", "full_name", "role", "status", "created_at", "updated_at")
           VALUES ($1, $2, $3, 'Staff Beta', 'MEMBER', 'ACTIVE', NOW(), NOW())`,
          staffBetaId,
          TENANT_BETA,
          `beta_${RUN_SEED}@example.com`,
        );
      }, TENANT_BETA);
    });

    it('RETURNS ZERO ROWS on raw SELECT when app.current_tenant_id is not set (Fail-Closed READ)', async () => {
      // SELECT as app_user without tenant setting
      const rows: { id: string }[] = await asAppUser(async (tx) => {
        return tx.$queryRawUnsafe(
          `SELECT "id" FROM "brands" WHERE "id" IN ($1, $2)`,
          brandAlphaId,
          brandBetaId,
        );
      });

      assert.equal(rows.length, 0, 'No rows must be returned when RLS tenant setting is missing');
    });

    it('ISOLATES rows strictly between tenants under RLS (Tenant Alpha views ONLY Alpha)', async () => {
      await asAppUser(async (tx) => {
        const brands: { id: string; name: string }[] = await tx.$queryRawUnsafe(
          `SELECT "id", "name" FROM "brands" WHERE "id" IN ($1, $2)`,
          brandAlphaId,
          brandBetaId,
        );

        assert.equal(brands.length, 1);
        assert.equal(brands[0].id, brandAlphaId);
        assert.equal(brands[0].name, 'Alpha Brand');

        const staff: { id: string }[] = await tx.$queryRawUnsafe(
          `SELECT "id" FROM "staff" WHERE "id" IN ($1, $2)`,
          staffAlphaId,
          staffBetaId,
        );

        assert.equal(staff.length, 1);
        assert.equal(staff[0].id, staffAlphaId);
      }, TENANT_ALPHA);
    });

    it('ISOLATES rows strictly between tenants under RLS (Tenant Beta views ONLY Beta)', async () => {
      await asAppUser(async (tx) => {
        const brands: { id: string; name: string }[] = await tx.$queryRawUnsafe(
          `SELECT "id", "name" FROM "brands" WHERE "id" IN ($1, $2)`,
          brandAlphaId,
          brandBetaId,
        );

        assert.equal(brands.length, 1);
        assert.equal(brands[0].id, brandBetaId);
        assert.equal(brands[0].name, 'Beta Brand');

        const staff: { id: string }[] = await tx.$queryRawUnsafe(
          `SELECT "id" FROM "staff" WHERE "id" IN ($1, $2)`,
          staffAlphaId,
          staffBetaId,
        );

        assert.equal(staff.length, 1);
        assert.equal(staff[0].id, staffBetaId);
      }, TENANT_BETA);
    });

    it('PREVENTS cross-tenant UPDATE and DELETE via RLS', async () => {
      // Tenant Alpha attempts to update Tenant Beta brand -> 0 rows affected
      await asAppUser(async (tx) => {
        const count = await tx.$executeRawUnsafe(
          `UPDATE "brands" SET "name" = 'Hacked by Alpha' WHERE "id" = $1`,
          brandBetaId,
        );
        assert.equal(count, 0, 'Alpha must not affect Beta rows');
      }, TENANT_ALPHA);

      // Verify Beta brand name remains intact
      await asAppUser(async (tx) => {
        const rows: { name: string }[] = await tx.$queryRawUnsafe(
          `SELECT "name" FROM "brands" WHERE "id" = $1`,
          brandBetaId,
        );
        assert.equal(rows[0].name, 'Beta Brand');
      }, TENANT_BETA);

      // Tenant Alpha attempts to delete Tenant Beta brand -> 0 rows affected
      await asAppUser(async (tx) => {
        const count = await tx.$executeRawUnsafe(
          `DELETE FROM "brands" WHERE "id" = $1`,
          brandBetaId,
        );
        assert.equal(count, 0, 'Alpha must not delete Beta rows');
      }, TENANT_ALPHA);
    });

    it('verifies RLS on contacts and suppression entries', async () => {
      const contactAlphaId = `cnt_alpha_${RUN_SEED}`;
      const contactBetaId = `cnt_beta_${RUN_SEED}`;

      // Alpha creates contact
      await asAppUser(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "contacts" ("id", "tenant_id", "phone_normalized", "created_at", "updated_at")
           VALUES ($1, $2, '+989120000001', NOW(), NOW())`,
          contactAlphaId,
          TENANT_ALPHA,
        );
      }, TENANT_ALPHA);

      // Beta creates contact
      await asAppUser(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO "contacts" ("id", "tenant_id", "phone_normalized", "created_at", "updated_at")
           VALUES ($1, $2, '+989120000002', NOW(), NOW())`,
          contactBetaId,
          TENANT_BETA,
        );
      }, TENANT_BETA);

      // Alpha queries contacts -> only Alpha contact returned
      await asAppUser(async (tx) => {
        const contacts: { id: string }[] = await tx.$queryRawUnsafe(
          `SELECT "id" FROM "contacts" WHERE "id" IN ($1, $2)`,
          contactAlphaId,
          contactBetaId,
        );
        assert.equal(contacts.length, 1);
        assert.equal(contacts[0].id, contactAlphaId);
      }, TENANT_ALPHA);

      // Beta queries contacts -> only Beta contact returned
      await asAppUser(async (tx) => {
        const contacts: { id: string }[] = await tx.$queryRawUnsafe(
          `SELECT "id" FROM "contacts" WHERE "id" IN ($1, $2)`,
          contactAlphaId,
          contactBetaId,
        );
        assert.equal(contacts.length, 1);
        assert.equal(contacts[0].id, contactBetaId);
      }, TENANT_BETA);
    });
  });
});
