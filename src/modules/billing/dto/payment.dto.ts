// src/modules/billing/dto/payment.dto.ts
import { PaymentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

const MONEY = /^\d+(\.\d{1,2})?$/;

export class AllocationPreviewQueryDto {
  @Matches(MONEY) amount!: string;
}

// Body of POST /payments/victim-profile/:victimProfileId/support-checkout.
// The app sends only the amount and the anonymous choice; the server works out the split.
export class SupportCheckoutDto {
  @Matches(MONEY) amount!: string;

  // Defaults to anonymous when omitted. The supporter opts in to showing their name.
  @IsOptional() @IsBoolean() anonymous?: boolean;
}

// Query of GET /payments/mine.
export class MyPaymentsQueryDto {
  @IsOptional() @IsEnum(PaymentStatus) status?: PaymentStatus;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) limit?: number;
}

export class ReasonDto {
  @IsString() @MaxLength(500) reason!: string;
}

// Superseded by dto/reward-claim.dto.ts's CreateClaimFromSubmissionDto +
// scoring/decision/split flow (section 11-12 / 16 / 20) — kept only in case
// something else in the codebase still imports it; no controller uses it anymore.
export class ApproveClaimDto {
  @IsUUID() submissionId!: string;
}
