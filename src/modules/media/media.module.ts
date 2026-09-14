import { Module } from '@nestjs/common';

import { MediaController } from './controller/media.controller';
import { MediaService } from './service/media.service';

// No MinioModule import needed here — confirmed @Global(), so
// MinioService is already resolvable app-wide without importing
// its module into every consumer.

@Module({
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
