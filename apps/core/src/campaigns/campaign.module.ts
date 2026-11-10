/**
 * Campaign Module (Phase 7)
 */

import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { ContactsModule } from '../contacts/contacts.module';
import { BillingModule } from '../billing/billing.module';
import { MessagingModule } from '../messaging/messaging.module';
import { SenderRoutingEngine } from '../senders/routing-engine';
import { CampaignRepository } from './campaign.repository';
import { CampaignService } from './campaign.service';
import { CampaignController } from './campaign.controller';

@Module({
  imports: [DatabaseModule, ContactsModule, BillingModule, MessagingModule],
  controllers: [CampaignController],
  providers: [CampaignRepository, CampaignService, SenderRoutingEngine],
  exports: [CampaignRepository, CampaignService],
})
export class CampaignModule {}
