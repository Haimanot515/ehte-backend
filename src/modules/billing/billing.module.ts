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
import { FX_RATE_PROVIDER, UnconfiguredFxRateProvider } from './service/fx-rate.provider';
import { InstitutionController } from './controller/institution.controller';
import { InstitutionService } from './service/institution.service';

@Module({
  imports: [ChapaModule],
  controllers: [
    PaymentController,
    ChapaWebhookController,
    AgreementController,
    DisbursementController,
    BillingReportController,
    InstitutionController,
  ],
  providers: [
    BillingEventsService,
    AllocationService,
    PaymentService,
    RewardService,
    DisbursementService,
    AgreementService,
    FundingQueryService,
    InstitutionService,
    // GAP 7: swap this binding for a real feed's implementation of
    // FxRateProvider (see fx-rate.provider.ts) once one is chosen.
    // Left as UnconfiguredFxRateProvider — which always throws
    // FxRateUnavailableException — until then, so a currency divergence
    // fails loudly instead of silently converting at a guessed rate.
    { provide: FX_RATE_PROVIDER, useClass: UnconfiguredFxRateProvider },
  ],
  exports: [
    AllocationService,
    PaymentService,
    RewardService,
    BillingEventsService,
    FundingQueryService,
    InstitutionService,
  ],
})
export class BillingModule {}