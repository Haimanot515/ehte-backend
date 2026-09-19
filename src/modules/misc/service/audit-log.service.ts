import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
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

import { AuditEventPayload } from '../events/audit.events';
import {
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
type RedactedKey = 'ipAddress' | 'userAgent' | 'metadata' | 'legalHold' | 'seq' | 'hash' | 'prevHash';

/** ADMIN rows simply do not carry the redacted keys, so they are optional in the type. */
export type AuditLogView = Omit<FullAuditRow, RedactedKey> & Partial<Pick<FullAuditRow, RedactedKey>>;

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

// ─────────────────────────────────────────────
// SERVICE
// ─────────────────────────────────────────────

@Injectable()
export class AuditLogService {
  private readonly logger = new Logger(AuditLogService.name);

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
      outcome: payload.outcome ?? AuditOutcome.SUCCESS,
      severity: payload.severity ?? AuditSeverity.INFO,
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
    await this.record({
      userId: actor.id,
      actorType: this.isSuperAdmin(actor) ? ActorType.SUPER_ADMIN : ActorType.ADMIN,
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
      this.prisma.auditLog.findFirst({ orderBy: { createdAt: 'desc' }, select: { createdAt: true } }),
      this.prisma.auditLog.findFirst({ orderBy: { createdAt: 'asc' }, select: { createdAt: true } }),
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
        filter: storedFilter as unknown as Prisma.InputJsonValue,
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
      meta: { page, limit, total, totalPages: Math.ceil(total / limit), hasMore: page * limit < total },
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
  ): Promise<IntegrityReport> {
    const from = query.from ? new Date(query.from) : undefined;
    const to = query.to ? new Date(query.to) : undefined;

    if (from && to && from > to) {
      throw new BadRequestException('from_after_to');
    }

    const range: Prisma.AuditLogWhereInput =
      from || to
        ? { createdAt: { ...(from && { gte: from }), ...(to && { lte: to }) } }
        : {};

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
            fail('rows_missing', `seq ${prev.seq + 1}..${seq - 1} are missing and no purge run explains it.`);
            break scan;
          }
        }

        prev = { seq, hash: row.hash as string };
        checked += 1;
      }

      lastSeq = rows[rows.length - 1].seq as number;
    }

    const unchainedRows = await this.prisma.auditLog.count({ where: { AND: [range, { seq: null }] } });

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
      this.logger.error(`Purge ${run.id} could not open archive, nothing deleted: ${this.errMsg(err)}`);
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
      this.logger.error(`Purge ${run.id} delete failed after ${deletedCount} rows: ${this.errMsg(err)}`);
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
    const orderBy: Prisma.AuditLogOrderByWithRelationInput[] = [{ createdAt: order }, { id: order }];

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