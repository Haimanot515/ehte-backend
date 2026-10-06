import { Module } from '@nestjs/common';

import { AuthModule } from 'src/modules/auth/auth.module';

import { InformationSubmissionController } from './controller/information-submission.controller';

import { InformationSubmissionCommonService } from './service/information-submission-common.service';
import { InformationSubmissionSubmissionService } from './service/information-submission-submission.service';
import { InformationSubmissionMineService } from './service/information-submission-mine.service';
import { InformationSubmissionPublicService } from './service/information-submission-public.service';
import { InformationSubmissionAdminOpsService } from './service/information-submission-admin-ops.service';
import { InformationSubmissionReviewService } from './service/information-submission-review.service';
import { InformationSubmissionWorkflowService } from './service/information-submission-workflow.service';
import { InformationSubmissionInboxService } from './service/information-submission-inbox.service';
import { InformationSubmissionInformantService } from './service/information-submission-informant.service';
import { InformationSubmissionMediaAdminService } from './service/information-submission-media-admin.service';
import { InformationSubmissionSearchService } from './service/information-submission-search.service';
import { InformationSubmissionExportService } from './service/information-submission-export.service';
import { InformationSubmissionStatsService } from './service/information-submission-stats.service';
import { InformationSubmissionOwnerActionsService } from './service/information-submission-owner-actions.service';

@Module({
  imports: [AuthModule],

  controllers: [InformationSubmissionController],

  providers: [
    InformationSubmissionCommonService,
    InformationSubmissionSubmissionService,
    InformationSubmissionMineService,
    InformationSubmissionPublicService,
    InformationSubmissionAdminOpsService,
    InformationSubmissionReviewService,
    InformationSubmissionWorkflowService,
    InformationSubmissionInboxService,
    InformationSubmissionInformantService,
    InformationSubmissionMediaAdminService,
    InformationSubmissionSearchService,
    InformationSubmissionExportService,
    InformationSubmissionStatsService,
    InformationSubmissionOwnerActionsService,
  ],
})
export class InformationSubmissionModule {}
