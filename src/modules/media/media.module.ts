import { Module } from '@nestjs/common';

import { MediaController } from './controller/media.controller';
import { MediaService } from './service/media.service';

@Module({
  controllers: [MediaController],
  providers: [MediaService],
})
export class MediaModule {}
