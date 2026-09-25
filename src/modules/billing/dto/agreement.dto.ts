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
  MaxLength,
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
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => AllocationRuleDto)
  rules!: AllocationRuleDto[];

  // Section 14 / 27: refund/cancellation terms are part of the commercial
  // agreement, versioned with everything else — free text for now (policy
  // engine is out of scope here), stored verbatim on the agreement version.
  @IsOptional() @IsString() @MaxLength(4000) refundPolicy?: string;
  @IsOptional() @IsString() @MaxLength(4000) cancellationPolicy?: string;
}

export class AssignAgreementDto {
  @IsUUID() agreementId!: string;
}

export class CreateInstitutionDto {
  @IsString() name!: string;
}

export class RetireAgreementDto {
  @IsString() @MaxLength(500) reason!: string;
}
