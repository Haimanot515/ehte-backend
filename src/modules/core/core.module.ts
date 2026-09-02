import { Module } from '@nestjs/common';

import { UserController } from './controller/user.controller';
import { ReportController } from './controller/report.controller';
import { PostController } from './controller/post.controller';
import { MissingPersonController } from './controller/missing-person.controller';
import { InformationSubmissionController } from './controller/information-submission.controller';
import { VictimProfileController } from './controller/victim-profile.controller';
import { SupportController } from './controller/support.controller';

import { UserService } from './service/user.service';
import { ReportService } from './service/report.service';
import { PostService } from './service/post.service';
import { MissingPersonService } from './service/missing-person.service';
import { InformationSubmissionService } from './service/information-submission.service';
import { VictimProfileService } from './service/victim-profile.service';
import { SupportService } from './service/support.service';

@Module({
  controllers: [
    UserController,
    ReportController,
    PostController,
    MissingPersonController,
    InformationSubmissionController,
    VictimProfileController,
    SupportController,
  ],

  providers: [
    UserService,
    ReportService,
    PostService,
    MissingPersonService,
    InformationSubmissionService,
    VictimProfileService,
    SupportService,
  ],

  exports: [
    UserService,
    ReportService,
    PostService,
    MissingPersonService,
    InformationSubmissionService,
    VictimProfileService,
    SupportService,
  ],
})
export class CoreModule {}
