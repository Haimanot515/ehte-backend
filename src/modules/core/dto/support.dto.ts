import { IsEnum, IsNumber, IsOptional, IsString, IsUUID, Min, MaxLength } from 'class-validator';

import { SupportAgreementType, SupportType } from '@prisma/client';

export class CreateSupportDto {
  @IsUUID()
  victimProfileId: string;

  @IsOptional()
  @IsEnum(SupportType)
  type?: SupportType;

  @IsOptional()
  @IsEnum(SupportAgreementType)
  agreementType?: SupportAgreementType;

  @IsNumber()
  @Min(0.01)
  amount: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  recipientAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  organizationAmount?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  platformAmount?: number;

  // Off-platform proof of transfer (bank reference no., transaction id,
  // etc). Not verified programmatically — admin checks manually before
  // moving status to CONFIRMED.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  transferReference?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}
