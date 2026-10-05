// src/modules/billing/dto/billing-admin.dto.ts
//
// DTOs for the new billing endpoints (BL-xx). Money amounts are strings with at
// most two decimals, same convention as dto/payment.dto.ts.
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
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
  ValidateNested,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  DisbursementStatus,
  InstitutionStatus,
  PartyType,
  PaymentDisputeStatus,
  PaymentStatus,
  PaymentType,
  PayoutRail,
  RewardClaimAppealStatus,
  RewardClaimStatus,
  SettlementStatus,
} from '@prisma/client';

const MONEY = /^\d+(\.\d{1,2})?$/;

export abstract class PagingDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// Date range used by reports, ledger and statistics.
export class DateRangeDto {
  @ApiPropertyOptional({ description: 'ISO date, inclusive. Defaults to 30 days ago.' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive. Defaults to now.' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ReasonBodyDto {
  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

// ── Payer ────────────────────────────────────────────────────────────

export class OpenPaymentDisputeDto {
  @ApiProperty({ minLength: 5, maxLength: 1000, example: 'I was charged twice for the same support.' })
  @IsString()
  @MinLength(5)
  @MaxLength(1000)
  reason!: string;
}

export class AnnualStatementQueryDto {
  @ApiPropertyOptional({ example: 2026, description: 'Calendar year. Defaults to the current year.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(2024)
  @Max(2100)
  year?: number;
}

export class CreateRewardAppealDto {
  @ApiProperty({ minLength: 10, maxLength: 2000 })
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  message!: string;
}

// ── Payments admin ───────────────────────────────────────────────────

export class WebhookEventsQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: ['RECEIVED', 'RECONCILED', 'IGNORED', 'ERROR'] })
  @IsOptional()
  @IsIn(['RECEIVED', 'RECONCILED', 'IGNORED', 'ERROR'])
  result?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  txRef?: string;
}

export class PaymentSearchQueryDto extends PagingDto {
  @ApiProperty({ minLength: 3, maxLength: 100, description: 'txRef, chapa reference, payment id, payer id or profile id.' })
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  q!: string;
}

export class ReviewQueueQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: PaymentType })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;
}

export class PaymentDisputesQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: PaymentDisputeStatus, default: PaymentDisputeStatus.OPEN })
  @IsOptional()
  @IsEnum(PaymentDisputeStatus)
  status?: PaymentDisputeStatus;
}

export class ResolvePaymentDisputeDto {
  @ApiProperty({ enum: ['UPHELD', 'DISMISSED'] })
  @IsIn(['UPHELD', 'DISMISSED'])
  outcome!: 'UPHELD' | 'DISMISSED';

  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

// ── Refunds ──────────────────────────────────────────────────────────

export class RequestRefundDto {
  @ApiPropertyOptional({ example: '50.00', description: 'Omit for a full refund.' })
  @IsOptional()
  @Matches(MONEY)
  amount?: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class RefundListQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: ['REQUESTED', 'REJECTED', 'REFUNDED', 'FAILED'], default: 'REQUESTED' })
  @IsOptional()
  @IsIn(['REQUESTED', 'REJECTED', 'REFUNDED', 'FAILED'])
  status?: string;

  @ApiPropertyOptional({ enum: PaymentType })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;
}

export class ExecuteRefundDto {
  @ApiProperty({ minLength: 3, maxLength: 200, description: 'Bank slip or transfer reference of the manual refund.' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reference!: string;
}

export class BulkRefundItemDto {
  @ApiProperty()
  @IsUUID()
  paymentId!: string;

  @ApiProperty({ minLength: 3, maxLength: 200 })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reference!: string;
}

export class BulkExecuteRefundsDto {
  @ApiProperty({ type: [BulkRefundItemDto], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkRefundItemDto)
  items!: BulkRefundItemDto[];
}

// ── Institutions, agreements, payout destinations ────────────────────

export class InstitutionsQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: InstitutionStatus })
  @IsOptional()
  @IsEnum(InstitutionStatus)
  status?: InstitutionStatus;

  @ApiPropertyOptional({ description: 'Name contains.' })
  @IsOptional()
  @IsString()
  q?: string;
}

export class UpdateInstitutionDto {
  @ApiProperty({ minLength: 2, maxLength: 200 })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name!: string;
}

export class StatementQueryDto extends DateRangeDto {}

export class ExpiringAgreementsQueryDto {
  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 365, description: 'Days ahead to look.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number = 30;
}

export class UpdateDraftAgreementDto {
  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Date)
  effectiveFrom?: Date;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @Type(() => Date)
  effectiveTo?: Date;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  refundPolicy?: string;

  @ApiPropertyOptional({ maxLength: 4000 })
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  cancellationPolicy?: string;
}

