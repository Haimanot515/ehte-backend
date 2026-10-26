import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  ActorType,
  AuditOutcome,
  AuditSeverity,
  InformationRequestStatus,
  Prisma,
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
  RequestMoreInformationDto,
  RespondToInformationRequestDto,
  PageQueryDto,
  PendingInformationRequestsQueryDto,
  CreateReportMessageDto,
  CancelInformationRequestDto,
  ExtendInformationRequestDto,
  ReviewInformationResponseDto,
  ReplyToReportEmailDto,
} from '../dto/report.dto';
import { ADMIN_ROLE_NAMES, act, NEW_EVENTS } from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportCommunicationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // Refuses a second request while one is still PENDING
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

    this.reportCommonService.assertAdminCanAccessReport(
      admin,
      existing,
      AuditEventEnum.REPORT_MORE_INFORMATION_REQUESTED,
    );

    const openRequest = await this.prisma.reportInformationRequest.findFirst({
      where: { reportId, status: InformationRequestStatus.PENDING },
    });

    if (openRequest) {
      this.reportCommonService.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
        action: AuditEventEnum.REPORT_MORE_INFORMATION_REQUESTED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: existing.caseReference,
        diff: { result: 'failure', reason: 'information_request_already_pending' },
        metadata: { existingRequestId: openRequest.id },
      });
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

    this.reportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: AuditEventEnum.REPORT_MORE_INFORMATION_REQUESTED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: existing.caseReference,
      reason: data.message,
      diff: { result: 'success' },
      metadata: { informationRequestId: infoRequest.id },
    });

    this.eventEmitter.emit(NotificationEventEnum.MORE_INFORMATION_REQUESTED, {
      reportId,
      caseReference: existing.caseReference,
      informationRequestId: infoRequest.id,
      userId: existing.userId,
      message: data.message,
    });

    return infoRequest;
  }

  async findInformationRequests(user: CurrentUserDto, reportId: string) {
    const roles = this.reportCommonService.getRoles(user);
    const isAdmin = roles.some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));

    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    if (!isAdmin && report.userId !== user.id) {
      throw new NotFoundException('report_not_found');
    }

    return this.prisma.reportInformationRequest.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findOneInformationRequest(user: CurrentUserDto, reportId: string, requestId: string) {
    const roles = this.reportCommonService.getRoles(user);
    const isAdmin = roles.some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));

    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    if (!isAdmin && report.userId !== user.id) {
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
      this.reportCommonService.emitAudit({
        userId: user.id,
        actorType: resolveActorType(this.reportCommonService.getRoles(user)),
        action: AuditEventEnum.REPORT_INFORMATION_RESPONDED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: report.caseReference,
        diff: { result: 'failure', reason: 'information_request_already_responded' },
        metadata: { informationRequestId: requestId },
      });
      throw new BadRequestException('information_request_already_responded');
    }

    await this.reportCommonService.validateMediaFilesExist(data.responseFiles ?? []);

    const updated = await this.prisma.reportInformationRequest.update({
      where: { id: requestId },
      data: {
        responseMessage: data.responseMessage,
        responseFiles: data.responseFiles ?? [],
        status: InformationRequestStatus.RESPONDED,
        respondedAt: new Date(),
      },
    });

    this.reportCommonService.emitAudit({
      userId: user.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(user)),
      action: AuditEventEnum.REPORT_INFORMATION_RESPONDED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: { result: 'success' },
      metadata: {
        informationRequestId: requestId,
        responseFileCount: (data.responseFiles ?? []).length,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.INFORMATION_REQUEST_RESPONDED, {
      reportId,
      caseReference: report.caseReference,
      informationRequestId: requestId,
      requestedById: infoRequest.requestedById,
    });

    return updated;
  }

  // RPT-02 POST /reports/:id/messages
  async createMessage(user: CurrentUserDto, reportId: string, dto: CreateReportMessageDto) {
    const report = await this.reportCommonService.loadOwned(user, reportId);

    const [message] = await this.prisma.$transaction([
      this.prisma.reportMessage.create({
        data: {
          reportId,
          authorId: user.id,
          authorType: resolveActorType(this.reportCommonService.getRoles(user)) as unknown as ActorType,
          message: dto.message,
        },
      }),
      this.prisma.report.update({
        where: { id: reportId },
        data: { lastActivityAt: new Date() },
      }),
    ]);

    this.reportCommonService.audit(user, act('REPORT_MESSAGE_POSTED'), report, { result: 'success' });
    this.eventEmitter.emit(NEW_EVENTS.MESSAGE_CREATED, {
      reportId,
      caseReference: report.caseReference,
      messageId: message.id,
      assignedToId: report.assignedToId,
      fromReporter: true,
    });

    return message;
  }

  // RPT-03 GET /reports/:id/messages  (User own / Admin)
  async listMessages(user: CurrentUserDto, reportId: string, query: PageQueryDto) {
    const isAdmin = this.reportCommonService.isAdminUser(user);
    if (isAdmin) await this.reportCommonService.loadForAdmin(user, reportId);
    else await this.reportCommonService.loadOwned(user, reportId);

    const { page, limit, skip, take } = this.reportCommonService.paging(query);
    const where = { reportId };

    const [items, total] = await Promise.all([
      this.prisma.reportMessage.findMany({
        where,
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
      this.prisma.reportMessage.count({ where }),
    ]);

    if (!isAdmin) {
      // Reporter opening the thread reads everything staff wrote
      await this.prisma.reportMessage.updateMany({
        where: {
          reportId,
          readAt: null,
          OR: [{ authorId: null }, { authorId: { not: user.id } }],
        },
        data: { readAt: new Date() },
      });
    }

    return { items, total, page, limit };
  }

  private async loadInfoRequest(reportId: string, requestId: string) {
    const request = await this.prisma.reportInformationRequest.findFirst({
      where: { id: requestId, reportId },
    });
    if (!request) throw new NotFoundException('information_request_not_found');
    return request;
  }

  // RPT-87 GET /reports/information-requests/pending
  async listPendingInformationRequests(
    admin: CurrentUserDto,
    query: PendingInformationRequestsQueryDto,
  ) {
    const { page, limit, skip, take } = this.reportCommonService.paging(query);
    const where: Prisma.ReportInformationRequestWhereInput = {
      status: InformationRequestStatus.PENDING,
      ...(query.overdueOnly ? { dueAt: { lt: new Date() } } : {}),
      report: { AND: [{ deletedAt: null }, this.reportCommonService.visibilityWhere(admin)] },
    };

    const [rows, total] = await Promise.all([
      this.prisma.reportInformationRequest.findMany({
        where,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        skip,
        take,
        include: {
          report: { select: { id: true, caseReference: true, status: true, assignedToId: true } },
        },
      }),
      this.prisma.reportInformationRequest.count({ where }),
    ]);

    const now = Date.now();
    return {
      items: rows.map((r) => ({ ...r, isOverdue: r.dueAt ? r.dueAt.getTime() < now : false })),
      total,
      page,
      limit,
    };
  }

  // RPT-89 PATCH /reports/:id/information-requests/:requestId/cancel
  async cancelInformationRequest(
    admin: CurrentUserDto,
    reportId: string,
    requestId: string,
    dto: CancelInformationRequestDto,
  ) {
    const report = await this.reportCommonService.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_INFO_REQUEST_CHANGED'),
    );
    const request = await this.loadInfoRequest(reportId, requestId);
    if (request.status !== InformationRequestStatus.PENDING) {
      throw new BadRequestException('only_pending_requests_can_be_cancelled');
    }

    const updated = await this.prisma.reportInformationRequest.update({
      where: { id: requestId },
      data: {
        status: InformationRequestStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledById: admin.id,
        cancelReason: dto.reason ?? null,
      },
    });
    this.reportCommonService.audit(
      admin,
      act('REPORT_INFO_REQUEST_CHANGED'),
      report,
      {
        result: 'success',
        op: 'cancel',
        requestId,
      },
      { reason: dto.reason ?? null },
    );
    return updated;
  }

  // RPT-90 POST /reports/:id/information-requests/:requestId/remind
  async remindInformationRequest(admin: CurrentUserDto, reportId: string, requestId: string) {
    const report = await this.reportCommonService.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_INFO_REQUEST_CHANGED'),
    );
    const request = await this.loadInfoRequest(reportId, requestId);
    if (request.status !== InformationRequestStatus.PENDING) {
      throw new BadRequestException('only_pending_requests_can_be_reminded');
    }

    const minHours = Number(this.configService.get<string>('REPORT_INFO_REMINDER_MIN_HOURS') ?? 24);
    if (request.remindedAt && Date.now() - request.remindedAt.getTime() < minHours * 3600000) {
      throw new BadRequestException('reminder_sent_too_recently');
    }

    const updated = await this.prisma.reportInformationRequest.update({
      where: { id: requestId },
      data: { remindedAt: new Date(), remindCount: { increment: 1 } },
    });

    this.reportCommonService.audit(admin, act('REPORT_INFO_REQUEST_CHANGED'), report, {
      result: 'success',
      op: 'remind',
      requestId,
    });
    this.eventEmitter.emit(NEW_EVENTS.INFORMATION_REMINDER, {
      reportId,
      caseReference: report.caseReference,
      informationRequestId: requestId,
      userId: report.userId,
      message: request.message,
    });
    return updated;
  }

  // RPT-91 PATCH /reports/:id/information-requests/:requestId/extend
  async extendInformationRequest(
    admin: CurrentUserDto,
    reportId: string,
    requestId: string,
    dto: ExtendInformationRequestDto,
  ) {
    const report = await this.reportCommonService.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_INFO_REQUEST_CHANGED'),
    );
    const request = await this.loadInfoRequest(reportId, requestId);
    if (request.status !== InformationRequestStatus.PENDING) {
      throw new BadRequestException('only_pending_requests_can_be_extended');
    }

    const dueAt = new Date(dto.dueAt);
    if (dueAt.getTime() <= Date.now())
      throw new BadRequestException('due_date_must_be_in_the_future');
    if (request.dueAt && dueAt.getTime() <= request.dueAt.getTime()) {
      throw new BadRequestException('new_due_date_must_be_later_than_current');
    }

    const updated = await this.prisma.reportInformationRequest.update({
      where: { id: requestId },
      data: { dueAt },
    });
    this.reportCommonService.audit(
      admin,
      act('REPORT_INFO_REQUEST_CHANGED'),
      report,
      {
        result: 'success',
        op: 'extend',
        requestId,
        from: request.dueAt,
        to: dueAt,
      },
      { reason: dto.reason ?? null },
    );
    return updated;
  }

  async reviewInformationResponse(
    admin: CurrentUserDto,
    reportId: string,
    requestId: string,
    dto: ReviewInformationResponseDto,
  ) {
    const report = await this.reportCommonService.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_INFO_REQUEST_CHANGED'),
    );
    const request = await this.loadInfoRequest(reportId, requestId);
    if (request.status !== InformationRequestStatus.RESPONDED) {
      throw new BadRequestException('request_has_no_response_to_review');
    }

    const accept = dto.decision === 'ACCEPT';
    const now = new Date();
    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.reportInformationRequest.update({
        where: { id: requestId },
        data: {
          status: accept ? InformationRequestStatus.ACCEPTED : InformationRequestStatus.PENDING,
          reviewedAt: now,
          reviewedById: admin.id,
          reviewNote: dto.note ?? null,
        },
      });
      await tx.report.update({
        where: { id: reportId },
        data: {
          lastActivityAt: now,
          reporterUpdatedAt: now,
          firstRespondedAt: report.firstRespondedAt ?? now,
        },
      });
      return u;
    });

    this.reportCommonService.audit(
      admin,
      act('REPORT_INFO_REQUEST_CHANGED'),
      report,
      {
        result: 'success',
        op: 'review',
        decision: dto.decision,
        requestId,
      },
      { reason: dto.note ?? null },
    );
    this.eventEmitter.emit(NEW_EVENTS.INFORMATION_REVIEWED, {
      reportId,
      caseReference: report.caseReference,
      informationRequestId: requestId,
      userId: report.userId,
      decision: dto.decision,
      note: dto.note ?? null,
    });
    return updated;
  }

  // GP-08 GET /reports/stats/by-region  (declared with the stats group below)

  // EM-20 GET /reports/:id/emails
  async listEmails(admin: CurrentUserDto, reportId: string, query: PageQueryDto) {
    await this.reportCommonService.loadForAdmin(admin, reportId);
    const { page, limit, skip, take } = this.reportCommonService.paging(query);
    const where = { reportId };
    const [items, total] = await Promise.all([
      this.prisma.reportEmail.findMany({ where, orderBy: { createdAt: 'asc' }, skip, take }),
      this.prisma.reportEmail.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  async replyToEmail(admin: CurrentUserDto, reportId: string, dto: ReplyToReportEmailDto) {
    const report = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_EMAIL_SENT'));

    const lastInbound = await this.prisma.reportEmail.findFirst({
      where: { reportId, direction: 'INBOUND' },
      orderBy: { createdAt: 'desc' },
    });
    if (!lastInbound?.fromAddress) throw new BadRequestException('no_inbound_email_to_reply_to');

    const subject =
      dto.subject ??
      (lastInbound.subject
        ? /^re:/i.test(lastInbound.subject)
          ? lastInbound.subject
          : `Re: ${lastInbound.subject}`
        : `Re: ${report.caseReference}`);

    const email = await this.prisma.reportEmail.create({
      data: {
        reportId,
        direction: 'OUTBOUND',
        subject,
        body: dto.body,
        fromAddress: this.configService.get<string>('MAIL_FROM') ?? null,
        toAddress: lastInbound.fromAddress,
        sentById: admin.id,
      },
    });

    await this.prisma.report.update({
      where: { id: reportId },
      data: { lastActivityAt: new Date(), firstRespondedAt: report.firstRespondedAt ?? new Date() },
    });

    this.reportCommonService.audit(admin, act('REPORT_EMAIL_SENT'), report, { result: 'success', emailId: email.id });
    this.eventEmitter.emit(NEW_EVENTS.EMAIL_REPLY, {
      reportId,
      caseReference: report.caseReference,
      emailId: email.id,
      to: email.toAddress,
      subject,
      body: dto.body,
      inReplyTo: lastInbound.messageId,
    });
    return email;
  }
}
