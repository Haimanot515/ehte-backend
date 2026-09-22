// src/modules/ussd/ussd.module.ts

import { Module } from '@nestjs/common';

import { UssdController } from './controller/ussd.controller';

import { UssdMenuService } from './service/ussd-menu.service';
import { UssdSessionService } from './service/ussd-session.service';

import { UssdReportService } from './service/ussd-report.service';
import { UssdMissingPersonService } from './service/ussd-missing-person.service';
import {
  UssdInformationSubmissionService,
} from './service/ussd-information-submission.service';

import { AfricasTalkingStyleAdapter } from './service/adapters/africastalking-style.adapter';
import { EthioTelecomAdapter } from './service/adapters/ethio-telecom.adapter';

import { CoreModule } from '../core/core.module';
import { RedisModule } from '../../services/redis/redis.module';

@Module({
  imports: [
    CoreModule,
    RedisModule,
  ],

  controllers: [
    UssdController,
  ],

  providers: [
    UssdMenuService,
    UssdSessionService,

    UssdReportService,
    UssdMissingPersonService,
    UssdInformationSubmissionService,

    AfricasTalkingStyleAdapter,
    EthioTelecomAdapter,
  ],
})
export class UssdModule {}