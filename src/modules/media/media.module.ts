import { Module } from '@nestjs/common';

import { ClamavModule } from '../../infrastructure/clamav/clamav.module';
import { MediaController } from './controller/media.controller';
import { MediaService } from './service/media.service';
import { MediaScanWorker } from './service/media-scan.worker';

@Module({
  imports: [ClamavModule],
  controllers: [MediaController],
  providers: [MediaService, MediaScanWorker],
})
export class MediaModule {}
