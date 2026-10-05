import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { PrismaModule } from 'src/prisma/prisma.module';
import { MinioModule } from 'src/services/minio/minio.module';
import { FirebaseModule } from 'src/services/firebase/firebase.module';
import { EmailModule } from 'src/services/email/email.module';
import { SmsModule } from 'src/services/sms/sms.module';

import { AuditLogController } from './controller/audit-log.controller';
import { MyAuditController } from './controller/my-audit.controller';
import { NotificationController } from './controller/notification.controller';
import { ExplorerController } from './controller/explorer.controller';

import { AuditLogService } from './service/audit-log.service';
import { NotificationService } from './service/notification.service';
import { ExplorerService } from './service/explorer.service';
import { AUDIT_ARCHIVE_STORAGE } from './service/audit-archive.storage';
import { MinioAuditArchiveStorage } from './service/minio-audit-archive.storage';
import { NOTIFICATION_CHANNEL_PROVIDERS } from './service/notification-channel.provider';
import { FirebasePushProvider } from '../../services/firebase/firebase-push.provider';
import { EmailNotificationProvider } from './service/email-notification.provider';
import { SmsNotificationProvider } from './service/sms-notification.provider';
import { ExportJobService } from './service/export-job.service';
import { MISC_OBJECT_STORAGE, MinioMiscObjectStorage } from './service/misc-object-storage';

import { AuditLogListener } from './listeners/audit-log.listener';
import { NotificationListener } from './listeners/notification.listener';

@Module({
  imports: [PrismaModule, EventEmitterModule, MinioModule, FirebaseModule, EmailModule, SmsModule],

  // MyAuditController must stay FIRST: its 'me' routes have to be matched before AuditLogController's 'GET :id'.
  controllers: [MyAuditController, AuditLogController, NotificationController, ExplorerController],

  providers: [
    AuditLogService,
    NotificationService,
    ExplorerService,
    AuditLogListener,
    NotificationListener,
    { provide: AUDIT_ARCHIVE_STORAGE, useClass: MinioAuditArchiveStorage },
    { provide: MISC_OBJECT_STORAGE, useClass: MinioMiscObjectStorage },
    ExportJobService,

    FirebasePushProvider,
    EmailNotificationProvider,
    SmsNotificationProvider,

    {
      provide: NOTIFICATION_CHANNEL_PROVIDERS,
      useFactory: (
        push: FirebasePushProvider,
        email: EmailNotificationProvider,
        sms: SmsNotificationProvider,
      ) => [push, email, sms],
      inject: [FirebasePushProvider, EmailNotificationProvider, SmsNotificationProvider],
    },
  ],

  exports: [AuditLogService, NotificationService],
})
export class MiscModule {}