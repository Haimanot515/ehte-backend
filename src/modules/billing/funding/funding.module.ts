import { Module } from '@nestjs/common';

import { ChapaModule } from 'src/infrastructure/chapa/chapa.module';

import { FundingQueryService } from './service/funding-query.service';

@Module({
  imports: [ChapaModule],
  providers: [FundingQueryService],
  exports: [FundingQueryService],
})
export class FundingModule {}
