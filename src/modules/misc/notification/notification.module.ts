import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { PrismaModule } from 'src/prisma/prisma.module';
import { FirebaseModule } from 'src/infrastructure/firebase/firebase.module';
import { EmailModule } from 'src/infrastructure/email/email.module';
import { SmsModule } from 'src/infrastructure/sms/sms.module';
import { FirebasePushProvider } from 'src/infrastructure/firebase/firebase-push.provider';

import { AuditLogModule } from '../audit-log/audit-log.module';
import { ExportJobModule } from '../export-job/export-job.module';

import { NotificationController } from './controller/notification.controller';

import { NotificationService } from './service/notification.service';
import { NOTIFICATION_CHANNEL_PROVIDERS } from './service/notification-channel.provider';
import { EmailNotificationProvider } from './service/email-notification.provider';
import { SmsNotificationProvider } from './service/sms-notification.provider';

import { NotificationListener } from './listeners/notification.listener';

@Module({
  imports: [
    PrismaModule,
    EventEmitterModule,
    FirebaseModule,
    EmailModule,
    SmsModule,
    AuditLogModule,
    ExportJobModule,
  ],

  controllers: [NotificationController],

  providers: [
    NotificationService,
    NotificationListener,

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

  exports: [NotificationService],
})
export class NotificationModule {}
