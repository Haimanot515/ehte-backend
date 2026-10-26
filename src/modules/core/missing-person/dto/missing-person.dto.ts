import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
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
  MaxLength,
  Max,
  Min,
  MinLength,
} from 'class-validator';
import { Transform, TransformFnParams, Type } from 'class-transformer';

import { MissingPersonType, MissingPersonStatus } from '@prisma/client';

const toBoolean = ({ value }: TransformFnParams) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

export enum MissingPersonFlagReason {
  FALSE_LISTING = 'FALSE_LISTING',
  ABUSIVE = 'ABUSIVE',
  IDENTIFIES_CHILD = 'IDENTIFIES_CHILD',
  OTHER = 'OTHER',
}

export enum MissingPersonFlagStatus {
  OPEN = 'OPEN',
  RESOLVED = 'RESOLVED',
}

export enum MissingPersonFlagAction {
  DISMISS = 'DISMISS',
  HIDE_CASE = 'HIDE_CASE',
  WARN_OWNER = 'WARN_OWNER',
}

export enum MissingPersonAppealStatus {
  PENDING = 'PENDING',
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
}

export enum MissingPersonAppealDecision {
  ACCEPTED = 'ACCEPTED',
  DECLINED = 'DECLINED',
}

export enum MissingPersonRedactionMode {
  BLUR_FACES = 'BLUR_FACES',
  BLUR_REGION = 'BLUR_REGION',
}

export enum MissingPersonStatsInterval {
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

export class CreateMissingPersonDto {
  @ApiProperty({ enum: MissingPersonType })
  @IsEnum(MissingPersonType)
  personType: MissingPersonType;

