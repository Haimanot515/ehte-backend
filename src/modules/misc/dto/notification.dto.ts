import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

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

// ─────────────────────────────────────────────
// Shared constants
// ─────────────────────────────────────────────

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

  @ApiPropertyOptional({ example: '22:00', nullable: true, description: 'null clears quiet hours.' })
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