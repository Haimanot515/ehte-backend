import { Module } from '@nestjs/common';
import { AppAccessController } from './controller/app-access.controller';
import { QrCodeController } from './controller/qr-code.controller';
import { QrCodeService } from './service/qr-code.service';

@Module({
  controllers: [AppAccessController, QrCodeController],
  providers: [QrCodeService],
})
export class AppAccessModule {}