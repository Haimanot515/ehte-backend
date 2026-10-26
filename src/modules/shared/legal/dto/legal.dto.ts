import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { LegalDocumentStatus } from '@prisma/client';
import { PagedQueryDto } from '../../common/paged-query.dto';

export const LEGAL_CHANNELS = ['APP', 'WEB', 'USSD'];
export const LEGAL_TYPE_PATTERN = /^[A-Z][A-Z0-9_]{1,39}$/;
export const LEGAL_LANGUAGE_PATTERN = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const upper = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value);
const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

export class LegalDocumentQueryDto {
  // Wins over the Accept-Language header
  @IsOptional()
  @Matches(LEGAL_LANGUAGE_PATTERN)
  lang?: string;
}

export class AcceptLegalDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  documentIds: string[];

  @IsOptional()
  @IsIn(LEGAL_CHANNELS)
  channel?: string;
}

export class CreateLegalDocumentDto {
  @Transform(upper)
  @Matches(LEGAL_TYPE_PATTERN, { message: 'type must be upper case letters, digits and underscores, like TERMS' })
  type: string;

  @Matches(LEGAL_LANGUAGE_PATTERN)
  language: string;

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  version: string;

  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title: string;

  @IsString()
  @MinLength(20)
  @MaxLength(200_000)
  body: string;

  @IsDateString()
  effectiveAt: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  requiresReacceptance?: boolean;

  // Keeps the version as a DRAFT so it can still be edited
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  saveAsDraft?: boolean;
}

export class UpdateLegalDraftDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  version?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title?: string;

  @IsOptional()
  @IsString()
  @MinLength(20)
  @MaxLength(200_000)
  body?: string;

  @IsOptional()
  @IsDateString()
  effectiveAt?: string;

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  requiresReacceptance?: boolean;

  // Publishes the draft after applying the other changes
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  publish?: boolean;
}

export class LegalDocumentsListQueryDto extends PagedQueryDto {
  @IsOptional()
  @Transform(upper)
  @Matches(LEGAL_TYPE_PATTERN)
  type?: string;

  @IsOptional()
  @Matches(LEGAL_LANGUAGE_PATTERN)
  language?: string;

  @IsOptional()
  @IsEnum(LegalDocumentStatus)
  status?: LegalDocumentStatus;
}

export class LegalAcceptancesQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsUUID()
  userId?: string;

  @IsOptional()
  @IsUUID()
  documentId?: string;

  @IsOptional()
  @Transform(upper)
  @Matches(LEGAL_TYPE_PATTERN)
  type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(20)
  version?: string;

  @IsOptional()
  @IsIn(LEGAL_CHANNELS)
  channel?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  // csv returns the matching rows (up to 10,000) as CSV text inside the response
  @IsOptional()
  @IsIn(['json', 'csv'])
  format?: 'json' | 'csv';
}
