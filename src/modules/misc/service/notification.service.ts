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
  UpdateNotificationPreferencesDto,
  UpdateNotificationTemplateDto,
} from '../dto/notification.dto';
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
} as const;

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
        select: { id: true, userId: true, type: true, priority: true },
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
      where: { ...this.audienceWhere('ADMINS'), ...(excludeUserId && { id: { not: excludeUserId } }) },
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

  private publish(userIds: string[]) {
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
          status: BROADCAST_STATUS.SCHEDULED,
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
        },
      });

      // Start straight away when it is due; the worker picks up anything this misses.
      if (scheduledAt.getTime() <= Date.now() + 5_000) {
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
          select: { id: true, userId: true, type: true, priority: true },
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
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      ...result,
      data: result.data.map((n) => ({ ...n, recipientName: names.get(n.userId) ?? null })),
    };
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
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })
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
    const exists = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
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
    const exists = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!exists) throw new NotFoundException('User not found');

    const [notifications, preferences, devices, keys, anonymizedActorRows] =
      await this.prisma.$transaction([
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

    const [users, prefs, tokenUsers, recent] = await Promise.all([
      this.prisma.user.findMany({
        where: { id: { in: userIds }, isActive: true },
        select: { id: true, isEmailVerified: true, isPhoneVerified: true, lockedUntil: true },
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
    ]);

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

      const pref = prefByKey.get(`${row.userId}:${row.type}`);

      for (const channel of OUTBOUND_CHANNELS) {
        if (!this.providers.has(channel)) continue;

        const reachable =
          channel === 'EMAIL'
            ? Boolean(user.isEmailVerified)
            : channel === 'SMS'
              ? Boolean(user.isPhoneVerified)
              : hasToken.has(row.userId);
        if (!reachable) continue;

        const explicit = channel === 'EMAIL' ? pref?.email : channel === 'SMS' ? pref?.sms : pref?.push;
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
      this.logger.error(`Delivery planning failed for ${rows.length} notification(s): ${this.safeError(err)}`);
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
    const rows = await this.prisma.$queryRaw<{ id: string }[]>`
      UPDATE notification_delivery
      SET status = 'SENDING', attempts = attempts + 1, "updatedAt" = ${now}
      WHERE id IN (
        SELECT id FROM notification_delivery
        WHERE status = 'PENDING' AND "nextAttemptAt" <= ${now}
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
        to.email = user.email;
      } else if (channel === 'SMS') {
        if (!user.phone || !user.isPhoneVerified) {
          return await this.finish(id, STATUS.SKIPPED, 'phone_not_verified');
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
        this.logger.warn(`Delivery ${id} (${channel}) failed after ${delivery.attempts} attempts: ${message}`);
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
    const readDays = Number(process.env.NOTIFICATION_READ_RETENTION_DAYS ?? 180);

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
    if (key.length === 0 || key.length > 200) throw new BadRequestException('invalid_idempotency_key');

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
        data: { result: result as unknown as Prisma.InputJsonValue },
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
      this.logger.error(`AUDIT FOR NOTIFICATION ACTION FAILED ${String(p.action)}: ${this.safeError(err)}`);
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
      const entry = (out[g.channel] ??= { sent: 0, failed: 0, pending: 0, skipped: 0, successRate: null });
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
  ) {
    const limit = Math.min(Math.max(dto.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const orderBy: Prisma.NotificationOrderByWithRelationInput[] = [
      { createdAt: 'desc' },
      { id: 'desc' },
    ];

    if (!dto.cursor && dto.page !== undefined) {
      const page = dto.page;
      const [data, total] = await this.prisma.$transaction([
        this.prisma.notification.findMany({ where, orderBy, skip: (page - 1) * limit, take: limit }),
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