// src/modules/billing/dto/reward-claim.dto.ts
//
// DTOs for the PRD-aligned reward flow: funding method selection (section 7),
// admin-selected evaluation weights (section 11), per-claim scoring and decision
// (section 11 / 16 / 20), and reward splitting among approved informants
// (section 12). Replaces the single-claim ApproveClaimDto/ReasonDto pair in
// payment.dto.ts for anything beyond the simple one-informant case, though those
// two DTOs still work for a case that only ever has one claim.

import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { RewardFundingMethod } from '@prisma/client';

export class SetFundingMethodDto {
  @IsEnum(RewardFundingMethod) fundingMethod!: RewardFundingMethod;
}

// Section 11: "Admin selects the weights for the case" — whole percentages,
// validated in RewardService to sum to exactly 100.
export class SetEvaluationWeightsDto {
  @IsInt() @Min(0) @Max(100) timeWeight!: number;
  @IsInt() @Min(0) @Max(100) evidenceWeight!: number;
  @IsInt() @Min(0) @Max(100) credibilityWeight!: number;
}

export class CreateClaimFromSubmissionDto {
  @IsUUID() informationSubmissionId!: string;
}

export class ScoreClaimDto {
  @IsInt() @Min(0) @Max(100) timeScore!: number;
  @IsInt() @Min(0) @Max(100) evidenceScore!: number;
  @IsInt() @Min(0) @Max(100) credibilityScore!: number;
}

// Section 20: duplicate/competing-claim outcomes. APPROVED_FOR_REWARD is NOT a
// decision here — that only happens via splitReward() once every claim on the
// case has already been decided VALID, so a claim can't be split into a reward
// before its eligibility is settled.
export enum ClaimDecision {
  VALID = 'VALID',
  INVALID = 'INVALID',
  DUPLICATE = 'DUPLICATE',
  ALREADY_KNOWN = 'ALREADY_KNOWN',
  INELIGIBLE = 'INELIGIBLE',
}

export class DecideClaimDto {
  @IsEnum(ClaimDecision) decision!: ClaimDecision;
  @IsString() @MaxLength(1000) reason!: string;
  @IsOptional() @IsUUID() duplicateOfClaimId?: string;
}

export class RewardSplitLineDto {
  @IsUUID() claimId!: string;
  // Percentage of the informant pool (not of the gross reward), e.g. 50.00.
  @IsInt() @Min(1) @Max(100) percentage!: number;
}

export class SplitRewardDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => RewardSplitLineDto)
  splits!: RewardSplitLineDto[];
}

export class CloseCaseReasonDto {
  @IsString() @MaxLength(500) reason!: string;
}
