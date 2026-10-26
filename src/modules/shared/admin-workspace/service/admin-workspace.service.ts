import { BadRequestException, Injectable } from '@nestjs/common';
import {
  MissingPersonFlagState,
  PaymentStatus,
  PostFlagStatus,
  PostStatus,
  Prisma,
  ReportStatus,
  SharedRecordType,
  VictimProfileFlagStatus,
  HelpTicketStatus,
  MissingPersonStatus,
  VictimProfileStatus,
  InformationStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { pageMeta, paging, dateRange } from '../../common/paging.util';
import { namesByUserId } from '../../common/shared-record.util';
import {
  ActivityFeedQueryDto,
  AdminGlobalSearchQueryDto,
  HandoverDto,
  MyWorkQueryDto,
  RecentQueryDto,
  SEARCH_ENTITIES,
  SlaQueryDto,
  WorkspaceStatsQueryDto,
  WORKSPACE_MODULES,
} from '../dto/admin-workspace.dto';

const HOUR_MS = 3_600_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_READ_PERMISSION = 'SUPPORT_PAYMENT_READ';

// Loose shape of a Prisma model delegate, so one code path can serve every record type
interface Delegate {
  findMany(args: unknown): Promise<any[]>;
  count(args: unknown): Promise<number>;
  groupBy(args: unknown): Promise<any[]>;
  aggregate(args: unknown): Promise<any>;
  updateMany(args: unknown): Promise<{ count: number }>;
}

type Where = Record<string, unknown>;

interface ModuleConfig {
  delegate: string;
  // Value stored in AuditLog.entity for this record type
  auditEntity: string;
  // Columns that say "an admin holds this item"
  ownerFields: string[];
  // Statuses (and soft-delete rule) that make an item open work for staff
  open: Where;
  labelField: string | null;
  fallbackLabel: string;
  // Hours without a change before a claimed item counts as stale
  staleHours: number;
  // Response target in hours, counted from creation
  slaHours: number;
  select: Record<string, true>;
  // True when the person on the record must be hidden from non-super admins
  sensitive: (row: any) => boolean;
  // Per-admin read-state table, where one exists
  read?: { delegate: string; relation: string };
}

const MODULES: Record<SharedRecordType, ModuleConfig> = {
  REPORT: {
    delegate: 'report',
    auditEntity: 'Report',
    ownerFields: ['assignedToId'],
    open: {
      deletedAt: null,
      status: {
        in: [
          ReportStatus.PENDING,
          ReportStatus.RECEIVED,
          ReportStatus.UNDER_REVIEW,
          ReportStatus.ASSIGNED,
          ReportStatus.IN_PROGRESS,
          ReportStatus.ESCALATED,
        ],
      },
    },
    labelField: 'caseReference',
    fallbackLabel: 'Report',
    staleHours: 48,
    slaHours: 24,
    select: { id: true, caseReference: true, status: true, createdAt: true, updatedAt: true, sensitivity: true },
    sensitive: (r) => r.sensitivity && r.sensitivity !== 'STANDARD',
  },
  POST: {
    delegate: 'post',
    auditEntity: 'Post',
    ownerFields: ['claimedByUserId'],
    open: { status: { in: [PostStatus.PENDING] } },
    labelField: 'title',
    fallbackLabel: 'Post',
    staleHours: 48,
    slaHours: 24,
    select: { id: true, title: true, status: true, createdAt: true, updatedAt: true, involvesChild: true },
    sensitive: (r) => !!r.involvesChild,
    read: { delegate: 'postReadState', relation: 'post' },
  },
  MISSING_PERSON: {
    delegate: 'missingPerson',
    auditEntity: 'MissingPerson',
    ownerFields: ['claimedByUserId', 'assignedToUserId'],
    open: {
      deletedAt: null,
      status: { in: [MissingPersonStatus.PENDING, MissingPersonStatus.UNDER_REVIEW] },
    },
    labelField: 'name',
    fallbackLabel: 'Missing person',
    staleHours: 24,
    slaHours: 12,
    select: { id: true, name: true, status: true, createdAt: true, updatedAt: true, personType: true },
    sensitive: (r) => r.personType === 'CHILD',
    read: { delegate: 'missingPersonReadState', relation: 'missingPerson' },
  },
  VICTIM_PROFILE: {
    delegate: 'victimProfile',
    auditEntity: 'VictimProfile',
    ownerFields: ['claimedByUserId', 'assignedReviewerId'],
    open: {
      deletedAt: null,
      status: {
        in: [
          VictimProfileStatus.PENDING,
          VictimProfileStatus.UNDER_REVIEW,
          VictimProfileStatus.VERIFIED,
          VictimProfileStatus.CONSENT_PENDING,
        ],
      },
    },
    labelField: 'name',
    fallbackLabel: 'Victim profile',
    staleHours: 72,
    slaHours: 48,
    select: { id: true, name: true, status: true, createdAt: true, updatedAt: true, involvesChild: true },
    sensitive: () => true, // profiles of victims are always masked for non-super admins
    read: { delegate: 'victimProfileReadState', relation: 'profile' },
  },
  INFORMATION_SUBMISSION: {
    delegate: 'informationSubmission',
    auditEntity: 'InformationSubmission',
    ownerFields: ['assignedToId'],
    open: {
      deletedAt: null,
      status: { in: [InformationStatus.PENDING, InformationStatus.UNDER_REVIEW] },
    },
    labelField: null,
    fallbackLabel: 'Information tip',
    staleHours: 24,
    slaHours: 24,
    select: { id: true, status: true, createdAt: true, updatedAt: true },
    sensitive: () => false,
    read: { delegate: 'informationAdminRead', relation: 'submission' },
  },
};

const NEXT_ACTION: Record<string, string> = {
  PENDING: 'Review and triage',
  RECEIVED: 'Start review',
  UNDER_REVIEW: 'Finish review',
  ASSIGNED: 'Begin work',
  IN_PROGRESS: 'Continue work',
  ESCALATED: 'Decide on escalation',
  VERIFIED: 'Check consent',
  CONSENT_PENDING: 'Confirm consent',
};

// Actions that read or reveal sensitive detail never appear in the shared feed
const HIDDEN_ACTION_PARTS = [
  'OPENED',
  'DOWNLOADED',
  'LOOKUP',
  'REVEALED',
  'EXPORT',
  'ANONYMIZED',
  'INFORMANT',
  'REPORTER_INFORMATION',
  'LEGAL_HOLD',
];

const ADMIN_ROLE_NAMES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] as string[];

