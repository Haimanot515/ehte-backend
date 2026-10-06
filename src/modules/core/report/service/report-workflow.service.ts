import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditOutcome,
  AuditSeverity,
  ReportPriority,
  ReportResolutionOutcome,
  ReportStatus,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { RolesEnum } from 'src/common/enums/roles.enum';
import {
  AdminReportQueryDto,
  UpdateReportStatusDto,
  AssignReportDto,
  EscalateReportDto,
  PageQueryDto,
  QueueNextQueryDto,
  UpdateReportCategoryDto,
  UpdateReportPriorityDto,
  ResolveReportDto,
  BulkAssignReportsDto,
  BulkUpdateReportStatusDto,
  AssignTeamDto,
  DeEscalateReportDto,
} from '../dto/report.dto';
import {
  ALLOWED_STATUS_TRANSITIONS,
  TERMINAL_STATUSES,
  ADMIN_ROLE_NAMES,
  act,
} from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // Unscoped by assignment; only acting on a report is assignment-gated
  async findAllForAdmin(query: AdminReportQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.assignedTo
        ? { assignedToId: query.assignedTo }
        : query.assignmentStatus === 'unassigned'
          ? { assignedToId: null }
          : query.assignmentStatus === 'assigned'
            ? { assignedToId: { not: null } }
            : {}),
    };

    const [items, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          assignedTo: { select: { id: true, name: true } },
          user: { select: { id: true, name: true } },
        },
      }),
      this.prisma.report.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  async findAssignedToMe(admin: CurrentUserDto, query: { page?: number; limit?: number } = {}) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { assignedToId: admin.id };

    const [items, total] = await Promise.all([
      this.prisma.report.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        include: {
          user: { select: { id: true, name: true } },
        },
      }),
      this.prisma.report.count({ where }),
    ]);

    return { items, total, page, limit };
  }

  // Only unassigned AND non-terminal reports count as stale
  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('REPORT_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    const reports = await this.prisma.report.findMany({
      where: {
        status: { notIn: TERMINAL_STATUSES },
        assignedToId: null,
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
    });

    return reports.map((report) => ({
      ...report,
      pendingHours: Math.floor((Date.now() - report.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  // Open to any ADMIN/SUPER_ADMIN; assignment gates writes, not reads
  async findOneForAdmin(admin: CurrentUserDto, reportId: string) {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
      include: {
        user: {
          select: { id: true, name: true, phone: true },
        },
        informationRequests: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    const roles = this.reportCommonService.getRoles(admin);
    const actorType = resolveActorType(roles);

    this.reportCommonService.emitAudit({
      userId: admin.id,
      actorType,
      action: AuditEventEnum.REPORT_OPENED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: { result: 'success' },
    });

    this.reportCommonService.emitAudit({
      userId: admin.id,
      targetUserId: report.user?.id,
      actorType,
      action: AuditEventEnum.REPORTER_INFORMATION_OPENED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: { result: 'success' },
    });

    return report;
  }

  async getHistory(reportId: string) {
    const existing = await this.prisma.report.findUnique({ where: { id: reportId } });
    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    return this.prisma.auditLog.findMany({
      where: { entity: 'Report', entityId: reportId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // Conditional update guards against a concurrent admin transition
  async updateStatus(admin: CurrentUserDto, reportId: string, data: UpdateReportStatusDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.reportCommonService.assertAdminCanAccessReport(admin, existing, AuditEventEnum.REPORT_STATUS_CHANGED);

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(data.status)) {
      this.reportCommonService.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
        action: AuditEventEnum.REPORT_STATUS_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: {
          result: 'failure',
          attemptedStatus: data.status,
          currentStatus: existing.status,
        },
      });
      throw new BadRequestException(
        `invalid_status_transition: ${existing.status} -> ${data.status}`,
      );
    }

    const result = await this.prisma.report.updateMany({
      where: { id: reportId, status: existing.status },
      data: { status: data.status },
    });

    if (result.count === 0) {
      this.reportCommonService.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
        action: AuditEventEnum.REPORT_STATUS_CHANGED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: {
          result: 'failure',
          reason: 'report_transition_conflict',
          attemptedStatus: data.status,
        },
      });
      throw new BadRequestException('report_transition_conflict');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.reportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: AuditEventEnum.REPORT_STATUS_CHANGED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      reason: data.note ?? null,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: report.userId,
      caseReference: report.caseReference,
      status: report.status,
    });

    if (data.status === ReportStatus.REJECTED && report.userId) {
      await this.reportCommonService.maybeFlagUserForRejections(report.userId);
    }

    return report;
  }

  // Validates the target user actually holds an admin role
  async assign(admin: CurrentUserDto, reportId: string, data: AssignReportDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    const target = await this.prisma.user.findUnique({
      where: { id: data.assignedToUserId },
      include: {
        userRoles: {
          include: { role: true },
        },
      },
    });

    if (!target) {
      throw new NotFoundException('assignee_not_found');
    }

    const targetRoleNames = target.userRoles.map((ur) => ur.role.name);
    const isEligibleAdmin = targetRoleNames.some((name) =>
      ADMIN_ROLE_NAMES.includes(name as RolesEnum),
    );

    if (!isEligibleAdmin) {
      this.reportCommonService.emitAudit({
        userId: admin.id,
        targetUserId: data.assignedToUserId,
        actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
        action: AuditEventEnum.REPORT_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', reason: 'assignee_must_be_an_admin' },
      });
      throw new BadRequestException('assignee_must_be_an_admin');
    }

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];
    const shouldAutoSetAssigned =
      existing.status !== ReportStatus.ASSIGNED && allowedNext.includes(ReportStatus.ASSIGNED);

    const result = await this.prisma.report.updateMany({
      where: shouldAutoSetAssigned ? { id: reportId, status: existing.status } : { id: reportId },
      data: {
        assignedToId: data.assignedToUserId,
        ...(shouldAutoSetAssigned ? { status: ReportStatus.ASSIGNED } : {}),
      },
    });

    if (result.count === 0) {
      this.reportCommonService.emitAudit({
        userId: admin.id,
        targetUserId: data.assignedToUserId,
        actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
        action: AuditEventEnum.REPORT_ASSIGNED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', reason: 'report_transition_conflict' },
      });
      throw new BadRequestException('report_transition_conflict');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.reportCommonService.emitAudit({
      userId: admin.id,
      targetUserId: data.assignedToUserId,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: AuditEventEnum.REPORT_ASSIGNED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      reason: data.note ?? null,
      diff: {
        result: 'success',
        assignedToUserId: data.assignedToUserId,
        previousStatus: existing.status,
        currentStatus: report.status,
      },
      metadata: {
        assignedToName: target.name ?? null,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_ASSIGNED, {
      reportId,
      caseReference: report.caseReference,
      assignedToUserId: data.assignedToUserId,
    });

    return report;
  }

  // Status is left unchanged; no concurrency guard needed here
  async unassign(admin: CurrentUserDto, reportId: string) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { assignedToId: null },
    });

    this.reportCommonService.emitAudit({
      userId: admin.id,
      ...(existing.assignedToId ? { targetUserId: existing.assignedToId } : {}),
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: AuditEventEnum.REPORT_UNASSIGNED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: {
        result: 'success',
        previousAssignedToId: existing.assignedToId,
      },
    });

    return report;
  }

  // Checks ALLOWED_STATUS_TRANSITIONS directly, same rulebook as updateStatus
  async escalate(admin: CurrentUserDto, reportId: string, data: EscalateReportDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.reportCommonService.assertAdminCanAccessReport(admin, existing, AuditEventEnum.REPORT_ESCALATED);

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(ReportStatus.ESCALATED)) {
      this.reportCommonService.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
        action: AuditEventEnum.REPORT_ESCALATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', currentStatus: existing.status },
      });
      throw new BadRequestException(
        `invalid_status_transition: ${existing.status} -> ${ReportStatus.ESCALATED}`,
      );
    }

    const result = await this.prisma.report.updateMany({
      where: { id: reportId, status: existing.status },
      data: { status: ReportStatus.ESCALATED },
    });

    if (result.count === 0) {
      this.reportCommonService.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
        action: AuditEventEnum.REPORT_ESCALATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', reason: 'report_transition_conflict' },
      });
      throw new BadRequestException('report_transition_conflict');
    }

    const report = await this.prisma.report.findUniqueOrThrow({ where: { id: reportId } });

    this.reportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: AuditEventEnum.REPORT_ESCALATED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      reason: data.reason,
      diff: {
        result: 'success',
        previousStatus: existing.status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.HIGH_PRIORITY_REPORT, {
      reportId: report.id,
      caseReference: report.caseReference,
      reason: data.reason,
    });

    return report;
  }

  private async runBulk(ids: string[], fn: (id: string) => Promise<unknown>) {
    const unique = [...new Set(ids)];
    const succeeded: string[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    for (const id of unique) {
      try {
        await fn(id);
        succeeded.push(id);
      } catch (err) {
        failed.push({ id, reason: this.reportCommonService.errMsg(err) });
      }
    }
    return { requested: unique.length, succeeded, failed };
  }

  // RPT-06 PATCH /reports/:id/category
  async updateCategory(admin: CurrentUserDto, reportId: string, dto: UpdateReportCategoryDto) {
    const existing = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_CATEGORY_CHANGED'));
    if (existing.category === dto.category) return existing;

    const [report] = await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id: reportId },
        data: { category: dto.category, lastActivityAt: new Date() },
      }),
      this.reportCommonService.revision(reportId, admin.id, {
        category: { from: existing.category, to: dto.category },
        ...(dto.reason ? { reason: dto.reason } : {}),
      }),
    ]);

    this.reportCommonService.audit(
      admin,
      act('REPORT_CATEGORY_CHANGED'),
      report,
      {
        result: 'success',
        from: existing.category,
        to: dto.category,
      },
      { reason: dto.reason ?? null, targetUserId: report.isAnonymous ? null : report.userId },
    );
    return report;
  }

  // RPT-07 PATCH /reports/:id/priority
  async updatePriority(admin: CurrentUserDto, reportId: string, dto: UpdateReportPriorityDto) {
    const existing = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_PRIORITY_CHANGED'));
    if (existing.priority === dto.priority) return existing;

    const [report] = await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id: reportId },
        data: { priority: dto.priority as ReportPriority, lastActivityAt: new Date() },
      }),
      this.reportCommonService.revision(reportId, admin.id, {
        priority: { from: existing.priority, to: dto.priority },
        ...(dto.reason ? { reason: dto.reason } : {}),
      }),
    ]);

    this.reportCommonService.audit(
      admin,
      act('REPORT_PRIORITY_CHANGED'),
      report,
      {
        result: 'success',
        from: existing.priority,
        to: dto.priority,
      },
      { reason: dto.reason ?? null },
    );
    return report;
  }

  // RPT-08 POST /reports/:id/resolve
  async resolve(admin: CurrentUserDto, reportId: string, dto: ResolveReportDto) {
    const existing = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_RESOLVED'));

    if (!(ALLOWED_STATUS_TRANSITIONS[existing.status] ?? []).includes(ReportStatus.CLOSED)) {
      throw new BadRequestException(
        `invalid_status_transition: ${existing.status} -> ${ReportStatus.CLOSED}`,
      );
    }

    const report = await this.reportCommonService.applyTransition(
      existing,
      ReportStatus.CLOSED,
      admin.id,
      {
        closedAt: new Date(),
        resolutionOutcome: dto.outcome as ReportResolutionOutcome,
        resolutionSummary: dto.summary,
        resolvedById: admin.id,
      },
      `resolved:${dto.outcome}`,
    );
    if (!report) throw new BadRequestException('report_transition_conflict');

    this.reportCommonService.audit(
      admin,
      AuditEventEnum.REPORT_STATUS_CHANGED,
      report,
      {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
        outcome: dto.outcome,
      },
      { reason: dto.summary },
    );
    this.reportCommonService.notifyReporter(report);
    return report;
  }

  // RPT-09 PATCH /reports/bulk/assign   (Super Admin)
  async bulkAssign(admin: CurrentUserDto, dto: BulkAssignReportsDto) {
    const result = await this.runBulk(dto.ids, async (id) => {
      await this.assign(admin, id, { assignedToUserId: dto.adminId });
      await this.prisma.reportAssignmentHistory.create({
        data: {
          reportId: id,
          assignedToId: dto.adminId,
          assignedById: admin.id,
          note: 'bulk_assign',
        },
      });
    });
    this.reportCommonService.emitAudit({
      userId: admin.id,
      targetUserId: dto.adminId,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: act('REPORT_BULK_ACTION'),
      entity: 'Report',
      entityId: 'bulk',
      diff: { op: 'assign', requested: result.requested, failed: result.failed.length },
    });
    return result;
  }

  // RPT-10 PATCH /reports/bulk/status
  async bulkUpdateStatus(admin: CurrentUserDto, dto: BulkUpdateReportStatusDto) {
    const result = await this.runBulk(dto.ids, async (id) => {
      const report = await this.updateStatus(admin, id, { status: dto.status, note: dto.note });
      await this.prisma.reportStatusHistory.create({
        data: {
          reportId: id,
          toStatus: dto.status,
          // updateStatus already validated the transition; record the source status
          fromStatus: null,
          changedById: admin.id,
          note: dto.note ?? 'bulk_status',
        },
      });
      return report;
    });
    this.reportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: act('REPORT_BULK_ACTION'),
      entity: 'Report',
      entityId: 'bulk',
      diff: {
        op: 'status',
        status: dto.status,
        requested: result.requested,
        failed: result.failed.length,
      },
    });
    return result;
  }

  // RPT-72 PATCH /reports/:id/assign-team   (Super Admin)
  async assignTeam(admin: CurrentUserDto, reportId: string, dto: AssignTeamDto) {
    const existing = await this.reportCommonService.loadForAdmin(admin, reportId);
    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { assignedTeamId: dto.teamId, lastActivityAt: new Date() },
    });
    this.reportCommonService.audit(admin, act('REPORT_TEAM_ASSIGNED'), report, {
      result: 'success',
      from: existing.assignedTeamId,
      to: dto.teamId,
    });
    return report;
  }

  // RPT-73 GET /reports/queue/next
  // Atomically claims the highest-priority, oldest unassigned report for this admin.
  async queueNext(admin: CurrentUserDto, query: QueueNextQueryDto) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const candidate = await this.prisma.report.findFirst({
        where: {
          AND: [
            {
              deletedAt: null,
              archivedAt: null,
              mergedIntoId: null,
              assignedToId: null,
              status: { notIn: TERMINAL_STATUSES },
              ...(query.teamId ? { assignedTeamId: query.teamId } : {}),
            },
            this.reportCommonService.visibilityWhere(admin),
          ],
        },
        orderBy: [
          { priority: 'desc' },
          { dueAt: { sort: 'asc', nulls: 'last' } },
          { createdAt: 'asc' },
        ],
        select: { id: true, status: true },
      });
      if (!candidate) return null;

      const autoAssign =
        candidate.status !== ReportStatus.ASSIGNED &&
        (ALLOWED_STATUS_TRANSITIONS[candidate.status] ?? []).includes(ReportStatus.ASSIGNED);

      const now = new Date();
      const claimed = await this.prisma.report.updateMany({
        where: { id: candidate.id, assignedToId: null, status: candidate.status },
        data: {
          assignedToId: admin.id,
          lastActivityAt: now,
          ...(autoAssign ? { status: ReportStatus.ASSIGNED, reporterUpdatedAt: now } : {}),
        },
      });
      if (claimed.count === 0) continue; // someone else got it first

      await this.prisma.reportAssignmentHistory.create({
        data: {
          reportId: candidate.id,
          assignedToId: admin.id,
          assignedById: admin.id,
          note: 'queue_next',
        },
      });
      if (autoAssign) {
        await this.prisma.reportStatusHistory.create({
          data: {
            reportId: candidate.id,
            fromStatus: candidate.status,
            toStatus: ReportStatus.ASSIGNED,
            changedById: admin.id,
            note: 'queue_next',
          },
        });
      }

      const report = await this.prisma.report.findUniqueOrThrow({ where: { id: candidate.id } });
      this.reportCommonService.audit(
        admin,
        AuditEventEnum.REPORT_ASSIGNED,
        report,
        {
          result: 'success',
          assignedToUserId: admin.id,
          previousStatus: candidate.status,
          currentStatus: report.status,
        },
        { metadata: { source: 'queue_next' } },
      );
      this.eventEmitter.emit(NotificationEventEnum.REPORT_ASSIGNED, {
        reportId: report.id,
        caseReference: report.caseReference,
        assignedToUserId: admin.id,
      });
      return report;
    }
    return null;
  }

  // RPT-74 PATCH /reports/:id/de-escalate
  async deEscalate(admin: CurrentUserDto, reportId: string, dto: DeEscalateReportDto) {
    const existing = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_DE_ESCALATED'));
    if (existing.status !== ReportStatus.ESCALATED) {
      throw new BadRequestException('report_not_escalated');
    }

    const report = await this.reportCommonService.applyTransition(
      existing,
      ReportStatus.IN_PROGRESS,
      admin.id,
      {},
      `de_escalated: ${dto.reason}`,
    );
    if (!report) throw new BadRequestException('report_transition_conflict');

    const open = await this.prisma.reportEscalation.findFirst({
      where: { reportId, deEscalatedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    if (open) {
      await this.prisma.reportEscalation.update({
        where: { id: open.id },
        data: {
          deEscalatedAt: new Date(),
          deEscalatedById: admin.id,
          deEscalationReason: dto.reason,
        },
      });
    }

    this.reportCommonService.audit(
      admin,
      act('REPORT_DE_ESCALATED'),
      report,
      {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
      },
      { reason: dto.reason },
    );
    this.reportCommonService.notifyReporter(report);
    return report;
  }

  // RPT-75 GET /reports/escalated
  async listEscalated(admin: CurrentUserDto, query: PageQueryDto) {
    return this.reportCommonService.pagedReports(admin, { deletedAt: null, status: ReportStatus.ESCALATED }, query, [
      { priority: 'desc' },
      { updatedAt: 'desc' },
    ]);
  }

  async getEscalations(admin: CurrentUserDto, reportId: string) {
    await this.reportCommonService.loadForAdmin(admin, reportId);
    return this.prisma.reportEscalation.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // RPT-80 PATCH /reports/bulk/unassign   (Super Admin)
  async bulkUnassign(admin: CurrentUserDto, ids: string[]) {
    const result = await this.runBulk(ids, async (id) => {
      await this.unassign(admin, id);
      await this.prisma.reportAssignmentHistory.create({
        data: { reportId: id, assignedToId: null, assignedById: admin.id, note: 'bulk_unassign' },
      });
    });
    this.reportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: act('REPORT_BULK_ACTION'),
      entity: 'Report',
      entityId: 'bulk',
      diff: { op: 'unassign', requested: result.requested, failed: result.failed.length },
    });
    return result;
  }

  // RPT-81 GET /reports/:id/transitions
  async getAllowedTransitions(admin: CurrentUserDto, reportId: string) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);
    return {
      id: report.id,
      current: report.status,
      allowed: ALLOWED_STATUS_TRANSITIONS[report.status] ?? [],
    };
  }
}
