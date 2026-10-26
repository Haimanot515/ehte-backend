import { AbuseReportOutcome } from '@prisma/client';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PagedQueryDto } from '../../common/paged-query.dto';

export const ABUSE_REPORT_STATUSES = ['OPEN', 'RESOLVED'];

export class BlockedListQueryDto extends PagedQueryDto {}

export class CreateAbuseReportDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  reason: string;

  @IsOptional()
  @IsString()
  @MaxLength(4000)
  details?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(500, { each: true })
  evidenceKeys?: string[];
}

export class AbuseReportsQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsIn(ABUSE_REPORT_STATUSES)
  status?: string;

  @IsOptional()
  @IsEnum(AbuseReportOutcome)
  outcome?: AbuseReportOutcome;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class AbuseStatsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

export class ResolveAbuseReportDto {
  @IsEnum(AbuseReportOutcome)
  outcome: AbuseReportOutcome;

  @IsString()
  @MinLength(3)
  @MaxLength(2000)
  reason: string;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  warningMessage?: string;
}
