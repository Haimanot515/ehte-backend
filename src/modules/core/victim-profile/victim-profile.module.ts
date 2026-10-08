import { Module } from '@nestjs/common';

import { AuthModule } from 'src/modules/auth/auth.module';
import { ChapaModule } from 'src/infrastructure/chapa/chapa.module';

import { VictimProfileController } from './controller/victim-profile.controller';

import { VictimProfileCommonService } from './service/victim-profile-common.service';
import { VictimProfileSubmissionService } from './service/victim-profile-submission.service';
import { VictimProfileMineService } from './service/victim-profile-mine.service';
import { VictimProfilePublicService } from './service/victim-profile-public.service';
import { VictimProfileReviewService } from './service/victim-profile-review.service';
import { VictimProfileChildSafetyService } from './service/victim-profile-child-safety.service';
import { VictimProfileFundingService } from './service/victim-profile-funding.service';
import { VictimProfileAdminOpsService } from './service/victim-profile-admin-ops.service';
import { VictimProfileModerationService } from './service/victim-profile-moderation.service';
import { VictimProfileInboxService } from './service/victim-profile-inbox.service';
import { VictimProfileSearchService } from './service/victim-profile-search.service';
import { VictimProfileExportService } from './service/victim-profile-export.service';
import { VictimProfileStatsService } from './service/victim-profile-stats.service';
import { VictimProfileWorkflowService } from './service/victim-profile-workflow.service';

@Module({
  imports: [AuthModule, ChapaModule],

  controllers: [VictimProfileController],

  providers: [
    VictimProfileCommonService,
    VictimProfileSubmissionService,
    VictimProfileMineService,
    VictimProfilePublicService,
    VictimProfileReviewService,
    VictimProfileChildSafetyService,
    VictimProfileFundingService,
    VictimProfileAdminOpsService,
    VictimProfileModerationService,
    VictimProfileInboxService,
    VictimProfileSearchService,
    VictimProfileExportService,
    VictimProfileStatsService,
    VictimProfileWorkflowService,
  ],
})
export class VictimProfileModule {}
