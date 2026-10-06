import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { PrismaModule } from 'src/prisma/prisma.module';
import { MinioModule } from 'src/infrastructure/minio/minio.module';

import { ExportJobService } from './service/export-job.service';
import { EXPORT_OBJECT_STORAGE, MinioExportObjectStorage } from './service/export-object-storage';

@Module({
  imports: [PrismaModule, EventEmitterModule, MinioModule],
  providers: [
    ExportJobService,
    { provide: EXPORT_OBJECT_STORAGE, useClass: MinioExportObjectStorage },
  ],
  exports: [ExportJobService, EXPORT_OBJECT_STORAGE],
})
export class ExportJobModule {}
