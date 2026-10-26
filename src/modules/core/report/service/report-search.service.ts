import { Injectable, NotFoundException } from '@nestjs/common';
import {
  ReportCategory,
  ReportIntegrityFlag,
  ReportPriority,
  ReportSensitivity,
  ReportStatus,
  SubmissionChannel,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { PageQueryDto, ReportStatsQueryDto, SearchReportsQueryDto } from '../dto/report.dto';
import { ADMIN_ROLE_NAMES } from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportSearchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // RPT-128 GET /reports/search?q=
  // Case-insensitive match over reference, description, location, region and tag names.
  async searchReports(admin: CurrentUserDto, query: SearchReportsQueryDto) {
    const term = query.q.trim();
    return this.reportCommonService.pagedReports(
      admin,
      {
        deletedAt: null,
        ...(query.status ? { status: query.status } : {}),
        ...(query.category ? { category: query.category } : {}),
        ...(query.assignedTo ? { assignedToId: query.assignedTo } : {}),
        OR: [
          { caseReference: { contains: term, mode: 'insensitive' } },
          { description: { contains: term, mode: 'insensitive' } },
          { location: { contains: term, mode: 'insensitive' } },
          { region: { contains: term, mode: 'insensitive' } },
          { tags: { some: { tag: { name: { contains: term.toLowerCase() } } } } },
        ],
      },
      query,
    );
  }

  // RPT-129 GET /reports/by-reference/:reference
  async findByReference(admin: CurrentUserDto, reference: string) {
    const found = await this.prisma.report.findFirst({
      where: {
        AND: [
          { caseReference: reference.trim().toUpperCase(), deletedAt: null },
          this.reportCommonService.visibilityWhere(admin),
        ],
      },
      select: { id: true },
    });
    if (!found) throw new NotFoundException('report_not_found');

    const { items } = await this.reportCommonService.pagedReports(admin, { id: found.id }, { page: 1, limit: 1 });
    return items[0];
  }

  // RPT-130 GET /reports/facets
  async getFacets(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const [status, category, priority, channel, sensitivity, region, assignment] =
      await Promise.all([
        this.reportCommonService.countBy(admin, query, 'status'),
        this.reportCommonService.countBy(admin, query, 'category'),
        this.reportCommonService.countBy(admin, query, 'priority'),
        this.reportCommonService.countBy(admin, query, 'channel'),
        this.reportCommonService.countBy(admin, query, 'sensitivity'),
        this.reportCommonService.countBy(admin, query, 'region'),
        this.reportCommonService.getStatsAssignment(admin, query),
      ]);
    return {
      total: status.total,
      status,
      category,
      priority,
      channel,
      sensitivity,
      region,
      assignment,
    };
  }

  // RPT-131 GET /reports/filters/options
  async getFilterOptions(admin: CurrentUserDto) {
    const [regions, teams, tags, admins] = await Promise.all([
      this.prisma.report.findMany({
        where: { deletedAt: null, region: { not: null } },
        distinct: ['region'],
        select: { region: true },
        orderBy: { region: 'asc' },
      }),
      this.prisma.report.findMany({
        where: { deletedAt: null, assignedTeamId: { not: null } },
        distinct: ['assignedTeamId'],
        select: { assignedTeamId: true },
        orderBy: { assignedTeamId: 'asc' },
      }),
      this.prisma.reportTag.findMany({
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
      this.prisma.user.findMany({
        where: { userRoles: { some: { role: { name: { in: ADMIN_ROLE_NAMES as string[] } } } } },
        select: { id: true, name: true },
        orderBy: { name: 'asc' },
      }),
    ]);

    return {
      statuses: Object.values(ReportStatus),
      categories: Object.values(ReportCategory),
      priorities: Object.values(ReportPriority),
      sensitivities: Object.values(ReportSensitivity),
      channels: Object.values(SubmissionChannel),
      integrityFlags: Object.values(ReportIntegrityFlag),
      regions: regions.map((r) => r.region!),
      teams: teams.map((t) => t.assignedTeamId!),
      tags,
      admins,
      canSeeAllAdmins: this.reportCommonService.isSuperAdmin(admin),
    };
  }

  // RPT-132 GET /reports/:id/revisions
  async getRevisions(admin: CurrentUserDto, reportId: string, query: PageQueryDto) {
    await this.reportCommonService.loadForAdmin(admin, reportId);
    const { page, limit, skip, take } = this.reportCommonService.paging(query);
    const where = { reportId };
    const [items, total] = await Promise.all([
      this.prisma.reportRevision.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.reportRevision.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  // RPT-141 GET /reports/categories   (for the submit form)
  getCategories() {
    const labels: Record<ReportCategory, string> = {
      HARASSMENT: 'Harassment',
      ABUSE: 'Abuse',
      FRAUD: 'Fraud',
      THREAT: 'Threat',
      DISCRIMINATION: 'Discrimination',
      SAFETY_CONCERN: 'Safety concern',
      OTHER: 'Other',
    };
    return Object.values(ReportCategory).map((value) => ({ value, label: labels[value] ?? value }));
  }
}
