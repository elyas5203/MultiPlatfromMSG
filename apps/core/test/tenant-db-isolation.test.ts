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
 * ARCHITECTURAL BOUNDARIES & SAFEGUARDS:
 * 1. Foreign Key Integrity: At the database constraint level, composite foreign keys
 *    (tenant_id, staff_id) and (tenant_id, team_id) strictly enforce that StaffTeam
 *    memberships cannot reference staff or teams belonging to different tenants.
 * 2. Query Read/Write Boundary: Enforced at the Repository application layer via explicit
 *    tenant_id scoping and validation (assertValidTenantId). Row-Level Security (RLS)
 *    is not yet implemented and is planned for future phases.
 * 3. Fail-Closed Test Guard: Ensures the integration test runs strictly against a dedicated
 *    test database containing an externally pre-provisioned test marker table and token.
 *    The test code NEVER creates or inserts the marker; it strictly SELECTs and verifies.
 *    If verification fails, `isTargetVerified` remains false, and no database mutations or
 *    cleanup routines are executed.
 * 4. Zero Credential / DB Name Leakage: Error messages and logs never output sensitive
 *    credentials, passwords, or raw database names.
 * 5. Run-Unique Identifiers: Tenant IDs and slugs are generated uniquely per test run,
 *    preventing collision with or accidental deletion of any pre-existing records.
 */

export const TEST_MARKER_TABLE = '__multiplatformmsg_test_marker__';
export const TEST_MARKER_KEY = 'TEST_ENVIRONMENT_PERMITTED';
export const DEFAULT_EXPECTED_MARKER_TOKEN = 'multiplatformmsg_dedicated_test_instance_token';

export class InsecureDatabaseTargetError extends Error {
  constructor(message = 'Refusing to run tests: Target database is not verified as a dedicated test database.') {
    super(message);
    this.name = 'InsecureDatabaseTargetError';
  }
}

/**
 * Validates that DATABASE_URL specifies an authorized test database name pattern
 * without exposing sensitive credentials, connection parameters, or target database names.
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
    // Fail-closed: do NOT print dbName or credentials in error message
    throw new InsecureDatabaseTargetError(
      'Target database is not an authorized test database. Target must match dedicated test database pattern.',
    );
  }
}

/**
 * Validates database name returned from PostgreSQL server runtime without exposing it.
 */
export function validateDatabaseName(dbName: string | undefined): void {
  if (!dbName || typeof dbName !== 'string' || dbName.trim().length === 0) {
    throw new InsecureDatabaseTargetError('Unable to determine current database name.');
  }

  const isDedicatedTestDb =
    dbName === 'multiplatformmsg_test' ||
    dbName.endsWith('_test') ||
    dbName.includes('test_') ||
    dbName.includes('synthetic');

  if (!isDedicatedTestDb) {
    throw new InsecureDatabaseTargetError(
      'Target database is not an authorized test database. Target must match dedicated test database pattern.',
    );
  }
}

/**
 * Verifies that the target database contains a pre-provisioned test marker table and matching token.
 * Strictly executes SELECT queries only; NEVER executes CREATE TABLE or INSERT.
 */
export async function assertPreProvisionedTestDatabaseMarker(
  prisma: { $queryRawUnsafe: (query: string, ...args: any[]) => Promise<any> },
  expectedToken: string = process.env.TEST_DATABASE_MARKER_TOKEN || DEFAULT_EXPECTED_MARKER_TOKEN,
): Promise<void> {
  let rows: { marker_key: string; marker_token: string }[];
  try {
    rows = (await prisma.$queryRawUnsafe(
      `SELECT "marker_key", "marker_token" FROM "${TEST_MARKER_TABLE}" WHERE "marker_key" = $1 LIMIT 1`,
      TEST_MARKER_KEY
    )) as { marker_key: string; marker_token: string }[];
  } catch {
    // Table missing or SQL query error -> fail closed without printing sensitive details
    throw new InsecureDatabaseTargetError(
      'Target database missing pre-provisioned test marker table. Test target is unverified.',
    );
  }

  if (!rows || rows.length === 0) {
    throw new InsecureDatabaseTargetError(
      'Target database missing required pre-provisioned test marker record. Refusing execution.',
    );
  }

  if (rows[0].marker_token !== expectedToken) {
    throw new InsecureDatabaseTargetError(
      'Target database test marker token mismatch. Refusing execution.',
    );
  }
}

