import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditOutcome,
  MissingPersonAppealState,
  MissingPersonStatus,
  Prisma,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { MinioService } from 'src/infrastructure/minio/minio.service';
import {
  AppealMissingPersonRejectionDto,
  ListMissingPersonsQueryDto,
  MissingPersonFoundReportDto,
} from '../dto/missing-person.dto';
import { FAMILY_VISIBLE_ACTIONS } from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonMineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

  async getMediaDownloadUrlForOwner(
    user: CurrentUserDto,
    id: string,
    key: string,
  ): Promise<{ url: string }> {
    const missingPerson = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!missingPerson) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (missingPerson.userId !== user.id) {
      this.missingPersonCommonService.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_MEDIA_DOWNLOADED,
        missingPerson,
        'not_case_owner',
        {
          outcome: AuditOutcome.DENIED,
          targetUserId: missingPerson.userId ?? undefined,
          metadata: { requestedKey: key },
        },
      );
      throw new NotFoundException('missing_person_not_found');
    }

    const owned = this.missingPersonCommonService.collectMediaFields(missingPerson).includes(key);
    if (!owned) {
      throw new NotFoundException('media_not_found_on_missing_person');
    }

    const url = await this.minioService.generatePresignedDownloadUrl(key);
    return { url };
  }

  async findMine(user: CurrentUserDto, query: ListMissingPersonsQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where = { userId: user.id };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data,
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOneMine(user: CurrentUserDto, id: string) {
    const missingPerson = await this.missingPersonCommonService.loadOwnCase(user, id);

    const [messages, pendingAppeal] = await Promise.all([
      this.prisma.missingPersonMessage.findMany({
        where: { missingPersonId: id },
        orderBy: { createdAt: 'desc' },
        take: 20,
        select: { id: true, kind: true, message: true, createdAt: true },
      }),
      this.prisma.missingPersonAppeal.findFirst({
        where: { missingPersonId: id, status: MissingPersonAppealState.PENDING },
        select: { id: true, reason: true, createdAt: true },
      }),
    ]);

    return {
      ...this.missingPersonCommonService.toOwnerView(missingPerson),
      requestedChanges:
        missingPerson.status === MissingPersonStatus.MORE_INFORMATION_REQUESTED
          ? missingPerson.reviewNote
          : null,
      messages,
      pendingAppeal,
    };
  }

  async getMySummary(user: CurrentUserDto) {
    const [grouped, openAppeals, pendingFoundReports] = await Promise.all([
      this.prisma.missingPerson.groupBy({
        by: ['status'],
        where: { userId: user.id, deletedAt: null },
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.missingPersonAppeal.count({
        where: { authorId: user.id, status: MissingPersonAppealState.PENDING },
      }),
      this.prisma.missingPerson.count({
        where: { userId: user.id, foundReportedAt: { not: null }, foundReportResolvedAt: null },
      }),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(MissingPersonStatus).map((status) => [status, 0]),
    ) as Record<MissingPersonStatus, number>;
    for (const row of grouped) {
      const c = row._count as { status?: number } | undefined;
      byStatus[row.status] = c?.status ?? 0;
    }

    const total = Object.values(byStatus).reduce((sum, n) => sum + n, 0);
    return { total, byStatus, openAppeals, pendingFoundReports };
  }

  // A case is unread when a status change or an admin message landed after the owner last opened it.
  async countMyUnreadUpdates(user: CurrentUserDto) {
    const actions = Prisma.join(FAMILY_VISIBLE_ACTIONS);
    const rows = await this.prisma.$queryRaw<{ count: number }[]>`
      SELECT COUNT(*)::int AS count
      FROM missing_person mp
      WHERE mp."userId" = ${user.id}
        AND mp."deletedAt" IS NULL
        AND (
          EXISTS (
            SELECT 1 FROM audit_log a
            WHERE a.entity = 'MissingPerson'
              AND a."entityId" = mp.id
              AND a.outcome = 'SUCCESS'
              AND a.action IN (${actions})
              AND a.diff->>'newStatus' IS NOT NULL
              AND a."userId" IS DISTINCT FROM mp."userId"
              AND a."createdAt" > COALESCE(mp."ownerLastSeenAt", mp."createdAt")
          )
          OR EXISTS (
            SELECT 1 FROM missing_person_message m
            WHERE m."missingPersonId" = mp.id
              AND m."createdAt" > COALESCE(mp."ownerLastSeenAt", mp."createdAt")
          )
        )
    `;
    return { count: rows[0]?.count ?? 0 };
  }

  async markAllMineSeen(user: CurrentUserDto) {
    const { count } = await this.prisma.missingPerson.updateMany({
      where: { userId: user.id, deletedAt: null },
      data: { ownerLastSeenAt: new Date() },
    });
    return { updated: count };
  }

  async markMineSeen(user: CurrentUserDto, id: string) {
    await this.missingPersonCommonService.loadOwnCase(user, id);
    await this.prisma.missingPerson.update({
      where: { id },
      data: { ownerLastSeenAt: new Date() },
    });
    return { id, seen: true };
  }

  // Family-facing timeline: status changes, admin messages, public updates, appeals and found reports.
  async getMyTimeline(user: CurrentUserDto, id: string) {
    const missingPerson = await this.missingPersonCommonService.loadOwnCase(user, id);

    const [auditRows, messages, updates, appeals] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          entity: 'MissingPerson',
          entityId: id,
          outcome: AuditOutcome.SUCCESS,
          action: { in: FAMILY_VISIBLE_ACTIONS },
        },
        orderBy: { createdAt: 'asc' },
        select: { action: true, createdAt: true, reason: true, diff: true, userId: true },
      }),
      this.prisma.missingPersonMessage.findMany({
        where: { missingPersonId: id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.missingPersonUpdate.findMany({
        where: { missingPersonId: id },
        orderBy: { createdAt: 'asc' },
      }),
      this.prisma.missingPersonAppeal.findMany({
        where: { missingPersonId: id },
        orderBy: { createdAt: 'asc' },
      }),
    ]);

    type TimelineEvent = { type: string; at: Date; [key: string]: unknown };
    const events: TimelineEvent[] = [];

    for (const row of auditRows) {
      const diff = (row.diff ?? {}) as Record<string, unknown>;
      if (row.action === AuditEventEnum.MISSING_PERSON_CREATED) {
        events.push({ type: 'SUBMITTED', at: row.createdAt });
        continue;
      }
      const newStatus = diff.newStatus as string | undefined;
      if (!newStatus) continue;
      // Review notes are written for the owner; takedown and delete reasons are internal.
      const showNote =
        newStatus === MissingPersonStatus.REJECTED ||
        newStatus === MissingPersonStatus.MORE_INFORMATION_REQUESTED;
      events.push({
        type: 'STATUS_CHANGED',
        at: row.createdAt,
        previousStatus: diff.previousStatus ?? null,
        status: newStatus,
        note: showNote ? row.reason : null,
      });
    }

    for (const m of messages) {
      events.push({
        type: m.kind === 'WARNING' ? 'WARNING' : 'MESSAGE',
        at: m.createdAt,
        message: m.message,
      });
    }
    for (const u of updates) {
      events.push({
        type: 'UPDATE_POSTED',
        at: u.createdAt,
        authorType: u.authorType,
        message: u.message,
      });
    }
    for (const a of appeals) {
      events.push({ type: 'APPEAL_SUBMITTED', at: a.createdAt, reason: a.reason });
      if (a.decidedAt) {
        events.push({
          type: 'APPEAL_DECIDED',
          at: a.decidedAt,
          decision: a.status,
          note: a.decisionNote,
        });
      }
    }
    if (missingPerson.foundReportedAt) {
      events.push({ type: 'FOUND_REPORTED', at: missingPerson.foundReportedAt });
    }
    if (missingPerson.foundReportResolvedAt) {
      events.push({
        type: 'FOUND_REPORT_RESOLVED',
        at: missingPerson.foundReportResolvedAt,
        confirmed: missingPerson.foundReportConfirmed,
      });
    }

    events.sort((a, b) => a.at.getTime() - b.at.getTime());
    return { missingPersonId: id, status: missingPerson.status, events };
  }

  async reportFoundByOwner(user: CurrentUserDto, id: string, data: MissingPersonFoundReportDto) {
    const existing = await this.missingPersonCommonService.loadOwnCase(user, id);

    if (existing.status !== MissingPersonStatus.APPROVED) {
      this.missingPersonCommonService.emitCaseFailure(
        user,
        AuditEventEnum.MISSING_PERSON_UPDATED,
        existing,
        'found_report_requires_approved_case',
        {
          diff: { currentStatus: existing.status },
        },
      );
      throw new BadRequestException('found_report_requires_approved_case');
    }
    if (existing.foundReportedAt && !existing.foundReportResolvedAt) {
      throw new ConflictException('found_report_already_pending');
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: {
        foundReportedAt: new Date(),
        foundReportDetails: data.details,
        foundReportDate: data.dateFound ? new Date(data.dateFound) : null,
        foundReportLocation: data.foundLocation ?? null,
        foundReportResolvedAt: null,
        foundReportConfirmed: null,
      },
    });

    this.missingPersonCommonService.auditOp(user, updated, 'owner_found_report', {
      previousStatus: existing.status,
    });
    return this.missingPersonCommonService.toOwnerView(updated);
  }

  // Counts and dates only. No informant identity, no tip text.
  async getMyTipsSummary(user: CurrentUserDto, id: string) {
    await this.missingPersonCommonService.loadOwnCase(user, id);

    const tips = await this.prisma.informationSubmission.findMany({
      where: { missingPersonId: id },
      select: { status: true, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const byStatus: Record<string, number> = {};
    const byDay: Record<string, number> = {};
    for (const tip of tips) {
      byStatus[tip.status] = (byStatus[tip.status] ?? 0) + 1;
      const day = tip.createdAt.toISOString().slice(0, 10);
      byDay[day] = (byDay[day] ?? 0) + 1;
    }

    return {
      total: tips.length,
      byStatus,
      firstReceivedAt: tips[0]?.createdAt ?? null,
      lastReceivedAt: tips[tips.length - 1]?.createdAt ?? null,
      perDay: Object.entries(byDay).map(([date, count]) => ({ date, count })),
    };
  }

  async appealRejection(user: CurrentUserDto, id: string, data: AppealMissingPersonRejectionDto) {
    const existing = await this.missingPersonCommonService.loadOwnCase(user, id);

    if (existing.status !== MissingPersonStatus.REJECTED) {
      throw new BadRequestException('only_rejected_cases_can_be_appealed');
    }

    const blocking = await this.prisma.missingPersonAppeal.findFirst({
      where: {
        missingPersonId: id,
        status: { in: [MissingPersonAppealState.PENDING, MissingPersonAppealState.DECLINED] },
      },
      select: { status: true },
    });
    if (blocking) {
      throw new ConflictException(
        blocking.status === MissingPersonAppealState.PENDING
          ? 'appeal_already_pending'
          : 'appeal_already_declined',
      );
    }

    const appeal = await this.prisma.missingPersonAppeal.create({
      data: { missingPersonId: id, authorId: user.id, reason: data.reason },
    });

    this.missingPersonCommonService.auditOp(user, existing, 'appeal_submitted', {
      appealId: appeal.id,
    });
    return appeal;
  }
}
