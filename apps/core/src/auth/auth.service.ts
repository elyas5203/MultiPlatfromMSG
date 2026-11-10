import {
  Injectable,
  UnauthorizedException,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AuthRepository, StaffAuthRecord, SessionRecord } from './auth.repository';
import { PasswordHasher } from './password-hasher';
import { SessionTokenService } from './session-token.service';
import { AuthConfig } from './auth.config';

export interface LoginResult {
  token: string;
  expiresAt: string;
  staff: {
    id: string;
    tenantId: string;
    username: string;
    email: string;
    fullName: string;
    role: string;
  };
}

export interface AuthSessionValidationResult {
  session: SessionRecord;
  staff: StaffAuthRecord;
}

@Injectable()
export class AuthService {
  constructor(private readonly authRepository: AuthRepository) {}

  private get config() {
    return AuthConfig.getValues();
  }

  /**
   * AC-02 & AC-04:
   * Authenticates staff using tenantId, username, and password.
   * Generic error message for invalid credentials, non-existent user, non-existent tenant,
   * or inactive user, preventing account enumeration.
   */
  async login(tenantId: string, username: string, password: string): Promise<LoginResult> {
    const GENERIC_INVALID_MESSAGE = 'Invalid credentials';

    if (!tenantId || !username || !password) {
      throw new UnauthorizedException(GENERIC_INVALID_MESSAGE);
    }

    const trimmedTenant = tenantId.trim();
    const trimmedUser = username.trim();

    if (!trimmedTenant || !trimmedUser) {
      throw new UnauthorizedException(GENERIC_INVALID_MESSAGE);
    }

    const staff = await this.authRepository.findStaffByUsername(trimmedTenant, trimmedUser);

    // AC-02: Non-existent user, non-existent tenant, or missing password hash
    if (!staff || !staff.passwordHash) {
      throw new UnauthorizedException(GENERIC_INVALID_MESSAGE);
    }

    // AC-02: Inactive user rejected with identical generic message
    if (staff.status !== 'ACTIVE') {
      throw new UnauthorizedException(GENERIC_INVALID_MESSAGE);
    }

    // AC-04: Check temporary lockout
    if (staff.lockedUntil && staff.lockedUntil > new Date()) {
      throw new UnauthorizedException('Account is temporarily locked');
    }

    // Verify password hash with argon2id
    const isPasswordValid = await PasswordHasher.verify(staff.passwordHash, password);

    if (!isPasswordValid) {
      // Record failed attempt and apply lockout if threshold reached
      await this.authRepository.recordFailedLogin(
        trimmedTenant,
        staff.id,
        this.config.maxLoginAttempts,
        this.config.lockoutDurationSeconds,
      );
      throw new UnauthorizedException(GENERIC_INVALID_MESSAGE);
    }

    // Password valid: reset failed attempts
    if (staff.failedLoginAttempts > 0 || staff.lockedUntil !== null) {
      await this.authRepository.resetFailedAttempts(trimmedTenant, staff.id);
    }

    // Generate secure random bearer token (>= 256 bits)
    const rawToken = SessionTokenService.generateToken();
    const tokenHash = SessionTokenService.hashToken(rawToken);
    const expiresAt = new Date(Date.now() + this.config.sessionTtlSeconds * 1000);

    const session = await this.authRepository.createSession(
      trimmedTenant,
      staff.id,
      tokenHash,
      expiresAt,
    );

    return {
      token: rawToken,
      expiresAt: session.expiresAt.toISOString(),
      staff: {
        id: staff.id,
        tenantId: staff.tenantId,
        username: staff.username ?? '',
        email: staff.email,
        fullName: staff.fullName,
        role: staff.role,
      },
    };
  }

