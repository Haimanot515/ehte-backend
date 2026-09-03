import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';

import { InformationRequestStatus, Prisma, ReportStatus } from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';

import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { RolesEnum } from 'src/common/enums/roles.enum';

import {
  CreateReportDto,
  UpdateReportDto,
  AdminReportQueryDto,
  UpdateReportStatusDto,
  AssignReportDto,
  RequestMoreInformationDto,
  EscalateReportDto,
  RespondToInformationRequestDto,
} from '../dto/report.dto';

// ─────────────────────────────────────────────
// STATUS STATE MACHINE
//
// Adjust to match your actual PRD workflow — this is
// a reasonable default based on the flow discussed,
// not confirmed against your PRD.
// ─────────────────────────────────────────────

const ALLOWED_STATUS_TRANSITIONS: Record<ReportStatus, ReportStatus[]> = {
  [ReportStatus.PENDING]: [ReportStatus.RECEIVED, ReportStatus.REJECTED],
  [ReportStatus.RECEIVED]: [ReportStatus.UNDER_REVIEW, ReportStatus.REJECTED],
  [ReportStatus.UNDER_REVIEW]: [
    ReportStatus.ASSIGNED,
    ReportStatus.ESCALATED,
    ReportStatus.UNABLE_TO_VERIFY,
    ReportStatus.REJECTED,
  ],
  [ReportStatus.ASSIGNED]: [ReportStatus.IN_PROGRESS, ReportStatus.ESCALATED],
  [ReportStatus.IN_PROGRESS]: [
    ReportStatus.ESCALATED,
    ReportStatus.CLOSED,
    ReportStatus.UNABLE_TO_VERIFY,
  ],
  [ReportStatus.ESCALATED]: [ReportStatus.IN_PROGRESS, ReportStatus.CLOSED],
  [ReportStatus.UNABLE_TO_VERIFY]: [ReportStatus.CLOSED, ReportStatus.UNDER_REVIEW],
  [ReportStatus.CLOSED]: [],
  [ReportStatus.REJECTED]: [],
};

const ADMIN_ROLE_NAMES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

