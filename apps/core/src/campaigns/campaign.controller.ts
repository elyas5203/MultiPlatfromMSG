/**
 * Campaign Controller (Phase 7)
 *
 * REST Endpoints for Campaign Management, Scheduling and Batch Execution.
 * Guarded by TenantGuard and RolesGuard.
 */

import {
  Controller,
  Get,
  Post,
  Param,
  Query,
  Body,
  HttpCode,
  HttpStatus,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { TenantGuard } from '../tenant/tenant.guard';
import { TenantInterceptor } from '../tenant/tenant.interceptor';
import { TenantContext } from '../tenant/tenant-context';
import { RolesGuard } from '../rbac/roles.guard';
import { Roles } from '../rbac/roles.decorator';
import { Role } from '../rbac/roles.enum';
import { CampaignService } from './campaign.service';
import {
  CreateCampaignDto,
  ScheduleCampaignDto,
  ExecuteCampaignDto,
  ListCampaignsFilterDto,
} from './dto/campaign.dto';

@Controller('campaigns')
@UseGuards(TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
export class CampaignController {
  constructor(private readonly campaignService: CampaignService) {}

  @Post()
  @Roles(Role.OMGR, Role.OP)
  @HttpCode(HttpStatus.CREATED)
  async createCampaign(@Body() dto: CreateCampaignDto) {
    const tenantId = TenantContext.getTenantId();
    return this.campaignService.createCampaign(tenantId, dto);
  }

  @Get()
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async listCampaigns(@Query() filter: ListCampaignsFilterDto) {
    const tenantId = TenantContext.getTenantId();
    return this.campaignService.listCampaigns(tenantId, filter);
  }

  @Get(':id')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async getCampaign(@Param('id') id: string) {
    const tenantId = TenantContext.getTenantId();
    return this.campaignService.getCampaign(tenantId, id);
  }

  @Get(':id/progress')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async getCampaignProgress(@Param('id') id: string) {
    const tenantId = TenantContext.getTenantId();
    return this.campaignService.getProgress(tenantId, id);
  }

  @Post(':id/schedule')
  @Roles(Role.OMGR, Role.OP)
  @HttpCode(HttpStatus.OK)
  async scheduleCampaign(@Param('id') id: string, @Body() dto: ScheduleCampaignDto) {
    const tenantId = TenantContext.getTenantId();
    return this.campaignService.scheduleCampaign(tenantId, id, dto);
  }

  @Post(':id/execute')
  @Roles(Role.OMGR, Role.OP)
  @HttpCode(HttpStatus.OK)
  async executeCampaign(@Param('id') id: string, @Body() dto: ExecuteCampaignDto) {
    const tenantId = TenantContext.getTenantId();
    return this.campaignService.executeCampaign(tenantId, id, dto);
  }

  @Post(':id/pause')
  @Roles(Role.OMGR, Role.OP)
  @HttpCode(HttpStatus.OK)
  async pauseCampaign(@Param('id') id: string) {
    const tenantId = TenantContext.getTenantId();
    return this.campaignService.pauseCampaign(tenantId, id);
  }

  @Post(':id/resume')
  @Roles(Role.OMGR, Role.OP)
  @HttpCode(HttpStatus.OK)
  async resumeCampaign(@Param('id') id: string) {
    const tenantId = TenantContext.getTenantId();
    return this.campaignService.resumeCampaign(tenantId, id);
  }

  @Post(':id/cancel')
  @Roles(Role.OMGR, Role.OP)
  @HttpCode(HttpStatus.OK)
  async cancelCampaign(@Param('id') id: string, @Body('reason') reason?: string) {
    const tenantId = TenantContext.getTenantId();
    return this.campaignService.cancelCampaign(tenantId, id, reason);
  }
}
