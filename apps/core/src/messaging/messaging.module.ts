/**
 * Messaging & Dispatch Module (Phase 6)
 */

import { Module } from '@nestjs/common';
import { KillSwitchService } from './kill-switch.service';
import { DispatchRateLimiter } from './rate-limiter';
import { TelegramConnector } from './connectors/telegram.connector';
import { BaleConnector } from './connectors/bale.connector';
import { DispatcherService } from './dispatcher.service';

@Module({
  providers: [
    KillSwitchService,
    DispatchRateLimiter,
    TelegramConnector,
    BaleConnector,
    DispatcherService,
  ],
  exports: [
    KillSwitchService,
    DispatchRateLimiter,
    TelegramConnector,
    BaleConnector,
    DispatcherService,
  ],
})
export class MessagingModule {}
