/**
 * Canonical RBAC roles definition according to docs/ai/product/ROLES_AND_PERMISSIONS.md.
 *
 * Platform Roles (Central Service Provider / خدمتگزاران تک):
 * - SA: Super Admin (سوپرادمین پلتفرم مرکزی) - Unrestricted platform administration
 * - OP: Platform Operations Manager (مدیر عملیات پلتفرم / اپراتور ارشد) - Operations & emergency controls
 *
 * Tenant Roles (Customer Organization / سازمان مشتری):
 * - OMGR: Organization Manager (مدیر سازمان مشتری) - Tenant-level administration, teams, brands, staff
 * - STF: Staff / Member / Inbox Agent (کارمند سازمان مشتری / کارشناس پاسخ‌گو) - Operational inbox & messaging
 *
 * Central / Cross-cutting Audit Role:
 * - AUD: Auditor / Observer (حسابرس / ناظر) - Read-only inspection across authorized scopes
 */
export enum Role {
  SA = 'SA',
  OMGR = 'OMGR',
  OP = 'OP',
  STF = 'STF',
  AUD = 'AUD',
}

export enum RoleScope {
  PLATFORM = 'PLATFORM', // Central service provider scope (SA, OP)
  TENANT = 'TENANT',     // Tenant / Customer organization scope (OMGR, STF)
  SYSTEM = 'SYSTEM',     // Cross-cutting system audit scope (AUD)
}

export interface RoleMetadata {
  role: Role;
  titleFa: string;
  titleEn: string;
  scope: RoleScope;
  isSuperAdmin: boolean;
  isTenantAdmin: boolean;
}

export const ROLE_METADATA: Record<Role, RoleMetadata> = {
  [Role.SA]: {
    role: Role.SA,
    titleFa: 'سوپرادمین خدمتگزاران تک',
    titleEn: 'Platform Super Admin',
    scope: RoleScope.PLATFORM,
    isSuperAdmin: true,
    isTenantAdmin: false,
  },
  [Role.OP]: {
    role: Role.OP,
    titleFa: 'مدیر عملیات خدمتگزاران تک / اپراتور ارشد',
    titleEn: 'Platform Operations Manager',
    scope: RoleScope.PLATFORM,
    isSuperAdmin: false,
    isTenantAdmin: false,
  },
  [Role.OMGR]: {
    role: Role.OMGR,
    titleFa: 'مدیر سازمان مشتری',
    titleEn: 'Organization Manager',
    scope: RoleScope.TENANT,
    isSuperAdmin: false,
    isTenantAdmin: true,
  },
  [Role.STF]: {
    role: Role.STF,
    titleFa: 'کارمند سازمان مشتری / کارشناس پاسخ‌گو',
    titleEn: 'Staff / Inbox Agent',
    scope: RoleScope.TENANT,
    isSuperAdmin: false,
    isTenantAdmin: false,
  },
  [Role.AUD]: {
    role: Role.AUD,
    titleFa: 'حسابرس / ناظر',
    titleEn: 'Auditor',
    scope: RoleScope.SYSTEM,
    isSuperAdmin: false,
    isTenantAdmin: false,
  },
};

/**
 * Validates whether a given value is an official Role enum member.
 */
export function isValidRole(value: unknown): value is Role {
  return typeof value === 'string' && Object.values(Role).includes(value as Role);
}

/**
 * Normalizes an arbitrary role string to its canonical Role enum value.
 * Supports canonical codes (SA, OMGR, OP, STF, AUD) and standard aliases (e.g. SUPERADMIN, ADMIN, MEMBER).
 * Returns null if the role cannot be mapped.
 */
export function normalizeRole(value: unknown): Role | null {
  if (!value || typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim().toUpperCase();
  if (isValidRole(trimmed)) {
    return trimmed;
  }

  const aliasMap: Record<string, Role> = {
    SUPERADMIN: Role.SA,
    SUPER_ADMIN: Role.SA,
    ADMIN: Role.OMGR,
    TENANT_ADMIN: Role.OMGR,
    MANAGER: Role.OMGR,
    OPERATOR: Role.OP,
    OPS: Role.OP,
    MEMBER: Role.STF,
    STAFF: Role.STF,
    SUPPORT: Role.STF,
    AGENT: Role.STF,
    AUDITOR: Role.AUD,
    AUDIT: Role.AUD,
  };

  return aliasMap[trimmed] ?? null;
}

/**
 * Evaluates whether a user's role matches any of the required roles.
 * Fail-closed: returns false if userRole is missing, invalid, or not in requiredRoles.
 */
export function hasRole(userRole: unknown, requiredRoles: Role[]): boolean {
  if (!userRole || !requiredRoles || requiredRoles.length === 0) {
    return false;
  }
  const normalized = normalizeRole(userRole);
  if (!normalized) {
    return false;
  }
  return requiredRoles.includes(normalized);
}
