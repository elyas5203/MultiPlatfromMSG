import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { spawn, ChildProcess, execSync } from 'node:child_process';
import * as net from 'node:net';
import * as fs from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TenantRepository } from '../src/tenant/tenant.repository';
import {
  TenantScopeMissingError,
  TenantScopeInvalidError,
} from '../src/tenant/tenant-scope';

// Ensure DATABASE_URL is pointed to our local test PostgreSQL instance
process.env.DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://postgres@127.0.0.1:54332/postgres?schema=public';

async function isPortOpen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    socket.setTimeout(800);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.on('error', () => {
      socket.destroy();
      resolve(false);
    });
    socket.connect(port, host);
  });
}

describe('PostgreSQL Real Database Multi-Tenancy Isolation & Boundary Verification (AC-02)', () => {
  let app: any;
  let repository: TenantRepository;
  let prisma: PrismaService;
  let spawnedPg: ChildProcess | null = null;

  // Synthetic test tenant IDs
  const TENANT_ALPHA = 'org_synthetic_alpha_101';
  const TENANT_BETA = 'org_synthetic_beta_202';

  before(async () => {
    // 1. Check if PostgreSQL is already listening on 127.0.0.1:54332
    const running = await isPortOpen(54332, '127.0.0.1');
    if (!running) {
      // Look for standalone test postgres binary
      const pgBin = 'C:\\Users\\kingk\\.openmausbot\\tmp\\pg16\\bin\\postgres.exe';
      const pgData = 'C:\\Users\\kingk\\.openmausbot\\tmp\\pg16_data';
      if (fs.existsSync(pgBin) && fs.existsSync(pgData)) {
        spawnedPg = spawn(pgBin, ['-D', pgData, '-p', '54332', '-h', '127.0.0.1'], {
          stdio: 'ignore',
          detached: false,
        });

        for (let i = 0; i < 30; i++) {
          await new Promise((r) => setTimeout(r, 200));
          if (await isPortOpen(54332, '127.0.0.1')) {
            break;
          }
        }
      } else {
        throw new Error(
          'PostgreSQL server is not running on port 54332 and fallback binary not found.',
        );
      }
    }

    // 2. Initialize NestJS Application Context & resolve providers
    app = await NestFactory.createApplicationContext(AppModule, {
      logger: false,
    });
    repository = app.get(TenantRepository);
    prisma = app.get(PrismaService);

    // 3. Retry querying until PostgreSQL is completely query-ready
    let dbReady = false;
    for (let i = 0; i < 50; i++) {
      try {
        await prisma.$queryRawUnsafe('SELECT 1');
        dbReady = true;
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 250));
      }
    }

    if (!dbReady) {
      throw new Error('Timed out waiting for PostgreSQL database to be query-ready');
    }
  });

  after(async () => {
    if (repository) {
      try {
        await repository.clearTenant(TENANT_ALPHA);
        await repository.clearTenant(TENANT_BETA);
      } catch {
        // Ignore cleanup errors during final shutdown
      }
    }

    if (app) {
      await app.close();
    }

    if (spawnedPg) {
      try {
        execSync(
          'C:\\Users\\kingk\\.openmausbot\\tmp\\pg16\\bin\\pg_ctl.exe stop -D C:\\Users\\kingk\\.openmausbot\\tmp\\pg16_data -m immediate',
          { stdio: 'ignore' },
        );
      } catch {
        spawnedPg.kill();
      }
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

  describe('Synthetic Two-Tenant Real Database Isolation (AC-02)', () => {
    it('should create and retrieve Brands with strict database-level tenant isolation', async () => {
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

      // Cross-tenant leak prevention: Tenant Beta must NEVER see Tenant Alpha's brand
      const crossRead = await repository.findBrandById(TENANT_BETA, brandAlpha.id);
      assert.strictEqual(
        crossRead,
        null,
        'Tenant Beta must not be able to read Tenant Alpha brand from PostgreSQL',
      );

      // Collection isolation
      const alphaBrands = await repository.listBrands(TENANT_ALPHA);
      const betaBrands = await repository.listBrands(TENANT_BETA);

      assert.strictEqual(alphaBrands.length, 1);
      assert.strictEqual(alphaBrands[0].id, brandAlpha.id);

      assert.strictEqual(betaBrands.length, 1);
      assert.strictEqual(betaBrands[0].id, brandBeta.id);
    });

    it('should create and retrieve Staff records with strict database-level isolation', async () => {
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

    it('should create and retrieve Teams with strict database-level isolation', async () => {
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

    it('should manage Staff-Team membership and prevent cross-tenant assignment', async () => {
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

      // Cross-tenant membership assignment attempts MUST throw errors:
      // 1. Attempting to assign Tenant Beta's staff to Tenant Alpha's team under Alpha's scope
      await assert.rejects(
        () => repository.assignStaffToTeam(TENANT_ALPHA, staffBeta.id, teamAlpha.id),
        (err: Error) => err.message.includes('not found within tenant scope'),
      );

      // 2. Attempting to assign Tenant Alpha's staff to Tenant Beta's team under Beta's scope
      await assert.rejects(
        () => repository.assignStaffToTeam(TENANT_BETA, staffAlpha.id, teamBeta.id),
        (err: Error) => err.message.includes('not found within tenant scope'),
      );

      // Verify listTeamMembers isolation
      const alphaMembers = await repository.listTeamMembers(TENANT_ALPHA, teamAlpha.id);
      assert.strictEqual(alphaMembers.length, 1);
      assert.strictEqual(alphaMembers[0].staffId, staffAlpha.id);

      // Querying Tenant Alpha's team from Tenant Beta's scope returns empty
      const leakedMembers = await repository.listTeamMembers(TENANT_BETA, teamAlpha.id);
      assert.strictEqual(leakedMembers.length, 0);

      // Verify listStaffTeams isolation
      const alphaStaffTeams = await repository.listStaffTeams(TENANT_ALPHA, staffAlpha.id);
      assert.strictEqual(alphaStaffTeams.length, 1);
      assert.strictEqual(alphaStaffTeams[0].teamId, teamAlpha.id);

      const leakedStaffTeams = await repository.listStaffTeams(TENANT_BETA, staffAlpha.id);
      assert.strictEqual(leakedStaffTeams.length, 0);
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