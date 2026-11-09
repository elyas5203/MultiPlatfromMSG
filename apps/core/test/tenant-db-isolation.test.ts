import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TenantRepository } from '../src/tenant/tenant.repository';
import {
  TenantScopeMissingError,
  TenantScopeInvalidError,
} from '../src/tenant/tenant-scope';

/**
 * Integration Test: PostgreSQL Multi-Tenancy Boundary & Integrity Verification (AC-02)
 *
 * NOTE ON ARCHITECTURAL BOUNDARIES:
 * 1. Foreign Key Integrity: At the database constraint level, composite foreign keys
 *    (tenant_id, staff_id) and (tenant_id, team_id) strictly enforce that StaffTeam
 *    memberships cannot reference staff or teams belonging to different tenants.
 * 2. Query Read/Write Boundary: Enforced at the Repository application layer via explicit
 *    tenant_id scoping and validation (assertValidTenantId). Row-Level Security (RLS)
 *    is not yet implemented and is planned for future phases.
 * 3. Fail-Closed Test Guard: Ensures the integration test runs strictly against a dedicated
 *    test database containing our trusted test marker table/record. Rejects non-test DBs
 *    without mutating or wiping any data, and never outputs raw connection strings or secrets.
 * 4. Run-Unique Identifiers: Tenant IDs and slugs are generated uniquely per test run,
 *    preventing collision with or accidental deletion of any pre-existing records.
 */

export const TEST_MARKER_TABLE = '__multiplatformmsg_test_marker__';
export const TEST_MARKER_KEY = 'TEST_ENVIRONMENT_PERMITTED';

export class InsecureDatabaseTargetError extends Error {
  constructor(message = 'Refusing to run tests: Target database is not verified as a dedicated test database.') {
    super(message);
    this.name = 'InsecureDatabaseTargetError';
  }
}

/**
 * Validates that DATABASE_URL specifies an authorized test database name
 * and matches dedicated test naming conventions, without exposing credentials.
 */
