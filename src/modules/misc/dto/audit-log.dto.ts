import {
  ApiProperty,
  ApiPropertyOptional,
  IntersectionType,
  OmitType,
  PartialType,
  PickType,
} from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
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

/**
 * Two paging modes:
 *  - cursor (preferred): pass `cursor` from the previous response's meta.nextCursor.
 *    Omit it to start from the newest row. No total is returned.
 *  - offset: pass `page`. Returns total and totalPages.
 * If both are sent, `cursor` wins.
 */
export class AuditPagingDto {
  @ApiPropertyOptional({
    description: 'Cursor from the previous page (meta.nextCursor). Preferred.',
  })
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
  @IsIn(HTTP_METHODS)
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
    description:
      'SUPER_ADMIN only. ADMIN gets 403 (ADMIN cannot see IPs, so it cannot filter by them).',
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

export class TimelineQueryDto {
  @ApiPropertyOptional({
    example: 30,
    default: 30,
    description: 'Number of days, including today (UTC).',
  })
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

export class CreateAuditAlertDto {
  @ApiProperty({ example: 'Repeated denials' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

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

  @ApiPropertyOptional({
    example: 60,
    description: 'Minimum minutes between firings.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_080)
  cooldownMinutes?: number;
}

export class UpdateAuditAlertDto extends PartialType(CreateAuditAlertDto) {}

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

export class PurgePreviewQueryDto {
  @ApiProperty({
    example: '2025-01-01T00:00:00.000Z',
    description: 'ISO date, must be in the past.',
  })
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

const boolFromQuery = ({ value }: { value: unknown }) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

/** AL-01. legalHold true sets a hold on one row, false clears it (clearing needs a second Super Admin). */
export class SetRowLegalHoldDto {
  @ApiProperty({ description: 'true = place a hold, false = clear it.' })
  @IsBoolean()
  legalHold!: boolean;

  @ApiProperty({ example: 'Subpoena 2026/114: preserve this entry.' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({ example: 'CASE-2026-114', description: 'Used when placing a hold.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  caseReference?: string;
}

/** What a hold covers. At least one of entity, entityId, userId, targetUserId, action or a date range is required. */
export class LegalHoldFilterDto extends PickType(AuditLogFiltersDto, [
  'entity',
  'entityId',
  'userId',
  'targetUserId',
  'action',
  'sessionId',
  'requestId',
  'startDate',
  'endDate',
] as const) {}

/** AL-02 */
export class CreateLegalHoldDto {
  @ApiProperty({ example: 'CASE-2026-114' })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(100)
  caseReference!: string;

  @ApiProperty({ example: 'Court order: preserve everything about report 8f2c...' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;

  @ApiProperty({ type: () => LegalHoldFilterDto })
  @IsObject()
  @ValidateNested()
  @Type(() => LegalHoldFilterDto)
  filter!: LegalHoldFilterDto;
}

/** AL-06 */
export class PreviewLegalHoldDto {
  @ApiProperty({ type: () => LegalHoldFilterDto })
  @IsObject()
  @ValidateNested()
  @Type(() => LegalHoldFilterDto)
  filter!: LegalHoldFilterDto;
}

/** AL-05 */
export class ReleaseLegalHoldDto {
  @ApiProperty({ example: 'Case closed on 2026-10-01 (ticket #88).' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

/** AL-03 */
export class LegalHoldsQueryDto extends AuditPagingDto {
  @ApiPropertyOptional({ enum: ['ACTIVE', 'RELEASED'] })
  @IsOptional()
  @IsIn(['ACTIVE', 'RELEASED'])
  status?: 'ACTIVE' | 'RELEASED';

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100)
  caseReference?: string;
}

export class PurgeRunsQueryDto extends AuditPagingDto {
  @ApiPropertyOptional({ enum: ['STARTED', 'ARCHIVED', 'COMPLETED', 'FAILED'] })
  @IsOptional()
  @IsIn(['STARTED', 'ARCHIVED', 'COMPLETED', 'FAILED'])
  status?: 'STARTED' | 'ARCHIVED' | 'COMPLETED' | 'FAILED';
}

/** AL-11. The purge runs on its own at runAt, which gives other admins time to object. */
export class SchedulePurgeDto {
  @ApiProperty({
    example: '2025-01-01T00:00:00.000Z',
    description: 'Rows older than this are purged.',
  })
  @IsDateString()
  olderThan!: string;

  @ApiProperty({
    example: '2026-11-01T02:00:00.000Z',
    description: 'When the purge runs. Must leave the minimum notice period.',
  })
  @IsDateString()
  runAt!: string;

  @ApiProperty({ example: 'Retention policy: 24 months (ticket #123)' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class CancelPurgeScheduleDto {
  @ApiProperty({ example: 'Legal asked us to wait until the audit ends.' })
  @Transform(trim)
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason!: string;
}

export class PurgeScheduleQueryDto extends AuditPagingDto {
  @ApiPropertyOptional({
    enum: ['SCHEDULED', 'RUNNING', 'EXECUTED', 'FAILED', 'CANCELLED'],
    description: 'Default SCHEDULED.',
  })
  @IsOptional()
  @IsIn(['SCHEDULED', 'RUNNING', 'EXECUTED', 'FAILED', 'CANCELLED'])
  status?: 'SCHEDULED' | 'RUNNING' | 'EXECUTED' | 'FAILED' | 'CANCELLED';
}

export const RETENTION_SCOPES = ['DEFAULT', 'ENTITY', 'SEVERITY'] as const;

export class RetentionPolicyItemDto {
  @ApiProperty({ enum: RETENTION_SCOPES })
  @IsIn(RETENTION_SCOPES)
  scope!: (typeof RETENTION_SCOPES)[number];

  @ApiProperty({
    example: 'Report',
    description:
      "Use 'DEFAULT' for the default, an entity name for ENTITY, or a severity for SEVERITY.",
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  key!: string;

  @ApiProperty({ example: 730, minimum: 30, maximum: 36500 })
  @Type(() => Number)
  @IsInt()
  @Min(30)
  @Max(36_500)
  retentionDays!: number;
}

/** AL-15. Needs a second Super Admin to send the same request before it takes effect. */
export class UpdateRetentionDto {
  @ApiProperty({ type: [RetentionPolicyItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => RetentionPolicyItemDto)
  policies!: RetentionPolicyItemDto[];

  @ApiProperty({ example: 'Annual policy review (ticket #301).' })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(500)
  reason!: string;
}

export class IntegrityRunsQueryDto extends AuditPagingDto {
  @ApiPropertyOptional({
    description: 'true = only clean runs, false = only runs that found a break.',
  })
  @IsOptional()
  @Transform(boolFromQuery)
  @IsBoolean()
  ok?: boolean;
}

export class IntegrityScheduleDto {
  @ApiProperty()
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({ example: 24, minimum: 1, maximum: 720, default: 24 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  intervalHours?: number;
}

export class HealthHistoryQueryDto {
  @ApiPropertyOptional({
    example: 24,
    default: 24,
    minimum: 1,
    maximum: 720,
    description: 'How many hours back.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(720)
  hours?: number = 24;
}

export class AlertTriggersQueryDto extends AuditPagingDto {
  @ApiPropertyOptional({ description: 'Only triggers of this rule.' })
  @IsOptional()
  @IsUUID()
  alertId?: string;

  @ApiPropertyOptional({
    description: 'false = only unacknowledged (default for the queue), true = only acknowledged.',
  })
  @IsOptional()
  @Transform(boolFromQuery)
  @IsBoolean()
  acknowledged?: boolean;
}

export class TestAlertDto {
  @ApiPropertyOptional({
    example: 24,
    default: 24,
    minimum: 1,
    maximum: 168,
    description: 'Hours of recent data to replay.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  hours?: number;
}

export class AcknowledgeTriggerDto {
  @ApiPropertyOptional({ example: 'Checked: this was the load test.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ApplyAlertTemplateDto {
  @ApiPropertyOptional({ description: 'Override the template name.' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ minimum: 1, maximum: 100_000 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100_000)
  threshold?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 10_080 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_080)
  windowMinutes?: number;

  @ApiPropertyOptional({ minimum: 0, maximum: 10_080 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(10_080)
  cooldownMinutes?: number;
}

export class UpdateSavedFilterDto {
  @ApiPropertyOptional({ example: 'Denied logins this week' })
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(80)
  name?: string;

  @ApiPropertyOptional({ type: () => AuditLogFiltersDto })
  @IsOptional()
  @IsObject()
  @ValidateNested()
  @Type(() => AuditLogFiltersDto)
  filter?: AuditLogFiltersDto;
}

/** Leave userIds out to share with every admin. */
export class ShareSavedFilterDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Share with these admins only. Omit to share with all admins.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  userIds?: string[];
}

export class UnshareSavedFilterDto {
  @ApiPropertyOptional({
    type: [String],
    description: 'Stop sharing with these admins only. Omit to stop sharing completely.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(100)
  @IsUUID('4', { each: true })
  userIds?: string[];
}

/** AL-36. The filters of GET /audit-logs, without paging: a job exports everything that matches. */
export class CreateAuditExportJobDto extends OmitType(GetAuditLogsDto, [
  'cursor',
  'page',
  'limit',
] as const) {}

/** AL-41, AL-42 */
export class MyActivityQueryDto extends AuditPagingDto {
  @ApiPropertyOptional({ example: '2026-08-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  startDate?: string;

  @ApiPropertyOptional({ example: '2026-08-31T23:59:59.999Z' })
  @IsOptional()
  @IsDateString()
  endDate?: string;
}

/** AL-47, AL-48. Default window is 30 days, maximum 365. */
export class AuditSummaryQueryDto {
  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59.999Z' })
  @IsOptional()
  @IsDateString()
  to?: string;
}

/** Shared by every /audit-logs/stats/* route below. */
export class AuditStatsFilterDto {
  @ApiPropertyOptional({
    example: '2026-09-01T00:00:00.000Z',
    description: 'Default: 30 days before now.',
  })
  @IsOptional()
  @IsDateString()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59.999Z', description: 'Default: now.' })
  @IsOptional()
  @IsDateString()
  to?: string;

  @ApiPropertyOptional({ example: 'Report' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity?: string;

  @ApiPropertyOptional({ example: 'REPORT_CREATED' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @ApiPropertyOptional({ description: 'User who performed the action.' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ enum: AuditSeverity })
  @IsOptional()
  @IsEnum(AuditSeverity)
  severity?: AuditSeverity;
}

export class AuditBucketStatsQueryDto extends AuditStatsFilterDto {
  @ApiPropertyOptional({ enum: ['hour', 'day', 'week'], default: 'day' })
  @IsOptional()
  @IsIn(['hour', 'day', 'week'])
  bucket?: 'hour' | 'day' | 'week';
}

export class DeniedStatsQueryDto extends AuditBucketStatsQueryDto {
  @ApiPropertyOptional({
    enum: ['path', 'action'],
    default: 'action',
    description: 'What to group the denied events by.',
  })
  @IsOptional()
  @IsIn(['path', 'action'])
  by?: 'path' | 'action';
}
