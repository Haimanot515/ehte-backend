import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Min,
} from 'class-validator';
import {
  PaymentStatus,
  PaymentType,
  SettlementStatus,
  PartyType,
  DisbursementStatus,
} from '@prisma/client';

// ── shared pagination base ────────────────────────────────────────────

abstract class PaginationDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  limit?: number = 20;
}

// ── GET admin/billing/payments ───────────────────────────────────────

export class GetPaymentsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ enum: PaymentType })
  @IsOptional()
  @IsEnum(PaymentType)
  type?: PaymentType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  victimProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  missingPersonId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  payerUserId?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive lower bound on createdAt' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ description: 'ISO date, inclusive upper bound on createdAt' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

export enum ReviewDecision {
  APPROVE = 'APPROVE',
  REJECT = 'REJECT',
}

export class ResolveReviewDto {
  @ApiPropertyOptional({ enum: ReviewDecision })
  @IsIn(Object.values(ReviewDecision))
  decision: ReviewDecision;

  @ApiPropertyOptional()
  @IsString()
  reason: string;
}

// ── GET admin/billing/allocations (payout queue, G23) ──────────────────

export class GetAllocationsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: SettlementStatus })
  @IsOptional()
  @IsEnum(SettlementStatus)
  settlementStatus?: SettlementStatus;

  @ApiPropertyOptional({ enum: PartyType })
  @IsOptional()
  @IsEnum(PartyType)
  partyType?: PartyType;

  @ApiPropertyOptional({ description: 'When true, only allocations with no disbursement rows yet' })
  @IsOptional()
  @Type(() => Boolean)
  undisbursedOnly?: boolean;
}

// ── GET admin/billing/disbursements ─────────────────────────────────────

export class GetDisbursementsDto extends PaginationDto {
  @ApiPropertyOptional({ enum: DisbursementStatus })
  @IsOptional()
  @IsEnum(DisbursementStatus)
  status?: DisbursementStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  allocationId?: string;
}
