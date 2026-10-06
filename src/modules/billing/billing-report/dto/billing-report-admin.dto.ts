import {
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsUUID,
} from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  DisbursementStatus,
  PartyType,
  PaymentStatus,
  PaymentType,
  SettlementStatus,
} from '@prisma/client';
import { PagingDto, DateRangeDto } from 'src/modules/billing/shared/dto/billing-common.dto';

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
  @ApiPropertyOptional({
    example: '2026-10-03',
    description: 'Day to close (UTC). Defaults to today.',
  })
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