// How many times to retry case-reference generation on a unique
// constraint collision before giving up.
const CASE_REFERENCE_MAX_ATTEMPTS = 5;

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  // ─────────────────────────────────────────────
  // ACCESS CONTROL HELPER
  //
  // Shared by every admin-facing report operation.
  // SUPER_ADMIN may act on any report. A plain ADMIN
  // may only act on a report that is unassigned or
  // assigned specifically to them. Previously only
  // findOneForAdmin() enforced this; updateStatus(),
  // requestMoreInformation(), and escalate() did not.
  // ─────────────────────────────────────────────

  private assertAdminCanAccessReport(
    admin: CurrentUserDto,
    report: { assignedToId: string | null },
  ): void {
    const roles = this.getRoles(admin);
    const isSuperAdmin = roles.includes(RolesEnum.SUPER_ADMIN);

    if (!isSuperAdmin && report.assignedToId && report.assignedToId !== admin.id) {
      throw new ForbiddenException('report_assigned_to_another_admin');
    }
  }

  // ─────────────────────────────────────────────
  // CREATE REPORT
  // ─────────────────────────────────────────────

  async create(user: CurrentUserDto, data: CreateReportDto) {
    const report = await this.createReportWithUniqueCaseReference(user, data);

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
      action: AuditEventEnum.REPORT_CREATED,
      entity: 'Report',
      entityId: report.id,
      diff: { result: 'success', status: report.status },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_RECEIVED, {
      reportId: report.id,
      userId: user.id,
    });

    this.eventEmitter.emit(NotificationEventEnum.NEW_REPORT, {
      reportId: report.id,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // GET MY REPORTS
  // ─────────────────────────────────────────────

  async findMyReports(user: CurrentUserDto) {
    return this.prisma.report.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // GET ONE OF MY REPORTS
  // ─────────────────────────────────────────────

  async findOne(user: CurrentUserDto, reportId: string) {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    return report;
  }

  // ─────────────────────────────────────────────
  // UPDATE REPORT
  // ─────────────────────────────────────────────

  async update(user: CurrentUserDto, reportId: string, data: UpdateReportDto) {
    const existing = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    if (existing.status !== ReportStatus.PENDING) {
      throw new BadRequestException('only_pending_reports_can_be_updated');
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        ...(data.category !== undefined ? { category: data.category } : {}),
        ...(data.description !== undefined ? { description: data.description } : {}),
        ...(data.location !== undefined ? { location: data.location } : {}),
        ...(data.incidentAt !== undefined ? { incidentAt: new Date(data.incidentAt) } : {}),
        ...(data.photo !== undefined ? { photo: data.photo } : {}),
        ...(data.video !== undefined ? { video: data.video } : {}),
        ...(data.audio !== undefined ? { audio: data.audio } : {}),
        ...(data.pdf !== undefined ? { pdf: data.pdf } : {}),
        ...(data.document !== undefined ? { document: data.document } : {}),
        ...(data.other !== undefined ? { other: data.other } : {}),
      },
    });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
      action: AuditEventEnum.REPORT_UPDATED,
      entity: 'Report',
      entityId: report.id,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: user.id,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // WITHDRAW REPORT (USER)
  //
  // NEW: lets a reporter withdraw their own report while it's
  // still PENDING — the same window during which they can edit
  // it. Reuses ReportStatus.REJECTED since there is no dedicated
  // WITHDRAWN status in the schema. If you want to distinguish
  // "reporter withdrew" from "admin rejected" later (e.g. for
  // reporting/metrics), that needs a schema/enum change — the
  // audit trail already records REPORT_WITHDRAWN separately so
  // the distinction isn't lost even though status collapses the
  // two together.
  // ─────────────────────────────────────────────

  async withdraw(user: CurrentUserDto, reportId: string) {
    const existing = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    if (existing.status !== ReportStatus.PENDING) {
      throw new BadRequestException('only_pending_reports_can_be_withdrawn');
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { status: ReportStatus.REJECTED },
    });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
      action: AuditEventEnum.REPORT_WITHDRAWN,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: user.id,
    });

    return report;
  }

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

  // ─────────────────────────────────────────────
  // GET REPORTS ASSIGNED TO ME (ADMIN)
  //
  // Paginated to match findAllForAdmin, and includes
  // reporter summary fields for dashboard display.
  // ─────────────────────────────────────────────

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

  // ─────────────────────────────────────────────
  // GET ONE REPORT — FULL DETAIL (ADMIN)
  //
  // SUPER_ADMIN sees any report. A plain ADMIN may
  // only open reports that are unassigned or assigned
  // specifically to them.
  // ─────────────────────────────────────────────

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

    this.assertAdminCanAccessReport(admin, report);

    const roles = this.getRoles(admin);
    const actorType = resolveActorType(roles);

    this.emitAudit({
      userId: admin.id,
      actorType,
      action: AuditEventEnum.REPORT_OPENED,
      entity: 'Report',
      entityId: reportId,
      diff: { result: 'success' },
    });

    this.emitAudit({
      userId: admin.id,
      actorType,
      action: AuditEventEnum.REPORTER_INFORMATION_OPENED,
      entity: 'Report',
      entityId: reportId,
      diff: { result: 'success' },
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // UPDATE STATUS (ADMIN)
  // Transitions validated against ALLOWED_STATUS_TRANSITIONS.
  // ─────────────────────────────────────────────

  async updateStatus(admin: CurrentUserDto, reportId: string, data: UpdateReportStatusDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.assertAdminCanAccessReport(admin, existing);

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(data.status)) {
      throw new BadRequestException(
        `invalid_status_transition: ${existing.status} -> ${data.status}`,
      );
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { status: data.status },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_STATUS_CHANGED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        currentStatus: report.status,
        note: data.note ?? null,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: report.userId,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // REQUEST MORE INFORMATION (ADMIN)
  //
  // Persists a ReportInformationRequest row, which the
  // user-response endpoint below reads and updates.
  // Enforces the same admin-access rule as findOneForAdmin,
  // and refuses to open a second request while one is
  // still PENDING — otherwise requests could stack up
  // with no way for the user to tell which is current.
  // ─────────────────────────────────────────────

  async requestMoreInformation(
    admin: CurrentUserDto,
    reportId: string,
    data: RequestMoreInformationDto,
  ) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.assertAdminCanAccessReport(admin, existing);

    const openRequest = await this.prisma.reportInformationRequest.findFirst({
      where: { reportId, status: InformationRequestStatus.PENDING },
    });

    if (openRequest) {
      throw new BadRequestException('information_request_already_pending');
    }

    const infoRequest = await this.prisma.reportInformationRequest.create({
      data: {
        reportId,
        requestedById: admin.id,
        message: data.message,
        status: InformationRequestStatus.PENDING,
      },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_MORE_INFORMATION_REQUESTED,
      entity: 'Report',
      entityId: reportId,
      diff: { result: 'success', informationRequestId: infoRequest.id, message: data.message },
    });

    this.eventEmitter.emit(NotificationEventEnum.MORE_INFORMATION_REQUESTED, {
      reportId,
      informationRequestId: infoRequest.id,
      userId: existing.userId,
      message: data.message,
    });

    return infoRequest;
  }

  // ─────────────────────────────────────────────
  // LIST INFORMATION REQUESTS
  //
  // NEW: backs GET /reports/:id/information-requests.
  // The reporter may list requests for their own report.
  // An admin may list them for any report they're allowed
  // to open (same rule as findOneForAdmin: SUPER_ADMIN sees
  // any report, plain ADMIN only unassigned or assigned-to-them).
  // ─────────────────────────────────────────────

  async findInformationRequests(user: CurrentUserDto, reportId: string) {
    const roles = this.getRoles(user);
    const isAdmin = roles.some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));

    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    if (isAdmin) {
      this.assertAdminCanAccessReport(user, report);
    } else if (report.userId !== user.id) {
      throw new NotFoundException('report_not_found');
    }

    return this.prisma.reportInformationRequest.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // GET ONE INFORMATION REQUEST
  //
  // NEW: backs GET /reports/:id/information-requests/:requestId.
  // Same access rule as findInformationRequests: the reporter
  // sees requests on their own report; an admin sees requests on
  // any report they're allowed to open.
  // ─────────────────────────────────────────────

  async findOneInformationRequest(user: CurrentUserDto, reportId: string, requestId: string) {
    const roles = this.getRoles(user);
    const isAdmin = roles.some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));

    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    if (isAdmin) {
      this.assertAdminCanAccessReport(user, report);
    } else if (report.userId !== user.id) {
      throw new NotFoundException('report_not_found');
    }

    const infoRequest = await this.prisma.reportInformationRequest.findFirst({
      where: { id: requestId, reportId },
    });

    if (!infoRequest) {
      throw new NotFoundException('information_request_not_found');
    }

    return infoRequest;
  }

  // ─────────────────────────────────────────────
  // RESPOND TO INFORMATION REQUEST (USER)
  //
  // NEW: backs the previously-missing
  // POST /reports/:id/information-requests/:requestId/respond
  // endpoint. Only the reporter who owns the report may
  // respond, and only to a request still PENDING.
  // ─────────────────────────────────────────────

  async respondToInformationRequest(
    user: CurrentUserDto,
    reportId: string,
    requestId: string,
    data: RespondToInformationRequestDto,
  ) {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    const infoRequest = await this.prisma.reportInformationRequest.findFirst({
      where: { id: requestId, reportId },
    });

    if (!infoRequest) {
      throw new NotFoundException('information_request_not_found');
    }

    if (infoRequest.status !== InformationRequestStatus.PENDING) {
      throw new BadRequestException('information_request_already_responded');
    }

    const updated = await this.prisma.reportInformationRequest.update({
      where: { id: requestId },
      data: {
        responseMessage: data.responseMessage,
        responseFiles: data.responseFiles ?? [],
        status: InformationRequestStatus.RESPONDED,
        respondedAt: new Date(),
      },
    });

    this.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.getRoles(user)),
      action: AuditEventEnum.REPORT_INFORMATION_RESPONDED,
      entity: 'Report',
      entityId: reportId,
      diff: { result: 'success', informationRequestId: requestId },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_REQUEST_RESPONDED, {
      reportId,
      informationRequestId: requestId,
      requestedById: infoRequest.requestedById,
    });

    return updated;
  }

  // ─────────────────────────────────────────────
  // ASSIGN (ADMIN)
  //
  // Persists assignedToId and flips status to ASSIGNED
  // when that transition is legal from the report's
  // current status. Validates the target user actually
  // holds an admin role.
  //   ⚠️ ASSUMPTION: userRoles -> role.name shape.
  //   Adjust to your real UserRole/Role schema.
  //
  // NOTE: if the current status does not allow a direct
  // transition to ASSIGNED (e.g. reassigning a report
  // that is already IN_PROGRESS), assignedToId is still
  // updated but status is left unchanged. Confirm this
  // silent-no-status-change behavior is what you want for
  // reassignment — otherwise consider throwing instead.
  // ─────────────────────────────────────────────

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
      throw new BadRequestException('assignee_must_be_an_admin');
    }

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];
    const shouldAutoSetAssigned =
      existing.status !== ReportStatus.ASSIGNED && allowedNext.includes(ReportStatus.ASSIGNED);

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        assignedToId: data.assignedToUserId,
        ...(shouldAutoSetAssigned ? { status: ReportStatus.ASSIGNED } : {}),
      },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_ASSIGNED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        assignedToUserId: data.assignedToUserId,
        previousStatus: existing.status,
        currentStatus: report.status,
        note: data.note ?? null,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.REPORT_ASSIGNED, {
      reportId,
      assignedToUserId: data.assignedToUserId,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // UNASSIGN (ADMIN)
  //
  // NEW: clears assignedToId back to null. Restricted to
  // SUPER_ADMIN at the controller level, mirroring assign()'s
  // current role restriction. Status is left unchanged — same
  // silent-no-status-change approach assign() already takes;
  // revisit if you'd rather step status back to UNDER_REVIEW
  // when a report becomes unassigned.
  // ─────────────────────────────────────────────

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

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_UNASSIGNED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        previousAssignedToId: existing.assignedToId,
      },
    });

    return report;
  }
  //
  // Now checks ALLOWED_STATUS_TRANSITIONS directly instead
  // of a separate terminal-state blocklist. The blocklist
  // only stopped CLOSED/REJECTED -> ESCALATED but still
  // allowed transitions the state machine doesn't otherwise
  // permit (e.g. PENDING -> ESCALATED, RECEIVED -> ESCALATED).
  // This keeps escalate() and updateStatus() enforcing the
  // same single rulebook. Also enforces the same admin-access
  // rule as the other admin operations.
  // ─────────────────────────────────────────────

  async escalate(admin: CurrentUserDto, reportId: string, data: EscalateReportDto) {
    const existing = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!existing) {
      throw new NotFoundException('report_not_found');
    }

    this.assertAdminCanAccessReport(admin, existing);

    const allowedNext = ALLOWED_STATUS_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(ReportStatus.ESCALATED)) {
      throw new BadRequestException(
        `invalid_status_transition: ${existing.status} -> ${ReportStatus.ESCALATED}`,
      );
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { status: ReportStatus.ESCALATED },
    });

    this.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.getRoles(admin)),
      action: AuditEventEnum.REPORT_ESCALATED,
      entity: 'Report',
      entityId: reportId,
      diff: {
        result: 'success',
        previousStatus: existing.status,
        reason: data.reason,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.HIGH_PRIORITY_REPORT, {
      reportId: report.id,
    });

    return report;
  }

  // ─────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────

  private generateCaseReference(): string {
    const year = new Date().getFullYear();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `EHT-${year}-${random}`;
  }

  // Random 6-char case references aren't guaranteed unique, and
  // caseReference is @unique in the schema, so a collision throws
  // a Prisma P2002 error. Retry a few times with a fresh reference
  // before giving up, rather than letting that error surface raw.
  private async createReportWithUniqueCaseReference(
    user: CurrentUserDto,
    data: CreateReportDto,
  ) {
    for (let attempt = 1; attempt <= CASE_REFERENCE_MAX_ATTEMPTS; attempt++) {
      try {
        return await this.prisma.report.create({
          data: {
            userId: user.id,
            caseReference: this.generateCaseReference(),
            category: data.category,
            description: data.description,
            location: data.location ?? null,
            incidentAt: data.incidentAt ? new Date(data.incidentAt) : null,
            photo: data.photo ?? [],
            video: data.video ?? [],
            audio: data.audio ?? [],
            pdf: data.pdf ?? [],
            document: data.document ?? [],
            other: data.other ?? [],
            status: ReportStatus.PENDING,
          },
        });
      } catch (err) {
        const isCaseReferenceCollision =
          err instanceof Prisma.PrismaClientKnownRequestError &&
          err.code === 'P2002' &&
          (err.meta?.target as string[] | undefined)?.includes('caseReference');

        if (!isCaseReferenceCollision || attempt === CASE_REFERENCE_MAX_ATTEMPTS) {
          throw err;
        }
        // otherwise loop and try again with a new random reference
      }
    }
    // Unreachable: the loop always returns or throws.
    throw new Error('failed_to_generate_unique_case_reference');
  }

  private getRoles(user: CurrentUserDto): string[] {
    return (
      (
        user as unknown as {
          roles?: string[];
        }
      ).roles ?? []
    );
  }
}