import { Module } from '@nestjs/common';

import { PaymentModule } from 'src/modules/billing/payment/payment.module';
import { FundingModule } from 'src/modules/billing/funding/funding.module';
import { BillingEventsModule } from 'src/modules/billing/billing-events/billing-events.module';

import { BillingReportAdminController } from './controller/billing-report-admin.controller';
import { BillingReportController } from './controller/billing-report.controller';

import { BillingReportAdminService } from './service/billing-report-admin.service';

@Module({
  imports: [PaymentModule, FundingModule, BillingEventsModule],
  controllers: [BillingReportAdminController, BillingReportController],
  providers: [BillingReportAdminService],
})
export class BillingReportModule {}
