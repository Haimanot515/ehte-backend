// src/modules/billing/dto/disbursement.dto.ts
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { DisbursementMethod } from '@prisma/client';

export class CreateDisbursementDto {
  @IsEnum(DisbursementMethod) method!: DisbursementMethod;

  // Required only when the target allocation's partyType is REWARD_BENEFICIARY
  // and the reward pool is being split across more than one informant
  // (section 12) — identifies which informant's approved RewardClaim this
  // disbursement pays out.
  @IsOptional() @IsUUID() rewardClaimId?: string;
}

export class ExecuteDisbursementDto {
  @IsOptional() @IsString() accountName?: string;
  @IsOptional() @IsString() accountNumber?: string;
  @IsOptional() @IsString() bankCode?: string;
  @IsOptional() @IsString() externalReference?: string;
}
