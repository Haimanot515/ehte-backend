import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';

import { SupportType, VictimProfileStatus } from '@prisma/client';

export enum AccountHolderRelationship {
  SELF = 'SELF',
  PARENT = 'PARENT',
  GUARDIAN = 'GUARDIAN',
  OTHER = 'OTHER',
}

export class CreateVictimProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  description?: string;

  @IsString()
  @MinLength(10)
  story: string;

  @IsEnum(SupportType)
  supportType: SupportType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  supportGoal?: number;

  // Off-platform transfer destination. Optional here; enforced at the gate stage.
  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankAccountName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bankAccountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  bankCode?: string;

  @ValidateIf((o) => !!o.bankAccountNumber)
  @IsString()
  @MaxLength(200)
  accountHolderName?: string;

  @IsOptional()
  @IsEnum(AccountHolderRelationship)
  accountHolderRelationship?: AccountHolderRelationship;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  @IsOptional()
  @IsBoolean()
  involvesChild?: boolean;
}

export class UpdateVictimProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  story?: string;

  @IsOptional()
  @IsEnum(SupportType)
  supportType?: SupportType;

  @IsOptional()
  @IsNumber()
  @Min(0)
  supportGoal?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankAccountName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(64)
  bankAccountNumber?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  bankName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  bankCode?: string;

  @ValidateIf((o) => !!o.bankAccountNumber)
  @IsString()
  @MaxLength(200)
  accountHolderName?: string;

  @IsOptional()
  @IsEnum(AccountHolderRelationship)
  accountHolderRelationship?: AccountHolderRelationship;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  @IsOptional()
  @IsBoolean()
  involvesChild?: boolean;
}

export class UpdateVictimGateDto {
  @IsOptional()
  @IsBoolean()
  isVerified?: boolean;

  @IsOptional()
  @IsBoolean()
  isSafetyReviewed?: boolean;

  @IsOptional()
  @IsBoolean()
  hasConsent?: boolean;

  @IsOptional()
  @IsBoolean()
  isPrivacyReviewed?: boolean;

  @IsOptional()
  @IsBoolean()
  isAdminApproved?: boolean;
}

// §32 — dedicated child-safety gate, kept as its own DTO so it always leaves its own audit trail.
export class UpdateChildSafetyReviewDto {
  @IsBoolean()
  isChildSafetyReviewed: boolean;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNotes?: string;
}

export class RevokeConsentDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class UpdateBankDetailsDto {
  @IsString()
  @MaxLength(200)
  bankAccountName: string;

  @IsString()
  @MaxLength(64)
  bankAccountNumber: string;

  @IsString()
  @MaxLength(200)
  bankName: string;

  @IsString()
  @MaxLength(20)
  bankCode: string;

  @IsString()
  @MaxLength(200)
  accountHolderName: string;

  @IsEnum(AccountHolderRelationship)
  accountHolderRelationship: AccountHolderRelationship;
}

export class FindAllVictimProfilesQueryDto {
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsEnum(VictimProfileStatus)
  status?: VictimProfileStatus;
}

// Public listing filters — pagination only, implicitly PUBLISHED-only.
export class FindPublicVictimProfilesQueryDto {
  @IsOptional()
  @Type(() => Number)
  page?: number = 1;

  @IsOptional()
  @Type(() => Number)
  limit?: number = 20;

  @IsOptional()
  @IsEnum(SupportType)
  supportType?: SupportType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;
}

// ── New DTOs for the /victim-profiles endpoints (VP-01 .. VP-102) ──

const toBool = ({ value }: { value: unknown }) =>
  value === 'true' || value === true ? true : value === 'false' || value === false ? false : value;

/* ------------------------------------------------------------------ */
/* Enums                                                               */
/* ------------------------------------------------------------------ */

export enum FlagReason {
  FALSE_INFORMATION = 'FALSE_INFORMATION',
  ABUSIVE = 'ABUSIVE',
  IDENTIFIES_CHILD = 'IDENTIFIES_CHILD',
  OTHER = 'OTHER',
}

export enum FlagStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
  DISMISSED = 'DISMISSED',
}

export enum FlagResolution {
  DISMISS = 'DISMISS',
  UNPUBLISH = 'UNPUBLISH',
  PAUSE_DONATIONS = 'PAUSE_DONATIONS',
}

export enum AppealStatus {
  OPEN = 'OPEN',
  UPHELD = 'UPHELD',
  OVERTURNED = 'OVERTURNED',
}

export enum AppealDecision {
  UPHOLD_REJECTION = 'UPHOLD_REJECTION',
  OVERTURN_REJECTION = 'OVERTURN_REJECTION',
}

