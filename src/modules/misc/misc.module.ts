import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { PrismaModule } from 'src/prisma/prisma.module';

import { AuditLogController } from './controller/audit-log.controller';
import { NotificationController } from './controller/notification.controller';

import { AuditLogService } from './service/audit-log.service';
import { NotificationService } from './service/notification.service';

import { AuditLogListener } from './listeners/audit-log.listener';
import { NotificationListener } from './listeners/notification.listener';

@Module({
  imports: [PrismaModule, EventEmitterModule],

  controllers: [AuditLogController, NotificationController],

  providers: [AuditLogService, NotificationService, AuditLogListener, NotificationListener],

  exports: [AuditLogService, NotificationService],
})
export class MiscModule {}
