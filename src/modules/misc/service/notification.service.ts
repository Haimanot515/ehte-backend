import { randomUUID } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  MessageEvent,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import {
  ActorType,
  AuditOutcome,
  AuditSeverity,
  NotificationPriority,
  NotificationType,
  Prisma,
} from '@prisma/client';
import { OnEvent } from '@nestjs/event-emitter';
import { Observable, Subject, interval, merge } from 'rxjs';
import { map } from 'rxjs/operators';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
// Same redaction used by audit: notifications must never carry secrets.
import { toAuditJson } from 'src/common/utils/audit-redaction';

import {
  BroadcastNotificationDto,
  BroadcastQueryDto,
  CreateNotificationTemplateDto,
  FailedDeliveriesQueryDto,
  NotificationQueryDto,
  RegisterDeviceDto,
  SentNotificationsQueryDto,
  AllNotificationsQueryDto,
  NotificationSummaryQueryDto,
  UserNotificationEventsQueryDto,
  EventsFeedQueryDto,
  EventCategoriesQueryDto,
  UpdateNotificationPreferencesDto,
  UpdateNotificationTemplateDto,
  // new endpoints
  NOTIFICATION_LANGUAGES,
  AdminReasonDto,
  AllTimelineQueryDto,
  BouncesQueryDto,
  BroadcastRecipientsQueryDto,
  ByRecipientQueryDto,
  ClearBounceDto,
  DeliveriesQueryDto,
  DeliveryTimelineQueryDto,
  NotificationExportJobDto,
  NotificationPagingDto,
  PreviewTemplateDto,
  QueuePauseDto,
  QueueResumeDto,
  RejectBroadcastDto,
  RetryAllFailedDeliveriesDto,
  SearchNotificationsQueryDto,
  SendTestNotificationDto,
  SnoozeDto,
  StatsRangeQueryDto,
  UpdateBroadcastDto,
  UpdateRetentionDto,
  UpdateTypePreferenceDto,
  UserDeliveriesQueryDto,
} from '../dto/notification.dto';
import { AUDIT_ALERT_TRIGGERED_EVENT, AuditAlertTriggeredEvent } from '../events/audit.events';
import { CSV_BOM, EXPORT_SCOPE, ExportJobService, csvCell } from './export-job.service';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import type { ExportJobFinishedEvent } from '../events/notification.events';
import { GetAuditLogsDto } from '../dto/audit-log.dto';
import { AuditLogService } from './audit-log.service';
import {
  NOTIFICATION_CHANNEL_PROVIDERS,
  NotificationChannelProvider,
  NotificationOutboundChannel,
} from './notification-channel.provider';

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_EXPORT_ROWS = 50_000;

/** Security types can never be switched off and ignore quiet hours. Strings on purpose: no enum coupling. */
const LOCKED_TYPES = new Set<string>(['SECURITY_ALERT', 'PASSWORD_CHANGED', 'PASSWORD_RESET']);

const OUTBOUND_CHANNELS: NotificationOutboundChannel[] = ['PUSH', 'EMAIL', 'SMS'];

/** Discreet mode: outside channels carry no detail at all. Full text stays inside the app. */
const DISCREET_TITLE = 'New update';
const DISCREET_BODY = 'You have a new update. Open the app to view it.';

const STATUS = {
  PENDING: 'PENDING',
  SENDING: 'SENDING',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED: 'SKIPPED',
} as const;

const BROADCAST_STATUS = {
  SCHEDULED: 'SCHEDULED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  AWAITING_APPROVAL: 'AWAITING_APPROVAL',
  REJECTED: 'REJECTED',
  STOPPED: 'STOPPED',
} as const;

/** Broadcasts to at least this many people need a second approver. 0 turns the rule off. */
const BROADCAST_APPROVAL_THRESHOLD = Number(
  process.env.NOTIFICATION_BROADCAST_APPROVAL_THRESHOLD ?? 1000,
);
const MAX_ENTITY_MUTES_PER_USER = 500;
const MAX_RETRY_ALL = 10_000;
const NOTIFICATION_EXPORT_HEADER = [
  'id',
  'createdAt',
  'type',
  'priority',
  'entity',
  'entityId',
  'recipientId',
  'actorId',
  'actorName',
  'actorRole',
  'title',
  'readAt',
];

const WORKER_INTERVAL_MS = 5_000;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const STALE_CLAIM_MS = 10 * 60 * 1000;
const DELIVERY_CLAIM_BATCH = 50;
const DELIVERY_BATCHES_PER_TICK = 4;
const DELIVERY_CONCURRENCY = 10;
const MAX_DELIVERY_ATTEMPTS = 5;
const MAX_BROADCAST_ATTEMPTS = 3;
const BACKOFF_BASE_MS = 30_000;
const BACKOFF_MAX_MS = 60 * 60 * 1000;

/** Per-user cap on outside-channel deliveries per hour. URGENT and security types bypass it. */
const MAX_OUTSIDE_PER_HOUR = 10;

const MAX_DEVICES_PER_USER = 10;
const MAX_STREAMS_PER_USER = 5;
const STREAM_HEARTBEAT_MS = 25_000;
const MAX_SCHEDULE_AHEAD_MS = 90 * 24 * 60 * 60 * 1000;
const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const DEVICE_STALE_MS = 90 * 24 * 60 * 60 * 1000;

const DEFAULT_TIMEZONE = process.env.NOTIFICATION_DEFAULT_TIMEZONE || 'Africa/Addis_Ababa';

// ─────────────────────────────────────────────
// Input types
// ─────────────────────────────────────────────

/** Fields shared by every way of creating a notification. */
export interface NotificationContent {
  type: NotificationType;
  title: string;
  body: string;

  priority?: NotificationPriority;

  /** Domain object the notification is about, e.g. 'Report' + report id. */
  entity?: string | null;
  entityId?: string | null;
  /** Who caused it. Null/undefined for system-generated notifications. */
  actorId?: string | null;
  /** Snapshot of the actor. Filled automatically from actorId when omitted. */
  actorName?: string | null;
  actorRole?: string | null;

  /** Navigation only. NOT an authorization mechanism. */
  actionUrl?: string | null;

  /** Non-sensitive structured data. Redacted before saving. */
  data?: Record<string, unknown> | null;

  expiresAt?: Date | null;
}

export interface CreateNotificationInput extends NotificationContent {
  /** Recipient. Required: every notification belongs to exactly one user. */
  userId: string;
  /**
   * Makes creation idempotent per recipient. Use it ONLY when the event has a
   * unique occurrence id (e.g. `INFO_REQUEST_RESPONDED:{informationRequestId}`).
   * Do not use it for repeatable events (assignment, status changes): a second
   * legitimate notification would be silently dropped.
   */
  dedupeKey?: string | null;
  broadcastId?: string | null;
}

export interface CreateNotificationsInput extends NotificationContent {
  userIds: string[];
  /** Called once per recipient to build that recipient's dedupeKey. */
  dedupeKeyFor?: (userId: string) => string;
}

export interface CreateForAdminsInput extends NotificationContent {
  /** Usually the admin who triggered the action, so they are not notified about it. */
  excludeUserId?: string | null;
  dedupeKeyFor?: (userId: string) => string;
}

export type NotificationAudience = 'ADMINS' | 'ALL_USERS';

/** Used by POST /notifications/admin (manual send by an admin). */
export interface AdminSendInput extends NotificationContent {
  userId?: string;
  audience?: NotificationAudience;
}

type PlanRow = {
  id: string;
  userId: string;
  type: NotificationType;
  priority: NotificationPriority;
  entity?: string | null;
  entityId?: string | null;
};

type PagingInput = { cursor?: string; page?: number; limit?: number };

// ─────────────────────────────────────────────
// Service
// ─────────────────────────────────────────────

