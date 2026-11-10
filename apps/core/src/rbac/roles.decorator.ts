import { SetMetadata, CustomDecorator } from '@nestjs/common';
import { Role } from './roles.enum';

export const ROLES_KEY = 'rbac:roles';
export const IS_PUBLIC_KEY = 'rbac:is_public';

/**
 * @Roles(...roles: Role[])
 * Declares the required roles to access an endpoint or controller.
 * Multiple roles indicate that possessing ANY of the specified roles grants access.
 */
export const Roles = (...roles: Role[]): CustomDecorator<string> =>
  SetMetadata(ROLES_KEY, roles);

/**
 * @Public()
 * Marks an endpoint or controller as public, bypassing RBAC role checks.
 */
export const Public = (): CustomDecorator<string> =>
  SetMetadata(IS_PUBLIC_KEY, true);
