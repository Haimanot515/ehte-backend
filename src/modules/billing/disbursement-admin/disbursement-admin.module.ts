import { Module } from '@nestjs/common';

import { DisbursementModule } from 'src/modules/billing/disbursement/disbursement.module';
import { BillingEventsModule } from 'src/modules/billing/billing-events/billing-events.module';

import { DisbursementAdminController } from './controller/disbursement-admin.controller';

import { DisbursementAdminService } from './service/disbursement-admin.service';

@Module({
  imports: [DisbursementModule, BillingEventsModule],
  controllers: [DisbursementAdminController],
  providers: [DisbursementAdminService],
})
export class DisbursementAdminModule {}
