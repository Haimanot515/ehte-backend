import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { Type } from 'class-transformer';

import { MissingPersonType, MissingPersonStatus } from '@prisma/client';

const MAX_MEDIA_ITEMS = 10;

// ─────────────────────────────────────────────
// CREATE MISSING PERSON DTO
// ─────────────────────────────────────────────

export class CreateMissingPersonDto {
  @IsEnum(MissingPersonType)
  personType: MissingPersonType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsString()
  @MaxLength(5000)
  description: string;

  @IsDateString()
  dateLastSeen: string;

  @IsString()
  @MaxLength(500)
  lastKnownArea: string;

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
// UPDATE MISSING PERSON DTO
// ─────────────────────────────────────────────

export class UpdateMissingPersonDto {
  @IsOptional()
  @IsEnum(MissingPersonType)
  personType?: MissingPersonType;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(5000)
  description?: string;

  @IsOptional()
  @IsDateString()
  dateLastSeen?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  lastKnownArea?: string;

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
// LIST QUERY DTOs (pagination)
// ─────────────────────────────────────────────

export class ListMissingPersonsQueryDto {
  @IsOptional()
  @IsEnum(MissingPersonType)
  type?: MissingPersonType;

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

export class ListMissingPersonsAdminQueryDto {
  @IsOptional()
  @IsEnum(MissingPersonStatus)
  status?: MissingPersonStatus;

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