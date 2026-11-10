import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  Controller,
  Get,
  UseGuards,
  INestApplication,
  Req,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { NestFactory, Reflector } from '@nestjs/core';
import {
  Role,
  RoleScope,
  ROLE_METADATA,
  isValidRole,
  normalizeRole,
  hasRole,
  Roles,
  Public,
  ROLES_KEY,
  IS_PUBLIC_KEY,
  RolesGuard,
} from '../src/rbac';

// ---------------------------------------------------------------------------
// Helpers for ExecutionContext simulation
// ---------------------------------------------------------------------------
function createMockExecutionContext(options: {
  handler: (...args: any[]) => any;
  controllerClass: new (...args: any[]) => any;
  user?: any;
}): ExecutionContext {
  const req = {
    user: options.user,
  };

  return {
    getHandler: () => options.handler,
    getClass: () => options.controllerClass,
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => ({}),
      getNext: () => ({}),
    }),
    getType: () => 'http',
    getArgs: () => [req, {}, {}],
    getArgByIndex: (index: number) => (index === 0 ? req : {}),
    switchToRpc: () => ({} as any),
    switchToWs: () => ({} as any),
  } as unknown as ExecutionContext;
}

// ---------------------------------------------------------------------------
// Live NestJS Test Controllers
// ---------------------------------------------------------------------------
@Controller('test-rbac')
@UseGuards(RolesGuard)
class TestRbacController {
  @Get('public')
  @Public()
  getPublic() {
    return { status: 'public_ok' };
  }

  @Get('sa-only')
  @Roles(Role.SA)
  getSuperAdminOnly() {
    return { status: 'sa_ok' };
  }

  @Get('omgr-only')
  @Roles(Role.OMGR)
  getOrgManagerOnly() {
    return { status: 'omgr_ok' };
  }

  @Get('tenant-management')
  @Roles(Role.OMGR, Role.SA)
  getTenantManagement() {
    return { status: 'tenant_mgmt_ok' };
  }

  @Get('inbox-operations')
  @Roles(Role.STF, Role.OMGR)
  getInboxOps() {
    return { status: 'inbox_ok' };
  }

  @Get('audit-only')
  @Roles(Role.AUD)
  getAuditOnly() {
    return { status: 'audit_ok' };
  }

  @Get('unmarked-fail-closed')
  getUnmarked() {
    return { status: 'should_never_reach_fail_closed' };
  }
}