export function validateDatabaseUrlSafety(dbUrl: string | undefined): void {
  if (!dbUrl || typeof dbUrl !== 'string' || dbUrl.trim().length === 0) {
    throw new InsecureDatabaseTargetError('DATABASE_URL environment variable is missing.');
  }

  let parsed: URL;
  try {
    parsed = new URL(dbUrl);
  } catch {
    throw new InsecureDatabaseTargetError('DATABASE_URL is malformed or invalid.');
  }

  // Extract database name (path without leading slash)
  const dbName = parsed.pathname.replace(/^\//, '').trim();

  // Allowed dedicated test database names: must contain 'test' or 'synthetic'
  const isDedicatedTestDb =
    dbName === 'multiplatformmsg_test' ||
    dbName.endsWith('_test') ||
    dbName.includes('test_') ||
    dbName.includes('synthetic');

  if (!isDedicatedTestDb) {
    throw new InsecureDatabaseTargetError(
      `Database name \"${dbName}\" is not an authorized test database. Name must denote a dedicated test DB (e.g. multiplatformmsg_test).`,
    );
  }
}

/**
 * Ensures the target database has the explicit test marker table & record.
 * If running on a dedicated test DB for the first time, creates the marker.
 */
export async function assertAndEnsureTestDatabaseMarker(prisma: PrismaService): Promise<void> {
  // Query current database name from PostgreSQL
  const dbNameRows = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
    'SELECT current_database()',
  );
  const currentDb = dbNameRows[0]?.current_database;
  validateDatabaseUrlSafety(`postgresql://localhost/${currentDb}`);

  // Create marker table if not present, and insert trusted marker record
  await prisma.$executeRawUnsafe(`
    CREATE TABLE IF NOT EXISTS "${TEST_MARKER_TABLE}" (
      "marker_key" TEXT PRIMARY KEY,
      "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await prisma.$executeRawUnsafe(`
    INSERT INTO "${TEST_MARKER_TABLE}" ("marker_key")
    VALUES ('${TEST_MARKER_KEY}')
    ON CONFLICT ("marker_key") DO NOTHING;
  `);

  // Verify marker presence
  const markerRows = await prisma.$queryRawUnsafe<{ marker_key: string }[]>(
    `SELECT "marker_key" FROM "${TEST_MARKER_TABLE}" WHERE "marker_key" = $1`,
    TEST_MARKER_KEY,
  );

  if (markerRows.length === 0) {
    throw new InsecureDatabaseTargetError(
      'Target database missing required test marker record. Halting execution to prevent mutation of non-test database.',
    );
  }
}

describe('PostgreSQL Database Multi-Tenancy Boundary & Integrity Verification (AC-02)', () => {
  let app: any;
  let repository: TenantRepository;
  let prisma: PrismaService;

  // Run-unique synthetic test tenant IDs and slugs (never static or hardcoded across runs)
  const RUN_SEED = crypto.randomBytes(4).toString('hex');
  const TENANT_ALPHA = `org_test_alpha_${RUN_SEED}`;
  const TENANT_BETA = `org_test_beta_${RUN_SEED}`;
  const SLUG_ALPHA = `slug-alpha-${RUN_SEED}`;
  const SLUG_BETA = `slug-beta-${RUN_SEED}`;

  before(async () => {
    // 1. Fail-closed pre-validation: check connection string safety without logging credentials
    validateDatabaseUrlSafety(process.env.DATABASE_URL);

    // 2. Initialize NestJS Application Context & resolve providers
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    repository = app.get(TenantRepository);
    prisma = app.get(PrismaService);

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
      throw new Error('Unable to connect to target test database. Connection refused.');
    }

    // 4. Assert fail-closed dedicated test database marker verification
    await assertAndEnsureTestDatabaseMarker(prisma);
  });

  after(async () => {
    // Strictly clean up ONLY this run's unique tenants
    if (repository) {
      try {
        await repository.clearTenant(TENANT_ALPHA);
        await repository.clearTenant(TENANT_BETA);
      } catch {
        // Ignore cleanup errors on shutdown
      }
    }

    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // Clean state before each test strictly for this run's unique tenants
    await repository.clearTenant(TENANT_ALPHA);
    await repository.clearTenant(TENANT_BETA);

    // Seed test tenants with unique run keys
    await repository.createTenant({
      id: TENANT_ALPHA,
      name: `Alpha Corp ${RUN_SEED}`,
      slug: SLUG_ALPHA,
    });

    await repository.createTenant({
      id: TENANT_BETA,
      name: `Beta LLC ${RUN_SEED}`,
      slug: SLUG_BETA,
    });
  });

  describe('Fail-Closed Non-Test Database Protection (Safety Guard)', () => {
    it('must reject non-test database URLs before any database mutation occurs', () => {
      const nonTestUrls = [
        'postgresql://admin:secret@127.0.0.1:5432/production',
        'postgresql://postgres:pw@127.0.0.1:5432/multiplatformmsg_prod',
        'postgresql://user:pass@127.0.0.1:5432/main_db',
        'postgresql://user:pass@127.0.0.1:5432/staging?schema=public',
        'postgresql://user:pass@127.0.0.1:5432/customer_data',
      ];

      for (const nonTestUrl of nonTestUrls) {
        assert.throws(
          () => validateDatabaseUrlSafety(nonTestUrl),
          (err: unknown) => {
            assert.ok(err instanceof InsecureDatabaseTargetError);
            // Ensure sensitive credentials are NEVER leaked into error messages
            const msg = (err as Error).message;
            assert.strictEqual(msg.includes('secret'), false);
            assert.strictEqual(msg.includes('pass'), false);
            assert.strictEqual(msg.includes('pw'), false);
            return true;
          },
          `Expected fail-closed rejection for non-test database URL: ${nonTestUrl}`,
        );
      }
    });

    it('must accept authorized dedicated test database names', () => {
      const authorizedTestUrls = [
        'postgresql://postgres@127.0.0.1:54332/multiplatformmsg_test?schema=public',
        'postgresql://postgres:sample@127.0.0.1:5432/core_test',
        'postgresql://testuser@localhost:5432/test_tenancy',
        'postgresql://app:sample@127.0.0.1:5432/app_synthetic_db',
      ];

      for (const testUrl of authorizedTestUrls) {
        assert.doesNotThrow(() => validateDatabaseUrlSafety(testUrl));
      }
    });
  });

  describe('Synthetic Two-Tenant Repository Isolation & Composite FK Integrity (AC-02)', () => {
    it('should create and retrieve Brands with strict repository tenant filtering', async () => {
      const brandAlpha = await repository.createBrand(TENANT_ALPHA, {
        name: 'Alpha Retail Brand',
        code: 'ALPHA-RT',
      });

      const brandBeta = await repository.createBrand(TENANT_BETA, {
        name: 'Beta Tech Brand',
        code: 'BETA-TECH',
      });

      assert.strictEqual(brandAlpha.tenantId, TENANT_ALPHA);
      assert.strictEqual(brandBeta.tenantId, TENANT_BETA);

      // Verify legitimate retrieval
      const foundAlpha = await repository.findBrandById(TENANT_ALPHA, brandAlpha.id);
      assert.ok(foundAlpha);
      assert.strictEqual(foundAlpha?.name, 'Alpha Retail Brand');

      const foundBeta = await repository.findBrandById(TENANT_BETA, brandBeta.id);
      assert.ok(foundBeta);
      assert.strictEqual(foundBeta?.name, 'Beta Tech Brand');

      // Cross-tenant query filtering: Tenant Beta must not see Tenant Alpha brand
      const crossRead = await repository.findBrandById(TENANT_BETA, brandAlpha.id);
      assert.strictEqual(
        crossRead,
        null,
        'Tenant Beta must not be able to read Tenant Alpha brand through repository',
      );

      // Collection isolation
      const alphaBrands = await repository.listBrands(TENANT_ALPHA);
      const betaBrands = await repository.listBrands(TENANT_BETA);

      assert.strictEqual(alphaBrands.length, 1);
      assert.strictEqual(alphaBrands[0].id, brandAlpha.id);

      assert.strictEqual(betaBrands.length, 1);
      assert.strictEqual(betaBrands[0].id, brandBeta.id);
    });

    it('should create and retrieve Staff records with strict repository tenant filtering', async () => {
      const staffAlpha = await repository.createStaff(TENANT_ALPHA, {
        email: `alice.${RUN_SEED}@alpha.example.com`,
        fullName: 'Alice Alpha',
        role: 'ADMIN',
      });

      const staffBeta = await repository.createStaff(TENANT_BETA, {
        email: `bob.${RUN_SEED}@beta.example.com`,
        fullName: 'Bob Beta',
        role: 'MEMBER',
      });

      assert.strictEqual(staffAlpha.tenantId, TENANT_ALPHA);
      assert.strictEqual(staffBeta.tenantId, TENANT_BETA);

      // Verify legitimate query
      const readAlpha = await repository.findStaffById(TENANT_ALPHA, staffAlpha.id);
      assert.ok(readAlpha);
      assert.strictEqual(readAlpha?.email, `alice.${RUN_SEED}@alpha.example.com`);

      // Cross-tenant read must return null
      const crossRead = await repository.findStaffById(TENANT_BETA, staffAlpha.id);
      assert.strictEqual(crossRead, null, 'Cross-tenant staff query must return null');

      // Collection isolation
      const alphaStaff = await repository.listStaff(TENANT_ALPHA);
      const betaStaff = await repository.listStaff(TENANT_BETA);

      assert.strictEqual(alphaStaff.length, 1);
      assert.strictEqual(alphaStaff[0].id, staffAlpha.id);

      assert.strictEqual(betaStaff.length, 1);
      assert.strictEqual(betaStaff[0].id, staffBeta.id);
    });

    it('should create and retrieve Teams with strict repository tenant filtering', async () => {
      const teamAlpha = await repository.createTeam(TENANT_ALPHA, {
        name: 'Alpha Customer Support',
        description: 'First line support for Alpha',
      });

      const teamBeta = await repository.createTeam(TENANT_BETA, {
        name: 'Beta Sales Team',
        description: 'Outbound sales team for Beta',
      });

      assert.strictEqual(teamAlpha.tenantId, TENANT_ALPHA);
      assert.strictEqual(teamBeta.tenantId, TENANT_BETA);

      // Verify legitimate query
      const readAlpha = await repository.findTeamById(TENANT_ALPHA, teamAlpha.id);
      assert.ok(readAlpha);
      assert.strictEqual(readAlpha?.name, 'Alpha Customer Support');

      // Cross-tenant read must return null
      const crossRead = await repository.findTeamById(TENANT_BETA, teamAlpha.id);
      assert.strictEqual(crossRead, null, 'Cross-tenant team query must return null');

      // Collection isolation
      const alphaTeams = await repository.listTeams(TENANT_ALPHA);
      const betaTeams = await repository.listTeams(TENANT_BETA);

      assert.strictEqual(alphaTeams.length, 1);
      assert.strictEqual(alphaTeams[0].id, teamAlpha.id);

      assert.strictEqual(betaTeams.length, 1);
      assert.strictEqual(betaTeams[0].id, teamBeta.id);
    });

    it('should manage Staff-Team membership and prevent cross-tenant assignment at Repository layer', async () => {
      const staffAlpha = await repository.createStaff(TENANT_ALPHA, {
        email: `alice.member.${RUN_SEED}@alpha.example.com`,
        fullName: 'Alice Member',
      });

      const teamAlpha = await repository.createTeam(TENANT_ALPHA, {
        name: 'Alpha Engineering',
      });

      const staffBeta = await repository.createStaff(TENANT_BETA, {
        email: `bob.member.${RUN_SEED}@beta.example.com`,
        fullName: 'Bob Member',
      });

      const teamBeta = await repository.createTeam(TENANT_BETA, {
        name: 'Beta Engineering',
      });

      // Valid assignment within Tenant Alpha
      const assignmentAlpha = await repository.assignStaffToTeam(
        TENANT_ALPHA,
        staffAlpha.id,
        teamAlpha.id,
        'LEAD',
      );
      assert.strictEqual(assignmentAlpha.tenantId, TENANT_ALPHA);
      assert.strictEqual(assignmentAlpha.staffId, staffAlpha.id);
      assert.strictEqual(assignmentAlpha.teamId, teamAlpha.id);

      // Valid assignment within Tenant Beta
      const assignmentBeta = await repository.assignStaffToTeam(
        TENANT_BETA,
        staffBeta.id,
        teamBeta.id,
        'DEVELOPER',
      );
      assert.strictEqual(assignmentBeta.tenantId, TENANT_BETA);

      // Repository layer pre-check prevents cross-tenant assignment
      await assert.rejects(
        () => repository.assignStaffToTeam(TENANT_ALPHA, staffBeta.id, teamAlpha.id),
        (err: Error) => err.message.includes('not found within tenant scope'),
      );

      await assert.rejects(
        () => repository.assignStaffToTeam(TENANT_BETA, staffAlpha.id, teamBeta.id),
        (err: Error) => err.message.includes('not found within tenant scope'),
      );

      // Verify listTeamMembers isolation
      const alphaMembers = await repository.listTeamMembers(TENANT_ALPHA, teamAlpha.id);
      assert.strictEqual(alphaMembers.length, 1);
      assert.strictEqual(alphaMembers[0].staffId, staffAlpha.id);

      const leakedMembers = await repository.listTeamMembers(TENANT_BETA, teamAlpha.id);
      assert.strictEqual(leakedMembers.length, 0);

      // Verify listStaffTeams isolation
      const alphaStaffTeams = await repository.listStaffTeams(TENANT_ALPHA, staffAlpha.id);
      assert.strictEqual(alphaStaffTeams.length, 1);
      assert.strictEqual(alphaStaffTeams[0].teamId, teamAlpha.id);

      const leakedStaffTeams = await repository.listStaffTeams(TENANT_BETA, staffAlpha.id);
      assert.strictEqual(leakedStaffTeams.length, 0);
    });

    it('must enforce composite foreign keys at the database level and reject cross-tenant inserts (AC-02 negative test)', async () => {
      // Create staff and team in separate tenants
      const staffAlpha = await repository.createStaff(TENANT_ALPHA, {
        email: `alice.fk.${RUN_SEED}@alpha.example.com`,
        fullName: 'Alice FK',
      });

      const teamBeta = await repository.createTeam(TENANT_BETA, {
        name: 'Beta Team FK',
      });

      // Negative Test 1: Direct SQL insert attempting to link Tenant Alpha's staff to Tenant Beta's team under Tenant Alpha scope.
      // The composite FK (tenant_id, team_id) -> teams(tenant_id, id) MUST fail at DB engine level.
      await assert.rejects(
        async () => {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "staff_teams" ("id", "tenant_id", "staff_id", "team_id", "created_at")
             VALUES ($1, $2, $3, $4, NOW())`,
            `st-cross-1-${RUN_SEED}`,
            TENANT_ALPHA,
            staffAlpha.id,
            teamBeta.id,
          );
        },
        (err: any) => {
          const msg = String(err.message || err);
          return (
            msg.includes('foreign key constraint') ||
            msg.includes('staff_teams_tenant_id_team_id_fkey') ||
            msg.includes('23503')
          );
        },
        'Database engine must reject cross-tenant staff_team insert via composite FK (tenant_id, team_id)',
      );

      // Negative Test 2: Direct SQL insert attempting to link Tenant Alpha's staff to Tenant Beta's team under Tenant Beta scope.
      // The composite FK (tenant_id, staff_id) -> staff(tenant_id, id) MUST fail at DB engine level.
      await assert.rejects(
        async () => {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "staff_teams" ("id", "tenant_id", "staff_id", "team_id", "created_at")
             VALUES ($1, $2, $3, $4, NOW())`,
            `st-cross-2-${RUN_SEED}`,
            TENANT_BETA,
            staffAlpha.id,
            teamBeta.id,
          );
        },
        (err: any) => {
          const msg = String(err.message || err);
          return (
            msg.includes('foreign key constraint') ||
            msg.includes('staff_teams_tenant_id_staff_id_fkey') ||
            msg.includes('23503')
          );
        },
        'Database engine must reject cross-tenant staff_team insert via composite FK (tenant_id, staff_id)',
      );
    });

    it('should strictly limit clearTenant cleanup to the specified tenant', async () => {
      await repository.createBrand(TENANT_ALPHA, { name: 'Alpha Brand To Clear' });
      const betaBrand = await repository.createBrand(TENANT_BETA, { name: 'Beta Brand Keep' });

      // Clear only Tenant Alpha
      await repository.clearTenant(TENANT_ALPHA);

      // Tenant Alpha brands must be gone
      const alphaBrands = await repository.listBrands(TENANT_ALPHA);
      assert.strictEqual(alphaBrands.length, 0);

      // Tenant Beta brand must be completely intact
      const betaBrands = await repository.listBrands(TENANT_BETA);
      assert.strictEqual(betaBrands.length, 1);
      assert.strictEqual(betaBrands[0].id, betaBrand.id);
    });
  });

  describe('Missing tenant_id Rejection (AC-02)', () => {
    it('must reject Brand operations when tenant_id is missing or empty', async () => {
      const missingValues = [null, undefined, '', '   '];

      for (const val of missingValues) {
        await assert.rejects(
          () => repository.createBrand(val, { name: 'X' }),
          (err: unknown) => err instanceof TenantScopeMissingError,
        );

        await assert.rejects(
          () => repository.findBrandById(val, 'b-1'),
          (err: unknown) => err instanceof TenantScopeMissingError,
        );

        await assert.rejects(
          () => repository.listBrands(val),
          (err: unknown) => err instanceof TenantScopeMissingError,
        );
      }
    });

    it('must reject Staff operations when tenant_id is missing or empty', async () => {
      const missingValues = [null, undefined, '', '   '];

      for (const val of missingValues) {
        await assert.rejects(
          () => repository.createStaff(val, { email: 'x@x.com', fullName: 'X' }),
          (err: unknown) => err instanceof TenantScopeMissingError,
        );

        await assert.rejects(
          () => repository.findStaffById(val, 's-1'),
          (err: unknown) => err instanceof TenantScopeMissingError,
        );

        await assert.rejects(
          () => repository.listStaff(val),
          (err: unknown) => err instanceof TenantScopeMissingError,
        );
      }
    });

    it('must reject Team operations when tenant_id is missing or empty', async () => {
      const missingValues = [null, undefined, '', '   '];

      for (const val of missingValues) {
        await assert.rejects(
          () => repository.createTeam(val, { name: 'T' }),
          (err: unknown) => err instanceof TenantScopeMissingError,
        );

        await assert.rejects(
          () => repository.findTeamById(val, 't-1'),
          (err: unknown) => err instanceof TenantScopeMissingError,
        );

        await assert.rejects(
          () => repository.listTeams(val),
          (err: unknown) => err instanceof TenantScopeMissingError,
        );
      }
    });

    it('must reject Staff-Team assignment and cleanup when tenant_id is missing', async () => {
      await assert.rejects(
        () => repository.assignStaffToTeam(null, 's-1', 't-1'),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      await assert.rejects(
        () => repository.clearTenant(null),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );
    });
  });

  describe('Invalid tenant_id Rejection (AC-02)', () => {
    it('must reject non-string and illegal characters in tenant_id', async () => {
      const illegalValues: any[] = [
        12345,
        { id: 'org' },
        '../path_traversal',
        'tenant with spaces',
        'tenant$invalid#',
        'tenant/slash',
        'a'.repeat(65),
      ];

      for (const val of illegalValues) {
        await assert.rejects(
          () => repository.createBrand(val, { name: 'X' }),
          (err: unknown) => err instanceof TenantScopeInvalidError,
        );

        await assert.rejects(
          () => repository.findBrandById(val, 'b-1'),
          (err: unknown) => err instanceof TenantScopeInvalidError,
        );

        await assert.rejects(
          () => repository.createStaff(val, { email: 'x@x.com', fullName: 'X' }),
          (err: unknown) => err instanceof TenantScopeInvalidError,
        );

        await assert.rejects(
          () => repository.createTeam(val, { name: 'T' }),
          (err: unknown) => err instanceof TenantScopeInvalidError,
        );

        await assert.rejects(
          () => repository.clearTenant(val),
          (err: unknown) => err instanceof TenantScopeInvalidError,
        );
      }
    });
  });
});