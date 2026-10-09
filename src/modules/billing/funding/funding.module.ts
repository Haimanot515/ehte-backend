import { Module } from '@nestjs/common';

import { ChapaModule } from 'src/infrastructure/chapa/chapa.module';

import { FundingController } from './controller/funding.controller';
import { FundingQueryService } from './service/funding-query.service';

@Module({
  imports: [ChapaModule],
  controllers: [FundingController],
  providers: [FundingQueryService],
  exports: [FundingQueryService],
})
export class FundingModule {}
