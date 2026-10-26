import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditSeverity, InformationStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import {
  InformationPaginationQueryDto,
  ListInformationSubmissionsQueryDto,
} from '../dto/information-submission.dto';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionInformantService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

  async listByCase(admin: CurrentUserDto, query: InformationPaginationQueryDto) {
    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);

    const [rows, totalRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          missingPersonId: string;
          total: number;
          read: number;
          lastSubmittedAt: Date;
        }>
      >(Prisma.sql`
        SELECT s."missingPersonId",
               COUNT(*)::int AS total,
               COUNT(r."adminId")::int AS read,
               MAX(s."createdAt") AS "lastSubmittedAt"
        FROM information_submission s
        LEFT JOIN information_admin_read r
               ON r."submissionId" = s.id AND r."adminId" = ${admin.id}
        WHERE s."deletedAt" IS NULL
        GROUP BY s."missingPersonId"
        ORDER BY MAX(s."createdAt") DESC
        LIMIT ${limit} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "missingPersonId")::int AS count
        FROM information_submission WHERE "deletedAt" IS NULL
      `),
    ]);

    const cases = await this.informationSubmissionCommonService.caseNameMap(rows.map((r) => r.missingPersonId));

    return {
      data: rows.map((r) => ({
        missingPersonId: r.missingPersonId,
        name: cases.get(r.missingPersonId)?.name ?? null,
        personType: cases.get(r.missingPersonId)?.personType ?? null,
        total: r.total,
        read: r.read,
        unread: r.total - r.read,
        lastSubmittedAt: r.lastSubmittedAt,
      })),
      meta: this.informationSubmissionCommonService.pageMeta(page, limit, totalRows[0]?.count ?? 0),
    };
  }

  // Every tip on one case, each with isRead for the calling admin. query.isRead filters.
  async findByCase(
    admin: CurrentUserDto,
    missingPersonId: string,
    query: ListInformationSubmissionsQueryDto,
  ) {
    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);

    const where: Prisma.InformationSubmissionWhereInput = {
      missingPersonId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.isRead === true ? { adminReads: { some: { adminId: admin.id } } } : {}),
      ...(query.isRead === false ? { adminReads: { none: { adminId: admin.id } } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: {
          assignedTo: { select: { id: true, name: true } },
          adminReads: { where: { adminId: admin.id }, select: { adminId: true } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
        skip,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    const data = rows.map(({ adminReads, ...rest }) => ({
      ...rest,
      isRead: adminReads.length > 0,
    }));
    return { data, meta: this.informationSubmissionCommonService.pageMeta(page, limit, total) };
  }

  async listByInformant(admin: CurrentUserDto, query: InformationPaginationQueryDto) {
    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);

    const [rows, totalRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          informantId: string;
          total: number;
          read: number;
          accepted: number;
          rejected: number;
          lastSubmittedAt: Date;
        }>
      >(Prisma.sql`
        SELECT s."userId" AS "informantId",
               COUNT(*)::int AS total,
               COUNT(r."adminId")::int AS read,
               (COUNT(*) FILTER (WHERE s.status = 'REVIEWED'))::int AS accepted,
               (COUNT(*) FILTER (WHERE s.status = 'REJECTED'))::int AS rejected,
               MAX(s."createdAt") AS "lastSubmittedAt"
        FROM information_submission s
        LEFT JOIN information_admin_read r
               ON r."submissionId" = s.id AND r."adminId" = ${admin.id}
        WHERE s."deletedAt" IS NULL AND s."userId" IS NOT NULL
        GROUP BY s."userId"
        ORDER BY MAX(s."createdAt") DESC
        LIMIT ${limit} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(DISTINCT "userId")::int AS count
        FROM information_submission WHERE "deletedAt" IS NULL AND "userId" IS NOT NULL
      `),
    ]);

    return {
      data: rows.map((r) => ({ ...r, unread: r.total - r.read })),
      meta: this.informationSubmissionCommonService.pageMeta(page, limit, totalRows[0]?.count ?? 0),
    };
  }

  async listRepeatRejections(query: InformationPaginationQueryDto) {
    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);

    const threshold = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_REPEAT_REJECTION_THRESHOLD') ?? 3,
    );
    const windowDays = Number(
      this.configService.get<string>('INFORMATION_SUBMISSION_REPEAT_REJECTION_WINDOW_DAYS') ?? 90,
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const grouped = Prisma.sql`
      FROM information_submission
      WHERE "deletedAt" IS NULL AND "userId" IS NOT NULL AND "createdAt" >= ${since}
      GROUP BY "userId"
      HAVING (COUNT(*) FILTER (WHERE status = 'REJECTED' AND resolution IS NULL)) >= ${threshold}::int
    `;

    const [rows, totalRows] = await Promise.all([
      this.prisma.$queryRaw<
        Array<{
          informantId: string;
          rejectedCount: number;
          closedAsDuplicateOrKnown: number;
          total: number;
          lastSubmittedAt: Date;
        }>
      >(Prisma.sql`
        SELECT "userId" AS "informantId",
               (COUNT(*) FILTER (WHERE status = 'REJECTED' AND resolution IS NULL))::int AS "rejectedCount",
               (COUNT(*) FILTER (WHERE status = 'REJECTED' AND resolution IS NOT NULL))::int AS "closedAsDuplicateOrKnown",
               COUNT(*)::int AS total,
               MAX("createdAt") AS "lastSubmittedAt"
        ${grouped}
        ORDER BY 2 DESC, 5 DESC
        LIMIT ${limit} OFFSET ${skip}
      `),
      this.prisma.$queryRaw<Array<{ count: number }>>(Prisma.sql`
        SELECT COUNT(*)::int AS count FROM (SELECT "userId" ${grouped}) g
      `),
    ]);

    return {
      data: rows,
      meta: this.informationSubmissionCommonService.pageMeta(page, limit, totalRows[0]?.count ?? 0),
      criteria: { threshold, windowDays },
    };
  }

  // Needs INFORMANT_IDENTITY_READ + re-auth (controller). Shows the informant's identity,
  // so the lookup itself is logged and audited.
  async findByInformant(
    admin: CurrentUserDto,
    informantId: string,
    query: ListInformationSubmissionsQueryDto,
  ) {
    const informant = await this.prisma.user.findUnique({
      where: { id: informantId },
      select: { id: true, name: true, phone: true },
    });
    if (!informant) {
      throw new NotFoundException('informant_not_found');
    }

    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);
    const where: Prisma.InformationSubmissionWhereInput = {
      userId: informantId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: { missingPerson: { select: { id: true, name: true, personType: true } } },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    await this.prisma.informationIdentityAccess.create({
      data: { informantId, adminId: admin.id, kind: 'INFORMANT_LOOKUP' },
    });

    this.informationSubmissionCommonService.emitAudit({
      userId: admin.id,
      targetUserId: informantId,
      actorType: resolveActorType(this.informationSubmissionCommonService.getRoles(admin)),
      action: AuditEventEnum.INFORMATION_SUBMISSION_INFORMANT_LOOKUP,
      severity: AuditSeverity.WARNING,
      entity: 'User',
      entityId: informantId,
      diff: { result: 'success' },
      metadata: { tipsReturned: data.length, total },
    });

    return { informant, data, meta: this.informationSubmissionCommonService.pageMeta(page, limit, total) };
  }

  async getInformantSummary(_admin: CurrentUserDto, informantId: string) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['status', 'resolution'],
      where: { userId: informantId, deletedAt: null },
      _count: { _all: true },
    });

    if (!rows.length) {
      throw new NotFoundException('informant_not_found');
    }

    let total = 0;
    let reviewed = 0;
    let rejectedOnMerits = 0;
    let duplicate = 0;
    let alreadyKnown = 0;
    const byStatus = Object.fromEntries(
      Object.values(InformationStatus).map((s) => [s, 0]),
    ) as Record<InformationStatus, number>;

    for (const row of rows) {
      const n = row._count._all;
      total += n;
      byStatus[row.status] += n;
      if (row.status === InformationStatus.REVIEWED) reviewed += n;
      if (row.status === InformationStatus.REJECTED) {
        if (row.resolution === 'DUPLICATE') duplicate += n;
        else if (row.resolution === 'ALREADY_KNOWN') alreadyKnown += n;
        else rejectedOnMerits += n;
      }
    }

    const decided = reviewed + rejectedOnMerits;
    const score = decided > 0 ? reviewed / decided : null;
    const label =
      decided < 3 || score === null
        ? 'INSUFFICIENT_DATA'
        : score >= 0.7
          ? 'HIGH'
          : score >= 0.3
            ? 'MEDIUM'
            : 'LOW';

    return {
      informantId,
      total,
      byStatus,
      reviewed,
      rejectedOnMerits,
      duplicate,
      alreadyKnown,
      reliability: { score, label, decided },
    };
  }

  async revealInformant(admin: CurrentUserDto, id: string, reason: string) {
    const submission = await this.informationSubmissionCommonService.findLiveOrThrow(id);

    const trimmed = reason.trim();
    if (!trimmed) {
      throw new BadRequestException('reason_required');
    }

    if (!submission.userId || submission.anonymizedAt) {
      throw new NotFoundException('informant_not_available');
    }

    const informant = await this.prisma.user.findUnique({
      where: { id: submission.userId },
      select: { id: true, name: true, phone: true },
    });
    if (!informant) {
      throw new NotFoundException('informant_not_available');
    }

    const previousReveals = await this.prisma.informationIdentityAccess.count({
      where: { submissionId: id, kind: 'REVEAL' },
    });

    await this.prisma.informationIdentityAccess.create({
      data: {
        submissionId: id,
        informantId: informant.id,
        adminId: admin.id,
        kind: 'REVEAL',
        reason: trimmed,
      },
    });

    this.informationSubmissionCommonService.auditAction({
      actor: admin,
      action: AuditEventEnum.INFORMATION_SUBMISSION_INFORMANT_REVEALED,
      submission,
      severity: AuditSeverity.WARNING,
      reason: trimmed,
      metadata: { missingPersonId: submission.missingPersonId, previousReveals },
    });

    return { submissionId: id, informant, revealedAt: new Date(), previousReveals };
  }

  // Super admin: every reveal for this tip, plus lookups of the same informant.
  async getIdentityAccessLog(id: string, query: InformationPaginationQueryDto) {
    const submission = await this.prisma.informationSubmission.findUnique({
      where: { id },
      select: { id: true, userId: true },
    });
    if (!submission) {
      throw new NotFoundException('information_submission_not_found');
    }

    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);
    const where: Prisma.InformationIdentityAccessWhereInput = {
      OR: [
        { submissionId: id },
        ...(submission.userId
          ? [{ informantId: submission.userId, kind: 'INFORMANT_LOOKUP' as const }]
          : []),
      ],
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationIdentityAccess.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationIdentityAccess.count({ where }),
    ]);

    const names = await this.informationSubmissionCommonService.userNameMap(rows.map((r) => r.adminId));

    return {
      data: rows.map((r) => ({
        id: r.id,
        kind: r.kind,
        reason: r.reason,
        at: r.createdAt,
        admin: { id: r.adminId, name: names.get(r.adminId) ?? null },
      })),
      meta: this.informationSubmissionCommonService.pageMeta(page, limit, total),
    };
  }

  // Super admin: who opened this tip in the admin area (information_access_log).
  // Rows are written by markRead(); see recordAdminView() for the detail-page hook.
  async getAccessLog(id: string, query: InformationPaginationQueryDto) {
    const exists = await this.prisma.informationSubmission.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) {
      throw new NotFoundException('information_submission_not_found');
    }

    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);
    const where = { submissionId: id };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.informationAccessLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.informationAccessLog.count({ where }),
    ]);

    const names = await this.informationSubmissionCommonService.userNameMap(rows.map((r) => r.adminId));

    return {
      data: rows.map((r) => ({
        id: r.id,
        action: r.action,
        at: r.createdAt,
        admin: { id: r.adminId, name: names.get(r.adminId) ?? null },
      })),
      meta: this.informationSubmissionCommonService.pageMeta(page, limit, total),
    };
  }
}
