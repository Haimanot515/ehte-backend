import { Module } from '@nestjs/common';

import { PaymentModule } from 'src/modules/billing/payment/payment.module';
import { BillingEventsModule } from 'src/modules/billing/billing-events/billing-events.module';

import { PaymentAdminController } from './controller/payment-admin.controller';

import { PaymentAdminService } from './service/payment-admin.service';

@Module({
  imports: [PaymentModule, BillingEventsModule],
  controllers: [PaymentAdminController],
  providers: [PaymentAdminService],
  exports: [PaymentAdminService],
})
export class PaymentAdminModule {}
