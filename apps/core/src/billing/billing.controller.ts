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
import { RolesGuard } from '../rbac/roles.guard';
import { Roles } from '../rbac/roles.decorator';
import { Role } from '../rbac/roles.enum';
import { BillingService } from './billing.service';
import {
  TopUpDto,
  ReserveCreditDto,
  SettleReservationDto,
  ReleaseReservationDto,
  CreateWalletAccountDto,
} from './dto/billing.dto';

@Controller('billing')
@UseGuards(TenantGuard, RolesGuard)
@UseInterceptors(TenantInterceptor)
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  // ==================== Wallet & Balance ====================

  @Get('balance')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async getBalance(@Query('accountId') accountId?: string) {
    return this.billingService.getWalletBalance(accountId);
  }

  @Get('accounts')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async listAccounts() {
    return this.billingService.listAccounts();
  }

  @Post('accounts')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.OMGR)
  async createAccount(@Body() body: unknown) {
    const input = CreateWalletAccountDto.parse(body);
    return this.billingService.createAccount(input);
  }

  // ==================== Top-Up (Credits) ====================

  @Post('topup')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.OMGR, Role.OP)
  async topUp(@Body() body: unknown) {
    const input = TopUpDto.parse(body);
    return this.billingService.topUpWallet(input);
  }

  // ==================== Ledger History ====================

  @Get('ledger')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async listLedgerEntries(@Query('accountId') accountId?: string) {
    return this.billingService.listLedgerEntries(accountId);
  }

  // ==================== Reservations ====================

  @Get('reservations')
  @Roles(Role.OMGR, Role.OP, Role.STF, Role.AUD)
  async listActiveReservations(@Query('accountId') accountId?: string) {
    return this.billingService.listActiveReservations(accountId);
  }

  @Post('reserve')
  @HttpCode(HttpStatus.CREATED)
  @Roles(Role.OMGR, Role.OP, Role.STF)
  async reserveCredit(@Body() body: unknown) {
    const input = ReserveCreditDto.parse(body);
    return this.billingService.reserveCredit(input);
  }

  @Post('settle')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OMGR, Role.OP, Role.STF)
  async settleReservation(@Body() body: unknown) {
    const input = SettleReservationDto.parse(body);
    return this.billingService.settleReservation(input);
  }

  @Post('release')
  @HttpCode(HttpStatus.OK)
  @Roles(Role.OMGR, Role.OP, Role.STF)
  async releaseReservation(@Body() body: unknown) {
    const input = ReleaseReservationDto.parse(body);
    return this.billingService.releaseReservation(input);
  }
}
