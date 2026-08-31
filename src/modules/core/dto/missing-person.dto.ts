import {
  IsArray,
  IsDateString,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

import { MissingPersonType } from '@prisma/client';

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
}