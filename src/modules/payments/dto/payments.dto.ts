import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { DisbursementStatus, PaymentStatus } from '@prisma/client';

// Money arrives as a string so it never passes through a JS float. Max 2 decimals.
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

export class CreateDonationDto {
  @IsUUID()
  victimProfileId: string;

  @Matches(MONEY, { message: 'amount_invalid' })
  amount: string;

  // Hides the donor's name on the public page. The donor is still logged in and recorded.
  @IsOptional()
  @IsBoolean()
  isAnonymous?: boolean;
}

export class PagedDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class PaymentListQueryDto extends PagedDto {
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @IsOptional()
  @IsUUID()
  victimProfileId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class DisbursementListQueryDto extends PagedDto {
  @IsOptional()
  @IsEnum(DisbursementStatus)
  status?: DisbursementStatus;

  @IsOptional()
  @IsUUID()
  victimProfileId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

// victimProfileId omitted = totals for everyone.
export class TotalsQueryDto {
  @IsOptional()
  @IsUUID()
  victimProfileId?: string;
}

export class PauseReasonDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

export class ResolveReviewDto {
  @IsIn(['ACCEPT', 'REFUND'])
  decision: 'ACCEPT' | 'REFUND';

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

// Body Chapa posts to our approval URL (see Chapa "Server approval").
export class TransferApprovalDto {
  @IsString()
  amount: string;

  @IsString()
  reference: string;

  @IsOptional()
  @IsString()
  bank?: string;

  @IsString()
  account_name: string;

  @IsString()
  account_number: string;
}