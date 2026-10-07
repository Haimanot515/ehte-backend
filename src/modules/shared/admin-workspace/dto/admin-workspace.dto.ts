import { SharedRecordType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PagedQueryDto } from '../../common/paged-query.dto';

// Record types an admin can claim or be assigned. Same list as notes, referrals and help-desk links.
export const WORKSPACE_MODULES = Object.values(SharedRecordType);

// What global search can look through. Users are staff-only and masked by role in the service.
export const SEARCH_ENTITIES = [...Object.values(SharedRecordType), 'USER'] as const;
export type SearchEntity = (typeof SEARCH_ENTITIES)[number];

export const SLA_STATES = ['NEAR', 'BREACHED', 'ALL'] as const;
export type SlaState = (typeof SLA_STATES)[number];

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// Accepts ?entities=REPORT,POST and ?entities=REPORT&entities=POST
const toList = ({ value }: { value: unknown }) => {
  if (value === undefined || value === null || value === '') return undefined;
  const raw = Array.isArray(value) ? value : String(value).split(',');
  return [...new Set(raw.map((v) => String(v).trim()).filter(Boolean))];
};

// SH-25
export class AdminGlobalSearchQueryDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q: string;

  // Limit the search to some record types. Empty means all of them.
  @IsOptional()
  @Transform(toList)
  @IsArray()
  @ArrayMaxSize(SEARCH_ENTITIES.length)
  @IsIn(SEARCH_ENTITIES as unknown as string[], { each: true })
  entities?: SearchEntity[];

  // Results are grouped by type, so the cap applies to each group
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(20)
  perTypeLimit?: number = 5;
}

// SH-26, SH-32
export class MyWorkQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(SharedRecordType)
  module?: SharedRecordType;

  // Oldest first is the default because that is what needs attention
  @IsOptional()
  @IsIn(['oldest', 'newest'])
  sort?: 'oldest' | 'newest' = 'oldest';
}

// SH-31
export class RecentQueryDto {
  @IsOptional()
  @IsEnum(SharedRecordType)
  entity?: SharedRecordType;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 20;
}

// SH-33
export class HandoverDto {
  @IsUUID()
  toAdminId: string;

  // Hand over only these modules. Empty means everything I hold.
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(WORKSPACE_MODULES.length)
  @IsEnum(SharedRecordType, { each: true })
  modules?: SharedRecordType[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

// SH-34
export class SlaQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(SharedRecordType)
  module?: SharedRecordType;

  // NEAR = past the warning share of the target but not yet over it. BREACHED = over the target.
  @IsOptional()
  @IsIn(SLA_STATES as unknown as string[])
  state?: SlaState = 'ALL';

  // Share of the response target at which an item counts as "near"
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(50)
  @Max(99)
  warnAtPercent?: number = 80;
}

// SH-35
export class ActivityFeedQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(SharedRecordType)
  entity?: SharedRecordType;

  @IsOptional()
  @IsUUID()
  actorId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}

// SH-36
export class WorkspaceStatsQueryDto {
  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(100)
  region?: string;
}
