import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';

@Module({
  imports: [DatabaseModule],
  controllers: [BillingController],
  providers: [BillingRepository, BillingService],
  exports: [BillingRepository, BillingService],
})
export class BillingModule {}
