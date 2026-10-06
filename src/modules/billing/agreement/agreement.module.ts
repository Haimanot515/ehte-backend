import { Module } from '@nestjs/common';

import { BillingEventsModule } from 'src/modules/billing/billing-events/billing-events.module';

import { AgreementController } from './controller/agreement.controller';

import { AgreementService } from './service/agreement.service';

@Module({
  imports: [BillingEventsModule],
  controllers: [AgreementController],
  providers: [AgreementService],
})
export class AgreementModule {}
