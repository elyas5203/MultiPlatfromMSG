import { Injectable } from '@nestjs/common';
import { PrismaService } from '../database/prisma.service';
import { assertValidTenantId } from './tenant-scope';
import { Tenant, Brand, Staff, Team, StaffTeam } from '@prisma/client';

export interface CreateTenantInput {
  id?: string;
  name: string;
  slug: string;
}

export interface CreateBrandInput {
  id?: string;
  name: string;
  code?: string;
}

export interface CreateStaffInput {
  id?: string;
  email: string;
  fullName: string;
  role?: string;
  status?: string;
}

export interface CreateTeamInput {
  id?: string;
  name: string;
  description?: string;
}

@Injectable()
export class TenantRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Tenant Operations ---

  async createTenant(data: CreateTenantInput): Promise<Tenant> {
    return this.prisma.tenant.create({
      data: {
        id: data.id,
        name: data.name,
        slug: data.slug,
      },
    });
  }

  async findTenantById(tenantId: unknown): Promise<Tenant | null> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.tenant.findUnique({
      where: { id: validTenantId },
    });
  }

  // --- Brand Operations (Tenant-Scoped) ---

  async createBrand(tenantId: unknown, data: CreateBrandInput): Promise<Brand> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.brand.create({
      data: {
        id: data.id,
        tenantId: validTenantId,
        name: data.name,
        code: data.code,
      },
    });
  }

  async findBrandById(tenantId: unknown, brandId: string): Promise<Brand | null> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!brandId || typeof brandId !== 'string') {
      return null;
    }
    return this.prisma.brand.findFirst({
      where: {
        id: brandId.trim(),
        tenantId: validTenantId,
      },
    });
  }

  async listBrands(tenantId: unknown): Promise<Brand[]> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.brand.findMany({
      where: { tenantId: validTenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // --- Staff Operations (Tenant-Scoped) ---

  async createStaff(tenantId: unknown, data: CreateStaffInput): Promise<Staff> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.staff.create({
      data: {
        id: data.id,
        tenantId: validTenantId,
        email: data.email.trim().toLowerCase(),
        fullName: data.fullName,
        role: data.role ?? 'MEMBER',
        status: data.status ?? 'ACTIVE',
      },
    });
  }

  async findStaffById(tenantId: unknown, staffId: string): Promise<Staff | null> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!staffId || typeof staffId !== 'string') {
      return null;
    }
    return this.prisma.staff.findFirst({
      where: {
        id: staffId.trim(),
        tenantId: validTenantId,
      },
    });
  }

  async listStaff(tenantId: unknown): Promise<Staff[]> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.staff.findMany({
      where: { tenantId: validTenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // --- Team Operations (Tenant-Scoped) ---

  async createTeam(tenantId: unknown, data: CreateTeamInput): Promise<Team> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.team.create({
      data: {
        id: data.id,
        tenantId: validTenantId,
        name: data.name,
        description: data.description,
      },
    });
  }

  async findTeamById(tenantId: unknown, teamId: string): Promise<Team | null> {
    const validTenantId = assertValidTenantId(tenantId);
    if (!teamId || typeof teamId !== 'string') {
      return null;
    }
    return this.prisma.team.findFirst({
      where: {
        id: teamId.trim(),
        tenantId: validTenantId,
      },
    });
  }

  async listTeams(tenantId: unknown): Promise<Team[]> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.team.findMany({
      where: { tenantId: validTenantId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // --- Staff-Team Membership Operations (Tenant-Scoped) ---

  async assignStaffToTeam(
    tenantId: unknown,
    staffId: string,
    teamId: string,
    role?: string,
  ): Promise<StaffTeam> {
    const validTenantId = assertValidTenantId(tenantId);

    // Strictly verify both staff and team belong to the validated tenant scope
    const staff = await this.findStaffById(validTenantId, staffId);
    if (!staff) {
      throw new Error(`Staff record '${staffId}' not found within tenant scope '${validTenantId}'.`);
    }

    const team = await this.findTeamById(validTenantId, teamId);
    if (!team) {
      throw new Error(`Team record '${teamId}' not found within tenant scope '${validTenantId}'.`);
    }

    return this.prisma.staffTeam.create({
      data: {
        tenantId: validTenantId,
        staffId: staff.id,
        teamId: team.id,
        role: role,
      },
    });
  }

  async listTeamMembers(tenantId: unknown, teamId: string): Promise<StaffTeam[]> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.staffTeam.findMany({
      where: {
        tenantId: validTenantId,
        teamId: teamId.trim(),
      },
      include: {
        staff: true,
      },
    });
  }

  async listStaffTeams(tenantId: unknown, staffId: string): Promise<StaffTeam[]> {
    const validTenantId = assertValidTenantId(tenantId);
    return this.prisma.staffTeam.findMany({
      where: {
        tenantId: validTenantId,
        staffId: staffId.trim(),
      },
      include: {
        team: true,
      },
    });
  }

  // --- Strict Tenant Boundary Cleanup (Never Global Wipe) ---

  async clearTenant(tenantId: unknown): Promise<void> {
    const validTenantId = assertValidTenantId(tenantId);
    await this.prisma.$transaction([
      this.prisma.staffTeam.deleteMany({ where: { tenantId: validTenantId } }),
      this.prisma.brand.deleteMany({ where: { tenantId: validTenantId } }),
      this.prisma.staff.deleteMany({ where: { tenantId: validTenantId } }),
      this.prisma.team.deleteMany({ where: { tenantId: validTenantId } }),
      this.prisma.tenant.deleteMany({ where: { id: validTenantId } }),
    ]);
  }
}
