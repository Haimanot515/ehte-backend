import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, TransformFnParams, Type } from 'class-transformer';

import { InformationStatus } from '@prisma/client';

const MAX_MEDIA_ITEMS = 10;

const toBoolean = ({ value }: TransformFnParams) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

export enum InformationPriority {
  LOW = 'LOW',
  NORMAL = 'NORMAL',
  HIGH = 'HIGH',
  URGENT = 'URGENT',
}

export enum InformationCredibility {
  UNVERIFIED = 'UNVERIFIED',
  LOW = 'LOW',
  MEDIUM = 'MEDIUM',
  HIGH = 'HIGH',
}

export enum InformationRedactionMode {
  BLUR_FACES = 'BLUR_FACES',
  BLUR_REGION = 'BLUR_REGION',
}

export enum InformationStatsInterval {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

// ─────────────────────────────────────────────
// CREATE
// ─────────────────────────────────────────────

export class CreateInformationSubmissionDto {
  @IsString()
  @MinLength(5)
  @MaxLength(3000)
  information: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  // FIX: these are MinIO filepaths returned by POST /media/upload-url
  // (same convention as CreatePostDto), not public URLs — @IsUrl was
  // rejecting every legitimate filepath. Switched to @IsString, same
  // as Post/Report/VictimProfile.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  audio?: string[];

  // NOTE: same as PostDto — MEDIA_ALLOWED_MIME_TYPES must include
  // application/pdf for this field to be usable.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  other?: string[];
}

// ─────────────────────────────────────────────
// UPDATE
// Same field set as CREATE, all optional. Only usable while
// PENDING (enforced in the service).
// ─────────────────────────────────────────────

export class UpdateInformationSubmissionDto {
  @IsOptional()
  @IsString()
  @MinLength(5)
  @MaxLength(3000)
  information?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  location?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  audio?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  other?: string[];
}

// ─────────────────────────────────────────────
// ADMIN — MOVE TO UNDER_REVIEW (admin/:id/status)
// The only status this endpoint may set is UNDER_REVIEW — the
// terminal REVIEWED/REJECTED decision goes through review()
// instead, which requires a reviewNote on REJECTED.
// ─────────────────────────────────────────────

export class UpdateInformationSubmissionStatusDto {
  @IsEnum(InformationStatus)
  status: InformationStatus;
}

// ─────────────────────────────────────────────
// ADMIN — REVIEW (admin/:id/review)
// reviewNote is required by the service when status is REJECTED
// (conditional on the value of `status`, so validated there).
// ─────────────────────────────────────────────

export class ReviewInformationSubmissionDto {
  @IsEnum(InformationStatus)
  status: InformationStatus;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;
}

// ─────────────────────────────────────────────
// LIST QUERY (pagination)
// ─────────────────────────────────────────────

export class ListInformationSubmissionsQueryDto {
  @IsOptional()
  @IsEnum(InformationStatus)
  status?: InformationStatus;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isRead?: boolean;

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

export class InformationPaginationQueryDto {
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

export class RespondToInformationQuestionDto {
  @IsOptional()
  @IsString()
  questionId?: string;

  @IsString()
  @MinLength(1)
  @MaxLength(3000)
  answer: string;
}

export class AddInformationEvidenceDto {
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  audio?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsString({ each: true })
  other?: string[];
}

export class AppealInformationRejectionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class BulkInformationSubmissionIdsDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids: string[];
}

export class BulkAssignInformationSubmissionDto extends BulkInformationSubmissionIdsDto {
  @IsString()
  adminId: string;
}

export class BulkReviewInformationSubmissionDto extends BulkInformationSubmissionIdsDto {
  @IsEnum(InformationStatus)
  status: InformationStatus;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reviewNote: string;
}

export class BulkRejectInformationSubmissionDto extends BulkInformationSubmissionIdsDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reviewNote: string;
}

export class MarkAllInformationReadDto {
  @IsOptional()
  @IsEnum(InformationStatus)
  status?: InformationStatus;

  @IsOptional()
  @IsString()
  missingPersonId?: string;
}

export class RequestInformationDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  question: string;
}

export class AssignInformationSubmissionDto {
  @IsString()
  adminId: string;
}

export class MarkInformationDuplicateDto {
  @IsString()
  duplicateOfId: string;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class MarkInformationAlreadyKnownDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class EscalateInformationDto {
  @IsEnum(InformationPriority)
  priority: InformationPriority;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  note: string;
}

export class SetInformationPriorityDto {
  @IsEnum(InformationPriority)
  priority: InformationPriority;
}

export class SetInformationCredibilityDto {
  @IsEnum(InformationCredibility)
  credibility: InformationCredibility;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class MessageInformantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;
}

export class DeleteInformationSubmissionAdminDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class RestoreInformationSubmissionDto {
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class RedactInformationMediaDto {
  @IsEnum(InformationRedactionMode)
  mode: InformationRedactionMode;

  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class RevealInformantDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;

  @IsOptional()
  @IsString()
  credential?: string;
}

export class InformationLegalHoldDto {
  @IsBoolean()
  legalHold: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class AnonymizeInformationSubmissionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;

  @IsOptional()
  @IsString()
  credential?: string;
}

export class AdminSearchInformationSubmissionsQueryDto extends InformationPaginationQueryDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q: string;

  @IsOptional()
  @IsEnum(InformationStatus)
  status?: InformationStatus;
}

export class AdminInformationExportDto {
  @IsOptional()
  @IsEnum(InformationStatus)
  status?: InformationStatus;

  @IsOptional()
  @IsString()
  missingPersonId?: string;

  @IsOptional()
  @IsString()
  assignedTo?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class InformationStatsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @IsEnum(InformationStatus)
  status?: InformationStatus;

  @IsOptional()
  @IsString()
  missingPersonId?: string;

  @IsOptional()
  @IsString()
  assignedTo?: string;
}

export class InformationStatsTimelineQueryDto extends InformationStatsQueryDto {
  @IsOptional()
  @IsEnum(InformationStatsInterval)
  interval?: InformationStatsInterval = InformationStatsInterval.DAY;
}