import {
  ReportEvidence,
  AuditSeverity,
  InformationRequestStatus,
  Prisma,
  ReportContactMethod,
  ReportEvidenceKind,
  ReportPriority,
  ReportStatus,
} from '@prisma/client';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import {
  PageQueryDto,
  AddReportEvidenceDto,
  RequestReopenDto,
  ReportFeedbackDto,
  ReportDeleteRequestDto,
  MuteReportDto,
  UrgentReportDto,
  ContactPreferenceDto,
  ChangeAnonymityDto,
} from '../dto/report.dto';
import {
  TERMINAL_STATUSES,
  REPORT_TABLE,
  MediaBearing,
  act,
  NEW_EVENTS,
  RequestCtx,
} from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportReporterService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // Reporter-facing media download, scoped to their own report
  async getMediaDownloadUrl(
    user: CurrentUserDto,
    reportId: string,
    key: string,
  ): Promise<{ url: string }> {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    const owned = this.reportCommonService.collectMediaFields(report).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_report');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  private kindFromMime(mime: string | undefined, key: string): ReportEvidenceKind {
    const m = (mime ?? '').toLowerCase();
    const ext = key.split('.').pop()?.toLowerCase() ?? '';
    if (m.startsWith('image/') || ['jpg', 'jpeg', 'png', 'webp', 'gif', 'heic'].includes(ext)) {
      return ReportEvidenceKind.PHOTO;
    }
    if (m.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv'].includes(ext)) {
      return ReportEvidenceKind.VIDEO;
    }
    if (m.startsWith('audio/') || ['mp3', 'm4a', 'wav', 'ogg', 'aac'].includes(ext)) {
      return ReportEvidenceKind.AUDIO;
    }
    if (m === 'application/pdf' || ext === 'pdf') return ReportEvidenceKind.PDF;
    if (
      m.includes('msword') ||
      m.includes('officedocument') ||
      m.startsWith('text/') ||
      ['doc', 'docx', 'txt', 'rtf', 'odt'].includes(ext)
    ) {
      return ReportEvidenceKind.DOCUMENT;
    }
    return ReportEvidenceKind.OTHER;
  }

  // RPT-01 POST /reports/:id/evidence
  // `files` are already uploaded to MinIO by the controller/interceptor.
  async addEvidence(
    user: CurrentUserDto,
    reportId: string,
    files: Array<{ storageKey: string; mimeType?: string; sizeBytes?: number; sha256?: string }>,
    dto: AddReportEvidenceDto,
    ctx?: RequestCtx,
  ) {
    if (!files.length) throw new BadRequestException('no_evidence_provided');

    const report = await this.reportCommonService.loadOwned(user, reportId);
    if (TERMINAL_STATUSES.includes(report.status)) {
      throw new BadRequestException('report_is_closed');
    }

    const existingKeys = this.reportCommonService.collectMediaFields(report);
    const keys = files.map((f) => f.storageKey);
    const dup = keys.filter((k) => existingKeys.includes(k));
    if (dup.length) throw new BadRequestException(`evidence_already_attached:${dup.join(',')}`);

    const validated = await this.reportCommonService.validateMediaFilesExist(keys);
    const sizeByKey = new Map(validated.map((v) => [v.filepath, v.size]));

    const entries = files.map((f) => ({
      ...f,
      kind: this.kindFromMime(f.mimeType, f.storageKey),
      size: sizeByKey.get(f.storageKey) ?? f.sizeBytes ?? 0,
    }));

    const merged: MediaBearing = {
      photo: [...report.photo],
      video: [...report.video],
      audio: [...report.audio],
      pdf: [...report.pdf],
      document: [...report.document],
      other: [...report.other],
    };
    for (const e of entries)
      merged[this.reportCommonService.fieldForKind(e.kind)].push(e.storageKey);
    this.reportCommonService.assertAttachmentCounts(merged);

    const newTotal = report.mediaTotalBytes + entries.reduce((s, e) => s + e.size, 0);
    this.reportCommonService.assertTotalBytes(newTotal);

    const rows = await this.prisma.$transaction(async (tx) => {
      const created: ReportEvidence[] = [];
      for (const e of entries) {
        created.push(
          await tx.reportEvidence.create({
            data: {
              reportId,
              kind: e.kind,
              storageKey: e.storageKey,
              mimeType: e.mimeType ?? null,
              sizeBytes: e.size,
              sha256: e.sha256 ?? null,
              note: dto.note ?? null,
              addedById: user.id,
              custody: {
                create: { action: 'ADDED', actorId: user.id, ipAddress: ctx?.ip ?? null },
              },
            },
          }),
        );
      }
      await tx.report.update({
        where: { id: reportId },
        data: { ...merged, mediaTotalBytes: newTotal, lastActivityAt: new Date() },
      });
      return created;
    });

    this.reportCommonService.audit(
      user,
      act('REPORT_EVIDENCE_ADDED'),
      report,
      { result: 'success' },
      {
        metadata: { count: rows.length, mediaTotalBytes: newTotal },
      },
    );

    return rows;
  }

  // RPT-04 POST /reports/:id/reopen-request
  async requestReopen(user: CurrentUserDto, reportId: string, dto: RequestReopenDto) {
    const report = await this.reportCommonService.loadOwned(user, reportId);

    if (!TERMINAL_STATUSES.includes(report.status)) {
      throw new BadRequestException('only_closed_reports_can_be_reopened');
    }

    const pending = await this.prisma.reportReopenRequest.findFirst({
      where: { reportId, handledAt: null },
    });
    if (pending) throw new BadRequestException('reopen_request_already_pending');

    const request = await this.prisma.reportReopenRequest.create({
      data: { reportId, requestedById: user.id, reason: dto.reason },
    });
    await this.prisma.report.update({
      where: { id: reportId },
      data: { lastActivityAt: new Date() },
    });

    this.reportCommonService.audit(
      user,
      act('REPORT_REOPEN_REQUESTED'),
      report,
      { result: 'success' },
      {
        reason: dto.reason,
      },
    );
    this.eventEmitter.emit(NEW_EVENTS.REOPEN_REQUESTED, {
      reportId,
      caseReference: report.caseReference,
      requestId: request.id,
      assignedToId: report.assignedToId,
    });

    return request;
  }

  // RPT-05 POST /reports/:id/feedback
  async submitFeedback(user: CurrentUserDto, reportId: string, dto: ReportFeedbackDto) {
    const report = await this.reportCommonService.loadOwned(user, reportId);

    if (report.status !== ReportStatus.CLOSED) {
      throw new BadRequestException('feedback_only_for_closed_reports');
    }

    try {
      const feedback = await this.prisma.reportFeedback.create({
        data: {
          reportId,
          userId: user.id,
          rating: dto.rating,
          comment: dto.comment ?? null,
        },
      });
      this.reportCommonService.audit(user, act('REPORT_FEEDBACK_SUBMITTED'), report, {
        result: 'success',
        rating: dto.rating,
      });
      return feedback;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('feedback_already_submitted');
      }
      throw err;
    }
  }

  // RPT-29 GET /reports/me/summary
  async getMySummary(user: CurrentUserDto) {
    const grouped = await this.prisma.report.groupBy({
      by: ['status'],
      where: { userId: user.id, deletedAt: null },
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: { status: 'asc' },
    });

    const byStatus = Object.fromEntries(Object.values(ReportStatus).map((s) => [s, 0])) as Record<
      ReportStatus,
      number
    >;
    let total = 0;
    let lastReportAt: Date | null = null;
    for (const row of grouped) {
      const count = (row._count as { _all?: number } | undefined)?._all ?? 0;
      byStatus[row.status] = count;
      total += count;
      const last = (row._max as { createdAt?: Date | null } | undefined)?.createdAt ?? null;
      if (last && (!lastReportAt || last > lastReportAt)) lastReportAt = last;
    }

    const open = Object.values(ReportStatus)
      .filter((s) => !TERMINAL_STATUSES.includes(s))
      .reduce((sum, s) => sum + byStatus[s], 0);

    return { total, open, byStatus, lastReportAt };
  }

  async countMyUnreadUpdates(user: CurrentUserDto) {
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM ${REPORT_TABLE}
      WHERE "userId" = ${user.id}
        AND "deletedAt" IS NULL
        AND "reporterUpdatedAt" > COALESCE("reporterSeenAt", "createdAt")
    `;
    return { count: rows[0]?.count ?? 0 };
  }

  // RPT-31 PATCH /reports/:id/seen
  async markSeen(user: CurrentUserDto, reportId: string) {
    await this.reportCommonService.loadOwned(user, reportId);
    const seenAt = new Date();
    await this.prisma.report.updateMany({
      where: { id: reportId, userId: user.id },
      data: { reporterSeenAt: seenAt },
    });
    return { id: reportId, seenAt };
  }

  // RPT-32 PATCH /reports/me/seen-all
  async markAllSeen(user: CurrentUserDto) {
    const result = await this.prisma.report.updateMany({
      where: { userId: user.id, deletedAt: null },
      data: { reporterSeenAt: new Date() },
    });
    return { updated: result.count };
  }

  // RPT-88 GET /reports/me/information-requests/pending
  async findMyPendingInformationRequests(user: CurrentUserDto, query: PageQueryDto) {
    const { page, limit, skip, take } = this.reportCommonService.paging(query);
    const where: Prisma.ReportInformationRequestWhereInput = {
      status: InformationRequestStatus.PENDING,
      report: { userId: user.id, deletedAt: null },
    };

    const [rows, total] = await Promise.all([
      this.prisma.reportInformationRequest.findMany({
        where,
        orderBy: [{ dueAt: { sort: 'asc', nulls: 'last' } }, { createdAt: 'asc' }],
        skip,
        take,
        include: { report: { select: { id: true, caseReference: true, category: true } } },
      }),
      this.prisma.reportInformationRequest.count({ where }),
    ]);

    const now = Date.now();
    const items = rows.map((r) => ({
      ...r,
      isOverdue: r.dueAt ? r.dueAt.getTime() < now : false,
    }));

    return { items, total, page, limit };
  }

  // RPT-99 GET /reports/:id/timeline
  // Reporter-safe: no internal notes, no admin ids.
  async getReporterTimeline(user: CurrentUserDto, reportId: string) {
    const report = await this.reportCommonService.loadOwned(user, reportId);

    const [history, requests] = await Promise.all([
      this.prisma.reportStatusHistory.findMany({
        where: { reportId },
        orderBy: { createdAt: 'asc' },
        select: { fromStatus: true, toStatus: true, createdAt: true },
      }),
      this.prisma.reportInformationRequest.findMany({
        where: { reportId },
        select: { createdAt: true, respondedAt: true, cancelledAt: true },
      }),
    ]);

    const events: Array<{ type: string; at: Date; from?: ReportStatus | null; to?: ReportStatus }> =
      [{ type: 'SUBMITTED', at: report.createdAt, to: ReportStatus.PENDING }];

    for (const h of history) {
      events.push({ type: 'STATUS_CHANGED', at: h.createdAt, from: h.fromStatus, to: h.toStatus });
    }
    for (const r of requests) {
      events.push({ type: 'INFORMATION_REQUESTED', at: r.createdAt });
      if (r.respondedAt) events.push({ type: 'INFORMATION_PROVIDED', at: r.respondedAt });
    }
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    return { reportId, caseReference: report.caseReference, status: report.status, events };
  }

  // RPT-100 GET /reports/track/:reference  (scoped to the caller's own reports)
  async trackByReference(user: CurrentUserDto, reference: string) {
    const report = await this.prisma.report.findFirst({
      where: {
        caseReference: reference.trim().toUpperCase(),
        userId: user.id,
        deletedAt: null,
      },
      select: {
        id: true,
        caseReference: true,
        status: true,
        category: true,
        createdAt: true,
        updatedAt: true,
        reporterUpdatedAt: true,
      },
    });
    if (!report) throw new NotFoundException('report_not_found');
    return report;
  }

  // RPT-101 GET /reports/:id/pdf
  async generateMyReportPdf(user: CurrentUserDto, reportId: string) {
    const report = await this.reportCommonService.loadOwned(user, reportId);
    const history = await this.prisma.reportStatusHistory.findMany({
      where: { reportId },
      orderBy: { createdAt: 'asc' },
      select: { toStatus: true, createdAt: true },
    });

    const lines = [
      `Case reference: ${report.caseReference}`,
      `Status: ${report.status}`,
      `Category: ${report.category}`,
      `Submitted: ${report.createdAt.toISOString()}`,
      `Incident time: ${report.incidentAt ? report.incidentAt.toISOString() : '-'}`,
      `Location: ${report.location ?? '-'}`,
      `Attachments: ${this.reportCommonService.collectMediaFields(report).length}`,
      '',
      'Description:',
      ...report.description.split('\n'),
      '',
      'Status history:',
      ...history.map((h) => `  ${h.createdAt.toISOString()}  ${h.toStatus}`),
    ];

    const buffer = await this.reportCommonService.renderPdf(
      `Report ${report.caseReference}`,
      lines,
    );
    return { buffer, filename: `${report.caseReference}.pdf`, contentType: 'application/pdf' };
  }

  // RPT-102 POST /reports/:id/delete-request
  async requestErasure(user: CurrentUserDto, reportId: string, dto: ReportDeleteRequestDto) {
    const report = await this.reportCommonService.loadOwned(user, reportId);

    if (report.legalHold) throw new ForbiddenException('report_under_legal_hold');

    const pending = await this.prisma.reportErasureRequest.findFirst({
      where: { reportId, status: 'PENDING' },
    });
    if (pending) throw new BadRequestException('erasure_request_already_pending');

    const request = await this.prisma.reportErasureRequest.create({
      data: { reportId, requestedById: user.id, reason: dto.reason ?? null },
    });

    this.reportCommonService.audit(
      user,
      act('REPORT_ERASURE_REQUESTED'),
      report,
      { result: 'success' },
      {
        reason: dto.reason ?? null,
      },
    );
    this.eventEmitter.emit(NEW_EVENTS.ERASURE_REQUESTED, {
      reportId,
      caseReference: report.caseReference,
      requestId: request.id,
    });

    return request;
  }

  // RPT-103 PATCH /reports/:id/mute
  async muteReport(user: CurrentUserDto, reportId: string, dto: MuteReportDto) {
    await this.reportCommonService.loadOwned(user, reportId);

    if (dto.until && new Date(dto.until).getTime() <= Date.now()) {
      throw new BadRequestException('mute_until_must_be_in_the_future');
    }

    const updated = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        updatesMuted: dto.muted,
        updatesMutedUntil: dto.muted && dto.until ? new Date(dto.until) : null,
      },
      select: { id: true, updatesMuted: true, updatesMutedUntil: true },
    });
    return updated;
  }

  async flagUrgent(user: CurrentUserDto, reportId: string, dto: UrgentReportDto) {
    const report = await this.reportCommonService.loadOwned(user, reportId);

    if (TERMINAL_STATUSES.includes(report.status)) {
      throw new BadRequestException('report_is_closed');
    }
    if (report.urgentFlaggedAt) {
      return { id: report.id, status: report.status, urgentFlaggedAt: report.urgentFlaggedAt };
    }

    const now = new Date();
    const alreadyEscalated = report.status === ReportStatus.ESCALATED;

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.report.update({
        where: { id: reportId },
        data: {
          urgentFlaggedAt: now,
          urgentDetails: dto.details ?? null,
          priority: ReportPriority.CRITICAL,
          lastActivityAt: now,
          reporterUpdatedAt: now,
          ...(alreadyEscalated ? {} : { status: ReportStatus.ESCALATED }),
          ...(dto.gps ? this.reportCommonService.gpsData(dto.gps) : {}),
        },
      });
      if (!alreadyEscalated) {
        await tx.reportStatusHistory.create({
          data: {
            reportId,
            fromStatus: report.status,
            toStatus: ReportStatus.ESCALATED,
            changedById: user.id,
            note: 'urgent_flag_by_reporter',
          },
        });
        await tx.reportEscalation.create({
          data: {
            reportId,
            escalatedById: user.id,
            reason: `URGENT: ${dto.details ?? 'reporter flagged immediate danger'}`,
          },
        });
      }
      return u;
    });

    this.reportCommonService.audit(
      user,
      act('REPORT_URGENT_FLAGGED'),
      report,
      {
        result: 'success',
        previousStatus: report.status,
        currentStatus: updated.status,
      },
      { severity: AuditSeverity.WARNING },
    );

    this.eventEmitter.emit(NotificationEventEnum.HIGH_PRIORITY_REPORT, {
      reportId,
      caseReference: report.caseReference,
      reason: 'urgent_flag_by_reporter',
      urgent: true,
    });
    this.eventEmitter.emit(NEW_EVENTS.URGENT_FLAGGED, {
      reportId,
      caseReference: report.caseReference,
      assignedToId: report.assignedToId,
      details: dto.details ?? null,
    });

    return { id: updated.id, status: updated.status, urgentFlaggedAt: updated.urgentFlaggedAt };
  }

  // RPT-162 PATCH /reports/:id/contact-preference
  async setContactPreference(user: CurrentUserDto, reportId: string, dto: ContactPreferenceDto) {
    await this.reportCommonService.loadOwned(user, reportId);
    return this.prisma.report.update({
      where: { id: reportId },
      data: {
        contactMethod: dto.method as ReportContactMethod,
        contactWindow: dto.window ?? null,
      },
      select: { id: true, contactMethod: true, contactWindow: true },
    });
  }

  async changeAnonymity(user: CurrentUserDto, reportId: string, dto: ChangeAnonymityDto) {
    const report = await this.reportCommonService.loadOwned(user, reportId);

    if (this.configService.get<string>('REPORT_ALLOW_ANONYMITY_CHANGE') === 'false') {
      throw new ForbiddenException('anonymity_change_not_allowed');
    }
    if (report.isAnonymous === dto.anonymous) {
      return { id: report.id, isAnonymous: report.isAnonymous };
    }
    if (dto.anonymous) {
      const revealed = await this.prisma.reportReporterReveal.count({ where: { reportId } });
      if (revealed > 0) throw new BadRequestException('identity_already_revealed');
    }

    await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id: reportId },
        data: { isAnonymous: dto.anonymous, lastActivityAt: new Date() },
      }),
      this.prisma.reportRevision.create({
        data: {
          reportId,
          editedById: user.id,
          changes: {
            isAnonymous: { from: report.isAnonymous, to: dto.anonymous },
            ...(dto.reason ? { reason: dto.reason } : {}),
          } as Prisma.InputJsonValue,
        },
      }),
    ]);

    this.reportCommonService.audit(
      user,
      act('REPORT_ANONYMITY_CHANGED'),
      report,
      {
        result: 'success',
        from: report.isAnonymous,
        to: dto.anonymous,
      },
      { reason: dto.reason ?? null },
    );

    return { id: report.id, isAnonymous: dto.anonymous };
  }
}
