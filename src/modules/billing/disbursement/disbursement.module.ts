import { Module } from '@nestjs/common';

import { ChapaModule } from 'src/infrastructure/chapa/chapa.module';

import { BillingEventsModule } from 'src/modules/billing/billing-events/billing-events.module';

import { DisbursementController } from './controller/disbursement.controller';

import { DisbursementService } from './service/disbursement.service';

@Module({
  imports: [ChapaModule, BillingEventsModule],
  controllers: [DisbursementController],
  providers: [DisbursementService],
  exports: [DisbursementService],
})
export class DisbursementModule {}