describe('RBAC Roles, Matrix & Guards Verification (TASK-0019)', () => {
  // =========================================================================
  // AC-01: Canonical Roles Enum, Metadata & Parsing
  // =========================================================================
  describe('AC-01: Canonical Roles Enum & Mapping', () => {
    it('defines exactly the five canonical roles approved in ROLES_AND_PERMISSIONS.md', () => {
      const expectedRoles = ['SA', 'OMGR', 'OP', 'STF', 'AUD'];
      const actualRoles = Object.values(Role);

      assert.equal(actualRoles.length, 5);
      assert.deepEqual(actualRoles.sort(), expectedRoles.sort());

      assert.equal(Role.SA, 'SA');
      assert.equal(Role.OMGR, 'OMGR');
      assert.equal(Role.OP, 'OP');
      assert.equal(Role.STF, 'STF');
      assert.equal(Role.AUD, 'AUD');
    });

    it('contains comprehensive metadata and scope definitions for every role', () => {
      for (const role of Object.values(Role)) {
        const meta = ROLE_METADATA[role];
        assert.ok(meta, `Metadata must exist for role ${role}`);
        assert.equal(meta.role, role);
        assert.ok(meta.titleFa.length > 0);
        assert.ok(meta.titleEn.length > 0);
      }

      // Verify scopes
      assert.equal(ROLE_METADATA[Role.SA].scope, RoleScope.PLATFORM);
      assert.equal(ROLE_METADATA[Role.SA].isSuperAdmin, true);
      assert.equal(ROLE_METADATA[Role.SA].isTenantAdmin, false);

      assert.equal(ROLE_METADATA[Role.OP].scope, RoleScope.PLATFORM);
      assert.equal(ROLE_METADATA[Role.OP].isSuperAdmin, false);

      assert.equal(ROLE_METADATA[Role.OMGR].scope, RoleScope.TENANT);
      assert.equal(ROLE_METADATA[Role.OMGR].isTenantAdmin, true);

      assert.equal(ROLE_METADATA[Role.STF].scope, RoleScope.TENANT);
      assert.equal(ROLE_METADATA[Role.STF].isTenantAdmin, false);

      assert.equal(ROLE_METADATA[Role.AUD].scope, RoleScope.SYSTEM);
    });

    it('validates canonical roles with isValidRole()', () => {
      assert.equal(isValidRole('SA'), true);
      assert.equal(isValidRole('OMGR'), true);
      assert.equal(isValidRole('OP'), true);
      assert.equal(isValidRole('STF'), true);
      assert.equal(isValidRole('AUD'), true);

      assert.equal(isValidRole('INVALID'), false);
      assert.equal(isValidRole('sa'), false); // strictly checks enum value
      assert.equal(isValidRole(''), false);
      assert.equal(isValidRole(null), false);
      assert.equal(isValidRole(undefined), false);
      assert.equal(isValidRole(123), false);
    });

    it('normalizes role strings and compatibility aliases with normalizeRole()', () => {
      // Canonical uppercase
      assert.equal(normalizeRole('SA'), Role.SA);
      assert.equal(normalizeRole('OMGR'), Role.OMGR);
      assert.equal(normalizeRole('OP'), Role.OP);
      assert.equal(normalizeRole('STF'), Role.STF);
      assert.equal(normalizeRole('AUD'), Role.AUD);

      // Case-insensitivity and whitespace trimming
      assert.equal(normalizeRole('  sa  '), Role.SA);
      assert.equal(normalizeRole('omgr'), Role.OMGR);
      assert.equal(normalizeRole('Stf'), Role.STF);

      // Compatibility Aliases
      assert.equal(normalizeRole('SUPERADMIN'), Role.SA);
      assert.equal(normalizeRole('SUPER_ADMIN'), Role.SA);
      assert.equal(normalizeRole('ADMIN'), Role.OMGR);
      assert.equal(normalizeRole('TENANT_ADMIN'), Role.OMGR);
      assert.equal(normalizeRole('MANAGER'), Role.OMGR);
      assert.equal(normalizeRole('MEMBER'), Role.STF);
      assert.equal(normalizeRole('STAFF'), Role.STF);
      assert.equal(normalizeRole('SUPPORT'), Role.STF);
      assert.equal(normalizeRole('AGENT'), Role.STF);
      assert.equal(normalizeRole('OPERATOR'), Role.OP);
      assert.equal(normalizeRole('OPS'), Role.OP);
      assert.equal(normalizeRole('AUDITOR'), Role.AUD);

      // Invalid / unmapped
      assert.equal(normalizeRole('HACKER'), null);
      assert.equal(normalizeRole(''), null);
      assert.equal(normalizeRole(null), null);
      assert.equal(normalizeRole(undefined), null);
    });

    it('evaluates role matching with hasRole() fail-closed', () => {
      assert.equal(hasRole(Role.SA, [Role.SA]), true);
      assert.equal(hasRole('SUPERADMIN', [Role.SA]), true); // alias normalized
      assert.equal(hasRole(Role.OMGR, [Role.OMGR, Role.SA]), true);
      assert.equal(hasRole(Role.STF, [Role.OMGR, Role.SA]), false);
      assert.equal(hasRole(null, [Role.SA]), false);
      assert.equal(hasRole(undefined, [Role.SA]), false);
      assert.equal(hasRole('INVALID', [Role.SA]), false);
      assert.equal(hasRole(Role.SA, []), false);
    });
  });

  // =========================================================================
  // AC-02: Decorators and RolesGuard ExecutionContext
  // =========================================================================
  describe('AC-02: @Roles, @Public, and RolesGuard ExecutionContext', () => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);

    class SampleController {
      @Public()
      publicEndpoint() {}

      @Roles(Role.SA)
      saEndpoint() {}

      @Roles(Role.OMGR, Role.SA)
      mgmtEndpoint() {}

      unadornedEndpoint() {}
    }

    const controllerInstance = new SampleController();

    it('attaches metadata correctly using @Roles and @Public decorators', () => {
      const publicMeta = reflector.get(IS_PUBLIC_KEY, controllerInstance.publicEndpoint);
      assert.equal(publicMeta, true);

      const saMeta = reflector.get(ROLES_KEY, controllerInstance.saEndpoint);
      assert.deepEqual(saMeta, [Role.SA]);

      const mgmtMeta = reflector.get(ROLES_KEY, controllerInstance.mgmtEndpoint);
      assert.deepEqual(mgmtMeta, [Role.OMGR, Role.SA]);
    });

    it('permits @Public() endpoints without user context (anonymous)', () => {
      const ctx = createMockExecutionContext({
        handler: controllerInstance.publicEndpoint,
        controllerClass: SampleController,
        user: undefined,
      });

      const allowed = guard.canActivate(ctx);
      assert.equal(allowed, true);
    });

    it('permits @Public() endpoints even when user context is present', () => {
      const ctx = createMockExecutionContext({
        handler: controllerInstance.publicEndpoint,
        controllerClass: SampleController,
        user: { id: 'u1', role: Role.STF },
      });

      const allowed = guard.canActivate(ctx);
      assert.equal(allowed, true);
    });

    it('rejects protected endpoints with 403 Forbidden when unauthenticated (no user)', () => {
      const ctx = createMockExecutionContext({
        handler: controllerInstance.saEndpoint,
        controllerClass: SampleController,
        user: undefined,
      });

      assert.throws(
        () => guard.canActivate(ctx),
        (err: unknown) => {
          assert.ok(err instanceof ForbiddenException);
          assert.match((err as Error).message, /unauthenticated user context/i);
          return true;
        },
      );
    });

    it('rejects protected endpoints with 403 Forbidden when user has no role assigned', () => {
      const ctx = createMockExecutionContext({
        handler: controllerInstance.saEndpoint,
        controllerClass: SampleController,
        user: { id: 'u2' }, // missing role
      });

      assert.throws(
        () => guard.canActivate(ctx),
        (err: unknown) => {
          assert.ok(err instanceof ForbiddenException);
          assert.match((err as Error).message, /no assigned role/i);
          return true;
        },
      );
    });

    it('rejects protected endpoints with 403 Forbidden when user role does not match', () => {
      const ctx = createMockExecutionContext({
        handler: controllerInstance.saEndpoint,
        controllerClass: SampleController,
        user: { id: 'u3', role: Role.STF },
      });

      assert.throws(
        () => guard.canActivate(ctx),
        (err: unknown) => {
          assert.ok(err instanceof ForbiddenException);
          assert.match((err as Error).message, /insufficient role privileges/i);
          return true;
        },
      );
    });

    it('allows protected endpoints when user role matches single required role', () => {
      const ctx = createMockExecutionContext({
        handler: controllerInstance.saEndpoint,
        controllerClass: SampleController,
        user: { id: 'u4', role: Role.SA },
      });

      const allowed = guard.canActivate(ctx);
      assert.equal(allowed, true);
    });

    it('allows protected endpoints when user role matches one of multiple required roles', () => {
      const ctxOmgr = createMockExecutionContext({
        handler: controllerInstance.mgmtEndpoint,
        controllerClass: SampleController,
        user: { id: 'u5', role: Role.OMGR },
      });
      assert.equal(guard.canActivate(ctxOmgr), true);

      const ctxSa = createMockExecutionContext({
        handler: controllerInstance.mgmtEndpoint,
        controllerClass: SampleController,
        user: { id: 'u6', role: Role.SA },
      });
      assert.equal(guard.canActivate(ctxSa), true);

      const ctxStf = createMockExecutionContext({
        handler: controllerInstance.mgmtEndpoint,
        controllerClass: SampleController,
        user: { id: 'u7', role: Role.STF },
      });
      assert.throws(() => guard.canActivate(ctxStf), ForbiddenException);
    });

    it('supports multiple roles on user context (array of roles)', () => {
      const ctx = createMockExecutionContext({
        handler: controllerInstance.mgmtEndpoint,
        controllerClass: SampleController,
        user: { id: 'u8', roles: [Role.STF, Role.OMGR] },
      });
      assert.equal(guard.canActivate(ctx), true);
    });

    it('enforces Fail-Closed policy on unadorned routes (no @Public, no @Roles)', () => {
      const ctx = createMockExecutionContext({
        handler: controllerInstance.unadornedEndpoint,
        controllerClass: SampleController,
        user: { id: 'u9', role: Role.SA }, // even superadmin fails closed if route has no declaration!
      });

      assert.throws(
        () => guard.canActivate(ctx),
        (err: unknown) => {
          assert.ok(err instanceof ForbiddenException);
          assert.match((err as Error).message, /explicit role authorization or @Public/i);
          return true;
        },
      );
    });
  });

  // =========================================================================
  // AC-03: Strict Role Separation & Full Combinatorial Matrix
  // =========================================================================
  describe('AC-03: Role Separation & Full Combinatorial Matrix Verification', () => {
    const reflector = new Reflector();
    const guard = new RolesGuard(reflector);

    class MatrixController {
      @Roles(Role.SA) saOnly() {}
      @Roles(Role.OP) opOnly() {}
      @Roles(Role.OMGR) omgrOnly() {}
      @Roles(Role.STF) stfOnly() {}
      @Roles(Role.AUD) audOnly() {}
      @Roles(Role.SA, Role.OP) platformOps() {}
      @Roles(Role.OMGR, Role.SA) tenantAdmin() {}
      @Roles(Role.STF, Role.OMGR) tenantGeneral() {}
      @Public() publicRoute() {}
      unprotected() {}
    }

    const ctrl = new MatrixController();

    it('strictly prevents STF from accessing OMGR managerial operations', () => {
      const ctx = createMockExecutionContext({
        handler: ctrl.omgrOnly,
        controllerClass: MatrixController,
        user: { id: 'stf_user', role: Role.STF },
      });
      assert.throws(() => guard.canActivate(ctx), ForbiddenException);
    });

    it('strictly prevents OMGR from accessing SA platform-exclusive operations', () => {
      const ctx = createMockExecutionContext({
        handler: ctrl.saOnly,
        controllerClass: MatrixController,
        user: { id: 'omgr_user', role: Role.OMGR },
      });
      assert.throws(() => guard.canActivate(ctx), ForbiddenException);
    });

    it('strictly prevents OP from accessing SA platform-exclusive operations', () => {
      const ctx = createMockExecutionContext({
        handler: ctrl.saOnly,
        controllerClass: MatrixController,
        user: { id: 'op_user', role: Role.OP },
      });
      assert.throws(() => guard.canActivate(ctx), ForbiddenException);
    });

    it('strictly prevents AUD from executing OMGR managerial operations', () => {
      const ctx = createMockExecutionContext({
        handler: ctrl.omgrOnly,
        controllerClass: MatrixController,
        user: { id: 'aud_user', role: Role.AUD },
      });
      assert.throws(() => guard.canActivate(ctx), ForbiddenException);
    });

    it('verifies exhaustive matrix table for all 5 roles across all endpoint archetypes', () => {
      const allRoles = [Role.SA, Role.OMGR, Role.OP, Role.STF, Role.AUD];

      const testCases: {
        name: string;
        handler: (...args: any[]) => any;
        allowedRoles: Role[];
      }[] = [
        { name: 'SA Only', handler: ctrl.saOnly, allowedRoles: [Role.SA] },
        { name: 'OP Only', handler: ctrl.opOnly, allowedRoles: [Role.OP] },
        { name: 'OMGR Only', handler: ctrl.omgrOnly, allowedRoles: [Role.OMGR] },
        { name: 'STF Only', handler: ctrl.stfOnly, allowedRoles: [Role.STF] },
        { name: 'AUD Only', handler: ctrl.audOnly, allowedRoles: [Role.AUD] },
        { name: 'Platform Ops (SA, OP)', handler: ctrl.platformOps, allowedRoles: [Role.SA, Role.OP] },
        { name: 'Tenant Admin (OMGR, SA)', handler: ctrl.tenantAdmin, allowedRoles: [Role.OMGR, Role.SA] },
        { name: 'Tenant General (STF, OMGR)', handler: ctrl.tenantGeneral, allowedRoles: [Role.STF, Role.OMGR] },
      ];

      for (const tc of testCases) {
        for (const role of allRoles) {
          const shouldAllow = tc.allowedRoles.includes(role);
          const ctx = createMockExecutionContext({
            handler: tc.handler,
            controllerClass: MatrixController,
            user: { id: `user_${role}`, role },
          });

          if (shouldAllow) {
            assert.equal(
              guard.canActivate(ctx),
              true,
              `Role ${role} SHOULD be allowed on ${tc.name}`,
            );
          } else {
            assert.throws(
              () => guard.canActivate(ctx),
              ForbiddenException,
              `Role ${role} MUST BE FORBIDDEN on ${tc.name}`,
            );
          }
        }
      }
    });
  });

  // =========================================================================
  // Live NestJS HTTP Application Integration Test
  // =========================================================================
  describe('Live NestJS HTTP Application Integration Test (HTTP 200 vs 403)', () => {
    let app: INestApplication;
    let baseUrl = '';

    before(async () => {
      app = await NestFactory.create(
        {
          module: class TestAppModule {},
          controllers: [TestRbacController],
          providers: [Reflector, RolesGuard],
        },
        { logger: false },
      );

      // Lightweight middleware to attach user context from x-user-role request header
      app.use((req: any, _res: any, next: () => void) => {
        const roleHeader = req.headers['x-user-role'];
        if (roleHeader) {
          req.user = {
            id: 'mock_http_user',
            role: roleHeader,
          };
        }
        next();
      });

      await app.listen(0);
      const server = app.getHttpServer();
      const address = server.address();
      const port = typeof address === 'string' ? address : address?.port;
      baseUrl = `http://127.0.0.1:${port}`;
    });

    after(async () => {
      if (app) {
        await app.close();
      }
    });

    it('GET /test-rbac/public returns 200 OK without any credentials', async () => {
      const res = await fetch(`${baseUrl}/test-rbac/public`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { status: 'public_ok' });
    });

    it('GET /test-rbac/sa-only returns 403 Forbidden for OMGR', async () => {
      const res = await fetch(`${baseUrl}/test-rbac/sa-only`, {
        headers: { 'x-user-role': 'OMGR' },
      });
      assert.equal(res.status, 403);
    });

    it('GET /test-rbac/sa-only returns 200 OK for SA', async () => {
      const res = await fetch(`${baseUrl}/test-rbac/sa-only`, {
        headers: { 'x-user-role': 'SA' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { status: 'sa_ok' });
    });

    it('GET /test-rbac/omgr-only returns 403 Forbidden for STF', async () => {
      const res = await fetch(`${baseUrl}/test-rbac/omgr-only`, {
        headers: { 'x-user-role': 'STF' },
      });
      assert.equal(res.status, 403);
    });

    it('GET /test-rbac/omgr-only returns 200 OK for OMGR', async () => {
      const res = await fetch(`${baseUrl}/test-rbac/omgr-only`, {
        headers: { 'x-user-role': 'OMGR' },
      });
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.deepEqual(data, { status: 'omgr_ok' });
    });

    it('GET /test-rbac/tenant-management returns 200 OK for both OMGR and SA', async () => {
      const resOmgr = await fetch(`${baseUrl}/test-rbac/tenant-management`, {
        headers: { 'x-user-role': 'OMGR' },
      });
      assert.equal(resOmgr.status, 200);

      const resSa = await fetch(`${baseUrl}/test-rbac/tenant-management`, {
        headers: { 'x-user-role': 'SA' },
      });
      assert.equal(resSa.status, 200);

      const resStf = await fetch(`${baseUrl}/test-rbac/tenant-management`, {
        headers: { 'x-user-role': 'STF' },
      });
      assert.equal(resStf.status, 403);
    });

    it('GET /test-rbac/inbox-operations returns 200 OK for STF and OMGR, but 403 for AUD', async () => {
      const resStf = await fetch(`${baseUrl}/test-rbac/inbox-operations`, {
        headers: { 'x-user-role': 'STF' },
      });
      assert.equal(resStf.status, 200);

      const resOmgr = await fetch(`${baseUrl}/test-rbac/inbox-operations`, {
        headers: { 'x-user-role': 'OMGR' },
      });
      assert.equal(resOmgr.status, 200);

      const resAud = await fetch(`${baseUrl}/test-rbac/inbox-operations`, {
        headers: { 'x-user-role': 'AUD' },
      });
      assert.equal(resAud.status, 403);
    });

    it('GET /test-rbac/unmarked-fail-closed returns 403 Forbidden even for SA', async () => {
      const res = await fetch(`${baseUrl}/test-rbac/unmarked-fail-closed`, {
        headers: { 'x-user-role': 'SA' },
      });
      assert.equal(res.status, 403);
    });
  });
});
