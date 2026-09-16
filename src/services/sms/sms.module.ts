import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { SendetService } from './sendet.service';

@Module({
  imports: [ConfigModule],
  providers: [SendetService],
  exports: [SendetService],
})
export class SmsModule {}