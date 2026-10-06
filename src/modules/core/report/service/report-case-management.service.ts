import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditOutcome,
  AuditSeverity,
  Prisma,
  Report,
  ReportEvidenceKind,
  ReportStatus,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import {
  PageQueryDto,
  SlaBreachingQueryDto,
  FollowUpsQueryDto,
  EvidenceRemovalQueryDto,
  SetDueDateDto,
  CreateFollowUpDto,
  AddReportTagsDto,
  BulkTagReportsDto,
  SaveReportViewDto,
  UpdateReportViewDto,
  RedactEvidenceDto,
} from '../dto/report.dto';
import {
  TERMINAL_STATUSES,
  MEDIA_FIELD_NAMES,
  MediaBearing,
  act,
  NEW_EVENTS,
  RequestCtx,
} from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportCaseManagementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // Admin media download, open to any ADMIN/SUPER_ADMIN
  // Mismatched key is recorded as a DENIED audit row before throwing
  async getMediaDownloadUrlForAdmin(
    admin: CurrentUserDto,
    reportId: string,
    key: string,
  ): Promise<{ url: string }> {
    const report = await this.prisma.report.findUnique({
      where: { id: reportId },
    });

    if (!report) {
      throw new NotFoundException('report_not_found');
    }

    const owned = this.reportCommonService.collectMediaFields(report).includes(key);
    if (!owned) {
      this.reportCommonService.emitAudit({
        userId: admin.id,
        targetUserId: report.userId,
        actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
        action: AuditEventEnum.REPORT_MEDIA_DOWNLOADED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: reportId,
        entityLabel: report.caseReference,
        diff: { result: 'denied', reason: 'media_not_found_on_report' },
        metadata: { requestedKey: key },
      });
      throw new NotFoundException('media_not_found_on_report');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);

    this.reportCommonService.emitAudit({
      userId: admin.id,
      targetUserId: report.userId,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: AuditEventEnum.REPORT_MEDIA_DOWNLOADED,
      entity: 'Report',
      entityId: reportId,
      entityLabel: report.caseReference,
      diff: { result: 'success' },
      metadata: { key },
    });

    return { url };
  }

  private slaInfo(r: {
    dueAt: Date | null;
    createdAt: Date;
    status: ReportStatus;
    closedAt: Date | null;
    firstRespondedAt: Date | null;
  }) {
    const now = Date.now();
    const closed = TERMINAL_STATUSES.includes(r.status);
    const due = r.dueAt?.getTime() ?? null;
    const endedAt = closed ? (r.closedAt?.getTime() ?? now) : null;
    const total = due ? due - r.createdAt.getTime() : null;
    const elapsed = (endedAt ?? now) - r.createdAt.getTime();

    return {
      dueAt: r.dueAt,
      hasDeadline: due !== null,
      state:
        due === null
          ? 'NO_DEADLINE'
          : closed
            ? endedAt! <= due
              ? 'MET'
              : 'BREACHED'
            : now > due
              ? 'BREACHED'
              : 'RUNNING',
      hoursRemaining: due && !closed ? Math.round(((due - now) / 3600000) * 10) / 10 : null,
      percentElapsed:
        total && total > 0 ? Math.min(100, Math.round((elapsed / total) * 100)) : null,
      firstRespondedAt: r.firstRespondedAt,
      hoursToFirstResponse: r.firstRespondedAt
        ? Math.round(((r.firstRespondedAt.getTime() - r.createdAt.getTime()) / 3600000) * 10) / 10
        : null,
    };
  }

  // RPT-45 GET /reports/sla/breaching
  async listSlaBreaching(admin: CurrentUserDto, query: SlaBreachingQueryDto) {
    const horizon = new Date(Date.now() + (query.withinHours ?? 24) * 3600000);
    const list = await this.reportCommonService.pagedReports(
      admin,
      {
        deletedAt: null,
        archivedAt: null,
        status: { notIn: TERMINAL_STATUSES },
        dueAt: { not: null, lte: horizon },
      },
      query,
      { dueAt: 'asc' },
    );
    return {
      ...list,
      items: list.items.map((r) => ({ ...r, sla: this.slaInfo(r) })),
    };
  }

  // RPT-46 GET /reports/:id/sla
  async getSla(admin: CurrentUserDto, reportId: string) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);
    return { id: report.id, caseReference: report.caseReference, ...this.slaInfo(report) };
  }

  // RPT-47 PATCH /reports/:id/due-date
  async setDueDate(admin: CurrentUserDto, reportId: string, dto: SetDueDateDto) {
    const existing = await this.reportCommonService.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_DUE_DATE_CHANGED'),
    );
    const dueAt = new Date(dto.dueAt);
    if (dueAt.getTime() <= Date.now())
      throw new BadRequestException('due_date_must_be_in_the_future');

    const [report] = await this.prisma.$transaction([
      this.prisma.report.update({
        where: { id: reportId },
        data: { dueAt, lastActivityAt: new Date() },
      }),
      this.reportCommonService.revision(reportId, admin.id, {
        dueAt: { from: existing.dueAt?.toISOString() ?? null, to: dueAt.toISOString() },
        ...(dto.reason ? { reason: dto.reason } : {}),
      }),
    ]);
    this.reportCommonService.audit(
      admin,
      act('REPORT_DUE_DATE_CHANGED'),
      report,
      {
        result: 'success',
        from: existing.dueAt,
        to: dueAt,
      },
      { reason: dto.reason ?? null },
    );
    return report;
  }

  // RPT-48 POST /reports/:id/follow-up
  async createFollowUp(admin: CurrentUserDto, reportId: string, dto: CreateFollowUpDto) {
    await this.reportCommonService.loadForAdmin(admin, reportId);
    const remindAt = new Date(dto.remindAt);
    if (remindAt.getTime() <= Date.now()) {
      throw new BadRequestException('remind_at_must_be_in_the_future');
    }
    return this.prisma.reportFollowUp.create({
      data: { reportId, adminId: admin.id, remindAt, note: dto.note ?? null },
    });
  }

  // RPT-49 GET /reports/follow-ups   (my reminders that are due)
  async listFollowUps(admin: CurrentUserDto, query: FollowUpsQueryDto) {
    const { page, limit, skip, take } = this.reportCommonService.paging(query);
    const where: Prisma.ReportFollowUpWhereInput = {
      adminId: admin.id,
      doneAt: null,
      remindAt: { lte: query.dueBefore ? new Date(query.dueBefore) : new Date() },
      report: { AND: [{ deletedAt: null }, this.reportCommonService.visibilityWhere(admin)] },
    };
    const [items, total] = await Promise.all([
      this.prisma.reportFollowUp.findMany({
        where,
        orderBy: { remindAt: 'asc' },
        skip,
        take,
        include: {
          report: { select: { id: true, caseReference: true, status: true, priority: true } },
        },
      }),
      this.prisma.reportFollowUp.count({ where }),
    ]);
    return { items, total, page, limit };
  }

  private normalizeTags(tags: string[]): string[] {
    const cleaned = tags.map((t) => t.trim().toLowerCase()).filter(Boolean);
    for (const t of cleaned) {
      if (t.length > 40) throw new BadRequestException(`tag_too_long:${t.slice(0, 20)}`);
    }
    return [...new Set(cleaned)];
  }

  private async tagIdsFor(names: string[]): Promise<string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const tag = await this.prisma.reportTag.upsert({
        where: { name },
        create: { name },
        update: {},
        select: { id: true },
      });
      ids.push(tag.id);
    }
    return ids;
  }

  // RPT-57 POST /reports/:id/tags
  async addTags(admin: CurrentUserDto, reportId: string, dto: AddReportTagsDto) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);
    const names = this.normalizeTags(dto.tags);
    if (!names.length) throw new BadRequestException('no_tags_provided');

    const tagIds = await this.tagIdsFor(names);
    await this.prisma.reportTagOnReport.createMany({
      data: tagIds.map((tagId) => ({ reportId, tagId, addedById: admin.id })),
      skipDuplicates: true,
    });
    this.reportCommonService.audit(admin, act('REPORT_TAGS_CHANGED'), report, {
      result: 'success',
      added: names,
    });

    return this.prisma.reportTagOnReport.findMany({
      where: { reportId },
      include: { tag: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'asc' },
    });
  }

  // RPT-58 DELETE /reports/:id/tags/:tagId
  async removeTag(admin: CurrentUserDto, reportId: string, tagId: string) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);
    const res = await this.prisma.reportTagOnReport.deleteMany({ where: { reportId, tagId } });
    if (res.count === 0) throw new NotFoundException('tag_not_on_report');
    this.reportCommonService.audit(admin, act('REPORT_TAGS_CHANGED'), report, {
      result: 'success',
      removedTagId: tagId,
    });
    return { deleted: true };
  }

  // RPT-59 PATCH /reports/bulk/tags
  async bulkTag(admin: CurrentUserDto, dto: BulkTagReportsDto) {
    const add = this.normalizeTags(dto.addTags ?? []);
    const remove = this.normalizeTags(dto.removeTags ?? []);
    if (!add.length && !remove.length) throw new BadRequestException('no_tags_provided');

    const ids = [...new Set(dto.ids)];
    const visible = await this.prisma.report.findMany({
      where: {
        AND: [
          { id: { in: ids }, deletedAt: null },
          this.reportCommonService.visibilityWhere(admin),
        ],
      },
      select: { id: true },
    });
    const visibleIds = visible.map((r) => r.id);

    if (add.length && visibleIds.length) {
      const tagIds = await this.tagIdsFor(add);
      await this.prisma.reportTagOnReport.createMany({
        data: visibleIds.flatMap((reportId) =>
          tagIds.map((tagId) => ({ reportId, tagId, addedById: admin.id })),
        ),
        skipDuplicates: true,
      });
    }
    if (remove.length && visibleIds.length) {
      await this.prisma.reportTagOnReport.deleteMany({
        where: { reportId: { in: visibleIds }, tag: { name: { in: remove } } },
      });
    }

    this.reportCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(this.reportCommonService.getRoles(admin)),
      action: act('REPORT_BULK_ACTION'),
      entity: 'Report',
      entityId: 'bulk',
      diff: { op: 'tags', reports: visibleIds.length, added: add, removed: remove },
    });

    const found = new Set(visibleIds);
    return {
      requested: ids.length,
      updated: visibleIds.length,
      notFound: ids.filter((i) => !found.has(i)),
    };
  }

  // RPT-60 POST /reports/:id/watch
  async watch(admin: CurrentUserDto, reportId: string) {
    await this.reportCommonService.loadForAdmin(admin, reportId);
    await this.prisma.reportWatcher.upsert({
      where: { reportId_adminId: { reportId, adminId: admin.id } },
      create: { reportId, adminId: admin.id },
      update: {},
    });
    return { id: reportId, watching: true };
  }

  // RPT-61 DELETE /reports/:id/watch
  async unwatch(admin: CurrentUserDto, reportId: string) {
    await this.prisma.reportWatcher.deleteMany({ where: { reportId, adminId: admin.id } });
    return { id: reportId, watching: false };
  }

  // RPT-62 GET /reports/watching
  async listWatching(admin: CurrentUserDto, query: PageQueryDto) {
    return this.reportCommonService.pagedReports(
      admin,
      { deletedAt: null, watchers: { some: { adminId: admin.id } } },
      query,
      { lastActivityAt: 'desc' },
    );
  }

  // RPT-63 GET /reports/views
  async listViews(admin: CurrentUserDto) {
    return this.prisma.reportSavedView.findMany({
      where: { adminId: admin.id },
      orderBy: { name: 'asc' },
    });
  }

  // RPT-64 POST /reports/views
  async saveView(admin: CurrentUserDto, dto: SaveReportViewDto) {
    try {
      return await this.prisma.reportSavedView.create({
        data: {
          adminId: admin.id,
          name: dto.name.trim(),
          filters: dto.filters as Prisma.InputJsonValue,
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('view_name_already_used');
      }
      throw err;
    }
  }

  // RPT-65 PATCH /reports/views/:id
  async updateView(admin: CurrentUserDto, viewId: string, dto: UpdateReportViewDto) {
    const existing = await this.prisma.reportSavedView.findFirst({
      where: { id: viewId, adminId: admin.id },
    });
    if (!existing) throw new NotFoundException('view_not_found');

    try {
      return await this.prisma.reportSavedView.update({
        where: { id: viewId },
        data: {
          ...(dto.name !== undefined ? { name: dto.name.trim() } : {}),
          ...(dto.filters !== undefined ? { filters: dto.filters as Prisma.InputJsonValue } : {}),
        },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('view_name_already_used');
      }
      throw err;
    }
  }

  // RPT-66 DELETE /reports/views/:id
  async deleteView(admin: CurrentUserDto, viewId: string) {
    const res = await this.prisma.reportSavedView.deleteMany({
      where: { id: viewId, adminId: admin.id },
    });
    if (res.count === 0) throw new NotFoundException('view_not_found');
    return { deleted: true };
  }

  // Evidence added at submission lives only in the media arrays. Custody, redaction and
  // removal need a row, so one is created lazily the first time it is needed.
  private async ensureEvidenceRow(report: Report, key: string) {
    const row = await this.prisma.reportEvidence.findFirst({
      where: { reportId: report.id, storageKey: key },
    });
    if (row) return row;

    const field = MEDIA_FIELD_NAMES.find((f) => report[f].includes(key));
    if (!field) throw new NotFoundException('evidence_not_found');

    let mimeType: string | null = null;
    let sizeBytes: number | null = null;
    try {
      const stat = await this.minioService.statObject(key);
      mimeType = stat.contentType ?? null;
      sizeBytes = stat.size;
    } catch {
      /* object metadata is best-effort */
    }

    return this.prisma.reportEvidence.create({
      data: {
        reportId: report.id,
        kind: field.toUpperCase() as ReportEvidenceKind,
        storageKey: key,
        mimeType,
        sizeBytes,
        addedById: report.userId,
        custody: {
          create: { action: 'ADDED', actorId: report.userId, note: 'initial_submission' },
        },
      },
    });
  }

  // RPT-82 GET /reports/:id/evidence   (Admin, or the reporter for their own report)
  async listEvidence(user: CurrentUserDto, reportId: string) {
    const isAdmin = this.reportCommonService.isAdminUser(user);
    const report = isAdmin
      ? await this.reportCommonService.loadForAdmin(user, reportId)
      : await this.reportCommonService.loadOwned(user, reportId);

    const items = await this.prisma.reportEvidence.findMany({
      where: { reportId, removedAt: null },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        kind: true,
        storageKey: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
        note: true,
        createdAt: true,
        redactedAt: true,
        ...(isAdmin ? { redactedStorageKey: true, redactionReason: true, addedById: true } : {}),
      },
    });

    const tracked = new Set(items.map((i) => i.storageKey));
    const submittedWithReport = MEDIA_FIELD_NAMES.flatMap((field) =>
      report[field].filter((k) => !tracked.has(k)).map((k) => ({ field, storageKey: k })),
    );

    return { items, submittedWithReport };
  }

  // RPT-83 DELETE /reports/:id/evidence/:key   (soft removal; custody survives)
  async removeEvidence(
    admin: CurrentUserDto,
    reportId: string,
    key: string,
    dto: EvidenceRemovalQueryDto,
    ctx?: RequestCtx,
  ) {
    const report = await this.reportCommonService.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_EVIDENCE_REMOVED'),
    );
    if (report.legalHold) throw new ForbiddenException('report_under_legal_hold');

    const evidence = await this.ensureEvidenceRow(report, key);
    if (evidence.removedAt) throw new BadRequestException('evidence_already_removed');

    const next: MediaBearing = {
      photo: report.photo.filter((k) => k !== key),
      video: report.video.filter((k) => k !== key),
      audio: report.audio.filter((k) => k !== key),
      pdf: report.pdf.filter((k) => k !== key),
      document: report.document.filter((k) => k !== key),
      other: report.other.filter((k) => k !== key),
    };

    await this.prisma.$transaction([
      this.prisma.reportEvidence.update({
        where: { id: evidence.id },
        data: { removedAt: new Date(), removedById: admin.id, removalReason: dto.reason },
      }),
      this.prisma.reportEvidenceCustody.create({
        data: {
          evidenceId: evidence.id,
          action: 'REMOVED',
          actorId: admin.id,
          note: dto.reason,
          ipAddress: ctx?.ip ?? null,
        },
      }),
      this.prisma.report.update({
        where: { id: reportId },
        data: {
          ...next,
          mediaTotalBytes: Math.max(0, report.mediaTotalBytes - (evidence.sizeBytes ?? 0)),
          lastActivityAt: new Date(),
        },
      }),
    ]);
    // The MinIO object is intentionally kept: custody and legal discovery need it.

    this.reportCommonService.audit(
      admin,
      act('REPORT_EVIDENCE_REMOVED'),
      report,
      { result: 'success', key },
      {
        reason: dto.reason,
        severity: AuditSeverity.WARNING,
      },
    );
    return { removed: true, evidenceId: evidence.id };
  }

  // RPT-84 GET /reports/:id/evidence/:key/custody
  async getEvidenceCustody(admin: CurrentUserDto, reportId: string, key: string) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);
    const evidence = await this.ensureEvidenceRow(report, key);
    const entries = await this.prisma.reportEvidenceCustody.findMany({
      where: { evidenceId: evidence.id },
      orderBy: { createdAt: 'asc' },
    });
    return { evidenceId: evidence.id, storageKey: key, entries };
  }

  async redactEvidence(
    admin: CurrentUserDto,
    reportId: string,
    key: string,
    dto: RedactEvidenceDto,
    ctx?: RequestCtx,
  ) {
    const report = await this.reportCommonService.loadForAdminWrite(
      admin,
      reportId,
      act('REPORT_EVIDENCE_REDACTED'),
    );
    const evidence = await this.ensureEvidenceRow(report, key);
    if (evidence.removedAt) throw new BadRequestException('evidence_already_removed');

    const updated = await this.prisma.reportEvidence.update({
      where: { id: evidence.id },
      data: {
        redactedAt: new Date(),
        redactedById: admin.id,
        redactionReason: dto.reason,
        redactedRegions: (dto.regions ?? null) as Prisma.InputJsonValue,
        redactedStorageKey: null,
        custody: {
          create: {
            action: 'REDACTED',
            actorId: admin.id,
            note: dto.reason,
            ipAddress: ctx?.ip ?? null,
          },
        },
      },
    });

    this.reportCommonService.audit(
      admin,
      act('REPORT_EVIDENCE_REDACTED'),
      report,
      { result: 'success', key },
      {
        reason: dto.reason,
      },
    );
    this.eventEmitter.emit(NEW_EVENTS.EVIDENCE_REDACTION_REQUESTED, {
      reportId,
      evidenceId: evidence.id,
      storageKey: key,
      regions: dto.regions ?? null,
    });

    return {
      evidenceId: updated.id,
      redactedAt: updated.redactedAt,
      redactedStorageKey: updated.redactedStorageKey,
      processing: updated.redactedStorageKey == null,
    };
  }

  // RPT-86 GET /reports/:id/case-file   (printable PDF)
  async getCaseFile(admin: CurrentUserDto, reportId: string, ctx?: RequestCtx) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);

    const [messages, history, escalations, infoRequests, evidence, merges] = await Promise.all([
      this.prisma.reportMessage.findMany({ where: { reportId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.reportStatusHistory.findMany({
        where: { reportId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.reportEscalation.findMany({ where: { reportId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.reportInformationRequest.findMany({
        where: { reportId },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.reportEvidence.findMany({ where: { reportId }, orderBy: { createdAt: 'asc' } }),
      this.prisma.reportMerge.findMany({
        where: { OR: [{ sourceReportId: reportId }, { targetReportId: reportId }] },
      }),
    ]);

    const iso = (d?: Date | null) => (d ? d.toISOString() : '-');
    const lines = [
      `Case reference: ${report.caseReference}`,
      `Status: ${report.status}    Priority: ${report.priority}    Sensitivity: ${report.sensitivity}`,
      `Category: ${report.category}    Channel: ${report.channel}`,
      `Reporter: ${report.isAnonymous ? 'Anonymous (identity withheld)' : (report.userId ?? 'unknown')}`,
      `Submitted: ${iso(report.createdAt)}    Incident: ${iso(report.incidentAt)}`,
      `Location (as typed): ${report.location ?? '-'}`,
      `Due: ${iso(report.dueAt)}    Closed: ${iso(report.closedAt)}`,
      report.resolutionOutcome
        ? `Resolution: ${report.resolutionOutcome} - ${report.resolutionSummary ?? ''}`
        : '',
      report.integrityFlag
        ? `Integrity flag: ${report.integrityFlag} (${report.integrityReason ?? '-'})`
        : '',
      report.legalHold ? `LEGAL HOLD: ${report.legalHoldReason ?? '-'}` : '',
      '',
      'DESCRIPTION',
      ...report.description.split('\n'),
      '',
      `STATUS HISTORY (${history.length})`,
      ...history.map(
        (h) => `  ${iso(h.createdAt)}  ${h.fromStatus ?? '-'} -> ${h.toStatus}  ${h.note ?? ''}`,
      ),
      '',
      `ESCALATIONS (${escalations.length})`,
      ...escalations.map(
        (e) =>
          `  ${iso(e.createdAt)}  ${e.reason}${e.deEscalatedAt ? `  [de-escalated ${iso(e.deEscalatedAt)}]` : ''}`,
      ),
      '',
      `INFORMATION REQUESTS (${infoRequests.length})`,
      ...infoRequests.flatMap((r) => [
        `  ${iso(r.createdAt)}  [${r.status}]  ${r.message}`,
        ...(r.responseMessage
          ? [`      Response ${iso(r.respondedAt)}: ${r.responseMessage}`]
          : []),
      ]),
      '',
      `MESSAGES (${messages.length})`,
      ...messages.map((m) => `  ${iso(m.createdAt)}  ${m.authorType}: ${m.message}`),
      '',
      `EVIDENCE (${evidence.length})`,
      ...evidence.map(
        (e) =>
          `  ${e.kind}  ${e.storageKey}  sha256=${e.sha256 ?? '-'}${e.removedAt ? '  [REMOVED]' : ''}${e.redactedAt ? '  [REDACTED]' : ''}`,
      ),
      '',
      `MERGES (${merges.length})`,
      ...merges.map(
        (m) =>
          `  ${iso(m.createdAt)}  ${m.sourceReportId} -> ${m.targetReportId}${m.unmergedAt ? '  [undone]' : ''}`,
      ),
      '',
      `Generated ${new Date().toISOString()} by admin ${admin.id}`,
    ].filter((l, i, arr) => !(l === '' && arr[i - 1] === ''));

    await this.reportCommonService.logAccess(reportId, admin.id, 'CASE_FILE', ctx);
    this.reportCommonService.audit(
      admin,
      act('REPORT_CASE_FILE_GENERATED'),
      report,
      { result: 'success' },
      {
        targetUserId: report.isAnonymous ? null : report.userId,
      },
    );

    const buffer = await this.reportCommonService.renderPdf(
      `CASE FILE ${report.caseReference}`,
      lines,
    );
    return {
      buffer,
      filename: `case-file-${report.caseReference}.pdf`,
      contentType: 'application/pdf',
    };
  }
}
