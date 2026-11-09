import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
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
 * 3. Test Isolation: This suite requires an explicit DATABASE_URL pointing to a dedicated
 *    test database. It does not auto-spawn, kill, or wipe arbitrary host processes or ports.
 */

describe('PostgreSQL Database Multi-Tenancy Boundary & Integrity Verification (AC-02)', () => {
  let app: any;
  let repository: TenantRepository;
  let prisma: PrismaService;

  // Synthetic test tenant IDs
  const TENANT_ALPHA = 'org_synthetic_alpha_101';
  const TENANT_BETA = 'org_synthetic_beta_202';

  before(async () => {
    const dbUrl = process.env.DATABASE_URL;
    if (!dbUrl) {
      throw new Error(
        'DATABASE_URL environment variable is required to run PostgreSQL integration tests.',
      );
    }

    // Initialize NestJS Application Context & resolve providers
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    repository = app.get(TenantRepository);
    prisma = app.get(PrismaService);

    // Verify database connectivity
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
      throw new Error(`Unable to connect to PostgreSQL database at ${dbUrl}`);
    }
  });

  after(async () => {
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
    // Clean state before each test strictly per-tenant (no cross-tenant wipe)
    await repository.clearTenant(TENANT_ALPHA);
    await repository.clearTenant(TENANT_BETA);

    // Seed test tenants
    await repository.createTenant({
      id: TENANT_ALPHA,
      name: 'Alpha Synthetic Corp',
      slug: 'alpha-corp-synthetic',
    });

    await repository.createTenant({
      id: TENANT_BETA,
      name: 'Beta Synthetic LLC',
      slug: 'beta-llc-synthetic',
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
        email: 'alice@alpha.example.com',
        fullName: 'Alice Alpha',
        role: 'ADMIN',
      });

      const staffBeta = await repository.createStaff(TENANT_BETA, {
        email: 'bob@beta.example.com',
        fullName: 'Bob Beta',
        role: 'MEMBER',
      });

      assert.strictEqual(staffAlpha.tenantId, TENANT_ALPHA);
      assert.strictEqual(staffBeta.tenantId, TENANT_BETA);

      // Verify legitimate query
      const readAlpha = await repository.findStaffById(TENANT_ALPHA, staffAlpha.id);
      assert.ok(readAlpha);
      assert.strictEqual(readAlpha?.email, 'alice@alpha.example.com');

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
        email: 'alice.member@alpha.example.com',
        fullName: 'Alice Member',
      });

      const teamAlpha = await repository.createTeam(TENANT_ALPHA, {
        name: 'Alpha Engineering',
      });

      const staffBeta = await repository.createStaff(TENANT_BETA, {
        email: 'bob.member@beta.example.com',
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
        email: 'alice.fk@alpha.example.com',
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
            'st-cross-1',
            TENANT_ALPHA,
            staffAlpha.id,
            teamBeta.id,
          );
        },
        (err: any) => {
          // PostgreSQL foreign key violation error (code 23503 / Prisma P2003 / P2010)
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
            'st-cross-2',
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