  /**
   * Validates a bearer session token.
   */
  async validateSession(rawToken: string): Promise<AuthSessionValidationResult> {
    if (!rawToken || typeof rawToken !== 'string') {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const tokenHash = SessionTokenService.hashToken(rawToken.trim());
    const session = await this.authRepository.findSessionByTokenHash(tokenHash);

    if (!session || session.revokedAt !== null || session.expiresAt <= new Date()) {
      throw new UnauthorizedException('Invalid or expired session');
    }

    const staff = await this.authRepository.findStaffById(session.tenantId, session.staffId);
    if (!staff || staff.status !== 'ACTIVE') {
      throw new UnauthorizedException('Invalid or expired session');
    }

    return { session, staff };
  }

  /**
   * AC-02: Revokes active session (logout).
   */
  async logout(rawToken: string): Promise<{ success: boolean; message: string }> {
    if (!rawToken || typeof rawToken !== 'string') {
      return { success: true, message: 'Logged out successfully' };
    }

    const tokenHash = SessionTokenService.hashToken(rawToken.trim());
    const session = await this.authRepository.findSessionByTokenHash(tokenHash);

    if (session && session.revokedAt === null) {
      await this.authRepository.revokeSession(session.tenantId, session.id);
    }

    return { success: true, message: 'Logged out successfully' };
  }

  /**
   * AC-03 & AC-04:
   * Changes password using active session and current password.
   * Invalidates all OTHER sessions of the same staff member.
   */
  async changePassword(
    rawToken: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<{ success: boolean; message: string }> {
    const { session, staff } = await this.validateSession(rawToken);

    if (!staff.passwordHash) {
      throw new BadRequestException('Account does not have a configured password');
    }

    const isCurrentValid = await PasswordHasher.verify(staff.passwordHash, currentPassword);
    if (!isCurrentValid) {
      throw new BadRequestException('Current password is incorrect');
    }

    if (!newPassword || newPassword.length < this.config.minPasswordLength) {
      throw new BadRequestException(
        `New password does not meet the minimum length requirement (${this.config.minPasswordLength} characters)`,
      );
    }

    const newPasswordHash = await PasswordHasher.hash(newPassword);
    await this.authRepository.updatePassword(staff.tenantId, staff.id, newPasswordHash);

    // AC-03: Invalidate all OTHER sessions of the same user
    await this.authRepository.revokeAllStaffSessionsExcept(
      staff.tenantId,
      staff.id,
      session.id,
    );

    return { success: true, message: 'Password changed successfully' };
  }

  /**
   * AC-03:
   * Resets staff password by organization admin or SuperAdmin.
   * Cross-tenant resets are strictly rejected.
   * Invalidates ALL sessions of target user.
   */
  async resetPassword(
    adminRawToken: string,
    targetTenantId: string,
    targetStaffId: string,
    newPassword: string,
  ): Promise<{ success: boolean; message: string }> {
    const { staff: adminStaff } = await this.validateSession(adminRawToken);

    const isSuperAdmin = adminStaff.role === 'SUPERADMIN' || adminStaff.role === 'SA';
    const isTenantAdmin = adminStaff.role === 'ADMIN';

    if (!isSuperAdmin && !isTenantAdmin) {
      throw new ForbiddenException('Only organization administrators can reset staff passwords');
    }

    // AC-03: Strictly prevent cross-tenant reset unless SuperAdmin
    if (!isSuperAdmin && adminStaff.tenantId !== targetTenantId) {
      throw new ForbiddenException('Cross-tenant password reset is strictly forbidden');
    }

    const targetStaff = await this.authRepository.findStaffById(targetTenantId, targetStaffId);
    if (!targetStaff) {
      throw new NotFoundException('Target staff record not found in the specified tenant');
    }

    if (!newPassword || newPassword.length < this.config.minPasswordLength) {
      throw new BadRequestException(
        `New password does not meet the minimum length requirement (${this.config.minPasswordLength} characters)`,
      );
    }

    const newPasswordHash = await PasswordHasher.hash(newPassword);
    await this.authRepository.updatePassword(targetTenantId, targetStaffId, newPasswordHash);

    // AC-03: Invalidate ALL sessions of the target user
    await this.authRepository.revokeAllStaffSessions(targetTenantId, targetStaffId);

    return { success: true, message: 'Password reset successfully' };
  }
}
