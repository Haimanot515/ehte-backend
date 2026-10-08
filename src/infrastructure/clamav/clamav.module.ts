import { Global, Module } from '@nestjs/common';

import { ClamavService } from './clamav.service';
import { MediaScanService } from './media-scan.service';

@Global()
@Module({
  providers: [ClamavService, MediaScanService],
  exports: [ClamavService, MediaScanService],
})
export class ClamavModule {}