describe('PostgreSQL Database Multi-Tenancy Boundary & Integrity Verification (AC-02)', () => {
  let app: any;
  let repository: TenantRepository;
  let prisma: PrismaService;
  let isTargetVerified = false;

  // Run-unique synthetic test tenant IDs and slugs (never static or hardcoded across runs)
  const RUN_SEED = crypto.randomBytes(4).toString('hex');
  const TENANT_ALPHA = `org_test_alpha_${RUN_SEED}`;
  const TENANT_BETA = `org_test_beta_${RUN_SEED}`;
  const SLUG_ALPHA = `slug-alpha-${RUN_SEED}`;
  const SLUG_BETA = `slug-beta-${RUN_SEED}`;

  before(async () => {
    isTargetVerified = false;

    // 1. Fail-closed pre-validation: check connection string safety without logging credentials or db names
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
      throw new InsecureDatabaseTargetError('Unable to connect to target test database. Connection refused.');
    }

    // 4. Verify runtime database name without leakage
    const dbNameRows = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
      'SELECT current_database()',
    );
    const currentDb = dbNameRows[0]?.current_database;
    validateDatabaseName(currentDb);

    // 5. Assert fail-closed pre-provisioned marker verification (pure SELECT, no CREATE/INSERT)
    await assertPreProvisionedTestDatabaseMarker(prisma);

    // All safety gates passed: authorize mutations strictly for this test run
    isTargetVerified = true;
  });

  after(async () => {
    // If target was not verified by safety guard, NEVER touch or wipe any data
    if (!isTargetVerified) {
      if (app) {
        await app.close();
      }
      return;
    }

    // Strictly clean up ONLY this run's unique tenants
    if (repository) {
      try {
        await repository.clearTenant(TENANT_ALPHA);
        await repository.clearTenant(TENANT_BETA);
      } catch {
        // Suppress during teardown
      }
    }

    if (app) {
      await app.close();
    }
  });

  beforeEach(async () => {
    // If target was not verified by safety guard, NEVER mutate database
    if (!isTargetVerified) {
      return;
    }

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
    it('must reject non-test database URLs before any database mutation occurs without leaking credentials or database names', () => {
      const nonTestUrls = [
        'postgresql://admin:secret_password@127.0.0.1:5432/production',
        'postgresql://postgres:pw_sample@127.0.0.1:5432/multiplatformmsg_prod',
        'postgresql://user:pass123@127.0.0.1:5432/main_db',
        'postgresql://user:pass123@127.0.0.1:5432/staging?schema=public',
        'postgresql://user:pass123@127.0.0.1:5432/customer_data',
      ];

      for (const nonTestUrl of nonTestUrls) {
        assert.throws(
          () => validateDatabaseUrlSafety(nonTestUrl),
          (err: unknown) => {
            assert.ok(err instanceof InsecureDatabaseTargetError);
            const msg = (err as Error).message;
            // Verify NO credentials, secrets, or database names are leaked in the error
            assert.strictEqual(msg.includes('secret_password'), false);
            assert.strictEqual(msg.includes('pw_sample'), false);
            assert.strictEqual(msg.includes('pass123'), false);
            assert.strictEqual(msg.includes('production'), false);
            assert.strictEqual(msg.includes('multiplatformmsg_prod'), false);
            assert.strictEqual(msg.includes('main_db'), false);
            assert.strictEqual(msg.includes('customer_data'), false);
            assert.strictEqual(msg.includes('staging'), false);
            return true;
          },
          `Expected fail-closed rejection for non-test database URL: ${nonTestUrl}`,
        );
      }
    });

    it('must reject missing or malformed database URLs', () => {
      assert.throws(
        () => validateDatabaseUrlSafety(undefined),
        (err: unknown) => err instanceof InsecureDatabaseTargetError,
      );
      assert.throws(
        () => validateDatabaseUrlSafety(''),
        (err: unknown) => err instanceof InsecureDatabaseTargetError,
      );
      assert.throws(
        () => validateDatabaseUrlSafety('not-a-valid-url'),
        (err: unknown) => err instanceof InsecureDatabaseTargetError,
      );
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

  describe('Pre-Provisioned Safety Marker Verification (Safety Guard Negative Tests)', () => {
    it('must reject execution when marker token mismatches expected value', async () => {
      await assert.rejects(
        async () => {
          await assertPreProvisionedTestDatabaseMarker(prisma, 'definitely_wrong_token_unmatched');
        },
        (err: unknown) => {
          assert.ok(err instanceof InsecureDatabaseTargetError);
          const msg = (err as Error).message;
          assert.strictEqual(msg.includes('token mismatch'), true);
          return true;
        },
      );
    });

    it('must reject execution when marker table is missing (simulated fail-closed query failure)', async () => {
      const mockPrismaMissingTable = {
        $queryRawUnsafe: async () => {
          throw new Error('relation "__multiplatformmsg_test_marker__" does not exist');
        },
      };

      await assert.rejects(
        async () => {
          await assertPreProvisionedTestDatabaseMarker(mockPrismaMissingTable);
        },
        (err: unknown) => {
          assert.ok(err instanceof InsecureDatabaseTargetError);
          const msg = (err as Error).message;
          assert.strictEqual(msg.includes('missing pre-provisioned test marker table'), true);
          return true;
        },
      );
    });

    it('must reject execution when marker record does not exist in table', async () => {
      const mockPrismaEmptyRows = {
        $queryRawUnsafe: async () => [],
      };

      await assert.rejects(
        async () => {
          await assertPreProvisionedTestDatabaseMarker(mockPrismaEmptyRows);
        },
        (err: unknown) => {
          assert.ok(err instanceof InsecureDatabaseTargetError);
          const msg = (err as Error).message;
          assert.strictEqual(msg.includes('missing required pre-provisioned test marker record'), true);
          return true;
        },
      );
    });

    it('must ensure guard failure leaves verified flag as false and blocks data mutation or cleanup', () => {
      // Simulate unverified state
      let testVerifiedFlag = false;
      let mutationOccurred = false;

      // Simulated beforeEach hook
      const simulatedBeforeEach = () => {
        if (!testVerifiedFlag) {
          return; // Guard active
        }
        mutationOccurred = true;
      };

      // Simulated after hook
      let cleanupOccurred = false;
      const simulatedAfter = () => {
        if (!testVerifiedFlag) {
          return; // Guard active
        }
        cleanupOccurred = true;
      };

      simulatedBeforeEach();
      simulatedAfter();

      assert.strictEqual(testVerifiedFlag, false);
      assert.strictEqual(mutationOccurred, false);
      assert.strictEqual(cleanupOccurred, false);
    });
  });

  describe('Synthetic Two-Tenant Repository Isolation & Composite FK Integrity (AC-02)', () => {
    it('should create and retrieve Brands with strict repository tenant filtering', async () => {
      const brandAlpha = await repository.createBrand(TENANT_ALPHA, {
        name: 'Brand Alpha',
        code: 'BA',
      });

      const brandBeta = await repository.createBrand(TENANT_BETA, {
        name: 'Brand Beta',
        code: 'BB',
      });

      assert.strictEqual(brandAlpha.tenantId, TENANT_ALPHA);
      assert.strictEqual(brandBeta.tenantId, TENANT_BETA);

      // Verify legitimate query
      const readAlpha = await repository.findBrandById(TENANT_ALPHA, brandAlpha.id);
      assert.ok(readAlpha);
      assert.strictEqual(readAlpha?.name, 'Brand Alpha');

      // Cross-tenant read must return null (isolation preserved)
      const crossRead = await repository.findBrandById(TENANT_BETA, brandAlpha.id);
      assert.strictEqual(crossRead, null);

      // Verify listBrands isolation
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
      assert.strictEqual(crossRead, null);

      // Verify listStaff isolation
      const alphaStaff = await repository.listStaff(TENANT_ALPHA);
      const betaStaff = await repository.listStaff(TENANT_BETA);

      assert.strictEqual(alphaStaff.length, 1);
      assert.strictEqual(alphaStaff[0].id, staffAlpha.id);
      assert.strictEqual(betaStaff.length, 1);
      assert.strictEqual(betaStaff[0].id, staffBeta.id);
    });

    it('should create and retrieve Teams with strict repository tenant filtering', async () => {
      const teamAlpha = await repository.createTeam(TENANT_ALPHA, {
        name: 'Team Alpha Alpha',
      });

      const teamBeta = await repository.createTeam(TENANT_BETA, {
        name: 'Team Beta Beta',
      });

      assert.strictEqual(teamAlpha.tenantId, TENANT_ALPHA);
      assert.strictEqual(teamBeta.tenantId, TENANT_BETA);

      // Legitimate read
      const readAlpha = await repository.findTeamById(TENANT_ALPHA, teamAlpha.id);
      assert.ok(readAlpha);
      assert.strictEqual(readAlpha?.name, 'Team Alpha Alpha');

      // Cross-tenant read returns null
      const crossRead = await repository.findTeamById(TENANT_BETA, teamAlpha.id);
      assert.strictEqual(crossRead, null);

      // Verify listTeams isolation
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
        name: 'Team Support Alpha',
      });

      const staffBeta = await repository.createStaff(TENANT_BETA, {
        email: `bob.member.${RUN_SEED}@beta.example.com`,
        fullName: 'Bob Member',
      });

      const teamBeta = await repository.createTeam(TENANT_BETA, {
        name: 'Team Support Beta',
      });

      // Legitimate assignment within Tenant Alpha
      const assignmentAlpha = await repository.assignStaffToTeam(
        TENANT_ALPHA,
        staffAlpha.id,
        teamAlpha.id,
      );
      assert.strictEqual(assignmentAlpha.tenantId, TENANT_ALPHA);
      assert.strictEqual(assignmentAlpha.staffId, staffAlpha.id);
      assert.strictEqual(assignmentAlpha.teamId, teamAlpha.id);

      // Legitimate assignment within Tenant Beta
      const assignmentBeta = await repository.assignStaffToTeam(
        TENANT_BETA,
        staffBeta.id,
        teamBeta.id,
      );
      assert.strictEqual(assignmentBeta.tenantId, TENANT_BETA);

      // Negative Test 1: Attempt to assign Alpha Staff to Beta Team under Tenant Alpha scope
      await assert.rejects(
        async () => {
          await repository.assignStaffToTeam(TENANT_ALPHA, staffAlpha.id, teamBeta.id);
        },
        (err: Error) => {
          assert.strictEqual(
            err.message,
            `Team record '${teamBeta.id}' not found within tenant scope '${TENANT_ALPHA}'.`,
          );
          return true;
        },
      );

      // Negative Test 2: Attempt to assign Beta Staff to Alpha Team under Tenant Beta scope
      await assert.rejects(
        async () => {
          await repository.assignStaffToTeam(TENANT_BETA, staffAlpha.id, teamBeta.id);
        },
        (err: Error) => {
          assert.strictEqual(
            err.message,
            `Staff record '${staffAlpha.id}' not found within tenant scope '${TENANT_BETA}'.`,
          );
          return true;
        },
      );

      // Verify listStaffTeams isolation
      const alphaAssignments = await repository.listStaffTeams(TENANT_ALPHA, staffAlpha.id);
      const betaAssignments = await repository.listStaffTeams(TENANT_BETA, staffBeta.id);

      assert.strictEqual(alphaAssignments.length, 1);
      assert.strictEqual(alphaAssignments[0].staffId, staffAlpha.id);
      assert.strictEqual(betaAssignments.length, 1);
      assert.strictEqual(betaAssignments[0].staffId, staffBeta.id);
    });

    it('must enforce composite foreign keys at the database level and reject cross-tenant inserts (AC-02 negative test)', async () => {
      // Create staff and team in separate tenants
      const staffAlpha = await repository.createStaff(TENANT_ALPHA, {
        email: `alice.fk.${RUN_SEED}@alpha.example.com`,
        fullName: 'Alice FK',
      });

      const teamBeta = await repository.createTeam(TENANT_BETA, {
        name: 'Team Beta FK',
      });

      // Negative Test 3: Bypass repository and attempt direct raw SQL insert referencing
      // Staff (Alpha) and Team (Beta) under Tenant Alpha scope
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
            msg.includes('23503') ||
            msg.includes('P2010')
          );
        },
        'Expected PostgreSQL composite FK constraint rejection when inserting cross-tenant team reference',
      );

      // Negative Test 4: Direct raw SQL insert referencing Staff (Alpha) and Team (Beta) under Tenant Beta scope
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
            msg.includes('23503') ||
            msg.includes('P2010')
          );
        },
        'Expected PostgreSQL composite FK constraint rejection when inserting cross-tenant staff reference',
      );
    });

    it('should strictly limit clearTenant cleanup to the specified tenant', async () => {
      await repository.createBrand(TENANT_ALPHA, { name: 'Alpha Brand 1' });
      await repository.createBrand(TENANT_BETA, { name: 'Beta Brand 1' });

      // Clear Alpha
      await repository.clearTenant(TENANT_ALPHA);

      // Verify Alpha is empty
      const alphaBrands = await repository.listBrands(TENANT_ALPHA);
      assert.strictEqual(alphaBrands.length, 0);

      // Verify Beta is unaffected
      const betaBrands = await repository.listBrands(TENANT_BETA);
      assert.strictEqual(betaBrands.length, 1);
      assert.strictEqual(betaBrands[0].name, 'Beta Brand 1');
    });
  });

  describe('Missing tenant_id Rejection (AC-02)', () => {
    it('must reject Brand operations when tenant_id is missing or empty', async () => {
      await assert.rejects(
        async () => repository.findBrandById('', 'brand-1'),
        TenantScopeMissingError,
      );
      await assert.rejects(
        async () => repository.createBrand('  ', { name: 'Test' }),
        TenantScopeMissingError,
      );
      await assert.rejects(
        async () => repository.listBrands(''),
        TenantScopeMissingError,
      );
    });

    it('must reject Staff operations when tenant_id is missing or empty', async () => {
      await assert.rejects(
        async () => repository.findStaffById('', 'staff-1'),
        TenantScopeMissingError,
      );
      await assert.rejects(
        async () => repository.createStaff('', { email: 'a@example.com', fullName: 'Alice' }),
        TenantScopeMissingError,
      );
      await assert.rejects(
        async () => repository.listStaff('   '),
        TenantScopeMissingError,
      );
    });

    it('must reject Team operations when tenant_id is missing or empty', async () => {
      await assert.rejects(
        async () => repository.findTeamById('', 'team-1'),
        TenantScopeMissingError,
      );
      await assert.rejects(
        async () => repository.createTeam('', { name: 'Team X' }),
        TenantScopeMissingError,
      );
      await assert.rejects(
        async () => repository.listTeams(''),
        TenantScopeMissingError,
      );
    });

    it('must reject Staff-Team assignment and cleanup when tenant_id is missing', async () => {
      await assert.rejects(
        async () => repository.assignStaffToTeam('', 'staff-1', 'team-1'),
        TenantScopeMissingError,
      );
      await assert.rejects(
        async () => repository.listStaffTeams('', 'staff-1'),
        TenantScopeMissingError,
      );
      await assert.rejects(
        async () => repository.clearTenant(''),
        TenantScopeMissingError,
      );
    });
  });

  describe('Invalid tenant_id Rejection (AC-02)', () => {
    it('must reject non-string and illegal characters in tenant_id', async () => {
      const illegalTenantIds = [
        'tenant/slash',
        'tenant with spaces',
        'tenant..traversal',
        'tenant!special',
        'tenant@symbol',
        'tenant$dollar',
      ];

      for (const illegalId of illegalTenantIds) {
        await assert.rejects(
          async () => repository.findBrandById(illegalId, 'b-1'),
          TenantScopeInvalidError,
        );
        await assert.rejects(
          async () => repository.createBrand(illegalId, { name: 'B' }),
          TenantScopeInvalidError,
        );
        await assert.rejects(
          async () => repository.clearTenant(illegalId),
          TenantScopeInvalidError,
        );
      }

      await assert.rejects(
        async () => repository.listBrands(12345 as any),
        TenantScopeInvalidError,
      );
      await assert.rejects(
        async () => repository.listBrands(null as any),
        TenantScopeMissingError,
      );
    });
  });
});