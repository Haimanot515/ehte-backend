import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditSeverity, Prisma, SupportDisputeOutcome, SupportStatus } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { RolesEnum } from 'src/common/enums/roles.enum';
import {
  ListSupportQueryDto,
  RestrictSupporterDto,
  SupportPagedQueryDto,
} from '../dto/support.dto';
import { ADMIN_ROLE_NAMES, REPEAT_DISPUTE_THRESHOLD, adminListSelect } from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportSupportersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly supportCommonService: SupportCommonService,
  ) {}

    private activeRestrictionWhere(userId: string): Prisma.SupporterRestrictionWhereInput {
    return {
      userId,
      liftedAt: null,
      OR: [{ endsAt: null }, { endsAt: { gt: new Date() } }],
    };
  }

  async isSupporterRestricted(userId: string): Promise<boolean> {
    const count = await this.prisma.supporterRestriction.count({
      where: this.activeRestrictionWhere(userId),
    });
    return count > 0;
  }

  // Call this at the top of create() to enforce a restriction. See the notes that came with this file.
  async assertSupporterNotRestricted(userId: string): Promise<void> {
    if (await this.isSupporterRestricted(userId)) {
      throw new ForbiddenException('supporter_restricted');
    }
  }

  // ═════════════════ admin: supporters and profiles (SP-28 .. SP-33) ═════════════════

  // SP-28
  async findSupportersSummary(admin: CurrentUserDto, query: SupportPagedQueryDto) {
    const { page, limit, skip, take } = this.supportCommonService.paging(query);

    const [items, totalRow] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          supporterId: string;
          name: string | null;
          total: bigint;
          read: bigint;
          unread: bigint;
          completed: bigint;
          disputed: bigint;
          lastOfferAt: Date;
        }>
      >(Prisma.sql`
        SELECT s."userId" AS "supporterId",
               u."name" AS "name",
               COUNT(*) AS total,
               COUNT(*) FILTER (WHERE r."supportId" IS NOT NULL) AS read,
               COUNT(*) FILTER (WHERE r."supportId" IS NULL) AS unread,
               COUNT(*) FILTER (WHERE s."status" = 'COMPLETED') AS completed,
               (SELECT COUNT(*) FROM "support_dispute" d WHERE d."supporterUserId" = s."userId") AS disputed,
               MAX(s."createdAt") AS "lastOfferAt"
        FROM "Support" s
        LEFT JOIN "user" u ON u."id" = s."userId"
        LEFT JOIN "support_admin_read" r ON r."supportId" = s."id" AND r."adminId" = ${admin.id}
        WHERE s."userId" IS NOT NULL
        GROUP BY s."userId", u."name"
        ORDER BY MAX(s."createdAt") DESC
        LIMIT ${take} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "userId") AS count FROM "Support" WHERE "userId" IS NOT NULL
      `),
    ]);

    return {
      total: this.supportCommonService.num(totalRow[0]?.count),
      page,
      limit,
      items: items.map((r) => ({
        supporterId: r.supporterId,
        name: r.name,
        total: this.supportCommonService.num(r.total),
        read: this.supportCommonService.num(r.read),
        unread: this.supportCommonService.num(r.unread),
        completed: this.supportCommonService.num(r.completed),
        disputed: this.supportCommonService.num(r.disputed),
        lastOfferAt: r.lastOfferAt,
      })),
    };
  }

  // SP-29
  async findBySupporter(supporterId: string, admin: CurrentUserDto, query: ListSupportQueryDto) {
    const { page, limit, skip, take } = this.supportCommonService.paging(query);
    const where: Prisma.SupportWhereInput = {
      userId: supporterId,
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.support.count({ where }),
      this.prisma.support.findMany({
        where,
        select: adminListSelect(admin.id),
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items: rows.map((r) => this.supportCommonService.mapAdminRow(r)) };
  }

  // SP-30
  async getSupporterSummary(supporterId: string, admin: CurrentUserDto) {
    void admin;
    const supporter = await this.prisma.user.findUnique({
      where: { id: supporterId },
      select: { id: true, name: true },
    });
    if (!supporter) throw new NotFoundException('supporter_not_found');

    const [byStatus, disputes, notDelivered, restriction, firstLast] = await Promise.all([
      this.prisma.support.groupBy({
        by: ['status'],
        where: { userId: supporterId },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.supportDispute.count({ where: { supporterUserId: supporterId } }),
      this.prisma.supportDispute.count({
        where: { supporterUserId: supporterId, outcome: SupportDisputeOutcome.NOT_DELIVERED },
      }),
      this.prisma.supporterRestriction.findFirst({
        where: this.activeRestrictionWhere(supporterId),
        select: { id: true, reason: true, startsAt: true, endsAt: true },
      }),
      this.prisma.support.aggregate({
        where: { userId: supporterId },
        _min: { createdAt: true },
        _max: { createdAt: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(SupportStatus).map((s) => [s, 0]),
    ) as Record<SupportStatus, number>;
    for (const row of byStatus)
      statusCounts[row.status] = (row._count as { _all?: number })?._all ?? 0;

    const total = Object.values(statusCounts).reduce((a, b) => a + b, 0);
    const completed = statusCounts[SupportStatus.COMPLETED];
    const failed = statusCounts[SupportStatus.FAILED];
    const denominator = completed + failed + notDelivered;

    return {
      supporter,
      total,
      byStatus: statusCounts,
      disputes: { total: disputes, notDelivered },
      reliability: {
        // completed / (completed + failed + confirmed non-deliveries). null until there is history.
        score: denominator === 0 ? null : Number((completed / denominator).toFixed(2)),
        completed,
        failed,
        notDelivered,
      },
      restriction,
      firstOfferAt: firstLast._min.createdAt,
      lastOfferAt: firstLast._max.createdAt,
    };
  }

  // SP-31
  async findProfilesSummary(admin: CurrentUserDto, query: SupportPagedQueryDto) {
    void admin;
    const { page, limit, skip, take } = this.supportCommonService.paging(query);

    const [items, totalRow] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          victimProfileId: string;
          name: string | null;
          offers: bigint;
          completed: bigint;
          pending: bigint;
          disputed: bigint;
          lastOfferAt: Date;
        }>
      >(Prisma.sql`
        SELECT s."victimProfileId" AS "victimProfileId",
               vp."name" AS "name",
               COUNT(*) AS offers,
               COUNT(*) FILTER (WHERE s."status" = 'COMPLETED') AS completed,
               COUNT(*) FILTER (WHERE s."status" = 'PENDING') AS pending,
               (SELECT COUNT(*) FROM "support_dispute" d
                  JOIN "Support" s2 ON s2."id" = d."supportId"
                 WHERE s2."victimProfileId" = s."victimProfileId") AS disputed,
               MAX(s."createdAt") AS "lastOfferAt"
        FROM "Support" s
        JOIN "victim_profile" vp ON vp."id" = s."victimProfileId"
        WHERE s."type" = 'NON_FINANCIAL'
        GROUP BY s."victimProfileId", vp."name"
        ORDER BY MAX(s."createdAt") DESC
        LIMIT ${take} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "victimProfileId") AS count FROM "Support" WHERE "type" = 'NON_FINANCIAL'
      `),
    ]);

    return {
      total: this.supportCommonService.num(totalRow[0]?.count),
      page,
      limit,
      items: items.map((r) => ({
        victimProfileId: r.victimProfileId,
        name: r.name,
        offers: this.supportCommonService.num(r.offers),
        completed: this.supportCommonService.num(r.completed),
        pending: this.supportCommonService.num(r.pending),
        disputed: this.supportCommonService.num(r.disputed),
        lastOfferAt: r.lastOfferAt,
      })),
    };
  }

  // SP-32
  async markSupporterRead(supporterId: string, admin: CurrentUserDto) {
    const unread = await this.prisma.support.findMany({
      where: { userId: supporterId, adminReads: { none: { adminId: admin.id } } },
      select: { id: true },
      take: 5_000,
    });
    const { count } = await this.prisma.supportAdminRead.createMany({
      data: unread.map((s) => ({ supportId: s.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    return { supporterId, marked: count };
  }

  // SP-33
  async findRepeatDisputeSupporters(admin: CurrentUserDto, query: SupportPagedQueryDto) {
    void admin;
    const { page, limit, skip, take } = this.supportCommonService.paging(query);

    const having = Prisma.sql`
      COUNT(*) >= ${REPEAT_DISPUTE_THRESHOLD}
      OR COUNT(*) FILTER (WHERE d."outcome" = 'NOT_DELIVERED') >= 1
    `;

    const [items, totalRow] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          supporterId: string;
          name: string | null;
          disputes: bigint;
          notDelivered: bigint;
          lastDisputeAt: Date;
        }>
      >(Prisma.sql`
        SELECT d."supporterUserId" AS "supporterId",
               u."name" AS "name",
               COUNT(*) AS disputes,
               COUNT(*) FILTER (WHERE d."outcome" = 'NOT_DELIVERED') AS "notDelivered",
               MAX(d."createdAt") AS "lastDisputeAt"
        FROM "support_dispute" d
        LEFT JOIN "user" u ON u."id" = d."supporterUserId"
        WHERE d."supporterUserId" IS NOT NULL
        GROUP BY d."supporterUserId", u."name"
        HAVING ${having}
        ORDER BY COUNT(*) DESC, MAX(d."createdAt") DESC
        LIMIT ${take} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
        SELECT COUNT(*) AS count FROM (
          SELECT d."supporterUserId"
          FROM "support_dispute" d
          WHERE d."supporterUserId" IS NOT NULL
          GROUP BY d."supporterUserId"
          HAVING ${having}
        ) t
      `),
    ]);

    return {
      total: this.supportCommonService.num(totalRow[0]?.count),
      page,
      limit,
      items: items.map((r) => ({
        supporterId: r.supporterId,
        name: r.name,
        disputes: this.supportCommonService.num(r.disputes),
        notDelivered: this.supportCommonService.num(r.notDelivered),
        lastDisputeAt: r.lastDisputeAt,
      })),
    };
  }

  // SP-38
  async restrictSupporter(supporterId: string, admin: CurrentUserDto, data: RestrictSupporterDto) {
    const target = await this.prisma.user.findUnique({
      where: { id: supporterId },
      select: { id: true, userRoles: { select: { role: { select: { name: true } } } } },
    });
    if (!target) throw new NotFoundException('supporter_not_found');
    if (target.userRoles.some((ur) => ADMIN_ROLE_NAMES.includes(ur.role.name as RolesEnum))) {
      throw new BadRequestException('cannot_restrict_staff');
    }
    if (supporterId === admin.id) throw new BadRequestException('cannot_restrict_yourself');

    const endsAt = data.endsAt ? new Date(data.endsAt) : null;
    if (endsAt && endsAt.getTime() <= Date.now()) {
      throw new BadRequestException('restriction_end_must_be_in_the_future');
    }

    const active = await this.prisma.supporterRestriction.count({
      where: this.activeRestrictionWhere(supporterId),
    });
    if (active > 0) throw new BadRequestException('supporter_already_restricted');

    const reason = data.reason.trim();
    const restriction = await this.prisma.supporterRestriction.create({
      data: { userId: supporterId, reason, endsAt, restrictedByUserId: admin.id },
      select: { id: true, userId: true, reason: true, startsAt: true, endsAt: true },
    });

    this.supportCommonService.emitAudit({
      userId: admin.id,
      targetUserId: supporterId,
      actorType: resolveActorType(this.supportCommonService.getRoles(admin)),
      action: AuditEventEnum.SUPPORT_SUPPORTER_RESTRICTED,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: supporterId,
      reason,
      diff: {
        result: 'success',
        restrictionId: restriction.id,
        endsAt: endsAt?.toISOString() ?? null,
      },
    } as AuditEventPayload);
    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_SUPPORTER_RESTRICTED, {
      userId: supporterId,
      endsAt: endsAt?.toISOString() ?? null,
    });

    return restriction;
  }

  // SP-39
  async liftSupporterRestriction(supporterId: string, admin: CurrentUserDto) {
    const { count } = await this.prisma.supporterRestriction.updateMany({
      where: this.activeRestrictionWhere(supporterId),
      data: { liftedAt: new Date(), liftedByUserId: admin.id },
    });
    if (count === 0) throw new NotFoundException('no_active_restriction');

    this.supportCommonService.emitAudit({
      userId: admin.id,
      targetUserId: supporterId,
      actorType: resolveActorType(this.supportCommonService.getRoles(admin)),
      action: AuditEventEnum.SUPPORT_SUPPORTER_RESTRICTION_LIFTED,
      entity: 'User',
      entityId: supporterId,
      diff: { result: 'success', lifted: count },
    } as AuditEventPayload);

    return { supporterId, lifted: count };
  }
}
