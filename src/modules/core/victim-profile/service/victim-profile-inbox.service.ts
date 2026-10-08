import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, SupportType, VictimProfileFlagStatus, VictimProfileStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import {
  BulkIdsDto,
  FindAllVictimProfilesQueryDto,
  FindFlagsQueryDto,
  FindUnreadVictimProfilesQueryDto,
  FlagReason,
  PagedQueryDto,
  ReadAllDto,
} from '../dto/victim-profile.dto';
import { chunk } from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  // VP-25
  async markRead(admin: CurrentUserDto, id: string) {
    await this.victimProfileCommonService.assertProfileExists(id);
    await this.prisma.victimProfileReadState.upsert({
      where: { profileId_adminId: { profileId: id, adminId: admin.id } },
      create: { profileId: id, adminId: admin.id },
      update: {},
    });
    return { id, isRead: true };
  }

  // VP-26
  async markUnread(admin: CurrentUserDto, id: string) {
    await this.victimProfileCommonService.assertProfileExists(id);
    await this.prisma.victimProfileReadState.deleteMany({
      where: { profileId: id, adminId: admin.id },
    });
    return { id, isRead: false };
  }

  // VP-27
  async bulkMarkRead(admin: CurrentUserDto, data: BulkIdsDto) {
    const ids = [...new Set(data.ids)];
    const found = await this.prisma.victimProfile.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const foundIds = found.map((f) => f.id);

    await this.prisma.victimProfileReadState.createMany({
      data: foundIds.map((profileId) => ({ profileId, adminId: admin.id })),
      skipDuplicates: true,
    });

    return {
      requested: ids.length,
      updated: foundIds.length,
      missing: ids.filter((i) => !foundIds.includes(i)),
    };
  }

  // VP-28
  async bulkMarkUnread(admin: CurrentUserDto, data: BulkIdsDto) {
    const ids = [...new Set(data.ids)];
    const result = await this.prisma.victimProfileReadState.deleteMany({
      where: { adminId: admin.id, profileId: { in: ids } },
    });
    return { requested: ids.length, updated: result.count };
  }

  // VP-29
  async markAllRead(admin: CurrentUserDto, data: ReadAllDto) {
    const unread = await this.prisma.victimProfile.findMany({
      where: this.victimProfileCommonService.unreadWhere(admin, data.status !== undefined ? { status: data.status } : {}),
      select: { id: true },
      take: 50_000,
    });

    let updated = 0;
    for (const ids of chunk(
      unread.map((u) => u.id),
      1000,
    )) {
      const res = await this.prisma.victimProfileReadState.createMany({
        data: ids.map((profileId) => ({ profileId, adminId: admin.id })),
        skipDuplicates: true,
      });
      updated += res.count;
    }
    return { updated };
  }

  // VP-30
  async findUnread(admin: CurrentUserDto, query: FindUnreadVictimProfilesQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where = this.victimProfileCommonService.unreadWhere(
      admin,
      query.status !== undefined ? { status: query.status } : {},
    );

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: rows.map((row) => ({ ...row, isRead: false })),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }

  // VP-31
  async countUnread(admin: CurrentUserDto) {
    return { unread: await this.prisma.victimProfile.count({ where: this.victimProfileCommonService.unreadWhere(admin) }) };
  }

  // VP-32
  async countUnreadByStatus(admin: CurrentUserDto) {
    const grouped = await this.prisma.victimProfile.groupBy({
      by: ['status'],
      where: this.victimProfileCommonService.unreadWhere(admin),
      _count: { _all: true },
      orderBy: { status: 'asc' },
    });
    const counts = Object.fromEntries(
      Object.values(VictimProfileStatus).map((s) => [s, 0]),
    ) as Record<VictimProfileStatus, number>;
    for (const row of grouped) counts[row.status] = row._count._all;
    return counts;
  }

  // VP-33  ("need category" = supportType; swap the groupBy field if you later add a dedicated column)
  async countUnreadByCategory(admin: CurrentUserDto) {
    const grouped = await this.prisma.victimProfile.groupBy({
      by: ['supportType'],
      where: this.victimProfileCommonService.unreadWhere(admin),
      _count: { _all: true },
      orderBy: { supportType: 'asc' },
    });
    const counts: Record<string, number> = {};
    for (const t of Object.values(SupportType)) counts[t] = 0;
    for (const row of grouped) counts[row.supportType ?? 'UNSPECIFIED'] = row._count._all;
    return counts;
  }

  // VP-34
  async getReadCounts(admin: CurrentUserDto) {
    const [total, read] = await Promise.all([
      this.prisma.victimProfile.count({ where: { deletedAt: null } }),
      this.prisma.victimProfile.count({
        where: { deletedAt: null, readStates: { some: { adminId: admin.id } } },
      }),
    ]);
    return { total, read, unread: Math.max(0, total - read) };
  }

  // VP-35
  async findCreatorsSummary(admin: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);

    const groups = await this.prisma.victimProfile.groupBy({
      by: ['createdByUserId'],
      where: { createdByUserId: { not: null }, deletedAt: null },
      _count: { id: true },
      orderBy: { _count: { id: 'desc' } },
    });
    const pageGroups = groups.slice(skip, skip + limit);
    const creatorIds = pageGroups.map((g) => g.createdByUserId as string);

    const [reads, names] = await Promise.all([
      this.prisma.victimProfileReadState.findMany({
        where: {
          adminId: admin.id,
          profile: { createdByUserId: { in: creatorIds }, deletedAt: null },
        },
        select: { profile: { select: { createdByUserId: true } } },
      }),
      this.victimProfileCommonService.creatorNames(creatorIds),
    ]);
    const readByCreator = new Map<string, number>();
    for (const r of reads) {
      const c = r.profile.createdByUserId;
      if (c) readByCreator.set(c, (readByCreator.get(c) ?? 0) + 1);
    }

    return {
      data: pageGroups.map((g) => {
        const creatorId = g.createdByUserId as string;
        const read = readByCreator.get(creatorId) ?? 0;
        return {
          creatorId,
          creatorName: names.get(creatorId) ?? null,
          total: g._count.id,
          read,
          unread: Math.max(0, g._count.id - read),
        };
      }),
      meta: this.victimProfileCommonService.metaOf(page, limit, groups.length),
    };
  }

  // VP-36
  async findByCreator(
    admin: CurrentUserDto,
    creatorId: string,
    query: FindAllVictimProfilesQueryDto,
  ) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.VictimProfileWhereInput = {
      createdByUserId: creatorId,
      deletedAt: null,
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfile.findMany({
        where,
        include: { readStates: { where: { adminId: admin.id }, select: { readAt: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfile.count({ where }),
    ]);

    return {
      data: rows.map(({ readStates, ...row }) => ({
        ...row,
        isRead: readStates.length > 0,
      })),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }

  // VP-37
  async getCreatorSummary(admin: CurrentUserDto, creatorId: string) {
    const where: Prisma.VictimProfileWhereInput = { createdByUserId: creatorId, deletedAt: null };

    const [grouped, read, names] = await Promise.all([
      this.prisma.victimProfile.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.victimProfile.count({
        where: { ...where, readStates: { some: { adminId: admin.id } } },
      }),
      this.victimProfileCommonService.creatorNames([creatorId]),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(VictimProfileStatus).map((s) => [s, 0]),
    ) as Record<VictimProfileStatus, number>;
    for (const row of grouped) byStatus[row.status] = row._count._all;
    const total = Object.values(byStatus).reduce((a, b) => a + b, 0);

    return {
      creatorId,
      creatorName: names.get(creatorId) ?? null,
      total,
      read,
      unread: Math.max(0, total - read),
      byStatus,
    };
  }

  // VP-38
  async markCreatorRead(admin: CurrentUserDto, creatorId: string) {
    const profiles = await this.prisma.victimProfile.findMany({
      where: { createdByUserId: creatorId, deletedAt: null },
      select: { id: true },
    });
    const res = await this.prisma.victimProfileReadState.createMany({
      data: profiles.map((p) => ({ profileId: p.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    return { creatorId, updated: res.count };
  }

  // VP-39
  async markCreatorUnread(admin: CurrentUserDto, creatorId: string) {
    const res = await this.prisma.victimProfileReadState.deleteMany({
      where: { adminId: admin.id, profile: { createdByUserId: creatorId } },
    });
    return { creatorId, updated: res.count };
  }

  // VP-40
  async findRepeatRejectionCreators(_admin: CurrentUserDto, query: PagedQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const threshold = Number(
      this.configService.get<string>('PROFILE_REPEAT_REJECTION_THRESHOLD') ?? 2,
    );

    const [rejected, fraudFlags] = await Promise.all([
      this.prisma.victimProfile.groupBy({
        by: ['createdByUserId'],
        where: {
          status: VictimProfileStatus.REJECTED,
          createdByUserId: { not: null },
          deletedAt: null,
        },
        _count: { id: true },
        having: { id: { _count: { gte: threshold } } },
        orderBy: { _count: { id: 'desc' } },
      }),
      // "Suspected fraud" = a reader flagged it as false information and staff actioned the flag.
      this.prisma.victimProfileFlag.findMany({
        where: {
          reason: FlagReason.FALSE_INFORMATION,
          status: VictimProfileFlagStatus.ACTIONED,
          profile: { createdByUserId: { not: null } },
        },
        select: { profile: { select: { createdByUserId: true } } },
      }),
    ]);

    const stats = new Map<string, { rejectedCount: number; confirmedFalseInfoFlags: number }>();
    const bump = (id: string) => {
      const cur = stats.get(id) ?? { rejectedCount: 0, confirmedFalseInfoFlags: 0 };
      stats.set(id, cur);
      return cur;
    };
    for (const r of rejected) bump(r.createdByUserId as string).rejectedCount = r._count.id;
    for (const f of fraudFlags) {
      const c = f.profile.createdByUserId;
      if (c) bump(c).confirmedFalseInfoFlags += 1;
    }

    const rows = [...stats.entries()]
      .map(([creatorId, s]) => ({ creatorId, ...s, suspectedFraud: s.confirmedFalseInfoFlags > 0 }))
      .sort(
        (a, b) =>
          b.rejectedCount +
          b.confirmedFalseInfoFlags * 2 -
          (a.rejectedCount + a.confirmedFalseInfoFlags * 2),
      );

    const pageRows = rows.slice(skip, skip + limit);
    const names = await this.victimProfileCommonService.creatorNames(pageRows.map((r) => r.creatorId));

    return {
      data: pageRows.map((r) => ({ ...r, creatorName: names.get(r.creatorId) ?? null })),
      meta: this.victimProfileCommonService.metaOf(page, limit, rows.length),
    };
  }

  // VP-41
  async findFlags(_admin: CurrentUserDto, query: FindFlagsQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.VictimProfileFlagWhereInput = {
      ...(query.status ? { status: this.toFlagStatus(query.status) } : {}),
      ...(query.reason ? { reason: query.reason } : {}),
      ...(query.profileId ? { profileId: query.profileId } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.victimProfileFlag.findMany({
        where,
        include: {
          profile: { select: { id: true, name: true, involvesChild: true, status: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.victimProfileFlag.count({ where }),
    ]);

    return {
      data: rows.map(({ profile, ...flag }) => ({
        ...flag,
        profile: { id: profile.id, label: this.victimProfileCommonService.profileLabel(profile), status: profile.status },
      })),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }

  // The DTO's FlagStatus has RESOLVED; the table splits that into DISMISSED / ACTIONED.
  private toFlagStatus(
    status: string,
  ): VictimProfileFlagStatus | { in: VictimProfileFlagStatus[] } {
    if (status === 'RESOLVED') {
      return { in: [VictimProfileFlagStatus.DISMISSED, VictimProfileFlagStatus.ACTIONED] };
    }
    return status as VictimProfileFlagStatus;
  }
}
