import { Module, forwardRef } from '@nestjs/common';

import { AuthModule } from 'src/modules/auth/auth.module';
import { RewardModule } from 'src/modules/billing/reward/reward.module';

import { MissingPersonController } from './controller/missing-person.controller';

import { MissingPersonCommonService } from './service/missing-person-common.service';
import { MissingPersonSubmissionService } from './service/missing-person-submission.service';
import { MissingPersonMineService } from './service/missing-person-mine.service';
import { MissingPersonCaseUpdatesService } from './service/missing-person-case-updates.service';
import { MissingPersonPublicService } from './service/missing-person-public.service';
import { MissingPersonReviewService } from './service/missing-person-review.service';
import { MissingPersonModerationService } from './service/missing-person-moderation.service';
import { MissingPersonAdminOpsService } from './service/missing-person-admin-ops.service';
import { MissingPersonDuplicatesService } from './service/missing-person-duplicates.service';
import { MissingPersonMediaAdminService } from './service/missing-person-media-admin.service';
import { MissingPersonSearchService } from './service/missing-person-search.service';
import { MissingPersonInboxService } from './service/missing-person-inbox.service';
import { MissingPersonExportService } from './service/missing-person-export.service';
import { MissingPersonStatsService } from './service/missing-person-stats.service';

@Module({
  imports: [AuthModule, forwardRef(() => RewardModule)],

  controllers: [MissingPersonController],

  providers: [
    MissingPersonCommonService,
    MissingPersonSubmissionService,
    MissingPersonMineService,
    MissingPersonCaseUpdatesService,
    MissingPersonPublicService,
    MissingPersonReviewService,
    MissingPersonModerationService,
    MissingPersonAdminOpsService,
    MissingPersonDuplicatesService,
    MissingPersonMediaAdminService,
    MissingPersonSearchService,
    MissingPersonInboxService,
    MissingPersonExportService,
    MissingPersonStatsService,
  ],
})
export class MissingPersonModule {}