function maskName(value: string | null | undefined): string | null {
  if (!value) return null;
  return value
    .trim()
    .split(/\s+/)
    .map((part) => `${part.charAt(0).toUpperCase()}.`)
    .join(' ');
}

function maskPhone(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.length > 7 ? `${value.slice(0, 4)}••••${value.slice(-3)}` : '••••';
}

function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const [local, domain] = value.split('@');
  return domain ? `${local.slice(0, 1)}***@${domain}` : '***';
}

const ago = (hours: number) => new Date(Date.now() - hours * HOUR_MS);
const hoursSince = (date: Date) => Math.max(0, Math.floor((Date.now() - date.getTime()) / HOUR_MS));

@Injectable()
export class AdminWorkspaceService {
  constructor(private readonly prisma: PrismaService) {}

  // SH-25
  async globalSearch(admin: CurrentUserDto, q: AdminGlobalSearchQueryDto) {
    const isSuper = this.isSuper(admin);
    const needle = q.q.trim();
    const take = q.perTypeLimit ?? 5;
    const types = q.entities?.length ? q.entities : [...SEARCH_ENTITIES];
    const contains = { contains: needle, mode: 'insensitive' as const };
    const byId: Where[] = UUID_RE.test(needle) ? [{ id: needle }] : [];

    const searches: Record<string, () => Promise<any[]>> = {
      REPORT: () =>
        this.db('REPORT').findMany({
          where: { deletedAt: null, OR: [...byId, { caseReference: contains }, { description: contains }] },
          select: MODULES.REPORT.select,
          orderBy: { createdAt: 'desc' },
          take,
        }),
      POST: () =>
        this.db('POST').findMany({
          where: { OR: [...byId, { title: contains }, { content: contains }] },
          select: MODULES.POST.select,
          orderBy: { createdAt: 'desc' },
          take,
        }),
      MISSING_PERSON: () =>
        this.db('MISSING_PERSON').findMany({
          where: {
            deletedAt: null,
            OR: [...byId, { name: contains }, { lastKnownArea: contains }, { description: contains }],
          },
          select: MODULES.MISSING_PERSON.select,
          orderBy: { createdAt: 'desc' },
          take,
        }),
      VICTIM_PROFILE: () =>
        this.db('VICTIM_PROFILE').findMany({
          where: { deletedAt: null, OR: [...byId, { name: contains }, { description: contains }] },
          select: MODULES.VICTIM_PROFILE.select,
          orderBy: { createdAt: 'desc' },
          take,
        }),
      INFORMATION_SUBMISSION: () =>
        this.db('INFORMATION_SUBMISSION').findMany({
          where: { deletedAt: null, OR: [...byId, { information: contains }, { location: contains }] },
          select: MODULES.INFORMATION_SUBMISSION.select,
          orderBy: { createdAt: 'desc' },
          take,
        }),
    };

    const entries = await Promise.all(
      types.map(async (type) => {
        if (type === 'USER') return ['USER', await this.searchUsers(needle, byId, take, isSuper)] as const;
        const rows = await searches[type]();
        const config = MODULES[type as SharedRecordType];
        return [
          type,
          rows.map((row) => {
            const masked = !isSuper && config.sensitive(row);
            const raw = config.labelField ? (row[config.labelField] as string | null) : null;
            return {
              entity: type,
              id: row.id,
              label: masked ? (maskName(raw) ?? config.fallbackLabel) : (raw ?? config.fallbackLabel),
              status: row.status,
              createdAt: row.createdAt,
              masked,
            };
          }),
        ] as const;
      }),
    );

    const results = Object.fromEntries(entries);
    return {
      query: needle,
      results,
      total: entries.reduce((sum, [, rows]) => sum + rows.length, 0),
    };
  }

