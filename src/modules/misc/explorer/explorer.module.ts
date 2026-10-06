import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { PrismaModule } from 'src/prisma/prisma.module';

import { ExplorerController } from './controller/explorer.controller';
import { ExplorerService } from './service/explorer.service';

@Module({
  imports: [PrismaModule, EventEmitterModule],
  controllers: [ExplorerController],
  providers: [ExplorerService],
})
export class ExplorerModule {}
