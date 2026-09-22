// src/modules/billing/dto/payment.dto.ts
import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const MONEY = /^\d+(\.\d{1,2})?$/;

export class AllocationPreviewQueryDto {
  @Matches(MONEY) amount!: string;
}

export class ReasonDto {
  @IsString() @MaxLength(500) reason!: string;
}

export class ApproveClaimDto {
  @IsUUID() submissionId!: string;
}
