import { OmitType, PartialType } from '@nestjs/swagger';
import { ContentKind, ContentStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PagedQueryDto } from '../../common/paged-query.dto';

export const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const CONTENT_TITLE_MAX = 200;
export const CONTENT_BODY_MAX = 20_000;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

// SH-68, SH-69, SH-70. ?lang= wins, otherwise the service uses the user's saved language.
export class ContentListQueryDto {
  @IsOptional()
  @Transform(trim)
  @Matches(LANGUAGE_PATTERN)
  lang?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  category?: string;
}

// SH-71
export class ContentSearchQueryDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q: string;

  @IsOptional()
  @Transform(trim)
  @Matches(LANGUAGE_PATTERN)
  lang?: string;

  @IsOptional()
  @IsEnum(ContentKind)
  kind?: ContentKind;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

// SH-72
export class AdminContentQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(ContentKind)
  kind?: ContentKind;

  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;

  @IsOptional()
  @Transform(trim)
  @Matches(LANGUAGE_PATTERN)
  language?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  category?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  q?: string;

  // Soft-deleted entries are hidden unless asked for
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  includeDeleted?: boolean;
}

// SH-73
export class CreateContentDto {
  @IsEnum(ContentKind)
  kind: ContentKind;

  // Stable across languages: the same slug in another language is a translation of the same entry
  @Transform(trim)
  @Matches(SLUG_PATTERN, { message: 'slug must be lower-case words joined by hyphens' })
  @MaxLength(120)
  slug: string;

  @Transform(trim)
  @Matches(LANGUAGE_PATTERN)
  language: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CONTENT_TITLE_MAX)
  title: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(CONTENT_BODY_MAX)
  body: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(64)
  category?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_000)
  sortOrder?: number;

  // New entries start as drafts unless the admin publishes straight away
  @IsOptional()
  @IsEnum(ContentStatus)
  status?: ContentStatus;
}

// SH-74. kind, slug and language identify the entry, so they cannot be edited.
export class UpdateContentDto extends PartialType(
  OmitType(CreateContentDto, ['kind', 'slug', 'language'] as const),
) {}