export class PayoutDestinationsQueryDto extends PagingDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional({ description: 'Only verified (true) or unverified (false).' })
  @IsOptional()
  @Type(() => String)
  @IsIn(['true', 'false'])
  verified?: 'true' | 'false';
}

export class CreatePayoutDestinationDto {
  @ApiProperty({ enum: PayoutRail })
  @IsEnum(PayoutRail)
  rail!: PayoutRail;

  @ApiPropertyOptional({ description: 'Required for BANK.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;

  @ApiPropertyOptional({ description: 'Required for BANK.' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  accountNumber?: string;

  @ApiPropertyOptional({ description: 'Required for TELEBIRR.' })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telebirrPhone?: string;

  @ApiProperty()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  accountHolder!: string;
}

export class UpdatePayoutDestinationDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  bankName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(50)
  accountNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(20)
  telebirrPhone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  accountHolder?: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

// ── Disbursements ────────────────────────────────────────────────────

export class FailedDisbursementsQueryDto extends PagingDto {
  @ApiPropertyOptional({ description: 'ISO date, only failures on or after this date.' })
  @IsOptional()
  @IsDateString()
  from?: string;
}

export class MarkDisbursementPaidDto {
  @ApiProperty({ minLength: 3, maxLength: 200, description: 'Bank slip or transfer reference proving the money left.' })
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  externalReference!: string;

  @ApiProperty({ minLength: 3, maxLength: 500 })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class BulkDisbursementIdsDto {
  @ApiProperty({ type: [String], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsUUID('all', { each: true })
  ids!: string[];
}

export class BulkExecuteItemDto {
  @ApiProperty()
  @IsUUID()
  id!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  accountName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  accountNumber?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  bankCode?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  externalReference?: string;
}

export class BulkExecuteDisbursementsDto {
  @ApiProperty({ type: [BulkExecuteItemDto], maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => BulkExecuteItemDto)
  items!: BulkExecuteItemDto[];
}

// ── Reward claims ────────────────────────────────────────────────────

export class RewardClaimsQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: RewardClaimStatus })
  @IsOptional()
  @IsEnum(RewardClaimStatus)
  status?: RewardClaimStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  missingPersonId?: string;
}

export class RewardAppealsQueryDto extends PagingDto {
  @ApiPropertyOptional({ enum: RewardClaimAppealStatus, default: RewardClaimAppealStatus.OPEN })
  @IsOptional()
  @IsEnum(RewardClaimAppealStatus)
  status?: RewardClaimAppealStatus;
}

export class DecideRewardAppealDto {
  @ApiProperty({ enum: ['UPHOLD', 'DECLINE'], description: 'UPHOLD reopens the claim for review.' })
  @IsIn(['UPHOLD', 'DECLINE'])
  decision!: 'UPHOLD' | 'DECLINE';

  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note!: string;
}

export class RewardOffersQueryDto extends PagingDto {
  @ApiPropertyOptional({ description: 'Only offers approved (true) or not yet approved (false).' })
  @IsOptional()
  @IsIn(['true', 'false'])
  approved?: 'true' | 'false';
}

// ── Ledger, reports, statistics ──────────────────────────────────────

export class LedgerQueryDto extends PagingDto {
  @ApiPropertyOptional() @IsOptional() @IsDateString() from?: string;
  @ApiPropertyOptional() @IsOptional() @IsDateString() to?: string;

  @ApiPropertyOptional({ enum: ['PAYMENT_IN', 'REFUND_OUT', 'PAYOUT_OUT'] })
  @IsOptional()
  @IsIn(['PAYMENT_IN', 'REFUND_OUT', 'PAYOUT_OUT'])
  kind?: 'PAYMENT_IN' | 'REFUND_OUT' | 'PAYOUT_OUT';

  @ApiPropertyOptional({ enum: PaymentType })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;
}

export class DailyCloseQueryDto {
  @ApiPropertyOptional({ example: '2026-10-03', description: 'Day to close (UTC). Defaults to today.' })
  @IsOptional()
  @IsDateString()
  date?: string;
}

export class BillingExportQueryDto extends DateRangeDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ enum: PaymentType })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;

  @ApiPropertyOptional({ enum: DisbursementStatus })
  @IsOptional()
  @IsEnum(DisbursementStatus)
  disbursementStatus?: DisbursementStatus;
}

export class BillingStatsQueryDto extends DateRangeDto {
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], default: 'day' })
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  granularity?: 'day' | 'week' | 'month' = 'day';

  @ApiPropertyOptional({ enum: PaymentType })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;

  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  institutionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  profileId?: string;
}

export class LiabilitiesQueryDto {
  @ApiPropertyOptional({ enum: SettlementStatus })
  @IsOptional()
  @IsEnum(SettlementStatus)
  settlementStatus?: SettlementStatus;

  @ApiPropertyOptional({ enum: PartyType })
  @IsOptional()
  @IsEnum(PartyType)
  partyType?: PartyType;
}
