import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { PrismaModule } from 'src/prisma/prisma.module';
import { MinioModule } from 'src/infrastructure/minio/minio.module';

import { ExportJobModule } from '../export-job/export-job.module';

import { AuditLogController } from './controller/audit-log.controller';
import { MyAuditController } from './controller/my-audit.controller';

import { AuditLogService } from './service/audit-log.service';
import { AUDIT_ARCHIVE_STORAGE } from './service/audit-archive.storage';
import { MinioAuditArchiveStorage } from './service/minio-audit-archive.storage';

import { AuditLogListener } from './listeners/audit-log.listener';

@Module({
  imports: [PrismaModule, EventEmitterModule, MinioModule, ExportJobModule],

  // MyAuditController must stay FIRST: its 'me' routes have to be matched before AuditLogController's 'GET :id'.
  controllers: [MyAuditController, AuditLogController],

  providers: [
    AuditLogService,
    AuditLogListener,
    { provide: AUDIT_ARCHIVE_STORAGE, useClass: MinioAuditArchiveStorage },
  ],

  exports: [AuditLogService],
})
export class AuditLogModule {}
