import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { ExecutionContext, CallHandler, BadRequestException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { of } from 'rxjs';
import {
  TenantContext,
  TenantContextMissingError,
} from '../src/tenant/tenant-context';
import {
  TenantMiddleware,
  TENANT_HEADER_NAME,
  HttpRequestLike,
} from '../src/tenant/tenant.middleware';
import { TenantGuard } from '../src/tenant/tenant.guard';
import { TenantInterceptor } from '../src/tenant/tenant.interceptor';
import { Public, IS_PUBLIC_KEY } from '../src/tenant/public.decorator';
import {
  TenantScopeMissingError,
  TenantScopeInvalidError,
} from '../src/tenant/tenant-scope';

describe('Tenant Context & Middleware Subsystem (TASK-0018)', () => {
  const VALID_TENANT_ALPHA = 'org_synthetic_alpha_101';
  const VALID_TENANT_BETA = 'org_synthetic_beta_202';
  const MALICIOUS_TENANT = 'tenant;DROP TABLE tenants;--';
  const OVERSIZED_TENANT = 'a'.repeat(65);

  describe('AC-01: TenantContext with AsyncLocalStorage & Fail-Closed', () => {
    it('should throw TenantContextMissingError when getTenantId() called outside context', () => {
      assert.strictEqual(TenantContext.hasContext(), false);
      assert.strictEqual(TenantContext.getOptionalTenantId(), undefined);
      assert.throws(
        () => TenantContext.getTenantId(),
        (err: unknown) => {
          assert.ok(err instanceof TenantContextMissingError);
          assert.strictEqual(err.name, 'TenantContextMissingError');
          return true;
        },
      );
    });

    it('should run callback within tenant context and retrieve tenantId reliably', () => {
      const result = TenantContext.runWithTenant(VALID_TENANT_ALPHA, () => {
        assert.strictEqual(TenantContext.hasContext(), true);
        assert.strictEqual(TenantContext.getTenantId(), VALID_TENANT_ALPHA);
        assert.strictEqual(TenantContext.getOptionalTenantId(), VALID_TENANT_ALPHA);
        return 'executed-alpha';
      });

      assert.strictEqual(result, 'executed-alpha');
      // Context must be cleaned up after execution exits
      assert.strictEqual(TenantContext.hasContext(), false);
    });

    it('should fail-closed if tenantId is missing, empty, or invalid when calling runWithTenant', () => {
      assert.throws(
        () => TenantContext.runWithTenant('', () => {}),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      assert.throws(
        () => TenantContext.runWithTenant(null, () => {}),
        (err: unknown) => err instanceof TenantScopeMissingError,
      );

      assert.throws(
        () => TenantContext.runWithTenant(MALICIOUS_TENANT, () => {}),
        (err: unknown) => err instanceof TenantScopeInvalidError,
      );
    });

    it('should maintain strict context isolation under concurrent async executions', async () => {
      const concurrency = 20;
      const tasks = Array.from({ length: concurrency }).map(async (_, idx) => {
        const tenantId = idx % 2 === 0 ? VALID_TENANT_ALPHA : VALID_TENANT_BETA;

        return TenantContext.runWithTenant(tenantId, async () => {
          // Asynchronous tick and delay to simulate I/O
          await new Promise((resolve) => setTimeout(resolve, Math.floor(Math.random() * 15) + 1));
          assert.strictEqual(
            TenantContext.getTenantId(),
            tenantId,
            `Concurrent execution ${idx} observed cross-tenant pollution`,
          );
          return tenantId;
        });
      });

      const results = await Promise.all(tasks);
      assert.strictEqual(results.length, concurrency);
      results.forEach((res, idx) => {
        const expected = idx % 2 === 0 ? VALID_TENANT_ALPHA : VALID_TENANT_BETA;
        assert.strictEqual(res, expected);
      });

      // Outer context remains clean
      assert.strictEqual(TenantContext.hasContext(), false);
    });
  });

  describe('AC-02: TenantMiddleware Header Extraction & Validation', () => {
    let middleware: TenantMiddleware;

    beforeEach(() => {
      middleware = new TenantMiddleware();
    });

    it('should extract valid x-tenant-id and bind AsyncLocalStorage context downstream', (t, done) => {
      const req: HttpRequestLike = {
        headers: {
          [TENANT_HEADER_NAME]: VALID_TENANT_ALPHA,
        },
      };
      const res = {};

      middleware.use(req, res, () => {
        try {
          assert.strictEqual(req.tenantId, VALID_TENANT_ALPHA);
          assert.strictEqual(TenantContext.hasContext(), true);
          assert.strictEqual(TenantContext.getTenantId(), VALID_TENANT_ALPHA);
          done();
        } catch (err) {
          done(err);
        }
      });
    });

    it('should trim surrounding whitespace from x-tenant-id header', (t, done) => {
      const req: HttpRequestLike = {
        headers: {
          [TENANT_HEADER_NAME]: `   ${VALID_TENANT_ALPHA}   `,
        },
      };
      const res = {};

      middleware.use(req, res, () => {
        try {
          assert.strictEqual(req.tenantId, VALID_TENANT_ALPHA);
          assert.strictEqual(TenantContext.getTenantId(), VALID_TENANT_ALPHA);
          done();
        } catch (err) {
          done(err);
        }
      });
    });

    it('should pass-through without binding context when header is absent (guard will check downstream)', (t, done) => {
      const req: HttpRequestLike = {
        headers: {},
      };
      const res = {};

      middleware.use(req, res, () => {
        try {
          assert.strictEqual(req.tenantId, undefined);
          assert.strictEqual(TenantContext.hasContext(), false);
          done();
        } catch (err) {
          done(err);
        }
      });
    });

    it('should reject multiple x-tenant-id headers to prevent smuggling', () => {
      const req: HttpRequestLike = {
        headers: {
          [TENANT_HEADER_NAME]: [VALID_TENANT_ALPHA, VALID_TENANT_BETA],
        },
      };
      const res = {};

      assert.throws(
        () => middleware.use(req, res, () => {}),
        (err: unknown) => {
          assert.ok(err instanceof BadRequestException);
          assert.match((err as Error).message, /Multiple x-tenant-id headers are strictly prohibited/);
          return true;
        },
      );
    });

    it('should reject empty or whitespace-only x-tenant-id header', () => {
      const req: HttpRequestLike = {
        headers: {
          [TENANT_HEADER_NAME]: '   ',
        },
      };
      const res = {};

      assert.throws(
        () => middleware.use(req, res, () => {}),
        (err: unknown) => {
          assert.ok(err instanceof BadRequestException);
          assert.match((err as Error).message, /x-tenant-id header cannot be empty/);
          return true;
        },
      );
    });

    it('should reject malicious SQL injection characters in x-tenant-id', () => {
      const req: HttpRequestLike = {
        headers: {
          [TENANT_HEADER_NAME]: MALICIOUS_TENANT,
        },
      };
      const res = {};

      assert.throws(
        () => middleware.use(req, res, () => {}),
        (err: unknown) => {
          assert.ok(err instanceof BadRequestException);
          assert.match((err as Error).message, /invalid characters/i);
          return true;
        },
      );
    });

    it('should reject oversized x-tenant-id exceeding 64 characters', () => {
      const req: HttpRequestLike = {
        headers: {
          [TENANT_HEADER_NAME]: OVERSIZED_TENANT,
        },
      };
      const res = {};

      assert.throws(
        () => middleware.use(req, res, () => {}),
        (err: unknown) => {
          assert.ok(err instanceof BadRequestException);
          assert.match((err as Error).message, /exceeds 64 characters/i);
          return true;
        },
      );
    });
  });

  describe('AC-03: TenantGuard & Protected Route Blocking', () => {
    let reflector: Reflector;
    let guard: TenantGuard;

    beforeEach(() => {
      reflector = new Reflector();
      guard = new TenantGuard(reflector);
    });

    function createMockContext(req: HttpRequestLike, isPublic = false): ExecutionContext {
      const handler = () => {};
      const targetClass = class TestController {};

      if (isPublic) {
        Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
      }

      return {
        getHandler: () => handler,
        getClass: () => targetClass,
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => ({}),
          getNext: () => () => {},
        }),
      } as unknown as ExecutionContext;
    }

    it('should allow public route unconditionally without tenant identification', () => {
      const req: HttpRequestLike = { headers: {} };
      const context = createMockContext(req, true);

      const canActivate = guard.canActivate(context);
      assert.strictEqual(canActivate, true);
    });

    it('should block protected route with 400 BadRequest when tenant_id is missing', () => {
      const req: HttpRequestLike = { headers: {} };
      const context = createMockContext(req, false);

      assert.throws(
        () => guard.canActivate(context),
        (err: unknown) => {
          assert.ok(err instanceof BadRequestException);
          assert.match((err as Error).message, /Tenant identification is required/);
          return true;
        },
      );
    });

    it('should allow protected route when x-tenant-id header is provided and valid', () => {
      const req: HttpRequestLike = {
        headers: {
          [TENANT_HEADER_NAME]: VALID_TENANT_ALPHA,
        },
      };
      const context = createMockContext(req, false);

      const canActivate = guard.canActivate(context);
      assert.strictEqual(canActivate, true);
      assert.strictEqual(req.tenantId, VALID_TENANT_ALPHA);
    });

    it('should allow protected route when active TenantContext already exists', () => {
      const req: HttpRequestLike = { headers: {} };
      const context = createMockContext(req, false);

      TenantContext.runWithTenant(VALID_TENANT_BETA, () => {
        const canActivate = guard.canActivate(context);
        assert.strictEqual(canActivate, true);
        assert.strictEqual(req.tenantId, VALID_TENANT_BETA);
      });
    });

    it('should allow protected route when authenticated user object has valid tenantId', () => {
      const req: HttpRequestLike = {
        headers: {},
        user: { tenantId: VALID_TENANT_ALPHA },
      };
      const context = createMockContext(req, false);

      const canActivate = guard.canActivate(context);
      assert.strictEqual(canActivate, true);
      assert.strictEqual(req.tenantId, VALID_TENANT_ALPHA);
    });

    it('should block protected route if x-tenant-id has invalid characters', () => {
      const req: HttpRequestLike = {
        headers: {
          [TENANT_HEADER_NAME]: MALICIOUS_TENANT,
        },
      };
      const context = createMockContext(req, false);

      assert.throws(
        () => guard.canActivate(context),
        (err: unknown) => {
          assert.ok(err instanceof BadRequestException);
          assert.match((err as Error).message, /invalid characters/i);
          return true;
        },
      );
    });
  });

  describe('TenantInterceptor Asynchronous Scope Wrapping & Fail-Closed', () => {
    let reflector: Reflector;
    let interceptor: TenantInterceptor;

    beforeEach(() => {
      reflector = new Reflector();
      interceptor = new TenantInterceptor(reflector);
    });

    function createMockContext(req: HttpRequestLike, isPublic = false): ExecutionContext {
      const handler = () => {};
      const targetClass = class TestController {};

      if (isPublic) {
        Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
      }

      return {
        getHandler: () => handler,
        getClass: () => targetClass,
        switchToHttp: () => ({
          getRequest: () => req,
          getResponse: () => ({}),
          getNext: () => () => {},
        }),
      } as unknown as ExecutionContext;
    }

    it('should wrap handler execution in TenantContext when valid header provided', (t, done) => {
      const req: HttpRequestLike = {
        headers: {
          [TENANT_HEADER_NAME]: VALID_TENANT_BETA,
        },
      };
      const context = createMockContext(req, false);

      let handlerRanWithContext = false;
      const callHandler: CallHandler = {
        handle: () => {
          assert.strictEqual(TenantContext.hasContext(), true);
          assert.strictEqual(TenantContext.getTenantId(), VALID_TENANT_BETA);
          handlerRanWithContext = true;
          return of({ status: 'success' });
        },
      };

      assert.strictEqual(TenantContext.hasContext(), false);

      interceptor.intercept(context, callHandler).subscribe({
        next: (val) => {
          assert.deepStrictEqual(val, { status: 'success' });
        },
        error: (err) => done(err),
        complete: () => {
          assert.strictEqual(handlerRanWithContext, true);
          done();
        },
      });

      // Synchronously in the outer caller scope, context was never leaked
      assert.strictEqual(TenantContext.hasContext(), false);
    });

    it('should allow public route without context wrapping if no header present', (t, done) => {
      const req: HttpRequestLike = { headers: {} };
      const context = createMockContext(req, true);

      const callHandler: CallHandler = {
        handle: () => {
          assert.strictEqual(TenantContext.hasContext(), false);
          return of({ status: 'public-ok' });
        },
      };

      interceptor.intercept(context, callHandler).subscribe({
        next: (val) => {
          assert.deepStrictEqual(val, { status: 'public-ok' });
        },
        error: (err) => done(err),
        complete: () => done(),
      });
    });

    it('should fail-closed with BadRequestException when protected route lacks tenantId', () => {
      const req: HttpRequestLike = { headers: {} };
      const context = createMockContext(req, false);

      const callHandler: CallHandler = {
        handle: () => of({ status: 'should-not-reach' }),
      };

      assert.throws(
        () => interceptor.intercept(context, callHandler),
        (err: unknown) => {
          assert.ok(err instanceof BadRequestException);
          assert.match((err as Error).message, /Tenant identification is required/);
          return true;
        },
      );
    });
  });
});
