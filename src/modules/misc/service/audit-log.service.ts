import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ActorType,
  AuditLog,
  AuditOutcome,
  AuditSeverity,
  AuditSource,
  Prisma,
} from '@prisma/client';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RequestContextService } from 'src/common/request-context/request-context.service';
import { PrismaService } from 'src/prisma/prisma.service';
import { toAuditJson } from 'src/common/utils/audit-redaction';

import {
  AUDIT_ALERT_TRIGGERED_EVENT,
  AuditAlertTriggeredEvent,
  AuditEventPayload,
} from '../events/audit.events';
import {
  AcknowledgeTriggerDto,
  AlertTriggersQueryDto,
  ApplyAlertTemplateDto,
  AuditBucketStatsQueryDto,
  AuditStatsFilterDto,
  AuditSummaryQueryDto,
  CancelPurgeScheduleDto,
  CreateAuditExportJobDto,
  CreateLegalHoldDto,
  DeniedStatsQueryDto,
  HealthHistoryQueryDto,
  IntegrityRunsQueryDto,
  IntegrityScheduleDto,
  LegalHoldsQueryDto,
  MyActivityQueryDto,
  PreviewLegalHoldDto,
  PurgeRunsQueryDto,
  PurgeScheduleQueryDto,
  ReleaseLegalHoldDto,
  SchedulePurgeDto,
  SetRowLegalHoldDto,
  ShareSavedFilterDto,
  TestAlertDto,
  UnshareSavedFilterDto,
  UpdateRetentionDto,
  UpdateSavedFilterDto,
  AuditLogFiltersDto,
  AuditPagingDto,
  AuditStatsQueryDto,
  AuditUserScopeQueryDto,
  CreateAuditAlertDto,
  CreateSavedFilterDto,
  GetAuditLogsDto,
  IntegrityVerifyQueryDto,
  PurgeAuditLogsDto,
  TimelineQueryDto,
  UpdateAuditAlertDto,
} from '../dto/audit-log.dto';
import {
  AUDIT_ARCHIVE_STORAGE,
  AuditArchiveStorage,
  AuditArchiveWriter,
} from './audit-archive.storage';
import { EXPORT_SCOPE, ExportJobService } from './export-job.service';
import { MISC_OBJECT_STORAGE, MiscObjectStorage } from './misc-object-storage';

// ─────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────

const DEFAULT_LIMIT = 20;
const DAY_MS = 86_400_000;
const MAX_EXPORT_ROWS = 50_000;
const MAX_VERIFY_ROWS = 500_000;
const VERIFY_BATCH = 2_000;
const PURGE_BATCH = 5_000;
const MAX_SAVED_FILTERS_PER_USER = 50;
const PURGE_TOKEN_TTL_MS = 10 * 60 * 1000;

/** Serialises chain writes. Any constant works; it only has to be the same everywhere. */
const AUDIT_CHAIN_LOCK_KEY = 7_301_001;
const HASH_VERSION = 'v1';

/** Excel needs a BOM to read UTF-8 (Amharic) correctly. */
const CSV_BOM = '\uFEFF';

/**
 * Security view: "failed logins and security alerts". Matched as substrings of
 * `action`, so it works whatever prefix your AuditEventEnum uses. Adjust to your enum.
 */
const SECURITY_ACTION_KEYWORDS = ['LOGIN_FAILED', 'SECURITY_ALERT'];

/** "WARNING or above", derived from whichever severities your enum actually has. */
const SEVERITY_RANK = ['INFO', 'WARNING', 'ERROR', 'CRITICAL'];
const SECURITY_SEVERITIES = (Object.values(AuditSeverity) as string[]).filter(
  (s) => SEVERITY_RANK.indexOf(s) >= 1,
) as AuditSeverity[];

// ─────────────────────────────────────────────
// SELECTS (role-based redaction happens in the query, not after it)
// ─────────────────────────────────────────────

/** Phone is never selected, for any role. */
const USER_SELECT = { id: true, name: true } as const;

/** What an ADMIN may see: no ipAddress, userAgent, metadata, and no chain internals. */
const ADMIN_SELECT = {
  id: true,
  createdAt: true,
  userId: true,
  actorType: true,
  actorName: true,
  actorRole: true,
  sessionId: true,
  targetUserId: true,
  action: true,
  outcome: true,
  severity: true,
  reason: true,
  entity: true,
  entityId: true,
  entityLabel: true,
  diff: true,
  country: true,
  city: true,
  source: true,
  method: true,
  path: true,
  requestId: true,
  anonymizedAt: true,
  user: { select: USER_SELECT },
} as const;

/** What a SUPER_ADMIN may see. */
const FULL_SELECT = {
  ...ADMIN_SELECT,
  ipAddress: true,
  userAgent: true,
  metadata: true,
  legalHold: true,
  seq: true,
  hash: true,
  prevHash: true,
} as const;

type FullAuditRow = Prisma.AuditLogGetPayload<{ select: typeof FULL_SELECT }>;
type RedactedKey =
  'ipAddress' | 'userAgent' | 'metadata' | 'legalHold' | 'seq' | 'hash' | 'prevHash';

/** ADMIN rows simply do not carry the redacted keys, so they are optional in the type. */
export type AuditLogView = Omit<FullAuditRow, RedactedKey> &
  Partial<Pick<FullAuditRow, RedactedKey>>;

// ─────────────────────────────────────────────
// TYPES
// ─────────────────────────────────────────────

export type AuditLogStats = {
  totalEvents: number;
  eventsToday: number;
  eventsThisWeek: number;
  eventsByAction: Record<string, number>;
  eventsByEntity: Record<string, number>;
  eventsByActorType: Record<string, number>;
  eventsBySeverity: Record<string, number>;
  eventsByOutcome: Record<string, number>;
  eventsBySource: Record<string, number>;
};

export type CursorMeta = { limit: number; nextCursor: string | null; hasMore: boolean };
export type OffsetMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  hasMore: boolean;
};
export type AuditPage = { data: AuditLogView[]; meta: CursorMeta | OffsetMeta };

export type IntegrityBreak = {
  id: string;
  seq: number;
  createdAt: string;
  reason: 'hash_mismatch' | 'chain_link_broken' | 'rows_missing';
  detail?: string;
};

export type IntegrityReport = {
  ok: boolean;
  /** false when MAX_VERIFY_ROWS was hit before the end of the range. Narrow the range and rerun. */
  complete: boolean;
  checked: number;
  /** Rows in range written before the chain existed (no seq/hash), so not checkable. */
  unchainedRows: number;
  from: string | null;
  to: string | null;
  firstBreak: IntegrityBreak | null;
  /** Newest verified link. Store it externally to also detect truncation of the tail. */
  head: { seq: number; hash: string } | null;
};

type PurgeTokenClaims = { sub: string; cutoff: string; exp: number; jti: string };

/** Filter stored on a legal hold. rowId is used by single-row holds (AL-01). */
type HoldFilter = {
  rowId?: string;
  entity?: string;
  entityId?: string;
  userId?: string;
  targetUserId?: string;
  action?: string;
  sessionId?: string;
  requestId?: string;
  startDate?: string;
  endDate?: string;
};

/** Acts as the system when the worker runs a job nobody triggered by hand. */
const SYSTEM_ACTOR = { id: null, roles: [], isSystem: true } as unknown as CurrentUserDto;

const AUDIT_WORKER_INTERVAL_MS = 60_000;
const HEALTH_SNAPSHOT_EVERY_MS = 10 * 60_000;
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
const ARCHIVE_LINK_TTL_SECONDS = 300;

// Case views (AL-43 to AL-45). Adjust these lists to the entity and action names your app really writes.
const SENSITIVE_ENTITIES = ['Report', 'VictimProfile', 'PayoutDestination', 'RewardClaim', 'InformationSubmission', 'MissingPerson'];
const SENSITIVE_ACTION_KEYWORDS = ['REPORTER_INFO', 'INFORMANT', 'BANK_DETAILS', 'CHILD_SAFETY', 'PAYOUT_DESTINATION_VIEWED'];
const PRIVILEGED_ENTITIES = [
  'Role',
  'Permission',
  'RolePermission',
  'UserRole',
  'RoleAssignmentRequest',
  'RoleTemporaryAssignment',
  'AccessReview',
  'AccessReviewItem',
  'TwoFactorPolicy',
  'TwoFactorResetRequest',
];
const PRIVILEGED_ACTION_KEYWORDS = ['ROLE_', 'PERMISSION', 'TWO_FACTOR', 'ACCESS_REVIEW'];
const MONEY_ENTITIES = ['Payment', 'PaymentAllocation', 'Disbursement', 'PayoutDestination', 'RewardClaim'];
const MONEY_ACTION_KEYWORDS = ['REFUND', 'PAYOUT', 'DISBURSEMENT', 'PAYMENT_VERIFIED', 'MANUAL_PAYMENT', 'REWARD_CLAIM'];

/** Ready-made alert rules (AL-28, AL-29). */
const ALERT_TEMPLATES = [
  {
    id: 'mass-export',
    name: 'Mass export',
    description: 'Three or more exports within an hour.',
    action: 'AUDIT_LOG_EXPORTED',
    entity: undefined as string | undefined,
    outcome: undefined as AuditOutcome | undefined,
    severity: undefined as AuditSeverity | undefined,
    threshold: 3,
    windowMinutes: 60,
    cooldownMinutes: 120,
  },
  {
    id: 'repeated-denied-access',
    name: 'Repeated denied access',
    description: 'Ten denied requests within ten minutes: someone may be probing.',
    action: undefined,
    entity: undefined,
    outcome: AuditOutcome.DENIED,
    severity: undefined,
    threshold: 10,
    windowMinutes: 10,
    cooldownMinutes: 60,
  },
  {
    id: 'failed-logins',
    name: 'Failed sign-ins',
    description: 'Five failed sign-ins within ten minutes.',
    action: 'LOGIN_FAILED',
    entity: undefined,
    outcome: undefined,
    severity: undefined,
    threshold: 5,
    windowMinutes: 10,
    cooldownMinutes: 30,
  },
  {
    id: 'critical-events',
    name: 'Critical events',
    description: 'Any event of CRITICAL severity.',
    action: undefined,
    entity: undefined,
    outcome: undefined,
    severity: AuditSeverity.CRITICAL,
    threshold: 1,
    windowMinutes: 5,
    cooldownMinutes: 15,
  },
  {
    id: 'purge-activity',
    name: 'Audit purge executed',
    description: 'Tell Super Admins every time audit rows are purged.',
    action: 'AUDIT_LOG_PURGED',
    entity: undefined,
    outcome: undefined,
    severity: undefined,
    threshold: 1,
    windowMinutes: 5,
    cooldownMinutes: 0,
  },
];

// ─────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────

