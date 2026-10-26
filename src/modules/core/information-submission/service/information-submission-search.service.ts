import { Injectable } from '@nestjs/common';
import {
  InformationStatus,
  Prisma,
  InformationPriority as PrismaInformationPriority,
  InformationCredibility as PrismaInformationCredibility,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { AdminSearchInformationSubmissionsQueryDto } from '../dto/information-submission.dto';
import { OPEN_STATUSES } from './information-submission.constants';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

  async searchForAdmin(admin: CurrentUserDto, query: AdminSearchInformationSubmissionsQueryDto) {
    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);
    const q = query.q.trim();

    const where: Prisma.InformationSubmissionWhereInput = {
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      OR: [
        { id: q },
        { information: { contains: q, mode: 'insensitive' } },
        { location: { contains: q, mode: 'insensitive' } },
        { reviewNote: { contains: q, mode: 'insensitive' } },
        { missingPerson: { name: { contains: q, mode: 'insensitive' } } },
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: {
          missingPerson: { select: { id: true, name: true, personType: true } },
          assignedTo: { select: { id: true, name: true } },
          adminReads: { where: { adminId: admin.id }, select: { adminId: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    const data = rows.map(({ adminReads, ...rest }) => ({
      ...rest,
      isRead: adminReads.length > 0,
    }));
    return { data, meta: this.informationSubmissionCommonService.pageMeta(page, limit, total), q };
  }

  async getFacets() {
    const base = { deletedAt: null };
    const [byStatus, byPriority, byCredibility, byChannel, byResolution, unassigned, assigned] =
      await Promise.all([
        this.prisma.informationSubmission.groupBy({
          by: ['status'],
          where: base,
          _count: { _all: true },
        }),
        this.prisma.informationSubmission.groupBy({
          by: ['priority'],
          where: base,
          _count: { _all: true },
        }),
        this.prisma.informationSubmission.groupBy({
          by: ['credibility'],
          where: base,
          _count: { _all: true },
        }),
        this.prisma.informationSubmission.groupBy({
          by: ['channel'],
          where: base,
          _count: { _all: true },
        }),
        this.prisma.informationSubmission.groupBy({
          by: ['resolution'],
          where: { ...base, resolution: { not: null } },
          _count: { _all: true },
        }),
        this.prisma.informationSubmission.count({
          where: { ...base, assignedToId: null, status: { in: OPEN_STATUSES } },
        }),
        this.prisma.informationSubmission.groupBy({
          by: ['assignedToId'],
          where: { ...base, assignedToId: { not: null }, status: { in: OPEN_STATUSES } },
          _count: { _all: true },
        }),
      ]);

    const names = await this.informationSubmissionCommonService.userNameMap(assigned.map((a) => a.assignedToId));
    const toMap = <T extends string>(
      rows: Array<Record<string, unknown> & { _count: { _all: number } }>,
      key: string,
    ) => Object.fromEntries(rows.map((r) => [String(r[key] as T), r._count._all]));

    return {
      status: toMap(byStatus, 'status'),
      priority: toMap(byPriority, 'priority'),
      credibility: toMap(byCredibility, 'credibility'),
      channel: toMap(byChannel, 'channel'),
      resolution: toMap(byResolution, 'resolution'),
      assignment: {
        unassignedOpen: unassigned,
        byAdmin: assigned.map((a) => ({
          adminId: a.assignedToId,
          name: a.assignedToId ? (names.get(a.assignedToId) ?? null) : null,
          open: a._count._all,
        })),
      },
    };
  }

  async getFilterOptions() {
    const [admins, caseRows] = await Promise.all([
      this.prisma.user.findMany({
        where: {
          isActive: true,
          userRoles: {
            some: { role: { name: { in: [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN] as string[] } } },
          },
        },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
        take: 200,
      }),
      this.prisma.informationSubmission.groupBy({
        by: ['missingPersonId'],
        where: { deletedAt: null },
        _count: { _all: true },
        orderBy: { _max: { createdAt: 'desc' } },
        take: 200,
      }),
    ]);

    const cases = await this.informationSubmissionCommonService.caseNameMap(caseRows.map((c) => c.missingPersonId));

    return {
      statuses: Object.values(InformationStatus),
      priorities: Object.values(PrismaInformationPriority),
      credibilities: Object.values(PrismaInformationCredibility),
      channels: ['APP', 'USSD'],
      resolutions: ['DUPLICATE', 'ALREADY_KNOWN'],
      admins,
      cases: caseRows.map((c) => ({
        id: c.missingPersonId,
        name: cases.get(c.missingPersonId)?.name ?? null,
        tips: c._count._all,
      })),
    };
  }
}
