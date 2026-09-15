import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Max,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

import { MissingPersonType, MissingPersonStatus } from '@prisma/client';

// ─────────────────────────────────────────────
// FIX: media fields now take bare MinIO object keys (e.g.
// "photo/<uuid>.jpg"), validated with @IsArray() @IsString({ each:
// true }) — same as CreateReportDto/UpdateReportDto and every
// other media-bearing DTO in the codebase (Post, VictimProfile).
//
// Previously these were validated with @IsUrl({}, { each: true }),
// requiring a full https://... URL — the only media-bearing DTO
// that did this. That mismatch is what caused every submission to
// fail with media_files_not_found: MinioService.objectExists()/
// statObject() expect a bare key scoped to the single configured
// bucket, not a full URL (which, for path-style S3/MinIO URLs,
// embeds the bucket name as a path segment MinIO was never asked
// to skip). Aligning the validator with every other module removes
// the need for any URL-unwrapping logic in the service layer —
// the console's uploader already returns a bare `filepath`/`key`
// from POST /media/presigned-upload, so no client-side change is
// needed once this field just accepts that value directly.
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// CREATE MISSING PERSON DTO
// ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────
  // RE-AUTHENTICATION
  //
  // Verified and stripped by ReauthGuard before this DTO's data
  // reaches MissingPersonService.create() — never persisted or
  // returned. Optional here since it can instead be supplied via
  // the X-Reauth-Credential header; the guard accepts either.
  // Mirrors CreateReportDto's credential field.
  // ─────────────────────────────────────────
  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}

// ─────────────────────────────────────────────
// UPDATE MISSING PERSON DTO
// ─────────────────────────────────────────────

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

  // Mirrors CreateMissingPersonDto's credential field — update()
  // is also gated behind ReauthGuard per the controller's TODO.
  @ApiPropertyOptional({
    description:
      'Account password (or Discreet Mode passcode, if enabled) confirming this sensitive action. Optional here if provided instead via the X-Reauth-Credential header.',
    example: 'StrongPassword123',
  })
  @IsOptional()
  @IsString()
  credential?: string;
}

// ─────────────────────────────────────────────
// ADMIN — UPDATE STATUS DTO
// reviewNote is required by the service layer when status is
// REJECTED or MORE_INFORMATION_REQUESTED (validated in the
// service, not here, since the requirement is conditional on
// the value of `status`).
// ─────────────────────────────────────────────

export class UpdateMissingPersonStatusDto {
  @ApiProperty({ enum: MissingPersonStatus })
  @IsEnum(MissingPersonStatus)
  status: MissingPersonStatus;

  @ApiPropertyOptional({ maxLength: 2000 })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  reviewNote?: string;
}

// ─────────────────────────────────────────────
// LIST QUERY DTOs (pagination)
// ─────────────────────────────────────────────

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