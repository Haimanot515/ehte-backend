import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupportCategory, SupportStatus, SupportType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsOptional,
  IsInt,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class CreateSupportDto {
  @ApiProperty()
  @IsUUID()
  victimProfileId: string;

  @ApiProperty({ enum: SupportCategory, isArray: true })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(Object.values(SupportCategory).length)
  @IsEnum(SupportCategory, { each: true })
  categories: SupportCategory[];

  // Required when OTHER is ticked.
  @ApiPropertyOptional({ description: 'Short note. Required when OTHER is ticked.' })
  @ValidateIf(
    (o: CreateSupportDto) =>
      o.message !== undefined || o.categories?.includes(SupportCategory.OTHER),
  )
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message?: string;

  @ApiPropertyOptional({
    default: true,
    description: 'Hide my name from the victim and public lists.',
  })
  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;

  @ApiPropertyOptional({
    default: false,
    description: 'The team may share my contact with this person.',
  })
  @IsOptional()
  @IsBoolean()
  contactMayBeShared?: boolean;
}

// Completing a support needs a note for the audit trail.
export class CompleteSupportDto {
  @ApiProperty({ description: 'What was delivered or handled. Stored in the audit trail.' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  note: string;
}

export class CancelSupportDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;
}

// Admin queue of supports, so pending non-financial offers can be found and followed up.
export class ListSupportQueryDto {
  @ApiPropertyOptional({ enum: SupportStatus })
  @IsOptional()
  @IsEnum(SupportStatus)
  status?: SupportStatus;

