import { Module } from '@nestjs/common';

import { AuthModule } from 'src/modules/auth/auth.module';

import { PostController } from './controller/post.controller';

import { PostCommonService } from './service/post-common.service';
import { PostSubmissionService } from './service/post-submission.service';
import { PostMineService } from './service/post-mine.service';
import { PostPublicService } from './service/post-public.service';
import { PostReviewService } from './service/post-review.service';
import { PostAdminService } from './service/post-admin.service';
import { PostInboxService } from './service/post-inbox.service';
import { PostModerationService } from './service/post-moderation.service';
import { PostStatsService } from './service/post-stats.service';
import { PostRetentionService } from './service/post-retention.service';

@Module({
  imports: [AuthModule],

  controllers: [PostController],

  providers: [
    PostCommonService,
    PostSubmissionService,
    PostMineService,
    PostPublicService,
    PostReviewService,
    PostAdminService,
    PostInboxService,
    PostModerationService,
    PostStatsService,
    PostRetentionService,
  ],
})
export class PostModule {}
