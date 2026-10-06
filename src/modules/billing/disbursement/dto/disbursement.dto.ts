// src/modules/billing/dto/disbursement.dto.ts
import { IsEnum, IsOptional, IsString, IsUUID } from 'class-validator';
import { DisbursementMethod } from '@prisma/client';

export class CreateDisbursementDto {
  @IsEnum(DisbursementMethod) method!: DisbursementMethod;

  @IsOptional() @IsUUID() rewardClaimId?: string;
}

export class ExecuteDisbursementDto {
  @IsOptional() @IsString() accountName?: string;
  @IsOptional() @IsString() accountNumber?: string;
  @IsOptional() @IsString() bankCode?: string;
  @IsOptional() @IsString() externalReference?: string;
}
