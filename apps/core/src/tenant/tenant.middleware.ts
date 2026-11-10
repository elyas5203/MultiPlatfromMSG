import {
  Injectable,
  NestMiddleware,
  BadRequestException,
} from '@nestjs/common';
import { assertValidTenantId, TenantScopeInvalidError, TenantScopeMissingError } from './tenant-scope';
import { TenantContext } from './tenant-context';

export const TENANT_HEADER_NAME = 'x-tenant-id';

export interface HttpRequestLike {
  headers?: Record<string, string | string[] | undefined>;
  tenantId?: string;
  [key: string]: unknown;
}

export interface HttpResponseLike {
  [key: string]: unknown;
}

export type HttpNextFunctionLike = (error?: unknown) => void;

@Injectable()
export class TenantMiddleware implements NestMiddleware {
  use(req: HttpRequestLike, res: HttpResponseLike, next: HttpNextFunctionLike): void {
    const rawHeader = req.headers?.[TENANT_HEADER_NAME];

    // Header may be array if repeated; reject repeated header to prevent ambiguity/smuggling
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
        const validatedTenantId = assertValidTenantId(trimmed);
        req.tenantId = validatedTenantId;

        // Wrap downstream async processing inside AsyncLocalStorage tenant context
        TenantContext.runWithTenant(validatedTenantId, () => {
          next();
        });
        return;
      } catch (err: unknown) {
        if (err instanceof TenantScopeMissingError || err instanceof TenantScopeInvalidError) {
          throw new BadRequestException(err.message);
        }
        throw new BadRequestException('Invalid x-tenant-id header');
      }
    }

    // No header provided: continue. Protected routes will be guarded by TenantGuard / TenantInterceptor
    next();
  }
}
