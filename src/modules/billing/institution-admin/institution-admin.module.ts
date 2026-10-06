import { Module } from '@nestjs/common';

import { BillingEventsModule } from 'src/modules/billing/billing-events/billing-events.module';

import { InstitutionAdminController } from './controller/institution-admin.controller';

import { InstitutionAdminService } from './service/institution-admin.service';

@Module({
  imports: [BillingEventsModule],
  controllers: [InstitutionAdminController],
  providers: [InstitutionAdminService],
})
export class InstitutionAdminModule {}