  // SH-26
  async myWork(admin: CurrentUserDto, q: MyWorkQueryDto) {
    return this.collectWork(admin, q, false);
  }

  // SH-32
  async myWorkOverdue(admin: CurrentUserDto, q: MyWorkQueryDto) {
    return this.collectWork(admin, q, true);
  }

  // SH-27
  async dashboardSummary(admin: CurrentUserDto) {
    const canSeePayments = this.canSeePayments(admin);

    const [modules, flags, paymentsToReview, helpTicketsOpen] = await Promise.all([
      Promise.all(
        WORKSPACE_MODULES.map(async (m) => {
          const c = MODULES[m];
          const [pending, stale, mine] = await Promise.all([
            this.db(m).count({ where: this.unclaimedWhere(c) }),
            this.db(m).count({ where: this.and(c.open, this.anyOwner(c), { updatedAt: { lt: ago(c.staleHours) } }) }),
            this.db(m).count({ where: this.ownedBy(c, admin.id) }),
          ]);
          return [m, { pending, stale, mine }] as const;
        }),
      ),
      this.openFlagCounts(),
      canSeePayments ? this.prisma.payment.count({ where: { status: PaymentStatus.REVIEW_REQUIRED } }) : null,
      this.prisma.helpTicket.count({
        where: { status: { in: [HelpTicketStatus.OPEN, HelpTicketStatus.IN_PROGRESS] }, assignedToId: null },
      }),
    ]);

    return {
      generatedAt: new Date(),
      modules: Object.fromEntries(modules),
      openFlags: flags,
      paymentsToReview,
      helpTicketsUnassigned: helpTicketsOpen,
    };
  }

