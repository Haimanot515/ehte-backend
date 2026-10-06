import { Module } from '@nestjs/common';

import { AuthModule } from 'src/modules/auth/auth.module';

import { UserController } from './controller/user.controller';

import { UserCommonService } from './service/user-common.service';
import { UserProfileService } from './service/user-profile.service';
import { UserAccountService } from './service/user-account.service';
import { UserPrivacyService } from './service/user-privacy.service';
import { UserRolesService } from './service/user-roles.service';
import { UserAdminActionsService } from './service/user-admin-actions.service';
import { UserInspectService } from './service/user-inspect.service';
import { UserAdminOpsService } from './service/user-admin-ops.service';
import { UserSearchService } from './service/user-search.service';
import { UserExportService } from './service/user-export.service';
import { UserStatsService } from './service/user-stats.service';

@Module({
  imports: [AuthModule],

  controllers: [UserController],

  providers: [
    UserCommonService,
    UserProfileService,
    UserAccountService,
    UserPrivacyService,
    UserRolesService,
    UserAdminActionsService,
    UserInspectService,
    UserAdminOpsService,
    UserSearchService,
    UserExportService,
    UserStatsService,
  ],
})
export class UserModule {}
