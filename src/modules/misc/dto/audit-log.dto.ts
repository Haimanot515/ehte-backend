import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
  PartialType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsIP,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { ActorType, AuditOutcome, AuditSeverity, AuditSource } from '@prisma/client';

const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] as const;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

// ─────────────────────────────────────────────
// PAGING
// ─────────────────────────────────────────────

/**
 * Two paging modes:
 *  - cursor (preferred): pass `cursor` from the previous response's meta.nextCursor.
 *    Omit it to start from the newest row. No total is returned.
 *  - offset: pass `page`. Returns total and totalPages.
 * If both are sent, `cursor` wins.
 */
export class AuditPagingDto {
  @ApiPropertyOptional({ description: 'Cursor from the previous page (meta.nextCursor). Preferred.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  cursor?: string;

  @ApiPropertyOptional({ example: 1, description: 'Offset paging. Ignored when cursor is set.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  page?: number;

  @ApiPropertyOptional({ example: 20, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─────────────────────────────────────────────
// FILTERS (shared by list, security view, export, saved filters)
// ─────────────────────────────────────────────

export class AuditLogFiltersDto {
  @ApiPropertyOptional({ description: 'Free text over entityLabel, reason and actorName.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ example: 'REPORT_CREATED' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @ApiPropertyOptional({ example: 'Report' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity?: string;

  @ApiPropertyOptional({
    example: 'uuid',
    description: 'Filter to audit logs for one specific entity record.',
  })
  @IsOptional()
  @IsUUID()
  entityId?: string;

  @ApiPropertyOptional({ enum: ActorType })
  @IsOptional()
  @IsEnum(ActorType)
  actorType?: ActorType;

  @ApiPropertyOptional({ example: 'ADMIN' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  actorRole?: string;

  @ApiPropertyOptional({ example: 'uuid', description: 'User who performed the action.' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ example: 'uuid', description: 'User affected by the action.' })
  @IsOptional()
  @IsUUID()
  targetUserId?: string;

  @ApiPropertyOptional({ enum: AuditOutcome })
  @IsOptional()
  @IsEnum(AuditOutcome)
  outcome?: AuditOutcome;

  @ApiPropertyOptional({ enum: AuditSeverity })
  @IsOptional()
  @IsEnum(AuditSeverity)
  severity?: AuditSeverity;

  @ApiPropertyOptional({ enum: AuditSource })
  @IsOptional()
  @IsEnum(AuditSource)
  source?: AuditSource;

  @ApiPropertyOptional({ enum: HTTP_METHODS })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(HTTP_METHODS as unknown as string[])
  method?: string;

  @ApiPropertyOptional({ example: '/api/v1/reports', description: 'Substring match.' })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  path?: string;

  @ApiPropertyOptional({ example: 'ET' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string;

  @ApiPropertyOptional({ example: 'Addis Ababa' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  city?: string;

  @ApiPropertyOptional({ example: 'session id' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  sessionId?: string;

  @ApiPropertyOptional({ example: 'req_0b6f3c1e-...' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  requestId?: string;

  @ApiPropertyOptional({
    example: '203.0.113.7',
    description: 'SUPER_ADMIN only. ADMIN gets 403 (ADMIN cannot see IPs, so it cannot filter by them).',
  })
  @IsOptional()
  @IsIP()
  ipAddress?: string;

  @ApiPropertyOptional({
    example: '2026-08-01T00:00:00.000Z',
    description: 'Inclusive start of createdAt range.',
  })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({
    example: '2026-08-31T23:59:59.999Z',
    description: 'Inclusive end of createdAt range.',
  })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

/** List / security / export query: every filter plus paging (paging is ignored by export). */
export class GetAuditLogsDto extends IntersectionType(AuditLogFiltersDto, AuditPagingDto) {}

// ─────────────────────────────────────────────
// SCOPED VIEWS
// ─────────────────────────────────────────────

export class AuditUserScopeQueryDto extends AuditPagingDto {
  @ApiPropertyOptional({
    enum: ['actor', 'target', 'both'],
    default: 'actor',
    description: 'actor: things the user did. target: things done TO the user. both: either.',
  })
  @IsOptional()
  @IsIn(['actor', 'target', 'both'])
  as?: 'actor' | 'target' | 'both' = 'actor';
}

// ─────────────────────────────────────────────
// STATS
// ─────────────────────────────────────────────

export class TimelineQueryDto {
  @ApiPropertyOptional({ example: 30, default: 30, description: 'Number of days, including today (UTC).' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number = 30;
}

export class AuditStatsQueryDto {
  @ApiPropertyOptional({ example: 30, default: 30 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  days?: number = 30;

  @ApiPropertyOptional({ example: 10, default: 10 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  limit?: number = 10;
}

// ─────────────────────────────────────────────
// SAVED FILTERS
// ─────────────────────────────────────────────

export class CreateSavedFilterDto {
  @ApiProperty({ example: 'Denied logins this week' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name!: string;

  @ApiProperty({ type: () => AuditLogFiltersDto })
  @IsObject()
  @ValidateNested()
  @Type(() => AuditLogFiltersDto)
  filter!: AuditLogFiltersDto;
}

// ─────────────────────────────────────────────
// ALERT RULES
// ─────────────────────────────────────────────

export class CreateAuditAlertDto {
  @ApiProperty({ example: 'Repeated denials' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean = true;

  @ApiPropertyOptional({ example: 'LOGIN_FAILED', description: 'Match this action.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @ApiPropertyOptional({ example: 'User', description: 'Match this entity.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity?: string;

  @ApiPropertyOptional({ enum: AuditOutcome })
  @IsOptional()
  @IsEnum(AuditOutcome)
  outcome?: AuditOutcome;

  @ApiPropertyOptional({ enum: AuditSeverity })
  @IsOptional()
  @IsEnum(AuditSeverity)
  severity?: AuditSeverity;

  @ApiProperty({ example: 5, description: 'Fire when at least this many matching events occur.' })
  @IsInt()
  @Min(1)
  @Max(100_000)
  threshold!: number;

  @ApiProperty({ example: 10, description: 'Sliding window in minutes.' })
  @IsInt()
  @Min(1)
  @Max(10_080)
  windowMinutes!: number;

  @ApiPropertyOptional({ example: 60, default: 60, description: 'Minimum minutes between firings.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_080)
  cooldownMinutes?: number = 60;
}

export class UpdateAuditAlertDto extends PartialType(CreateAuditAlertDto) {}

// ─────────────────────────────────────────────
// INTEGRITY
// ─────────────────────────────────────────────

export class IntegrityVerifyQueryDto {
  @ApiPropertyOptional({ example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-08-31T23:59:59.999Z' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

// ─────────────────────────────────────────────
// RETENTION
// ─────────────────────────────────────────────

export class PurgePreviewQueryDto {
  @ApiProperty({ example: '2025-01-01T00:00:00.000Z', description: 'ISO date, must be in the past.' })
  @IsDateString()
  olderThan!: string;
}

export class PurgeAuditLogsDto extends PurgePreviewQueryDto {
  @ApiProperty({ example: 'Retention policy: 24 months (ticket #123)' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ description: 'Token returned by GET /audit-logs/purge/preview.' })
  @IsString()
  @MaxLength(1000)
  confirmToken!: string;
}