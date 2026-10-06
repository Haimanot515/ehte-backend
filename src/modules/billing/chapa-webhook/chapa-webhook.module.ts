import { Module } from '@nestjs/common';

import { ChapaModule } from 'src/infrastructure/chapa/chapa.module';

import { PaymentModule } from 'src/modules/billing/payment/payment.module';
import { PaymentAdminModule } from 'src/modules/billing/payment-admin/payment-admin.module';

import { ChapaWebhookController } from './controller/chapa-webhook.controller';

@Module({
  imports: [ChapaModule, PaymentModule, PaymentAdminModule],
  controllers: [ChapaWebhookController],
})
export class ChapaWebhookModule {}
