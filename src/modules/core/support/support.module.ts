import { Module } from '@nestjs/common';

import { AuthModule } from 'src/modules/auth/auth.module';

import { SupportController } from './controller/support.controller';

import { SupportCommonService } from './service/support-common.service';
import { SupportSubmissionService } from './service/support-submission.service';
import { SupportMineService } from './service/support-mine.service';
import { SupportPublicService } from './service/support-public.service';
import { SupportIncomingService } from './service/support-incoming.service';
import { SupportLifecycleService } from './service/support-lifecycle.service';
import { SupportAutomationService } from './service/support-automation.service';
import { SupportInboxService } from './service/support-inbox.service';
import { SupportSupportersService } from './service/support-supporters.service';
import { SupportModerationService } from './service/support-moderation.service';
import { SupportAdminOpsService } from './service/support-admin-ops.service';
import { SupportSearchService } from './service/support-search.service';
import { SupportExportService } from './service/support-export.service';
import { SupportStatsService } from './service/support-stats.service';

@Module({
  imports: [AuthModule],

  controllers: [SupportController],

  providers: [
    SupportCommonService,
    SupportSubmissionService,
    SupportMineService,
    SupportPublicService,
    SupportIncomingService,
    SupportLifecycleService,
    SupportAutomationService,
    SupportInboxService,
    SupportSupportersService,
    SupportModerationService,
    SupportAdminOpsService,
    SupportSearchService,
    SupportExportService,
    SupportStatsService,
  ],
})
export class SupportModule {}