export enum RedactionMode {
  BLUR_FACES = 'BLUR_FACES',
  HIDE_DETAILS = 'HIDE_DETAILS',
}

export enum StatsInterval {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

/* ------------------------------------------------------------------ */
/* Shared query / body building blocks                                 */
/* ------------------------------------------------------------------ */

export class PagedQueryDto {
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

export class ReasonDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

export class OptionalReasonDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class BulkIdsDto {
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids: string[];
}

export class BulkReasonDto extends BulkIdsDto {
  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Creator + supporter                                                 */
/* ------------------------------------------------------------------ */

export class CreateProfileUpdateDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(5000)
  body: string;
}

export class CreateAppealDto {
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  message: string;
}

export class FlagVictimProfileDto {
  @IsEnum(FlagReason)
  reason: FlagReason;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  details?: string;
}

export class PublicSearchQueryDto extends PagedQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q: string;
}

/* ------------------------------------------------------------------ */
/* Admin read state                                                    */
/* ------------------------------------------------------------------ */

export class FindUnreadVictimProfilesQueryDto extends FindAllVictimProfilesQueryDto {}

export class ReadAllDto {
  @IsOptional()
  @IsEnum(VictimProfileStatus)
  status?: VictimProfileStatus;
}

/* ------------------------------------------------------------------ */
/* Flags, takedowns, appeals                                           */
/* ------------------------------------------------------------------ */

export class FindFlagsQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(FlagStatus)
  status?: FlagStatus;

  @IsOptional()
  @IsEnum(FlagReason)
  reason?: FlagReason;

  @IsOptional()
  @IsString()
  profileId?: string;
}

export class ResolveFlagDto {
  @IsEnum(FlagResolution)
  resolution: FlagResolution;

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

export class TakedownDto extends ReasonDto {}

export class LiftTakedownDto extends ReasonDto {}

export class FindAppealsQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(AppealStatus)
  status?: AppealStatus;
}

export class DecideAppealDto {
  @IsEnum(AppealDecision)
  decision: AppealDecision;

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Case management                                                     */
/* ------------------------------------------------------------------ */

export class AssignReviewerDto {
  @IsString()
  reviewerId: string;
}

export class BulkAssignDto extends BulkIdsDto {
  @IsString()
  reviewerId: string;
}

export class RequestChangesDto {
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  message: string;
}

export class BulkRequestChangesDto extends BulkIdsDto {
  @IsString()
  @MinLength(10)
  @MaxLength(5000)
  message: string;
}

export class CompleteProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  note?: string;
}

export class RecordConsentDto {
  @IsString()
  @MaxLength(200)
  consentedBy: string;

  @IsOptional()
  @IsDateString()
  consentedAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  // Signed consent form arrives through @MediaUpload as `document`.
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];
}

export class AdminEditVictimProfileDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(10)
  story?: string;

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

export class UpdateChildFlagDto {
  @IsBoolean()
  involvesChild: boolean;

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

/* ------------------------------------------------------------------ */
/* Money controls                                                      */
/* ------------------------------------------------------------------ */

export class UpdateGoalDto {
  @IsNumber()
  @Min(0)
  supportGoal: number;

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

export class VerifyBankDetailsDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

/* ------------------------------------------------------------------ */
/* Media, retention                                                    */
/* ------------------------------------------------------------------ */

export class RemoveMediaDto extends OptionalReasonDto {}

export class RedactMediaDto {
  @IsEnum(RedactionMode)
  mode: RedactionMode;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class LegalHoldDto {
  @IsBoolean()
  legalHold: boolean;

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;
}

export class AnonymizeDto extends ReasonDto {}

/* ------------------------------------------------------------------ */
/* Search, export, statistics                                          */
/* ------------------------------------------------------------------ */

export class DateRangeQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

// Shared filters for every stats route: from, to, status, category,
// creatorId, involvesChild, assignedTo.
export class StatsQueryDto extends DateRangeQueryDto {
  @IsOptional()
  @IsEnum(VictimProfileStatus)
  status?: VictimProfileStatus;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  category?: string;

  @IsOptional()
  @IsString()
  creatorId?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  involvesChild?: boolean;

  @IsOptional()
  @IsString()
  assignedTo?: string;
}

export class StatsTimelineQueryDto extends StatsQueryDto {
  @IsOptional()
  @IsEnum(StatsInterval)
  interval?: StatsInterval = StatsInterval.DAY;
}

export class AdminSearchQueryDto extends StatsQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q: string;

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

// Used as the query for GET admin/export and the body for POST admin/export-jobs.
export class ExportQueryDto extends StatsQueryDto {}
