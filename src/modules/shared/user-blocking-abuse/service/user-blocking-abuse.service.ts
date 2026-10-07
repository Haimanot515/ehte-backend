import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AbuseReportOutcome, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { dateRange, pageMeta, paging } from '../../common/paging.util';
import {
  AbuseReportsQueryDto,
  AbuseStatsQueryDto,
  BlockedListQueryDto,
  CreateAbuseReportDto,
  ResolveAbuseReportDto,
} from '../dto/user-blocking-abuse.dto';

const STAFF_ROLES: string[] = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN, RolesEnum.SYSTEM];

const REPORT_SELECT = {
  id: true,
  status: true,
  reason: true,
  details: true,
  evidenceKeys: true,
  outcome: true,
  resolutionReason: true,
  resolvedById: true,
  resolvedAt: true,
  reporterId: true,
  targetUserId: true,
  createdAt: true,
  target: { select: { id: true, name: true } },
} satisfies Prisma.AbuseReportSelect;

@Injectable()
export class UserBlockingAbuseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CacheService,
  ) {}

  async listBlocked(user: CurrentUserDto, q: BlockedListQueryDto) {
    const { page, limit, skip } = paging(q);
    const where = { blockerId: user.id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.userBlock.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: { blockedId: true, createdAt: true, blocked: { select: { name: true } } },
      }),
      this.prisma.userBlock.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({ userId: r.blockedId, name: r.blocked.name, blockedAt: r.createdAt })),
      meta: pageMeta(page, limit, total),
    };
  }

  async block(user: CurrentUserDto, id: string) {
    if (id === user.id) throw new BadRequestException('cannot_block_self');

    const target = await this.prisma.user.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: { userRoles: { select: { role: { select: { name: true } } } } },
    });
    if (!target) throw new NotFoundException('user_not_found');
    if (target.userRoles.some((r) => STAFF_ROLES.includes(r.role.name))) {
      throw new ForbiddenException('staff_cannot_be_blocked');
    }

    await this.prisma.userBlock.upsert({
      where: { blockerId_blockedId: { blockerId: user.id, blockedId: id } },
      create: { blockerId: user.id, blockedId: id },
      update: {},
    });

    return { userId: id, blocked: true };
  }

  async unblock(user: CurrentUserDto, id: string) {
    await this.prisma.userBlock.deleteMany({ where: { blockerId: user.id, blockedId: id } });
    return { userId: id, blocked: false };
  }

  async reportAbuse(user: CurrentUserDto, id: string, body: CreateAbuseReportDto) {
    if (id === user.id) throw new BadRequestException('cannot_report_self');

    const target = await this.prisma.user.findUnique({ where: { id }, select: { id: true } });
    if (!target) throw new NotFoundException('user_not_found');

    const open = await this.prisma.abuseReport.findFirst({
      where: { targetUserId: id, reporterId: user.id, status: 'OPEN' },
      select: { id: true },
    });
    if (open) throw new ConflictException('abuse_report_already_open');

    return this.prisma.abuseReport.create({
      data: {
        targetUserId: id,
        reporterId: user.id,
        reason: body.reason,
        details: body.details ?? null,
        evidenceKeys: body.evidenceKeys ?? [],
      },
      select: { id: true, status: true, createdAt: true },
    });
  }

  async adminList(admin: CurrentUserDto, q: AbuseReportsQueryDto) {
    return this.pagedReports(q, {});
  }

  async adminByUser(admin: CurrentUserDto, userId: string, q: AbuseReportsQueryDto) {
    const exists = await this.prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
    if (!exists) throw new NotFoundException('user_not_found');

    return this.pagedReports(q, { targetUserId: userId });
  }

  async adminGet(admin: CurrentUserDto, id: string) {
    const report = await this.prisma.abuseReport.findUnique({ where: { id }, select: REPORT_SELECT });
    if (!report) throw new NotFoundException('abuse_report_not_found');

    const targetId = report.targetUserId;

    const [reporter, otherReports, otherReportCount, warnings, restrictions] = await Promise.all([
      report.reporterId
        ? this.prisma.user.findUnique({
            where: { id: report.reporterId },
            select: { id: true, name: true },
          })
        : Promise.resolve(null),
      this.prisma.abuseReport.findMany({
        where: { targetUserId: targetId ?? '', id: { not: id } },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, status: true, outcome: true, reason: true, createdAt: true },
      }),
      this.prisma.abuseReport.count({ where: { targetUserId: targetId ?? '', id: { not: id } } }),
      this.prisma.userWarning.findMany({
        where: { userId: targetId ?? '' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, message: true, createdAt: true },
      }),
      this.prisma.userRestriction.findMany({
        where: { userId: targetId ?? '' },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, ability: true, reason: true, endsAt: true, liftedAt: true, createdAt: true },
      }),
    ]);

    return {
      report,
      reporter,
      history: {
        otherReportCount,
        otherReports,
        warnings,
        restrictions,
      },
    };
  }

  async adminResolve(admin: CurrentUserDto, id: string, body: ResolveAbuseReportDto) {
    const report = await this.prisma.abuseReport.findUnique({
      where: { id },
      select: { id: true, status: true, targetUserId: true },
    });
    if (!report) throw new NotFoundException('abuse_report_not_found');
    if (report.status !== 'OPEN') throw new ConflictException('abuse_report_already_resolved');

    const targetUserId = report.targetUserId;
    const needsTarget = body.outcome !== AbuseReportOutcome.DISMISS;

    if (needsTarget && !targetUserId) throw new BadRequestException('report_target_missing');
    if (needsTarget && targetUserId === admin.id) throw new BadRequestException('cannot_target_self');

    if (body.outcome === AbuseReportOutcome.SUSPEND && targetUserId) {
      const roles = await this.prisma.userRole.findMany({
        where: { userId: targetUserId },
        select: { role: { select: { name: true } } },
      });
      if (roles.some((r) => STAFF_ROLES.includes(r.role.name))) {
        throw new ForbiddenException('cannot_suspend_staff');
      }
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.abuseReport.updateMany({
        where: { id, status: 'OPEN' },
        data: {
          status: 'RESOLVED',
          outcome: body.outcome,
          resolutionReason: body.reason,
          resolvedById: admin.id,
          resolvedAt: new Date(),
        },
      });
      if (claimed.count === 0) throw new ConflictException('abuse_report_already_resolved');

      if (body.outcome === AbuseReportOutcome.WARN && targetUserId) {
        await tx.userWarning.create({
          data: { userId: targetUserId, message: body.warningMessage ?? body.reason, issuedById: admin.id },
        });
      }

      if (body.outcome === AbuseReportOutcome.SUSPEND && targetUserId) {
        await tx.user.updateMany({ where: { id: targetUserId, isActive: true }, data: { isActive: false } });
        await tx.session.deleteMany({ where: { userId: targetUserId } });
      }

      return tx.abuseReport.findUniqueOrThrow({ where: { id }, select: REPORT_SELECT });
    });

    if (targetUserId && body.outcome === AbuseReportOutcome.SUSPEND) {
      await this.cache.purgeUserCache(targetUserId);
    }
    if (targetUserId && body.outcome === AbuseReportOutcome.WARN) {
      this.eventEmitter.emit(NotificationEventEnum.SECURITY_ALERT, {
        userId: targetUserId,
        reason: 'admin_warning',
      });
    }

    return updated;
  }

  async adminStats(q: AbuseStatsQueryDto) {
    const { from, to } = dateRange(q, 30);
    const where: Prisma.AbuseReportWhereInput = { createdAt: { gte: from, lte: to } };

    const [total, byStatus, byOutcome, series] = await Promise.all([
      this.prisma.abuseReport.count({ where }),
      this.prisma.abuseReport.groupBy({ by: ['status'], where, _count: { _all: true } }),
      this.prisma.abuseReport.groupBy({
        by: ['outcome'],
        where: { ...where, outcome: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.$queryRaw<{ day: Date; count: bigint }[]>(Prisma.sql`
        SELECT date_trunc('day', "createdAt") AS day, COUNT(*)::bigint AS count
        FROM "abuse_report"
        WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
        GROUP BY 1
        ORDER BY 1
      `),
    ]);

    return {
      range: { from, to },
      total,
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      byOutcome: Object.fromEntries(byOutcome.map((r) => [r.outcome as string, r._count._all])),
      overTime: series.map((r) => ({ day: r.day, count: Number(r.count) })),
    };
  }

  private async pagedReports(q: AbuseReportsQueryDto, extra: Prisma.AbuseReportWhereInput) {
    const { page, limit, skip } = paging(q);
    const where: Prisma.AbuseReportWhereInput = {
      ...extra,
      ...(q.status ? { status: q.status } : {}),
      ...(q.outcome ? { outcome: q.outcome } : {}),
      ...(q.from || q.to
        ? {
            createdAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.abuseReport.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        select: REPORT_SELECT,
      }),
      this.prisma.abuseReport.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, limit, total) };
  }
}
