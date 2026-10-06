import { Module } from '@nestjs/common';

import { BillingEventsService } from './service/billing-events.service';

@Module({
  providers: [BillingEventsService],
  exports: [BillingEventsService],
})
export class BillingEventsModule {}
