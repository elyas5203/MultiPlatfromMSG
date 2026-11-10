import {
  Injectable,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role, hasRole } from './roles.enum';
import { ROLES_KEY, IS_PUBLIC_KEY } from './roles.decorator';

export interface RbacUserContext {
  id?: string;
  tenantId?: string;
  role?: Role | string;
  roles?: (Role | string)[];
  [key: string]: unknown;
}

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    // 1. Check if the handler or controller is marked as @Public()
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    // 2. Retrieve required roles
    const requiredRoles = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    // Fail-Closed policy: if route is not @Public() and specifies no roles, deny access
    if (!requiredRoles || requiredRoles.length === 0) {
      throw new ForbiddenException(
        'Access denied: route requires explicit role authorization or @Public() marker (fail-closed)',
      );
    }

    // 3. Extract request and user from context
    const request = context.switchToHttp().getRequest();
    if (!request) {
      throw new ForbiddenException('Access denied: missing HTTP request context');
    }

    const user: RbacUserContext | undefined = request.user ?? request.staff;
    if (!user) {
      throw new ForbiddenException(
        'Access denied: unauthenticated user context or missing credentials',
      );
    }

    // 4. Extract assigned user role(s)
    const userRoles: (Role | string)[] = [];
    if (user.role) {
      userRoles.push(user.role);
    }
    if (Array.isArray(user.roles)) {
      userRoles.push(...user.roles);
    }

    if (userRoles.length === 0) {
      throw new ForbiddenException(
        'Access denied: user context contains no assigned role',
      );
    }

    // 5. Check if user possesses at least one of the required roles
    const isAuthorized = userRoles.some((role) => hasRole(role, requiredRoles));

    if (!isAuthorized) {
      throw new ForbiddenException(
        'Access denied: insufficient role privileges for the requested resource',
      );
    }

    return true;
  }
}
