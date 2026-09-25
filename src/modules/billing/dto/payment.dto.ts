// src/modules/billing/dto/payment.dto.ts
import { IsString, IsUUID, Matches, MaxLength } from 'class-validator';

const MONEY = /^\d+(\.\d{1,2})?$/;

export class AllocationPreviewQueryDto {
  @Matches(MONEY) amount!: string;
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
