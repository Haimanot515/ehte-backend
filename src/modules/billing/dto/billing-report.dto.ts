// src/modules/billing/dto/billing-report.dto.ts
//
// Query/body DTOs for BillingReportController (section 3 admin reports).
// Shapes are derived directly from how the controller and
// FundingQueryService consume `query`/`dto` — adjust the Prisma enum
// imports below if your generated enum names differ.

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

// ── POST admin/billing/payments/:id/resolve-review (G9) ────────────────
//
// PaymentService.resolveReview(adminId, id, dto) still needs to be
// written (see the controller's file-level note). This is the contract
// it should accept: an admin either clears a REVIEW_REQUIRED payment to
// proceed as PAID, or rejects it — either way a reason is required for
// the audit trail. Adjust the `decision` values/fields if payment.service.ts's
// actual G9 handling expects something different once you paste it.

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