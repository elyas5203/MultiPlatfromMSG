import { describe, it, before, after, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'node:crypto';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { PrismaService } from '../src/database/prisma.service';
import { TenantRepository } from '../src/tenant/tenant.repository';
import { AuthRepository } from '../src/auth/auth.repository';
import { AuthService } from '../src/auth/auth.service';
import { PasswordHasher } from '../src/auth/password-hasher';
import { SessionTokenService } from '../src/auth/session-token.service';
import { AuthConfig } from '../src/auth/auth.config';
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

describe('Authentication & Session Integration Tests (TASK-0015)', () => {
  let app: any;
  let tenantRepo: TenantRepository;
  let authRepo: AuthRepository;
  let authService: AuthService;
  let prisma: PrismaService;
  let isTargetVerified = false;
  let baseUrl = '';

  const RUN_SEED = crypto.randomBytes(4).toString('hex');
  const TENANT_ALPHA = `org_auth_alpha_${RUN_SEED}`;
  const TENANT_BETA = `org_auth_beta_${RUN_SEED}`;
  const SLUG_ALPHA = `slug-auth-alpha-${RUN_SEED}`;
  const SLUG_BETA = `slug-auth-beta-${RUN_SEED}`;

  before(async () => {
    isTargetVerified = false;

    // Fail-closed target validation
    validateDatabaseUrlSafety(process.env.DATABASE_URL);

    // Initialize NestJS HTTP Application
    app = await NestFactory.create(AppModule, { logger: false });
    tenantRepo = app.get(TenantRepository);
    authRepo = app.get(AuthRepository);
    authService = app.get(AuthService);
    prisma = app.get(PrismaService);

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

    const dbNameRows = await prisma.$queryRawUnsafe<{ current_database: string }[]>(
      'SELECT current_database()',
    );
    validateDatabaseName(dbNameRows[0]?.current_database);

    await assertPreProvisionedTestDatabaseMarker(prisma);
    isTargetVerified = true;

    // Start listening on a random ephemeral loopback port for HTTP integration tests
    await app.listen(0, '127.0.0.1');
    const server = app.getHttpServer();
    const address = server.address();
    const port = typeof address === 'string' ? address : address?.port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    if (!isTargetVerified) {
      if (app) await app.close();
      return;
    }

    if (tenantRepo) {
      try {
        await tenantRepo.clearTenant(TENANT_ALPHA);
        await tenantRepo.clearTenant(TENANT_BETA);
      } catch {
        // Suppress during teardown
      }
    }

    if (app) await app.close();
  });

  beforeEach(async () => {
    if (!isTargetVerified) return;

    await tenantRepo.clearTenant(TENANT_ALPHA);
    await tenantRepo.clearTenant(TENANT_BETA);

    await tenantRepo.createTenant({
      id: TENANT_ALPHA,
      name: `Alpha Auth ${RUN_SEED}`,
      slug: SLUG_ALPHA,
    });

    await tenantRepo.createTenant({
      id: TENANT_BETA,
      name: `Beta Auth ${RUN_SEED}`,
      slug: SLUG_BETA,
    });
  });

  describe('AC-01: Schema & Composite Foreign Key Constraint Verification', () => {
    it('should create staff with username and password hash, enforcing tenant-scoped uniqueness', async () => {
      const hash1 = await PasswordHasher.hash('SampleSecurePassword123!');
      const staff1 = await authRepo.createStaffWithPassword(TENANT_ALPHA, {
        username: `alice_${RUN_SEED}`,
        email: `alice_${RUN_SEED}@alpha.example.com`,
        fullName: 'Alice Alpha',
        role: 'MEMBER',
        passwordHash: hash1,
      });

      assert.strictEqual(staff1.tenantId, TENANT_ALPHA);
      assert.strictEqual(staff1.username, `alice_${RUN_SEED}`);
      assert.strictEqual(staff1.passwordHash, hash1);
      assert.strictEqual(staff1.failedLoginAttempts, 0);

      // Verify that the same username CAN exist in a different tenant (tenant-scoped uniqueness)
      const hash2 = await PasswordHasher.hash('SampleSecurePasswordBeta123!');
      const staffBeta = await authRepo.createStaffWithPassword(TENANT_BETA, {
        username: `alice_${RUN_SEED}`,
        email: `alice_${RUN_SEED}@beta.example.com`,
        fullName: 'Alice Beta',
        role: 'MEMBER',
        passwordHash: hash2,
      });
      assert.strictEqual(staffBeta.tenantId, TENANT_BETA);
      assert.strictEqual(staffBeta.username, `alice_${RUN_SEED}`);

      // Verify that duplicate username in the SAME tenant is rejected by unique constraint
      await assert.rejects(
        async () => {
          await authRepo.createStaffWithPassword(TENANT_ALPHA, {
            username: `alice_${RUN_SEED}`,
            email: `another_${RUN_SEED}@alpha.example.com`,
            fullName: 'Duplicate Alice',
            role: 'MEMBER',
            passwordHash: hash1,
          });
        },
        /Unique constraint failed|duplicate key value/i,
      );
    });

    it('must enforce composite foreign key at database level: session cannot reference cross-tenant staff (AC-01 negative test)', async () => {
      const hashAlpha = await PasswordHasher.hash('PasswordAlpha123!');
      const staffAlpha = await authRepo.createStaffWithPassword(TENANT_ALPHA, {
        username: `user_fk_${RUN_SEED}`,
        email: `user_fk_${RUN_SEED}@alpha.example.com`,
        fullName: 'Staff FK Alpha',
        role: 'MEMBER',
        passwordHash: hashAlpha,
      });

      const tokenHash = SessionTokenService.hashToken(SessionTokenService.generateToken());
      const expiresAt = new Date(Date.now() + 86400000);

      // Attempt to insert session under TENANT_BETA referencing staffAlpha (which belongs to TENANT_ALPHA)
      await assert.rejects(
        async () => {
          await prisma.$executeRawUnsafe(
            `INSERT INTO "sessions" ("id", "tenant_id", "staff_id", "token_hash", "expires_at", "updated_at")
             VALUES ($1, $2, $3, $4, $5, $6)`,
            crypto.randomUUID(),
            TENANT_BETA, // Mismatched tenant
            staffAlpha.id, // Staff belonging to TENANT_ALPHA
            tokenHash,
            expiresAt,
            new Date(),
          );
        },
        /foreign key constraint|violates foreign key constraint/i,
      );
    });
  });

  describe('AC-02: HTTP Login & Session & Logout Integration', () => {
    it('should successfully log in via POST /auth/login and return 256-bit bearer token', async () => {
      const rawPassword = 'CorrectSamplePassword2026!';
      const hash = await PasswordHasher.hash(rawPassword);
      const staff = await authRepo.createStaffWithPassword(TENANT_ALPHA, {
        username: `login_user_${RUN_SEED}`,
        email: `login_user_${RUN_SEED}@alpha.example.com`,
        fullName: 'Login User Alpha',
        role: 'MEMBER',
        passwordHash: hash,
      });

      const response = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: TENANT_ALPHA,
          username: `login_user_${RUN_SEED}`,
          password: rawPassword,
        }),
      });

      assert.strictEqual(response.status, 200);
      const body = await response.json();

      assert.ok(body.token, 'Token must be present in response');
      // 32 bytes hex encoded = 64 characters (256 bits)
      assert.strictEqual(body.token.length, 64, 'Token must be at least 256 bits (64 hex characters)');
      assert.ok(body.expiresAt, 'expiresAt must be present');
      assert.strictEqual(body.staff.id, staff.id);
      assert.strictEqual(body.staff.tenantId, TENANT_ALPHA);
      assert.strictEqual(body.staff.username, `login_user_${RUN_SEED}`);

      // Verify database: raw token must NOT be stored anywhere, only token_hash
      const expectedTokenHash = SessionTokenService.hashToken(body.token);
      const dbSession = await prisma.session.findUnique({
        where: { tokenHash: expectedTokenHash },
      });
      assert.ok(dbSession, 'Session must exist in database by token_hash');
      assert.strictEqual(dbSession?.staffId, staff.id);
      assert.strictEqual(dbSession?.tenantId, TENANT_ALPHA);
      assert.strictEqual(dbSession?.revokedAt, null);

      // Verify that querying DB for raw token yields zero records
      const rawTokenMatch = await prisma.$queryRawUnsafe<any[]>(
        `SELECT * FROM "sessions" WHERE "token_hash" = $1`,
        body.token,
      );
      assert.strictEqual(rawTokenMatch.length, 0, 'Raw token must never exist in the database');
    });

    it('must reject wrong password, wrong user, wrong tenant, and inactive user with IDENTICAL generic message (AC-02)', async () => {
      const rawPassword = 'ValidSecretPassword123!';
      const hash = await PasswordHasher.hash(rawPassword);

      // 1. Active user in Alpha
      await authRepo.createStaffWithPassword(TENANT_ALPHA, {
        username: `user_active_${RUN_SEED}`,
        email: `user_active_${RUN_SEED}@alpha.example.com`,
        fullName: 'Active User',
        role: 'MEMBER',
        status: 'ACTIVE',
        passwordHash: hash,
      });

      // 2. Inactive user in Alpha
      await authRepo.createStaffWithPassword(TENANT_ALPHA, {
        username: `user_inactive_${RUN_SEED}`,
        email: `user_inactive_${RUN_SEED}@alpha.example.com`,
        fullName: 'Inactive User',
        role: 'MEMBER',
        status: 'INACTIVE',
        passwordHash: hash,
      });

      // Case A: Wrong password
      const resWrongPw = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: TENANT_ALPHA,
          username: `user_active_${RUN_SEED}`,
          password: 'WrongPassword!',
        }),
      });
      const bodyWrongPw = await resWrongPw.json();

      // Case B: Non-existent user
      const resNonExistentUser = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: TENANT_ALPHA,
          username: `non_existent_${RUN_SEED}`,
          password: rawPassword,
        }),
      });
      const bodyNonExistentUser = await resNonExistentUser.json();

      // Case C: Non-existent tenant
      const resNonExistentTenant = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: 'non_existent_tenant_999',
          username: `user_active_${RUN_SEED}`,
          password: rawPassword,
        }),
      });
      const bodyNonExistentTenant = await resNonExistentTenant.json();

      // Case D: Inactive user
      const resInactiveUser = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: TENANT_ALPHA,
          username: `user_inactive_${RUN_SEED}`,
          password: rawPassword,
        }),
      });
      const bodyInactiveUser = await resInactiveUser.json();

      // All 4 cases must return HTTP 401
      assert.strictEqual(resWrongPw.status, 401);
      assert.strictEqual(resNonExistentUser.status, 401);
      assert.strictEqual(resNonExistentTenant.status, 401);
      assert.strictEqual(resInactiveUser.status, 401);

      // All 4 cases must return identical message
      assert.strictEqual(bodyWrongPw.message, 'Invalid credentials');
      assert.strictEqual(bodyNonExistentUser.message, 'Invalid credentials');
      assert.strictEqual(bodyNonExistentTenant.message, 'Invalid credentials');
      assert.strictEqual(bodyInactiveUser.message, 'Invalid credentials');
    });

    it('should revoke session on logout and reject subsequent authenticated requests (AC-02)', async () => {
      const rawPassword = 'LogoutPassword123!';
      const hash = await PasswordHasher.hash(rawPassword);
      await authRepo.createStaffWithPassword(TENANT_ALPHA, {
        username: `logout_test_${RUN_SEED}`,
        email: `logout_test_${RUN_SEED}@alpha.example.com`,
        fullName: 'Logout User',
        role: 'MEMBER',
        passwordHash: hash,
      });

      const loginRes = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: TENANT_ALPHA,
          username: `logout_test_${RUN_SEED}`,
          password: rawPassword,
        }),
      });
      const { token } = await loginRes.json();

      // Verify session is valid before logout
      const validationBefore = await authService.validateSession(token);
      assert.strictEqual(validationBefore.staff.username, `logout_test_${RUN_SEED}`);

      // Call POST /auth/logout
      const logoutRes = await fetch(`${baseUrl}/auth/logout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
      });
      assert.strictEqual(logoutRes.status, 200);

      // Verify database shows revoked_at is set
      const tokenHash = SessionTokenService.hashToken(token);
      const sessionInDb = await prisma.session.findUnique({ where: { tokenHash } });
      assert.ok(sessionInDb?.revokedAt !== null, 'revokedAt must be populated');

      // Verify session validation now fails
      await assert.rejects(
        async () => authService.validateSession(token),
        /Invalid or expired session/i,
      );
    });
  });

  describe('AC-03: Change Password & Reset Password Integration', () => {
    it('should change password, require current password, and invalidate other sessions (AC-03)', async () => {
      const initialPassword = 'InitialSecurePassword123!';
      const hash = await PasswordHasher.hash(initialPassword);
      const staff = await authRepo.createStaffWithPassword(TENANT_ALPHA, {
        username: `pw_change_${RUN_SEED}`,
        email: `pw_change_${RUN_SEED}@alpha.example.com`,
        fullName: 'PW Change User',
        role: 'MEMBER',
        passwordHash: hash,
      });

      // Login session 1
      const login1 = await authService.login(TENANT_ALPHA, staff.username!, initialPassword);
      // Login session 2
      const login2 = await authService.login(TENANT_ALPHA, staff.username!, initialPassword);

      // Verify both sessions active
      await authService.validateSession(login1.token);
      await authService.validateSession(login2.token);

      // Attempt change password with wrong current password -> rejected
      const failRes = await fetch(`${baseUrl}/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${login1.token}`,
        },
        body: JSON.stringify({
          currentPassword: 'WrongCurrentPassword!',
          newPassword: 'BrandNewSecurePassword456!',
        }),
      });
      assert.strictEqual(failRes.status, 400);

      // Attempt change password with short new password -> rejected
      const shortRes = await fetch(`${baseUrl}/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${login1.token}`,
        },
        body: JSON.stringify({
          currentPassword: initialPassword,
          newPassword: 'short',
        }),
      });
      assert.strictEqual(shortRes.status, 400);

      // Valid change password from session 1
      const newPassword = 'BrandNewSecurePassword456!';
      const changeRes = await fetch(`${baseUrl}/auth/change-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${login1.token}`,
        },
        body: JSON.stringify({
          currentPassword: initialPassword,
          newPassword,
        }),
      });
      assert.strictEqual(changeRes.status, 200);

      // Session 1 remains valid
      const session1Check = await authService.validateSession(login1.token);
      assert.strictEqual(session1Check.staff.id, staff.id);

      // Session 2 MUST BE REVOKED
      await assert.rejects(
        async () => authService.validateSession(login2.token),
        /Invalid or expired session/i,
      );

      // Old password cannot log in
      await assert.rejects(
        async () => authService.login(TENANT_ALPHA, staff.username!, initialPassword),
        /Invalid credentials/i,
      );

      // New password logs in successfully
      const newLogin = await authService.login(TENANT_ALPHA, staff.username!, newPassword);
      assert.ok(newLogin.token);
    });

    it('should allow admin to reset password and strictly reject cross-tenant resets (AC-03)', async () => {
      const adminPassword = 'AdminPassword123!';
      const adminHash = await PasswordHasher.hash(adminPassword);
      const adminAlpha = await authRepo.createStaffWithPassword(TENANT_ALPHA, {
        username: `admin_alpha_${RUN_SEED}`,
        email: `admin_alpha_${RUN_SEED}@alpha.example.com`,
        fullName: 'Admin Alpha',
        role: 'ADMIN',
        passwordHash: adminHash,
      });

      const memberPassword = 'MemberPassword123!';
      const memberHash = await PasswordHasher.hash(memberPassword);
      const memberAlpha = await authRepo.createStaffWithPassword(TENANT_ALPHA, {
        username: `member_alpha_${RUN_SEED}`,
        email: `member_alpha_${RUN_SEED}@alpha.example.com`,
        fullName: 'Member Alpha',
        role: 'MEMBER',
        passwordHash: memberHash,
      });

      const memberBeta = await authRepo.createStaffWithPassword(TENANT_BETA, {
        username: `member_beta_${RUN_SEED}`,
        email: `member_beta_${RUN_SEED}@beta.example.com`,
        fullName: 'Member Beta',
        role: 'MEMBER',
        passwordHash: memberHash,
      });

      const adminLogin = await authService.login(TENANT_ALPHA, adminAlpha.username!, adminPassword);
      const memberAlphaLogin = await authService.login(TENANT_ALPHA, memberAlpha.username!, memberPassword);

      // Negative Test 1: Non-admin member attempts reset -> 403 Forbidden
      const memberResetRes = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${memberAlphaLogin.token}`,
        },
        body: JSON.stringify({
          tenantId: TENANT_ALPHA,
          staffId: memberAlpha.id,
          newPassword: 'NewPassword999!',
        }),
      });
      assert.strictEqual(memberResetRes.status, 403);

      // Negative Test 2: Admin of Alpha attempts cross-tenant reset on Member in Beta -> 403 Forbidden
      const crossTenantRes = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminLogin.token}`,
        },
        body: JSON.stringify({
          tenantId: TENANT_BETA,
          staffId: memberBeta.id,
          newPassword: 'NewPassword999!',
        }),
      });
      assert.strictEqual(crossTenantRes.status, 403);

      // Positive Test: Admin Alpha resets Member Alpha password
      const newMemberPw = 'FreshAdminAssignedPassword888!';
      const validResetRes = await fetch(`${baseUrl}/auth/reset-password`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${adminLogin.token}`,
        },
        body: JSON.stringify({
          tenantId: TENANT_ALPHA,
          staffId: memberAlpha.id,
          newPassword: newMemberPw,
        }),
      });
      assert.strictEqual(validResetRes.status, 200);

      // ALL existing sessions of the target user must be revoked
      await assert.rejects(
        async () => authService.validateSession(memberAlphaLogin.token),
        /Invalid or expired session/i,
      );

      // Member logs in with new password
      const reLogin = await authService.login(TENANT_ALPHA, memberAlpha.username!, newMemberPw);
      assert.ok(reLogin.token);
    });
  });

  describe('AC-04: Lockout, Configuration & Zero Leakage Verification', () => {
    it('must enforce configurable temporary lockout on excessive failed login attempts (AC-04)', async () => {
      const correctPw = 'StrongUserPassword123!';
      const hash = await PasswordHasher.hash(correctPw);
      const staff = await authRepo.createStaffWithPassword(TENANT_ALPHA, {
        username: `lockout_user_${RUN_SEED}`,
        email: `lockout_user_${RUN_SEED}@alpha.example.com`,
        fullName: 'Lockout User',
        role: 'MEMBER',
        passwordHash: hash,
      });

      const maxAttempts = AuthConfig.getValues().maxLoginAttempts; // default 5

      // Fail maxAttempts times
      for (let i = 0; i < maxAttempts; i++) {
        await assert.rejects(
          async () => authService.login(TENANT_ALPHA, staff.username!, 'WrongPassword!'),
          /Invalid credentials/i,
        );
      }

      // Check DB: account is now locked
      const staffAfterFailures = await authRepo.findStaffById(TENANT_ALPHA, staff.id);
      assert.strictEqual(staffAfterFailures?.failedLoginAttempts, maxAttempts);
      assert.ok(staffAfterFailures?.lockedUntil !== null, 'lockedUntil must be set');
      assert.ok(staffAfterFailures?.lockedUntil! > new Date(), 'lockedUntil must be in the future');

      // Attempt login with CORRECT password while locked -> REJECTED
      await assert.rejects(
        async () => authService.login(TENANT_ALPHA, staff.username!, correctPw),
        /Account is temporarily locked/i,
      );
    });

    it('must NEVER output plain passwords, password hashes, or session tokens in error messages (Zero Leakage AC-04)', async () => {
      const sensitivePassword = 'SuperSensitiveSecretPassword_DoNotLeak_999!';

      // Test bad login error payload
      const loginRes = await fetch(`${baseUrl}/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tenantId: TENANT_ALPHA,
          username: `user_${RUN_SEED}`,
          password: sensitivePassword,
        }),
      });
      const errorText = await loginRes.text();

      assert.strictEqual(errorText.includes(sensitivePassword), false, 'Password must not appear in error');
      assert.strictEqual(errorText.includes('$2a$'), false, 'Password hash must not appear in error');
      assert.strictEqual(errorText.includes('$2b$'), false, 'Password hash must not appear in error');
    });
  });
});