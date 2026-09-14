import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AfroMessageService } from './afro-message.service';

@Module({
  imports: [ConfigModule],
  providers: [AfroMessageService],
  exports: [AfroMessageService],
})
export class SmsModule {}
