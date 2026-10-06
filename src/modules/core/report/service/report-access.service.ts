import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditSeverity, ReportSensitivity } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { RolesEnum } from 'src/common/enums/roles.enum';
import {
  PageQueryDto,
  UpdateReportSensitivityDto,
  GrantReportAccessDto,
  RevealReporterDto,
  LegalHoldDto,
} from '../dto/report.dto';
import { ADMIN_ROLE_NAMES, act, RequestCtx } from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // RPT-104 PATCH /reports/:id/sensitivity
  async updateSensitivity(
    admin: CurrentUserDto,
    reportId: string,
    dto: UpdateReportSensitivityDto,
  ) {
    const existing = await this.reportCommonService.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_SENSITIVITY_CHANGED'),
    );
    if (existing.sensitivity === dto.level) return existing;

    const [report] = await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id: reportId },
        data: { sensitivity: dto.level as ReportSensitivity, lastActivityAt: new Date() },
      }),
      this.reportCommonService.revision(reportId, admin.id, {
        sensitivity: { from: existing.sensitivity, to: dto.level },
        reason: dto.reason,
      }),
    ]);
    this.reportCommonService.audit(
      admin,
      act('REPORT_SENSITIVITY_CHANGED'),
      report,
      {
        result: 'success',
        from: existing.sensitivity,
        to: dto.level,
      },
      { reason: dto.reason, severity: AuditSeverity.WARNING },
    );
    return report;
  }

  // RPT-105 GET /reports/:id/access-log   (Super Admin)
  async getAccessLog(admin: CurrentUserDto, reportId: string, query: PageQueryDto) {
    await this.reportCommonService.loadForAdmin(admin, reportId, { includeDeleted: true });
    const { page, limit, skip, take } = this.reportCommonService.paging(query);
    const where = { reportId };

    const [rows, total] = await Promise.all([
      this.prisma.reportAccessLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
      this.prisma.reportAccessLog.count({ where }),
    ]);

    const userIds = [...new Set(rows.map((r) => r.userId).filter((v): v is string => !!v))];
    const users = userIds.length
      ? await this.prisma.user.findMany({
          where: { id: { in: userIds } },
          select: { id: true, name: true },
        })
      : [];
    const names = new Map(users.map((u) => [u.id, u.name]));

    return {
      items: rows.map((r) => ({ ...r, userName: r.userId ? (names.get(r.userId) ?? null) : null })),
      total,
      page,
      limit,
    };
  }

  // RPT-106 GET /reports/:id/access-grants
  async listAccessGrants(admin: CurrentUserDto, reportId: string) {
    await this.reportCommonService.loadForAdmin(admin, reportId);
    const grants = await this.prisma.reportAccessGrant.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
      include: { admin: { select: { id: true, name: true } } },
    });
    const now = Date.now();
    return grants.map((g) => ({
      ...g,
      isActive: !g.revokedAt && (!g.expiresAt || g.expiresAt.getTime() > now),
    }));
  }

  // RPT-107 POST /reports/:id/access-grants
  async grantAccess(admin: CurrentUserDto, reportId: string, dto: GrantReportAccessDto) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);

    const target = await this.prisma.user.findUnique({
      where: { id: dto.adminId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!target) throw new NotFoundException('assignee_not_found');
    if (!target.userRoles.some((ur) => ADMIN_ROLE_NAMES.includes(ur.role.name as RolesEnum))) {
      throw new BadRequestException('grantee_must_be_an_admin');
    }

    const expiresAt = dto.expiresAt ? new Date(dto.expiresAt) : null;
    if (expiresAt && expiresAt.getTime() <= Date.now()) {
      throw new BadRequestException('expiry_must_be_in_the_future');
    }

    const active = await this.prisma.reportAccessGrant.findFirst({
      where: { reportId, ...this.reportCommonService.activeGrantWhere(dto.adminId) },
    });
    if (active) throw new ConflictException('access_already_granted');

    const grant = await this.prisma.reportAccessGrant.create({
      data: {
        reportId,
        adminId: dto.adminId,
        grantedById: admin.id,
        reason: dto.reason,
        expiresAt,
      },
    });
    this.reportCommonService.audit(
      admin,
      act('REPORT_ACCESS_GRANTED'),
      report,
      {
        result: 'success',
        grantedTo: dto.adminId,
        expiresAt,
      },
      { reason: dto.reason, targetUserId: dto.adminId, severity: AuditSeverity.WARNING },
    );
    return grant;
  }

  // RPT-108 DELETE /reports/:id/access-grants/:adminId
  async revokeAccess(admin: CurrentUserDto, reportId: string, adminId: string) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);
    const res = await this.prisma.reportAccessGrant.updateMany({
      where: { reportId, adminId, revokedAt: null },
      data: { revokedAt: new Date(), revokedById: admin.id },
    });
    if (res.count === 0) throw new NotFoundException('access_grant_not_found');
    this.reportCommonService.audit(
      admin,
      act('REPORT_ACCESS_REVOKED'),
      report,
      {
        result: 'success',
        revokedFrom: adminId,
      },
      { targetUserId: adminId },
    );
    return { revoked: res.count };
  }

  // RPT-109 POST /reports/:id/reveal-reporter   (break-glass, Super Admin)
  // The reveal is written first and cannot be skipped; the identity is only returned after.
  async revealReporter(
    admin: CurrentUserDto,
    reportId: string,
    dto: RevealReporterDto,
    ctx?: RequestCtx,
  ) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);
    if (!report.userId) throw new NotFoundException('reporter_unknown');

    await this.prisma.reportReporterReveal.create({
      data: {
        reportId,
        revealedById: admin.id,
        reason: dto.reason,
        ticketRef: dto.ticketRef ?? null,
      },
    });
    await this.reportCommonService.logAccess(reportId, admin.id, 'REPORTER_REVEAL', ctx);

    const reporter = await this.prisma.user.findUnique({
      where: { id: report.userId },
      select: { id: true, name: true, phone: true },
    });

    this.reportCommonService.audit(
      admin,
      act('REPORTER_REVEALED'),
      report,
      {
        result: 'success',
        wasAnonymous: report.isAnonymous,
      },
      {
        reason: dto.reason,
        targetUserId: report.userId,
        severity: AuditSeverity.WARNING,
        metadata: { ticketRef: dto.ticketRef ?? null },
      },
    );

    return { reportId, wasAnonymous: report.isAnonymous, reporter };
  }

  // RPT-110 PATCH /reports/:id/legal-hold
  async setLegalHold(admin: CurrentUserDto, reportId: string, dto: LegalHoldDto) {
    const existing = await this.reportCommonService.loadForAdmin(admin, reportId, { includeDeleted: true });
    if (existing.legalHold === dto.enabled) return existing;

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: dto.enabled
        ? {
            legalHold: true,
            legalHoldReason: dto.reason,
            legalHoldAt: new Date(),
            legalHoldById: admin.id,
          }
        : { legalHold: false, legalHoldReason: null, legalHoldAt: null, legalHoldById: null },
    });
    this.reportCommonService.audit(
      admin,
      act('REPORT_LEGAL_HOLD_CHANGED'),
      report,
      {
        result: 'success',
        enabled: dto.enabled,
      },
      { reason: dto.reason, severity: AuditSeverity.WARNING },
    );
    return report;
  }
}
