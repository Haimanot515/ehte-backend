import {
  ArrayMaxSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { Type } from 'class-transformer';

import { InformationStatus } from '@prisma/client';

const MAX_MEDIA_ITEMS = 10;

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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  audio?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  other?: string[];
}

// ─────────────────────────────────────────────
// UPDATE
// Same field set as CREATE, all optional. Only usable while
// PENDING (enforced in the service) — once an admin has moved a
// submission to UNDER_REVIEW, the submitter can no longer edit it
// underneath them.
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
  @IsUrl({}, { each: true })
  photo?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  video?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  audio?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  pdf?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  document?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_MEDIA_ITEMS)
  @IsUrl({}, { each: true })
  other?: string[];
}

// ─────────────────────────────────────────────
// ADMIN — MOVE TO UNDER_REVIEW (admin/:id/status)
// The only status this endpoint may set is UNDER_REVIEW — the
// terminal REVIEWED/REJECTED decision goes through review()
// instead, which requires a reviewNote on REJECTED. Kept as
// IsEnum(InformationStatus) rather than a literal so a clear
// validation error is returned for anything else, instead of
// silently rejecting at the service layer with no field context.
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