import { Module } from '@nestjs/common';

import { PaymentModule } from 'src/modules/billing/payment/payment.module';
import { BillingEventsModule } from 'src/modules/billing/billing-events/billing-events.module';

import { PayerBillingController } from './controller/payer-billing.controller';

import { PayerBillingService } from './service/payer-billing.service';

@Module({
  imports: [PaymentModule, BillingEventsModule],
  controllers: [PayerBillingController],
  providers: [PayerBillingService],
})
export class PayerBillingModule {}