  // SH-28
  async workload() {
    const [admins, perModule] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          isActive: true,
          deletedAt: null,
          userRoles: { some: { role: { name: { in: ADMIN_ROLE_NAMES } } } },
        },
        select: { id: true, name: true },
      }),
      Promise.all(
        WORKSPACE_MODULES.flatMap((m) =>
          MODULES[m].ownerFields.map(async (field) => {
            const rows = await this.db(m).groupBy({
              by: [field],
              where: this.and(MODULES[m].open, { [field]: { not: null } }),
              _count: { _all: true },
            });
            return rows.map((r) => ({ module: m, adminId: r[field] as string, count: r._count._all as number }));
          }),
        ),
      ),
    ]);

    const byAdmin = new Map<string, { total: number; byModule: Record<string, number> }>();
    for (const admin of admins) byAdmin.set(admin.id, { total: 0, byModule: {} });

    for (const entry of perModule.flat()) {
      const slot = byAdmin.get(entry.adminId) ?? { total: 0, byModule: {} };
      slot.total += entry.count;
      slot.byModule[entry.module] = (slot.byModule[entry.module] ?? 0) + entry.count;
      byAdmin.set(entry.adminId, slot);
    }

    const names = await namesByUserId(this.prisma, [...byAdmin.keys()]);
    const data = [...byAdmin.entries()]
      .map(([adminId, v]) => ({ adminId, name: names.get(adminId) ?? null, ...v }))
      .sort((a, b) => b.total - a.total);

    return { data, totalOpenClaims: data.reduce((sum, d) => sum + d.total, 0) };
  }

  // SH-29
  async unreadSummary(admin: CurrentUserDto) {
    const now = new Date();
    const notificationWhere: Prisma.NotificationWhereInput = {
      userId: admin.id,
      readAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };

    const withReadState = WORKSPACE_MODULES.filter((m) => MODULES[m].read);

    const [byEntity, records] = await Promise.all([
      this.prisma.notification.groupBy({
        by: ['entity'],
        where: notificationWhere,
        _count: { _all: true },
      }),
      Promise.all(
        withReadState.map(async (m) => {
          const c = MODULES[m];
          const [open, read] = await Promise.all([
            this.db(m).count({ where: c.open }),
            this.delegate(c.read!.delegate).count({
              where: { adminId: admin.id, [c.read!.relation]: c.open },
            }),
          ]);
          return [m, Math.max(0, open - read)] as const;
        }),
      ),
    ]);

    const notifications = {
      total: byEntity.reduce((sum, row) => sum + row._count._all, 0),
      byEntity: Object.fromEntries(byEntity.map((row) => [row.entity ?? 'GENERAL', row._count._all])),
    };
    const unreadRecords = Object.fromEntries(records);

    return {
      notifications,
      records: unreadRecords,
      total: notifications.total + records.reduce((sum, [, n]) => sum + n, 0),
    };
  }

  // SH-30
  async queues(admin: CurrentUserDto) {
    const canSeePayments = this.canSeePayments(admin);

    const queueOf = async (key: string, label: string, delegate: Delegate, where: Where) => {
      const [size, oldest] = await Promise.all([
        delegate.count({ where }),
        delegate.aggregate({ where, _min: { createdAt: true } }),
      ]);
      const oldestAt: Date | null = oldest?._min?.createdAt ?? null;
      return { key, label, size, oldestAt, oldestAgeHours: oldestAt ? hoursSince(oldestAt) : null };
    };

    const tasks: Array<ReturnType<typeof queueOf>> = [
      ...WORKSPACE_MODULES.map((m) => queueOf(m, `${MODULES[m].fallbackLabel}s waiting for an owner`, this.db(m), this.unclaimedWhere(MODULES[m]))),
      queueOf('POST_FLAGS', 'Open post flags', this.prisma.postFlag as unknown as Delegate, { status: PostFlagStatus.OPEN }),
      queueOf('MISSING_PERSON_FLAGS', 'Open missing person flags', this.prisma.missingPersonFlag as unknown as Delegate, { status: MissingPersonFlagState.OPEN }),
      queueOf('VICTIM_PROFILE_FLAGS', 'Open victim profile flags', this.prisma.victimProfileFlag as unknown as Delegate, { status: VictimProfileFlagStatus.OPEN }),
      queueOf('HELP_TICKETS', 'Help tickets waiting for an owner', this.prisma.helpTicket as unknown as Delegate, {
        status: { in: [HelpTicketStatus.OPEN, HelpTicketStatus.IN_PROGRESS] },
        assignedToId: null,
      }),
    ];
    if (canSeePayments) {
      tasks.push(queueOf('PAYMENTS_REVIEW', 'Payments to review', this.prisma.payment as unknown as Delegate, { status: PaymentStatus.REVIEW_REQUIRED }));
    }

    return { data: await Promise.all(tasks) };
  }

  // SH-31
  async recent(admin: CurrentUserDto, q: RecentQueryDto) {
    const rows = await this.prisma.adminRecentRecord.findMany({
      where: { adminId: admin.id, ...(q.entity ? { entity: q.entity } : {}) },
      orderBy: { openedAt: 'desc' },
      take: q.limit ?? 20,
    });

    return {
      data: rows.map((r) => ({
        entity: r.entity,
        id: r.entityId,
        label: r.label,
        openedAt: r.openedAt,
      })),
    };
  }

  /**
   * Other modules call this when an admin opens a record, so it shows up in "recent" (SH-31).
   * Never throws: a failed bookmark must not break opening the record.
   */
  async touchRecent(adminId: string, entity: SharedRecordType, entityId: string, label?: string | null) {
    try {
      await this.prisma.adminRecentRecord.upsert({
        where: { adminId_entity_entityId: { adminId, entity, entityId } },
        create: { adminId, entity, entityId, label: label ?? null },
        update: { openedAt: new Date(), ...(label ? { label } : {}) },
      });
    } catch {
      // ignore
    }
  }

  // SH-33
  async handover(admin: CurrentUserDto, body: HandoverDto) {
    if (body.toAdminId === admin.id) throw new BadRequestException('cannot_hand_over_to_yourself');

    const target = await this.prisma.user.findFirst({
      where: {
        id: body.toAdminId,
        isActive: true,
        deletedAt: null,
        userRoles: { some: { role: { name: { in: ADMIN_ROLE_NAMES } } } },
      },
      select: { id: true, name: true },
    });
    if (!target) throw new BadRequestException('target_is_not_an_active_admin');

    const modules = body.modules?.length ? [...new Set(body.modules)] : WORKSPACE_MODULES;
    const note = body.note?.trim() || null;

    const moved = await this.prisma.$transaction(async (tx): Promise<Record<string, number>> => {
      const out: Record<string, number> = {};

      for (const m of modules) {
        const c = MODULES[m];
        const delegate = (tx as any)[c.delegate] as Delegate;
        const where = this.ownedBy(c, admin.id);

        const items = await delegate.findMany({ where, select: { id: true } });
        if (items.length === 0) continue;

        for (const field of c.ownerFields) {
          await delegate.updateMany({
            where: this.and(c.open, { [field]: admin.id }),
            data: { [field]: target.id },
          });
        }

        if (m === SharedRecordType.REPORT) {
          await tx.reportAssignmentHistory.createMany({
            data: items.map((item) => ({
              reportId: item.id as string,
              assignedToId: target.id,
              assignedById: admin.id,
              note: note ?? 'Handover',
            })),
          });
        }

        out[m] = items.length;
      }

      return out;
    });

    return {
      fromAdminId: admin.id,
      toAdminId: target.id,
      toAdminName: target.name,
      moved,
      total: Object.values(moved as Record<string, number>).reduce((sum, n) => sum + n, 0),
      note,
    };
  }

  // SH-34
  async sla(_admin: CurrentUserDto, q: SlaQueryDto) {
    const { page, limit, skip } = paging(q);
    const warn = (q.warnAtPercent ?? 80) / 100;
    const state = q.state ?? 'ALL';
    const mods = q.module ? [q.module] : WORKSPACE_MODULES;
    const take = skip + limit;

    const parts = await Promise.all(
      mods.map(async (m) => {
        const c = MODULES[m];
        const nearCutoff = ago(c.slaHours * warn);
        const breachCutoff = ago(c.slaHours);

        const [overWarn, breached] = await Promise.all([
          this.db(m).count({ where: this.and(c.open, { createdAt: { lte: nearCutoff } }) }),
          this.db(m).count({ where: this.and(c.open, { createdAt: { lte: breachCutoff } }) }),
        ]);
        const near = Math.max(0, overWarn - breached);

        const createdFilter =
          state === 'BREACHED'
            ? { createdAt: { lte: breachCutoff } }
            : state === 'NEAR'
              ? { createdAt: { lte: nearCutoff, gt: breachCutoff } }
              : { createdAt: { lte: nearCutoff } };

        const rows = await this.db(m).findMany({
          where: this.and(c.open, createdFilter),
          select: c.select,
          orderBy: { createdAt: 'asc' },
          take,
        });

        return { m, c, near, breached, rows };
      }),
    );

    const items = parts
      .flatMap(({ m, c, rows }) =>
        rows.map((row) => {
          const ageHours = hoursSince(row.createdAt);
          const percent = Math.round((ageHours / c.slaHours) * 100);
          return {
            entity: m,
            id: row.id as string,
            label: this.labelOf(c, row),
            status: row.status as string,
            createdAt: row.createdAt as Date,
            ageHours,
            targetHours: c.slaHours,
            percentOfTarget: percent,
            state: percent >= 100 ? 'BREACHED' : 'NEAR',
          };
        }),
      )
      .sort((a, b) => b.percentOfTarget - a.percentOfTarget);

    const total = parts.reduce((sum, p) => {
      if (state === 'BREACHED') return sum + p.breached;
      if (state === 'NEAR') return sum + p.near;
      return sum + p.near + p.breached;
    }, 0);

    return {
      modules: parts.map((p) => ({ module: p.m, targetHours: p.c.slaHours, near: p.near, breached: p.breached })),
      data: items.slice(skip, skip + limit),
      meta: pageMeta(page, limit, total),
    };
  }

  // SH-35
  async activityFeed(admin: CurrentUserDto, q: ActivityFeedQueryDto) {
    const isSuper = this.isSuper(admin);
    const { page, limit, skip } = paging(q);
    const { from, to } = dateRange(q, 7);
    const entities = q.entity
      ? [MODULES[q.entity].auditEntity]
      : WORKSPACE_MODULES.map((m) => MODULES[m].auditEntity);

    const where: Prisma.AuditLogWhereInput = {
      entity: { in: entities },
      outcome: 'SUCCESS',
      actorType: { in: ['ADMIN', 'SUPER_ADMIN'] },
      createdAt: { gte: from, lte: to },
      ...(q.actorId ? { userId: q.actorId } : {}),
      NOT: { OR: HIDDEN_ACTION_PARTS.map((part) => ({ action: { contains: part } })) },
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        // No diff, metadata, IP or device: the feed shows who did what, never the detail
        select: {
          id: true,
          createdAt: true,
          action: true,
          entity: true,
          entityId: true,
          entityLabel: true,
          userId: true,
          actorName: true,
          actorRole: true,
        },
      }),
      this.prisma.auditLog.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        at: r.createdAt,
        action: r.action,
        entity: r.entity,
        entityId: r.entityId,
        entityLabel: isSuper ? r.entityLabel : maskName(r.entityLabel),
        actorId: r.userId,
        actorName: r.actorName,
        actorRole: r.actorRole,
      })),
      meta: pageMeta(page, limit, total),
    };
  }

  // SH-36
  async statsOverview(admin: CurrentUserDto, q: WorkspaceStatsQueryDto) {
    const { from, to } = dateRange(q, 30);
    const range = { gte: from, lte: to };
    const canSeePayments = this.canSeePayments(admin);

    const [modules, flags, newUsers, paid] = await Promise.all([
      Promise.all(
        WORKSPACE_MODULES.map(async (m) => {
          const c = MODULES[m];
          // Region only exists on reports
          const scope: Where = m === SharedRecordType.REPORT && q.region ? { region: q.region } : {};
          const [total, createdInRange, byStatus, backlog] = await Promise.all([
            this.db(m).count({ where: this.and(scope, this.notDeleted(c)) }),
            this.db(m).count({ where: this.and(scope, this.notDeleted(c), { createdAt: range }) }),
            this.db(m).groupBy({
              by: ['status'],
              where: this.and(scope, this.notDeleted(c)),
              _count: { _all: true },
            }),
            this.db(m).count({ where: this.and(scope, this.unclaimedWhere(c)) }),
          ]);
          return [
            m,
            {
              total,
              createdInRange,
              waitingForOwner: backlog,
              byStatus: Object.fromEntries(byStatus.map((r) => [r.status as string, r._count._all as number])),
            },
          ] as const;
        }),
      ),
      this.openFlagCounts(),
      this.prisma.user.count({ where: { createdAt: range, deletedAt: null } }),
      canSeePayments
        ? this.prisma.payment.groupBy({
            by: ['currency'],
            where: { status: PaymentStatus.PAID, paidAt: range },
            _sum: { amount: true },
            _count: { _all: true },
          })
        : null,
    ]);

    return {
      range: { from, to },
      region: q.region ?? null,
      modules: Object.fromEntries(modules),
      openFlags: flags,
      newUsers,
      payments: paid
        ? paid.map((p) => ({ currency: p.currency, count: p._count._all, total: Number(p._sum.amount ?? 0) }))
        : null,
    };
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  private async collectWork(admin: CurrentUserDto, q: MyWorkQueryDto, overdueOnly: boolean) {
    const { page, limit, skip } = paging(q);
    const mods = q.module ? [q.module] : WORKSPACE_MODULES;
    const take = skip + limit;
    const direction = q.sort === 'newest' ? 'desc' : 'asc';

    const parts = await Promise.all(
      mods.map(async (m) => {
        const c = MODULES[m];
        const where = this.and(
          this.ownedBy(c, admin.id),
          overdueOnly ? { updatedAt: { lt: ago(c.staleHours) } } : {},
        );
        const [rows, total] = await Promise.all([
          this.db(m).findMany({ where, select: c.select, orderBy: { createdAt: direction }, take }),
          this.db(m).count({ where }),
        ]);
        return { m, c, rows, total };
      }),
    );

    const items = parts
      .flatMap(({ m, c, rows }) =>
        rows.map((row) => {
          const idleHours = hoursSince(row.updatedAt);
          return {
            entity: m,
            id: row.id as string,
            label: this.labelOf(c, row),
            status: row.status as string,
            createdAt: row.createdAt as Date,
            updatedAt: row.updatedAt as Date,
            ageHours: hoursSince(row.createdAt),
            idleHours,
            overdue: idleHours >= c.staleHours,
            nextAction: NEXT_ACTION[row.status as string] ?? 'Review',
          };
        }),
      )
      .sort((a, b) =>
        direction === 'asc'
          ? a.createdAt.getTime() - b.createdAt.getTime()
          : b.createdAt.getTime() - a.createdAt.getTime(),
      );

    const total = parts.reduce((sum, p) => sum + p.total, 0);
    return {
      data: items.slice(skip, skip + limit),
      counts: Object.fromEntries(parts.map((p) => [p.m, p.total])),
      meta: pageMeta(page, limit, total),
    };
  }

  private async searchUsers(needle: string, byId: Where[], take: number, isSuper: boolean) {
    const contains = { contains: needle, mode: 'insensitive' as const };
    const digits = needle.replace(/\D/g, '');
    const rows = await this.prisma.user.findMany({
      where: {
        deletedAt: null,
        OR: [
          ...(byId as Prisma.UserWhereInput[]),
          { name: contains },
          { email: contains },
          { phone: { contains: needle } },
          ...(digits.length >= 6 ? [{ phone: { contains: digits.slice(-9) } }] : []),
        ],
      },
      select: { id: true, name: true, phone: true, email: true, isActive: true, createdAt: true },
      orderBy: { createdAt: 'desc' },
      take,
    });

    return rows.map((u) => ({
      entity: 'USER',
      id: u.id,
      label: u.name ?? (isSuper ? (u.email ?? u.phone) : maskPhone(u.phone)) ?? 'User',
      status: u.isActive ? 'ACTIVE' : 'INACTIVE',
      createdAt: u.createdAt,
      phone: isSuper ? u.phone : maskPhone(u.phone),
      email: isSuper ? u.email : maskEmail(u.email),
      masked: !isSuper,
    }));
  }

  private async openFlagCounts() {
    const [posts, missingPersons, victimProfiles] = await Promise.all([
      this.prisma.postFlag.count({ where: { status: PostFlagStatus.OPEN } }),
      this.prisma.missingPersonFlag.count({ where: { status: MissingPersonFlagState.OPEN } }),
      this.prisma.victimProfileFlag.count({ where: { status: VictimProfileFlagStatus.OPEN } }),
    ]);
    return { posts, missingPersons, victimProfiles, total: posts + missingPersons + victimProfiles };
  }

  private db(m: SharedRecordType): Delegate {
    return this.delegate(MODULES[m].delegate);
  }

  private delegate(name: string): Delegate {
    return (this.prisma as unknown as Record<string, Delegate>)[name];
  }

  private and(...parts: Where[]): Where {
    const used = parts.filter((p) => p && Object.keys(p).length > 0);
    return used.length === 1 ? used[0] : { AND: used };
  }

  private anyOwner(c: ModuleConfig): Where {
    return { OR: c.ownerFields.map((f) => ({ [f]: { not: null } })) };
  }

  private ownedBy(c: ModuleConfig, adminId: string): Where {
    return this.and(c.open, { OR: c.ownerFields.map((f) => ({ [f]: adminId })) });
  }

  private unclaimedWhere(c: ModuleConfig): Where {
    return this.and(c.open, ...c.ownerFields.map((f) => ({ [f]: null })));
  }

  // Everything that is not soft-deleted, whatever its status
  private notDeleted(c: ModuleConfig): Where {
    return 'deletedAt' in c.open ? { deletedAt: null } : {};
  }

  private labelOf(c: ModuleConfig, row: Record<string, any>): string {
    const raw = c.labelField ? (row[c.labelField] as string | null | undefined) : null;
    return raw || c.fallbackLabel;
  }

  private isSuper(admin: CurrentUserDto): boolean {
    return !!admin.roles?.includes(RolesEnum.SUPER_ADMIN);
  }

  private canSeePayments(admin: CurrentUserDto): boolean {
    return this.isSuper(admin) || !!admin.permissions?.includes(PAYMENT_READ_PERMISSION);
  }
}
