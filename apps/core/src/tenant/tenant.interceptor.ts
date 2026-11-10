import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { IS_PUBLIC_KEY } from './public.decorator';
import { TenantContext } from './tenant-context';
import { assertValidTenantId, TenantScopeInvalidError, TenantScopeMissingError } from './tenant-scope';
import { TENANT_HEADER_NAME, HttpRequestLike } from './tenant.middleware';

/**
 * TenantInterceptor ensures that downstream controller handler and service executions
 * run inside AsyncLocalStorage TenantContext, even if TenantMiddleware was bypassed.
 * Also enforces Fail-Closed policy on non-public routes.
 */
@Injectable()
export class TenantInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // If context is already active, proceed directly
    if (TenantContext.hasContext()) {
      return next.handle();
    }

    const request = context.switchToHttp().getRequest<HttpRequestLike>();

    // Determine tenantId from request property, header, or attached user
    let candidateTenantId: unknown = request?.tenantId;

    if (!candidateTenantId) {
      const rawHeader = request?.headers?.[TENANT_HEADER_NAME];
      if (Array.isArray(rawHeader)) {
        throw new BadRequestException('Multiple x-tenant-id headers are strictly prohibited');
      }
      if (typeof rawHeader === 'string') {
        candidateTenantId = rawHeader;
      }
    }

    if (!candidateTenantId) {
      const user = (request as unknown as { user?: { tenantId?: string } })?.user;
      if (user?.tenantId) {
        candidateTenantId = user.tenantId;
      }
    }

    // If tenant identifier found, validate and wrap execution in TenantContext
    if (candidateTenantId !== undefined && candidateTenantId !== null) {
      try {
        const validated = assertValidTenantId(candidateTenantId);
        if (request) {
          request.tenantId = validated;
        }

        return new Observable((subscriber) => {
          TenantContext.runWithTenant(validated, () => {
            next.handle().subscribe(subscriber);
          });
        });
      } catch (err: unknown) {
        if (err instanceof TenantScopeMissingError || err instanceof TenantScopeInvalidError) {
          throw new BadRequestException(err.message);
        }
        throw new BadRequestException('Invalid tenant identification');
      }
    }

    // If route is explicitly marked Public, allow execution outside tenant context
    if (isPublic) {
      return next.handle();
    }

    // Otherwise, Fail-Closed on protected route
    throw new BadRequestException('Tenant identification is required (x-tenant-id header missing)');
  }
}
