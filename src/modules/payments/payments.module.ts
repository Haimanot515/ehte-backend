import { Module } from '@nestjs/common';
import { ChapaModule } from 'src/infrastructure/chapa/chapa.module';
import { DonationController } from './controller/donation.controller';
import { ChapaWebhookController } from './controller/chapa-webhook.controller';
import { AdminPaymentsController } from './controller/admin-payments.controller';
import { DonationService } from './service/donation.service';
import { ChapaWebhookService } from './service/chapa-webhook.service';
import { PaymentsAdminService } from './service/payments-admin.service';
import { PayoutService } from './service/payout.service';

@Module({
  imports: [ChapaModule],
  controllers: [DonationController, ChapaWebhookController, AdminPaymentsController],
  providers: [DonationService, ChapaWebhookService, PaymentsAdminService, PayoutService],
  exports: [PayoutService],
})
export class PaymentsModule {}
