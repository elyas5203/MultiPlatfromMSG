import {
  Injectable,
  CanActivate,
  ExecutionContext,
  BadRequestException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './public.decorator';
import { TenantContext } from './tenant-context';
import { assertValidTenantId, TenantScopeInvalidError, TenantScopeMissingError } from './tenant-scope';
import { TENANT_HEADER_NAME, HttpRequestLike } from './tenant.middleware';

@Injectable()
export class TenantGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    const request = context.switchToHttp().getRequest<HttpRequestLike>();

    // 1. Check if already populated in TenantContext (e.g. by TenantMiddleware)
    const existingContextId = TenantContext.getOptionalTenantId();
    if (existingContextId) {
      if (request) {
        request.tenantId = existingContextId;
      }
      return true;
    }

    // 2. Check request.tenantId property directly
    if (request?.tenantId) {
      try {
        const validated = assertValidTenantId(request.tenantId);
        request.tenantId = validated;
        return true;
      } catch {
        throw new BadRequestException('Invalid tenant identification');
      }
    }

    // 3. Fallback extraction from request header if middleware did not bind context
    const rawHeader = request?.headers?.[TENANT_HEADER_NAME];
    if (Array.isArray(rawHeader)) {
      throw new BadRequestException('Multiple x-tenant-id headers are strictly prohibited');
    }

    if (rawHeader !== undefined) {
      if (typeof rawHeader !== 'string') {
        throw new BadRequestException('Invalid x-tenant-id header format');
      }

      const trimmed = rawHeader.trim();
      if (trimmed.length === 0) {
        throw new BadRequestException('x-tenant-id header cannot be empty');
      }

      try {
        const validated = assertValidTenantId(trimmed);
        if (request) {
          request.tenantId = validated;
        }
        return true;
      } catch (err: unknown) {
        if (err instanceof TenantScopeMissingError || err instanceof TenantScopeInvalidError) {
          throw new BadRequestException(err.message);
        }
        throw new BadRequestException('Invalid x-tenant-id header');
      }
    }

    // 4. Fallback extraction from auth staff/user object attached to request (e.g., from auth guard)
    const staffUser = (request as unknown as { user?: { tenantId?: string } })?.user;
    if (staffUser?.tenantId) {
      try {
        const validated = assertValidTenantId(staffUser.tenantId);
        if (request) {
          request.tenantId = validated;
        }
        return true;
      } catch {
        throw new BadRequestException('Invalid tenant identification on session user');
      }
    }

    // Missing tenant on a protected route -> Fail-closed: 400 Bad Request
    throw new BadRequestException('Tenant identification is required (x-tenant-id header missing)');
  }
}
