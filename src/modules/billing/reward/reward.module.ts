import { Module } from '@nestjs/common';

import { BillingEventsModule } from 'src/modules/billing/billing-events/billing-events.module';

import { RewardController } from './controller/reward.controller';

import { RewardService } from './service/reward.service';

@Module({
  imports: [BillingEventsModule],
  controllers: [RewardController],
  providers: [RewardService],
  exports: [RewardService],
})
export class RewardModule {}
