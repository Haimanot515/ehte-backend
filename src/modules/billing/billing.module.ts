import { Module } from '@nestjs/common';
import { ChapaModule } from '../../services/chapa/chapa.module';
import { PayerBillingController } from './controller/payer-billing.controller';
import { PaymentAdminController } from './controller/payment-admin.controller';
import { InstitutionAdminController } from './controller/institution-admin.controller';
import { DisbursementAdminController } from './controller/disbursement-admin.controller';
import { RewardAdminController } from './controller/reward-admin.controller';
import { BillingReportAdminController } from './controller/billing-report-admin.controller';
import { PaymentController } from './controller/payment.controller';
import { ChapaWebhookController } from './controller/chapa-webhook.controller';
import { AgreementController } from './controller/agreement.controller';
import { DisbursementController } from './controller/disbursement.controller';
import { RewardController } from './controller/reward.controller';
import { BillingReportController } from './controller/billing-report.controller';
import { AllocationService } from './service/allocation.service';
import { PaymentService } from './service/payment.service';
import { RewardService } from './service/reward.service';
import { DisbursementService } from './service/disbursement.service';
import { AgreementService } from './service/agreement.service';
import { BillingEventsService } from './service/billing-events.service';
import { FundingQueryService } from './service/funding-query.service';
import { PayerBillingService } from './service/payer-billing.service';
import { PaymentAdminService } from './service/payment-admin.service';
import { InstitutionAdminService } from './service/institution-admin.service';
import { DisbursementAdminService } from './service/disbursement-admin.service';
import { RewardAdminService } from './service/reward-admin.service';
import { BillingReportAdminService } from './service/billing-report-admin.service';

@Module({
  imports: [ChapaModule],
  controllers: [
    PayerBillingController,
    PaymentAdminController,
    InstitutionAdminController,
    DisbursementAdminController,
    RewardAdminController,
    BillingReportAdminController,
    PaymentController,
    ChapaWebhookController,
    AgreementController,
    DisbursementController,
    RewardController,
    BillingReportController,
  ],
  providers: [
    BillingEventsService,
    AllocationService,
    PaymentService,
    RewardService,
    DisbursementService,
    AgreementService,
    FundingQueryService,
    PayerBillingService,
    PaymentAdminService,
    InstitutionAdminService,
    DisbursementAdminService,
    RewardAdminService,
    BillingReportAdminService,
  ],
  exports: [
    AllocationService,
    PaymentService,
    RewardService,
    BillingEventsService,
    FundingQueryService,
  ],
})
export class BillingModule {}
