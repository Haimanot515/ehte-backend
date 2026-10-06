import { Injectable } from '@nestjs/common';
import {
  Prisma,
  SupportType,
  VictimProfileAppealStatus,
  VictimProfileFlagStatus,
  VictimProfileStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import {
  AdminSearchQueryDto,
  FlagReason,
  StatsInterval,
  StatsQueryDto,
} from '../dto/victim-profile.dto';
import { stripBank } from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  // VP-84
  async searchForAdmin(admin: CurrentUserDto, query: AdminSearchQueryDto) {
    const { page, limit, skip } = this.victimProfileCommonService.pageOf(query);
    const where: Prisma.VictimProfileWhereInput = {
      AND: [
        this.victimProfileCommonService.statsWhere(query),
        {
          OR: [
            { id: query.q },
            { name: { contains: query.q, mode: 'insensitive' } },
            { description: { contains: query.q, mode: 'insensitive' } },
            { story: { contains: query.q, mode: 'insensitive' } },
          ],
        },
      ],
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
        ...stripBank(row),
        isRead: readStates.length > 0,
      })),
      meta: this.victimProfileCommonService.metaOf(page, limit, total),
    };
  }

  // VP-85
  async getFacets(admin: CurrentUserDto, query: StatsQueryDto) {
    const where = this.victimProfileCommonService.statsWhere(query);

    const [
      byStatus,
      byCategory,
      byChild,
      byAssignee,
      unassigned,
      unclaimed,
      flagged,
      paused,
      held,
      unread,
    ] = await Promise.all([
      this.prisma.victimProfile.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.victimProfile.groupBy({
        by: ['supportType'],
        where,
        _count: { _all: true },
        orderBy: { supportType: 'asc' },
      }),
      this.prisma.victimProfile.groupBy({
        by: ['involvesChild'],
        where,
        _count: { _all: true },
        orderBy: { involvesChild: 'asc' },
      }),
      this.prisma.victimProfile.groupBy({
        by: ['assignedReviewerId'],
        where: { AND: [where, { assignedReviewerId: { not: null } }] },
        _count: { _all: true },
        orderBy: { assignedReviewerId: 'asc' },
      }),
      this.prisma.victimProfile.count({ where: { AND: [where, { assignedReviewerId: null }] } }),
      this.prisma.victimProfile.count({ where: { AND: [where, { claimedByUserId: null }] } }),
      this.prisma.victimProfile.count({
        where: { AND: [where, { flags: { some: { status: VictimProfileFlagStatus.OPEN } } }] },
      }),
      this.prisma.victimProfile.count({ where: { AND: [where, { donationsPaused: true }] } }),
      this.prisma.victimProfile.count({ where: { AND: [where, { legalHold: true }] } }),
      this.prisma.victimProfile.count({ where: { AND: [where, this.victimProfileCommonService.unreadWhere(admin)] } }),
    ]);

    return {
      status: Object.fromEntries(byStatus.map((r) => [r.status, r._count._all])),
      category: Object.fromEntries(
        byCategory.map((r) => [r.supportType ?? 'UNSPECIFIED', r._count._all]),
      ),
      involvesChild: Object.fromEntries(
        byChild.map((r) => [String(r.involvesChild), r._count._all]),
      ),
      assignedReviewer: {
        unassigned,
        ...Object.fromEntries(
          byAssignee.map((r) => [r.assignedReviewerId as string, r._count._all]),
        ),
      },
      unclaimed,
      withOpenFlags: flagged,
      donationsPaused: paused,
      underLegalHold: held,
      unreadForMe: unread,
    };
  }

  // VP-86
  async getFilterOptions(_admin: CurrentUserDto) {
    const reviewers = await this.prisma.user.findMany({
      where: {
        isActive: true,
        userRoles: { some: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] } } } },
      },
      select: { id: true, name: true },
      orderBy: { name: 'asc' },
    });

    return {
      statuses: Object.values(VictimProfileStatus),
      categories: Object.values(SupportType),
      flagReasons: Object.values(FlagReason),
      flagStatuses: Object.values(VictimProfileFlagStatus),
      appealStatuses: Object.values(VictimProfileAppealStatus),
      intervals: Object.values(StatsInterval),
      reviewers,
    };
  }
}
