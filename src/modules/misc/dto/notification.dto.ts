import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';

import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';

import { Transform, Type } from 'class-transformer';

import { NotificationPriority, NotificationType } from '@prisma/client';

import { GetAuditLogsDto } from './audit-log.dto';

// ─────────────────────────────────────────────
// Shared constants
// ─────────────────────────────────────────────

export const EVENT_CATEGORIES = ['USER', 'ADMIN', 'SUPER_ADMIN', 'SYSTEM'] as const;
export type EventCategoryValue = (typeof EVENT_CATEGORIES)[number];

export const NOTIFICATION_AUDIENCES = ['ADMINS', 'ALL_USERS'] as const;
export type NotificationAudienceValue = (typeof NOTIFICATION_AUDIENCES)[number];

/** Languages templates are written in. */
export const NOTIFICATION_LANGUAGES = ['en', 'am', 'it'] as const;
export type NotificationLanguage = (typeof NOTIFICATION_LANGUAGES)[number];

export const BROADCAST_STATUSES = [
  'SCHEDULED',
  'PROCESSING',
  'COMPLETED',
  'CANCELLED',
  'FAILED',
  'AWAITING_APPROVAL',
  'REJECTED',
  'STOPPED',
] as const;

/** Channels that leave the app. In-app is always on and has no setting. */
export const DELIVERY_CHANNELS = ['EMAIL', 'SMS', 'PUSH'] as const;

export const DEVICE_PLATFORMS = ['ios', 'android', 'web'] as const;

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Query strings are always text. `@Type(() => Boolean)` turns the text
 * "false" into true, so booleans are parsed explicitly instead. Anything that
 * is not true/false is left as-is so @IsBoolean rejects it with a 400.
 */
const parseBoolean = ({ value }: { value: unknown }) => {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
};

// ─────────────────────────────────────────────
// Paging
// ─────────────────────────────────────────────

/**
 * Cursor paging when `cursor` is set or `page` is absent (no COUNT).
 * Offset paging when `page` is set (returns total and totalPages).
 */
export class NotificationPagingDto {
  @ApiPropertyOptional({ description: 'Cursor pagination (preferred). Id of the last item seen.' })
  @IsOptional()
  @IsUUID()
  cursor?: string;

