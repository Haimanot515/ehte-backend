import { Module } from '@nestjs/common';

import { BillingEventsModule } from 'src/modules/billing/billing-events/billing-events.module';

import { RewardAdminController } from './controller/reward-admin.controller';

import { RewardAdminService } from './service/reward-admin.service';

@Module({
  imports: [BillingEventsModule],
  controllers: [RewardAdminController],
  providers: [RewardAdminService],
})
export class RewardAdminModule {}
