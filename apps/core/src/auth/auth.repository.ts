import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';

export interface CreateStaffAuthData {
  username: string;
  email: string;
  fullName: string;
  role?: string;
  status?: string;
  passwordHash: string;
}

export interface StaffAuthRecord {
  id: string;
  tenantId: string;
  email: string;
  fullName: string;
  role: string;
  status: string;
  username: string | null;
  passwordHash: string | null;
  failedLoginAttempts: number;
  lockedUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SessionRecord {
  id: string;
  tenantId: string;
  staffId: string;
  tokenHash: string;
  expiresAt: Date;
  revokedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class AuthRepository {
  constructor(private readonly prisma: PrismaService) {}

  private assertTenantId(tenantId: string): void {
    if (!tenantId || typeof tenantId !== 'string' || tenantId.trim().length === 0) {
      throw new Error('Tenant ID is required for authentication operations.');
    }
  }

  async findStaffByUsername(tenantId: string, username: string): Promise<StaffAuthRecord | null> {
    this.assertTenantId(tenantId);
    if (!username || typeof username !== 'string' || username.trim().length === 0) {
      return null;
    }

    return this.prisma.staff.findFirst({
      where: {
        tenantId,
        username: username.trim(),
      },
    });
  }

  async findStaffById(tenantId: string, staffId: string): Promise<StaffAuthRecord | null> {
    this.assertTenantId(tenantId);
    if (!staffId || typeof staffId !== 'string' || staffId.trim().length === 0) {
      return null;
    }

    return this.prisma.staff.findUnique({
      where: {
        tenantId_id: {
          tenantId,
          id: staffId,
        },
      },
    });
  }

  async createStaffWithPassword(
    tenantId: string,
    data: CreateStaffAuthData,
  ): Promise<StaffAuthRecord> {
    this.assertTenantId(tenantId);
    return this.prisma.staff.create({
      data: {
        tenantId,
        username: data.username.trim(),
        email: data.email.trim(),
        fullName: data.fullName.trim(),
        role: data.role ?? 'MEMBER',
        status: data.status ?? 'ACTIVE',
        passwordHash: data.passwordHash,
      },
    });
  }

  async recordFailedLogin(
    tenantId: string,
    staffId: string,
    maxAttempts: number,
    lockoutDurationSeconds: number,
  ): Promise<{ attempts: number; isLocked: boolean; lockedUntil: Date | null }> {
    this.assertTenantId(tenantId);
    const staff = await this.findStaffById(tenantId, staffId);
    if (!staff) {
      return { attempts: 0, isLocked: false, lockedUntil: null };
    }

    const newAttempts = staff.failedLoginAttempts + 1;
    let lockedUntil: Date | null = null;

    if (newAttempts >= maxAttempts) {
      lockedUntil = new Date(Date.now() + lockoutDurationSeconds * 1000);
    }

    await this.prisma.staff.update({
      where: {
        tenantId_id: {
          tenantId,
          id: staffId,
        },
      },
      data: {
        failedLoginAttempts: newAttempts,
        lockedUntil,
      },
    });

    return {
      attempts: newAttempts,
      isLocked: lockedUntil !== null,
      lockedUntil,
    };
  }

  async resetFailedAttempts(tenantId: string, staffId: string): Promise<void> {
    this.assertTenantId(tenantId);
    await this.prisma.staff.update({
      where: {
        tenantId_id: {
          tenantId,
          id: staffId,
        },
      },
      data: {
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
  }

  async updatePassword(
    tenantId: string,
    staffId: string,
    newPasswordHash: string,
  ): Promise<void> {
    this.assertTenantId(tenantId);
    await this.prisma.staff.update({
      where: {
        tenantId_id: {
          tenantId,
          id: staffId,
        },
      },
      data: {
        passwordHash: newPasswordHash,
        failedLoginAttempts: 0,
        lockedUntil: null,
      },
    });
  }

  async createSession(
    tenantId: string,
    staffId: string,
    tokenHash: string,
    expiresAt: Date,
  ): Promise<SessionRecord> {
    this.assertTenantId(tenantId);
    return this.prisma.session.create({
      data: {
        tenantId,
        staffId,
        tokenHash,
        expiresAt,
      },
    });
  }

  async findSessionByTokenHash(tokenHash: string): Promise<SessionRecord | null> {
    if (!tokenHash || typeof tokenHash !== 'string') {
      return null;
    }

    return this.prisma.session.findUnique({
      where: {
        tokenHash,
      },
    });
  }

  async revokeSession(tenantId: string, sessionId: string): Promise<void> {
    this.assertTenantId(tenantId);
    await this.prisma.session.updateMany({
      where: {
        tenantId,
        id: sessionId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
  }

  async revokeAllStaffSessionsExcept(
    tenantId: string,
    staffId: string,
    keepSessionId: string,
  ): Promise<number> {
    this.assertTenantId(tenantId);
    const result = await this.prisma.session.updateMany({
      where: {
        tenantId,
        staffId,
        id: { not: keepSessionId },
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    return result.count;
  }

  async revokeAllStaffSessions(tenantId: string, staffId: string): Promise<number> {
    this.assertTenantId(tenantId);
    const result = await this.prisma.session.updateMany({
      where: {
        tenantId,
        staffId,
        revokedAt: null,
      },
      data: {
        revokedAt: new Date(),
      },
    });
    return result.count;
  }
}
