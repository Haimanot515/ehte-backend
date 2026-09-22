// src/modules/billing/dto/agreement.dto.ts
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { PartyType, PaymentType, RuleMode, SupportAgreementType } from '@prisma/client';

export class AllocationRuleDto {
  @IsEnum(PaymentType) paymentType!: PaymentType;
  @IsEnum(PartyType) partyType!: PartyType; // RECIPIENT is rejected: it is always the remainder
  @IsOptional() @IsUUID() institutionId?: string;
  @IsEnum(RuleMode) mode!: RuleMode;
  @IsOptional() @IsInt() @Min(1) @Max(9999) valueBps?: number;
  @IsOptional() @Matches(/^\d+(\.\d{1,2})?$/) flatAmount?: string;
}

export class CreateAgreementDto {
  @IsEnum(SupportAgreementType) type!: SupportAgreementType;
  @IsOptional() @IsUUID() institutionId?: string;
  @Type(() => Date) @IsDate() effectiveFrom!: Date;
  @IsOptional() @Type(() => Date) @IsDate() effectiveTo?: Date;
  @IsArray() @ArrayMaxSize(10) @ValidateNested({ each: true }) @Type(() => AllocationRuleDto)
  rules!: AllocationRuleDto[];
}

export class AssignAgreementDto {
  @IsUUID() agreementId!: string;
}

export class CreateInstitutionDto {
  @IsString() name!: string;
}