@Injectable()
export class AuditLogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditLogService.name);

  private workerTimer: NodeJS.Timeout | null = null;
  private workerTicking = false;

  /** Per-process counters for getHealth(). */
  private writeFailures = 0;
  private lastFailureAt: Date | null = null;
  private lastFailureMessage: string | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly requestContext: RequestContextService,
    @Optional()
    @Inject(AUDIT_ARCHIVE_STORAGE)
    private readonly archive?: AuditArchiveStorage,
    // NEW HOOK: used by the new endpoints. All optional so existing wiring and tests keep working.
    @Optional() private readonly eventEmitter?: EventEmitter2,
    @Optional() private readonly exportJobs?: ExportJobService,
    @Optional()
    @Inject(MISC_OBJECT_STORAGE)
    private readonly objectStorage?: MiscObjectStorage,
  ) {}

  // ═════════════════════════════════════════════
  // WRITE
  // ═════════════════════════════════════════════

  /**
   * Record an audit event and link it into the hash chain.
   *
   * Each row stores seq, prevHash and hash, where hash covers the previous
   * hash plus the core event facts (see computeHash). Writes are serialised
   * with a transaction-level advisory lock so the chain has no forks. That
   * makes audit writes single-file: fine for admin-portal volumes, revisit
   * if you ever audit every read at high throughput.
   *
   * Failures are logged loudly, counted for getHealth(), and re-thrown.
   */
  async record(payload: AuditEventPayload): Promise<AuditLog> {
    const ctx = this.requestContext.get();
    const isSystem = payload.actorType === ActorType.SYSTEM;
    const isFailedLogin = payload.action === AuditEventEnum.LOGIN_FAILED;
    // System actions don't inherit the HTTP caller's network details
    const net = isSystem ? undefined : ctx;

    const data: Prisma.AuditLogUncheckedCreateInput = {
      userId: isSystem ? null : (payload.userId ?? null),
      actorType: payload.actorType,
      actorName: payload.actorName ?? (isSystem ? 'System' : (ctx?.actorName ?? null)),
      actorRole: payload.actorRole ?? (isSystem ? 'SYSTEM' : (ctx?.actorRole ?? null)),
      sessionId: payload.sessionId ?? net?.sessionId ?? null,
      targetUserId: payload.targetUserId ?? null,

      action: payload.action,
      outcome:
        isFailedLogin && (!payload.outcome || payload.outcome === AuditOutcome.SUCCESS)
          ? AuditOutcome.FAILURE
          : (payload.outcome ?? AuditOutcome.SUCCESS),
      severity:
        isFailedLogin && (!payload.severity || payload.severity === AuditSeverity.INFO)
          ? AuditSeverity.WARNING
          : (payload.severity ?? AuditSeverity.INFO),
      reason: payload.reason ?? null,

      entity: payload.entity,
      entityId: payload.entityId ?? null,
      entityLabel: payload.entityLabel ?? null,

      diff: toAuditJson(payload.diff),
      metadata: toAuditJson(payload.metadata),

      ipAddress: payload.ipAddress ?? net?.ipAddress ?? null,
      userAgent: payload.userAgent ?? net?.userAgent ?? null,
      country: payload.country ?? null,
      city: payload.city ?? null,
      source: payload.source ?? (isSystem ? AuditSource.SYSTEM : (ctx?.source ?? null)),
      method: payload.method ?? net?.method ?? null,
      path: payload.path ?? net?.path ?? null,
      requestId: payload.requestId ?? ctx?.requestId ?? null,
    };

    try {
      return await this.prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(${AUDIT_CHAIN_LOCK_KEY})`;

          const last = await tx.auditLog.findFirst({
            where: { seq: { not: null } },
            orderBy: { seq: 'desc' },
            select: { seq: true, hash: true },
          });

          const seq = (last?.seq ?? 0) + 1;
          const prevHash = last?.hash ?? null;
          const createdAt = new Date();

          const hash = this.computeHash({
            seq,
            prevHash,
            createdAt,
            action: String(data.action),
            outcome: String(data.outcome),
            severity: String(data.severity),
            actorType: String(data.actorType),
            entity: data.entity,
            entityId: data.entityId ?? null,
            reason: data.reason ?? null,
          });

          return tx.auditLog.create({ data: { ...data, createdAt, seq, prevHash, hash } });
        },
        { timeout: 10_000 },
      );
    } catch (err) {
      this.writeFailures += 1;
      this.lastFailureAt = new Date();
      this.lastFailureMessage = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `AUDIT WRITE FAILED action=${String(payload.action)} entity=${payload.entity}: ${this.lastFailureMessage}`,
        err instanceof Error ? err.stack : undefined,
      );
      throw err;
    }
  }

  /**
   * The hash covers the core event facts only: what, when, outcome, entity, reason.
   * It deliberately excludes personal fields (names, roles, IP, user agent, user ids)
   * and JSON blobs, so anonymizeUser() and user deletion never break the chain and
   * jsonb key re-ordering can never cause false alarms.
   */
  private computeHash(r: {
    seq: number;
    prevHash: string | null;
    createdAt: Date;
    action: string;
    outcome: string;
    severity: string;
    actorType: string;
    entity: string;
    entityId: string | null;
    reason: string | null;
  }): string {
    return createHash('sha256')
      .update(
        JSON.stringify([
          HASH_VERSION,
          r.seq,
          r.prevHash ?? 'GENESIS',
          r.createdAt.toISOString(),
          r.action,
          r.outcome,
          r.severity,
          r.actorType,
          r.entity,
          r.entityId,
          r.reason,
        ]),
      )
      .digest('hex');
  }

  /** Records an action performed on the audit system itself (the "audit the audit" rule). */
  private async auditSelf(
    actor: CurrentUserDto,
    p: {
      action: AuditEventEnum;
      entity?: string;
      entityId?: string;
      entityLabel?: string;
      reason?: string;
      severity?: AuditSeverity;
      outcome?: AuditOutcome;
      diff?: Record<string, unknown>;
      metadata?: Record<string, unknown>;
    },
  ): Promise<void> {
    const isSystem = (actor as unknown as { isSystem?: boolean }).isSystem === true;
    await this.record({
      userId: isSystem ? null : actor.id,
      actorType: isSystem
        ? ActorType.SYSTEM
        : this.isSuperAdmin(actor)
          ? ActorType.SUPER_ADMIN
          : ActorType.ADMIN,
      action: p.action,
      entity: p.entity ?? 'AuditLog',
      entityId: p.entityId,
      entityLabel: p.entityLabel,
      reason: p.reason,
      severity: p.severity,
      outcome: p.outcome,
      diff: p.diff,
      metadata: p.metadata,
    });
  }

  // ═════════════════════════════════════════════
  // READ: LIST, ONE, SCOPED VIEWS
  // ═════════════════════════════════════════════

  async findAll(dto: GetAuditLogsDto, viewer: CurrentUserDto): Promise<AuditPage> {
    const { cursor, page, limit, ...filters } = dto;
    return this.paginate(this.buildWhere(filters, viewer), { cursor, page, limit }, viewer);
  }

  async findSecurityEvents(dto: GetAuditLogsDto, viewer: CurrentUserDto): Promise<AuditPage> {
    const { cursor, page, limit, ...filters } = dto;
    const where: Prisma.AuditLogWhereInput = {
      AND: [this.buildWhere(filters, viewer), this.securityWhere()],
    };
    return this.paginate(where, { cursor, page, limit }, viewer);
  }

  /**
   * One entry. Viewing is itself audited; if that audit write fails the view fails
   * too (fail closed), so an unlogged read can't happen.
   */
  async findOne(id: string, viewer: CurrentUserDto) {
    const row = await this.prisma.auditLog.findUnique({
      where: { id },
      select: this.selectFor(viewer) as typeof FULL_SELECT,
    });

    if (!row) {
      throw new NotFoundException('Audit log not found');
    }

    const targetUser = row.targetUserId
      ? await this.prisma.user.findUnique({ where: { id: row.targetUserId }, select: USER_SELECT })
      : null;

    await this.auditSelf(viewer, {
      action: AuditEventEnum.AUDIT_LOG_VIEWED,
      entityId: id,
      entityLabel: row.action,
    });

    return { ...this.present(row), targetUser };
  }

  /** Full audit history for one entity record, e.g. every event tied to a single MissingPerson. */
  async findByEntity(
    entity: string,
    entityId: string,
    dto: AuditPagingDto,
    viewer: CurrentUserDto,
  ): Promise<AuditPage> {
    return this.paginate({ entity, entityId }, dto, viewer);
  }

  /** as=actor (default): things the user did. as=target: things done TO them. as=both: either. */
  async findByUser(
    userId: string,
    dto: AuditUserScopeQueryDto,
    viewer: CurrentUserDto,
  ): Promise<AuditPage> {
    const scope = dto.as ?? 'actor';
    const where: Prisma.AuditLogWhereInput =
      scope === 'target'
        ? { targetUserId: userId }
        : scope === 'both'
          ? { OR: [{ userId }, { targetUserId: userId }] }
          : { userId };

    return this.paginate(where, dto, viewer);
  }

  /** One login session, oldest event first. */
  async findBySession(sessionId: string, dto: AuditPagingDto, viewer: CurrentUserDto) {
    return this.paginate({ sessionId }, dto, viewer, 'asc');
  }

  /** One request id (trace a single call), oldest event first. */
  async findByRequest(requestId: string, dto: AuditPagingDto, viewer: CurrentUserDto) {
    return this.paginate({ requestId }, dto, viewer, 'asc');
  }

  async findDistinctActions(): Promise<string[]> {
    const rows = await this.prisma.auditLog.findMany({
      distinct: ['action'],
      select: { action: true },
      orderBy: { action: 'asc' },
    });
    return rows.map((row) => row.action);
  }

  async findDistinctEntities(): Promise<string[]> {
    const rows = await this.prisma.auditLog.findMany({
      distinct: ['entity'],
      select: { entity: true },
      orderBy: { entity: 'asc' },
    });
    return rows.map((row) => row.entity);
  }

  // ═════════════════════════════════════════════
  // STATS
  // ═════════════════════════════════════════════

  async getStats(): Promise<AuditLogStats> {
    const now = new Date();

    const startOfToday = new Date(now);
    startOfToday.setHours(0, 0, 0, 0);

    const startOfWeek = new Date(now);
    startOfWeek.setDate(startOfWeek.getDate() - 7);

    const [
      totalEvents,
      eventsToday,
      eventsThisWeek,
      byAction,
      byEntity,
      byActorType,
      bySeverity,
      byOutcome,
      bySource,
    ] = await Promise.all([
      this.prisma.auditLog.count(),
      this.prisma.auditLog.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.auditLog.count({ where: { createdAt: { gte: startOfWeek } } }),
      this.prisma.auditLog.groupBy({ by: ['action'], _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['entity'], _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['actorType'], _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['severity'], _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['outcome'], _count: { _all: true } }),
      this.prisma.auditLog.groupBy({ by: ['source'], _count: { _all: true } }),
    ]);

    const toMap = <K extends string>(
      groups: Array<Record<K, string | null> & { _count: { _all: number } }>,
      key: K,
    ): Record<string, number> =>
      Object.fromEntries(groups.map((g) => [g[key] ?? 'UNKNOWN', g._count._all]));

    return {
      totalEvents,
      eventsToday,
      eventsThisWeek,
      eventsByAction: toMap(byAction, 'action'),
      eventsByEntity: toMap(byEntity, 'entity'),
      eventsByActorType: toMap(byActorType, 'actorType'),
      eventsBySeverity: toMap(bySeverity, 'severity'),
      eventsByOutcome: toMap(byOutcome, 'outcome'),
      eventsBySource: toMap(bySource, 'source'),
    };
  }

  /** Events per UTC day for the last N days (today included), zero-filled for the chart. */
  async getTimeline(query: TimelineQueryDto) {
    const days = query.days ?? 30;

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (days - 1));

    // NOTE: table/column names assume no @@map. Adjust if your schema maps them.
    const rows = await this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
      SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
      FROM audit_log
      WHERE "createdAt" >= ${since}
      GROUP BY 1
      ORDER BY 1 ASC`;

    const counts = new Map(rows.map((r) => [r.day.toISOString().slice(0, 10), Number(r.count)]));

    const data = Array.from({ length: days }, (_, i) => {
      const d = new Date(since.getTime() + i * DAY_MS);
      const date = d.toISOString().slice(0, 10);
      return { date, count: counts.get(date) ?? 0 };
    });

    return { days, from: since.toISOString(), data };
  }

  /** Most active actors, plus the actors with the most DENIED/FAILURE outcomes. */
  async getTopActors(query: AuditStatsQueryDto) {
    const days = query.days ?? 30;
    const limit = query.limit ?? 10;
    const since = new Date(Date.now() - days * DAY_MS);

    const base: Prisma.AuditLogWhereInput = {
      createdAt: { gte: since },
      userId: { not: null },
      anonymizedAt: null,
    };

    const [active, troubled] = await Promise.all([
      this.prisma.auditLog.groupBy({
        by: ['userId'],
        where: base,
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: limit,
      }),
      this.prisma.auditLog.groupBy({
        by: ['userId'],
        where: { ...base, outcome: { in: [AuditOutcome.DENIED, AuditOutcome.FAILURE] } },
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: limit,
      }),
    ]);

    const ids = [...new Set([...active, ...troubled].map((g) => g.userId as string))];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: USER_SELECT })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    const shape = (groups: typeof active) =>
      groups.map((g) => ({
        userId: g.userId as string,
        name: names.get(g.userId as string) ?? null,
        count: g._count._all,
      }));

    return {
      days,
      since: since.toISOString(),
      mostActive: shape(active),
      mostDeniedOrFailed: shape(troubled),
    };
  }

  // ═════════════════════════════════════════════
  // HEALTH
  // ═════════════════════════════════════════════

  async getHealth() {
    const [newest, oldest, legalHoldCount, unchainedRows, table] = await Promise.all([
      this.prisma.auditLog.findFirst({
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      }),
      this.prisma.auditLog.findFirst({
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      this.prisma.auditLog.count({ where: { legalHold: true } }),
      this.prisma.auditLog.count({ where: { seq: null } }),
      this.tableStats(),
    ]);

    return {
      lastWriteAt: newest?.createdAt ?? null,
      oldestRowAt: oldest?.createdAt ?? null,
      legalHoldCount,
      unchainedRows,
      table,
      // Counters live in this process only; with several instances, aggregate them in your metrics stack.
      writeFailures: {
        sinceProcessStart: this.writeFailures,
        lastFailureAt: this.lastFailureAt,
        lastFailureMessage: this.lastFailureMessage,
      },
      archiveConfigured: Boolean(this.archive),
      purgeConfigured: (process.env.AUDIT_PURGE_TOKEN_SECRET?.length ?? 0) >= 32,
    };
  }

  private async tableStats(): Promise<{ estimatedRows: number | null; sizeBytes: number | null }> {
    try {
      const rows = await this.prisma.$queryRaw<{ rows: bigint; bytes: bigint }[]>`
        SELECT c.reltuples::bigint AS rows, pg_total_relation_size(c.oid)::bigint AS bytes
        FROM pg_class c
        WHERE c.relname = 'audit_log' AND c.relkind = 'r'
        LIMIT 1`;
      const r = rows[0];
      if (!r) return { estimatedRows: null, sizeBytes: null };
      return {
        estimatedRows: Number(r.rows) >= 0 ? Number(r.rows) : null,
        sizeBytes: Number(r.bytes),
      };
    } catch (err) {
      this.logger.warn(`tableStats failed: ${err instanceof Error ? err.message : String(err)}`);
      return { estimatedRows: null, sizeBytes: null };
    }
  }

  // ═════════════════════════════════════════════
  // EXPORT
  // ═════════════════════════════════════════════

  /**
   * CSV export of the rows matching the filters (paging ignored, capped at MAX_EXPORT_ROWS).
   * ADMIN gets no ipAddress/userAgent/metadata columns; nobody gets phone.
   * The export is written to AuditExport and audited before the CSV is returned.
   */
  async exportCsv(
    dto: GetAuditLogsDto,
    viewer: CurrentUserDto,
  ): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
    const { cursor: _cursor, page: _page, limit: _limit, ...filters } = dto;
    const where = this.buildWhere(filters, viewer);
    const superAdmin = this.isSuperAdmin(viewer);

    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: MAX_EXPORT_ROWS + 1,
      select: this.selectFor(viewer) as typeof FULL_SELECT,
    });

    const truncated = rows.length > MAX_EXPORT_ROWS;
    const logs = truncated ? rows.slice(0, MAX_EXPORT_ROWS) : rows;

    type Column = { header: string; superOnly?: boolean; value: (r: FullAuditRow) => unknown };
    const columns: Column[] = [
      { header: 'id', value: (r) => r.id },
      { header: 'createdAt', value: (r) => r.createdAt },
      { header: 'action', value: (r) => r.action },
      { header: 'outcome', value: (r) => r.outcome },
      { header: 'severity', value: (r) => r.severity },
      { header: 'actorType', value: (r) => r.actorType },
      { header: 'actorName', value: (r) => r.actorName },
      { header: 'actorRole', value: (r) => r.actorRole },
      { header: 'userId', value: (r) => r.userId },
      { header: 'userName', value: (r) => (r.anonymizedAt ? null : r.user?.name) },
      { header: 'targetUserId', value: (r) => r.targetUserId },
      { header: 'entity', value: (r) => r.entity },
      { header: 'entityId', value: (r) => r.entityId },
      { header: 'entityLabel', value: (r) => r.entityLabel },
      { header: 'reason', value: (r) => r.reason },
      { header: 'ipAddress', superOnly: true, value: (r) => r.ipAddress },
      { header: 'userAgent', superOnly: true, value: (r) => r.userAgent },
      { header: 'requestId', value: (r) => r.requestId },
      { header: 'source', value: (r) => r.source },
      { header: 'diff', value: (r) => r.diff },
      { header: 'metadata', superOnly: true, value: (r) => r.metadata },
    ];
    const active = columns.filter((c) => superAdmin || !c.superOnly);

    const escapeCsv = (value: unknown): string => {
      if (value === null || value === undefined) {
        return '';
      }

      let str =
        typeof value === 'string'
          ? value
          : value instanceof Date
            ? value.toISOString()
            : JSON.stringify(value);

      // Neutralise spreadsheet formulas (CSV injection): names and reasons are user-controlled.
      if (/^[=+\-@\t\r]/.test(str)) {
        str = `'${str}`;
      }

      // Quote and escape whenever the value could break CSV structure.
      if (/[",\r\n]/.test(str)) {
        return `"${str.replace(/"/g, '""')}"`;
      }

      return str;
    };

    const lines = [
      active.map((c) => c.header).join(','),
      ...logs.map((log) => active.map((c) => escapeCsv(c.value(log))).join(',')),
    ];
    const csv = CSV_BOM + lines.join('\n');

    // The stored filter must not reveal what only SUPER_ADMIN may see.
    const storedFilter = filters.ipAddress ? { ...filters, ipAddress: '[redacted]' } : filters;

    await this.prisma.auditExport.create({
      data: {
        exportedById: viewer.id,
        filter: storedFilter,
        rowCount: logs.length,
        truncated,
      },
    });

    await this.auditSelf(viewer, {
      action: AuditEventEnum.AUDIT_LOG_EXPORTED,
      entityLabel: `${logs.length} rows${truncated ? ' (truncated)' : ''}`,
      metadata: { filter: storedFilter, rowCount: logs.length, truncated },
    });

    return { csv, rowCount: logs.length, truncated };
  }

  /** Who exported what, when, with which filter and how many rows. Offset paging. */
  async findExportHistory(dto: AuditPagingDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? DEFAULT_LIMIT;

    const [rows, total] = await Promise.all([
      this.prisma.auditExport.findMany({
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditExport.count(),
    ]);

    const ids = [...new Set(rows.map((r) => r.exportedById).filter((id): id is string => !!id))];
    const users = ids.length
      ? await this.prisma.user.findMany({ where: { id: { in: ids } }, select: USER_SELECT })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      data: rows.map((r) => ({
        ...r,
        exportedByName: r.exportedById ? (names.get(r.exportedById) ?? null) : null,
      })),
      meta: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
        hasMore: page * limit < total,
      },
    };
  }

  // ═════════════════════════════════════════════
  // SAVED FILTERS (per admin)
  // ═════════════════════════════════════════════

  async findSavedFilters(viewer: CurrentUserDto) {
    return this.prisma.auditSavedFilter.findMany({
      where: { userId: this.requireUserId(viewer) },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createSavedFilter(dto: CreateSavedFilterDto, viewer: CurrentUserDto) {
    const userId = this.requireUserId(viewer);

    const existing = await this.prisma.auditSavedFilter.count({ where: { userId } });
    if (existing >= MAX_SAVED_FILTERS_PER_USER) {
      throw new BadRequestException('saved_filter_limit_reached');
    }

    try {
      return await this.prisma.auditSavedFilter.create({
        data: {
          userId,
          name: dto.name,
          filter: dto.filter as unknown as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('saved_filter_name_already_exists');
      }
      throw err;
    }
  }

  /** Scoped by owner in the query itself, so one admin can never delete another's filter. */
  async deleteSavedFilter(id: string, viewer: CurrentUserDto) {
    const result = await this.prisma.auditSavedFilter.deleteMany({
      where: { id, userId: this.requireUserId(viewer) },
    });

    if (result.count === 0) {
      throw new NotFoundException('Saved filter not found');
    }

    return { deleted: true };
  }

  // ═════════════════════════════════════════════
  // ALERT RULES (SUPER_ADMIN)
  // Rules are stored and managed here. Evaluating them (count matches in the
  // window, respect cooldown, notify SUPER_ADMINs) belongs with the notification batch.
  // ═════════════════════════════════════════════

  async findAlerts() {
    return this.prisma.auditAlert.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async createAlert(dto: CreateAuditAlertDto, actor: CurrentUserDto) {
    if (!dto.action && !dto.entity && !dto.outcome && !dto.severity) {
      throw new BadRequestException('alert_needs_at_least_one_match_condition');
    }

    const alert = await this.prisma.auditAlert.create({
      data: { ...dto, createdById: actor.id },
    });

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_ALERT_CREATED,
      entity: 'AuditAlert',
      entityId: alert.id,
      entityLabel: alert.name,
      diff: { before: null, after: dto },
    });

    return alert;
  }

  async updateAlert(id: string, dto: UpdateAuditAlertDto, actor: CurrentUserDto) {
    const before = await this.prisma.auditAlert.findUnique({ where: { id } });
    if (!before) {
      throw new NotFoundException('Alert rule not found');
    }

    const changes = Object.fromEntries(Object.entries(dto).filter(([, v]) => v !== undefined));
    if (Object.keys(changes).length === 0) {
      throw new BadRequestException('nothing_to_update');
    }

    const after = await this.prisma.auditAlert.update({ where: { id }, data: changes });

    const changedKeys = Object.keys(changes) as Array<keyof typeof before>;
    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_ALERT_UPDATED,
      entity: 'AuditAlert',
      entityId: id,
      entityLabel: after.name,
      diff: {
        before: Object.fromEntries(changedKeys.map((k) => [k, before[k]])),
        after: Object.fromEntries(changedKeys.map((k) => [k, after[k]])),
      },
    });

    return after;
  }

  async deleteAlert(id: string, actor: CurrentUserDto) {
    const before = await this.prisma.auditAlert.findUnique({ where: { id } });
    if (!before) {
      throw new NotFoundException('Alert rule not found');
    }

    await this.prisma.auditAlert.delete({ where: { id } });

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_ALERT_DELETED,
      entity: 'AuditAlert',
      entityId: id,
      entityLabel: before.name,
      diff: { before, after: null },
    });

    return { deleted: true };
  }

  // ═════════════════════════════════════════════
  // INTEGRITY (hash chain)
  // ═════════════════════════════════════════════

  /**
   * Walks the chain in seq order and checks, for every row:
   *  1. its stored hash matches the recomputed hash,
   *  2. its prevHash equals the previous row's hash,
   *  3. no seq is missing, unless a recorded purge run explains the gap.
   * Stops at the first break. Rows written before the chain existed are counted, not checked.
   */
  async verifyIntegrity(
    query: IntegrityVerifyQueryDto,
    actor: CurrentUserDto,
    trigger: 'MANUAL' | 'SCHEDULED' = 'MANUAL',
  ): Promise<IntegrityReport> {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;

    if (from && to && from > to) {
      throw new BadRequestException('from_after_to');
    }

    const range: Prisma.AuditLogWhereInput =
      from || to ? { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } } : {};

    const purged = await this.purgedSeqRanges();
    const explainedByPurge = (lo: number, hi: number) =>
      purged.some(([a, b]) => a <= lo && b >= hi);

    let prev: { seq: number; hash: string } | null = null;
    let lastSeq: number | null = null;
    let checked = 0;
    let complete = true;
    let firstBreak: IntegrityBreak | null = null;

    scan: for (;;) {
      const rows = await this.prisma.auditLog.findMany({
        where: { AND: [range, { seq: lastSeq === null ? { not: null } : { gt: lastSeq } }] },
        orderBy: { seq: 'asc' },
        take: VERIFY_BATCH,
        select: {
          id: true,
          seq: true,
          hash: true,
          prevHash: true,
          createdAt: true,
          action: true,
          outcome: true,
          severity: true,
          actorType: true,
          entity: true,
          entityId: true,
          reason: true,
        },
      });

      if (rows.length === 0) break;

      // First batch: anchor on the row just before the range so the first link is checked too.
      if (prev === null && lastSeq === null) {
        const pred = await this.prisma.auditLog.findFirst({
          where: { seq: { lt: rows[0].seq as number } },
          orderBy: { seq: 'desc' },
          select: { seq: true, hash: true },
        });
        if (pred?.seq != null && pred.hash) {
          prev = { seq: pred.seq, hash: pred.hash };
        }
      }

      for (const row of rows) {
        if (checked >= MAX_VERIFY_ROWS) {
          complete = false;
          break scan;
        }

        const seq = row.seq as number;
        const fail = (reason: IntegrityBreak['reason'], detail?: string) => {
          firstBreak = { id: row.id, seq, createdAt: row.createdAt.toISOString(), reason, detail };
        };

        const expected = this.computeHash({
          seq,
          prevHash: row.prevHash,
          createdAt: row.createdAt,
          action: row.action,
          outcome: row.outcome,
          severity: row.severity,
          actorType: row.actorType,
          entity: row.entity,
          entityId: row.entityId,
          reason: row.reason,
        });

        if (expected !== row.hash) {
          fail('hash_mismatch', 'Row content no longer matches its stored hash.');
          break scan;
        }

        if (prev) {
          if (seq === prev.seq + 1) {
            if (row.prevHash !== prev.hash) {
              fail('chain_link_broken', `prevHash does not match the hash of seq ${prev.seq}.`);
              break scan;
            }
          } else if (!explainedByPurge(prev.seq + 1, seq - 1)) {
            fail(
              'rows_missing',
              `seq ${prev.seq + 1}..${seq - 1} are missing and no purge run explains it.`,
            );
            break scan;
          }
        }

        prev = { seq, hash: row.hash };
        checked += 1;
      }

      lastSeq = rows[rows.length - 1].seq;
    }

    const unchainedRows = await this.prisma.auditLog.count({
      where: { AND: [range, { seq: null }] },
    });

    const report: IntegrityReport = {
      ok: firstBreak === null,
      complete,
      checked,
      unchainedRows,
      from: from?.toISOString() ?? null,
      to: to?.toISOString() ?? null,
      firstBreak,
      head: prev,
    };

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_LOG_INTEGRITY_VERIFIED,
      outcome: report.ok ? AuditOutcome.SUCCESS : AuditOutcome.FAILURE,
      severity: report.ok ? AuditSeverity.INFO : AuditSeverity.CRITICAL,
      metadata: { ...report },
    });

    await this.saveIntegrityRun(trigger, actor, report);

    return report;
  }

  /** Seq ranges removed by purge runs, merged, so legitimate gaps aren't reported as tampering. */
  private async purgedSeqRanges(): Promise<Array<[number, number]>> {
    const runs = await this.prisma.auditPurgeRun.findMany({
      where: { minSeq: { not: null }, maxSeq: { not: null } },
      select: { minSeq: true, maxSeq: true },
      orderBy: { minSeq: 'asc' },
    });

    const merged: Array<[number, number]> = [];
    for (const r of runs) {
      const lo = r.minSeq as number;
      const hi = r.maxSeq as number;
      const last = merged[merged.length - 1];
      if (last && lo <= last[1] + 1) {
        last[1] = Math.max(last[1], hi);
      } else {
        merged.push([lo, hi]);
      }
    }
    return merged;
  }

  // ═════════════════════════════════════════════
  // RETENTION: PREVIEW → PURGE
  // ═════════════════════════════════════════════

  /**
   * Dry run. Counts what a purge would delete, what legal hold protects, and issues a
   * short-lived, single-use, actor-bound confirmToken. The preview is audited.
   */
  async previewPurge(olderThan: string, actor: CurrentUserDto) {
    const cutoff = this.parseCutoff(olderThan);

    const [wouldDelete, underLegalHold] = await Promise.all([
      this.prisma.auditLog.count({ where: { createdAt: { lt: cutoff }, legalHold: false } }),
      this.prisma.auditLog.count({ where: { createdAt: { lt: cutoff }, legalHold: true } }),
    ]);

    const { token, expiresAt } = this.issueConfirmToken(actor, cutoff);

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_LOG_PURGE_PREVIEWED,
      severity: AuditSeverity.WARNING,
      metadata: { cutoff: cutoff.toISOString(), wouldDelete, underLegalHold },
    });

    return {
      olderThan: cutoff.toISOString(),
      wouldDelete,
      underLegalHold,
      confirmToken: token,
      expiresAt: new Date(expiresAt).toISOString(),
    };
  }

  /**
   * Archive, then delete.
   *  1. validate cutoff, reason and confirmToken (signed, unexpired, same actor, same cutoff)
   *  2. burn the token by inserting an AuditPurgeRun (unique tokenId)
   *  3. stream matching rows to cold storage; abort with nothing deleted if that fails
   *  4. delete in batches, skipping rows under legal hold
   *  5. write AUDIT_LOG_PURGED AFTER the delete so the cutoff can't remove it
   */
  async purgeOlderThan(dto: PurgeAuditLogsDto, actor: CurrentUserDto) {
    const cutoff = this.parseCutoff(dto.olderThan);

    const reason = dto.reason?.trim();
    if (!reason) {
      throw new BadRequestException('reason_required');
    }

    const claims = this.verifyConfirmToken(dto.confirmToken, actor, cutoff);

    if (!this.archive) {
      throw new ServiceUnavailableException('audit_archive_not_configured');
    }

    let run;
    try {
      run = await this.prisma.auditPurgeRun.create({
        data: {
          tokenId: claims.jti,
          cutoff,
          reason,
          status: 'STARTED',
          requestedById: actor.id,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new BadRequestException('confirm_token_already_used');
      }
      throw err;
    }

    const purgeWhere: Prisma.AuditLogWhereInput = { createdAt: { lt: cutoff }, legalHold: false };

    // ── 1. archive ──────────────────────────────
    let archivedCount = 0;
    let minSeq: number | null = null;
    let maxSeq: number | null = null;
    let archiveKey: string | null = null;

    let writer: AuditArchiveWriter;
    try {
      writer = await this.archive.open({ runId: run.id, cutoff: cutoff.toISOString() });
    } catch (err) {
      await this.failRun(run.id, `archive_open: ${this.errMsg(err)}`);
      this.logger.error(
        `Purge ${run.id} could not open archive, nothing deleted: ${this.errMsg(err)}`,
      );
      throw new ServiceUnavailableException('audit_archive_unavailable_nothing_deleted');
    }

    try {
      let cursorId: string | undefined;
      for (;;) {
        const batch = await this.prisma.auditLog.findMany({
          where: purgeWhere,
          orderBy: { id: 'asc' },
          take: PURGE_BATCH,
          ...(cursorId && { cursor: { id: cursorId }, skip: 1 }),
        });
        if (batch.length === 0) break;

        await writer.write(batch);
        archivedCount += batch.length;
        for (const row of batch) {
          if (row.seq !== null) {
            minSeq = minSeq === null ? row.seq : Math.min(minSeq, row.seq);
            maxSeq = maxSeq === null ? row.seq : Math.max(maxSeq, row.seq);
          }
        }
        cursorId = batch[batch.length - 1].id;
      }

      if (archivedCount > 0) {
        archiveKey = (await writer.finish()).key;
      } else {
        await writer.abort();
      }
    } catch (err) {
      await writer.abort().catch(() => undefined);
      await this.failRun(run.id, `archive: ${this.errMsg(err)}`);
      this.logger.error(`Purge ${run.id} archive failed, nothing deleted: ${this.errMsg(err)}`);
      throw new ServiceUnavailableException('audit_archive_failed_nothing_deleted');
    }

    await this.prisma.auditPurgeRun.update({
      where: { id: run.id },
      data: { status: 'ARCHIVED', archiveKey, archivedCount, minSeq, maxSeq },
    });

    // ── 2. delete ───────────────────────────────
    let deletedCount = 0;
    try {
      for (;;) {
        const ids = await this.prisma.auditLog.findMany({
          where: purgeWhere,
          orderBy: { id: 'asc' },
          take: PURGE_BATCH,
          select: { id: true },
        });
        if (ids.length === 0) break;

        // legalHold is re-checked here in case a hold was placed after the scan.
        const res = await this.prisma.auditLog.deleteMany({
          where: { id: { in: ids.map((r) => r.id) }, legalHold: false },
        });
        deletedCount += res.count;
        if (res.count === 0) break;
      }
    } catch (err) {
      await this.prisma.auditPurgeRun.update({
        where: { id: run.id },
        data: { status: 'FAILED', deletedCount, error: `delete: ${this.errMsg(err)}` },
      });
      this.logger.error(
        `Purge ${run.id} delete failed after ${deletedCount} rows: ${this.errMsg(err)}`,
      );
      throw new ServiceUnavailableException(`purge_partially_failed_see_run_${run.id}`);
    }

    const heldCount = await this.prisma.auditLog.count({
      where: { createdAt: { lt: cutoff }, legalHold: true },
    });

    await this.prisma.auditPurgeRun.update({
      where: { id: run.id },
      data: { status: 'COMPLETED', deletedCount, heldCount, finishedAt: new Date() },
    });

    // ── 3. audit AFTER the delete ───────────────
    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_LOG_PURGED,
      severity: AuditSeverity.CRITICAL,
      entityId: run.id,
      reason,
      diff: {
        before: { cutoff: cutoff.toISOString(), archivedCount, archiveKey },
        after: { deletedCount, heldCount },
      },
    });

    return {
      runId: run.id,
      olderThan: cutoff.toISOString(),
      archivedCount,
      archiveKey,
      deletedCount,
      heldCount,
    };
  }

  private parseCutoff(olderThan: string): Date {
    if (!olderThan) {
      throw new BadRequestException('olderThan_query_param_required');
    }

    const cutoff = new Date(olderThan);

    if (isNaN(cutoff.getTime())) {
      throw new BadRequestException('invalid_olderThan_date');
    }

    if (cutoff.getTime() > Date.now()) {
      throw new BadRequestException('olderThan_must_be_in_the_past');
    }

    return cutoff;
  }

  private async failRun(id: string, error: string) {
    await this.prisma.auditPurgeRun
      .update({ where: { id }, data: { status: 'FAILED', error, finishedAt: new Date() } })
      .catch(() => undefined);
  }

  // ── confirm token (stateless HMAC; single use is enforced by AuditPurgeRun.tokenId) ──

  private tokenSecret(): string {
    const secret = process.env.AUDIT_PURGE_TOKEN_SECRET;
    if (!secret || secret.length < 32) {
      // Fail closed: no purge without a real secret.
      throw new ServiceUnavailableException('purge_not_configured');
    }
    return secret;
  }

  private issueConfirmToken(actor: CurrentUserDto, cutoff: Date) {
    const claims: PurgeTokenClaims = {
      sub: this.requireUserId(actor),
      cutoff: cutoff.toISOString(),
      exp: Date.now() + PURGE_TOKEN_TTL_MS,
      jti: randomUUID(),
    };
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    const sig = createHmac('sha256', this.tokenSecret()).update(body).digest('base64url');
    return { token: `${body}.${sig}`, expiresAt: claims.exp };
  }

  private verifyConfirmToken(token: string, actor: CurrentUserDto, cutoff: Date): PurgeTokenClaims {
    const [body, sig] = (token ?? '').split('.');
    if (!body || !sig) {
      throw new BadRequestException('invalid_confirm_token');
    }

    const expected = createHmac('sha256', this.tokenSecret()).update(body).digest();
    const given = Buffer.from(sig, 'base64url');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new BadRequestException('invalid_confirm_token');
    }

    let claims: PurgeTokenClaims;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      throw new BadRequestException('invalid_confirm_token');
    }

    if (claims.exp < Date.now()) {
      throw new BadRequestException('confirm_token_expired');
    }
    if (claims.sub !== actor.id) {
      throw new ForbiddenException('confirm_token_issued_to_another_user');
    }
    if (claims.cutoff !== cutoff.toISOString()) {
      throw new BadRequestException('confirm_token_does_not_match_olderThan');
    }

    return claims;
  }

  // ═════════════════════════════════════════════
  // DATA-SUBJECT: anonymize one user
  // ═════════════════════════════════════════════

  /**
   * Keeps the events, removes the person. On rows the user performed, blanks
   * name, role, IP, user agent, geo and metadata, and stamps anonymizedAt (which
   * also hides the joined User name in every read). Clears entityLabel on the
   * user's own User-entity rows.
   *
   * userId / sessionId stay as opaque pseudonyms so events remain countable and the
   * hash chain is untouched. If the subject also needs the User row erased, do that
   * separately. Rows under legal hold are skipped and reported.
   */
  async anonymizeUser(userId: string, actor: CurrentUserDto) {
    const now = new Date();

    const [actorRows, labelRows, skippedLegalHold] = await this.prisma.$transaction([
      this.prisma.auditLog.updateMany({
        where: { userId, legalHold: false, anonymizedAt: null },
        data: {
          actorName: 'Anonymized user',
          actorRole: null,
          ipAddress: null,
          userAgent: null,
          country: null,
          city: null,
          metadata: Prisma.DbNull,
          anonymizedAt: now,
        },
      }),
      this.prisma.auditLog.updateMany({
        where: { entity: 'User', entityId: userId, legalHold: false },
        data: { entityLabel: null },
      }),
      this.prisma.auditLog.count({
        where: { legalHold: true, OR: [{ userId }, { entity: 'User', entityId: userId }] },
      }),
    ]);

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_LOG_ANONYMIZED,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: userId,
      diff: {
        before: null,
        after: {
          anonymizedRows: actorRows.count,
          entityLabelsCleared: labelRows.count,
          skippedLegalHold,
        },
      },
    });

    return {
      userId,
      anonymizedRows: actorRows.count,
      entityLabelsCleared: labelRows.count,
      skippedLegalHold,
    };
  }

  // ═════════════════════════════════════════════════════════════════════════
  // NEW ENDPOINTS (AL-01 to AL-56)
  // Everything below was added. The methods above are unchanged except for the
  // small hooks marked "NEW HOOK" (constructor, auditSelf, verifyIntegrity).
  // ═════════════════════════════════════════════════════════════════════════

  // ─────────────────────────────────────────────
  // BACKGROUND WORKER (scheduled purge, scheduled integrity, alert evaluation, health snapshots)
  // ─────────────────────────────────────────────

  onModuleInit() {
    if (process.env.AUDIT_WORKER_ENABLED === 'false') {
      this.logger.warn('Audit worker disabled (AUDIT_WORKER_ENABLED=false)');
      return;
    }
    this.workerTimer = setInterval(() => void this.runWorkerOnce(), AUDIT_WORKER_INTERVAL_MS);
    this.workerTimer.unref?.();
  }

  onModuleDestroy() {
    if (this.workerTimer) clearInterval(this.workerTimer);
  }

  /** One worker pass. Safe with several instances: every job is claimed with a conditional update. */
  async runWorkerOnce(): Promise<void> {
    if (this.workerTicking) return;
    this.workerTicking = true;
    try {
      await this.safely('scheduled purges', () => this.runDueScheduledPurges());
      await this.safely('scheduled integrity', () => this.runDueIntegrity());
      await this.safely('alert rules', () => this.evaluateAlerts());
      await this.safely('health snapshot', () => this.snapshotHealthIfDue());
    } finally {
      this.workerTicking = false;
    }
  }

  private async safely(label: string, fn: () => Promise<void>) {
    try {
      await fn();
    } catch (err) {
      this.logger.error(`Audit worker (${label}) failed: ${this.errMsg(err)}`);
    }
  }

  private emitAttention(event: AuditAlertTriggeredEvent) {
    try {
      this.eventEmitter?.emit(AUDIT_ALERT_TRIGGERED_EVENT, event);
    } catch (err) {
      this.logger.error(`Could not emit attention event: ${this.errMsg(err)}`);
    }
  }

  private async runDueScheduledPurges() {
    const due = await this.prisma.auditPurgeSchedule.findMany({
      where: { status: 'SCHEDULED', runAt: { lte: new Date() } },
      orderBy: { runAt: 'asc' },
      take: 3,
    });

    for (const s of due) {
      const claimed = await this.prisma.auditPurgeSchedule.updateMany({
        where: { id: s.id, status: 'SCHEDULED' },
        data: { status: 'RUNNING' },
      });
      if (claimed.count === 0) continue;

      // Runs exactly like a manual purge (archive first, held rows skipped, audited after),
      // acting as the Super Admin who scheduled it.
      const actor = { id: s.createdById, roles: [RolesEnum.SUPER_ADMIN] } as unknown as CurrentUserDto;
      try {
        const { token } = this.issueConfirmToken(actor, s.olderThan);
        const result = await this.purgeOlderThan(
          {
            olderThan: s.olderThan.toISOString(),
            reason: `${s.reason} (scheduled purge ${s.id})`,
            confirmToken: token,
          },
          actor,
        );
        await this.prisma.auditPurgeSchedule.update({
          where: { id: s.id },
          data: { status: 'EXECUTED', purgeRunId: result.runId, executedAt: new Date() },
        });
      } catch (err) {
        await this.prisma.auditPurgeSchedule.update({
          where: { id: s.id },
          data: { status: 'FAILED', error: this.errMsg(err).slice(0, 300), executedAt: new Date() },
        });
        this.emitAttention({
          kind: 'SCHEDULED_PURGE_FAILED',
          title: 'Scheduled audit purge failed',
          body: 'A scheduled audit log purge did not complete. Open the purge schedule for details.',
          entity: 'AuditPurgeSchedule',
          entityId: s.id,
          occurrenceId: s.id,
        });
      }
    }
  }

  private async runDueIntegrity() {
    const schedule = await this.prisma.auditIntegritySchedule.findUnique({ where: { id: 'default' } });
    if (!schedule?.enabled) return;
    const now = new Date();
    if (schedule.nextRunAt && schedule.nextRunAt > now) return;

    const next = new Date(now.getTime() + schedule.intervalHours * 3_600_000);
    const claimed = await this.prisma.auditIntegritySchedule.updateMany({
      where: {
        id: 'default',
        enabled: true,
        OR: [{ nextRunAt: null }, { nextRunAt: { lte: now } }],
      },
      data: { lastRunAt: now, nextRunAt: next },
    });
    if (claimed.count === 0) return;

    const report = await this.verifyIntegrity({}, SYSTEM_ACTOR, 'SCHEDULED');
    if (!report.ok) {
      this.emitAttention({
        kind: 'INTEGRITY_BREAK',
        title: 'Audit log integrity check failed',
        body: 'The scheduled hash-chain check found a break. Open the integrity breaks list.',
        entity: 'AuditIntegrityRun',
        entityId: report.firstBreak?.id ?? 'unknown',
        occurrenceId: `${now.toISOString()}`,
      });
    }
  }

  /** Counts matches in each enabled rule's window and records a trigger when the threshold is reached. */
  private async evaluateAlerts() {
    const alerts = await this.prisma.auditAlert.findMany({ where: { enabled: true } });
    const now = new Date();

    for (const alert of alerts) {
      const cooldownCutoff = new Date(now.getTime() - alert.cooldownMinutes * 60_000);
      if (alert.lastTriggeredAt && alert.lastTriggeredAt > cooldownCutoff) continue;

      const windowStart = new Date(now.getTime() - alert.windowMinutes * 60_000);
      const where = this.alertWhere(alert, windowStart, now);
      const matchCount = await this.prisma.auditLog.count({ where });
      if (matchCount < alert.threshold) continue;

      const claimed = await this.prisma.auditAlert.updateMany({
        where: {
          id: alert.id,
          enabled: true,
          OR: [{ lastTriggeredAt: null }, { lastTriggeredAt: { lte: cooldownCutoff } }],
        },
        data: { lastTriggeredAt: now },
      });
      if (claimed.count === 0) continue;

      const samples = await this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true },
      });
      const trigger = await this.prisma.auditAlertTrigger.create({
        data: {
          alertId: alert.id,
          firedAt: now,
          matchCount,
          windowStart,
          windowEnd: now,
          sampleIds: samples.map((x) => x.id),
        },
      });

      this.emitAttention({
        kind: 'ALERT_RULE',
        title: `Audit alert: ${alert.name}`,
        body: `${matchCount} matching events in the last ${alert.windowMinutes} minutes (threshold ${alert.threshold}).`,
        entity: 'AuditAlert',
        entityId: alert.id,
        occurrenceId: trigger.id,
      });
    }
  }

  private alertWhere(
    alert: { action: string | null; entity: string | null; outcome: AuditOutcome | null; severity: AuditSeverity | null },
    from: Date,
    to: Date,
  ): Prisma.AuditLogWhereInput {
    return {
      createdAt: { gte: from, lte: to },
      ...(alert.action && { action: alert.action }),
      ...(alert.entity && { entity: alert.entity }),
      ...(alert.outcome && { outcome: alert.outcome }),
      ...(alert.severity && { severity: alert.severity }),
    };
  }

  private async snapshotHealthIfDue() {
    const last = await this.prisma.auditHealthSnapshot.findFirst({
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });
    if (last && Date.now() - last.createdAt.getTime() < HEALTH_SNAPSHOT_EVERY_MS) return;

    const [newest, unchained, table] = await Promise.all([
      this.prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      this.prisma.auditLog.count({ where: { seq: null } }),
      this.tableStats(),
    ]);

    await this.prisma.auditHealthSnapshot.create({
      data: {
        lastWriteAt: newest?.createdAt ?? null,
        lagSeconds: newest ? Math.max(0, Math.round((Date.now() - newest.createdAt.getTime()) / 1000)) : null,
        writeFailures: this.writeFailures,
        estimatedRows: table.estimatedRows,
        sizeBytes: table.sizeBytes,
        unchainedRows: unchained,
      },
    });

    await this.prisma.auditHealthSnapshot.deleteMany({
      where: { createdAt: { lt: new Date(Date.now() - 90 * DAY_MS) } },
    });
  }

  // ─────────────────────────────────────────────
  // TWO-PERSON RULE
  // ─────────────────────────────────────────────

  /**
   * Releasing a hold, changing retention and retrieving an archive weaken evidence, so a
   * second Super Admin must repeat the same request. The first call records the request; a
   * call by a DIFFERENT Super Admin with the same target and material fields approves it and
   * the action runs. A request expires after 24 hours and is single use.
   */
  private async twoPerson(
    kind: 'HOLD_RELEASE' | 'RETENTION_CHANGE' | 'ARCHIVE_RETRIEVAL',
    targetKey: string,
    material: Record<string, unknown>,
    reason: string | undefined,
    actor: CurrentUserDto,
  ): Promise<{
    approved: boolean;
    requestId?: string;
    requestedById?: string;
    response?: Record<string, unknown>;
  }> {
    const actorId = this.requireUserId(actor);
    const now = new Date();
    const payloadHash = createHash('sha256')
      .update(`${kind}|${targetKey}|${this.stable(material)}`)
      .digest('hex');

    await this.prisma.auditApprovalRequest.updateMany({
      where: { status: 'PENDING', expiresAt: { lt: now } },
      data: { status: 'EXPIRED' },
    });

    const pending = await this.prisma.auditApprovalRequest.findFirst({
      where: { kind, targetKey, payloadHash, status: 'PENDING', expiresAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
    });

    if (!pending) {
      const created = await this.prisma.auditApprovalRequest.create({
        data: {
          kind,
          targetKey,
          payloadHash,
          payload: material as Prisma.InputJsonValue,
          reason: reason ?? null,
          requestedById: actorId,
          expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS),
        },
      });
      await this.auditSelf(actor, {
        action: AuditEventEnum.AUDIT_APPROVAL_REQUESTED,
        entity: 'AuditApprovalRequest',
        entityId: created.id,
        entityLabel: `${kind} ${targetKey}`,
        severity: AuditSeverity.WARNING,
        reason,
        metadata: { kind, targetKey },
      });
      return {
        approved: false,
        response: {
          status: 'APPROVAL_REQUIRED',
          kind,
          requestId: created.id,
          expiresAt: created.expiresAt.toISOString(),
          message: 'A second Super Admin must send the same request to approve it.',
        },
      };
    }

    if (pending.requestedById === actorId) {
      return {
        approved: false,
        response: {
          status: 'AWAITING_SECOND_APPROVER',
          kind,
          requestId: pending.id,
          expiresAt: pending.expiresAt.toISOString(),
          message: 'You already requested this. A different Super Admin must approve it.',
        },
      };
    }

    const claimed = await this.prisma.auditApprovalRequest.updateMany({
      where: { id: pending.id, status: 'PENDING' },
      data: { status: 'CONSUMED', approvedById: actorId, decidedAt: now },
    });
    if (claimed.count === 0) throw new ConflictException('approval_already_used');

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_APPROVAL_GRANTED,
      entity: 'AuditApprovalRequest',
      entityId: pending.id,
      entityLabel: `${kind} ${targetKey}`,
      severity: AuditSeverity.WARNING,
      metadata: { kind, targetKey, requestedById: pending.requestedById },
    });

    return { approved: true, requestId: pending.id, requestedById: pending.requestedById };
  }

  private stable(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((v) => this.stable(v)).join(',')}]`;
    if (value && typeof value === 'object') {
      return `{${Object.keys(value as object)
        .sort()
        .map((k) => `${JSON.stringify(k)}:${this.stable((value as Record<string, unknown>)[k])}`)
        .join(',')}}`;
    }
    return JSON.stringify(value ?? null);
  }

  // ─────────────────────────────────────────────
  // 1. LEGAL HOLD
  // ─────────────────────────────────────────────

  /** One place that turns a stored hold filter into a row query. Rejects an empty filter. */
  private holdWhere(f: HoldFilter): Prisma.AuditLogWhereInput {
    const where: Prisma.AuditLogWhereInput = {
      ...(f.rowId && { id: f.rowId }),
      ...(f.entity && { entity: f.entity }),
      ...(f.entityId && { entityId: f.entityId }),
      ...(f.userId && { userId: f.userId }),
      ...(f.targetUserId && { targetUserId: f.targetUserId }),
      ...(f.action && { action: f.action }),
      ...(f.sessionId && { sessionId: f.sessionId }),
      ...(f.requestId && { requestId: f.requestId }),
      ...((f.startDate || f.endDate) && {
        createdAt: {
          ...(f.startDate && { gte: new Date(f.startDate) }),
          ...(f.endDate && { lte: new Date(f.endDate) }),
        },
      }),
    };
    if (Object.keys(where).length === 0) throw new BadRequestException('hold_filter_needs_at_least_one_condition');
    if (f.startDate && f.endDate && new Date(f.startDate) > new Date(f.endDate)) {
      throw new BadRequestException('startDate_after_endDate');
    }
    return where;
  }

  private cleanHoldFilter(f: HoldFilter): HoldFilter {
    return Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined && v !== null && v !== '')) as HoldFilter;
  }

  /** AL-01 */
  async setRowLegalHold(id: string, dto: SetRowLegalHoldDto, actor: CurrentUserDto) {
    const row = await this.prisma.auditLog.findUnique({
      where: { id },
      select: { id: true, legalHold: true, action: true },
    });
    if (!row) throw new NotFoundException('Audit log not found');
    const reason = dto.reason.trim();

    if (dto.legalHold) {
      if (!dto.caseReference?.trim()) throw new BadRequestException('caseReference_required_to_set_a_hold');
      const caseReference = dto.caseReference.trim();

      const hold = await this.prisma.$transaction(async (tx) => {
        const created = await tx.auditLegalHold.create({
          data: {
            kind: 'ROW',
            caseReference,
            reason,
            filter: { rowId: id } as Prisma.InputJsonValue,
            rowCount: 1,
            createdById: actor.id,
          },
        });
        await tx.auditLog.update({ where: { id }, data: { legalHold: true } });
        return created;
      });

      await this.auditSelf(actor, {
        action: AuditEventEnum.AUDIT_LEGAL_HOLD_SET,
        entity: 'AuditLegalHold',
        entityId: hold.id,
        entityLabel: caseReference,
        severity: AuditSeverity.WARNING,
        reason,
        metadata: { kind: 'ROW', auditLogId: id },
      });
      return { id, legalHold: true, holdId: hold.id };
    }

    // Clearing: weakens evidence, so a second Super Admin must approve.
    if (!this.isSuperAdmin(actor)) throw new ForbiddenException('only_super_admin_can_clear_a_hold');
    const active = await this.prisma.auditLegalHold.findMany({ where: { status: 'ACTIVE' } });
    const covering: typeof active = [];
    for (const h of active) {
      const covers = await this.prisma.auditLog.count({
        where: { AND: [{ id }, this.holdWhere(h.filter as HoldFilter)] },
      });
      if (covers > 0) covering.push(h);
    }
    if (!row.legalHold && covering.length === 0) return { id, legalHold: false, changed: false };
    if (covering.some((h) => h.kind !== 'ROW')) {
      throw new ConflictException({
        message: 'row_is_covered_by_a_filter_hold_release_that_hold_instead',
        holdIds: covering.filter((h) => h.kind !== 'ROW').map((h) => h.id),
      });
    }

    const gate = await this.twoPerson('HOLD_RELEASE', `row:${id}`, {}, reason, actor);
    if (!gate.approved) return gate.response as Record<string, unknown>;

    await this.prisma.auditLegalHold.updateMany({
      where: { id: { in: covering.map((h) => h.id) }, status: 'ACTIVE' },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        releasedById: actor.id,
        releaseRequestedById: gate.requestedById,
        releaseReason: reason,
      },
    });
    await this.prisma.auditLog.update({ where: { id }, data: { legalHold: false } });

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_LEGAL_HOLD_CLEARED,
      entity: 'AuditLegalHold',
      entityId: covering[0]?.id ?? id,
      severity: AuditSeverity.CRITICAL,
      reason,
      metadata: { kind: 'ROW', auditLogId: id, requestedById: gate.requestedById },
    });
    return { id, legalHold: false, changed: true };
  }

  /** AL-06: what a hold filter would cover. Nothing is changed. */
  async previewLegalHold(dto: PreviewLegalHoldDto) {
    const filter = this.cleanHoldFilter(dto.filter as HoldFilter);
    const where = this.holdWhere(filter);

    const [total, alreadyHeld, range, byEntity] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.count({ where: { ...where, legalHold: true } }),
      this.prisma.auditLog.aggregate({ where, _min: { createdAt: true }, _max: { createdAt: true } }),
      this.prisma.auditLog.groupBy({
        by: ['entity'],
        where,
        _count: { _all: true },
        orderBy: { _count: { entity: 'desc' } },
        take: 10,
      }),
    ]);

    return {
      filter,
      wouldCover: total,
      alreadyHeld,
      newlyHeld: total - alreadyHeld,
      oldestRowAt: range._min.createdAt,
      newestRowAt: range._max.createdAt,
      byEntity: byEntity.map((g) => ({ entity: g.entity, count: g._count._all })),
      note: 'A hold covers the rows that exist when it is applied. Rows written later are not covered.',
    };
  }

  /** AL-02 */
  async createLegalHold(dto: CreateLegalHoldDto, actor: CurrentUserDto) {
    const filter = this.cleanHoldFilter(dto.filter as HoldFilter);
    const where = this.holdWhere(filter);
    const caseReference = dto.caseReference.trim();
    const reason = dto.reason.trim();

    const matched = await this.prisma.auditLog.count({ where });
    if (matched === 0) throw new BadRequestException('filter_matches_no_rows');

    const hold = await this.prisma.$transaction(
      async (tx) => {
        const created = await tx.auditLegalHold.create({
          data: {
            kind: 'FILTER',
            caseReference,
            reason,
            filter: filter as Prisma.InputJsonValue,
            rowCount: matched,
            createdById: actor.id,
          },
        });
        await tx.auditLog.updateMany({ where: { ...where, legalHold: false }, data: { legalHold: true } });
        return created;
      },
      { timeout: 60_000 },
    );

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_LEGAL_HOLD_SET,
      entity: 'AuditLegalHold',
      entityId: hold.id,
      entityLabel: caseReference,
      severity: AuditSeverity.WARNING,
      reason,
      metadata: { kind: 'FILTER', filter, rowCount: matched },
    });

    return { holdId: hold.id, caseReference, rowCount: matched, appliedAt: hold.appliedAt };
  }

  /** AL-03 */
  async listLegalHolds(query: LegalHoldsQueryDto) {
    const where: Prisma.AuditLegalHoldWhereInput = {
      ...(query.status && { status: query.status }),
      ...(query.caseReference && { caseReference: { contains: query.caseReference, mode: 'insensitive' } }),
    };
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;

    const [rows, total] = await Promise.all([
      this.prisma.auditLegalHold.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditLegalHold.count({ where }),
    ]);

    const names = await this.userNames(rows.flatMap((r) => [r.createdById, r.releasedById]));
    return {
      data: rows.map((h) => ({
        id: h.id,
        kind: h.kind,
        caseReference: h.caseReference,
        reason: h.reason,
        status: h.status,
        rowCount: h.rowCount,
        appliedAt: h.appliedAt,
        createdById: h.createdById,
        createdByName: h.createdById ? (names.get(h.createdById) ?? null) : null,
        releasedAt: h.releasedAt,
        releasedById: h.releasedById,
        releasedByName: h.releasedById ? (names.get(h.releasedById) ?? null) : null,
      })),
      meta: this.offsetMetaFor(page, limit, total, rows.length),
    };
  }

  private async findHold(holdId: string) {
    const hold = await this.prisma.auditLegalHold.findUnique({ where: { id: holdId } });
    if (!hold) throw new NotFoundException('Legal hold not found');
    return hold;
  }

  /** AL-04: one hold with its filter and a page of the rows it covers. */
  async getLegalHold(holdId: string, dto: AuditPagingDto, viewer: CurrentUserDto) {
    const hold = await this.findHold(holdId);
    const where = this.holdWhere(hold.filter as HoldFilter);
    const [affected, stillHeld] = await Promise.all([
      this.paginate({ AND: [where, { createdAt: { lte: hold.appliedAt } }] }, dto, viewer),
      hold.status === 'ACTIVE'
        ? this.prisma.auditLog.count({ where: { AND: [where, { legalHold: true }] } })
        : Promise.resolve(null),
    ]);

    return {
      hold: {
        id: hold.id,
        kind: hold.kind,
        caseReference: hold.caseReference,
        reason: hold.reason,
        status: hold.status,
        filter: hold.filter,
        rowCount: hold.rowCount,
        appliedAt: hold.appliedAt,
        releasedAt: hold.releasedAt,
        releaseReason: hold.releaseReason,
      },
      currentlyHeldRows: stillHeld,
      affectedRows: affected,
    };
  }

  /** AL-05: needs a second Super Admin. Rows covered by another active hold stay held. */
  async releaseLegalHold(holdId: string, dto: ReleaseLegalHoldDto, actor: CurrentUserDto) {
    const hold = await this.findHold(holdId);
    if (hold.status !== 'ACTIVE') throw new ConflictException('hold_already_released');
    const reason = dto.reason.trim();

    const gate = await this.twoPerson('HOLD_RELEASE', `hold:${holdId}`, {}, reason, actor);
    if (!gate.approved) return gate.response as Record<string, unknown>;

    const released = await this.prisma.auditLegalHold.updateMany({
      where: { id: holdId, status: 'ACTIVE' },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        releasedById: actor.id,
        releaseRequestedById: gate.requestedById,
        releaseReason: reason,
      },
    });
    if (released.count === 0) throw new ConflictException('hold_already_released');

    const releasedWhere = this.holdWhere(hold.filter as HoldFilter);
    const cleared = await this.prisma.auditLog.updateMany({
      where: { AND: [releasedWhere, { legalHold: true }] },
      data: { legalHold: false },
    });

    // Anything another active hold still covers goes back on hold.
    const others = await this.prisma.auditLegalHold.findMany({ where: { status: 'ACTIVE' } });
    let reapplied = 0;
    for (const o of others) {
      const r = await this.prisma.auditLog.updateMany({
        where: { AND: [releasedWhere, this.holdWhere(o.filter as HoldFilter), { legalHold: false }] },
        data: { legalHold: true },
      });
      reapplied += r.count;
    }

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_LEGAL_HOLD_RELEASED,
      entity: 'AuditLegalHold',
      entityId: holdId,
      entityLabel: hold.caseReference,
      severity: AuditSeverity.CRITICAL,
      reason,
      metadata: {
        clearedRows: cleared.count,
        keptByOtherHolds: reapplied,
        requestedById: gate.requestedById,
      },
    });

    return { holdId, status: 'RELEASED', clearedRows: cleared.count - reapplied, keptByOtherHolds: reapplied };
  }

  /** AL-07: who created, changed and released a hold. Read from the audit log itself. */
  async getLegalHoldHistory(holdId: string, dto: AuditPagingDto, viewer: CurrentUserDto) {
    await this.findHold(holdId);
    return this.paginate({ entity: 'AuditLegalHold', entityId: holdId }, dto, viewer, 'asc');
  }

  // ─────────────────────────────────────────────
  // 2. PURGE AND RETENTION
  // ─────────────────────────────────────────────

  /** AL-08 */
  async listPurgeRuns(query: PurgeRunsQueryDto) {
    const where: Prisma.AuditPurgeRunWhereInput = { ...(query.status && { status: query.status }) };
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;

    const [rows, total] = await Promise.all([
      this.prisma.auditPurgeRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          cutoff: true,
          reason: true,
          status: true,
          requestedById: true,
          archivedCount: true,
          deletedCount: true,
          heldCount: true,
          error: true,
          createdAt: true,
          finishedAt: true,
        },
      }),
      this.prisma.auditPurgeRun.count({ where }),
    ]);

    const names = await this.userNames(rows.map((r) => r.requestedById));
    return {
      data: rows.map((r) => ({
        ...r,
        requestedByName: r.requestedById ? (names.get(r.requestedById) ?? null) : null,
      })),
      meta: this.offsetMetaFor(page, limit, total, rows.length),
    };
  }

  /** AL-09 */
  async getPurgeRun(id: string) {
    const run = await this.prisma.auditPurgeRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Purge run not found');
    const names = await this.userNames([run.requestedById]);
    // tokenId is the single-use confirm token id: never shown.
    const { tokenId: _tokenId, ...safe } = run;
    return {
      ...safe,
      requestedByName: run.requestedById ? (names.get(run.requestedById) ?? null) : null,
      skippedBecauseOfLegalHold: run.heldCount,
    };
  }

  /**
   * AL-10: unredacted archived rows from cold storage, as short-lived download links.
   * A second Super Admin must approve, and the retrieval is audited before any link is issued.
   */
  async retrievePurgeArchive(id: string, actor: CurrentUserDto) {
    const run = await this.prisma.auditPurgeRun.findUnique({ where: { id } });
    if (!run) throw new NotFoundException('Purge run not found');
    if (!run.archiveKey) throw new ConflictException('run_has_no_archive');
    if (!this.objectStorage) throw new ServiceUnavailableException('object_storage_not_configured');

    const gate = await this.twoPerson('ARCHIVE_RETRIEVAL', `run:${id}`, {}, undefined, actor);
    if (!gate.approved) return gate.response as Record<string, unknown>;

    let parts: Array<{ key: string; rows: number; bytes: number }> = [];
    try {
      const manifest = JSON.parse((await this.objectStorage.getBuffer(run.archiveKey)).toString('utf8'));
      parts = Array.isArray(manifest.parts) ? manifest.parts : [];
    } catch (err) {
      this.logger.error(`Archive manifest unreadable for run ${id}: ${this.errMsg(err)}`);
      throw new ServiceUnavailableException('archive_manifest_unreadable');
    }

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_ARCHIVE_RETRIEVED,
      entity: 'AuditPurgeRun',
      entityId: id,
      severity: AuditSeverity.CRITICAL,
      metadata: { parts: parts.length, archivedCount: run.archivedCount, requestedById: gate.requestedById },
    });

    const files = await Promise.all(
      parts.map(async (p, i) => ({
        name: `part-${String(i + 1).padStart(5, '0')}.ndjson.gz`,
        rows: p.rows,
        bytes: p.bytes,
        url: await this.objectStorage!.presignGet(p.key, ARCHIVE_LINK_TTL_SECONDS),
      })),
    );
    return {
      runId: id,
      format: 'ndjson.gz',
      redacted: false,
      linkExpiresAt: new Date(Date.now() + ARCHIVE_LINK_TTL_SECONDS * 1000).toISOString(),
      files,
    };
  }

  /** AL-11: the purge runs on its own at runAt, which gives other admins time to object. */
  async schedulePurge(dto: SchedulePurgeDto, actor: CurrentUserDto) {
    const olderThan = this.parseCutoff(dto.olderThan);
    const runAt = new Date(dto.runAt);
    if (isNaN(runAt.getTime())) throw new BadRequestException('invalid_runAt');

    const minNoticeHours = Number(process.env.AUDIT_PURGE_MIN_NOTICE_HOURS ?? 72);
    if (runAt.getTime() < Date.now() + minNoticeHours * 3_600_000) {
      throw new BadRequestException(`runAt_needs_at_least_${minNoticeHours}_hours_notice`);
    }
    if (runAt.getTime() > Date.now() + 365 * DAY_MS) throw new BadRequestException('runAt_too_far_ahead');
    if (!this.archive) throw new ServiceUnavailableException('audit_archive_not_configured');
    this.tokenSecret(); // fails closed when purge is not configured

    const schedule = await this.prisma.auditPurgeSchedule.create({
      data: {
        olderThan,
        runAt,
        reason: dto.reason.trim(),
        createdById: this.requireUserId(actor),
      },
    });

    const wouldDelete = await this.prisma.auditLog.count({ where: { createdAt: { lt: olderThan }, legalHold: false } });
    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_PURGE_SCHEDULED,
      entity: 'AuditPurgeSchedule',
      entityId: schedule.id,
      severity: AuditSeverity.CRITICAL,
      reason: dto.reason.trim(),
      metadata: { olderThan: olderThan.toISOString(), runAt: runAt.toISOString(), wouldDeleteToday: wouldDelete },
    });

    return { ...schedule, wouldDeleteToday: wouldDelete };
  }

  /** AL-12 */
  async listPurgeSchedule(query: PurgeScheduleQueryDto) {
    const where: Prisma.AuditPurgeScheduleWhereInput = { status: query.status ?? 'SCHEDULED' };
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;

    const [rows, total] = await Promise.all([
      this.prisma.auditPurgeSchedule.findMany({
        where,
        orderBy: [{ runAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditPurgeSchedule.count({ where }),
    ]);
    const names = await this.userNames(rows.map((r) => r.createdById));
    return {
      data: rows.map((r) => ({ ...r, createdByName: names.get(r.createdById) ?? null })),
      meta: this.offsetMetaFor(page, limit, total, rows.length),
    };
  }

  /** AL-13: only works before it starts. */
  async cancelPurgeSchedule(id: string, dto: CancelPurgeScheduleDto, actor: CurrentUserDto) {
    const existing = await this.prisma.auditPurgeSchedule.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('Scheduled purge not found');

    const result = await this.prisma.auditPurgeSchedule.updateMany({
      where: { id, status: 'SCHEDULED' },
      data: {
        status: 'CANCELLED',
        cancelledById: this.requireUserId(actor),
        cancelReason: dto.reason.trim(),
        cancelledAt: new Date(),
      },
    });
    if (result.count === 0) throw new ConflictException('purge_already_started_or_finished');

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_PURGE_SCHEDULE_CANCELLED,
      entity: 'AuditPurgeSchedule',
      entityId: id,
      severity: AuditSeverity.WARNING,
      reason: dto.reason.trim(),
    });
    return { id, cancelled: true };
  }

  /** AL-14 */
  async getRetention() {
    const rows = await this.prisma.auditRetentionPolicy.findMany({ orderBy: [{ scope: 'asc' }, { key: 'asc' }] });
    const defaultRow = rows.find((r) => r.scope === 'DEFAULT');
    return {
      default: defaultRow?.retentionDays ?? null,
      byEntity: rows.filter((r) => r.scope === 'ENTITY').map((r) => ({ entity: r.key, retentionDays: r.retentionDays })),
      bySeverity: rows.filter((r) => r.scope === 'SEVERITY').map((r) => ({ severity: r.key, retentionDays: r.retentionDays })),
      enforcement:
        'Declared policy. Rows are only removed by a purge (manual or scheduled), and rows under legal hold are always kept.',
      updatedAt: rows.reduce<Date | null>((m, r) => (!m || r.updatedAt > m ? r.updatedAt : m), null),
    };
  }

  /** AL-15: needs a second Super Admin to send the same policies. */
  async updateRetention(dto: UpdateRetentionDto, actor: CurrentUserDto) {
    const severities = Object.values(AuditSeverity) as string[];
    const seen = new Set<string>();
    for (const p of dto.policies) {
      const k = `${p.scope}:${p.key}`;
      if (seen.has(k)) throw new BadRequestException('duplicate_policy');
      seen.add(k);
      if (p.scope === 'DEFAULT' && p.key !== 'DEFAULT') throw new BadRequestException("DEFAULT_policy_key_must_be_'DEFAULT'");
      if (p.scope === 'SEVERITY' && !severities.includes(p.key)) throw new BadRequestException('unknown_severity');
    }

    const reason = dto.reason.trim();
    const material = { policies: [...dto.policies].sort((a, b) => `${a.scope}${a.key}`.localeCompare(`${b.scope}${b.key}`)) };
    const gate = await this.twoPerson('RETENTION_CHANGE', 'retention', material, reason, actor);
    if (!gate.approved) return gate.response as Record<string, unknown>;

    const before = await this.getRetention();
    await this.prisma.$transaction(
      dto.policies.map((p) =>
        this.prisma.auditRetentionPolicy.upsert({
          where: { scope_key: { scope: p.scope, key: p.key } },
          create: { scope: p.scope, key: p.key, retentionDays: p.retentionDays, updatedById: actor.id },
          update: { retentionDays: p.retentionDays, updatedById: actor.id },
        }),
      ),
    );
    const after = await this.getRetention();

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_RETENTION_CHANGED,
      entity: 'AuditRetentionPolicy',
      severity: AuditSeverity.CRITICAL,
      reason,
      diff: { before, after },
      metadata: { requestedById: gate.requestedById },
    });
    return after;
  }

  /** AL-16 */
  async listAnonymizations(dto: AuditPagingDto, viewer: CurrentUserDto) {
    return this.paginate({ action: AuditEventEnum.AUDIT_LOG_ANONYMIZED }, dto, viewer);
  }

  // ─────────────────────────────────────────────
  // 3. INTEGRITY
  // ─────────────────────────────────────────────

  /** NEW HOOK: every verification is kept, so history and breaks can be listed. Never fails the check. */
  private async saveIntegrityRun(
    trigger: 'MANUAL' | 'SCHEDULED',
    actor: CurrentUserDto,
    report: IntegrityReport,
  ) {
    try {
      await this.prisma.auditIntegrityRun.create({
        data: {
          trigger,
          requestedById: actor.id ?? null,
          ok: report.ok,
          complete: report.complete,
          checked: report.checked,
          unchainedRows: report.unchainedRows,
          rangeFrom: report.from ? new Date(report.from) : null,
          rangeTo: report.to ? new Date(report.to) : null,
          firstBreak: (report.firstBreak ?? Prisma.DbNull) as Prisma.InputJsonValue,
          head: (report.head ?? Prisma.DbNull) as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      this.logger.error(`Could not save integrity run: ${this.errMsg(err)}`);
    }
  }

  /** AL-17 */
  async listIntegrityRuns(query: IntegrityRunsQueryDto) {
    const where: Prisma.AuditIntegrityRunWhereInput = { ...(query.ok !== undefined && { ok: query.ok }) };
    const page = query.page ?? 1;
    const limit = query.limit ?? DEFAULT_LIMIT;

    const [rows, total] = await Promise.all([
      this.prisma.auditIntegrityRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditIntegrityRun.count({ where }),
    ]);
    return { data: rows, meta: this.offsetMetaFor(page, limit, total, rows.length) };
  }

  /** AL-18 */
  async setIntegritySchedule(dto: IntegrityScheduleDto, actor: CurrentUserDto) {
    const before = await this.prisma.auditIntegritySchedule.findUnique({ where: { id: 'default' } });
    const intervalHours = dto.intervalHours ?? before?.intervalHours ?? 24;
    const nextRunAt = dto.enabled ? new Date(Date.now() + 60_000) : null;

    const after = await this.prisma.auditIntegritySchedule.upsert({
      where: { id: 'default' },
      create: { id: 'default', enabled: dto.enabled, intervalHours, nextRunAt, updatedById: actor.id },
      update: { enabled: dto.enabled, intervalHours, nextRunAt, updatedById: actor.id },
    });

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_INTEGRITY_SCHEDULE_CHANGED,
      entity: 'AuditIntegritySchedule',
      entityId: 'default',
      severity: AuditSeverity.WARNING,
      diff: {
        before: before ? { enabled: before.enabled, intervalHours: before.intervalHours } : null,
        after: { enabled: after.enabled, intervalHours: after.intervalHours },
      },
    });
    return after;
  }

  /** AL-19: runs that found a break, with the first affected row. */
  async listIntegrityBreaks(dto: AuditPagingDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? DEFAULT_LIMIT;
    const where: Prisma.AuditIntegrityRunWhereInput = { ok: false };

    const [rows, total] = await Promise.all([
      this.prisma.auditIntegrityRun.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.auditIntegrityRun.count({ where }),
    ]);
    return {
      data: rows.map((r) => ({
        runId: r.id,
        foundAt: r.createdAt,
        trigger: r.trigger,
        checked: r.checked,
        firstBreak: r.firstBreak,
      })),
      meta: this.offsetMetaFor(page, limit, total, rows.length),
    };
  }

  /** AL-20 */
  async getHealthHistory(query: HealthHistoryQueryDto) {
    const hours = query.hours ?? 24;
    const since = new Date(Date.now() - hours * 3_600_000);
    const [snapshots, current] = await Promise.all([
      this.prisma.auditHealthSnapshot.findMany({ where: { createdAt: { gte: since } }, orderBy: { createdAt: 'asc' }, take: 2000 }),
      this.getHealth(),
    ]);
    return {
      hours,
      since: since.toISOString(),
      current,
      data: snapshots.map((s) => ({
        at: s.createdAt,
        lastWriteAt: s.lastWriteAt,
        lagSeconds: s.lagSeconds,
        // Audit writes are direct (no queue), so there is no depth to report.
        queueDepth: null,
        writeFailuresSinceProcessStart: s.writeFailures,
        estimatedRows: s.estimatedRows,
        sizeBytes: s.sizeBytes,
        unchainedRows: s.unchainedRows,
      })),
    };
  }

  // ─────────────────────────────────────────────
  // 4. ALERT RULES
  // ─────────────────────────────────────────────

  private async requireAlert(id: string) {
    const alert = await this.prisma.auditAlert.findUnique({ where: { id } });
    if (!alert) throw new NotFoundException('Alert rule not found');
    return alert;
  }

  /** AL-21 */
  async getAlert(id: string) {
    const alert = await this.requireAlert(id);
    const [triggerCount, unacknowledged] = await Promise.all([
      this.prisma.auditAlertTrigger.count({ where: { alertId: id } }),
      this.prisma.auditAlertTrigger.count({ where: { alertId: id, acknowledgedAt: null } }),
    ]);
    return { ...alert, triggerCount, unacknowledgedTriggers: unacknowledged };
  }

  /** AL-22 */
  async listAlertTriggers(id: string, dto: AuditPagingDto) {
    await this.requireAlert(id);
    return this.triggerPage({ alertId: id }, dto);
  }

  private async triggerPage(where: Prisma.AuditAlertTriggerWhereInput, dto: AuditPagingDto) {
    const page = dto.page ?? 1;
    const limit = dto.limit ?? DEFAULT_LIMIT;
    const [rows, total] = await Promise.all([
      this.prisma.auditAlertTrigger.findMany({
        where,
        orderBy: [{ firedAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: { alert: { select: { name: true, action: true, entity: true, severity: true } } },
      }),
      this.prisma.auditAlertTrigger.count({ where }),
    ]);
    return { data: rows, meta: this.offsetMetaFor(page, limit, total, rows.length) };
  }

  /** AL-23: replays a rule over recent data. Nothing is recorded or sent. */
  async testAlert(id: string, dto: TestAlertDto, actor: CurrentUserDto) {
    const alert = await this.requireAlert(id);
    const hours = dto.hours ?? 24;
    const to = new Date();
    const from = new Date(to.getTime() - hours * 3_600_000);

    const rows = await this.prisma.auditLog.findMany({
      where: this.alertWhere(alert, from, to),
      orderBy: { createdAt: 'asc' },
      take: 50_000,
      select: { createdAt: true },
    });

    // Slide through the events: fire when the window holds `threshold` events and the cooldown has passed.
    const windowMs = alert.windowMinutes * 60_000;
    const cooldownMs = alert.cooldownMinutes * 60_000;
    const times = rows.map((r) => r.createdAt.getTime());
    const fires: Array<{ at: string; matchCount: number }> = [];
    let left = 0;
    let lastFire = -Infinity;
    for (let right = 0; right < times.length; right++) {
      while (times[right] - times[left] > windowMs) left++;
      const count = right - left + 1;
      if (count >= alert.threshold && times[right] - lastFire >= cooldownMs) {
        fires.push({ at: new Date(times[right]).toISOString(), matchCount: count });
        lastFire = times[right];
      }
    }

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_ALERT_TESTED,
      entity: 'AuditAlert',
      entityId: id,
      entityLabel: alert.name,
      metadata: { hours, matched: rows.length, wouldHaveFired: fires.length },
    });

    return {
      alertId: id,
      replayedHours: hours,
      matchingEvents: rows.length,
      truncated: rows.length >= 50_000,
      wouldHaveFired: fires.length,
      firesPerDay: Number(((fires.length / hours) * 24).toFixed(2)),
      sample: fires.slice(0, 20),
    };
  }

  /** AL-24 and AL-25 */
  async setAlertEnabled(id: string, enabled: boolean, actor: CurrentUserDto) {
    const before = await this.requireAlert(id);
    if (before.enabled === enabled) return before;

    const after = await this.prisma.auditAlert.update({ where: { id }, data: { enabled } });
    await this.auditSelf(actor, {
      action: enabled ? AuditEventEnum.AUDIT_ALERT_ENABLED : AuditEventEnum.AUDIT_ALERT_DISABLED,
      entity: 'AuditAlert',
      entityId: id,
      entityLabel: after.name,
      diff: { before: { enabled: before.enabled }, after: { enabled } },
    });
    return after;
  }

  /** AL-26 */
  async acknowledgeTrigger(triggerId: string, dto: AcknowledgeTriggerDto, actor: CurrentUserDto) {
    const trigger = await this.prisma.auditAlertTrigger.findUnique({ where: { id: triggerId } });
    if (!trigger) throw new NotFoundException('Alert trigger not found');

    const result = await this.prisma.auditAlertTrigger.updateMany({
      where: { id: triggerId, acknowledgedAt: null },
      data: {
        acknowledgedAt: new Date(),
        acknowledgedById: this.requireUserId(actor),
        acknowledgeNote: dto.note?.trim() || null,
      },
    });
    if (result.count === 0) throw new ConflictException('trigger_already_acknowledged');

    await this.auditSelf(actor, {
      action: AuditEventEnum.AUDIT_ALERT_ACKNOWLEDGED,
      entity: 'AuditAlert',
      entityId: trigger.alertId,
      metadata: { triggerId, note: dto.note?.trim() ?? null },
    });
    return { triggerId, acknowledged: true };
  }

  /** AL-27: queue of unacknowledged triggers (set acknowledged=true to see the done ones). */
  async listTriggerQueue(query: AlertTriggersQueryDto) {
    return this.triggerPage(
      {
        ...(query.alertId && { alertId: query.alertId }),
        acknowledgedAt: query.acknowledged === true ? { not: null } : null,
      },
      query,
    );
  }

  /** AL-28 */
  listAlertTemplates() {
    return ALERT_TEMPLATES.map((t) => ({ ...t }));
  }

  /** AL-29 */
  async applyAlertTemplate(templateId: string, dto: ApplyAlertTemplateDto, actor: CurrentUserDto) {
    const t = ALERT_TEMPLATES.find((x) => x.id === templateId);
    if (!t) throw new NotFoundException('Alert template not found');

    return this.createAlert(
      {
        name: dto.name ?? t.name,
        enabled: true,
        action: t.action,
        entity: t.entity,
        outcome: t.outcome,
        severity: t.severity,
        threshold: dto.threshold ?? t.threshold,
        windowMinutes: dto.windowMinutes ?? t.windowMinutes,
        cooldownMinutes: dto.cooldownMinutes ?? t.cooldownMinutes,
      } as CreateAuditAlertDto,
      actor,
    );
  }

  // ─────────────────────────────────────────────
  // 5. SAVED FILTERS
  // ─────────────────────────────────────────────

  /** The owner, or someone it was shared with. Everyone else gets 404. */
  private async accessibleFilter(id: string, viewer: CurrentUserDto) {
    const userId = this.requireUserId(viewer);
    const found = await this.prisma.auditSavedFilter.findFirst({
      where: {
        id,
        OR: [{ userId }, { sharedWithAdmins: true }, { shares: { some: { userId } } }],
      },
    });
    if (!found) throw new NotFoundException('Saved filter not found');
    return found;
  }

  /** AL-30 */
  async getSavedFilter(id: string, viewer: CurrentUserDto) {
    const filter = await this.accessibleFilter(id, viewer);
    const isOwner = filter.userId === viewer.id;
    const shares = isOwner
      ? await this.prisma.auditSavedFilterShare.findMany({ where: { filterId: id }, select: { userId: true } })
      : [];
    return {
      ...filter,
      isOwner,
      ...(isOwner && { sharedWithUserIds: shares.map((s) => s.userId) }),
    };
  }

  /** AL-31 */
  async updateSavedFilter(id: string, dto: UpdateSavedFilterDto, viewer: CurrentUserDto) {
    const existing = await this.prisma.auditSavedFilter.findFirst({
      where: { id, userId: this.requireUserId(viewer) },
    });
    if (!existing) throw new NotFoundException('Saved filter not found');
    if (dto.name === undefined && dto.filter === undefined) throw new BadRequestException('nothing_to_update');

    try {
      return await this.prisma.auditSavedFilter.update({
        where: { id },
        data: {
          ...(dto.name !== undefined && { name: dto.name }),
          ...(dto.filter !== undefined && { filter: dto.filter as unknown as Prisma.InputJsonValue }),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('saved_filter_name_already_exists');
      }
      throw err;
    }
  }

  /** AL-32: omit userIds to share with every admin. Only admins can receive a share. */
  async shareSavedFilter(id: string, dto: ShareSavedFilterDto, viewer: CurrentUserDto) {
    const owned = await this.prisma.auditSavedFilter.findFirst({
      where: { id, userId: this.requireUserId(viewer) },
    });
    if (!owned) throw new NotFoundException('Saved filter not found');

    if (!dto.userIds?.length) {
      await this.prisma.auditSavedFilter.update({ where: { id }, data: { sharedWithAdmins: true } });
      await this.auditSelf(viewer, {
        action: AuditEventEnum.AUDIT_SAVED_FILTER_SHARED,
        entity: 'AuditSavedFilter',
        entityId: id,
        entityLabel: owned.name,
        metadata: { with: 'ALL_ADMINS' },
      });
      return { id, sharedWithAllAdmins: true };
    }

    const ids = [...new Set(dto.userIds)].filter((u) => u !== viewer.id);
    const admins = await this.prisma.user.findMany({
      where: {
        id: { in: ids },
        isActive: true,
        userRoles: { some: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] } } } },
      },
      select: { id: true },
    });
    if (admins.length !== ids.length) throw new BadRequestException('can_only_share_with_active_admins');

    await this.prisma.auditSavedFilterShare.createMany({
      data: admins.map((a) => ({ filterId: id, userId: a.id })),
      skipDuplicates: true,
    });
    await this.auditSelf(viewer, {
      action: AuditEventEnum.AUDIT_SAVED_FILTER_SHARED,
      entity: 'AuditSavedFilter',
      entityId: id,
      entityLabel: owned.name,
      metadata: { withCount: admins.length },
    });
    return { id, sharedWith: admins.map((a) => a.id) };
  }

  /** AL-33: omit userIds to stop sharing completely. */
  async unshareSavedFilter(id: string, dto: UnshareSavedFilterDto, viewer: CurrentUserDto) {
    const owned = await this.prisma.auditSavedFilter.findFirst({
      where: { id, userId: this.requireUserId(viewer) },
    });
    if (!owned) throw new NotFoundException('Saved filter not found');

    if (!dto.userIds?.length) {
      const [, removed] = await this.prisma.$transaction([
        this.prisma.auditSavedFilter.update({ where: { id }, data: { sharedWithAdmins: false } }),
        this.prisma.auditSavedFilterShare.deleteMany({ where: { filterId: id } }),
      ]);
      await this.auditSelf(viewer, {
        action: AuditEventEnum.AUDIT_SAVED_FILTER_UNSHARED,
        entity: 'AuditSavedFilter',
        entityId: id,
        entityLabel: owned.name,
        metadata: { removed: removed.count },
      });
      return { id, shared: false, removed: removed.count };
    }

    const removed = await this.prisma.auditSavedFilterShare.deleteMany({
      where: { filterId: id, userId: { in: dto.userIds } },
    });
    await this.auditSelf(viewer, {
      action: AuditEventEnum.AUDIT_SAVED_FILTER_UNSHARED,
      entity: 'AuditSavedFilter',
      entityId: id,
      entityLabel: owned.name,
      metadata: { removed: removed.count },
    });
    return { id, removed: removed.count };
  }

  /** AL-34: runs the saved filter with the caller's own redaction level and paging. */
  async runSavedFilter(id: string, dto: AuditPagingDto, viewer: CurrentUserDto): Promise<AuditPage & { filterName: string }> {
    const saved = await this.accessibleFilter(id, viewer);
    const filters = saved.filter as unknown as AuditLogFiltersDto;
    const page = await this.paginate(this.buildWhere(filters, viewer), dto, viewer);
    return { ...page, filterName: saved.name };
  }

  // ─────────────────────────────────────────────
  // 6. EXPORTS
  // ─────────────────────────────────────────────

  /** AL-35 */
  async getExportRecord(id: string) {
    const record = await this.prisma.auditExport.findUnique({ where: { id } });
    if (!record) throw new NotFoundException('Export not found');
    const names = await this.userNames([record.exportedById]);
    return { ...record, exportedByName: record.exportedById ? (names.get(record.exportedById) ?? null) : null };
  }

  private auditExportColumns(superAdmin: boolean) {
    type Col = { header: string; superOnly?: boolean; value: (r: FullAuditRow) => unknown };
    const columns: Col[] = [
      { header: 'id', value: (r) => r.id },
      { header: 'createdAt', value: (r) => r.createdAt },
      { header: 'action', value: (r) => r.action },
      { header: 'outcome', value: (r) => r.outcome },
      { header: 'severity', value: (r) => r.severity },
      { header: 'actorType', value: (r) => r.actorType },
      { header: 'actorName', value: (r) => r.actorName },
      { header: 'actorRole', value: (r) => r.actorRole },
      { header: 'userId', value: (r) => r.userId },
      { header: 'userName', value: (r) => (r.anonymizedAt ? null : r.user?.name) },
      { header: 'targetUserId', value: (r) => r.targetUserId },
      { header: 'entity', value: (r) => r.entity },
      { header: 'entityId', value: (r) => r.entityId },
      { header: 'entityLabel', value: (r) => r.entityLabel },
      { header: 'reason', value: (r) => r.reason },
      { header: 'ipAddress', superOnly: true, value: (r) => r.ipAddress },
      { header: 'userAgent', superOnly: true, value: (r) => r.userAgent },
      { header: 'requestId', value: (r) => r.requestId },
      { header: 'source', value: (r) => r.source },
      { header: 'diff', value: (r) => r.diff },
      { header: 'metadata', superOnly: true, value: (r) => r.metadata },
    ];
    return columns.filter((c) => superAdmin || !c.superOnly);
  }

  /** AL-36: background export beyond the CSV cap. Same columns and redaction as the inline export. */
  async startExportJob(dto: CreateAuditExportJobDto, viewer: CurrentUserDto) {
    if (!this.exportJobs) throw new ServiceUnavailableException('export_jobs_not_configured');
    const where = this.buildWhere(dto, viewer);
    const superAdmin = this.isSuperAdmin(viewer);
    const select = this.selectFor(viewer) as typeof FULL_SELECT;
    const columns = this.auditExportColumns(superAdmin);
    const storedFilter = dto.ipAddress ? { ...dto, ipAddress: '[redacted]' } : { ...dto };
    const requestedById = this.requireUserId(viewer);

    await this.auditSelf(viewer, {
      action: AuditEventEnum.AUDIT_EXPORT_JOB_CREATED,
      entityLabel: 'background export',
      severity: AuditSeverity.WARNING,
      metadata: { filter: storedFilter },
    });

    const prisma = this.prisma;
    const job = await this.exportJobs.start({
      scope: EXPORT_SCOPE.AUDIT_LOGS,
      requestedById,
      filter: storedFilter,
      producer: {
        header: columns.map((c) => c.header),
        async *batches() {
          let cursor: string | undefined;
          const size = 5_000;
          for (;;) {
            const rows = (await prisma.auditLog.findMany({
              where,
              orderBy: { id: 'asc' },
              take: size,
              ...(cursor && { cursor: { id: cursor }, skip: 1 }),
              select,
            })) as unknown as FullAuditRow[];
            if (rows.length === 0) return;
            yield rows.map((r) => columns.map((c) => c.value(r)));
            if (rows.length < size) return;
            cursor = rows[rows.length - 1].id;
          }
        },
      },
      onCompleted: async (done) => {
        await prisma.auditExport.create({
          data: {
            exportedById: requestedById,
            filter: storedFilter as Prisma.InputJsonValue,
            rowCount: done.rowCount,
            truncated: done.truncated,
          },
        });
        await this.auditSelf(viewer, {
          action: AuditEventEnum.AUDIT_LOG_EXPORTED,
          entityLabel: `${done.rowCount} rows (background job)`,
          metadata: { jobId: done.id, filter: storedFilter, rowCount: done.rowCount, truncated: done.truncated },
        });
      },
    });

    return { jobId: job.id, status: job.status };
  }

  /** AL-37 */
  async listExportJobs(viewer: CurrentUserDto, dto: AuditPagingDto) {
    if (!this.exportJobs) throw new ServiceUnavailableException('export_jobs_not_configured');
    return this.exportJobs.list(EXPORT_SCOPE.AUDIT_LOGS, this.requireUserId(viewer), dto);
  }

  /** AL-38 */
  async getExportJob(id: string, viewer: CurrentUserDto) {
    if (!this.exportJobs) throw new ServiceUnavailableException('export_jobs_not_configured');
    return this.exportJobs.get(EXPORT_SCOPE.AUDIT_LOGS, id, this.requireUserId(viewer));
  }

  /** AL-39: short-lived links, audited before they are returned. */
  async downloadExportJob(id: string, viewer: CurrentUserDto) {
    if (!this.exportJobs) throw new ServiceUnavailableException('export_jobs_not_configured');
    const result = await this.exportJobs.downloadLinks(EXPORT_SCOPE.AUDIT_LOGS, id, this.requireUserId(viewer));

    await this.auditSelf(viewer, {
      action: AuditEventEnum.AUDIT_EXPORT_DOWNLOADED,
      entity: 'MiscExportJob',
      entityId: id,
      severity: AuditSeverity.WARNING,
      metadata: { rowCount: result.job.rowCount, parts: result.files.length },
    });
    return result;
  }

  /** AL-40: every export by every admin, with per-person totals, to review who exported what. */
  async listAllExports(dto: AuditPagingDto, viewer: CurrentUserDto) {
    const [history, perAdmin, jobs] = await Promise.all([
      this.findExportHistory(dto),
      this.prisma.auditExport.groupBy({
        by: ['exportedById'],
        _count: { _all: true },
        _sum: { rowCount: true },
        _max: { createdAt: true },
        orderBy: { _sum: { rowCount: 'desc' } },
        take: 50,
      }),
      this.prisma.miscExportJob.findMany({
        where: { scope: EXPORT_SCOPE.AUDIT_LOGS },
        orderBy: { createdAt: 'desc' },
        take: 50,
        select: { id: true, requestedById: true, status: true, rowCount: true, createdAt: true, finishedAt: true },
      }),
    ]);

    const names = await this.userNames(perAdmin.map((p) => p.exportedById));
    await this.auditSelf(viewer, {
      action: AuditEventEnum.AUDIT_ALL_EXPORTS_VIEWED,
      entityLabel: 'all exports',
    });

    return {
      ...history,
      perAdmin: perAdmin.map((p) => ({
        exportedById: p.exportedById,
        name: p.exportedById ? (names.get(p.exportedById) ?? null) : null,
        exports: p._count._all,
        totalRows: p._sum.rowCount ?? 0,
        lastExportAt: p._max.createdAt,
      })),
      backgroundJobs: jobs,
    };
  }

  // ─────────────────────────────────────────────
  // 7. VIEWS FOR USERS AND CASES
  // ─────────────────────────────────────────────

  /** Fields a normal user may see about their own events: no IP, device, request or session detail. */
  private static readonly SELF_SELECT = {
    id: true,
    createdAt: true,
    action: true,
    outcome: true,
    severity: true,
    entity: true,
    source: true,
    country: true,
    city: true,
  } as const;

  private async selfPage(where: Prisma.AuditLogWhereInput, dto: AuditPagingDto) {
    const limit = dto.limit ?? DEFAULT_LIMIT;
    const orderBy: Prisma.AuditLogOrderByWithRelationInput[] = [{ createdAt: 'desc' }, { id: 'desc' }];
    const select = AuditLogService.SELF_SELECT;

    if (!dto.cursor && dto.page !== undefined) {
      const skip = (dto.page - 1) * limit;
      const [data, total] = await Promise.all([
        this.prisma.auditLog.findMany({ where, orderBy, skip, take: limit, select }),
        this.prisma.auditLog.count({ where }),
      ]);
      return {
        data,
        meta: { page: dto.page, limit, total, totalPages: Math.ceil(total / limit), hasMore: skip + data.length < total },
      };
    }
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(dto.cursor && { cursor: { id: dto.cursor } }),
      select,
    });
    const hasMore = rows.length > limit;
    return { data: rows.slice(0, limit), meta: { limit, nextCursor: hasMore ? rows[limit].id : null, hasMore } };
  }

  private selfWhere(userId: string, q: MyActivityQueryDto): Prisma.AuditLogWhereInput {
    return {
      OR: [
        { userId },
        // Failed sign-ins against my account are recorded against me even when no session existed.
        { targetUserId: userId, action: { contains: 'LOGIN_FAILED' } },
      ],
      ...((q.startDate || q.endDate) && {
        createdAt: {
          ...(q.startDate && { gte: new Date(q.startDate) }),
          ...(q.endDate && { lte: new Date(q.endDate) }),
        },
      }),
    };
  }

  /** AL-41 */
  async findMyActivity(viewer: CurrentUserDto, q: MyActivityQueryDto) {
    return this.selfPage(this.selfWhere(this.requireUserId(viewer), q), q);
  }

  /** AL-42 */
  async findMySecurityEvents(viewer: CurrentUserDto, q: MyActivityQueryDto) {
    return this.selfPage(
      { AND: [this.selfWhere(this.requireUserId(viewer), q), this.securityWhere()] },
      q,
    );
  }

  /** Shared by the case views below: the usual filters and paging, plus a fixed condition. */
  private async scopedList(dto: GetAuditLogsDto, viewer: CurrentUserDto, fixed: Prisma.AuditLogWhereInput) {
    const { cursor, page, limit, ...filters } = dto;
    return this.paginate({ AND: [this.buildWhere(filters, viewer), fixed] }, { cursor, page, limit }, viewer);
  }

  private sensitiveWhere(): Prisma.AuditLogWhereInput {
    return {
      OR: [
        {
          action: { in: [AuditEventEnum.EXPLORER_RECORD_VIEWED, AuditEventEnum.EXPLORER_RELATION_VIEWED] },
          entity: { in: SENSITIVE_ENTITIES },
        },
        ...SENSITIVE_ACTION_KEYWORDS.map((k) => ({ action: { contains: k } })),
      ],
    };
  }

  /** AL-43: who viewed informant identity, child cases, bank details. */
  async findSensitiveAccess(dto: GetAuditLogsDto, viewer: CurrentUserDto) {
    return this.scopedList(dto, viewer, this.sensitiveWhere());
  }

  /** AL-44: role, permission and security-setting changes. */
  async findPrivilegedActions(dto: GetAuditLogsDto, viewer: CurrentUserDto) {
    return this.scopedList(dto, viewer, {
      OR: [
        { entity: { in: PRIVILEGED_ENTITIES } },
        ...PRIVILEGED_ACTION_KEYWORDS.map((k) => ({ action: { contains: k } })),
      ],
    });
  }

  /** AL-45: refunds, payout verification, disbursements and manual payments. */
  async findMoneyActions(dto: GetAuditLogsDto, viewer: CurrentUserDto) {
    return this.scopedList(dto, viewer, {
      OR: [
        { entity: { in: MONEY_ENTITIES } },
        ...MONEY_ACTION_KEYWORDS.map((k) => ({ action: { contains: k } })),
      ],
    });
  }

  /** AL-46: denied and failed events, to spot probing. */
  async findDenied(dto: GetAuditLogsDto, viewer: CurrentUserDto) {
    return this.scopedList(dto, viewer, { outcome: { in: [AuditOutcome.DENIED, AuditOutcome.FAILURE] } });
  }

  private summaryRange(q: AuditSummaryQueryDto) {
    const to = q.to ? new Date(q.to) : new Date();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY_MS);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new BadRequestException('invalid_date');
    if (from >= to) throw new BadRequestException('from_must_be_before_to');
    if (to.getTime() - from.getTime() > 365 * DAY_MS) throw new BadRequestException('range_too_large_max_365_days');
    return { from, to };
  }

  /** AL-47: counts of actions on one record by type and actor. */
  async summarizeEntity(entity: string, entityId: string, q: AuditSummaryQueryDto) {
    const { from, to } = this.summaryRange(q);
    const where: Prisma.AuditLogWhereInput = { entity, entityId, createdAt: { gte: from, lte: to } };

    const [total, byAction, byActor, byOutcome, range] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.groupBy({ by: ['action'], where, _count: { _all: true }, orderBy: { _count: { action: 'desc' } }, take: 50 }),
      this.prisma.auditLog.groupBy({
        by: ['userId', 'actorType'],
        where,
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 25,
      }),
      this.prisma.auditLog.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
      this.prisma.auditLog.aggregate({ where, _min: { createdAt: true }, _max: { createdAt: true } }),
    ]);

    const names = await this.userNames(byActor.map((g) => g.userId));
    return {
      entity,
      entityId,
      from: from.toISOString(),
      to: to.toISOString(),
      total,
      firstEventAt: range._min.createdAt,
      lastEventAt: range._max.createdAt,
      byAction: byAction.map((g) => ({ action: g.action, count: g._count._all })),
      byActor: byActor.map((g) => ({
        userId: g.userId,
        name: g.userId ? (names.get(g.userId) ?? null) : null,
        actorType: g.actorType,
        count: g._count._all,
      })),
      byOutcome: Object.fromEntries(byOutcome.map((g) => [g.outcome, g._count._all])),
    };
  }

  /** AL-48: what one user did over a period, grouped by area (entity). */
  async summarizeUser(userId: string, q: AuditSummaryQueryDto) {
    const { from, to } = this.summaryRange(q);
    const where: Prisma.AuditLogWhereInput = { userId, createdAt: { gte: from, lte: to } };

    const [user, total, byEntity, byAction, byOutcome, range] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: USER_SELECT }),
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.groupBy({ by: ['entity'], where, _count: { _all: true }, orderBy: { _count: { entity: 'desc' } }, take: 50 }),
      this.prisma.auditLog.groupBy({ by: ['action'], where, _count: { _all: true }, orderBy: { _count: { action: 'desc' } }, take: 25 }),
      this.prisma.auditLog.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
      this.prisma.auditLog.aggregate({ where, _min: { createdAt: true }, _max: { createdAt: true } }),
    ]);
    if (!user && total === 0) throw new NotFoundException('User not found');

    return {
      userId,
      name: user?.name ?? null,
      from: from.toISOString(),
      to: to.toISOString(),
      total,
      firstEventAt: range._min.createdAt,
      lastEventAt: range._max.createdAt,
      byArea: byEntity.map((g) => ({ area: g.entity, count: g._count._all })),
      topActions: byAction.map((g) => ({ action: g.action, count: g._count._all })),
      byOutcome: Object.fromEntries(byOutcome.map((g) => [g.outcome, g._count._all])),
    };
  }

  // ─────────────────────────────────────────────
  // 8. STATISTICS
  // ─────────────────────────────────────────────

  private statsRange(f: AuditStatsFilterDto) {
    const to = f.to ? new Date(f.to) : new Date();
    const from = f.from ? new Date(f.from) : new Date(to.getTime() - 30 * DAY_MS);
    if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new BadRequestException('invalid_date');
    if (from >= to) throw new BadRequestException('from_must_be_before_to');
    if (to.getTime() - from.getTime() > 365 * DAY_MS) throw new BadRequestException('range_too_large_max_365_days');
    return { from, to };
  }

  private statsWhere(f: AuditStatsFilterDto, extra: Prisma.AuditLogWhereInput = {}): Prisma.AuditLogWhereInput {
    const { from, to } = this.statsRange(f);
    return {
      createdAt: { gte: from, lte: to },
      ...(f.entity && { entity: f.entity }),
      ...(f.action && { action: f.action }),
      ...(f.actorId && { userId: f.actorId }),
      ...(f.severity && { severity: f.severity }),
      ...extra,
    };
  }

  private statsSql(f: AuditStatsFilterDto, alias = ''): Prisma.Sql[] {
    const { from, to } = this.statsRange(f);
    const c = (name: string) => Prisma.raw(`${alias}"${name}"`);
    const conds: Prisma.Sql[] = [Prisma.sql`${c('createdAt')} >= ${from}`, Prisma.sql`${c('createdAt')} <= ${to}`];
    if (f.entity) conds.push(Prisma.sql`${c('entity')} = ${f.entity}`);
    if (f.action) conds.push(Prisma.sql`${c('action')} = ${f.action}`);
    if (f.actorId) conds.push(Prisma.sql`${c('userId')} = ${f.actorId}`);
    if (f.severity) conds.push(Prisma.sql`${c('severity')} = ${f.severity}::"AuditSeverity"`);
    return conds;
  }

  /** AL-49 */
  async statsBySeverity(f: AuditStatsFilterDto) {
    const where = this.statsWhere(f);
    const groups = await this.prisma.auditLog.groupBy({ by: ['severity'], where, _count: { _all: true } });
    const data: Record<string, number> = {};
    for (const s of Object.values(AuditSeverity)) data[s] = 0;
    for (const g of groups) data[g.severity] = g._count._all;
    const { from, to } = this.statsRange(f);
    return { from: from.toISOString(), to: to.toISOString(), total: Object.values(data).reduce((a, b) => a + b, 0), data };
  }

  /** AL-50 */
  async statsByOutcome(f: AuditStatsFilterDto) {
    const where = this.statsWhere(f);
    const groups = await this.prisma.auditLog.groupBy({ by: ['outcome'], where, _count: { _all: true } });
    const data: Record<string, number> = {};
    for (const o of Object.values(AuditOutcome)) data[o] = 0;
    for (const g of groups) data[g.outcome] = g._count._all;
    const total = Object.values(data).reduce((a, b) => a + b, 0);
    const { from, to } = this.statsRange(f);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      total,
      data,
      successRate: total > 0 ? Number(((data[AuditOutcome.SUCCESS] ?? 0) / total).toFixed(4)) : null,
    };
  }

  /** AL-51: denied and failed events over time, grouped by path or action. */
  async statsDenied(f: DeniedStatsQueryDto) {
    const bucket = f.bucket ?? 'day';
    const by = f.by ?? 'action';
    const unit = Prisma.raw(`'${bucket}'`);
    const col = Prisma.raw(by === 'path' ? '"path"' : '"action"');
    const conds = [...this.statsSql(f), Prisma.sql`"outcome" IN ('DENIED', 'FAILURE')`];

    const [series, top] = await Promise.all([
      this.prisma.$queryRaw<{ bucket: Date; count: bigint }[]>`
        SELECT date_trunc(${unit}, "createdAt") AS bucket, COUNT(*)::bigint AS count
        FROM audit_log WHERE ${Prisma.join(conds, ' AND ')}
        GROUP BY 1 ORDER BY 1 ASC`,
      this.prisma.$queryRaw<{ key: string | null; count: bigint }[]>`
        SELECT ${col} AS key, COUNT(*)::bigint AS count
        FROM audit_log WHERE ${Prisma.join(conds, ' AND ')}
        GROUP BY 1 ORDER BY count DESC LIMIT 25`,
    ]);

    const { from, to } = this.statsRange(f);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
      by,
      timeline: series.map((r) => ({ bucket: r.bucket.toISOString(), count: Number(r.count) })),
      top: top.map((r) => ({ key: r.key ?? 'UNKNOWN', count: Number(r.count) })),
    };
  }

  /** AL-52: exports per admin over time, to spot unusual bulk exports. */
  async statsExportActivity(f: AuditBucketStatsQueryDto) {
    const { from, to } = this.statsRange(f);
    const bucket = f.bucket ?? 'day';
    const unit = Prisma.raw(`'${bucket}'`);
    const actor = f.actorId ? Prisma.sql`AND "exportedById" = ${f.actorId}` : Prisma.empty;

    const [series, perAdmin] = await Promise.all([
      this.prisma.$queryRaw<{ bucket: Date; exportedById: string | null; exports: bigint; rows: bigint }[]>`
        SELECT date_trunc(${unit}, "createdAt") AS bucket, "exportedById", COUNT(*)::bigint AS exports,
               COALESCE(SUM("rowCount"), 0)::bigint AS rows
        FROM audit_export
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to} ${actor}
        GROUP BY 1, 2 ORDER BY 1 ASC`,
      this.prisma.auditExport.groupBy({
        by: ['exportedById'],
        where: { createdAt: { gte: from, lte: to }, ...(f.actorId && { exportedById: f.actorId }) },
        _count: { _all: true },
        _sum: { rowCount: true },
        orderBy: { _sum: { rowCount: 'desc' } },
        take: 25,
      }),
    ]);

    const names = await this.userNames([...series.map((s) => s.exportedById), ...perAdmin.map((p) => p.exportedById)]);
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
      perAdmin: perAdmin.map((p) => ({
        exportedById: p.exportedById,
        name: p.exportedById ? (names.get(p.exportedById) ?? null) : null,
        exports: p._count._all,
        totalRows: p._sum.rowCount ?? 0,
      })),
      timeline: series.map((s) => ({
        bucket: s.bucket.toISOString(),
        exportedById: s.exportedById,
        name: s.exportedById ? (names.get(s.exportedById) ?? null) : null,
        exports: Number(s.exports),
        rows: Number(s.rows),
      })),
    };
  }

  /** AL-53 */
  async statsByEntity(f: AuditStatsFilterDto) {
    const groups = await this.prisma.auditLog.groupBy({
      by: ['entity'],
      where: this.statsWhere(f),
      _count: { _all: true },
      orderBy: { _count: { entity: 'desc' } },
      take: 100,
    });
    const { from, to } = this.statsRange(f);
    return { from: from.toISOString(), to: to.toISOString(), data: groups.map((g) => ({ entity: g.entity, count: g._count._all })) };
  }

  /** AL-54: events by hour of day and weekday (UTC), to spot out-of-hours activity. */
  async statsHourly(f: AuditStatsFilterDto) {
    const conds = this.statsSql(f);
    const rows = await this.prisma.$queryRaw<{ dow: number; hour: number; count: bigint }[]>`
      SELECT EXTRACT(DOW FROM "createdAt" AT TIME ZONE 'UTC')::int AS dow,
             EXTRACT(HOUR FROM "createdAt" AT TIME ZONE 'UTC')::int AS hour,
             COUNT(*)::bigint AS count
      FROM audit_log WHERE ${Prisma.join(conds, ' AND ')}
      GROUP BY 1, 2 ORDER BY 1, 2`;

    // 7 x 24 grid, Sunday = 0. Zero-filled so a chart needs no gap handling.
    const grid = Array.from({ length: 7 }, () => Array<number>(24).fill(0));
    const byHour = Array<number>(24).fill(0);
    for (const r of rows) {
      grid[r.dow][r.hour] = Number(r.count);
      byHour[r.hour] += Number(r.count);
    }
    const { from, to } = this.statsRange(f);
    return { from: from.toISOString(), to: to.toISOString(), timezone: 'UTC', weekdayStartsAt: 'SUNDAY', byHour, grid };
  }

  /** AL-55: sensitive reads per admin over time. */
  async statsSensitiveAccess(f: AuditBucketStatsQueryDto) {
    const bucket = f.bucket ?? 'day';
    const where = this.statsWhere(f, this.sensitiveWhere());
    const unit = Prisma.raw(`'${bucket}'`);
    const { from, to } = this.statsRange(f);

    const [perAdmin, rows] = await Promise.all([
      this.prisma.auditLog.groupBy({
        by: ['userId'],
        where,
        _count: { _all: true },
        orderBy: { _count: { userId: 'desc' } },
        take: 25,
      }),
      this.prisma.auditLog.findMany({ where, select: { createdAt: true, userId: true }, take: 100_000 }),
    ]);

    const series = new Map<string, number>();
    for (const r of rows) {
      const d = new Date(r.createdAt);
      if (bucket === 'hour') d.setUTCMinutes(0, 0, 0);
      else {
        d.setUTCHours(0, 0, 0, 0);
        if (bucket === 'week') d.setUTCDate(d.getUTCDate() - d.getUTCDay());
      }
      const key = `${d.toISOString()}|${r.userId ?? ''}`;
      series.set(key, (series.get(key) ?? 0) + 1);
    }
    void unit;

    const names = await this.userNames(perAdmin.map((p) => p.userId));
    return {
      from: from.toISOString(),
      to: to.toISOString(),
      bucket,
      truncated: rows.length >= 100_000,
      perAdmin: perAdmin.map((p) => ({
        userId: p.userId,
        name: p.userId ? (names.get(p.userId) ?? null) : null,
        reads: p._count._all,
      })),
      timeline: [...series.entries()]
        .map(([k, count]) => {
          const [bucketAt, userId] = k.split('|');
          return { bucket: bucketAt, userId: userId || null, reads: count };
        })
        .sort((a, b) => a.bucket.localeCompare(b.bucket)),
    };
  }

  /** AL-56: the dashboard in one call. */
  async statsOverview(f: AuditStatsFilterDto) {
    const where = this.statsWhere(f);
    const { from, to } = this.statsRange(f);
    const weekAgo = new Date(Math.max(from.getTime(), to.getTime() - 7 * DAY_MS));

    const [total, bySeverity, byOutcome, byEntity, topActors, lastIntegrity, unackedAlerts, activeHolds, lastPurge, exportsInRange, daily] =
      await Promise.all([
        this.prisma.auditLog.count({ where }),
        this.prisma.auditLog.groupBy({ by: ['severity'], where, _count: { _all: true } }),
        this.prisma.auditLog.groupBy({ by: ['outcome'], where, _count: { _all: true } }),
        this.prisma.auditLog.groupBy({ by: ['entity'], where, _count: { _all: true }, orderBy: { _count: { entity: 'desc' } }, take: 5 }),
        this.prisma.auditLog.groupBy({
          by: ['userId'],
          where: { ...where, userId: { not: null }, anonymizedAt: null },
          _count: { _all: true },
          orderBy: { _count: { userId: 'desc' } },
          take: 5,
        }),
        this.prisma.auditIntegrityRun.findFirst({ orderBy: { createdAt: 'desc' }, select: { ok: true, createdAt: true, checked: true, complete: true } }),
        this.prisma.auditAlertTrigger.count({ where: { acknowledgedAt: null } }),
        this.prisma.auditLegalHold.count({ where: { status: 'ACTIVE' } }),
        this.prisma.auditPurgeRun.findFirst({ orderBy: { createdAt: 'desc' }, select: { status: true, createdAt: true, deletedCount: true } }),
        this.prisma.auditExport.count({ where: { createdAt: { gte: from, lte: to } } }),
        this.prisma.$queryRaw<{ day: Date; count: bigint }[]>`
          SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
          FROM audit_log WHERE ${Prisma.join(this.statsSql({ ...f, from: weekAgo.toISOString(), to: to.toISOString() }), ' AND ')}
          GROUP BY 1 ORDER BY 1 ASC`,
      ]);

    const names = await this.userNames(topActors.map((a) => a.userId));
    const outcome: Record<string, number> = {};
    for (const o of Object.values(AuditOutcome)) outcome[o] = 0;
    for (const g of byOutcome) outcome[g.outcome] = g._count._all;
    const severity: Record<string, number> = {};
    for (const s of Object.values(AuditSeverity)) severity[s] = 0;
    for (const g of bySeverity) severity[g.severity] = g._count._all;

    return {
      from: from.toISOString(),
      to: to.toISOString(),
      total,
      bySeverity: severity,
      byOutcome: outcome,
      deniedOrFailed: (outcome[AuditOutcome.DENIED] ?? 0) + (outcome[AuditOutcome.FAILURE] ?? 0),
      topEntities: byEntity.map((g) => ({ entity: g.entity, count: g._count._all })),
      topActors: topActors.map((a) => ({ userId: a.userId, name: a.userId ? (names.get(a.userId) ?? null) : null, count: a._count._all })),
      last7Days: daily.map((d) => ({ date: d.day.toISOString().slice(0, 10), count: Number(d.count) })),
      exports: exportsInRange,
      attention: {
        unacknowledgedAlerts: unackedAlerts,
        activeLegalHolds: activeHolds,
        lastIntegrityCheck: lastIntegrity,
        lastPurge,
      },
    };
  }

  // ─────────────────────────────────────────────
  // NEW INTERNALS
  // ─────────────────────────────────────────────

  private async userNames(ids: Array<string | null | undefined>): Promise<Map<string, string | null>> {
    const unique = [...new Set(ids.filter((x): x is string => !!x))];
    if (unique.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { id: { in: unique } }, select: USER_SELECT });
    return new Map(users.map((u) => [u.id, u.name]));
  }

  private offsetMetaFor(page: number, limit: number, total: number, returned: number): OffsetMeta {
    return {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
      hasMore: (page - 1) * limit + returned < total,
    };
  }

  // ═════════════════════════════════════════════
  // INTERNALS
  // ═════════════════════════════════════════════

  private isSuperAdmin(user: CurrentUserDto): boolean {
    return user.roles.includes(RolesEnum.SUPER_ADMIN);
  }

  private requireUserId(user: CurrentUserDto): string {
    if (!user.id) {
      throw new ForbiddenException('authenticated_user_required');
    }
    return user.id;
  }

  private errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  /** ADMIN gets the redacted select; the redaction happens in the query itself. */
  private selectFor(viewer: CurrentUserDto): typeof ADMIN_SELECT | typeof FULL_SELECT {
    return this.isSuperAdmin(viewer) ? FULL_SELECT : ADMIN_SELECT;
  }

  /** Anonymized rows never expose the joined User name. */
  private present(row: FullAuditRow): AuditLogView {
    return row.anonymizedAt ? { ...row, user: null } : row;
  }

  private securityWhere(): Prisma.AuditLogWhereInput {
    return {
      OR: [
        {
          AND: [
            { outcome: { in: [AuditOutcome.DENIED, AuditOutcome.FAILURE] } },
            { severity: { in: SECURITY_SEVERITIES } },
          ],
        },
        ...SECURITY_ACTION_KEYWORDS.map((keyword) => ({ action: { contains: keyword } })),
      ],
    };
  }

  /** Shared filter builder for the list, security view and export. */
  private buildWhere(f: AuditLogFiltersDto, viewer: CurrentUserDto): Prisma.AuditLogWhereInput {
    // ADMIN never sees IPs, so letting them filter by IP would leak them one guess at a time.
    if (f.ipAddress && !this.isSuperAdmin(viewer)) {
      throw new ForbiddenException('ip_filter_requires_super_admin');
    }

    if (f.startDate && f.endDate && new Date(f.startDate) > new Date(f.endDate)) {
      throw new BadRequestException('startDate_after_endDate');
    }

    const ci = (value: string) => ({ contains: value, mode: Prisma.QueryMode.insensitive });
    const q = f.q?.trim();

    return {
      ...(f.action && { action: f.action }),
      ...(f.entity && { entity: f.entity }),
      ...(f.entityId && { entityId: f.entityId }),
      ...(f.actorType && { actorType: f.actorType }),
      ...(f.actorRole && { actorRole: f.actorRole }),
      ...(f.userId && { userId: f.userId }),
      ...(f.targetUserId && { targetUserId: f.targetUserId }),
      ...(f.outcome && { outcome: f.outcome }),
      ...(f.severity && { severity: f.severity }),
      ...(f.source && { source: f.source }),
      ...(f.method && { method: f.method }),
      ...(f.path && { path: ci(f.path) }),
      ...(f.country && { country: { equals: f.country, mode: Prisma.QueryMode.insensitive } }),
      ...(f.city && { city: { equals: f.city, mode: Prisma.QueryMode.insensitive } }),
      ...(f.sessionId && { sessionId: f.sessionId }),
      ...(f.requestId && { requestId: f.requestId }),
      ...(f.ipAddress && { ipAddress: f.ipAddress }),
      ...(q && { OR: [{ entityLabel: ci(q) }, { reason: ci(q) }, { actorName: ci(q) }] }),
      ...((f.startDate || f.endDate) && {
        createdAt: {
          ...(f.startDate && { gte: new Date(f.startDate) }),
          ...(f.endDate && { lte: new Date(f.endDate) }),
        },
      }),
    };
  }

  /**
   * Cursor paging when `cursor` is set or `page` is absent (no total, no COUNT).
   * Offset paging when `page` is set (returns total and totalPages).
   */
  private async paginate(
    where: Prisma.AuditLogWhereInput,
    dto: AuditPagingDto,
    viewer: CurrentUserDto,
    order: 'asc' | 'desc' = 'desc',
  ): Promise<AuditPage> {
    const limit = dto.limit ?? DEFAULT_LIMIT;
    const select = this.selectFor(viewer) as typeof FULL_SELECT;
    const orderBy: Prisma.AuditLogOrderByWithRelationInput[] = [
      { createdAt: order },
      { id: order },
    ];

    if (!dto.cursor && dto.page !== undefined) {
      const page = dto.page;
      const skip = (page - 1) * limit;

      const [rows, total] = await Promise.all([
        this.prisma.auditLog.findMany({ where, orderBy, skip, take: limit, select }),
        this.prisma.auditLog.count({ where }),
      ]);

      return {
        data: rows.map((r) => this.present(r)),
        meta: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
          hasMore: skip + rows.length < total,
        },
      };
    }

    // Fetch one extra row: its id is the next cursor.
    const rows = await this.prisma.auditLog.findMany({
      where,
      orderBy,
      take: limit + 1,
      ...(dto.cursor && { cursor: { id: dto.cursor } }),
      select,
    });

    const hasMore = rows.length > limit;

    return {
      data: rows.slice(0, limit).map((r) => this.present(r)),
      meta: { limit, nextCursor: hasMore ? rows[limit].id : null, hasMore },
    };
  }
}