  @ApiPropertyOptional({ example: 'Metania Shiferaw' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiProperty({
    example: 'Metania was last seen wearing a blue jacket and black trousers...',
  })
  @IsString()
  @MaxLength(5000)
  description: string;

  @ApiProperty({ example: '2026-09-10T00:00:00.000Z' })
  @IsDateString()
  dateLastSeen: string;

  @ApiProperty({ example: 'Bole, Addis Ababa' })
  @IsString()
  @MaxLength(500)
  lastKnownArea: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['photo/550e8400-e29b-41d4-a716-446655440000.jpg'],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}

// Admin create: same as a user submission, minus the re-auth credential.
export class AdminCreateMissingPersonDto extends OmitType(CreateMissingPersonDto, [
  'credential',
] as const) {}

export class UpdateMissingPersonDto {
  @ApiPropertyOptional({ enum: MissingPersonType })
  @IsOptional()
  @IsEnum(MissingPersonType)
  personType?: MissingPersonType;

  @ApiPropertyOptional({ example: 'Metania Shiferaw' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ example: 'Updated description with more detail.' })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: '2026-09-10T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  dateLastSeen?: string;

  @ApiPropertyOptional({ example: 'Bole, Addis Ababa' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  lastKnownArea?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  video?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  audio?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  pdf?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  document?: string[];

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  other?: string[];

  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}

// reviewNote is required by the service for REJECTED and MORE_INFORMATION_REQUESTED.
export class UpdateMissingPersonStatusDto {
  @ApiProperty({ enum: MissingPersonStatus })
  @IsEnum(MissingPersonStatus)
  status: MissingPersonStatus;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;

  @ApiPropertyOptional({
    description:
      'Required (true) when approving a case where personType is CHILD. Ignored otherwise.',
  })
  @IsOptional()
  @IsBoolean()
  childSafetyConfirmed?: boolean;
}

export class ListMissingPersonsQueryDto {
  @ApiPropertyOptional({ enum: MissingPersonType })
  @IsOptional()
  @IsEnum(MissingPersonType)
  type?: MissingPersonType;

  @ApiPropertyOptional({ default: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class ListMissingPersonsAdminQueryDto {
  @ApiPropertyOptional({ enum: MissingPersonStatus })
  @IsOptional()
  @IsEnum(MissingPersonStatus)
  status?: MissingPersonStatus;

  @ApiPropertyOptional({
    description: 'Filter by whether the current admin has read the case.',
  })
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  isRead?: boolean;

  @ApiPropertyOptional({ default: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class PaginationQueryDto {
  @ApiPropertyOptional({ default: 1, example: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20, example: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

export class RecentMissingPersonsQueryDto {
  @ApiPropertyOptional({ default: 10, example: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;
}

export class SearchMissingPersonsQueryDto extends PaginationQueryDto {
  @ApiProperty({ example: 'Metania', description: 'Name, area or description text.' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  q: string;
}

export class AdminSearchMissingPersonsQueryDto extends SearchMissingPersonsQueryDto {
  @ApiPropertyOptional({ enum: MissingPersonStatus })
  @IsOptional()
  @IsEnum(MissingPersonStatus)
  status?: MissingPersonStatus;
}

export class MissingPersonFoundReportDto {
  @ApiProperty({
    description: 'What the family knows: where and how the person was found, and their condition.',
    maxLength: 2000,
  })
  @IsString()
  @MaxLength(2000)
  details: string;

  @ApiPropertyOptional({ example: '2026-10-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  dateFound?: string;

  @ApiPropertyOptional({ example: 'Piassa, Addis Ababa' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  foundLocation?: string;

  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}

export class RenewMissingPersonDto {
  @ApiPropertyOptional({
    description: 'Days to extend the listing by. Omit to use the platform default.',
    example: 30,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(180)
  extendDays?: number;
}

export class AdminRenewMissingPersonDto extends RenewMissingPersonDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class CreateMissingPersonUpdateDto {
  @ApiProperty({
    example: 'Now believed to be wearing a green coat.',
    maxLength: 2000,
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'MinIO object keys returned by POST /media/presigned-upload',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  photo?: string[];
}

export class AppealMissingPersonRejectionDto {
  @ApiProperty({ description: 'Why the rejection should be reconsidered.', maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;

  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}

export class FlagMissingPersonDto {
  @ApiProperty({ enum: MissingPersonFlagReason })
  @IsEnum(MissingPersonFlagReason)
  reason: MissingPersonFlagReason;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  details?: string;
}

export class ListMissingPersonFlagsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MissingPersonFlagStatus })
  @IsOptional()
  @IsEnum(MissingPersonFlagStatus)
  status?: MissingPersonFlagStatus;

  @ApiPropertyOptional({ enum: MissingPersonFlagReason })
  @IsOptional()
  @IsEnum(MissingPersonFlagReason)
  reason?: MissingPersonFlagReason;
}

export class ResolveMissingPersonFlagDto {
  @ApiProperty({ enum: MissingPersonFlagAction })
  @IsEnum(MissingPersonFlagAction)
  action: MissingPersonFlagAction;

  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class TakedownMissingPersonDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class LiftTakedownMissingPersonDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class ListMissingPersonAppealsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: MissingPersonAppealStatus })
  @IsOptional()
  @IsEnum(MissingPersonAppealStatus)
  status?: MissingPersonAppealStatus;
}

export class DecideMissingPersonAppealDto {
  @ApiProperty({ enum: MissingPersonAppealDecision })
  @IsEnum(MissingPersonAppealDecision)
  decision: MissingPersonAppealDecision;

  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class AssignMissingPersonDto {
  @ApiProperty({ description: 'Id of the admin to assign as reviewer.' })
  @IsString()
  adminId: string;
}

export class BulkMissingPersonIdsDto {
  @ApiProperty({ type: [String], description: 'Case ids, up to 100 per request.' })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @IsString({ each: true })
  ids: string[];
}

export class BulkAssignMissingPersonDto extends BulkMissingPersonIdsDto {
  @ApiProperty({ description: 'Id of the admin to assign as reviewer.' })
  @IsString()
  adminId: string;
}

export class BulkRejectMissingPersonDto extends BulkMissingPersonIdsDto {
  @ApiProperty({ maxLength: 2000, description: 'One review note applied to every case.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reviewNote: string;
}

export class BulkExpireMissingPersonDto extends BulkMissingPersonIdsDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class MarkAllMissingPersonsReadDto {
  @ApiPropertyOptional({ enum: MissingPersonStatus })
  @IsOptional()
  @IsEnum(MissingPersonStatus)
  status?: MissingPersonStatus;

  @ApiPropertyOptional({ enum: MissingPersonType })
  @IsOptional()
  @IsEnum(MissingPersonType)
  personType?: MissingPersonType;

  @ApiPropertyOptional({ example: 'Bole, Addis Ababa' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  area?: string;
}

export class VerifyFoundMissingPersonDto {
  @ApiProperty({ description: 'true confirms the person is found; false declines the report.' })
  @IsBoolean()
  confirmed: boolean;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;
}

export class ReopenMissingPersonDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class MergeMissingPersonDto {
  @ApiProperty({ description: 'Id of the duplicate case to merge into this one.' })
  @IsString()
  duplicateId: string;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class AdminEditMissingPersonDto {
  @ApiPropertyOptional({ example: 'Metania Shiferaw' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @ApiPropertyOptional({ example: '2026-09-10T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  dateLastSeen?: string;

  @ApiPropertyOptional({ example: 'Bole, Addis Ababa' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  lastKnownArea?: string;

  @ApiProperty({ description: 'Why the text was edited. Kept in the revision history.', maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class MessageMissingPersonOwnerDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  message: string;
}

export class CorrectMissingPersonChildFlagDto {
  @ApiProperty({ description: 'Whether the case involves a child.' })
  @IsBoolean()
  involvesChild: boolean;

  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class DeleteMissingPersonAdminDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class RestoreMissingPersonDto {
  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class RedactMissingPersonMediaDto {
  @ApiProperty({ enum: MissingPersonRedactionMode })
  @IsEnum(MissingPersonRedactionMode)
  mode: MissingPersonRedactionMode;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reason?: string;
}

export class MissingPersonLegalHoldDto {
  @ApiProperty({ description: 'true places the hold; false releases it.' })
  @IsBoolean()
  legalHold: boolean;

  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  reason: string;
}

export class AdminMissingPersonExportDto {
  @ApiPropertyOptional({ enum: MissingPersonStatus })
  @IsOptional()
  @IsEnum(MissingPersonStatus)
  status?: MissingPersonStatus;

  @ApiPropertyOptional({ enum: MissingPersonType })
  @IsOptional()
  @IsEnum(MissingPersonType)
  personType?: MissingPersonType;

  @ApiPropertyOptional({ example: 'Bole, Addis Ababa' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  area?: string;

  @ApiPropertyOptional({ description: 'Admin id the case is assigned to.' })
  @IsOptional()
  @IsString()
  assignedTo?: string;

  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

export class MissingPersonStatsQueryDto {
  @ApiPropertyOptional({ example: '2026-01-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-12-31T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ enum: MissingPersonStatus })
  @IsOptional()
  @IsEnum(MissingPersonStatus)
  status?: MissingPersonStatus;

  @ApiPropertyOptional({ example: 'Bole, Addis Ababa' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  area?: string;

  @ApiPropertyOptional({ example: 'FEMALE' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  gender?: string;

  @ApiPropertyOptional({ example: '18-30' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  ageGroup?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  involvesChild?: boolean;

  @ApiPropertyOptional({ description: 'Admin id the case is assigned to.' })
  @IsOptional()
  @IsString()
  assignedTo?: string;
}

export class MissingPersonStatsTimelineQueryDto extends MissingPersonStatsQueryDto {
  @ApiPropertyOptional({ enum: MissingPersonStatsInterval, default: MissingPersonStatsInterval.DAY })
  @IsOptional()
  @IsEnum(MissingPersonStatsInterval)
  interval?: MissingPersonStatsInterval = MissingPersonStatsInterval.DAY;
}