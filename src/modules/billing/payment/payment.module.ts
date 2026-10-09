import { Module } from '@nestjs/common';

import { ChapaModule } from 'src/infrastructure/chapa/chapa.module';

import { BillingEventsModule } from 'src/modules/billing/billing-events/billing-events.module';
import { AllocationModule } from 'src/modules/billing/allocation/allocation.module';

import { PaymentController } from './controller/payment.controller';

import { PaymentService } from './service/payment.service';
import { PostingFeeFulfilmentService } from './service/posting-fee-fulfilment.service';

@Module({
  imports: [ChapaModule, BillingEventsModule, AllocationModule],
  controllers: [PaymentController],
  providers: [PaymentService, PostingFeeFulfilmentService],
  exports: [PaymentService],
})
export class PaymentModule {}