  @ApiPropertyOptional({ enum: SupportType })
  @IsOptional()
  @IsEnum(SupportType)
  type?: SupportType;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// ── New DTOs for the /support endpoints (SP-01 .. SP-68) ──

export enum SupportDisputeReason {
  NOT_DELIVERED = 'NOT_DELIVERED',
  MISMATCH = 'MISMATCH',
  RECIPIENT_DENIES_RECEIPT = 'RECIPIENT_DENIES_RECEIPT',
  OTHER = 'OTHER',
}

export enum SupportDisputeStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

export enum SupportDisputeOutcome {
  DELIVERED = 'DELIVERED',
  NOT_DELIVERED = 'NOT_DELIVERED',
  CANCELLED = 'CANCELLED',
}

export enum SupportFlagReason {
  ASKS_FOR_CONTACT = 'ASKS_FOR_CONTACT',
  ASKS_FOR_PAYMENT = 'ASKS_FOR_PAYMENT',
  ASKS_FOR_MEETING = 'ASKS_FOR_MEETING',
  OTHER = 'OTHER',
}

export enum SupportStatsInterval {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

// Shared pagination for new list routes.
export class SupportPagedQueryDto {
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// Required reason for admin actions that must leave a justification.
export class SupportReasonDto {
  @ApiProperty({ description: 'Why, stored in the audit trail.' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

export class SupportOptionalReasonDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/* ── Supporter and recipient ── */

// PATCH /support/:id. Only while PENDING. The profile cannot be changed here.
export class UpdateSupportDto {
  @ApiPropertyOptional({ enum: SupportCategory, isArray: true })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @ArrayUnique()
  @ArrayMaxSize(Object.values(SupportCategory).length)
  @IsEnum(SupportCategory, { each: true })
  categories?: SupportCategory[];

  @ApiPropertyOptional({ description: 'Short note. Required when OTHER is ticked.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  message?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  anonymous?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  contactMayBeShared?: boolean;
}

// POST /support/:id/proof. Files arrive through @MediaUpload; the arrays hold their keys.
export class UploadSupportProofDto {
  @ApiPropertyOptional({ description: 'What this proof shows' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];
}

// POST /support/:id/dispute (supporter) and POST /support/:id/dispute-receipt (recipient).
// The service checks which reasons each side may use.
export class CreateSupportDisputeDto {
  @ApiProperty({ enum: SupportDisputeReason })
  @IsEnum(SupportDisputeReason)
  reason: SupportDisputeReason;

  @ApiProperty({ description: 'What happened' })
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  details: string;
}

export class CreateSupportMessageDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body: string;
}

export class DeclineIncomingSupportDto {
  @ApiProperty({ description: 'Why the offer does not fit' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

export class SendThanksDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  message?: string;
}

/* ── Admin read state and bulk ── */

export class ListUnreadSupportQueryDto extends ListSupportQueryDto {}

export class ReadAllSupportDto {
  @ApiPropertyOptional({ enum: SupportStatus })
  @IsOptional()
  @IsEnum(SupportStatus)
  status?: SupportStatus;

  @ApiPropertyOptional({ enum: SupportType })
  @IsOptional()
  @IsEnum(SupportType)
  type?: SupportType;
}

export class BulkSupportIdsDto {
  @ApiProperty({ type: [String], description: 'Up to 100 support ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids: string[];
}

export class BulkSupportReasonDto {
  @ApiProperty({ type: [String], description: 'Up to 100 support ids' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  ids: string[];

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

export class BulkExpireSupportDto {
  @ApiPropertyOptional({
    default: 14,
    description: 'Expire PENDING offers older than this many days',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  olderThanDays?: number = 14;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/* ── Disputes, restrictions, flags ── */

export class ListSupportDisputesQueryDto extends SupportPagedQueryDto {
  @ApiPropertyOptional({ enum: SupportDisputeStatus })
  @IsOptional()
  @IsEnum(SupportDisputeStatus)
  status?: SupportDisputeStatus;

  @ApiPropertyOptional({ enum: SupportDisputeOutcome })
  @IsOptional()
  @IsEnum(SupportDisputeOutcome)
  outcome?: SupportDisputeOutcome;
}

export class ResolveSupportDisputeDto {
  @ApiProperty({ enum: SupportDisputeOutcome })
  @IsEnum(SupportDisputeOutcome)
  outcome: SupportDisputeOutcome;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

export class RestrictSupporterDto {
  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;

  @ApiPropertyOptional({ description: 'When the restriction ends. Omit for open-ended.' })
  @IsOptional()
  @IsDateString()
  endsAt?: string;
}

export class FlagSupportDto {
  @ApiProperty({ enum: SupportFlagReason })
  @IsEnum(SupportFlagReason)
  reason: SupportFlagReason;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string;
}

export class ListSupportFlagsQueryDto extends SupportPagedQueryDto {
  @ApiPropertyOptional({ enum: SupportFlagReason })
  @IsOptional()
  @IsEnum(SupportFlagReason)
  reason?: SupportFlagReason;
}

/* ── Case management ── */

export class AssignSupportReviewerDto {
  @ApiProperty()
  @IsString()
  reviewerId: string;
}

export class ReassignSupportProfileDto {
  @ApiProperty({ description: 'The victim profile that will receive the offer instead' })
  @IsUUID()
  victimProfileId: string;

  @ApiProperty()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

/* ── Search, export, statistics ── */

// Shared filters for every stats route: from, to, status, type, victimProfileId, supporterId.
export class SupportStatsQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: SupportStatus })
  @IsOptional()
  @IsEnum(SupportStatus)
  status?: SupportStatus;

  @ApiPropertyOptional({ enum: SupportType })
  @IsOptional()
  @IsEnum(SupportType)
  type?: SupportType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  victimProfileId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  supporterId?: string;
}

export class SupportStatsTimelineQueryDto extends SupportStatsQueryDto {
  @ApiPropertyOptional({ enum: SupportStatsInterval, default: SupportStatsInterval.DAY })
  @IsOptional()
  @IsEnum(SupportStatsInterval)
  interval?: SupportStatsInterval = SupportStatsInterval.DAY;
}

export class SupportSearchQueryDto extends SupportStatsQueryDto {
  @ApiProperty({ description: 'Reference, supporter or profile' })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

// GET /support/export query and POST /support/export-jobs body.
export class SupportExportQueryDto extends SupportStatsQueryDto {}
