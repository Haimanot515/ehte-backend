import { Module } from '@nestjs/common';

import { NotificationModule } from 'src/modules/misc/notification/notification.module';

import { AdminWorkspaceController } from './admin-workspace/controller/admin-workspace.controller';
import { AnnouncementsController } from './announcements/controller/announcements.controller';
import { ApiClientsController } from './api-clients/controller/api-clients.controller';
import { ContentController } from './content/controller/content.controller';
import { DeliveryWebhooksController } from './delivery-webhooks/controller/delivery-webhooks.controller';
import { FollowsController } from './follows/controller/follows.controller';
import { HelpDeskController } from './help-desk/controller/help.controller';
import { LegalController } from './legal/controller/legal.controller';
import { AdminNotesController } from './notes/controller/admin-notes.controller';
import { AdminReferralsController } from './referrals/controller/admin-referrals.controller';
import { UserBlockingAbuseController } from './user-blocking-abuse/controller/user-blocking-abuse.controller';

import { AdminWorkspaceService } from './admin-workspace/service/admin-workspace.service';
import { AnnouncementsService } from './announcements/service/announcements.service';
import { ApiClientsService } from './api-clients/service/api-clients.service';
import { ContentService } from './content/service/content.service';
import { DeliveryWebhooksService } from './delivery-webhooks/service/delivery-webhooks.service';
import { FollowsService } from './follows/service/follows.service';
import { HelpDeskService } from './help-desk/service/help-desk.service';
import { LegalService } from './legal/service/legal.service';
import { AdminNotesService } from './notes/service/admin-notes.service';
import { AdminReferralsService } from './referrals/service/admin-referrals.service';
import { UserBlockingAbuseService } from './user-blocking-abuse/service/user-blocking-abuse.service';

@Module({
  imports: [NotificationModule],

  controllers: [
    AdminWorkspaceController,
    AnnouncementsController,
    ApiClientsController,
    ContentController,
    DeliveryWebhooksController,
    FollowsController,
    HelpDeskController,
    LegalController,
    AdminNotesController,
    AdminReferralsController,
    UserBlockingAbuseController,
  ],

  providers: [
    AdminWorkspaceService,
    AnnouncementsService,
    ApiClientsService,
    ContentService,
    DeliveryWebhooksService,
    FollowsService,
    HelpDeskService,
    LegalService,
    AdminNotesService,
    AdminReferralsService,
    UserBlockingAbuseService,
  ],
})
export class SharedModule {}
