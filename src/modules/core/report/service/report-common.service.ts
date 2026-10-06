import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHmac } from 'crypto';
import {
  AuditOutcome,
  AuditSeverity,
  Prisma,
  Report,
  ReportEvidenceKind,
  ReportSensitivity,
  ReportStatus,
  SubmissionChannel,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import { ReportStatsQueryDto, ReportLocationDto } from '../dto/report.dto';
import {
  ADMIN_ROLE_NAMES,
  REPORT_TABLE,
  MEDIA_FIELD_NAMES,
  MediaFieldName,
  MediaBearing,
  MediaBearingDto,
  RequestCtx,
  ANON_KEY_PREFIX,
} from './report.constants';

@Injectable()
export class ReportCommonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  getMediaBucket(): string {
    return this.configService.get<string>('minio.bucketName') ?? 'ehte-media';
  }

  collectMediaFields(entity: MediaBearing): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => entity[field]);
  }

  collectMediaFieldsFromDto(dto: MediaBearingDto): string[] {
    return MEDIA_FIELD_NAMES.flatMap((field) => dto[field] ?? []);
  }

  // Confirms every filepath exists, and enforces size/MIME limits
  // Also returns each validated file's size for running byte totals
  async validateMediaFilesExist(
    filepaths: string[],
  ): Promise<Array<{ filepath: string; size: number }>> {
    if (!filepaths.length) return [];

    const maxFileSizeBytes = Number(
      this.configService.get<string>('MEDIA_MAX_FILE_SIZE') ?? 52_428_800,
    );
    const allowedMimeTypes = new Set(
      (this.configService.get<string>('MEDIA_ALLOWED_MIME_TYPES') ?? '')
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean),
    );

    const checks = await Promise.all(
      filepaths.map(async (filepath) => {
        const exists = await this.minioService.objectExists(filepath);
        if (!exists) {
          return { filepath, ok: false as const, reason: 'not_found', size: 0 };
        }

        const stat = await this.minioService.statObject(filepath);

        if (stat.size > maxFileSizeBytes) {
          return { filepath, ok: false as const, reason: 'too_large', size: stat.size };
        }
        if (allowedMimeTypes.size > 0 && !allowedMimeTypes.has(stat.contentType)) {
          return { filepath, ok: false as const, reason: 'disallowed_type', size: stat.size };
        }
        return { filepath, ok: true as const, size: stat.size };
      }),
    );

    const bad = checks.filter((c) => !c.ok);
    if (bad.length) {
      throw new BadRequestException(
        `media_validation_failed:${bad.map((b) => `${b.filepath}:${b.reason}`).join(',')}`,
      );
    }

    return checks.map((c) => ({ filepath: c.filepath, size: c.size }));
  }

  // Per-field attachment counts, checked before any MinIO calls
  assertAttachmentCounts(media: MediaBearing): void {
    const maxPhotos = Number(
      this.configService.get<string>('REPORT_MAX_PHOTOS') ??
        this.configService.get<string>('CONTENT_MAX_PHOTOS') ??
        5,
    );
    const maxVideos = Number(
      this.configService.get<string>('REPORT_MAX_VIDEOS') ??
        this.configService.get<string>('CONTENT_MAX_VIDEOS') ??
        1,
    );
    const maxOther = Number(
      this.configService.get<string>('REPORT_MAX_OTHER_FILES') ??
        this.configService.get<string>('CONTENT_MAX_OTHER_FILES') ??
        2,
    );

    if (media.photo.length > maxPhotos) {
      throw new BadRequestException(`too_many_photos:max_${maxPhotos}`);
    }
    if (media.video.length > maxVideos) {
      throw new BadRequestException(`too_many_videos:max_${maxVideos}`);
    }
    const otherCount =
      media.audio.length + media.pdf.length + media.document.length + media.other.length;
    if (otherCount > maxOther) {
      throw new BadRequestException(`too_many_other_files:max_${maxOther}`);
    }
  }

  // Total attached-media size cap per report
  assertTotalBytes(totalBytes: number): void {
    const maxTotalBytes = Number(
      this.configService.get<string>('REPORT_MAX_TOTAL_UPLOAD_BYTES') ??
        this.configService.get<string>('CONTENT_MAX_TOTAL_UPLOAD_BYTES') ??
        52_428_800,
    );
    if (totalBytes > maxTotalBytes) {
      throw new BadRequestException(`upload_total_size_exceeded:max_${maxTotalBytes}`);
    }
  }

  // Best-effort MinIO delete; failures are swallowed per-file
  async deleteMediaFiles(filepaths: string[]): Promise<void> {
    if (!filepaths.length) return;
    await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));
  }

  // SUPER_ADMIN may act on any report; plain ADMIN only unassigned/own
  // Denied access attempts write a DENIED audit row before throwing
  assertAdminCanAccessReport(
    admin: CurrentUserDto,
    report: { id: string; assignedToId: string | null; caseReference: string },
    action: AuditEventEnum,
  ): void {
    const roles = this.getRoles(admin);
    const isSuperAdmin = roles.includes(RolesEnum.SUPER_ADMIN);

    if (!isSuperAdmin && report.assignedToId && report.assignedToId !== admin.id) {
      this.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(roles),
        action,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Report',
        entityId: report.id,
        entityLabel: report.caseReference,
        diff: { result: 'denied', reason: 'assigned_to_another_admin' },
      });
      throw new ForbiddenException('report_assigned_to_another_admin');
    }
  }

  // Flag != reject; only writes an audit row an admin can review
  async maybeFlagUserForRejections(userId: string): Promise<void> {
    const threshold = Number(
      this.configService.get<string>('REPORT_AUTO_FLAG_REJECTION_COUNT') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_REJECTION_COUNT') ??
        3,
    );
    const windowDays = Number(
      this.configService.get<string>('REPORT_AUTO_FLAG_WINDOW_DAYS') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_WINDOW_DAYS') ??
        7,
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const recentRejections = await this.prisma.report.count({
      where: { userId, status: ReportStatus.REJECTED, updatedAt: { gte: since } },
    });

    if (recentRejections >= threshold) {
      const flaggedUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      this.emitAudit({
        targetUserId: userId,
        actorType: 'SYSTEM',
        action: AuditEventEnum.USER_AUTO_FLAGGED,
        entity: 'User',
        entityId: userId,
        entityLabel: flaggedUser?.name ?? undefined,
        diff: {
          reason: 'repeated_report_rejections',
          rejectionCount: recentRejections,
          windowDays,
          result: 'flagged_for_review',
        },
      });
    }
  }

  isAdminUser(user: CurrentUserDto): boolean {
    return this.getRoles(user).some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));
  }

  isSuperAdmin(user: CurrentUserDto): boolean {
    return this.getRoles(user).includes(RolesEnum.SUPER_ADMIN);
  }

  errMsg(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }

  paging(q: { page?: number; limit?: number }, maxLimit = 100) {
    const page = Math.max(1, q.page ?? 1);
    const limit = Math.min(maxLimit, Math.max(1, q.limit ?? 20));
    return { page, limit, skip: (page - 1) * limit, take: limit };
  }

  activeGrantWhere(adminId: string): Prisma.ReportAccessGrantWhereInput {
    return {
      adminId,
      revokedAt: null,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
  }

  visibilityWhere(admin: CurrentUserDto): Prisma.ReportWhereInput {
    if (this.isSuperAdmin(admin)) return {};
    return {
      OR: [
        { sensitivity: ReportSensitivity.STANDARD },
        { assignedToId: admin.id },
        { accessGrants: { some: this.activeGrantWhere(admin.id) } },
      ],
    };
  }

  // Same rule as visibilityWhere, as a SQL fragment (alias r)
  visibilitySql(admin: CurrentUserDto): Prisma.Sql {
    if (this.isSuperAdmin(admin)) return Prisma.sql`TRUE`;
    return Prisma.sql`(r."sensitivity"::text = 'STANDARD'
      OR r."assignedToId" = ${admin.id}
      OR EXISTS (
        SELECT 1 FROM report_access_grant g
        WHERE g."reportId" = r.id AND g."adminId" = ${admin.id}
          AND g."revokedAt" IS NULL AND (g."expiresAt" IS NULL OR g."expiresAt" > NOW())
      ))`;
  }

  // Loads a report the admin may see; hidden restricted reports look like 404
  async loadForAdmin(
    admin: CurrentUserDto,
    reportId: string,
    opts: { includeDeleted?: boolean } = {},
  ): Promise<Report> {
    const report = await this.prisma.report.findFirst({
      where: {
        AND: [
          { id: reportId },
          opts.includeDeleted ? {} : { deletedAt: null },
          this.visibilityWhere(admin),
        ],
      },
    });
    if (!report) throw new NotFoundException('report_not_found');
    return report;
  }

  // loadForAdmin + the same assignment gate the existing write routes use
  async loadForAdminWrite(
    admin: CurrentUserDto,
    reportId: string,
    action: AuditEventEnum,
  ): Promise<Report> {
    const report = await this.loadForAdmin(admin, reportId);
    this.assertAdminCanAccessReport(admin, report, action);
    return report;
  }

  async loadOwned(user: CurrentUserDto, reportId: string): Promise<Report> {
    const report = await this.prisma.report.findFirst({
      where: { id: reportId, userId: user.id, deletedAt: null },
    });
    if (!report) throw new NotFoundException('report_not_found');
    return report;
  }

  // Masked, stable identifier for anonymous reporters (never the real id)
  maskUserId(userId: string): string {
    const secret =
      this.configService.get<string>('REPORT_ANON_MASK_SECRET') ??
      this.configService.get<string>('JWT_SECRET') ??
      'ehte-anon-mask';
    return `${ANON_KEY_PREFIX}${createHmac('sha256', secret).update(userId).digest('hex').slice(0, 12)}`;
  }

  presentReporter(
    isAnonymous: boolean,
    userId: string | null,
    user?: { id: string; name: string | null } | null,
  ) {
    if (isAnonymous || !userId) {
      return { anonymous: true, key: userId ? this.maskUserId(userId) : null };
    }
    return { anonymous: false, id: user?.id ?? userId, name: user?.name ?? null };
  }

  // Generic admin list: visibility + isRead + masked reporter, one place
  async pagedReports(
    admin: CurrentUserDto,
    where: Prisma.ReportWhereInput,
    q: { page?: number; limit?: number },
    orderBy: Prisma.ReportOrderByWithRelationInput | Prisma.ReportOrderByWithRelationInput[] = {
      createdAt: 'desc',
    },
  ) {
    const { page, limit, skip, take } = this.paging(q);
    const full: Prisma.ReportWhereInput = { AND: [where, this.visibilityWhere(admin)] };

    const [rows, total] = await Promise.all([
      this.prisma.report.findMany({
        where: full,
        orderBy,
        skip,
        take,
        include: {
          user: { select: { id: true, name: true } },
          assignedTo: { select: { id: true, name: true } },
          adminReads: { where: { adminId: admin.id }, select: { readAt: true } },
        },
      }),
      this.prisma.report.count({ where: full }),
    ]);

    const items = rows.map(({ user, adminReads, ...r }) => ({
      ...r,
      userId: r.isAnonymous ? null : r.userId,
      isRead: adminReads.length > 0,
      reporter: this.presentReporter(r.isAnonymous, r.userId, user),
    }));

    return { items, total, page, limit };
  }

  // Single audit entry point for the new flows
  audit(
    actor: CurrentUserDto,
    action: AuditEventEnum,
    report: { id: string; caseReference: string },
    diff: Record<string, unknown>,
    opts: {
      reason?: string | null;
      targetUserId?: string | null;
      metadata?: Record<string, unknown>;
      outcome?: AuditOutcome;
      severity?: AuditSeverity;
    } = {},
  ): void {
    this.emitAudit({
      userId: actor.id,
      ...(opts.targetUserId ? { targetUserId: opts.targetUserId } : {}),
      actorType: resolveActorType(this.getRoles(actor)),
      action,
      ...(opts.outcome ? { outcome: opts.outcome } : {}),
      ...(opts.severity ? { severity: opts.severity } : {}),
      entity: 'Report',
      entityId: report.id,
      entityLabel: report.caseReference,
      ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
      diff,
      ...(opts.metadata ? { metadata: opts.metadata } : {}),
    });
  }

  async logAccess(
    reportId: string,
    userId: string | null,
    action: string,
    ctx?: RequestCtx,
  ): Promise<void> {
    await this.prisma.reportAccessLog
      .create({ data: { reportId, userId, action, ipAddress: ctx?.ip ?? null } })
      .catch(() => undefined); // never block the request on the access log
  }

  // Status change that also writes ReportStatusHistory; null = lost a race
  async applyTransition(
    existing: Report,
    to: ReportStatus,
    changedById: string | null,
    extra: Prisma.ReportUncheckedUpdateManyInput = {},
    note?: string | null,
  ): Promise<Report | null> {
    return this.prisma.$transaction(async (tx) => {
      const now = new Date();
      const r = await tx.report.updateMany({
        where: { id: existing.id, status: existing.status },
        data: { status: to, lastActivityAt: now, reporterUpdatedAt: now, ...extra },
      });
      if (r.count === 0) return null;
      await tx.reportStatusHistory.create({
        data: {
          reportId: existing.id,
          fromStatus: existing.status,
          toStatus: to,
          changedById,
          note: note ?? null,
        },
      });
      return tx.report.findUniqueOrThrow({ where: { id: existing.id } });
    });
  }

  notifyReporter(report: Report): void {
    this.eventEmitter.emit(NotificationEventEnum.REPORT_UPDATED, {
      reportId: report.id,
      userId: report.userId,
      caseReference: report.caseReference,
      status: report.status,
    });
  }

  fieldForKind(kind: ReportEvidenceKind): MediaFieldName {
    return kind.toLowerCase() as MediaFieldName;
  }

  gpsData(gps: ReportLocationDto) {
    const capturedAt = gps.capturedAt ? new Date(gps.capturedAt) : new Date();
    if (capturedAt.getTime() > Date.now() + 5 * 60 * 1000) {
      throw new BadRequestException('location_captured_in_the_future');
    }
    return {
      latitude: gps.latitude,
      longitude: gps.longitude,
      locationAccuracyMeters: gps.accuracyMeters ?? null,
      locationCapturedAt: capturedAt,
      locationAddress: gps.address ?? null,
      locationVerified: false,
      locationVerifiedAt: null,
      locationVerifiedById: null,
    };
  }

  async renderPdf(title: string, lines: string[]): Promise<Buffer> {
    let PDFDocument: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      PDFDocument = require('pdfkit');
    } catch {
      return this.renderSimplePdf(title, lines);
    }

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) =>
      doc.on('end', () => resolve(Buffer.concat(chunks))),
    );

    const fontPath = this.configService.get<string>('REPORT_PDF_FONT_PATH');
    if (fontPath) doc.font(fontPath);
    doc.fontSize(16).text(title);
    doc.moveDown();
    doc.fontSize(10);
    for (const line of lines) doc.text(line || ' ');
    doc.end();
    return done;
  }

  renderSimplePdf(title: string, lines: string[]): Buffer {
    const clean = (s: string) => s.replace(/[^\x20-\x7E]/g, '?').replace(/([\\()])/g, '\\$1');
    const wrapped: string[] = [title, ''];
    for (const line of lines) {
      if (!line) {
        wrapped.push('');
        continue;
      }
      for (let i = 0; i < line.length; i += 95) wrapped.push(line.slice(i, i + 95));
    }

    const perPage = 55;
    const pages: string[][] = [];
    for (let i = 0; i < wrapped.length; i += perPage) pages.push(wrapped.slice(i, i + perPage));
    if (!pages.length) pages.push(['']);

    const objs: string[] = [];
    objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
    objs[2] = `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + 2 * i} 0 R`).join(' ')}] /Count ${pages.length} >>`;
    objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
    pages.forEach((pg, i) => {
      const content = `BT /F1 10 Tf 13 TL 50 800 Td\n${pg.map((l) => `(${clean(l)}) '`).join('\n')}\nET`;
      objs[4 + 2 * i] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + 2 * i} 0 R >>`;
      objs[5 + 2 * i] =
        `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`;
    });

    let out = '%PDF-1.4\n';
    const offsets: number[] = [];
    for (let id = 1; id < objs.length; id++) {
      offsets[id] = Buffer.byteLength(out);
      out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
    }
    const xref = Buffer.byteLength(out);
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objs.length; id++) {
      out += `${String(offsets[id]).padStart(10, '0')} 00000 n \n`;
    }
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
    return Buffer.from(out, 'latin1');
  }

  revision(reportId: string, editedById: string, changes: Record<string, unknown>) {
    return this.prisma.reportRevision.create({
      data: { reportId, editedById, changes: changes as Prisma.InputJsonValue },
    });
  }

  normChannel(channel?: string): SubmissionChannel | undefined {
    if (!channel) return undefined;
    const value = channel.trim().toUpperCase();
    if (!(Object.values(SubmissionChannel) as string[]).includes(value)) {
      throw new BadRequestException('invalid_channel');
    }
    return value as SubmissionChannel;
  }

  statsWhere(q: ReportStatsQueryDto, admin: CurrentUserDto): Prisma.ReportWhereInput {
    const channel = this.normChannel(q.channel);
    const and: Prisma.ReportWhereInput[] = [{ deletedAt: null }, this.visibilityWhere(admin)];
    if (q.from || q.to) {
      and.push({
        createdAt: {
          ...(q.from ? { gte: new Date(q.from) } : {}),
          ...(q.to ? { lte: new Date(q.to) } : {}),
        },
      });
    }
    if (q.status) and.push({ status: q.status });
    if (q.category) and.push({ category: q.category });
    if (channel) and.push({ channel });
    if (q.assignedTo) and.push({ assignedToId: q.assignedTo });
    if (q.region) and.push({ region: q.region });
    return { AND: and };
  }

  statsFilterSql(q: ReportStatsQueryDto, admin: CurrentUserDto): Prisma.Sql {
    const channel = this.normChannel(q.channel);
    const c: Prisma.Sql[] = [Prisma.sql`r."deletedAt" IS NULL`, this.visibilitySql(admin)];
    if (q.from) c.push(Prisma.sql`r."createdAt" >= ${new Date(q.from)}`);
    if (q.to) c.push(Prisma.sql`r."createdAt" <= ${new Date(q.to)}`);
    if (q.status) c.push(Prisma.sql`r.status::text = ${q.status}`);
    if (q.category) c.push(Prisma.sql`r.category::text = ${q.category}`);
    if (channel) c.push(Prisma.sql`r.channel::text = ${channel}`);
    if (q.assignedTo) c.push(Prisma.sql`r."assignedToId" = ${q.assignedTo}`);
    if (q.region) c.push(Prisma.sql`r.region = ${q.region}`);
    return Prisma.join(c, ' AND ');
  }

  // Counts grouped by one whitelisted column; used by facets and the by-* stats
  async countBy(
    admin: CurrentUserDto,
    q: ReportStatsQueryDto,
    column:
      'status' | 'category' | 'channel' | 'priority' | 'sensitivity' | 'region' | 'assignedTeamId',
  ) {
    const allowed = [
      'status',
      'category',
      'channel',
      'priority',
      'sensitivity',
      'region',
      'assignedTeamId',
    ];
    if (!allowed.includes(column)) throw new BadRequestException('invalid_column');
    const col = Prisma.raw(`r."${column}"`);
    const where = this.statsFilterSql(q, admin);

    const rows = await this.prisma.$queryRaw<Array<{ key: string | null; count: number }>>`
      SELECT ${col}::text AS key, COUNT(*)::int AS count
      FROM ${REPORT_TABLE} r
      WHERE ${where}
      GROUP BY 1
      ORDER BY count DESC
    `;
    const total = rows.reduce((s, r) => s + r.count, 0);
    return {
      total,
      items: rows.map((r) => ({
        key: r.key ?? 'UNKNOWN',
        count: r.count,
        share: total ? Math.round((r.count / total) * 10000) / 10000 : 0,
      })),
    };
  }

  // RPT-43 GET /reports/stats/assignment   (assigned / unassigned / stale)
  async getStatsAssignment(admin: CurrentUserDto, query: ReportStatsQueryDto) {
    const staleHours = Number(this.configService.get<string>('REPORT_STALE_PENDING_HOURS') ?? 48);
    const where = this.statsFilterSql(query, admin);
    const cutoff = new Date(Date.now() - staleHours * 3600000);

    const rows = await this.prisma.$queryRaw<
      Array<{ assigned: number; unassigned: number; stale: number }>
    >`
      SELECT COUNT(*) FILTER (WHERE r."assignedToId" IS NOT NULL)::int AS assigned,
             COUNT(*) FILTER (WHERE r."assignedToId" IS NULL)::int AS unassigned,
             COUNT(*) FILTER (WHERE r."assignedToId" IS NULL
                                AND r.status::text NOT IN ('CLOSED','REJECTED')
                                AND r."createdAt" < ${cutoff})::int AS stale
      FROM ${REPORT_TABLE} r
      WHERE ${where}
    `;
    return {
      assigned: rows[0]?.assigned ?? 0,
      unassigned: rows[0]?.unassigned ?? 0,
      stale: rows[0]?.stale ?? 0,
      staleAfterHours: staleHours,
    };
  }

  generateCaseReference(): string {
    const year = new Date().getFullYear();
    const random = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `EHT-${year}-${random}`;
  }

  getRoles(user: CurrentUserDto): string[] {
    return (
      (
        user as unknown as {
          roles?: string[];
        }
      ).roles ?? []
    );
  }
}
