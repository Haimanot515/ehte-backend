// src/modules/billing/billing.module.ts
//
// Assumes PrismaModule and ConfigModule are global, and that EventEmitterModule.forRoot()
// and ScheduleModule.forRoot() are registered once in AppModule.

import { Module } from '@nestjs/common';
import { ChapaModule } from '../../services/chapa/chapa.module';
import { PaymentController } from './controller/payment.controller';
import { ChapaWebhookController } from './controller/chapa-webhook.controller';
import { AgreementController } from './controller/agreement.controller';
import { DisbursementController } from './controller/disbursement.controller';
import { BillingReportController } from './controller/billing-report.controller';
import { AllocationService } from './service/allocation.service';
import { PaymentService } from './service/payment.service';
import { RewardService } from './service/reward.service';
import { DisbursementService } from './service/disbursement.service';
import { AgreementService } from './service/agreement.service';
import { BillingEventsService } from './service/billing-events.service';
import { FundingQueryService } from './service/funding-query.service';

@Module({
  imports: [ChapaModule],
  controllers: [
    PaymentController,
    ChapaWebhookController,
    AgreementController,
    DisbursementController,
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
  ],
  exports: [AllocationService, PaymentService, RewardService, BillingEventsService, FundingQueryService],
})
export class BillingModule {}
