import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditSeverity,
  Prisma,
  Report,
  ReportIntegrityFlag,
  ReportLinkRecordType,
  ReportResolutionOutcome,
  ReportStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import {
  PageQueryDto,
  SoftDeleteReportQueryDto,
  MergeReportDto,
  MarkSpamDto,
  MarkFalseReportDto,
  UnmarkReportDto,
  LinkReportRecordDto,
  UnmergeReportDto,
  SplitReportDto,
  ArchiveReportDto,
} from '../dto/report.dto';
import {
  ALLOWED_STATUS_TRANSITIONS,
  TERMINAL_STATUSES,
  CASE_REFERENCE_MAX_ATTEMPTS,
  REPORT_TABLE,
  MediaBearing,
  act,
} from './report.constants';
import { ReportCommonService } from './report-common.service';

@Injectable()
export class ReportLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly reportCommonService: ReportCommonService,
  ) {}

  // RPT-12 GET /reports/:id/related
  async findRelated(admin: CurrentUserDto, reportId: string) {
    const report = await this.reportCommonService.loadForAdmin(admin, reportId);
    const vis = this.reportCommonService.visibilityWhere(admin);
    const pick = { id: true, caseReference: true, status: true, category: true, createdAt: true };

    const links = await this.prisma.reportLink.findMany({
      where: { reportId, recordType: ReportLinkRecordType.REPORT },
      select: { recordId: true },
    });

    const [sameReporter, linked, mergedInto, mergedReports, splitFrom, splitReports] =
      await Promise.all([
        report.userId
          ? this.prisma.report.findMany({
              where: {
                AND: [{ userId: report.userId, id: { not: reportId }, deletedAt: null }, vis],
              },
              select: pick,
              orderBy: { createdAt: 'desc' },
              take: 20,
            })
          : Promise.resolve([]),
        links.length
          ? this.prisma.report.findMany({
              where: { AND: [{ id: { in: links.map((l) => l.recordId) }, deletedAt: null }, vis] },
              select: pick,
            })
          : Promise.resolve([]),
        report.mergedIntoId
          ? this.prisma.report.findFirst({
              where: { AND: [{ id: report.mergedIntoId }, vis] },
              select: pick,
            })
          : Promise.resolve(null),
        this.prisma.report.findMany({
          where: { AND: [{ mergedIntoId: reportId }, vis] },
          select: pick,
        }),
        report.splitFromId
          ? this.prisma.report.findFirst({
              where: { AND: [{ id: report.splitFromId }, vis] },
              select: pick,
            })
          : Promise.resolve(null),
        this.prisma.report.findMany({
          where: { AND: [{ splitFromId: reportId }, vis] },
          select: pick,
        }),
      ]);

    return { sameReporter, linked, mergedInto, mergedReports, splitFrom, splitReports };
  }

  async merge(admin: CurrentUserDto, sourceId: string, dto: MergeReportDto) {
    if (sourceId === dto.targetReportId) throw new BadRequestException('cannot_merge_into_itself');

    const source = await this.reportCommonService.loadForAdminWrite(admin, sourceId, act('REPORT_MERGED'));
    const target = await this.reportCommonService.loadForAdmin(admin, dto.targetReportId);

    if (source.mergedIntoId) throw new BadRequestException('report_already_merged');
    if (target.mergedIntoId) throw new BadRequestException('target_report_is_merged');

    const children = await this.prisma.report.findMany({
      where: { mergedIntoId: sourceId },
      select: { id: true },
    });

    const closeSource = !TERMINAL_STATUSES.includes(source.status);
    const now = new Date();
    const snapshot = {
      previousStatus: source.status,
      previousClosedAt: source.closedAt?.toISOString() ?? null,
      previousResolutionOutcome: source.resolutionOutcome,
      previousResolutionSummary: source.resolutionSummary,
      previousResolvedById: source.resolvedById,
      closedByMerge: closeSource,
      repointedChildIds: children.map((c) => c.id),
    };

    const merged = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.report.update({
        where: { id: sourceId },
        data: {
          mergedIntoId: target.id,
          mergedAt: now,
          lastActivityAt: now,
          ...(closeSource
            ? {
                status: ReportStatus.CLOSED,
                closedAt: now,
                reporterUpdatedAt: now,
                resolutionOutcome: ReportResolutionOutcome.NO_ACTION,
                resolutionSummary: `Merged into ${target.caseReference}`,
                resolvedById: admin.id,
              }
            : {}),
        },
      });
      if (children.length) {
        await tx.report.updateMany({
          where: { mergedIntoId: sourceId },
          data: { mergedIntoId: target.id },
        });
      }
      await tx.reportMerge.create({
        data: {
          sourceReportId: sourceId,
          targetReportId: target.id,
          mergedById: admin.id,
          reason: dto.reason ?? null,
          snapshot: snapshot as Prisma.InputJsonValue,
        },
      });
      if (closeSource) {
        await tx.reportStatusHistory.create({
          data: {
            reportId: sourceId,
            fromStatus: source.status,
            toStatus: ReportStatus.CLOSED,
            changedById: admin.id,
            note: `merged_into:${target.caseReference}`,
          },
        });
      }
      await tx.report.update({ where: { id: target.id }, data: { lastActivityAt: now } });
      return updated;
    });

    this.reportCommonService.audit(
      admin,
      act('REPORT_MERGED'),
      source,
      {
        result: 'success',
        targetReportId: target.id,
        targetCaseReference: target.caseReference,
      },
      { reason: dto.reason ?? null },
    );
    if (closeSource) this.reportCommonService.notifyReporter(merged);
    return merged;
  }

  // RPT-111 PATCH /reports/:id/archive
  async archive(admin: CurrentUserDto, reportId: string, dto: ArchiveReportDto) {
    const existing = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_ARCHIVED'));
    if (existing.archivedAt) throw new BadRequestException('report_already_archived');
    if (!TERMINAL_STATUSES.includes(existing.status)) {
      throw new BadRequestException('only_closed_reports_can_be_archived');
    }

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        archivedAt: new Date(),
        archivedById: admin.id,
        archiveReason: dto.reason ?? null,
        lastActivityAt: new Date(),
      },
    });
    this.reportCommonService.audit(
      admin,
      act('REPORT_ARCHIVED'),
      report,
      { result: 'success' },
      {
        reason: dto.reason ?? null,
      },
    );
    return report;
  }

  // RPT-112 PATCH /reports/:id/unarchive
  async unarchive(admin: CurrentUserDto, reportId: string) {
    const existing = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_UNARCHIVED'));
    if (!existing.archivedAt) throw new BadRequestException('report_not_archived');

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        archivedAt: null,
        archivedById: null,
        archiveReason: null,
        lastActivityAt: new Date(),
      },
    });
    this.reportCommonService.audit(admin, act('REPORT_UNARCHIVED'), report, { result: 'success' });
    return report;
  }

  // RPT-113 GET /reports/archived
  async listArchived(admin: CurrentUserDto, query: PageQueryDto) {
    return this.reportCommonService.pagedReports(admin, { deletedAt: null, archivedAt: { not: null } }, query, {
      archivedAt: 'desc',
    });
  }

  // RPT-114 DELETE /reports/:id   (soft delete, Super Admin)
  async softDelete(admin: CurrentUserDto, reportId: string, dto: SoftDeleteReportQueryDto) {
    const existing = await this.reportCommonService.loadForAdmin(admin, reportId);
    if (existing.legalHold) throw new ForbiddenException('report_under_legal_hold');

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        deletedAt: new Date(),
        deletedById: admin.id,
        deleteReason: dto.reason,
      },
    });
    this.reportCommonService.audit(
      admin,
      act('REPORT_DELETED'),
      report,
      { result: 'success' },
      {
        reason: dto.reason,
        severity: AuditSeverity.WARNING,
      },
    );
    return { id: report.id, deletedAt: report.deletedAt };
  }

  // RPT-115 POST /reports/:id/restore   (Super Admin)
  async restore(admin: CurrentUserDto, reportId: string) {
    const existing = await this.reportCommonService.loadForAdmin(admin, reportId, { includeDeleted: true });
    if (!existing.deletedAt) throw new BadRequestException('report_not_deleted');

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: { deletedAt: null, deletedById: null, deleteReason: null, lastActivityAt: new Date() },
    });
    this.reportCommonService.audit(admin, act('REPORT_RESTORED'), report, { result: 'success' });
    return report;
  }

  // RPT-116 GET /reports/trash   (Super Admin)
  async listTrash(admin: CurrentUserDto, query: PageQueryDto) {
    return this.reportCommonService.pagedReports(admin, { deletedAt: { not: null } }, query, { deletedAt: 'desc' });
  }

  // RPT-119 POST /reports/:id/mark-spam
  // Also rejects the report when the status table allows REJECTED from where it is.
  async markSpam(admin: CurrentUserDto, reportId: string, dto: MarkSpamDto) {
    const existing = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_INTEGRITY_FLAGGED'));
    if (existing.integrityFlag) throw new BadRequestException('report_already_flagged');

    const flagData = {
      integrityFlag: ReportIntegrityFlag.SPAM,
      integrityReason: dto.reason ?? null,
      integrityFlagAt: new Date(),
      integrityById: admin.id,
    };

    const canReject = (ALLOWED_STATUS_TRANSITIONS[existing.status] ?? []).includes(
      ReportStatus.REJECTED,
    );

    let report: Report;
    if (canReject) {
      const res = await this.reportCommonService.applyTransition(
        existing,
        ReportStatus.REJECTED,
        admin.id,
        flagData,
        'marked_spam',
      );
      if (!res) throw new BadRequestException('report_transition_conflict');
      report = res;
    } else {
      report = await this.prisma.report.update({
        where: { id: reportId },
        data: { ...flagData, lastActivityAt: new Date() },
      });
    }

    this.reportCommonService.audit(
      admin,
      act('REPORT_INTEGRITY_FLAGGED'),
      report,
      {
        result: 'success',
        flag: ReportIntegrityFlag.SPAM,
        rejected: canReject,
      },
      { reason: dto.reason ?? null },
    );

    if (canReject) {
      this.reportCommonService.notifyReporter(report);
      if (report.userId) await this.reportCommonService.maybeFlagUserForRejections(report.userId);
    }
    return report;
  }

  // RPT-120 POST /reports/:id/mark-false   (flag only; closing is a separate decision)
  async markFalse(admin: CurrentUserDto, reportId: string, dto: MarkFalseReportDto) {
    const existing = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_INTEGRITY_FLAGGED'));
    if (existing.integrityFlag) throw new BadRequestException('report_already_flagged');

    const flag = dto.malicious
      ? ReportIntegrityFlag.MALICIOUS_FALSE_REPORT
      : ReportIntegrityFlag.FALSE_REPORT;

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        integrityFlag: flag,
        integrityReason: dto.reason,
        integrityFlagAt: new Date(),
        integrityById: admin.id,
        lastActivityAt: new Date(),
      },
    });
    this.reportCommonService.audit(
      admin,
      act('REPORT_INTEGRITY_FLAGGED'),
      report,
      {
        result: 'success',
        flag,
      },
      { reason: dto.reason, severity: dto.malicious ? AuditSeverity.WARNING : undefined },
    );
    return report;
  }

  // RPT-121 PATCH /reports/:id/unmark   (clears the flag; does not revert a rejection)
  async unmark(admin: CurrentUserDto, reportId: string, dto: UnmarkReportDto) {
    const existing = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_INTEGRITY_CLEARED'));
    if (!existing.integrityFlag) throw new BadRequestException('report_not_flagged');

    const report = await this.prisma.report.update({
      where: { id: reportId },
      data: {
        integrityFlag: null,
        integrityReason: null,
        integrityFlagAt: null,
        integrityById: null,
        lastActivityAt: new Date(),
      },
    });
    this.reportCommonService.audit(
      admin,
      act('REPORT_INTEGRITY_CLEARED'),
      report,
      {
        result: 'success',
        previousFlag: existing.integrityFlag,
      },
      { reason: dto.reason ?? null },
    );
    return report;
  }

  // RPT-122 GET /reports/spam
  async listSpam(admin: CurrentUserDto, query: PageQueryDto) {
    return this.reportCommonService.pagedReports(admin, { deletedAt: null, integrityFlag: { not: null } }, query, {
      integrityFlagAt: 'desc',
    });
  }

  // RPT-123 GET /reports/:id/links
  async getLinks(admin: CurrentUserDto, reportId: string) {
    await this.reportCommonService.loadForAdmin(admin, reportId);
    return this.prisma.reportLink.findMany({
      where: { reportId },
      orderBy: { createdAt: 'desc' },
    });
  }

  // RPT-124 POST /reports/:id/links
  async addLink(admin: CurrentUserDto, reportId: string, dto: LinkReportRecordDto) {
    const report = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_LINKED'));

    if (dto.recordType === 'REPORT') {
      if (dto.recordId === reportId) throw new BadRequestException('cannot_link_report_to_itself');
      await this.reportCommonService.loadForAdmin(admin, dto.recordId); // must exist and be visible
    }

    try {
      const link = await this.prisma.reportLink.create({
        data: {
          reportId,
          recordType: dto.recordType as ReportLinkRecordType,
          recordId: dto.recordId,
          note: dto.note ?? null,
          createdById: admin.id,
        },
      });
      this.reportCommonService.audit(admin, act('REPORT_LINKED'), report, {
        result: 'success',
        recordType: dto.recordType,
        recordId: dto.recordId,
      });
      return link;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        throw new ConflictException('link_already_exists');
      }
      throw err;
    }
  }

  // RPT-125 DELETE /reports/:id/links/:linkId
  async removeLink(admin: CurrentUserDto, reportId: string, linkId: string) {
    const report = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_UNLINKED'));
    const res = await this.prisma.reportLink.deleteMany({ where: { id: linkId, reportId } });
    if (res.count === 0) throw new NotFoundException('link_not_found');
    this.reportCommonService.audit(admin, act('REPORT_UNLINKED'), report, { result: 'success', linkId });
    return { deleted: true };
  }

  // RPT-126 POST /reports/:id/unmerge
  async unmerge(admin: CurrentUserDto, reportId: string, dto: UnmergeReportDto) {
    const source = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_UNMERGED'));

    const merge = await this.prisma.reportMerge.findFirst({
      where: {
        sourceReportId: reportId,
        unmergedAt: null,
        ...(dto.mergeId ? { id: dto.mergeId } : {}),
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!merge) throw new NotFoundException('merge_not_found');

    const snap = (merge.snapshot ?? {}) as {
      previousStatus?: ReportStatus;
      previousClosedAt?: string | null;
      previousResolutionOutcome?: ReportResolutionOutcome | null;
      previousResolutionSummary?: string | null;
      previousResolvedById?: string | null;
      closedByMerge?: boolean;
      repointedChildIds?: string[];
    };

    const now = new Date();
    const restored = await this.prisma.$transaction(async (tx) => {
      const updated = await tx.report.update({
        where: { id: reportId },
        data: {
          mergedIntoId: null,
          mergedAt: null,
          lastActivityAt: now,
          ...(snap.closedByMerge && snap.previousStatus
            ? {
                status: snap.previousStatus,
                reporterUpdatedAt: now,
                closedAt: snap.previousClosedAt ? new Date(snap.previousClosedAt) : null,
                resolutionOutcome: snap.previousResolutionOutcome ?? null,
                resolutionSummary: snap.previousResolutionSummary ?? null,
                resolvedById: snap.previousResolvedById ?? null,
              }
            : {}),
        },
      });
      if (snap.repointedChildIds?.length) {
        await tx.report.updateMany({
          where: { id: { in: snap.repointedChildIds }, mergedIntoId: merge.targetReportId },
          data: { mergedIntoId: reportId },
        });
      }
      await tx.reportMerge.update({
        where: { id: merge.id },
        data: { unmergedAt: now, unmergedById: admin.id, unmergeReason: dto.reason },
      });
      if (snap.closedByMerge && snap.previousStatus) {
        await tx.reportStatusHistory.create({
          data: {
            reportId,
            fromStatus: source.status,
            toStatus: snap.previousStatus,
            changedById: admin.id,
            note: 'unmerged',
          },
        });
      }
      return updated;
    });

    this.reportCommonService.audit(
      admin,
      act('REPORT_UNMERGED'),
      source,
      {
        result: 'success',
        mergeId: merge.id,
        restoredStatus: restored.status,
      },
      { reason: dto.reason },
    );
    if (snap.closedByMerge) this.reportCommonService.notifyReporter(restored);
    return restored;
  }

  // RPT-127 GET /reports/:id/merge-history
  async getMergeHistory(admin: CurrentUserDto, reportId: string) {
    await this.reportCommonService.loadForAdmin(admin, reportId, { includeDeleted: true });
    return this.prisma.reportMerge.findMany({
      where: { OR: [{ sourceReportId: reportId }, { targetReportId: reportId }] },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listDuplicates(admin: CurrentUserDto, query: PageQueryDto) {
    const { page, limit, skip } = this.reportCommonService.paging(query);
    const windowSec = 72 * 3600;
    const degrees = 0.0045; // ≈ 0.5 km
    const standardOnly = this.reportCommonService.isSuperAdmin(admin)
      ? Prisma.sql`TRUE`
      : Prisma.sql`(a."sensitivity"::text = 'STANDARD' AND b."sensitivity"::text = 'STANDARD')`;

    const rows = await this.prisma.$queryRaw<
      Array<{
        aId: string;
        aRef: string;
        bId: string;
        bRef: string;
        category: string;
        reason: string;
        gapHours: number;
      }>
    >`
      SELECT a.id AS "aId", a."caseReference" AS "aRef",
             b.id AS "bId", b."caseReference" AS "bRef",
             a.category::text AS category,
             CASE WHEN a."userId" IS NOT NULL AND a."userId" = b."userId"
                  THEN 'SAME_REPORTER' ELSE 'NEARBY_LOCATION' END AS reason,
             ROUND((ABS(EXTRACT(EPOCH FROM (a."createdAt" - b."createdAt"))) / 3600)::numeric, 1)::float AS "gapHours"
      FROM ${REPORT_TABLE} a
      JOIN ${REPORT_TABLE} b
        ON a.id < b.id
       AND a.category = b.category
       AND ABS(EXTRACT(EPOCH FROM (a."createdAt" - b."createdAt"))) <= ${windowSec}
       AND (
            (a."userId" IS NOT NULL AND a."userId" = b."userId")
         OR (a.latitude IS NOT NULL AND b.latitude IS NOT NULL
             AND ABS(a.latitude - b.latitude) <= ${degrees}
             AND ABS(a.longitude - b.longitude) <= ${degrees})
       )
      WHERE a."deletedAt" IS NULL AND b."deletedAt" IS NULL
        AND a."mergedIntoId" IS NULL AND b."mergedIntoId" IS NULL
        AND a.status::text NOT IN ('CLOSED','REJECTED')
        AND b.status::text NOT IN ('CLOSED','REJECTED')
        AND ${standardOnly}
        AND NOT EXISTS (
          SELECT 1 FROM report_link l
          WHERE l."recordType"::text = 'REPORT'
            AND ((l."reportId" = a.id AND l."recordId" = b.id)
              OR (l."reportId" = b.id AND l."recordId" = a.id))
        )
      ORDER BY GREATEST(a."createdAt", b."createdAt") DESC
      LIMIT ${limit + 1} OFFSET ${skip}
    `;

    return {
      items: rows.slice(0, limit),
      page,
      limit,
      hasMore: rows.length > limit,
    };
  }

  async split(admin: CurrentUserDto, reportId: string, dto: SplitReportDto) {
    const source = await this.reportCommonService.loadForAdminWrite(admin, reportId, act('REPORT_SPLIT'));

    const evidenceIds = [...new Set(dto.evidenceIds ?? [])];
    const evidence = evidenceIds.length
      ? await this.prisma.reportEvidence.findMany({
          where: { id: { in: evidenceIds }, reportId, removedAt: null },
        })
      : [];
    if (evidence.length !== evidenceIds.length) {
      throw new BadRequestException('evidence_not_on_report');
    }

    const sourceMedia: MediaBearing = {
      photo: [...source.photo],
      video: [...source.video],
      audio: [...source.audio],
      pdf: [...source.pdf],
      document: [...source.document],
      other: [...source.other],
    };
    const newMedia: MediaBearing = {
      photo: [],
      video: [],
      audio: [],
      pdf: [],
      document: [],
      other: [],
    };
    let movedBytes = 0;
    for (const e of evidence) {
      const field = this.reportCommonService.fieldForKind(e.kind);
      sourceMedia[field] = sourceMedia[field].filter((k) => k !== e.storageKey);
      newMedia[field].push(e.storageKey);
      movedBytes += e.sizeBytes ?? 0;
    }

    let caseReference = this.reportCommonService.generateCaseReference();
    for (let i = 0; i < CASE_REFERENCE_MAX_ATTEMPTS; i++) {
      const clash = await this.prisma.report.findUnique({
        where: { caseReference },
        select: { id: true },
      });
      if (!clash) break;
      caseReference = this.reportCommonService.generateCaseReference();
    }

    const now = new Date();
    const created = await this.prisma.$transaction(async (tx) => {
      const child = await tx.report.create({
        data: {
          userId: source.userId,
          caseReference,
          category: source.category,
          description: dto.description,
          location: source.location,
          incidentAt: source.incidentAt,
          channel: source.channel,
          status: ReportStatus.PENDING,
          priority: source.priority,
          sensitivity: source.sensitivity,
          region: source.region,
          isAnonymous: source.isAnonymous,
          contactMethod: source.contactMethod,
          contactWindow: source.contactWindow,
          latitude: source.latitude,
          longitude: source.longitude,
          locationAccuracyMeters: source.locationAccuracyMeters,
          locationCapturedAt: source.locationCapturedAt,
          locationAddress: source.locationAddress,
          splitFromId: source.id,
          ...newMedia,
          mediaTotalBytes: movedBytes,
        },
      });

      if (evidence.length) {
        await tx.reportEvidence.updateMany({
          where: { id: { in: evidenceIds } },
          data: { reportId: child.id },
        });
        await tx.reportEvidenceCustody.createMany({
          data: evidence.map((e) => ({
            evidenceId: e.id,
            action: 'MOVED',
            actorId: admin.id,
            note: `split_from:${source.caseReference}`,
          })),
        });
        await tx.report.update({
          where: { id: source.id },
          data: {
            ...sourceMedia,
            mediaTotalBytes: Math.max(0, source.mediaTotalBytes - movedBytes),
          },
        });
      }

      await tx.report.update({ where: { id: source.id }, data: { lastActivityAt: now } });
      await tx.reportStatusHistory.create({
        data: {
          reportId: child.id,
          fromStatus: null,
          toStatus: ReportStatus.PENDING,
          changedById: admin.id,
          note: `split_from:${source.caseReference}`,
        },
      });
      await tx.reportRevision.create({
        data: {
          reportId: source.id,
          editedById: admin.id,
          changes: {
            split: { to: child.id, caseReference: child.caseReference, movedEvidence: evidenceIds },
            ...(dto.reason ? { reason: dto.reason } : {}),
          } as Prisma.InputJsonValue,
        },
      });
      return child;
    });

    this.reportCommonService.audit(
      admin,
      act('REPORT_SPLIT'),
      source,
      {
        result: 'success',
        newReportId: created.id,
        newCaseReference: created.caseReference,
        movedEvidence: evidenceIds.length,
      },
      { reason: dto.reason ?? null },
    );
    return created;
  }
}
