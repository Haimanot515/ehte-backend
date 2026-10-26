import { PartialType } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { AnnouncementSeverity } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Matches,
  Max,
  MaxLength,
  Min,
  Validate,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { PagedQueryDto } from '../../common/paged-query.dto';

export const LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
export const ANNOUNCEMENT_STATUSES = ['SCHEDULED', 'ACTIVE', 'ENDED'];

export interface AnnouncementTranslation {
  title: string;
  body: string;
}

function isTranslation(value: unknown): value is AnnouncementTranslation {
  if (!value || typeof value !== 'object') return false;
  const { title, body } = value as Record<string, unknown>;
  return (
    typeof title === 'string' &&
    title.trim().length > 0 &&
    title.length <= 200 &&
    typeof body === 'string' &&
    body.trim().length > 0 &&
    body.length <= 2000
  );
}

@ValidatorConstraint({ name: 'translationsMap', async: false })
class TranslationsMapConstraint implements ValidatorConstraintInterface {
  validate(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 20) return false;
    return entries.every(([lang, t]) => LANGUAGE_PATTERN.test(lang) && isTranslation(t));
  }

  defaultMessage() {
    return 'translations must map language codes to a title (max 200) and a body (max 2000)';
  }
}

export class CreateAnnouncementDto {
  @Validate(TranslationsMapConstraint)
  translations: Record<string, AnnouncementTranslation>;

  @IsOptional()
  @IsEnum(AnnouncementSeverity)
  severity?: AnnouncementSeverity;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  audienceRoles?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  regions?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @Matches(LANGUAGE_PATTERN, { each: true })
  languages?: string[];

  @IsOptional()
  @IsUrl({ protocols: ['https'], require_protocol: true })
  @MaxLength(2000)
  linkUrl?: string;

  @IsOptional()
  @IsDateString()
  startsAt?: string;

  @IsOptional()
  @IsDateString()
  endsAt?: string;
}

export class UpdateAnnouncementDto extends PartialType(CreateAnnouncementDto) {}

export class AdminAnnouncementsQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsIn(ANNOUNCEMENT_STATUSES)
  status?: string;

  @IsOptional()
  @IsEnum(AnnouncementSeverity)
  severity?: AnnouncementSeverity;
}

export class MyAnnouncementsQueryDto {
  @IsOptional()
  @Matches(LANGUAGE_PATTERN)
  language?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

export class PreviewAnnouncementDto {
  @IsOptional()
  @IsString()
  @MaxLength(64)
  role?: string;

  @IsOptional()
  @Matches(LANGUAGE_PATTERN)
  language?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  region?: string;
}