  @ApiPropertyOptional({ description: 'Offset pagination. Sending page switches to offset mode.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ default: 20, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number = 20;
}

// ─────────────────────────────────────────────
// Send
// ─────────────────────────────────────────────

/**
 * Body of POST /notifications/admin.
 * Provide EXACTLY ONE of userId or audience (checked in the service).
 * audience ALL_USERS is rejected here: use POST /notifications/admin/broadcast.
 * Every recipient gets their own row; there are no shared broadcast rows.
 */
export class CreateNotificationDto {
  @ApiPropertyOptional({ example: 'uuid', description: 'Send to one specific user.' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({
    enum: NOTIFICATION_AUDIENCES,
    description: 'Send to a group instead of one user.',
  })
  @IsOptional()
  @IsIn(NOTIFICATION_AUDIENCES)
  audience?: NotificationAudienceValue;

  @ApiProperty({ enum: NotificationType, example: NotificationType.GENERAL })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiProperty({ example: 'Scheduled maintenance' })
  @IsString()
  @MaxLength(200)
  title: string;

  @ApiProperty({ example: 'The system will be unavailable tonight at 22:00.' })
  @IsString()
  @MaxLength(2000)
  body: string;

  @ApiPropertyOptional({ enum: NotificationPriority, default: NotificationPriority.NORMAL })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;
}

/**
 * Body of POST /notifications/admin/broadcast.
 *
 * Content comes from EITHER a template (templateId, plus optional variables)
 * OR written directly (type + title + body). Sending both is rejected.
 * dryRun returns the audience size and the rendered preview without sending.
 */
export class BroadcastNotificationDto {
  @ApiProperty({ enum: NOTIFICATION_AUDIENCES })
  @IsIn(NOTIFICATION_AUDIENCES)
  audience: NotificationAudienceValue;

  @ApiPropertyOptional({ description: 'Use a saved template instead of type/title/body.' })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({
    example: { name: 'Team' },
    description: 'Values for {{placeholders}} in the template. Text, number or boolean only.',
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, string | number | boolean>;

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({ example: 'Scheduled maintenance' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional({ example: 'The system will be unavailable tonight at 22:00.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  @ApiPropertyOptional({ enum: NotificationPriority, default: NotificationPriority.NORMAL })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @ApiPropertyOptional({
    example: '2026-10-01T09:00:00.000Z',
    description: 'ISO date in the future (up to 90 days). Omit to send now.',
  })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;

  @ApiPropertyOptional({ description: 'true = only return the audience size and preview.' })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  dryRun?: boolean;
}

export class BroadcastQueryDto extends NotificationPagingDto {
  @ApiPropertyOptional({ enum: BROADCAST_STATUSES })
  @IsOptional()
  @IsIn(BROADCAST_STATUSES)
  status?: (typeof BROADCAST_STATUSES)[number];
}

export class SentNotificationsQueryDto extends NotificationPagingDto {
  @ApiPropertyOptional({ description: 'SUPER_ADMIN only: see what another admin sent.' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({ enum: NotificationPriority })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;
}

export class AllNotificationsQueryDto extends NotificationPagingDto {
  @ApiPropertyOptional({ description: 'Only notifications delivered to this user.' })
  @IsOptional()
  @IsUUID()
  recipientId?: string;

  @ApiPropertyOptional({ description: 'Only notifications caused by this user.' })
  @IsOptional()
  @IsUUID()
  actorId?: string;

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({ enum: NotificationPriority })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @ApiPropertyOptional({ example: 'Report' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity?: string;

  @ApiPropertyOptional({ description: 'Only notifications about this record.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entityId?: string;

  @ApiPropertyOptional({ description: 'true = read only, false = unread only' })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  isRead?: boolean;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({
    enum: EVENT_CATEGORIES,
    description: 'Who caused it: USER, ADMIN, SUPER_ADMIN, or SYSTEM (no actor).',
  })
  @IsOptional()
  @IsIn(EVENT_CATEGORIES)
  category?: EventCategoryValue;

  @ApiPropertyOptional({ description: 'Search title, body and actor name.' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'desc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  sort?: 'asc' | 'desc';

  @ApiPropertyOptional({ description: 'false hides expired notifications. Default true.' })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  includeExpired?: boolean;
}

export class UserNotificationEventsQueryDto extends OmitType(AllNotificationsQueryDto, [
  'recipientId',
  'actorId',
] as const) {
  @ApiPropertyOptional({
    enum: ['caused', 'received', 'both'],
    default: 'both',
    description: 'caused = events this user triggered, received = notifications sent to them.',
  })
  @IsOptional()
  @IsIn(['caused', 'received', 'both'])
  direction?: 'caused' | 'received' | 'both';
}

export class EventsFeedQueryDto extends OmitType(GetAuditLogsDto, ['actorType'] as const) {}

export class EventCategoriesQueryDto {
  @ApiPropertyOptional({ description: 'Default: 30 days before now. Window is at most 90 days.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Default: now.' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class NotificationSummaryQueryDto {
  @ApiPropertyOptional({ description: 'Default: 30 days before now. Window is at most 90 days.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Default: now.' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({ example: 'Report' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity?: string;
}

// ─────────────────────────────────────────────
// Read
// ─────────────────────────────────────────────

export class MarkBulkReadDto {
  @ApiProperty({
    type: [String],
    example: ['notification-id-1', 'notification-id-2'],
  })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  ids: string[];
}

export class NotificationQueryDto extends NotificationPagingDto {
  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({ enum: NotificationPriority })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @ApiPropertyOptional({ example: 'Report', description: 'Only notifications about this entity.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity?: string;

  @ApiPropertyOptional({ description: 'true = read only, false = unread only' })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  isRead?: boolean;
}

// ─────────────────────────────────────────────
// Preferences and devices
// ─────────────────────────────────────────────

/**
 * One notification type. For each channel:
 *   true / false = explicit choice, null = go back to the default policy,
 *   field omitted = leave unchanged.
 * Security types cannot have a channel switched off (the service rejects it).
 */
export class NotificationPreferenceItemDto {
  @ApiProperty({ enum: NotificationType })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsBoolean()
  email?: boolean | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsBoolean()
  sms?: boolean | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsBoolean()
  push?: boolean | null;

  @ApiPropertyOptional({
    example: '22:00',
    nullable: true,
    description: 'null clears quiet hours.',
  })
  @IsOptional()
  @Matches(HH_MM, { message: 'quietHoursStart must be HH:mm (24h)' })
  quietHoursStart?: string | null;

  @ApiPropertyOptional({ example: '07:00', nullable: true })
  @IsOptional()
  @Matches(HH_MM, { message: 'quietHoursEnd must be HH:mm (24h)' })
  quietHoursEnd?: string | null;

  @ApiPropertyOptional({ example: 'Africa/Addis_Ababa', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string | null;
}

export class UpdateNotificationPreferencesDto {
  @ApiProperty({ type: [NotificationPreferenceItemDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceItemDto)
  items: NotificationPreferenceItemDto[];
}

export class RegisterDeviceDto {
  @ApiProperty({ description: 'Push token from FCM / APNs / web push.' })
  @IsString()
  @MinLength(10)
  @MaxLength(4096)
  token: string;

  @ApiProperty({ enum: DEVICE_PLATFORMS })
  @IsIn(DEVICE_PLATFORMS)
  platform: (typeof DEVICE_PLATFORMS)[number];
}

// ─────────────────────────────────────────────
// Deliveries
// ─────────────────────────────────────────────

export class FailedDeliveriesQueryDto extends NotificationPagingDto {
  @ApiPropertyOptional({ enum: DELIVERY_CHANNELS })
  @IsOptional()
  @IsIn(DELIVERY_CHANNELS)
  channel?: (typeof DELIVERY_CHANNELS)[number];
}

export class RetryDeliveriesDto {
  @ApiProperty({ type: [String], description: 'Delivery ids (not notification ids).' })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  ids: string[];
}

// ─────────────────────────────────────────────
// Templates
// ─────────────────────────────────────────────

export class CreateNotificationTemplateDto {
  @ApiProperty({ enum: NotificationType })
  @IsEnum(NotificationType)
  type: NotificationType;

  @ApiProperty({ enum: NOTIFICATION_LANGUAGES })
  @IsIn(NOTIFICATION_LANGUAGES)
  language: NotificationLanguage;

  @ApiProperty({ example: 'Hello {{name}}' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title: string;

  @ApiProperty({ example: 'Your case {{reference}} has an update.' })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body: string;

  @ApiPropertyOptional({ default: true })
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

/** type and language are fixed once created: create a new template instead. */
export class UpdateNotificationTemplateDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}

// ═════════════════════════════════════════════
// NEW ENDPOINTS (NF-01 to NF-63)
// ═════════════════════════════════════════════

export const OUTBOUND_CHANNELS_LIST = ['EMAIL', 'SMS', 'PUSH'] as const;
export type OutboundChannelValue = (typeof OUTBOUND_CHANNELS_LIST)[number];

export const TEST_CHANNELS = ['IN_APP', 'EMAIL', 'SMS', 'PUSH'] as const;
export const DELIVERY_STATUSES = ['PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED'] as const;
export const BOUNCE_STATUSES = ['ACTIVE', 'CLEARED'] as const;
export const STATS_BUCKETS = ['hour', 'day', 'week', 'month'] as const;
export type StatsBucket = (typeof STATS_BUCKETS)[number];

// ─────────────────────────────────────────────
// 1. User: own notifications
// ─────────────────────────────────────────────

/** PATCH /notifications/preferences/:type. The type comes from the path. Same rules as the bulk update. */
export class UpdateTypePreferenceDto extends OmitType(NotificationPreferenceItemDto, [
  'type',
] as const) {}

export class SnoozeDto {
  @ApiProperty({
    example: 8,
    minimum: 1,
    maximum: 168,
    description: 'How long to mute non-security notifications: 1 hour to 7 days (168 hours).',
  })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(168)
  hours: number;
}

export class BulkNotificationIdsDto {
  @ApiProperty({ type: [String], example: ['notification-id-1', 'notification-id-2'] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(500)
  @IsUUID('4', { each: true })
  ids: string[];
}

export class MarkReadByTypeDto {
  @ApiProperty({ enum: NotificationType })
  @IsEnum(NotificationType)
  type: NotificationType;
}

export class SearchNotificationsQueryDto extends NotificationPagingDto {
  @ApiProperty({ description: 'Search title and body.', minLength: 2, maxLength: 100 })
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q: string;
}

// ─────────────────────────────────────────────
// 2. Templates and broadcasts
// ─────────────────────────────────────────────

/** Render a saved template, or loose text, with sample values. Nothing is sent or saved. */
export class PreviewTemplateDto {
  @ApiPropertyOptional({ description: 'Preview a saved template.' })
  @IsOptional()
  @IsUUID()
  templateId?: string;

  @ApiPropertyOptional({ description: 'Or preview text that is not saved yet (title and body together).' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  body?: string;

  @ApiPropertyOptional({
    example: { name: 'Sample name' },
    description: 'Values for {{placeholders}}. Missing ones are shown as <placeholder>.',
  })
  @IsOptional()
  @IsObject()
  variables?: Record<string, string | number | boolean>;
}

/** Edit a broadcast that has not started. Only the fields you send change. */
export class UpdateBroadcastDto {
  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  title?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  body?: string;

  @ApiPropertyOptional({ enum: NotificationPriority })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @ApiPropertyOptional({ example: '2026-10-10T09:00:00.000Z', description: 'ISO date in the future (up to 90 days).' })
  @IsOptional()
  @IsISO8601()
  scheduledAt?: string;
}

export class RejectBroadcastDto {
  @ApiProperty({ example: 'Audience is too broad for this message.' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

export class BroadcastRecipientsQueryDto extends NotificationPagingDto {
  @ApiPropertyOptional({ description: 'true = read only, false = unread only' })
  @IsOptional()
  @Transform(parseBoolean)
  @IsBoolean()
  isRead?: boolean;
}

export class SendTestNotificationDto {
  @ApiProperty({ enum: TEST_CHANNELS, description: 'IN_APP only creates the inbox copy.' })
  @IsIn(TEST_CHANNELS)
  channel: (typeof TEST_CHANNELS)[number];
}

// ─────────────────────────────────────────────
// 3. Delivery and bounces
// ─────────────────────────────────────────────

export class DeliveriesQueryDto extends NotificationPagingDto {
  @ApiPropertyOptional({ enum: DELIVERY_CHANNELS })
  @IsOptional()
  @IsIn(DELIVERY_CHANNELS)
  channel?: (typeof DELIVERY_CHANNELS)[number];

  @ApiPropertyOptional({ enum: DELIVERY_STATUSES })
  @IsOptional()
  @IsIn(DELIVERY_STATUSES)
  status?: (typeof DELIVERY_STATUSES)[number];

  @ApiPropertyOptional({ description: 'Only deliveries to this user.' })
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'Only deliveries of this notification.' })
  @IsOptional()
  @IsUUID()
  notificationId?: string;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class UserDeliveriesQueryDto extends OmitType(DeliveriesQueryDto, ['userId'] as const) {}

/** Retry every FAILED delivery that matches. All fields are optional filters. */
export class RetryAllFailedDeliveriesDto {
  @ApiPropertyOptional({ enum: DELIVERY_CHANNELS })
  @IsOptional()
  @IsIn(DELIVERY_CHANNELS)
  channel?: (typeof DELIVERY_CHANNELS)[number];

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  userId?: string;

  @ApiPropertyOptional({ description: 'Only deliveries of this broadcast.' })
  @IsOptional()
  @IsUUID()
  broadcastId?: string;

  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ default: 5000, maximum: 10000, description: 'Safety cap for one call.' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(10_000)
  limit?: number;
}

export class StatsRangeQueryDto {
  @ApiPropertyOptional({ description: 'Default: 30 days before now. Window is at most 90 days.' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ description: 'Default: now.' })
  @IsOptional()
  @IsISO8601()
  to?: string;
}

export class DeliveryTimelineQueryDto extends StatsRangeQueryDto {
  @ApiPropertyOptional({ enum: DELIVERY_CHANNELS })
  @IsOptional()
  @IsIn(DELIVERY_CHANNELS)
  channel?: (typeof DELIVERY_CHANNELS)[number];

  @ApiPropertyOptional({ enum: ['hour', 'day'], default: 'day' })
  @IsOptional()
  @IsIn(['hour', 'day'])
  bucket?: 'hour' | 'day';
}

export class BouncesQueryDto extends NotificationPagingDto {
  @ApiPropertyOptional({ enum: ['EMAIL', 'SMS'] })
  @IsOptional()
  @IsIn(['EMAIL', 'SMS'])
  channel?: 'EMAIL' | 'SMS';

  @ApiPropertyOptional({ enum: BOUNCE_STATUSES, description: 'Default ACTIVE.' })
  @IsOptional()
  @IsIn(BOUNCE_STATUSES)
  status?: (typeof BOUNCE_STATUSES)[number];
}

export class ClearBounceDto {
  @ApiPropertyOptional({ example: 'User confirmed the new address by phone.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

// ─────────────────────────────────────────────
// 4. Per-user support
// ─────────────────────────────────────────────

/** A short reason (for example the support ticket) that is written to the audit log. */
export class AdminReasonDto {
  @ApiProperty({ example: 'Support ticket #4821: phone reported stolen.' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

// ─────────────────────────────────────────────
// 5. Admin inbox and company-wide analytics
// ─────────────────────────────────────────────

export class ByRecipientQueryDto extends NotificationPagingDto {
  @ApiPropertyOptional({ example: '2026-09-01T00:00:00.000Z' })
  @IsOptional()
  @IsISO8601()
  from?: string;

  @ApiPropertyOptional({ example: '2026-09-30T23:59:59.999Z' })
  @IsOptional()
  @IsISO8601()
  to?: string;

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({ enum: NotificationPriority })
  @IsOptional()
  @IsEnum(NotificationPriority)
  priority?: NotificationPriority;

  @ApiPropertyOptional({ example: 'Report' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity?: string;

  @ApiPropertyOptional({ enum: ['total', 'unread', 'last'], default: 'total' })
  @IsOptional()
  @IsIn(['total', 'unread', 'last'])
  sortBy?: 'total' | 'unread' | 'last';
}

export class AllTimelineQueryDto extends StatsRangeQueryDto {
  @ApiPropertyOptional({ enum: ['day', 'week', 'month'], default: 'day' })
  @IsOptional()
  @IsIn(['day', 'week', 'month'])
  bucket?: 'day' | 'week' | 'month';

  @ApiPropertyOptional({ enum: NotificationType })
  @IsOptional()
  @IsEnum(NotificationType)
  type?: NotificationType;

  @ApiPropertyOptional({ example: 'Report' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  entity?: string;
}

/** Same filters as GET /notifications/admin/all. Paging fields are ignored: a job exports everything that matches. */
export class NotificationExportJobDto extends OmitType(AllNotificationsQueryDto, [
  'cursor',
  'page',
  'limit',
] as const) {}

// ─────────────────────────────────────────────
// 6. Governance and queue
// ─────────────────────────────────────────────

export class UpdateRetentionDto {
  @ApiProperty({
    example: 180,
    minimum: 0,
    maximum: 3650,
    description: 'Days to keep a notification after it was read. 0 keeps read notifications forever.',
  })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(3650)
  readRetentionDays: number;

  @ApiProperty({ example: 'Policy review 2026-Q4.' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

export class QueuePauseDto {
  @ApiProperty({ enum: OUTBOUND_CHANNELS_LIST })
  @IsIn(OUTBOUND_CHANNELS_LIST)
  channel: OutboundChannelValue;

  @ApiProperty({ example: 'SMS provider outage, incident #77.' })
  @IsString()
  @MinLength(5)
  @MaxLength(500)
  reason: string;
}

export class QueueResumeDto {
  @ApiProperty({ enum: OUTBOUND_CHANNELS_LIST })
  @IsIn(OUTBOUND_CHANNELS_LIST)
  channel: OutboundChannelValue;
}
