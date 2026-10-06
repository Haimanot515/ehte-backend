import { Module } from '@nestjs/common';

import { AllocationService } from './service/allocation.service';

@Module({
  providers: [AllocationService],
  exports: [AllocationService],
})
export class AllocationModule {}