@Injectable()
export class NotificationService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(NotificationService.name);

  /** Role names that count as "admin" for admin-queue notifications. */
  private static readonly ADMIN_ROLE_NAMES = ['ADMIN', 'SUPER_ADMIN'];

  /** Rows per createMany call when sending to a large audience. */
  private static readonly BATCH_SIZE = 1000;

  private readonly providers = new Map<NotificationOutboundChannel, NotificationChannelProvider>();

  /** Live SSE connections. Per process: with several instances use Redis pub/sub instead. */
  private readonly streams = new Map<string, Set<Subject<MessageEvent>>>();

  private readonly firehose = new Subject<MessageEvent>();

  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private lastTickAt: Date | null = null;
  private lastMaintenanceAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLog: AuditLogService,
    @Optional()
    @Inject(NOTIFICATION_CHANNEL_PROVIDERS)
    providers?: NotificationChannelProvider[],
    // NEW: background export jobs (NF-54 to NF-57)
    private readonly exportJobs?: ExportJobService,
  ) {
    for (const p of providers ?? []) {
      this.providers.set(p.channel, p);
    }
  }

  // ───────────────────────────────────────────
  // LIFECYCLE (delivery worker)
  // ───────────────────────────────────────────

  onModuleInit() {
    if (process.env.NOTIFICATION_WORKER_ENABLED === 'false') {
      this.logger.warn('Notification worker disabled (NOTIFICATION_WORKER_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => void this.runWorkerOnce(), WORKER_INTERVAL_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    for (const set of this.streams.values()) {
      for (const subject of set) subject.complete();
    }
    this.streams.clear();
  }

  /** One worker pass. Safe to call from a test. Several instances can run it: rows are claimed with SKIP LOCKED. */
  async runWorkerOnce(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      this.lastTickAt = new Date();
      await this.startDueBroadcasts();
      await this.processDeliveries();

      if (Date.now() - this.lastMaintenanceAt > MAINTENANCE_INTERVAL_MS) {
        this.lastMaintenanceAt = Date.now();
        await this.runMaintenance();
      }
    } catch (err) {
      this.logger.error(`Notification worker pass failed: ${this.safeError(err)}`);
    } finally {
      this.ticking = false;
    }
  }

  // ───────────────────────────────────────────
  // CREATE
  // ───────────────────────────────────────────

  /**
   * Create one notification for one user, then plan its outside deliveries.
   * Returns null if a notification with the same (userId, dedupeKey) already exists.
   */
  async createForUser(input: CreateNotificationInput) {
    const snapshot = await this.actorSnapshot(input);

    let row;
    try {
      row = await this.prisma.notification.create({
        data: this.toCreateData({ ...input, ...snapshot }),
      });
    } catch (error) {
      if (
        input.dedupeKey &&
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        return null; // same event processed twice: already notified
      }
      throw error;
    }

    await this.planDeliveriesSafely([row]);
    this.publish([row.userId]);
    return row;
  }

  /**
   * Fan-out: one row per recipient, each with its own readAt.
   * Duplicate ids are collapsed; rows hitting an existing (userId, dedupeKey) are skipped.
   */
  async createForUsers(input: CreateNotificationsInput): Promise<{ count: number }> {
    const { userIds, dedupeKeyFor, ...content } = input;
    const recipients = [...new Set(userIds)].filter(Boolean);
    if (recipients.length === 0) return { count: 0 };

    const snapshot = await this.actorSnapshot(content);

    let count = 0;
    for (let i = 0; i < recipients.length; i += NotificationService.BATCH_SIZE) {
      const batch = recipients.slice(i, i + NotificationService.BATCH_SIZE);
      const ids = batch.map(() => randomUUID());

      const result = await this.prisma.notification.createMany({
        data: batch.map((userId, idx) => ({
          ...this.toCreateData({
            ...content,
            ...snapshot,
            userId,
            dedupeKey: dedupeKeyFor?.(userId) ?? null,
          }),
          id: ids[idx],
        })),
        skipDuplicates: true,
      });
      count += result.count;

      // Rows skipped as duplicates never got our ids, so only real inserts come back.
      const created = await this.prisma.notification.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          userId: true,
          type: true,
          priority: true,
          entity: true,
          entityId: true,
        },
      });
      await this.planDeliveriesSafely(created);
      this.publish(batch);
    }
    return { count };
  }

  /**
   * Admin-queue notices ("a report needs review"): one personal row per
   * active ADMIN / SUPER_ADMIN, so read state is independent per admin.
   */
  async createForAdmins(input: CreateForAdminsInput): Promise<{ count: number }> {
    const { excludeUserId, ...rest } = input;

    const admins = await this.prisma.user.findMany({
      where: {
        ...this.audienceWhere('ADMINS'),
        ...(excludeUserId && { id: { not: excludeUserId } }),
      },
      select: { id: true },
    });

    return this.createForUsers({ ...rest, userIds: admins.map((a) => a.id) });
  }

  /**
   * Manual send from the admin panel: exactly one of userId or audience ADMINS.
   * ALL_USERS is not accepted here: it goes through broadcast(), which has its own permission.
   * Safe to retry with an Idempotency-Key.
   */
  async createFromAdmin(
    input: AdminSendInput,
    actor: CurrentUserDto,
    idempotencyKey?: string,
  ): Promise<{ count: number }> {
    const actorId = this.requireUserId(actor);
    const { userId, audience, ...content } = input;

    if ((userId && audience) || (!userId && !audience)) {
      throw new BadRequestException('provide_exactly_one_of_userId_or_audience');
    }
    if (audience === 'ALL_USERS') {
      throw new BadRequestException('use_broadcast_endpoint_for_all_users');
    }
    if (audience && audience !== 'ADMINS') {
      throw new BadRequestException('invalid_audience');
    }

    return this.withIdempotency(actorId, idempotencyKey, async () => {
      const snapshot = await this.resolveActor(actorId);
      const withActor = { ...content, actorId, ...snapshot };

      if (userId) {
        const exists = await this.prisma.user.findUnique({
          where: { id: userId },
          select: { id: true },
        });
        if (!exists) throw new NotFoundException('User not found');

        await this.createForUser({ ...withActor, userId });
        return { count: 1 };
      }

      return this.createForAdmins(withActor);
    });
  }

  // ───────────────────────────────────────────
  // READ  (everything below is scoped to the caller's own rows)
  // ───────────────────────────────────────────

  async getMyNotifications(user: CurrentUserDto, query: NotificationQueryDto = {}) {
    return this.paginateNotifications(this.myFilters(user.id, query), query);
  }

  /** Notifications about one record, e.g. entity 'Report' + report id. */
  async getMyNotificationsForEntity(
    user: CurrentUserDto,
    entity: string,
    entityId: string,
    query: NotificationQueryDto = {},
  ) {
    return this.paginateNotifications(this.myFilters(user.id, query, { entity, entityId }), query);
  }

  /** The notification plus who caused it (from the stored snapshot) and whether the system made it. */
  async getMyNotificationById(id: string, user: CurrentUserDto) {
    const notification = await this.prisma.notification.findFirst({
      where: this.activeWhere(user.id, { id }),
    });

    if (!notification) throw new NotFoundException('Notification not found');

    return {
      ...notification,
      actor:
        notification.actorId || notification.actorName
          ? { name: notification.actorName ?? null, role: notification.actorRole ?? null }
          : null,
      isSystemGenerated: !notification.actorId,
    };
  }

  async getMyUnreadCount(user: CurrentUserDto) {
    const count = await this.prisma.notification.count({
      where: this.activeWhere(user.id, { readAt: null }),
    });
    return { count };
  }

  /** For tab badges: { total, byType: { REPORT_...: 3, ... } }. */
  async getMyUnreadCountByType(user: CurrentUserDto) {
    const groups = await this.prisma.notification.groupBy({
      by: ['type'],
      where: this.activeWhere(user.id, { readAt: null }),
      _count: { _all: true },
    });

    const byType: Record<string, number> = {};
    let total = 0;
    for (const g of groups) {
      byType[g.type] = g._count._all;
      total += g._count._all;
    }
    return { total, byType };
  }

  // ───────────────────────────────────────────
  // UPDATE / DELETE
  // ───────────────────────────────────────────

  /**
   * Mark one of MY notifications as read. Someone else's id and an unknown id
   * both return 404, so ids cannot be probed. Already-read rows keep their
   * original readAt (count is then 0).
   */
  async markOneAsRead(id: string, user: CurrentUserDto) {
    await this.requireOwned(id, user.id);

    const result = await this.prisma.notification.updateMany({
      where: { id, userId: user.id, readAt: null },
      data: this.readPatch(),
    });
    this.publish([user.id]);
    return result;
  }

  async markOneAsUnread(id: string, user: CurrentUserDto) {
    await this.requireOwned(id, user.id);

    const result = await this.prisma.notification.updateMany({
      where: { id, userId: user.id, readAt: { not: null } },
      data: this.unreadPatch(),
    });
    this.publish([user.id]);
    return result;
  }

  /** Ids that are not mine are simply ignored (never touched). */
  async markBulkAsRead(ids: string[], user: CurrentUserDto) {
    const result = await this.prisma.notification.updateMany({
      where: { id: { in: ids }, userId: user.id, readAt: null },
      data: this.readPatch(),
    });
    this.publish([user.id]);
    return result;
  }

  async markAllAsRead(user: CurrentUserDto) {
    const result = await this.prisma.notification.updateMany({
      where: { userId: user.id, readAt: null },
      data: this.readPatch(),
    });
    this.publish([user.id]);
    return result;
  }

  /** Every row is personal, so deleting only ever affects the caller. */
  async deleteMyNotification(id: string, user: CurrentUserDto) {
    const result = await this.prisma.notification.deleteMany({
      where: { id, userId: user.id },
    });

    if (result.count === 0) throw new NotFoundException('Notification not found');
    this.publish([user.id]);
    return { id, deleted: true };
  }

  /** Clears everything I have already read. Unread rows are never touched. */
  async deleteAllMyRead(user: CurrentUserDto) {
    const result = await this.prisma.notification.deleteMany({
      where: { userId: user.id, readAt: { not: null } },
    });
    this.publish([user.id]);
    return { deleted: true, count: result.count };
  }

  /** For the scheduled cleanup. Deliveries go with them (cascade). */
  async deleteExpired(now = new Date()): Promise<{ count: number }> {
    const result = await this.prisma.notification.deleteMany({
      where: { expiresAt: { lt: now } },
    });
    return { count: result.count };
  }

  // ───────────────────────────────────────────
  // PREFERENCES
  // ───────────────────────────────────────────

  /**
   * One entry per notification type. A null channel means "default policy":
   * push on; email only for HIGH/URGENT; SMS only for URGENT. Security types
   * are locked on for every channel the user has verified.
   */
  async getMyPreferences(user: CurrentUserDto) {
    const rows = await this.prisma.notificationPreference.findMany({
      where: { userId: this.requireUserId(user) },
    });
    const byType = new Map(rows.map((r) => [String(r.type), r]));

    return (Object.values(NotificationType) as string[]).map((type) => {
      const row = byType.get(type);
      const locked = LOCKED_TYPES.has(type);
      return {
        type,
        locked,
        inApp: true,
        email: locked ? true : (row?.email ?? null),
        sms: locked ? true : (row?.sms ?? null),
        push: locked ? true : (row?.push ?? null),
        quietHours:
          !locked && row?.quietHoursStart && row?.quietHoursEnd
            ? {
                start: row.quietHoursStart,
                end: row.quietHoursEnd,
                timezone: row.timezone ?? DEFAULT_TIMEZONE,
              }
            : null,
      };
    });
  }

  async updateMyPreferences(user: CurrentUserDto, dto: UpdateNotificationPreferencesDto) {
    const userId = this.requireUserId(user);

    const seen = new Set<string>();
    for (const item of dto.items) {
      if (seen.has(item.type)) throw new BadRequestException('duplicate_notification_type');
      seen.add(item.type);

      if (LOCKED_TYPES.has(item.type)) {
        if (item.email === false || item.sms === false || item.push === false) {
          throw new BadRequestException('security_notifications_cannot_be_disabled');
        }
      }
      if (item.timezone) this.assertTimezone(item.timezone);

      const hasStart = item.quietHoursStart !== undefined && item.quietHoursStart !== null;
      const hasEnd = item.quietHoursEnd !== undefined && item.quietHoursEnd !== null;
      if (hasStart !== hasEnd) {
        throw new BadRequestException('quiet_hours_need_both_start_and_end');
      }
    }

    await this.prisma.$transaction(
      dto.items.map((item) => {
        const data = {
          ...(item.email !== undefined && { email: item.email }),
          ...(item.sms !== undefined && { sms: item.sms }),
          ...(item.push !== undefined && { push: item.push }),
          ...(item.quietHoursStart !== undefined && { quietHoursStart: item.quietHoursStart }),
          ...(item.quietHoursEnd !== undefined && { quietHoursEnd: item.quietHoursEnd }),
          ...(item.timezone !== undefined && { timezone: item.timezone }),
        };
        return this.prisma.notificationPreference.upsert({
          where: { userId_type: { userId, type: item.type } },
          create: { userId, type: item.type, ...data },
          update: data,
        });
      }),
    );

    return this.getMyPreferences(user);
  }

  // ───────────────────────────────────────────
  // DEVICES (push tokens)
  // ───────────────────────────────────────────

  async registerDevice(user: CurrentUserDto, dto: RegisterDeviceDto) {
    const userId = this.requireUserId(user);
    const now = new Date();

    // A token belongs to one user at a time: if the device signs in as someone else it moves.
    await this.prisma.deviceToken.upsert({
      where: { token: dto.token },
      create: { userId, token: dto.token, platform: dto.platform, lastSeenAt: now },
      update: { userId, platform: dto.platform, lastSeenAt: now },
    });

    // Keep only the newest devices.
    const devices = await this.prisma.deviceToken.findMany({
      where: { userId },
      orderBy: { lastSeenAt: 'desc' },
      select: { id: true },
    });
    if (devices.length > MAX_DEVICES_PER_USER) {
      await this.prisma.deviceToken.deleteMany({
        where: { id: { in: devices.slice(MAX_DEVICES_PER_USER).map((d) => d.id) } },
      });
    }

    return { registered: true };
  }

  /** Scoped to the caller: someone else's token is simply not found. */
  async unregisterDevice(user: CurrentUserDto, token: string) {
    const result = await this.prisma.deviceToken.deleteMany({
      where: { token, userId: this.requireUserId(user) },
    });
    return { removed: result.count > 0 };
  }

  // ───────────────────────────────────────────
  // LIVE STREAM (SSE)
  // ───────────────────────────────────────────

  /**
   * Emits { kind: 'refresh' } whenever the caller's inbox or unread count may
   * have changed (the client then refetches), plus a heartbeat to keep proxies
   * from closing the connection. Nothing about other users is ever sent.
   */
  streamForUser(user: CurrentUserDto): Observable<MessageEvent> {
    const userId = this.requireUserId(user);

    return new Observable<MessageEvent>((subscriber) => {
      const subject = new Subject<MessageEvent>();
      const set = this.streams.get(userId) ?? new Set<Subject<MessageEvent>>();

      // Too many open tabs: close the oldest connection.
      if (set.size >= MAX_STREAMS_PER_USER) {
        const oldest = set.values().next().value as Subject<MessageEvent> | undefined;
        if (oldest) {
          set.delete(oldest);
          oldest.complete();
        }
      }
      set.add(subject);
      this.streams.set(userId, set);

      const heartbeat = interval(STREAM_HEARTBEAT_MS).pipe(
        map((): MessageEvent => ({ data: { kind: 'heartbeat' } })),
      );
      const subscription = merge(subject, heartbeat).subscribe(subscriber);
      subscriber.next({ data: { kind: 'connected' } });

      return () => {
        subscription.unsubscribe();
        set.delete(subject);
        if (set.size === 0) this.streams.delete(userId);
      };
    });
  }

  /** Company-level live feed: one small event per batch of new notifications, then re-query admin/all. */
  streamAllEvents(): Observable<MessageEvent> {
    return new Observable<MessageEvent>((subscriber) => {
      const heartbeat = interval(STREAM_HEARTBEAT_MS).pipe(
        map((): MessageEvent => ({ data: { kind: 'heartbeat' } })),
      );
      const subscription = merge(this.firehose, heartbeat).subscribe(subscriber);
      subscriber.next({ data: { kind: 'connected' } });
      return () => subscription.unsubscribe();
    });
  }

  private publish(userIds: string[]) {
    if (this.firehose.observed) {
      this.firehose.next({
        data: { kind: 'notifications', recipients: userIds.length, at: new Date().toISOString() },
      });
    }
    if (this.streams.size === 0) return;
    for (const id of userIds) {
      const set = this.streams.get(id);
      if (!set) continue;
      for (const subject of set) subject.next({ data: { kind: 'refresh' } });
    }
  }

  // ───────────────────────────────────────────
  // BROADCASTS (admin)
  // ───────────────────────────────────────────

  /**
   * Audience send with optional template, scheduling and dry run.
   * Creates a broadcast record; the worker fans it out into personal rows.
   * Fan-out is crash-safe: each row carries dedupeKey `broadcast:{id}`, so a
   * re-run never duplicates anyone.
   */
  async broadcast(dto: BroadcastNotificationDto, actor: CurrentUserDto, idempotencyKey?: string) {
    const actorId = this.requireUserId(actor);
    const content = await this.resolveBroadcastContent(dto);
    const scheduledAt = this.parseScheduledAt(dto.scheduledAt);
    const audienceSize = await this.prisma.user.count({ where: this.audienceWhere(dto.audience) });

    // A dry run never consumes the idempotency key, so a later real send with the same key still works.
    if (dto.dryRun) {
      return {
        dryRun: true,
        audience: dto.audience,
        audienceSize,
        scheduledAt: scheduledAt.toISOString(),
        preview: content,
      };
    }

    // NEW HOOK (NF-31): a large broadcast waits for a second person before it can start.
    const needsApproval =
      BROADCAST_APPROVAL_THRESHOLD > 0 && audienceSize >= BROADCAST_APPROVAL_THRESHOLD;

    return this.withIdempotency(actorId, idempotencyKey, async () => {
      const created = await this.prisma.notificationBroadcast.create({
        data: {
          createdById: actorId,
          audience: dto.audience,
          type: content.type,
          title: content.title,
          body: content.body,
          priority: content.priority,
          templateId: content.templateId,
          status: needsApproval ? BROADCAST_STATUS.AWAITING_APPROVAL : BROADCAST_STATUS.SCHEDULED,
          requiresApproval: needsApproval,
          scheduledAt,
        },
      });

      await this.audit(actor, {
        action: AuditEventEnum.NOTIFICATION_BROADCAST_CREATED,
        entity: 'NotificationBroadcast',
        entityId: created.id,
        entityLabel: content.title,
        severity: dto.audience === 'ALL_USERS' ? AuditSeverity.WARNING : AuditSeverity.INFO,
        metadata: {
          audience: dto.audience,
          audienceSize,
          type: content.type,
          scheduledAt: scheduledAt.toISOString(),
          templateId: content.templateId,
          requiresApproval: needsApproval,
        },
      });

      // Start straight away when it is due; the worker picks up anything this misses.
      if (needsApproval) {
        void this.notifyApprovers(created.id, content.title, audienceSize, actorId);
      }

      if (!needsApproval && scheduledAt.getTime() <= Date.now() + 5_000) {
        void this.runBroadcast(created.id).catch((err) =>
          this.logger.error(`Broadcast ${created.id} start failed: ${this.safeError(err)}`),
        );
      }

      return {
        broadcastId: created.id,
        status: created.status,
        audience: dto.audience,
        audienceSize,
        scheduledAt: scheduledAt.toISOString(),
        requiresApproval: needsApproval,
      };
    });
  }

  /** Mine; SUPER_ADMIN sees everyone's. */
  async listBroadcasts(user: CurrentUserDto, query: BroadcastQueryDto) {
    const where: Prisma.NotificationBroadcastWhereInput = {
      ...(!this.isSuperAdmin(user) && { createdById: this.requireUserId(user) }),
      ...(query.status && { status: query.status }),
    };
    const { page, limit } = this.pageParams(query);

    const [data, total] = await Promise.all([
      this.prisma.notificationBroadcast.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notificationBroadcast.count({ where }),
    ]);

    return { data, meta: this.offsetMeta(page, limit, total, data.length) };
  }

  /** One broadcast with delivery numbers: reached, delivered per channel, failed, read and unread. */
  async getBroadcast(id: string, user: CurrentUserDto) {
    const broadcast = await this.findOwnedBroadcast(id, user);

    const [recipients, read, groups] = await Promise.all([
      this.prisma.notification.count({ where: { broadcastId: id } }),
      this.prisma.notification.count({ where: { broadcastId: id, readAt: { not: null } } }),
      this.prisma.notificationDelivery.groupBy({
        by: ['channel', 'status'],
        where: { notification: { broadcastId: id } },
        _count: { _all: true },
      }),
    ]);

    return {
      ...broadcast,
      stats: {
        recipients,
        read,
        unread: recipients - read,
        deliveries: this.summarizeDeliveries(groups),
      },
    };
  }

  /** Only broadcasts that have not started can be cancelled. */
  async cancelBroadcast(id: string, user: CurrentUserDto) {
    const broadcast = await this.findOwnedBroadcast(id, user);

    const result = await this.prisma.notificationBroadcast.updateMany({
      where: { id, status: BROADCAST_STATUS.SCHEDULED },
      data: { status: BROADCAST_STATUS.CANCELLED, finishedAt: new Date() },
    });
    if (result.count === 0) {
      throw new ConflictException('broadcast_already_started_or_finished');
    }

    await this.audit(user, {
      action: AuditEventEnum.NOTIFICATION_BROADCAST_CANCELLED,
      entity: 'NotificationBroadcast',
      entityId: id,
      entityLabel: broadcast.title,
      severity: AuditSeverity.WARNING,
    });

    return { id, cancelled: true };
  }

  private async findOwnedBroadcast(id: string, user: CurrentUserDto) {
    const broadcast = await this.prisma.notificationBroadcast.findUnique({ where: { id } });
    // Another admin's broadcast and an unknown id look the same.
    if (!broadcast || (!this.isSuperAdmin(user) && broadcast.createdById !== user.id)) {
      throw new NotFoundException('Broadcast not found');
    }
    return broadcast;
  }

  private async resolveBroadcastContent(dto: BroadcastNotificationDto) {
    const hasDirect = Boolean(dto.type || dto.title || dto.body);

    if (dto.templateId) {
      if (hasDirect) throw new BadRequestException('use_either_templateId_or_type_title_body');

      const template = await this.prisma.notificationTemplate.findUnique({
        where: { id: dto.templateId },
      });
      if (!template || !template.isActive) throw new NotFoundException('Template not found');

      const vars = this.cleanVariables(dto.variables);
      return {
        type: template.type,
        title: this.render(template.title, vars),
        body: this.render(template.body, vars),
        priority: dto.priority ?? NotificationPriority.NORMAL,
        templateId: template.id as string | null,
      };
    }

    if (dto.variables) throw new BadRequestException('variables_need_templateId');
    if (!dto.type || !dto.title?.trim() || !dto.body?.trim()) {
      throw new BadRequestException('type_title_and_body_required_without_template');
    }

    return {
      type: dto.type,
      title: dto.title.trim(),
      body: dto.body.trim(),
      priority: dto.priority ?? NotificationPriority.NORMAL,
      templateId: null as string | null,
    };
  }

  private parseScheduledAt(value?: string): Date {
    if (!value) return new Date();

    const at = new Date(value);
    if (isNaN(at.getTime())) throw new BadRequestException('invalid_scheduledAt');
    if (at.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('scheduledAt_must_be_in_the_future');
    }
    if (at.getTime() > Date.now() + MAX_SCHEDULE_AHEAD_MS) {
      throw new BadRequestException('scheduledAt_too_far_ahead');
    }
    return at;
  }

  private audienceWhere(audience: string): Prisma.UserWhereInput {
    if (audience === 'ADMINS') {
      return {
        isActive: true,
        userRoles: { some: { role: { name: { in: NotificationService.ADMIN_ROLE_NAMES } } } },
      };
    }
    // ALL_USERS: active users.
    return { isActive: true };
  }

  /** Picks up broadcasts that are due, or whose worker died mid-way. */
  private async startDueBroadcasts() {
    const now = new Date();
    const due = await this.prisma.notificationBroadcast.findMany({
      where: {
        OR: [
          { status: BROADCAST_STATUS.SCHEDULED, scheduledAt: { lte: now } },
          {
            status: BROADCAST_STATUS.PROCESSING,
            updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
          },
        ],
      },
      orderBy: { scheduledAt: 'asc' },
      take: 5,
      select: { id: true },
    });

    for (const b of due) {
      await this.runBroadcast(b.id);
    }
  }

  private async runBroadcast(id: string): Promise<void> {
    const now = new Date();

    // Claim: only one worker wins. A stale PROCESSING row (worker died) can be re-claimed.
    const claimed = await this.prisma.notificationBroadcast.updateMany({
      where: {
        id,
        OR: [
          { status: BROADCAST_STATUS.SCHEDULED, scheduledAt: { lte: now } },
          {
            status: BROADCAST_STATUS.PROCESSING,
            updatedAt: { lt: new Date(now.getTime() - STALE_CLAIM_MS) },
          },
        ],
      },
      data: {
        status: BROADCAST_STATUS.PROCESSING,
        startedAt: now,
        attempts: { increment: 1 },
        error: null,
      },
    });
    if (claimed.count === 0) return;

    const broadcast = await this.prisma.notificationBroadcast.findUnique({ where: { id } });
    if (!broadcast) return;

    try {
      const snapshot = broadcast.createdById
        ? await this.resolveActor(broadcast.createdById)
        : { actorName: null, actorRole: null };
      const where = this.audienceWhere(broadcast.audience);
      const dedupeKey = `broadcast:${broadcast.id}`;

      let lastId: string | undefined;
      for (;;) {
        const users = await this.prisma.user.findMany({
          where,
          orderBy: { id: 'asc' },
          take: NotificationService.BATCH_SIZE,
          select: { id: true },
          ...(lastId && { cursor: { id: lastId }, skip: 1 }),
        });
        if (users.length === 0) break;

        // NEW HOOK (NF-33): an admin asked to stop. Rows already created keep their inbox copy.
        if (await this.stopRequested(id)) {
          await this.markStopped(id);
          return;
        }

        const ids = users.map((u) => u.id);
        lastId = ids[ids.length - 1];

        await this.prisma.notification.createMany({
          data: ids.map((userId) =>
            this.toCreateData({
              userId,
              type: broadcast.type,
              title: broadcast.title,
              body: broadcast.body,
              priority: broadcast.priority,
              actorId: broadcast.createdById,
              ...snapshot,
              dedupeKey,
              broadcastId: broadcast.id,
            }),
          ),
          skipDuplicates: true,
        });

        // Read back by broadcast, not by generated id: a re-run after a crash still plans its deliveries.
        const rows = await this.prisma.notification.findMany({
          where: { broadcastId: broadcast.id, userId: { in: ids } },
          select: {
            id: true,
            userId: true,
            type: true,
            priority: true,
            entity: true,
            entityId: true,
          },
        });
        await this.planDeliveriesSafely(rows);
        this.publish(ids);

        // Touch the row so a live worker is never mistaken for a dead one.
        await this.prisma.notificationBroadcast.update({
          where: { id },
          data: { status: BROADCAST_STATUS.PROCESSING },
        });

        if (users.length < NotificationService.BATCH_SIZE) break;
      }

      if (await this.stopRequested(id)) {
        await this.markStopped(id);
        return;
      }

      const recipientCount = await this.prisma.notification.count({
        where: { broadcastId: broadcast.id },
      });
      await this.prisma.notificationBroadcast.update({
        where: { id },
        data: { status: BROADCAST_STATUS.COMPLETED, finishedAt: new Date(), recipientCount },
      });

      await this.audit(null, {
        action: AuditEventEnum.NOTIFICATION_BROADCAST_SENT,
        entity: 'NotificationBroadcast',
        entityId: broadcast.id,
        entityLabel: broadcast.title,
        metadata: {
          audience: broadcast.audience,
          recipientCount,
          createdById: broadcast.createdById,
        },
      });
    } catch (err) {
      const message = this.safeError(err);
      const giveUp = broadcast.attempts >= MAX_BROADCAST_ATTEMPTS;
      this.logger.error(`Broadcast ${id} failed (attempt ${broadcast.attempts}): ${message}`);

      await this.prisma.notificationBroadcast
        .update({
          where: { id },
          data: {
            // Back to SCHEDULED so the next pass retries. Already-created rows are skipped by dedupeKey.
            status: giveUp ? BROADCAST_STATUS.FAILED : BROADCAST_STATUS.SCHEDULED,
            error: message,
            ...(giveUp && { finishedAt: new Date() }),
          },
        })
        .catch(() => undefined);
    }
  }

  // ───────────────────────────────────────────
  // SENT HISTORY + DELIVERY HEALTH (admin)
  // ───────────────────────────────────────────

  /**
   * Notifications I sent one-to-one or to admins. Broadcast rows are left out
   * (thousands of rows): they are reachable through the broadcast routes.
   * Only SUPER_ADMIN may look at another admin's sends.
   */
  async getSentByAdmin(user: CurrentUserDto, query: SentNotificationsQueryDto) {
    const self = this.requireUserId(user);
    if (query.actorId && query.actorId !== self && !this.isSuperAdmin(user)) {
      throw new ForbiddenException('only_super_admin_can_view_other_admins_sends');
    }

    const where: Prisma.NotificationWhereInput = {
      actorId: query.actorId ?? self,
      broadcastId: null,
      ...(query.type && { type: query.type }),
      ...(query.priority && { priority: query.priority }),
    };

    const result = await this.paginateNotifications(where, query, true);

    // Recipient names, looked up separately so only id and name are ever exposed.
    const ids = [...new Set(result.data.map((n) => n.userId))];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      ...result,
      data: result.data.map((n) => ({ ...n, recipientName: names.get(n.userId) ?? null })),
    };
  }

  /** Every notification the system has emitted, for ADMIN and SUPER_ADMIN. Not scoped to the caller. */
  async getAllNotifications(query: AllNotificationsQueryDto) {
    const result = await this.paginateNotifications(
      this.allWhere(query),
      query,
      true,
      query.sort ?? 'desc',
    );

    const ids = [...new Set(result.data.map((n) => n.userId))];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      ...result,
      data: result.data.map((n) => ({
        ...n,
        recipientName: names.get(n.userId) ?? null,
        isSystemGenerated: !n.actorId,
      })),
    };
  }

  /** What one user did (caused) and what was sent to them (received). ADMIN and SUPER_ADMIN. */
  async getUserNotificationEvents(userId: string, query: UserNotificationEventsQueryDto) {
    const exists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });
    if (!exists) throw new NotFoundException('User not found');

    const direction = query.direction ?? 'both';
    const scope: Prisma.NotificationWhereInput =
      direction === 'caused'
        ? { actorId: userId }
        : direction === 'received'
          ? { userId }
          : { OR: [{ actorId: userId }, { userId }] };

    const result = await this.paginateNotifications(
      { AND: [this.allWhere(query as AllNotificationsQueryDto), scope] },
      query,
      true,
      query.sort ?? 'desc',
    );

    const ids = [...new Set(result.data.map((n) => n.userId))];
    const users = await this.prisma.user.findMany({
      where: { id: { in: ids } },
      select: { id: true, name: true },
    });
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      user: exists,
      direction,
      ...result,
      data: result.data.map((n) => ({
        ...n,
        recipientName: names.get(n.userId) ?? null,
        relation: n.actorId === userId ? 'caused' : 'received',
      })),
    };
  }

  /** Everything one class of actor did, from the audit log (covers actions that raise no notification). */
  async getEventsByActorType(
    actorType: ActorType,
    query: EventsFeedQueryDto,
    viewer: CurrentUserDto,
  ) {
    return this.auditLog.findAll({ ...query, actorType } as GetAuditLogsDto, viewer);
  }

  async getEventCategories(query: EventCategoriesQueryDto) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw new BadRequestException('from_must_be_before_to');
    if (to.getTime() - from.getTime() > 90 * 86_400_000) {
      throw new BadRequestException('range_too_large_max_90_days');
    }

    const auditWhere: Prisma.AuditLogWhereInput = { createdAt: { gte: from, lte: to } };
    const notifWhere: Prisma.NotificationWhereInput = { createdAt: { gte: from, lte: to } };

    const [audit, adminN, superN, systemN, userN] = await Promise.all([
      this.prisma.auditLog.groupBy({
        by: ['actorType'],
        where: auditWhere,
        _count: { _all: true },
      }),
      this.prisma.notification.count({ where: { ...notifWhere, actorRole: 'ADMIN' } }),
      this.prisma.notification.count({ where: { ...notifWhere, actorRole: 'SUPER_ADMIN' } }),
      this.prisma.notification.count({ where: { ...notifWhere, actorId: null } }),
      this.prisma.notification.count({
        where: {
          ...notifWhere,
          actorId: { not: null },
          OR: [{ actorRole: null }, { actorRole: { notIn: ['ADMIN', 'SUPER_ADMIN'] } }],
        },
      }),
    ]);

    const auditCount = (type: string) =>
      audit.find((g) => String(g.actorType) === type)?._count._all ?? 0;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      categories: [
        { category: 'USER', auditEvents: auditCount('USER'), notifications: userN },
        { category: 'ADMIN', auditEvents: auditCount('ADMIN'), notifications: adminN },
        {
          category: 'SUPER_ADMIN',
          auditEvents: auditCount('SUPER_ADMIN'),
          notifications: superN,
        },
        { category: 'SYSTEM', auditEvents: auditCount('SYSTEM'), notifications: systemN },
      ],
    };
  }

  /** Any notification by id, with how each channel delivery went. ADMIN and SUPER_ADMIN. */
  async getAnyNotificationById(id: string) {
    const notification = await this.prisma.notification.findUnique({ where: { id } });
    if (!notification) throw new NotFoundException('Notification not found');

    const [deliveries, recipient] = await Promise.all([
      this.prisma.notificationDelivery.findMany({
        where: { notificationId: id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.user.findUnique({
        where: { id: notification.userId },
        select: { id: true, name: true },
      }),
    ]);

    return {
      ...notification,
      recipient,
      actor:
        notification.actorId || notification.actorName
          ? { name: notification.actorName ?? null, role: notification.actorRole ?? null }
          : null,
      isSystemGenerated: !notification.actorId,
      deliveries,
    };
  }

  /** One user's notification settings and devices, for support. Device tokens are shortened. */
  async getUserNotificationSettings(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true },
    });
    if (!user) throw new NotFoundException('User not found');

    const [preferences, devices, unread] = await Promise.all([
      this.getMyPreferences({ id: userId } as CurrentUserDto),
      this.prisma.deviceToken.findMany({
        where: { userId },
        orderBy: { lastSeenAt: 'desc' },
      }),
      this.prisma.notification.count({ where: this.activeWhere(userId, { readAt: null }) }),
    ]);

    return {
      user,
      unreadCount: unread,
      preferences,
      devices: devices.map((d) => ({
        platform: d.platform,
        tokenSuffix: d.token.slice(-6),
        lastSeenAt: d.lastSeenAt,
        createdAt: d.createdAt,
      })),
    };
  }

  async getNotificationSummary(query: NotificationSummaryQueryDto) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (from >= to) throw new BadRequestException('from_must_be_before_to');
    if (to.getTime() - from.getTime() > 90 * 86_400_000) {
      throw new BadRequestException('range_too_large_max_90_days');
    }

    const where: Prisma.NotificationWhereInput = {
      createdAt: { gte: from, lte: to },
      ...(query.type && { type: query.type }),
      ...(query.entity && { entity: query.entity }),
    };

    const [total, unread, systemGenerated, byType, byPriority, byEntity, topActorGroups] =
      await Promise.all([
        this.prisma.notification.count({ where }),
        this.prisma.notification.count({ where: { ...where, readAt: null } }),
        this.prisma.notification.count({ where: { ...where, actorId: null } }),
        this.prisma.notification.groupBy({ by: ['type'], where, _count: { _all: true } }),
        this.prisma.notification.groupBy({ by: ['priority'], where, _count: { _all: true } }),
        this.prisma.notification.groupBy({ by: ['entity'], where, _count: { _all: true } }),
        this.prisma.notification.groupBy({
          by: ['actorId'],
          where: { ...where, actorId: { not: null } },
          _count: { _all: true },
          orderBy: { _count: { actorId: 'desc' } },
          take: 10,
        }),
      ]);

    const actorIds = topActorGroups.map((g) => g.actorId).filter((id): id is string => !!id);
    const actors = actorIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: actorIds } },
          select: { id: true, name: true },
        })
      : [];
    const actorNames = new Map(actors.map((u) => [u.id, u.name]));

    const sorted = <T extends { _count: { _all: number } }>(rows: T[]) =>
      [...rows].sort((a, b) => b._count._all - a._count._all);

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      total,
      unread,
      read: total - unread,
      systemGenerated,
      userGenerated: total - systemGenerated,
      byType: sorted(byType).map((g) => ({ type: g.type, count: g._count._all })),
      byPriority: sorted(byPriority).map((g) => ({ priority: g.priority, count: g._count._all })),
      byEntity: sorted(byEntity).map((g) => ({ entity: g.entity, count: g._count._all })),
      topActors: topActorGroups.map((g) => ({
        actorId: g.actorId,
        name: actorNames.get(g.actorId as string) ?? null,
        count: g._count._all,
      })),
    };
  }

  async exportAllNotificationsCsv(query: AllNotificationsQueryDto, admin: CurrentUserDto) {
    const rows = await this.prisma.notification.findMany({
      where: this.allWhere(query),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_EXPORT_ROWS + 1,
      select: {
        id: true,
        createdAt: true,
        type: true,
        priority: true,
        entity: true,
        entityId: true,
        userId: true,
        actorId: true,
        actorName: true,
        actorRole: true,
        title: true,
        readAt: true,
      },
    });

    const truncated = rows.length > MAX_EXPORT_ROWS;
    const data = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows;

    await this.audit(
      admin,
      {
        action: AuditEventEnum.NOTIFICATION_USER_DATA_EXPORTED,
        entity: 'Notification',
        severity: AuditSeverity.WARNING,
        metadata: {
          scope: 'all',
          rowCount: data.length,
          truncated,
          filters: { ...query, cursor: undefined, page: undefined, limit: undefined },
        },
      },
      true,
    );

    const cell = (value: unknown): string => {
      if (value === null || value === undefined) return '';
      let text = value instanceof Date ? value.toISOString() : String(value);
      if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    };

    const header = [
      'id',
      'createdAt',
      'type',
      'priority',
      'entity',
      'entityId',
      'recipientId',
      'actorId',
      'actorName',
      'actorRole',
      'title',
      'readAt',
    ];
    const lines = data.map((n) =>
      [
        n.id,
        n.createdAt,
        n.type,
        n.priority,
        n.entity,
        n.entityId,
        n.userId,
        n.actorId,
        n.actorName,
        n.actorRole,
        n.title,
        n.readAt,
      ]
        .map(cell)
        .join(','),
    );

    return { csv: [header.join(','), ...lines].join('\r\n'), truncated, rowCount: data.length };
  }

  /** Last 24h delivery success per channel, queue depth, failures and broadcasts in flight. */
  async getDeliveryStats() {
    const now = new Date();
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [groups, queueDepth, oldestPending, scheduledBroadcasts, processingBroadcasts] =
      await Promise.all([
        this.prisma.notificationDelivery.groupBy({
          by: ['channel', 'status'],
          where: { createdAt: { gte: since } },
          _count: { _all: true },
        }),
        this.prisma.notificationDelivery.count({ where: { status: STATUS.PENDING } }),
        this.prisma.notificationDelivery.findFirst({
          where: { status: STATUS.PENDING },
          orderBy: { nextAttemptAt: 'asc' },
          select: { nextAttemptAt: true },
        }),
        this.prisma.notificationBroadcast.count({ where: { status: BROADCAST_STATUS.SCHEDULED } }),
        this.prisma.notificationBroadcast.count({ where: { status: BROADCAST_STATUS.PROCESSING } }),
      ]);

    const failedLast24h = groups
      .filter((g) => g.status === STATUS.FAILED)
      .reduce((sum, g) => sum + g._count._all, 0);

    return {
      windowHours: 24,
      channels: this.summarizeDeliveries(groups),
      queueDepth,
      oldestPendingAt: oldestPending?.nextAttemptAt ?? null,
      failedLast24h,
      scheduledBroadcasts,
      processingBroadcasts,
      configuredChannels: [...this.providers.keys()],
      // Per process: with several instances, aggregate these in your metrics stack.
      worker: {
        enabled: this.timer !== null,
        lastTickAt: this.lastTickAt,
      },
    };
  }

  async getFailedDeliveries(query: FailedDeliveriesQueryDto) {
    const where: Prisma.NotificationDeliveryWhereInput = {
      status: STATUS.FAILED,
      ...(query.channel && { channel: query.channel }),
    };
    const { page, limit } = this.pageParams(query);

    const [rows, total] = await Promise.all([
      this.prisma.notificationDelivery.findMany({
        where,
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        // No notification title/body here: the failure list must not become a second copy of the content.
        include: {
          notification: {
            select: { id: true, type: true, priority: true, entity: true, entityId: true },
          },
        },
      }),
      this.prisma.notificationDelivery.count({ where }),
    ]);

    const ids = [...new Set(rows.map((r) => r.userId))];
    const users = ids.length
      ? await this.prisma.user.findMany({
          where: { id: { in: ids } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      data: rows.map((r) => ({ ...r, userName: names.get(r.userId) ?? null })),
      meta: this.offsetMeta(page, limit, total, rows.length),
    };
  }

  /** Puts FAILED deliveries back in the queue. Anything not FAILED is ignored. */
  async retryDeliveries(ids: string[], actor: CurrentUserDto) {
    const result = await this.prisma.notificationDelivery.updateMany({
      where: { id: { in: ids }, status: STATUS.FAILED },
      data: { status: STATUS.PENDING, attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });

    await this.audit(actor, {
      action: AuditEventEnum.NOTIFICATION_DELIVERIES_RETRIED,
      entity: 'NotificationDelivery',
      entityLabel: `${result.count} of ${ids.length} requeued`,
      metadata: { requested: ids.length, requeued: result.count },
    });

    return { requested: ids.length, requeued: result.count };
  }

  // ───────────────────────────────────────────
  // TEMPLATES (admin)
  // ───────────────────────────────────────────

  async listTemplates() {
    return this.prisma.notificationTemplate.findMany({
      orderBy: [{ type: 'asc' }, { language: 'asc' }],
    });
  }

  async createTemplate(dto: CreateNotificationTemplateDto, actor: CurrentUserDto) {
    let template;
    try {
      template = await this.prisma.notificationTemplate.create({
        data: {
          type: dto.type,
          language: dto.language,
          title: dto.title.trim(),
          body: dto.body.trim(),
          isActive: dto.isActive ?? true,
          createdById: this.requireUserId(actor),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('template_already_exists_for_type_and_language');
      }
      throw err;
    }

    await this.audit(actor, {
      action: AuditEventEnum.NOTIFICATION_TEMPLATE_CREATED,
      entity: 'NotificationTemplate',
      entityId: template.id,
      entityLabel: `${template.type}/${template.language}`,
      diff: { before: null, after: dto },
    });

    return template;
  }

  async updateTemplate(id: string, dto: UpdateNotificationTemplateDto, actor: CurrentUserDto) {
    const before = await this.prisma.notificationTemplate.findUnique({ where: { id } });
    if (!before) throw new NotFoundException('Template not found');

    const changes = Object.fromEntries(
      Object.entries(dto)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => [k, typeof v === 'string' ? v.trim() : v]),
    );
    if (Object.keys(changes).length === 0) throw new BadRequestException('nothing_to_update');

    const after = await this.prisma.notificationTemplate.update({ where: { id }, data: changes });

    const keys = Object.keys(changes) as Array<keyof typeof before>;
    await this.audit(actor, {
      action: AuditEventEnum.NOTIFICATION_TEMPLATE_UPDATED,
      entity: 'NotificationTemplate',
      entityId: id,
      entityLabel: `${after.type}/${after.language}`,
      diff: {
        before: Object.fromEntries(keys.map((k) => [k, before[k]])),
        after: Object.fromEntries(keys.map((k) => [k, after[k]])),
      },
    });

    return after;
  }

  // ───────────────────────────────────────────
  // DATA-SUBJECT REQUESTS (SUPER_ADMIN)
  // ───────────────────────────────────────────

  /** Everything held about one user's notifications. Push tokens are masked. Audited (fails closed). */
  async exportForUser(userId: string, admin: CurrentUserDto) {
    const exists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('User not found');

    const [rows, preferences, devices] = await Promise.all([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: MAX_EXPORT_ROWS + 1,
      }),
      this.prisma.notificationPreference.findMany({ where: { userId } }),
      this.prisma.deviceToken.findMany({ where: { userId } }),
    ]);

    const truncated = rows.length > MAX_EXPORT_ROWS;
    const notifications = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows;

    await this.audit(
      admin,
      {
        action: AuditEventEnum.NOTIFICATION_USER_DATA_EXPORTED,
        entity: 'User',
        entityId: userId,
        severity: AuditSeverity.WARNING,
        metadata: { notificationCount: notifications.length, truncated },
      },
      true,
    );

    return {
      userId,
      exportedAt: new Date().toISOString(),
      truncated,
      notifications,
      preferences,
      devices: devices.map((d) => ({
        platform: d.platform,
        tokenSuffix: d.token.slice(-6),
        lastSeenAt: d.lastSeenAt,
        createdAt: d.createdAt,
      })),
    };
  }

  /**
   * Removes one user's notifications, deliveries (cascade), preferences, devices
   * and idempotency keys. Rows this user CAUSED for other people keep the event
   * but lose the actor's name and role (the id stays as an opaque pseudonym).
   */
  async eraseForUser(userId: string, admin: CurrentUserDto) {
    const exists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('User not found');

    const [, , notifications, preferences, devices, keys, anonymizedActorRows] =
      await this.prisma.$transaction([
        this.prisma.notificationSnooze.deleteMany({ where: { userId } }),
        this.prisma.notificationEntityMute.deleteMany({ where: { userId } }),
        this.prisma.notification.deleteMany({ where: { userId } }),
        this.prisma.notificationPreference.deleteMany({ where: { userId } }),
        this.prisma.deviceToken.deleteMany({ where: { userId } }),
        this.prisma.notificationIdempotencyKey.deleteMany({ where: { actorId: userId } }),
        this.prisma.notification.updateMany({
          where: { actorId: userId },
          data: { actorName: null, actorRole: null },
        }),
      ]);

    const summary = {
      notifications: notifications.count,
      preferences: preferences.count,
      devices: devices.count,
      idempotencyKeys: keys.count,
      anonymizedActorRows: anonymizedActorRows.count,
    };

    this.publish([userId]);

    await this.audit(
      admin,
      {
        action: AuditEventEnum.NOTIFICATION_USER_DATA_ERASED,
        entity: 'User',
        entityId: userId,
        severity: AuditSeverity.CRITICAL,
        diff: { before: null, after: summary },
      },
      true,
    );

    return { userId, ...summary };
  }

  // ───────────────────────────────────────────
  // DELIVERY PLANNING
  // ───────────────────────────────────────────

  /**
   * Decides, per notification and outside channel, whether a delivery row is
   * created. The notification row itself is the in-app copy and is unaffected.
   *
   * A channel is planned only when ALL of these hold:
   *  - a provider is registered for it
   *  - the user is active and not locked out
   *  - the channel is verified (email/phone) or has a device token (push)
   *  - the user's preference allows it (security types are locked on)
   *  - the hourly cap is not exceeded (URGENT and security types bypass it)
   *
   * Quiet hours delay the delivery; URGENT and security types ignore them.
   * Planning is idempotent: (notificationId, channel) is unique.
   */
  private async planDeliveries(rows: PlanRow[]): Promise<void> {
    if (rows.length === 0 || this.providers.size === 0) return;

    const now = new Date();
    const userIds = [...new Set(rows.map((r) => r.userId))];
    const types = [...new Set(rows.map((r) => r.type))];
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);

    const [users, prefs, tokenUsers, recent, snoozes, mutes, bounces] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds }, isActive: true },
        select: {
          id: true,
          email: true,
          phone: true,
          isEmailVerified: true,
          isPhoneVerified: true,
          lockedUntil: true,
        },
      }),
      this.prisma.notificationPreference.findMany({
        where: { userId: { in: userIds }, type: { in: types } },
      }),
      this.prisma.deviceToken.groupBy({ by: ['userId'], where: { userId: { in: userIds } } }),
      this.prisma.notificationDelivery.groupBy({
        by: ['userId'],
        where: { userId: { in: userIds }, createdAt: { gte: hourAgo } },
        _count: { _all: true },
      }),
      // NEW HOOKS: snooze (NF-08), per-record mute (NF-20), bounced addresses (NF-40)
      this.prisma.notificationSnooze.findMany({
        where: { userId: { in: userIds }, until: { gt: now } },
        select: { userId: true },
      }),
      this.prisma.notificationEntityMute.findMany({
        where: { userId: { in: userIds } },
        select: { userId: true, entity: true, entityId: true },
      }),
      this.prisma.notificationBounce.findMany({
        where: { status: 'ACTIVE' },
        select: { channel: true, address: true },
      }),
    ]);

    const snoozed = new Set(snoozes.map((x) => x.userId));
    const mutedRecords = new Set(mutes.map((m) => `${m.userId}:${m.entity}:${m.entityId}`));
    const bouncedSet = new Set(bounces.map((b) => `${b.channel}:${b.address}`));

    const userById = new Map(users.map((u) => [u.id, u]));
    const prefByKey = new Map(prefs.map((p) => [`${p.userId}:${p.type}`, p]));
    const hasToken = new Set(tokenUsers.map((t) => t.userId));
    const sentLastHour = new Map(recent.map((r) => [r.userId, r._count._all]));

    const data: Prisma.NotificationDeliveryCreateManyInput[] = [];

    for (const row of rows) {
      const user = userById.get(row.userId);
      if (!user) continue;
      if (user.lockedUntil && user.lockedUntil > now) continue;

      const locked = LOCKED_TYPES.has(String(row.type));
      const urgent = String(row.priority) === 'URGENT';
      const bypass = locked || urgent;

      if (!bypass && (sentLastHour.get(row.userId) ?? 0) >= MAX_OUTSIDE_PER_HOUR) continue;

      // Snooze and per-record mute silence the outside channels. The inbox copy always exists.
      // Security types (locked) are never silenced.
      if (!locked) {
        if (snoozed.has(row.userId)) continue;
        if (
          row.entity &&
          row.entityId &&
          mutedRecords.has(`${row.userId}:${row.entity}:${row.entityId}`)
        ) {
          continue;
        }
      }

      const pref = prefByKey.get(`${row.userId}:${row.type}`);

      for (const channel of OUTBOUND_CHANNELS) {
        if (!this.providers.has(channel)) continue;
        if (
          channel === 'EMAIL' &&
          user.email &&
          bouncedSet.has(`EMAIL:${this.normalizeAddress('EMAIL', user.email)}`)
        )
          continue;
        if (
          channel === 'SMS' &&
          user.phone &&
          bouncedSet.has(`SMS:${this.normalizeAddress('SMS', user.phone)}`)
        )
          continue;

        const reachable =
          channel === 'EMAIL'
            ? Boolean(user.isEmailVerified)
            : channel === 'SMS'
              ? Boolean(user.isPhoneVerified)
              : hasToken.has(row.userId);
        if (!reachable) continue;

        const explicit =
          channel === 'EMAIL' ? pref?.email : channel === 'SMS' ? pref?.sms : pref?.push;
        const enabled = locked ? true : (explicit ?? this.defaultEnabled(channel, row));
        if (!enabled) continue;

        let nextAttemptAt = now;
        if (!bypass && pref?.quietHoursStart && pref?.quietHoursEnd) {
          const end = this.quietHoursEnd(
            now,
            pref.quietHoursStart,
            pref.quietHoursEnd,
            pref.timezone ?? DEFAULT_TIMEZONE,
          );
          if (end) nextAttemptAt = end;
        }

        data.push({
          notificationId: row.id,
          userId: row.userId,
          channel,
          status: STATUS.PENDING,
          nextAttemptAt,
        });
        sentLastHour.set(row.userId, (sentLastHour.get(row.userId) ?? 0) + 1);
      }
    }

    if (data.length > 0) {
      await this.prisma.notificationDelivery.createMany({ data, skipDuplicates: true });
    }
  }

  /** Delivery planning must never make creating a notification fail: the in-app copy already exists. */
  private async planDeliveriesSafely(rows: PlanRow[]) {
    try {
      await this.planDeliveries(rows);
    } catch (err) {
      this.logger.error(
        `Delivery planning failed for ${rows.length} notification(s): ${this.safeError(err)}`,
      );
    }
  }

  /** Default policy when the user has not chosen: push on, email for HIGH/URGENT, SMS for URGENT only. */
  private defaultEnabled(channel: NotificationOutboundChannel, row: PlanRow): boolean {
    const priority = String(row.priority);
    if (channel === 'PUSH') return true;
    if (channel === 'EMAIL') return priority === 'HIGH' || priority === 'URGENT';
    return priority === 'URGENT';
  }

  /** When inside the quiet window, returns the moment it ends; otherwise null. */
  private quietHoursEnd(now: Date, start: string, end: string, timeZone: string): Date | null {
    const toMinutes = (hhmm: string) => {
      const [h, m] = hhmm.split(':').map(Number);
      return h * 60 + m;
    };
    const s = toMinutes(start);
    const e = toMinutes(end);
    if (s === e) return null;

    let current: number;
    try {
      const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      }).formatToParts(now);
      const h = Number(parts.find((p) => p.type === 'hour')?.value);
      const m = Number(parts.find((p) => p.type === 'minute')?.value);
      current = h * 60 + m;
    } catch {
      return null; // unknown time zone: do not delay
    }

    const inWindow = s < e ? current >= s && current < e : current >= s || current < e;
    if (!inWindow) return null;

    const minutesUntilEnd = (e - current + 1440) % 1440;
    return new Date(
      now.getTime() + minutesUntilEnd * 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds()),
    );
  }

  // ───────────────────────────────────────────
  // DELIVERY WORKER
  // ───────────────────────────────────────────

  private async processDeliveries(): Promise<void> {
    await this.recoverStuckDeliveries();

    for (let i = 0; i < DELIVERY_BATCHES_PER_TICK; i++) {
      const ids = await this.claimDeliveries(DELIVERY_CLAIM_BATCH);
      if (ids.length === 0) return;

      for (let j = 0; j < ids.length; j += DELIVERY_CONCURRENCY) {
        const chunk = ids.slice(j, j + DELIVERY_CONCURRENCY);
        await Promise.allSettled(chunk.map((id) => this.dispatchOne(id)));
      }
      if (ids.length < DELIVERY_CLAIM_BATCH) return;
    }
  }

  /**
   * Claims due PENDING rows for this worker. SKIP LOCKED lets several
   * instances run without picking the same row. Dates are sent as parameters
   * (not NOW()) so they are compared in UTC like every stored value.
   */
  private async claimDeliveries(limit: number): Promise<string[]> {
    const now = new Date();
    // NEW HOOK (NF-62): paused channels are left waiting in the queue.
    const paused = await this.pausedChannels();
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE notification_delivery
      SET status = 'SENDING', attempts = attempts + 1, "updatedAt" = ${now}
      WHERE id IN (
        SELECT id FROM notification_delivery
        WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now}
          AND NOT (channel = ANY(${paused}::text[]))
        ORDER BY "nextAttemptAt" ASC
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING id`;
    return rows.map((r) => r.id);
  }

  /** A worker that died mid-send leaves rows in SENDING: put them back. */
  private async recoverStuckDeliveries() {
    await this.prisma.notificationDelivery.updateMany({
      where: {
        status: STATUS.SENDING,
        updatedAt: { lt: new Date(Date.now() - STALE_CLAIM_MS) },
      },
      data: { status: STATUS.PENDING },
    });
  }

  private async dispatchOne(id: string): Promise<void> {
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id },
      include: { notification: true },
    });
    if (!delivery || delivery.status !== STATUS.SENDING) return;

    const channel = delivery.channel as NotificationOutboundChannel;
    const notification = delivery.notification;

    try {
      const provider = this.providers.get(channel);
      if (!provider) return await this.finish(id, STATUS.SKIPPED, 'provider_not_configured');

      if (notification.expiresAt && notification.expiresAt < new Date()) {
        return await this.finish(id, STATUS.SKIPPED, 'notification_expired');
      }

      const user = await this.prisma.user.findUnique({
        where: { id: delivery.userId },
        select: {
          email: true,
          phone: true,
          isActive: true,
          isEmailVerified: true,
          isPhoneVerified: true,
          lockedUntil: true,
          discreetModeEnabled: true,
        },
      });

      // Everything is re-checked at send time: the user may have changed since planning.
      if (!user || !user.isActive) return await this.finish(id, STATUS.SKIPPED, 'user_inactive');
      if (user.lockedUntil && user.lockedUntil > new Date()) {
        return await this.finish(id, STATUS.SKIPPED, 'user_locked');
      }

      const to: { email?: string; phone?: string; deviceTokens?: string[] } = {};
      if (channel === 'EMAIL') {
        if (!user.email || !user.isEmailVerified) {
          return await this.finish(id, STATUS.SKIPPED, 'email_not_verified');
        }
        if (await this.isBounced('EMAIL', user.email)) {
          return await this.finish(id, STATUS.SKIPPED, 'address_bounced');
        }
        to.email = user.email;
      } else if (channel === 'SMS') {
        if (!user.phone || !user.isPhoneVerified) {
          return await this.finish(id, STATUS.SKIPPED, 'phone_not_verified');
        }
        if (await this.isBounced('SMS', user.phone)) {
          return await this.finish(id, STATUS.SKIPPED, 'address_bounced');
        }
        to.phone = user.phone;
      } else {
        const tokens = await this.prisma.deviceToken.findMany({
          where: { userId: delivery.userId },
          select: { token: true },
        });
        if (tokens.length === 0) return await this.finish(id, STATUS.SKIPPED, 'no_device_token');
        to.deviceTokens = tokens.map((t) => t.token);
      }

      // DISCREET MODE: nothing about the event leaves the app.
      const discreet = Boolean(user.discreetModeEnabled);

      await provider.send({
        deliveryId: id,
        userId: delivery.userId,
        type: String(notification.type),
        priority: String(notification.priority),
        title: discreet ? DISCREET_TITLE : notification.title,
        body: discreet ? DISCREET_BODY : notification.body,
        actionUrl: discreet ? null : (notification.actionUrl ?? null),
        discreet,
        to,
      });

      await this.prisma.notificationDelivery.update({
        where: { id },
        data: { status: STATUS.SENT, sentAt: new Date(), lastError: null },
      });
    } catch (err) {
      const message = this.safeError(err);
      const giveUp = delivery.attempts >= MAX_DELIVERY_ATTEMPTS;
      const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (delivery.attempts - 1), BACKOFF_MAX_MS);

      await this.prisma.notificationDelivery.update({
        where: { id },
        data: giveUp
          ? { status: STATUS.FAILED, lastError: message }
          : {
              status: STATUS.PENDING,
              lastError: message,
              nextAttemptAt: new Date(Date.now() + backoff),
            },
      });

      if (giveUp) {
        this.logger.warn(
          `Delivery ${id} (${channel}) failed after ${delivery.attempts} attempts: ${message}`,
        );
      }
    }
  }

  private async finish(id: string, status: string, reason: string) {
    await this.prisma.notificationDelivery.update({
      where: { id },
      data: { status, lastError: reason },
    });
  }

  // ───────────────────────────────────────────
  // MAINTENANCE
  // ───────────────────────────────────────────

  private async runMaintenance() {
    const now = Date.now();
    const readDays = await this.effectiveReadRetentionDays();

    try {
      const expired = await this.deleteExpired(new Date(now));

      // 0 turns off deleting old read notifications.
      const oldRead =
        readDays > 0
          ? await this.prisma.notification.deleteMany({
              where: { readAt: { lt: new Date(now - readDays * 24 * 60 * 60 * 1000) } },
            })
          : { count: 0 };

      const keys = await this.prisma.notificationIdempotencyKey.deleteMany({
        where: { createdAt: { lt: new Date(now - IDEMPOTENCY_TTL_MS) } },
      });
      const devices = await this.prisma.deviceToken.deleteMany({
        where: { lastSeenAt: { lt: new Date(now - DEVICE_STALE_MS) } },
      });

      this.logger.log(
        `Maintenance: expired=${expired.count} oldRead=${oldRead.count} idempotencyKeys=${keys.count} staleDevices=${devices.count}`,
      );
    } catch (err) {
      this.logger.error(`Maintenance failed: ${this.safeError(err)}`);
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // NEW ENDPOINTS (NF-01 to NF-63)
  // Everything below was added. The methods above are unchanged except for the
  // small hooks marked "NEW HOOK" (planDeliveries, claimDeliveries, dispatchOne,
  // broadcast, runBroadcast, runMaintenance, eraseForUser).
  // ═════════════════════════════════════════════════════════════════════════

  // ───────────────────────────────────────────
  // 1. USER: OWN NOTIFICATIONS
  // ───────────────────────────────────────────

  /** NF-01: every type with its locked flag and default channel policy, for a preferences screen. */
  getNotificationTypes() {
    return (Object.values(NotificationType) as string[]).map((type) => {
      const locked = LOCKED_TYPES.has(type);
      return {
        type,
        locked,
        inApp: true,
        defaultChannels: locked
          ? { push: 'ALWAYS', email: 'ALWAYS', sms: 'ALWAYS' }
          : { push: 'ALWAYS', email: 'HIGH_AND_URGENT', sms: 'URGENT_ONLY' },
      };
    });
  }

  /** NF-02: same rules as the bulk update, for one type. */
  async updateMyTypePreference(
    user: CurrentUserDto,
    type: NotificationType,
    dto: UpdateTypePreferenceDto,
  ) {
    const all = await this.updateMyPreferences(user, { items: [{ type, ...dto }] });
    return all.find((p) => p.type === String(type)) ?? null;
  }

  /** NF-03: back to the default policy for one type. Security types are locked and cannot be reset. */
  async resetMyTypePreference(user: CurrentUserDto, type: NotificationType) {
    const userId = this.requireUserId(user);
    if (LOCKED_TYPES.has(String(type))) {
      throw new BadRequestException('security_notifications_are_locked');
    }
    const result = await this.prisma.notificationPreference.deleteMany({ where: { userId, type } });
    return { type, reset: true, hadCustomSettings: result.count > 0 };
  }

  /** NF-04: every preference and every quiet-hours window back to the defaults. */
  async resetAllMyPreferences(user: CurrentUserDto) {
    const userId = this.requireUserId(user);
    const result = await this.prisma.notificationPreference.deleteMany({
      where: { userId, type: { notIn: [...LOCKED_TYPES] as unknown as NotificationType[] } },
    });
    return { reset: true, removed: result.count };
  }

  /** NF-05: my push devices. Tokens are never returned, only the last 6 characters. */
  async listMyDevices(user: CurrentUserDto) {
    const devices = await this.prisma.deviceToken.findMany({
      where: { userId: this.requireUserId(user) },
      orderBy: { lastSeenAt: 'desc' },
    });
    return {
      count: devices.length,
      data: devices.map((d) => ({
        id: d.id,
        platform: d.platform,
        tokenSuffix: d.token.slice(-6),
        lastSeenAt: d.lastSeenAt,
        createdAt: d.createdAt,
      })),
    };
  }

  /** NF-06 */
  async unregisterAllMyDevices(user: CurrentUserDto) {
    const result = await this.prisma.deviceToken.deleteMany({
      where: { userId: this.requireUserId(user) },
    });
    return { removed: result.count };
  }

  /** NF-07 */
  async getMySnooze(user: CurrentUserDto) {
    const row = await this.prisma.notificationSnooze.findUnique({
      where: { userId: this.requireUserId(user) },
    });
    return this.snoozeView(row?.until ?? null);
  }

  /** NF-08: non-security notifications still reach the inbox but are not pushed, emailed or texted. */
  async setMySnooze(user: CurrentUserDto, dto: SnoozeDto) {
    const userId = this.requireUserId(user);
    const until = new Date(Date.now() + dto.hours * 60 * 60 * 1000);

    await this.prisma.notificationSnooze.upsert({
      where: { userId },
      create: { userId, until },
      update: { until },
    });
    return { ...this.snoozeView(until), stillDelivered: [...LOCKED_TYPES] };
  }

  /** NF-09 */
  async cancelMySnooze(user: CurrentUserDto) {
    const result = await this.prisma.notificationSnooze.deleteMany({
      where: { userId: this.requireUserId(user) },
    });
    return { active: false, cancelled: result.count > 0 };
  }

  /** NF-10: my own notifications as CSV. Capped at 50,000 rows. */
  async exportMyNotificationsCsv(user: CurrentUserDto) {
    const rows = await this.prisma.notification.findMany({
      where: this.activeWhere(this.requireUserId(user)),
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_EXPORT_ROWS + 1,
      select: {
        id: true,
        createdAt: true,
        type: true,
        priority: true,
        title: true,
        body: true,
        entity: true,
        entityId: true,
        readAt: true,
      },
    });

    const truncated = rows.length > MAX_EXPORT_ROWS;
    const data = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows;

    const header = [
      'id',
      'createdAt',
      'type',
      'priority',
      'title',
      'body',
      'entity',
      'entityId',
      'readAt',
    ];
    const lines = data.map((n) =>
      [n.id, n.createdAt, n.type, n.priority, n.title, n.body, n.entity, n.entityId, n.readAt]
        .map(csvCell)
        .join(','),
    );

    return {
      csv: CSV_BOM + [header.map(csvCell).join(','), ...lines].join('\r\n'),
      truncated,
      rowCount: data.length,
    };
  }

  /** NF-11: which channels reached me. Failure reasons and retry counts are internal and never shown. */
  async getMyNotificationDeliveries(id: string, user: CurrentUserDto) {
    const userId = this.requireUserId(user);
    await this.requireOwned(id, userId);

    const deliveries = await this.prisma.notificationDelivery.findMany({
      where: { notificationId: id, userId },
      orderBy: { createdAt: 'asc' },
      select: { channel: true, status: true, sentAt: true },
    });

    return {
      notificationId: id,
      inApp: { delivered: true },
      channels: deliveries.map((d) => ({
        channel: d.channel,
        status: this.friendlyDeliveryStatus(d.status),
        sentAt: d.sentAt,
      })),
    };
  }

  /** NF-12: only my own rows are touched. Ids that are not mine are ignored. */
  async markBulkAsUnread(ids: string[], user: CurrentUserDto) {
    const result = await this.prisma.notification.updateMany({
      where: { id: { in: ids }, userId: this.requireUserId(user), readAt: { not: null } },
      data: this.unreadPatch(),
    });
    this.publish([user.id]);
    return result;
  }

  /** NF-13 */
  async markAllOfTypeAsRead(type: NotificationType, user: CurrentUserDto) {
    const result = await this.prisma.notification.updateMany({
      where: { userId: this.requireUserId(user), type, readAt: null },
      data: this.readPatch(),
    });
    this.publish([user.id]);
    return result;
  }

  /** NF-14 */
  async deleteMyBulk(ids: string[], user: CurrentUserDto) {
    const result = await this.prisma.notification.deleteMany({
      where: { id: { in: ids }, userId: this.requireUserId(user) },
    });
    this.publish([user.id]);
    return { deleted: true, count: result.count };
  }

  /** NF-15 */
  async getMyUnreadCountByPriority(user: CurrentUserDto) {
    const groups = await this.prisma.notification.groupBy({
      by: ['priority'],
      where: this.activeWhere(this.requireUserId(user), { readAt: null }),
      _count: { _all: true },
    });

    const byPriority: Record<string, number> = {};
    for (const p of Object.values(NotificationPriority)) byPriority[p] = 0;
    let total = 0;
    for (const g of groups) {
      byPriority[g.priority] = g._count._all;
      total += g._count._all;
    }
    return { total, byPriority };
  }

  /** NF-16 */
  async getMyCounts(user: CurrentUserDto) {
    const userId = this.requireUserId(user);
    const [total, unread] = await Promise.all([
      this.prisma.notification.count({ where: this.activeWhere(userId) }),
      this.prisma.notification.count({ where: this.activeWhere(userId, { readAt: null }) }),
    ]);
    return { total, read: total - unread, unread };
  }

  /** NF-17 */
  async searchMyNotifications(user: CurrentUserDto, query: SearchNotificationsQueryDto) {
    const q = query.q.trim();
    const where = this.activeWhere(this.requireUserId(user), {
      OR: [
        { title: { contains: q, mode: 'insensitive' } },
        { body: { contains: q, mode: 'insensitive' } },
      ],
    });
    return this.paginateNotifications(where, query);
  }

  /** NF-18 */
  async getMyUnreadCountForEntity(user: CurrentUserDto, entity: string, entityId: string) {
    const count = await this.prisma.notification.count({
      where: this.activeWhere(this.requireUserId(user), { entity, entityId, readAt: null }),
    });
    return { entity, entityId, count };
  }

  /** NF-19: everything about one record, for example when its report is opened. */
  async markEntityAsRead(user: CurrentUserDto, entity: string, entityId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId: this.requireUserId(user), entity, entityId, readAt: null },
      data: this.readPatch(),
    });
    this.publish([user.id]);
    return result;
  }

  /** NF-20: updates about this record are no longer pushed, emailed or texted. Security types still are. */
  async muteEntity(user: CurrentUserDto, entity: string, entityId: string) {
    const userId = this.requireUserId(user);
    this.assertRecordRef(entity, entityId);

    const key = { userId_entity_entityId: { userId, entity, entityId } };
    const existing = await this.prisma.notificationEntityMute.findUnique({ where: key });
    if (!existing) {
      const count = await this.prisma.notificationEntityMute.count({ where: { userId } });
      if (count >= MAX_ENTITY_MUTES_PER_USER)
        throw new BadRequestException('too_many_muted_records');
    }

    await this.prisma.notificationEntityMute.upsert({
      where: key,
      create: { userId, entity, entityId },
      update: {},
    });
    return { entity, entityId, muted: true };
  }

  /** NF-21 */
  async unmuteEntity(user: CurrentUserDto, entity: string, entityId: string) {
    const result = await this.prisma.notificationEntityMute.deleteMany({
      where: { userId: this.requireUserId(user), entity, entityId },
    });
    return { entity, entityId, muted: false, wasMuted: result.count > 0 };
  }

  /** NF-22 */
  async listMyMutedRecords(user: CurrentUserDto, query: NotificationPagingDto) {
    const where = { userId: this.requireUserId(user) };
    const { page, limit } = this.pageParams(query);

    const [data, total] = await Promise.all([
      this.prisma.notificationEntityMute.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: { entity: true, entityId: true, createdAt: true },
      }),
      this.prisma.notificationEntityMute.count({ where }),
    ]);
    return { data, meta: this.offsetMeta(page, limit, total, data.length) };
  }

  // ───────────────────────────────────────────
  // 2. TEMPLATES AND BROADCASTS (admin)
  // ───────────────────────────────────────────

  /** NF-23 */
  async getTemplate(id: string) {
    const template = await this.prisma.notificationTemplate.findUnique({ where: { id } });
    if (!template) throw new NotFoundException('Template not found');
    return template;
  }

  /** NF-24: soft retire. Broadcasts refuse retired templates; nothing is deleted. */
  async retireTemplate(id: string, actor: CurrentUserDto) {
    const before = await this.getTemplate(id);
    if (!before.isActive) return before;

    const after = await this.prisma.notificationTemplate.update({
      where: { id },
      data: { isActive: false, retiredAt: new Date(), retiredById: this.requireUserId(actor) },
    });

    await this.audit(actor, {
      action: AuditEventEnum.NOTIFICATION_TEMPLATE_RETIRED,
      entity: 'NotificationTemplate',
      entityId: id,
      entityLabel: `${after.type}/${after.language}`,
      diff: { before: { isActive: true }, after: { isActive: false } },
    });
    return after;
  }

  /** NF-25 */
  async activateTemplate(id: string, actor: CurrentUserDto) {
    const before = await this.getTemplate(id);
    if (before.isActive) return before;

    const after = await this.prisma.notificationTemplate.update({
      where: { id },
      data: { isActive: true, retiredAt: null, retiredById: null },
    });

    await this.audit(actor, {
      action: AuditEventEnum.NOTIFICATION_TEMPLATE_ACTIVATED,
      entity: 'NotificationTemplate',
      entityId: id,
      entityLabel: `${after.type}/${after.language}`,
      diff: { before: { isActive: false }, after: { isActive: true } },
    });
    return after;
  }

  /**
   * NF-26: renders a saved template or loose text. Nothing is saved or sent.
   * Placeholders without a value show as <name>, so gaps are easy to see.
   */
  async previewTemplate(dto: PreviewTemplateDto) {
    const hasLoose = dto.title !== undefined || dto.body !== undefined;
    if (dto.templateId && hasLoose)
      throw new BadRequestException('use_either_templateId_or_title_body');
    if (!dto.templateId && (dto.title === undefined || dto.body === undefined)) {
      throw new BadRequestException('templateId_or_title_and_body_required');
    }

    let title = dto.title ?? '';
    let body = dto.body ?? '';
    let source: { templateId: string; type: string; language: string } | null = null;

    if (dto.templateId) {
      const template = await this.getTemplate(dto.templateId);
      title = template.title;
      body = template.body;
      source = {
        templateId: template.id,
        type: String(template.type),
        language: template.language,
      };
    }

    const vars = this.cleanVariables(dto.variables);
    const placeholders = this.extractPlaceholders(`${title}\n${body}`);
    const sample: Record<string, string> = {};
    for (const key of placeholders) sample[key] = vars[key] ?? `<${key}>`;

    const renderedTitle = this.render(title, sample);
    const renderedBody = this.render(body, sample);

    return {
      source,
      title: renderedTitle,
      body: renderedBody,
      placeholders,
      missingVariables: placeholders.filter((k) => vars[k] === undefined),
      titleTooLong: renderedTitle.length > 200,
      bodyTooLong: renderedBody.length > 2000,
      // What push, email and SMS carry for people who turned discreet mode on.
      discreetPreview: { title: DISCREET_TITLE, body: DISCREET_BODY },
    };
  }

  /** NF-27: which types have a template in each language, and which are missing. */
  async getTemplateCoverage() {
    const templates = await this.prisma.notificationTemplate.findMany({
      select: { id: true, type: true, language: true, isActive: true },
    });
    const byKey = new Map(templates.map((t) => [`${t.type}:${t.language}`, t]));

    return (Object.values(NotificationType) as string[]).map((type) => {
      const languages: Record<string, { templateId: string; active: boolean } | null> = {};
      const missingLanguages: string[] = [];

      for (const language of NOTIFICATION_LANGUAGES) {
        const t = byKey.get(`${type}:${language}`);
        languages[language] = t ? { templateId: t.id, active: t.isActive } : null;
        if (!t || !t.isActive) missingLanguages.push(language);
      }
      return { type, languages, missingLanguages };
    });
  }

  /**
   * NF-28: requeue a broadcast that failed or partly failed.
   *  - FAILED or STOPPED: the fan-out runs again. Rows already created are skipped by dedupeKey.
   *  - Any finished broadcast: FAILED deliveries (and deliveries cancelled by a stop) go back in the queue.
   */
  async retryBroadcast(id: string, user: CurrentUserDto) {
    const broadcast = await this.findOwnedBroadcast(id, user);
    const retryable: string[] = [
      BROADCAST_STATUS.FAILED,
      BROADCAST_STATUS.STOPPED,
      BROADCAST_STATUS.COMPLETED,
    ];
    if (!retryable.includes(broadcast.status)) {
      throw new ConflictException('broadcast_not_in_a_retryable_state');
    }

    let fanOutRequeued = false;
    if (
      broadcast.status === BROADCAST_STATUS.FAILED ||
      broadcast.status === BROADCAST_STATUS.STOPPED
    ) {
      const claimed = await this.prisma.notificationBroadcast.updateMany({
        where: { id, status: { in: [BROADCAST_STATUS.FAILED, BROADCAST_STATUS.STOPPED] } },
        data: {
          status: BROADCAST_STATUS.SCHEDULED,
          attempts: 0,
          error: null,
          finishedAt: null,
          stopRequestedAt: null,
          stopRequestedById: null,
          stoppedAt: null,
          scheduledAt: new Date(),
        },
      });
      fanOutRequeued = claimed.count > 0;
    }

    const requeued = await this.prisma.notificationDelivery.updateMany({
      where: {
        notification: { broadcastId: id },
        OR: [{ status: STATUS.FAILED }, { status: STATUS.SKIPPED, lastError: 'broadcast_stopped' }],
      },
      data: { status: STATUS.PENDING, attempts: 0, nextAttemptAt: new Date(), lastError: null },
    });

    if (!fanOutRequeued && requeued.count === 0) throw new ConflictException('nothing_to_retry');

    await this.audit(user, {
      action: AuditEventEnum.NOTIFICATION_BROADCAST_RETRIED,
      entity: 'NotificationBroadcast',
      entityId: id,
      entityLabel: broadcast.title,
      severity: AuditSeverity.WARNING,
      metadata: {
        fanOutRequeued,
        deliveriesRequeued: requeued.count,
        previousStatus: broadcast.status,
      },
    });

    if (fanOutRequeued) {
      void this.runBroadcast(id).catch((err) =>
        this.logger.error(`Broadcast ${id} restart failed: ${this.safeError(err)}`),
      );
    }

    return { id, fanOutRequeued, deliveriesRequeued: requeued.count };
  }

  /**
   * NF-29: edit a broadcast before it starts. Changing the content of a broadcast
   * that was already approved sends it back for approval, so nobody can swap the
   * text after the second person has signed off.
   */
  async updateBroadcast(id: string, dto: UpdateBroadcastDto, user: CurrentUserDto) {
    const before = await this.findOwnedBroadcast(id, user);
    const editable: string[] = [BROADCAST_STATUS.SCHEDULED, BROADCAST_STATUS.AWAITING_APPROVAL];
    if (!editable.includes(before.status)) {
      throw new ConflictException('broadcast_already_started_or_finished');
    }

    const changes: Prisma.NotificationBroadcastUpdateManyMutationInput = {};
    if (dto.type !== undefined) changes.type = dto.type;
    if (dto.title !== undefined) changes.title = dto.title.trim();
    if (dto.body !== undefined) changes.body = dto.body.trim();
    if (dto.priority !== undefined) changes.priority = dto.priority;
    if (dto.scheduledAt !== undefined) changes.scheduledAt = this.parseScheduledAt(dto.scheduledAt);
    if (Object.keys(changes).length === 0) throw new BadRequestException('nothing_to_update');

    const contentChanged =
      dto.type !== undefined ||
      dto.title !== undefined ||
      dto.body !== undefined ||
      dto.priority !== undefined;
    const textChanged = dto.type !== undefined || dto.title !== undefined || dto.body !== undefined;

    const data: Prisma.NotificationBroadcastUncheckedUpdateManyInput = {
      ...changes,
      // The text no longer comes from the template.
      ...(textChanged && before.templateId && { templateId: null }),
      ...(contentChanged &&
        before.approvedAt && {
          status: BROADCAST_STATUS.AWAITING_APPROVAL,
          requiresApproval: true,
          approvedById: null,
          approvedAt: null,
        }),
    };

    const result = await this.prisma.notificationBroadcast.updateMany({
      where: { id, status: { in: editable } },
      data,
    });
    if (result.count === 0) throw new ConflictException('broadcast_already_started_or_finished');

    const after = await this.prisma.notificationBroadcast.findUniqueOrThrow({ where: { id } });
    const keys = Object.keys(changes) as Array<keyof typeof before>;
    await this.audit(user, {
      action: AuditEventEnum.NOTIFICATION_BROADCAST_UPDATED,
      entity: 'NotificationBroadcast',
      entityId: id,
      entityLabel: after.title,
      diff: {
        before: Object.fromEntries(keys.map((k) => [k, before[k]])),
        after: Object.fromEntries(keys.map((k) => [k, after[k]])),
      },
      metadata: { sentBackForApproval: before.status !== after.status },
    });

    return after;
  }

  /** NF-30: who a broadcast reached, with delivery and read state. No provider errors are shown. */
  async getBroadcastRecipients(
    id: string,
    user: CurrentUserDto,
    query: BroadcastRecipientsQueryDto,
  ) {
    await this.findOwnedBroadcast(id, user);

    const where: Prisma.NotificationWhereInput = {
      broadcastId: id,
      ...(query.isRead !== undefined && { readAt: query.isRead ? { not: null } : null }),
    };
    const result = await this.paginateNotifications(where, query, true);

    const notificationIds = result.data.map((n) => n.id);
    const [deliveries, names] = await Promise.all([
      notificationIds.length
        ? this.prisma.notificationDelivery.findMany({
            where: { notificationId: { in: notificationIds } },
            select: { notificationId: true, channel: true, status: true, sentAt: true },
          })
        : Promise.resolve([]),
      this.namesFor(result.data.map((n) => n.userId)),
    ]);

    const byNotification = new Map<
      string,
      Array<{ channel: string; status: string; sentAt: Date | null }>
    >();
    for (const d of deliveries) {
      const list = byNotification.get(d.notificationId) ?? [];
      list.push({ channel: d.channel, status: d.status, sentAt: d.sentAt });
      byNotification.set(d.notificationId, list);
    }

    return {
      ...result,
      data: result.data.map((n) => ({
        notificationId: n.id,
        userId: n.userId,
        recipientName: names.get(n.userId) ?? null,
        createdAt: n.createdAt,
        isRead: n.readAt !== null,
        readAt: n.readAt,
        deliveries: byNotification.get(n.id) ?? [],
      })),
    };
  }

  /** NF-31: a second person approves a large broadcast. The person who wrote it cannot. */
  async approveBroadcast(id: string, actor: CurrentUserDto) {
    const actorId = this.requireUserId(actor);
    const broadcast = await this.prisma.notificationBroadcast.findUnique({ where: { id } });
    if (!broadcast) throw new NotFoundException('Broadcast not found');

    if (broadcast.status !== BROADCAST_STATUS.AWAITING_APPROVAL) {
      throw new ConflictException('broadcast_not_awaiting_approval');
    }
    if (broadcast.createdById === actorId) {
      throw new ForbiddenException('creator_cannot_approve_own_broadcast');
    }

    const result = await this.prisma.notificationBroadcast.updateMany({
      where: { id, status: BROADCAST_STATUS.AWAITING_APPROVAL },
      data: { status: BROADCAST_STATUS.SCHEDULED, approvedById: actorId, approvedAt: new Date() },
    });
    if (result.count === 0) throw new ConflictException('broadcast_not_awaiting_approval');

    await this.audit(actor, {
      action: AuditEventEnum.NOTIFICATION_BROADCAST_APPROVED,
      entity: 'NotificationBroadcast',
      entityId: id,
      entityLabel: broadcast.title,
      severity: broadcast.audience === 'ALL_USERS' ? AuditSeverity.WARNING : AuditSeverity.INFO,
      metadata: { audience: broadcast.audience, createdById: broadcast.createdById },
    });

    void this.notifyBroadcastDecision(broadcast.createdById, id, broadcast.title, 'APPROVED');

    if (broadcast.scheduledAt.getTime() <= Date.now() + 5_000) {
      void this.runBroadcast(id).catch((err) =>
        this.logger.error(`Broadcast ${id} start failed: ${this.safeError(err)}`),
      );
    }

    return {
      id,
      status: BROADCAST_STATUS.SCHEDULED,
      approvedById: actorId,
      scheduledAt: broadcast.scheduledAt,
    };
  }

  /** NF-32 */
  async rejectBroadcast(id: string, dto: RejectBroadcastDto, actor: CurrentUserDto) {
    const actorId = this.requireUserId(actor);
    const broadcast = await this.prisma.notificationBroadcast.findUnique({ where: { id } });
    if (!broadcast) throw new NotFoundException('Broadcast not found');

    const now = new Date();
    const result = await this.prisma.notificationBroadcast.updateMany({
      where: { id, status: BROADCAST_STATUS.AWAITING_APPROVAL },
      data: {
        status: BROADCAST_STATUS.REJECTED,
        rejectedById: actorId,
        rejectedAt: now,
        rejectionReason: dto.reason.trim(),
        finishedAt: now,
      },
    });
    if (result.count === 0) throw new ConflictException('broadcast_not_awaiting_approval');

    await this.audit(actor, {
      action: AuditEventEnum.NOTIFICATION_BROADCAST_REJECTED,
      entity: 'NotificationBroadcast',
      entityId: id,
      entityLabel: broadcast.title,
      severity: AuditSeverity.WARNING,
      metadata: { reason: dto.reason.trim(), createdById: broadcast.createdById },
    });

    void this.notifyBroadcastDecision(broadcast.createdById, id, broadcast.title, 'REJECTED');

    return { id, status: BROADCAST_STATUS.REJECTED };
  }

  /**
   * NF-33: halts a broadcast that is already sending. Cancel only works before it starts.
   * Deliveries still waiting are put on hold; ones already handed to a provider cannot be recalled.
   * People who already got their inbox copy keep it.
   */
  async stopBroadcast(id: string, user: CurrentUserDto) {
    const broadcast = await this.findOwnedBroadcast(id, user);
    if (broadcast.status !== BROADCAST_STATUS.PROCESSING) {
      throw new ConflictException('broadcast_not_sending');
    }

    const now = new Date();
    await this.prisma.notificationBroadcast.update({
      where: { id },
      data: { stopRequestedAt: now, stopRequestedById: this.requireUserId(user) },
    });

    const onHold = await this.prisma.notificationDelivery.updateMany({
      where: { status: STATUS.PENDING, notification: { broadcastId: id } },
      data: { status: STATUS.SKIPPED, lastError: 'broadcast_stopped' },
    });

    // The worker normally notices within one batch. If it died, close the broadcast right away.
    const workerGone = broadcast.updatedAt.getTime() < now.getTime() - STALE_CLAIM_MS;
    if (workerGone) {
      await this.prisma.notificationBroadcast.update({
        where: { id },
        data: { status: BROADCAST_STATUS.STOPPED, stoppedAt: now, finishedAt: now },
      });
    }

    await this.audit(user, {
      action: AuditEventEnum.NOTIFICATION_BROADCAST_STOPPED,
      entity: 'NotificationBroadcast',
      entityId: id,
      entityLabel: broadcast.title,
      severity: AuditSeverity.WARNING,
      metadata: { pendingDeliveriesOnHold: onHold.count, workerGone },
    });

    return {
      id,
      status: workerGone ? BROADCAST_STATUS.STOPPED : BROADCAST_STATUS.PROCESSING,
      stopping: !workerGone,
      pendingDeliveriesOnHold: onHold.count,
    };
  }

  /**
   * NF-34: sends the caller a test on one channel. Goes through the same send path
   * as a real notification, so discreet mode applies: if it is on, push, email and
   * SMS carry the generic text only.
   */
  async sendTestToSelf(dto: SendTestNotificationDto, actor: CurrentUserDto) {
    const userId = this.requireUserId(actor);
    const channel = dto.channel;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        email: true,
        phone: true,
        isEmailVerified: true,
        isPhoneVerified: true,
        discreetModeEnabled: true,
      },
    });
    if (!user) throw new NotFoundException('User not found');

    if (channel !== 'IN_APP') {
      if (!this.providers.has(channel)) throw new BadRequestException('channel_not_configured');
      if ((await this.pausedChannels()).includes(channel)) {
        throw new ConflictException('channel_is_paused');
      }
      if (channel === 'EMAIL') {
        if (!user.email || !user.isEmailVerified)
          throw new BadRequestException('email_not_verified');
        if (await this.isBounced('EMAIL', user.email))
          throw new BadRequestException('address_bounced');
      } else if (channel === 'SMS') {
        if (!user.phone || !user.isPhoneVerified)
          throw new BadRequestException('phone_not_verified');
        if (await this.isBounced('SMS', user.phone))
          throw new BadRequestException('address_bounced');
      } else {
        const devices = await this.prisma.deviceToken.count({ where: { userId } });
        if (devices === 0) throw new BadRequestException('no_device_registered');
      }
    }

    const snapshot = await this.resolveActor(userId);
    const notification = await this.prisma.notification.create({
      data: this.toCreateData({
        userId,
        type: NotificationType.GENERAL,
        title: 'Test notification',
        body: 'This is a test. If you can read it, this channel works.',
        priority: NotificationPriority.NORMAL,
        actorId: userId,
        ...snapshot,
        data: { test: true },
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      }),
    });

    let deliveryId: string | null = null;
    if (channel !== 'IN_APP') {
      const delivery = await this.prisma.notificationDelivery.create({
        data: {
          notificationId: notification.id,
          userId,
          channel,
          status: STATUS.PENDING,
          nextAttemptAt: new Date(),
        },
      });
      deliveryId = delivery.id;
    }
    this.publish([userId]);

    await this.audit(actor, {
      action: AuditEventEnum.NOTIFICATION_TEST_SENT,
      entity: 'Notification',
      entityId: notification.id,
      metadata: { channel },
    });

    return {
      notificationId: notification.id,
      channel,
      deliveryId,
      discreetModeOn: Boolean(user.discreetModeEnabled),
    };
  }

  // ───────────────────────────────────────────
  // 3. DELIVERY AND BOUNCES (admin)
  // ───────────────────────────────────────────

  /** NF-35: retry every FAILED delivery that matches the filter, up to a safety cap per call. */
  async retryAllFailedDeliveries(dto: RetryAllFailedDeliveriesDto, actor: CurrentUserDto) {
    const limit = Math.min(dto.limit ?? 5000, MAX_RETRY_ALL);
    const notification: Prisma.NotificationWhereInput = {
      ...(dto.type && { type: dto.type }),
      ...(dto.broadcastId && { broadcastId: dto.broadcastId }),
    };

    const where: Prisma.NotificationDeliveryWhereInput = {
      status: STATUS.FAILED,
      ...(dto.channel && { channel: dto.channel }),
      ...(dto.userId && { userId: dto.userId }),
      ...((dto.from || dto.to) && {
        updatedAt: {
          ...(dto.from && { gte: new Date(dto.from) }),
          ...(dto.to && { lte: new Date(dto.to) }),
        },
      }),
      ...(Object.keys(notification).length > 0 && { notification }),
    };

    const matched = await this.prisma.notificationDelivery.count({ where });
    const rows = await this.prisma.notificationDelivery.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      select: { id: true },
    });

    const result = rows.length
      ? await this.prisma.notificationDelivery.updateMany({
          where: { id: { in: rows.map((r) => r.id) }, status: STATUS.FAILED },
          data: { status: STATUS.PENDING, attempts: 0, nextAttemptAt: new Date(), lastError: null },
        })
      : { count: 0 };

    await this.audit(actor, {
      action: AuditEventEnum.NOTIFICATION_DELIVERIES_RETRIED,
      entity: 'NotificationDelivery',
      entityLabel: `${result.count} of ${matched} requeued`,
      metadata: {
        mode: 'filter',
        filter: { ...dto, limit: undefined },
        matched,
        requeued: result.count,
      },
    });

    return { matched, requeued: result.count, capped: matched > limit };
  }

  /** NF-36 */
  async listDeliveries(query: DeliveriesQueryDto) {
    const where = this.deliveriesWhere(query);
    const { page, limit } = this.pageParams(query);

    const [rows, total] = await Promise.all([
      this.prisma.notificationDelivery.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          notification: {
            select: {
              id: true,
              type: true,
              priority: true,
              entity: true,
              entityId: true,
              broadcastId: true,
            },
          },
        },
      }),
      this.prisma.notificationDelivery.count({ where }),
    ]);

    const names = await this.namesFor(rows.map((r) => r.userId));
    return {
      data: rows.map((r) => ({ ...r, userName: names.get(r.userId) ?? null })),
      meta: this.offsetMeta(page, limit, total, rows.length),
    };
  }

  /** NF-37: one delivery. lastError is the provider's answer after contact details were stripped. */
  async getDelivery(id: string) {
    const delivery = await this.prisma.notificationDelivery.findUnique({
      where: { id },
      include: {
        notification: {
          select: {
            id: true,
            type: true,
            priority: true,
            entity: true,
            entityId: true,
            broadcastId: true,
            createdAt: true,
          },
        },
      },
    });
    if (!delivery) throw new NotFoundException('Delivery not found');

    const names = await this.namesFor([delivery.userId]);
    return {
      ...delivery,
      userName: names.get(delivery.userId) ?? null,
      providerResponse: delivery.lastError,
    };
  }

  /** NF-38: sent, failed and skipped over time. */
  async getDeliveryTimeline(query: DeliveryTimelineQueryDto) {
    const { from, to } = this.statsRange(query);
    const bucket = query.bucket ?? 'day';
    const unit = Prisma.raw(bucket === 'hour' ? `'hour'` : `'day'`);
    const channelSql = query.channel ? Prisma.sql`AND channel = ${query.channel}` : Prisma.empty;

    const rows = await this.prisma.$queryRaw<{ bucket: Date; status: string; count: bigint }[]>`
      SELECT date_trunc(${unit}, "updatedAt") AS bucket, status, COUNT(*)::bigint AS count
      FROM notification_delivery
      WHERE "updatedAt" >= ${from} AND "updatedAt" <= ${to}
        AND status IN ('SENT', 'FAILED', 'SKIPPED')
        ${channelSql}
      GROUP BY 1, 2
      ORDER BY 1 ASC`;

    const byBucket = new Map<
      string,
      { bucket: string; sent: number; failed: number; skipped: number }
    >();
    for (const r of rows) {
      const key = r.bucket.toISOString();
      const entry = byBucket.get(key) ?? { bucket: key, sent: 0, failed: 0, skipped: 0 };
      const n = Number(r.count);
      if (r.status === STATUS.SENT) entry.sent += n;
      else if (r.status === STATUS.FAILED) entry.failed += n;
      else entry.skipped += n;
      byBucket.set(key, entry);
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
      channel: query.channel ?? null,
      data: [...byBucket.values()],
    };
  }

  /** NF-39: per type: notifications sent, outside deliveries that worked and failed, and how many were read. */
  async getStatsByType(query: StatsRangeQueryDto) {
    const { from, to } = this.statsRange(query);
    const range = { createdAt: { gte: from, lte: to } };

    const [totals, reads, deliveries] = await Promise.all([
      this.prisma.notification.groupBy({ by: ['type'], where: range, _count: { _all: true } }),
      this.prisma.notification.groupBy({
        by: ['type'],
        where: { ...range, readAt: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ type: string; status: string; count: bigint }[]>`
        SELECT n."type"::text AS type, d.status AS status, COUNT(*)::bigint AS count
        FROM notification_delivery d
        JOIN notification n ON n.id = d."notificationId"
        WHERE n."createdAt" >= ${from} AND n."createdAt" <= ${to}
        GROUP BY 1, 2`,
    ]);

    const readByType = new Map(reads.map((g) => [String(g.type), g._count._all]));
    const outside = new Map<
      string,
      { delivered: number; failed: number; pending: number; skipped: number }
    >();
    for (const d of deliveries) {
      const e = outside.get(d.type) ?? { delivered: 0, failed: 0, pending: 0, skipped: 0 };
      const n = Number(d.count);
      if (d.status === STATUS.SENT) e.delivered += n;
      else if (d.status === STATUS.FAILED) e.failed += n;
      else if (d.status === STATUS.SKIPPED) e.skipped += n;
      else e.pending += n;
      outside.set(d.type, e);
    }

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      data: totals
        .map((g) => {
          const type = String(g.type);
          const sent = g._count._all;
          const read = readByType.get(type) ?? 0;
          const o = outside.get(type) ?? { delivered: 0, failed: 0, pending: 0, skipped: 0 };
          return {
            type,
            sent,
            read,
            unread: sent - read,
            readRate: sent > 0 ? Number((read / sent).toFixed(4)) : null,
            outside: o,
          };
        })
        .sort((a, b) => b.sent - a.sent),
    };
  }

  /** NF-40: bounced or blocked addresses. Addresses are always masked. */
  async listBounces(query: BouncesQueryDto) {
    const where: Prisma.NotificationBounceWhereInput = {
      status: query.status ?? 'ACTIVE',
      ...(query.channel && { channel: query.channel }),
    };
    const { page, limit } = this.pageParams(query);

    const [rows, total] = await Promise.all([
      this.prisma.notificationBounce.findMany({
        where,
        orderBy: [{ lastBouncedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notificationBounce.count({ where }),
    ]);

    const names = await this.namesFor(rows.map((r) => r.userId).filter((u): u is string => !!u));
    return {
      data: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        address: this.maskAddress(r.channel, r.address),
        userId: r.userId,
        userName: r.userId ? (names.get(r.userId) ?? null) : null,
        reason: r.reason,
        providerCode: r.providerCode,
        status: r.status,
        bounceCount: r.bounceCount,
        firstBouncedAt: r.firstBouncedAt,
        lastBouncedAt: r.lastBouncedAt,
        clearedAt: r.clearedAt,
      })),
      meta: this.offsetMeta(page, limit, total, rows.length),
    };
  }

  /** NF-41: lets sending to this address resume, after the user fixed their contact details. */
  async clearBounce(id: string, dto: ClearBounceDto, actor: CurrentUserDto) {
    const bounce = await this.prisma.notificationBounce.findUnique({ where: { id } });
    if (!bounce) throw new NotFoundException('Bounce not found');
    if (bounce.status !== 'ACTIVE') throw new ConflictException('bounce_already_cleared');

    const cleared = await this.prisma.notificationBounce.update({
      where: { id },
      data: {
        status: 'CLEARED',
        clearedAt: new Date(),
        clearedById: this.requireUserId(actor),
        clearNote: dto.note?.trim() || null,
      },
    });

    await this.audit(actor, {
      action: AuditEventEnum.NOTIFICATION_BOUNCE_CLEARED,
      entity: 'NotificationBounce',
      entityId: id,
      entityLabel: `${bounce.channel} ${this.maskAddress(bounce.channel, bounce.address)}`,
      metadata: { note: dto.note?.trim() ?? null, bounceCount: bounce.bounceCount },
    });

    return { id: cleared.id, status: cleared.status, clearedAt: cleared.clearedAt };
  }

  /**
   * For the bounce webhooks (WH-03, WH-04) to call when a provider reports a hard
   * bounce or a block. From then on, sends to that address are skipped until an
   * admin clears it (NF-41).
   */
  async recordBounce(input: {
    channel: 'EMAIL' | 'SMS';
    address: string;
    reason: string;
    providerCode?: string | null;
    userId?: string | null;
  }) {
    const address = this.normalizeAddress(input.channel, input.address);
    if (!address) throw new BadRequestException('invalid_address');
    const reason = this.safeError(input.reason);

    let userId = input.userId ?? null;
    if (!userId && input.channel === 'EMAIL') {
      const match = await this.prisma.user.findFirst({
        where: { email: { equals: address, mode: 'insensitive' } },
        select: { id: true },
      });
      userId = match?.id ?? null;
    }

    const now = new Date();
    const bounce = await this.prisma.notificationBounce.upsert({
      where: { channel_address: { channel: input.channel, address } },
      create: {
        channel: input.channel,
        address,
        userId,
        reason,
        providerCode: input.providerCode ?? null,
        firstBouncedAt: now,
        lastBouncedAt: now,
      },
      update: {
        bounceCount: { increment: 1 },
        lastBouncedAt: now,
        reason,
        providerCode: input.providerCode ?? null,
        status: 'ACTIVE',
        clearedAt: null,
        clearedById: null,
        clearNote: null,
        ...(userId && { userId }),
      },
    });
    return { id: bounce.id };
  }

  // ───────────────────────────────────────────
  // 4. PER-USER SUPPORT (admin)
  // ───────────────────────────────────────────

  /** NF-42: for a compromised account. Their push tokens stop working at once. */
  async revokeUserDevices(userId: string, dto: AdminReasonDto, admin: CurrentUserDto) {
    await this.requireUserExists(userId);

    const result = await this.prisma.deviceToken.deleteMany({ where: { userId } });

    await this.audit(
      admin,
      {
        action: AuditEventEnum.NOTIFICATION_DEVICES_REVOKED,
        entity: 'User',
        entityId: userId,
        severity: AuditSeverity.WARNING,
        metadata: { revoked: result.count, reason: dto.reason.trim() },
      },
      true,
    );

    return { userId, revoked: result.count };
  }

  /** NF-43: on a support request. Security types are locked and have nothing to reset. */
  async resetUserPreferences(userId: string, dto: AdminReasonDto, admin: CurrentUserDto) {
    await this.requireUserExists(userId);

    const result = await this.prisma.notificationPreference.deleteMany({
      where: { userId, type: { notIn: [...LOCKED_TYPES] as unknown as NotificationType[] } },
    });

    await this.audit(admin, {
      action: AuditEventEnum.NOTIFICATION_PREFERENCES_RESET_BY_ADMIN,
      entity: 'User',
      entityId: userId,
      metadata: { removed: result.count, reason: dto.reason.trim() },
    });

    return { userId, reset: true, removed: result.count };
  }

  /** NF-44 */
  async getUserDeliveries(userId: string, query: UserDeliveriesQueryDto) {
    await this.requireUserExists(userId);
    return this.listDeliveries({ ...query, userId });
  }

  // ───────────────────────────────────────────
  // 5. COMPANY-WIDE ANALYTICS (admin)
  // ───────────────────────────────────────────

  /** NF-50: one row per recipient. */
  async getAllByRecipient(query: ByRecipientQueryDto) {
    const conds: Prisma.Sql[] = [Prisma.sql`TRUE`];
    if (query.from) conds.push(Prisma.sql`n."createdAt" >= ${new Date(query.from)}`);
    if (query.to) conds.push(Prisma.sql`n."createdAt" <= ${new Date(query.to)}`);
    if (query.type) conds.push(Prisma.sql`n."type" = ${query.type}::"NotificationType"`);
    if (query.priority)
      conds.push(Prisma.sql`n."priority" = ${query.priority}::"NotificationPriority"`);
    if (query.entity) conds.push(Prisma.sql`n."entity" = ${query.entity}`);
    const whereSql = Prisma.join(conds, ' AND ');

    const order =
      query.sortBy === 'unread'
        ? Prisma.sql`unread DESC`
        : query.sortBy === 'last'
          ? Prisma.sql`"lastAt" DESC`
          : Prisma.sql`total DESC`;

    const { page, limit } = this.pageParams(query);
    const offset = (page - 1) * limit;

    const [rows, totalRows] = await Promise.all([
      this.prisma.$queryRaw<
        { userId: string; total: bigint; readCount: bigint; unread: bigint; lastAt: Date }[]
      >`
        SELECT n."userId" AS "userId",
               COUNT(*)::bigint AS total,
               COUNT(n."readAt")::bigint AS "readCount",
               (COUNT(*) - COUNT(n."readAt"))::bigint AS unread,
               MAX(n."createdAt") AS "lastAt"
        FROM notification n
        WHERE ${whereSql}
        GROUP BY n."userId"
        ORDER BY ${order}, n."userId" ASC
        LIMIT ${limit} OFFSET ${offset}`,
      this.prisma.$queryRaw<{ total: bigint }[]>`
        SELECT COUNT(DISTINCT n."userId")::bigint AS total FROM notification n WHERE ${whereSql}`,
    ]);

    const userIds = rows.map((r) => r.userId);
    const [names, failed] = await Promise.all([
      this.namesFor(userIds),
      userIds.length
        ? this.prisma.notificationDelivery.groupBy({
            by: ['userId'],
            where: {
              userId: { in: userIds },
              status: STATUS.FAILED,
              ...((query.from || query.to) && {
                createdAt: {
                  ...(query.from && { gte: new Date(query.from) }),
                  ...(query.to && { lte: new Date(query.to) }),
                },
              }),
            },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const failedByUser = new Map<string, number>(
      failed.map((f) => [f.userId, f._count._all] as [string, number]),
    );

    const total = Number(totalRows[0]?.total ?? 0);
    return {
      data: rows.map((r) => ({
        userId: r.userId,
        name: names.get(r.userId) ?? null,
        total: Number(r.total),
        read: Number(r.readCount),
        unread: Number(r.unread),
        failedDeliveries: failedByUser.get(r.userId) ?? 0,
        lastNotificationAt: r.lastAt,
      })),
      meta: this.offsetMeta(page, limit, total, rows.length),
    };
  }

  /** NF-51: notifications emitted per day, week or month. */
  async getAllTimeline(query: AllTimelineQueryDto) {
    const { from, to } = this.statsRange(query, 365);
    const bucket = query.bucket ?? 'day';
    const unit = Prisma.raw(
      `'${bucket === 'month' ? 'month' : bucket === 'week' ? 'week' : 'day'}'`,
    );

    const conds: Prisma.Sql[] = [
      Prisma.sql`"createdAt" >= ${from}`,
      Prisma.sql`"createdAt" <= ${to}`,
    ];
    if (query.type) conds.push(Prisma.sql`"type" = ${query.type}::"NotificationType"`);
    if (query.entity) conds.push(Prisma.sql`"entity" = ${query.entity}`);

    const rows = await this.prisma.$queryRaw<{ bucket: Date; total: bigint; readCount: bigint }[]>`
      SELECT date_trunc(${unit}, "createdAt") AS bucket,
             COUNT(*)::bigint AS total,
             COUNT("readAt")::bigint AS "readCount"
      FROM notification
      WHERE ${Prisma.join(conds, ' AND ')}
      GROUP BY 1
      ORDER BY 1 ASC`;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
      data: rows.map((r) => ({
        bucket: r.bucket.toISOString(),
        total: Number(r.total),
        read: Number(r.readCount),
      })),
    };
  }

  /** NF-52: read rate and median time to read, by type. */
  async getAllReadRate(query: StatsRangeQueryDto) {
    const { from, to } = this.statsRange(query);

    const rows = await this.prisma.$queryRaw<
      { type: string; total: bigint; readCount: bigint; medianSeconds: number | null }[]
    >`
      SELECT n."type"::text AS type,
             COUNT(*)::bigint AS total,
             COUNT(n."readAt")::bigint AS "readCount",
             percentile_cont(0.5) WITHIN GROUP (
               ORDER BY EXTRACT(EPOCH FROM (n."readAt" - n."createdAt"))
             ) FILTER (WHERE n."readAt" IS NOT NULL) AS "medianSeconds"
      FROM notification n
      WHERE n."createdAt" >= ${from} AND n."createdAt" <= ${to}
      GROUP BY 1
      ORDER BY total DESC`;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      data: rows.map((r) => {
        const total = Number(r.total);
        const read = Number(r.readCount);
        return {
          type: r.type,
          total,
          read,
          readRate: total > 0 ? Number((read / total).toFixed(4)) : null,
          medianSecondsToRead:
            r.medianSeconds === null ? null : Math.round(Number(r.medianSeconds)),
        };
      }),
    };
  }

  /** NF-53: free-text search across every notification. Same filters and shape as admin/all. */
  async searchAllNotifications(query: AllNotificationsQueryDto) {
    if (!query.q?.trim()) throw new BadRequestException('q_required');
    return this.getAllNotifications(query);
  }

  /** NF-54: background export beyond the 50,000-row CSV cap. */
  async startAllExportJob(dto: NotificationExportJobDto, admin: CurrentUserDto) {
    const requestedById = this.requireUserId(admin);
    const where = this.allWhere(dto as AllNotificationsQueryDto);
    const filter = { ...dto } as Record<string, unknown>;

    // Audited first and strictly: a data export must never start unlogged.
    await this.audit(
      admin,
      {
        action: AuditEventEnum.NOTIFICATION_EXPORT_JOB_CREATED,
        entity: 'Notification',
        severity: AuditSeverity.WARNING,
        metadata: { scope: 'all', filters: filter },
      },
      true,
    );

    const job = await this.exportJobsOrThrow().start({
      scope: EXPORT_SCOPE.NOTIFICATIONS,
      requestedById,
      filter,
      producer: {
        header: NOTIFICATION_EXPORT_HEADER,
        batches: () => this.notificationExportBatches(where),
      },
    });

    return { jobId: job.id, status: job.status };
  }

  /** NF-55 */
  async listAllExportJobs(admin: CurrentUserDto, query: NotificationPagingDto) {
    return this.exportJobsOrThrow().list(
      EXPORT_SCOPE.NOTIFICATIONS,
      this.requireUserId(admin),
      query,
    );
  }

  /** NF-56 */
  async getAllExportJob(id: string, admin: CurrentUserDto) {
    return this.exportJobsOrThrow().get(EXPORT_SCOPE.NOTIFICATIONS, id, this.requireUserId(admin));
  }

  /** NF-57: short-lived links, one per CSV part. Audited. */
  async getAllExportJobDownload(id: string, admin: CurrentUserDto) {
    const result = await this.exportJobsOrThrow().downloadLinks(
      EXPORT_SCOPE.NOTIFICATIONS,
      id,
      this.requireUserId(admin),
    );

    await this.audit(
      admin,
      {
        action: AuditEventEnum.NOTIFICATION_EXPORT_DOWNLOADED,
        entity: 'MiscExportJob',
        entityId: id,
        severity: AuditSeverity.WARNING,
        metadata: { rowCount: result.job.rowCount, parts: result.files.length },
      },
      true,
    );

    return result;
  }

  private async *notificationExportBatches(
    where: Prisma.NotificationWhereInput,
  ): AsyncGenerator<unknown[][]> {
    const size = 5_000;
    let cursor: string | undefined;

    for (;;) {
      const rows = await this.prisma.notification.findMany({
        where,
        orderBy: { id: 'asc' },
        take: size,
        ...(cursor && { cursor: { id: cursor }, skip: 1 }),
        select: {
          id: true,
          createdAt: true,
          type: true,
          priority: true,
          entity: true,
          entityId: true,
          userId: true,
          actorId: true,
          actorName: true,
          actorRole: true,
          title: true,
          readAt: true,
        },
      });
      if (rows.length === 0) return;

      yield rows.map((n) => [
        n.id,
        n.createdAt,
        n.type,
        n.priority,
        n.entity,
        n.entityId,
        n.userId,
        n.actorId,
        n.actorName,
        n.actorRole,
        n.title,
        n.readAt,
      ]);

      if (rows.length < size) return;
      cursor = rows[rows.length - 1].id;
    }
  }

  // ───────────────────────────────────────────
  // 6. GOVERNANCE AND QUEUE (super admin)
  // ───────────────────────────────────────────

  /** NF-58: runs the expired-notification cleanup now instead of waiting for the hourly pass. */
  async purgeExpiredNow(dto: AdminReasonDto, admin: CurrentUserDto) {
    const result = await this.deleteExpired();

    await this.audit(
      admin,
      {
        action: AuditEventEnum.NOTIFICATION_PURGE_EXPIRED_RUN,
        entity: 'Notification',
        severity: AuditSeverity.WARNING,
        metadata: { deleted: result.count, reason: dto.reason.trim() },
      },
      true,
    );

    return { deleted: result.count };
  }

  /** NF-59 */
  async getRetention() {
    const environmentDefault = Number(process.env.NOTIFICATION_READ_RETENTION_DAYS ?? 180);
    const row = await this.prisma.notificationSetting.findUnique({ where: { key: 'retention' } });
    const stored = (row?.value as { readRetentionDays?: unknown } | null)?.readRetentionDays;
    const fromDatabase = typeof stored === 'number' && stored >= 0;

    return {
      readRetentionDays: fromDatabase ? (stored as number) : environmentDefault,
      source: fromDatabase ? 'database' : 'environment',
      environmentDefault,
      expiredNotifications: 'removed once their expiry date passes',
      keepsReadForever: (fromDatabase ? (stored as number) : environmentDefault) === 0,
      updatedAt: row?.updatedAt ?? null,
      updatedById: row?.updatedById ?? null,
    };
  }

  /** NF-60: changes how long read notifications are kept. Audited, and the audit must succeed. */
  async updateRetention(dto: UpdateRetentionDto, admin: CurrentUserDto) {
    const before = await this.getRetention();

    await this.audit(
      admin,
      {
        action: AuditEventEnum.NOTIFICATION_RETENTION_CHANGED,
        entity: 'NotificationSetting',
        entityId: 'retention',
        severity: AuditSeverity.WARNING,
        diff: {
          before: { readRetentionDays: before.readRetentionDays },
          after: { readRetentionDays: dto.readRetentionDays },
        },
        metadata: { reason: dto.reason.trim() },
      },
      true,
    );

    await this.prisma.notificationSetting.upsert({
      where: { key: 'retention' },
      create: {
        key: 'retention',
        value: { readRetentionDays: dto.readRetentionDays },
        updatedById: this.requireUserId(admin),
      },
      update: {
        value: { readRetentionDays: dto.readRetentionDays },
        updatedById: this.requireUserId(admin),
      },
    });

    return this.getRetention();
  }

  /** NF-61: depth, rate and paused state per outside channel. */
  async getQueueState() {
    const now = new Date();
    const hourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);

    const [due, later, sending, sentLastHour, failedLastDay, states, oldest] = await Promise.all([
      this.prisma.notificationDelivery.groupBy({
        by: ['channel'],
        where: { status: STATUS.PENDING, nextAttemptAt: { lte: now } },
        _count: { _all: true },
      }),
      this.prisma.notificationDelivery.groupBy({
        by: ['channel'],
        where: { status: STATUS.PENDING, nextAttemptAt: { gt: now } },
        _count: { _all: true },
      }),
      this.prisma.notificationDelivery.groupBy({
        by: ['channel'],
        where: { status: STATUS.SENDING },
        _count: { _all: true },
      }),
      this.prisma.notificationDelivery.groupBy({
        by: ['channel'],
        where: { status: STATUS.SENT, sentAt: { gte: hourAgo } },
        _count: { _all: true },
      }),
      this.prisma.notificationDelivery.groupBy({
        by: ['channel'],
        where: { status: STATUS.FAILED, updatedAt: { gte: dayAgo } },
        _count: { _all: true },
      }),
      this.prisma.notificationQueueState.findMany(),
      Promise.all(
        OUTBOUND_CHANNELS.map((channel) =>
          this.prisma.notificationDelivery.findFirst({
            where: { channel, status: STATUS.PENDING, nextAttemptAt: { lte: now } },
            orderBy: { nextAttemptAt: 'asc' },
            select: { nextAttemptAt: true },
          }),
        ),
      ),
    ]);

    const count = (groups: Array<{ channel: string; _count: { _all: number } }>, channel: string) =>
      groups.find((g) => g.channel === channel)?._count._all ?? 0;
    const stateByChannel = new Map(states.map((s) => [s.channel, s]));

    return {
      worker: { enabled: this.timer !== null, lastTickAt: this.lastTickAt },
      channels: OUTBOUND_CHANNELS.map((channel, i) => {
        const state = stateByChannel.get(channel);
        const sent = count(sentLastHour, channel);
        return {
          channel,
          configured: this.providers.has(channel),
          paused: state?.paused ?? false,
          pausedReason: state?.paused ? state.reason : null,
          pausedAt: state?.paused ? state.pausedAt : null,
          pausedById: state?.paused ? state.pausedById : null,
          depth: {
            waitingNow: count(due, channel),
            scheduledLater: count(later, channel),
            sending: count(sending, channel),
          },
          oldestWaitingAt: oldest[i]?.nextAttemptAt ?? null,
          sentLastHour: sent,
          ratePerMinute: Number((sent / 60).toFixed(2)),
          failedLast24h: count(failedLastDay, channel),
        };
      }),
    };
  }

  /**
   * NF-62: stops sending on one channel during a provider outage. Waiting deliveries
   * stay queued. This includes security notifications on that channel: they still
   * reach the inbox.
   */
  async pauseQueueChannel(dto: QueuePauseDto, admin: CurrentUserDto) {
    const adminId = this.requireUserId(admin);
    const now = new Date();

    await this.audit(
      admin,
      {
        action: AuditEventEnum.NOTIFICATION_QUEUE_PAUSED,
        entity: 'NotificationQueueState',
        entityId: dto.channel,
        severity: AuditSeverity.CRITICAL,
        metadata: { channel: dto.channel, reason: dto.reason.trim() },
      },
      true,
    );

    const state = await this.prisma.notificationQueueState.upsert({
      where: { channel: dto.channel },
      create: {
        channel: dto.channel,
        paused: true,
        reason: dto.reason.trim(),
        pausedAt: now,
        pausedById: adminId,
      },
      update: {
        paused: true,
        reason: dto.reason.trim(),
        pausedAt: now,
        pausedById: adminId,
      },
    });
    return state;
  }

  /** NF-63 */
  async resumeQueueChannel(dto: QueueResumeDto, admin: CurrentUserDto) {
    const adminId = this.requireUserId(admin);

    await this.audit(
      admin,
      {
        action: AuditEventEnum.NOTIFICATION_QUEUE_RESUMED,
        entity: 'NotificationQueueState',
        entityId: dto.channel,
        severity: AuditSeverity.WARNING,
        metadata: { channel: dto.channel },
      },
      true,
    );

    return this.prisma.notificationQueueState.upsert({
      where: { channel: dto.channel },
      create: { channel: dto.channel, paused: false, resumedAt: new Date(), resumedById: adminId },
      update: { paused: false, resumedAt: new Date(), resumedById: adminId },
    });
  }

  // ───────────────────────────────────────────
  // AUDIT ALERTS → SUPER ADMIN INBOX
  // ───────────────────────────────────────────

  /**
   * AuditLogService cannot call this service directly (this one depends on it), so it
   * emits an event. Every active SUPER_ADMIN gets an inbox notice. SECURITY_ALERT is a
   * locked type, so it also goes out by push, email and SMS (generic text in discreet mode).
   */
  @OnEvent(AUDIT_ALERT_TRIGGERED_EVENT)
  async handleAuditAlertTriggered(event: AuditAlertTriggeredEvent): Promise<void> {
    try {
      const superAdmins = await this.prisma.user.findMany({
        where: {
          isActive: true,
          userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
        },
        select: { id: true },
      });
      if (superAdmins.length === 0) return;

      await this.createForUsers({
        userIds: superAdmins.map((u) => u.id),
        type: NotificationType.SECURITY_ALERT,
        title: event.title,
        body: event.body,
        priority: NotificationPriority.HIGH,
        entity: event.entity,
        entityId: event.entityId,
        data: { kind: event.kind },
        dedupeKeyFor: (userId) => `audit-alert:${event.entityId}:${event.occurrenceId}:${userId}`,
      });
    } catch (err) {
      this.logger.error(
        `Could not notify super admins about an audit alert: ${this.safeError(err)}`,
      );
    }
  }

  // ───────────────────────────────────────────
  // NEW: inbox notices for the new workflows
  // ───────────────────────────────────────────

  /** A background export finished or failed. Tells only the person who asked for it. No data in the text. */
  @OnEvent(NotificationEventEnum.EXPORT_JOB_FINISHED)
  async handleExportJobFinished(event: ExportJobFinishedEvent): Promise<void> {
    try {
      const done = event.status === 'COMPLETED';
      await this.createForUsers({
        userIds: [event.userId],
        type: NotificationType.GENERAL,
        title: done ? 'Your export is ready' : 'Your export failed',
        body: done
          ? 'Open your export jobs to download it. Download links are short-lived, so ask for a fresh one if it expires.'
          : 'The export did not finish. You can start it again from your export jobs.',
        priority: NotificationPriority.NORMAL,
        entity: 'MiscExportJob',
        entityId: event.jobId,
        data: { scope: event.scope, status: event.status },
        dedupeKeyFor: (userId) => `export-job:${event.jobId}:${event.status}:${userId}`,
      });
    } catch (err) {
      this.logger.error(`Could not notify about export ${event.jobId}: ${this.safeError(err)}`);
    }
  }

  /**
   * A large broadcast is waiting for a second person. Super Admins other than the creator are told.
   * (The approve route itself checks the NOTIFICATION_BROADCAST_APPROVE permission.)
   */
  private async notifyApprovers(
    broadcastId: string,
    title: string,
    audienceSize: number,
    creatorId: string,
  ) {
    try {
      const admins = await this.prisma.user.findMany({
        where: {
          isActive: true,
          id: { not: creatorId },
          userRoles: { some: { role: { name: RolesEnum.SUPER_ADMIN } } },
        },
        select: { id: true },
      });
      await this.createForUsers({
        userIds: admins.map((a) => a.id),
        type: NotificationType.GENERAL,
        title: 'A broadcast needs approval',
        body: `"${title.slice(0, 80)}" is waiting for a second approver (${audienceSize} recipients).`,
        priority: NotificationPriority.HIGH,
        entity: 'NotificationBroadcast',
        entityId: broadcastId,
        dedupeKeyFor: (userId) => `broadcast-approval:${broadcastId}:${userId}`,
      });
    } catch (err) {
      this.logger.error(
        `Could not notify approvers for broadcast ${broadcastId}: ${this.safeError(err)}`,
      );
    }
  }

  /** Tells the person who wrote a broadcast whether it was approved or rejected. */
  private async notifyBroadcastDecision(
    creatorId: string | null,
    broadcastId: string,
    title: string,
    decision: 'APPROVED' | 'REJECTED',
  ) {
    if (!creatorId) return;
    try {
      await this.createForUsers({
        userIds: [creatorId],
        type: NotificationType.GENERAL,
        title:
          decision === 'APPROVED' ? 'Your broadcast was approved' : 'Your broadcast was rejected',
        body:
          decision === 'APPROVED'
            ? `"${title.slice(0, 80)}" was approved and will be sent at its scheduled time.`
            : `"${title.slice(0, 80)}" was rejected. Open the broadcast to see the reason.`,
        priority: NotificationPriority.NORMAL,
        entity: 'NotificationBroadcast',
        entityId: broadcastId,
        dedupeKeyFor: (userId) => `broadcast-decision:${broadcastId}:${decision}:${userId}`,
      });
    } catch (err) {
      this.logger.error(
        `Could not notify creator of broadcast ${broadcastId}: ${this.safeError(err)}`,
      );
    }
  }

  // ───────────────────────────────────────────
  // NEW INTERNALS
  // ───────────────────────────────────────────

  private snoozeView(until: Date | null) {
    const active = !!until && until.getTime() > Date.now();
    return {
      active,
      until: active ? until : null,
      remainingSeconds: active ? Math.ceil((until.getTime() - Date.now()) / 1000) : 0,
    };
  }

  /** What a person sees: no retry counts, no provider errors. */
  private friendlyDeliveryStatus(status: string): 'SENT' | 'PENDING' | 'NOT_SENT' {
    if (status === STATUS.SENT) return 'SENT';
    if (status === STATUS.PENDING || status === STATUS.SENDING) return 'PENDING';
    return 'NOT_SENT';
  }

  private assertRecordRef(entity: string, entityId: string) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(entity))
      throw new BadRequestException('invalid_entity');
    if (!entityId || entityId.length > 100) throw new BadRequestException('invalid_entityId');
  }

  private extractPlaceholders(text: string): string[] {
    const found = new Set<string>();
    for (const m of text.matchAll(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g)) found.add(m[1]);
    return [...found];
  }

  private async requireUserExists(userId: string) {
    const exists = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('User not found');
  }

  private async namesFor(ids: string[]): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({
      where: { id: { in: unique } },
      select: { id: true, name: true },
    });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  /** Default window is 30 days. `maxDays` is 90 unless a route says otherwise. */
  private statsRange(query: { from?: string; to?: string }, maxDays = 90) {
    const to = query.to ? new Date(query.to) : new Date();
    const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * 86_400_000);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new BadRequestException('invalid_date');
    if (from >= to) throw new BadRequestException('from_must_be_before_to');
    if (to.getTime() - from.getTime() > maxDays * 86_400_000) {
      throw new BadRequestException(`range_too_large_max_${maxDays}_days`);
    }
    return { from, to };
  }

  private deliveriesWhere(query: DeliveriesQueryDto): Prisma.NotificationDeliveryWhereInput {
    return {
      ...(query.channel && { channel: query.channel }),
      ...(query.status && { status: query.status }),
      ...(query.userId && { userId: query.userId }),
      ...(query.notificationId && { notificationId: query.notificationId }),
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
    };
  }

  private normalizeAddress(channel: 'EMAIL' | 'SMS', value: string): string {
    return channel === 'EMAIL' ? value.trim().toLowerCase() : value.replace(/\D/g, '');
  }

  private maskAddress(channel: string, address: string): string {
    if (channel === 'EMAIL') {
      const [local, domain] = address.split('@');
      return domain ? `${local.slice(0, 1)}***@${domain}` : '[email]';
    }
    return `••••${address.replace(/\D/g, '').slice(-4)}`;
  }

  private async isBounced(channel: 'EMAIL' | 'SMS', address: string): Promise<boolean> {
    const row = await this.prisma.notificationBounce.findUnique({
      where: { channel_address: { channel, address: this.normalizeAddress(channel, address) } },
      select: { status: true },
    });
    return row?.status === 'ACTIVE';
  }

  /** Channels an admin has paused. Never throws: a missing table must not stop the worker. */
  private async pausedChannels(): Promise<string[]> {
    try {
      const rows = await this.prisma.notificationQueueState.findMany({
        where: { paused: true },
        select: { channel: true },
      });
      return rows.map((r) => r.channel);
    } catch (err) {
      this.logger.warn(`Could not read queue state: ${this.safeError(err)}`);
      return [];
    }
  }

  /** Retention an admin set (NF-60), else the environment value. */
  private async effectiveReadRetentionDays(): Promise<number> {
    const fromEnv = Number(process.env.NOTIFICATION_READ_RETENTION_DAYS ?? 180);
    try {
      const row = await this.prisma.notificationSetting.findUnique({ where: { key: 'retention' } });
      const stored = (row?.value as { readRetentionDays?: unknown } | null)?.readRetentionDays;
      if (typeof stored === 'number' && stored >= 0) return stored;
    } catch (err) {
      this.logger.warn(`Could not read retention setting: ${this.safeError(err)}`);
    }
    return fromEnv;
  }

  private exportJobsOrThrow(): ExportJobService {
    if (!this.exportJobs) throw new BadRequestException('export_jobs_not_configured');
    return this.exportJobs;
  }

  private async stopRequested(id: string): Promise<boolean> {
    const row = await this.prisma.notificationBroadcast.findUnique({
      where: { id },
      select: { stopRequestedAt: true },
    });
    return Boolean(row?.stopRequestedAt);
  }

  private async markStopped(id: string) {
    const now = new Date();
    const recipientCount = await this.prisma.notification.count({ where: { broadcastId: id } });
    await this.prisma.notificationBroadcast.update({
      where: { id },
      data: { status: BROADCAST_STATUS.STOPPED, stoppedAt: now, finishedAt: now, recipientCount },
    });
  }

  // ───────────────────────────────────────────
  // INTERNALS
  // ───────────────────────────────────────────

  /**
   * Retry-safe wrapper for the two admin send routes. The key is claimed first
   * (unique per actor): a repeat returns the stored result, a repeat while the
   * first call is still running gets 409. A failed run releases the key.
   */
  private async withIdempotency<T extends object>(
    actorId: string,
    rawKey: string | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    if (!rawKey) return run();

    const key = rawKey.trim();
    if (key.length === 0 || key.length > 200)
      throw new BadRequestException('invalid_idempotency_key');

    try {
      await this.prisma.notificationIdempotencyKey.create({ data: { actorId, key } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        const existing = await this.prisma.notificationIdempotencyKey.findUnique({
          where: { actorId_key: { actorId, key } },
        });
        if (existing?.result) return existing.result as unknown as T;
        throw new ConflictException('request_already_in_progress');
      }
      throw err;
    }

    try {
      const result = await run();
      await this.prisma.notificationIdempotencyKey.update({
        where: { actorId_key: { actorId, key } },
        data: { result: result },
      });
      return result;
    } catch (err) {
      await this.prisma.notificationIdempotencyKey
        .delete({ where: { actorId_key: { actorId, key } } })
        .catch(() => undefined);
      throw err;
    }
  }

  /** Name and top role of whoever caused a notification, stored on the row so it survives later changes. */
  private async resolveActor(
    userId: string,
  ): Promise<{ actorName: string | null; actorRole: string | null }> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { name: true, userRoles: { select: { role: { select: { name: true } } } } },
    });
    if (!user) return { actorName: null, actorRole: null };

    const roles = user.userRoles.map((ur) => ur.role.name);
    const actorRole = roles.includes('SUPER_ADMIN')
      ? 'SUPER_ADMIN'
      : roles.includes('ADMIN')
        ? 'ADMIN'
        : (roles[0] ?? null);

    return { actorName: user.name ?? null, actorRole };
  }

  private async actorSnapshot(input: {
    actorId?: string | null;
    actorName?: string | null;
    actorRole?: string | null;
  }): Promise<{ actorName?: string | null; actorRole?: string | null }> {
    if (!input.actorId || input.actorName !== undefined) return {};
    return this.resolveActor(input.actorId);
  }

  /**
   * Notification audit entries go through AuditLogService. `strict` makes a
   * failed audit write fail the call (data-subject actions must never go
   * unlogged); otherwise the failure is logged loudly and the call continues.
   * AuditLogService.record() already counts failures for its health endpoint.
   */
  private async audit(
    actor: CurrentUserDto | null,
    p: {
      action: AuditEventEnum;
      entity: string;
      entityId?: string;
      entityLabel?: string;
      severity?: AuditSeverity;
      outcome?: AuditOutcome;
      diff?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
    strict = false,
  ): Promise<void> {
    try {
      await this.auditLog.record({
        userId: actor?.id ?? null,
        actorType: actor
          ? this.isSuperAdmin(actor)
            ? ActorType.SUPER_ADMIN
            : ActorType.ADMIN
          : ActorType.SYSTEM,
        action: p.action,
        entity: p.entity,
        entityId: p.entityId,
        entityLabel: p.entityLabel,
        severity: p.severity,
        outcome: p.outcome,
        diff: p.diff,
        metadata: p.metadata,
      });
    } catch (err) {
      this.logger.error(
        `AUDIT FOR NOTIFICATION ACTION FAILED ${String(p.action)}: ${this.safeError(err)}`,
      );
      if (strict) throw err;
    }
  }

  private isSuperAdmin(user: CurrentUserDto): boolean {
    return user.roles.includes(RolesEnum.SUPER_ADMIN);
  }

  private requireUserId(user: CurrentUserDto): string {
    if (!user.id) throw new ForbiddenException('authenticated_user_required');
    return user.id;
  }

  private assertTimezone(timeZone: string) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
      throw new BadRequestException('invalid_timezone');
    }
  }

  private async requireOwned(id: string, userId: string) {
    const owned = await this.prisma.notification.findFirst({
      where: { id, userId },
      select: { id: true },
    });
    if (!owned) throw new NotFoundException('Notification not found');
  }

  /** {{name}} placeholders. Missing values become empty text, never "undefined". */
  private render(text: string, vars: Record<string, string>): string {
    return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g, (_m, key: string) => vars[key] ?? '');
  }

  private cleanVariables(vars?: Record<string, unknown>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(vars ?? {})) {
      if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
        throw new BadRequestException('template_variables_must_be_text_number_or_boolean');
      }
      const text = String(value);
      if (text.length > 500) throw new BadRequestException('template_variable_too_long');
      out[key] = text;
    }
    return out;
  }

  /** Provider errors can contain contact details. Strip them before they reach logs or the database. */
  private safeError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return raw
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]')
      .replace(/\+?\d[\d\s().-]{6,}\d/g, '[number]')
      .slice(0, 300);
  }

  private summarizeDeliveries(
    groups: Array<{ channel: string; status: string; _count: { _all: number } }>,
  ) {
    const out: Record<
      string,
      { sent: number; failed: number; pending: number; skipped: number; successRate: number | null }
    > = {};

    for (const g of groups) {
      const entry = (out[g.channel] ??= {
        sent: 0,
        failed: 0,
        pending: 0,
        skipped: 0,
        successRate: null,
      });
      const n = g._count._all;
      if (g.status === STATUS.SENT) entry.sent += n;
      else if (g.status === STATUS.FAILED) entry.failed += n;
      else if (g.status === STATUS.SKIPPED) entry.skipped += n;
      else entry.pending += n; // PENDING and SENDING
    }
    for (const entry of Object.values(out)) {
      const finished = entry.sent + entry.failed;
      entry.successRate = finished > 0 ? Number((entry.sent / finished).toFixed(4)) : null;
    }
    return out;
  }

  /** This user's rows that have not expired, plus any extra filters. */
  private activeWhere(
    userId: string,
    extra: Prisma.NotificationWhereInput = {},
  ): Prisma.NotificationWhereInput {
    return {
      userId,
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] }, extra],
    };
  }

  private allWhere(query: AllNotificationsQueryDto): Prisma.NotificationWhereInput {
    const and: Prisma.NotificationWhereInput[] = [];
    if (query.includeExpired === false) {
      and.push({ OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] });
    }
    if (query.q) {
      and.push({
        OR: [
          { title: { contains: query.q, mode: 'insensitive' } },
          { body: { contains: query.q, mode: 'insensitive' } },
          { actorName: { contains: query.q, mode: 'insensitive' } },
        ],
      });
    }

    if (query.category === 'SYSTEM') {
      and.push({ actorId: null });
    } else if (query.category === 'ADMIN' || query.category === 'SUPER_ADMIN') {
      and.push({ actorRole: query.category });
    } else if (query.category === 'USER') {
      and.push({ actorId: { not: null } });
      and.push({ OR: [{ actorRole: null }, { actorRole: { notIn: ['ADMIN', 'SUPER_ADMIN'] } }] });
    }

    return {
      ...(query.recipientId && { userId: query.recipientId }),
      ...(query.actorId && { actorId: query.actorId }),
      ...(query.type && { type: query.type }),
      ...(query.priority && { priority: query.priority }),
      ...(query.entity && { entity: query.entity }),
      ...(query.entityId && { entityId: query.entityId }),
      ...(query.isRead !== undefined && { readAt: query.isRead ? { not: null } : null }),
      ...((query.from || query.to) && {
        createdAt: {
          ...(query.from && { gte: new Date(query.from) }),
          ...(query.to && { lte: new Date(query.to) }),
        },
      }),
      ...(and.length && { AND: and }),
    };
  }

  private myFilters(
    userId: string,
    query: NotificationQueryDto,
    extra: Prisma.NotificationWhereInput = {},
  ): Prisma.NotificationWhereInput {
    const { type, priority, entity, isRead } = query;
    return this.activeWhere(userId, {
      ...(type && { type }),
      ...(priority && { priority }),
      ...(entity && { entity }),
      ...(isRead !== undefined && { readAt: isRead ? { not: null } : null }),
      ...extra,
    });
  }

  private pageParams(dto: PagingInput) {
    return {
      page: dto.page ?? 1,
      limit: Math.min(Math.max(dto.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT),
    };
  }

  private offsetMeta(page: number, limit: number, total: number, returned: number) {
    return {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: (page - 1) * limit + returned < total,
    };
  }

  /**
   * Cursor paging when `cursor` is set or `page` is absent (no total, no COUNT).
   * Offset paging when `page` is set (returns total and totalPages).
   * `where` is used as given, so callers decide about expiry filtering.
   */
  private async paginateNotifications(
    where: Prisma.NotificationWhereInput,
    dto: PagingInput,
    _raw = false,
    direction: 'asc' | 'desc' = 'desc',
  ) {
    const limit = Math.min(Math.max(dto.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const orderBy: Prisma.NotificationOrderByWithRelationInput[] = [
      { createdAt: direction },
      { id: direction },
    ];

    if (!dto.cursor && dto.page !== undefined) {
      const page = dto.page;
      const [data, total] = await this.prisma.$transaction([
        this.prisma.notification.findMany({
          where,
          orderBy,
          skip: (page - 1) * limit,
          take: limit,
        }),
        this.prisma.notification.count({ where }),
      ]);
      return { data, meta: this.offsetMeta(page, limit, total, data.length) };
    }

    // Fetch one extra row: its id is the next cursor.
    const rows = await this.prisma.notification.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(dto.cursor && { cursor: { id: dto.cursor } }),
    });
    const hasMore = rows.length > limit;

    return {
      data: rows.slice(0, limit),
      meta: { limit, nextCursor: hasMore ? rows[limit].id : null, hasMore },
    };
  }

  /**
   * While the legacy `isRead` column exists, keep it in sync with readAt.
   * When isRead is dropped from schema.prisma, delete the isRead lines.
   */
  private readPatch() {
    return { readAt: new Date(), isRead: true };
  }

  private unreadPatch() {
    return { readAt: null, isRead: false };
  }

  private toCreateData(input: CreateNotificationInput): Prisma.NotificationUncheckedCreateInput {
    return {
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      priority: input.priority ?? NotificationPriority.NORMAL,
      entity: input.entity ?? null,
      entityId: input.entityId ?? null,
      actorId: input.actorId ?? null,
      actorName: input.actorName ?? null,
      actorRole: input.actorRole ?? null,
      actionUrl: input.actionUrl ?? null,
      data: toAuditJson(input.data),
      expiresAt: input.expiresAt ?? null,
      dedupeKey: input.dedupeKey ?? null,
      broadcastId: input.broadcastId ?? null,
    };
  }
}
