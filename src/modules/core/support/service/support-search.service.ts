import { Injectable } from '@nestjs/common';
import {
  Prisma,
  SupportCategory,
  SupportDisputeStatus,
  SupportStatus,
  SupportType,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { SupportSearchQueryDto, SupportStatsQueryDto } from '../dto/support.dto';
import { UUID_RE, adminListSelect } from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  // SP-55
  async searchSupports(admin: CurrentUserDto, query: SupportSearchQueryDto) {
    const { page, limit, skip, take } = this.supportCommonService.paging(query);
    const q = query.q.trim();

    const or: Prisma.SupportWhereInput[] = [
      { transferReference: { contains: q, mode: 'insensitive' } },
      { user: { name: { contains: q, mode: 'insensitive' } } },
      { user: { email: { contains: q, mode: 'insensitive' } } },
      { user: { phone: { contains: q } } },
      { victimProfile: { name: { contains: q, mode: 'insensitive' } } },
    ];
    if (UUID_RE.test(q)) {
      or.push({ id: q }, { victimProfileId: q }, { userId: q });
    } else {
      // The label shown in audit rows is "support:" plus the first 8 characters of the id.
      const prefix = q.toLowerCase().replace(/^support:/, '');
      if (/^[0-9a-f-]{4,36}$/.test(prefix)) or.push({ id: { startsWith: prefix } });
    }

    const where: Prisma.SupportWhereInput = { AND: [this.supportCommonService.buildStatsWhere(query), { OR: or }] };
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

  // SP-56. Each dimension ignores its own filter so the sidebar still shows the alternatives.
  async getSupportFacets(admin: CurrentUserDto, query: SupportStatsQueryDto) {
    const base = this.supportCommonService.buildStatsWhere({ ...query, status: undefined, type: undefined });
    const withStatus = this.supportCommonService.buildStatsWhere({ ...query, status: undefined });
    const withType = this.supportCommonService.buildStatsWhere({ ...query, type: undefined });
    const full = this.supportCommonService.buildStatsWhere(query);

    const [byStatus, byType, openDisputes, flagged, unread, ...categoryCounts] = await Promise.all([
      this.prisma.support.groupBy({
        by: ['status'],
        where: withType,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.support.groupBy({
        by: ['type'],
        where: withStatus,
        _count: { _all: true },
        orderBy: { type: 'asc' },
      }),
      this.prisma.support.count({
        where: { ...full, disputes: { some: { status: SupportDisputeStatus.OPEN } } },
      }),
      this.prisma.support.count({ where: { ...full, flags: { some: {} } } }),
      this.prisma.support.count({
        where: { ...full, adminReads: { none: { adminId: admin.id } } },
      }),
      ...Object.values(SupportCategory).map((category) =>
        this.prisma.support.count({ where: { ...base, ...full, categories: { has: category } } }),
      ),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(SupportStatus).map((s) => [s, 0]),
    ) as Record<SupportStatus, number>;
    for (const row of byStatus)
      statusCounts[row.status] = (row._count as { _all?: number })?._all ?? 0;

    const typeCounts = Object.fromEntries(Object.values(SupportType).map((t) => [t, 0])) as Record<
      SupportType,
      number
    >;
    for (const row of byType) typeCounts[row.type] = (row._count as { _all?: number })?._all ?? 0;

    const categories = Object.fromEntries(
      Object.values(SupportCategory).map((c, i) => [c, categoryCounts[i]]),
    ) as Record<SupportCategory, number>;

    return { status: statusCounts, type: typeCounts, categories, openDisputes, flagged, unread };
  }
}
