import { Injectable } from '@nestjs/common';
import { InformationStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import {
  ListInformationSubmissionsQueryDto,
  MarkAllInformationReadDto,
} from '../dto/information-submission.dto';
import { InformationSubmissionCommonService } from './information-submission-common.service';

@Injectable()
export class InformationSubmissionInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly informationSubmissionCommonService: InformationSubmissionCommonService,
  ) {}

  private unreadWhere(
    adminId: string,
    extra: Prisma.InformationSubmissionWhereInput = {},
  ): Prisma.InformationSubmissionWhereInput {
    return { deletedAt: null, adminReads: { none: { adminId } }, ...extra };
  }

  async markRead(admin: CurrentUserDto, id: string) {
    await this.informationSubmissionCommonService.findLiveOrThrow(id);

    await this.prisma.informationAdminRead.upsert({
      where: { submissionId_adminId: { submissionId: id, adminId: admin.id } },
      create: { submissionId: id, adminId: admin.id },
      update: { readAt: new Date() },
    });
    await this.prisma.informationAccessLog.create({
      data: { submissionId: id, adminId: admin.id, action: 'READ' },
    });

    return { id, isRead: true };
  }

  async markUnread(admin: CurrentUserDto, id: string) {
    await this.informationSubmissionCommonService.findLiveOrThrow(id);

    await this.prisma.informationAdminRead.deleteMany({
      where: { submissionId: id, adminId: admin.id },
    });
    return { id, isRead: false };
  }

  async bulkMarkRead(admin: CurrentUserDto, ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await this.prisma.informationSubmission.findMany({
      where: { id: { in: unique }, deletedAt: null },
      select: { id: true },
    });

    await this.prisma.informationAdminRead.createMany({
      data: found.map((f) => ({ submissionId: f.id, adminId: admin.id })),
      skipDuplicates: true,
    });

    const foundIds = new Set(found.map((f) => f.id));
    return {
      requested: unique.length,
      updated: found.length,
      notFound: unique.filter((i) => !foundIds.has(i)),
    };
  }

  async bulkMarkUnread(admin: CurrentUserDto, ids: string[]) {
    const unique = [...new Set(ids)];
    const result = await this.prisma.informationAdminRead.deleteMany({
      where: { adminId: admin.id, submissionId: { in: unique } },
    });
    return { requested: unique.length, updated: result.count };
  }

  // Marks every unread tip matching the filter as read, in one statement.
  async markAllRead(admin: CurrentUserDto, data: MarkAllInformationReadDto) {
    const statusSql = data.status
      ? Prisma.sql`AND s.status = ${data.status}::"InformationStatus"`
      : Prisma.empty;
    const caseSql = data.missingPersonId
      ? Prisma.sql`AND s."missingPersonId" = ${data.missingPersonId}`
      : Prisma.empty;

    const marked = await this.prisma.$executeRaw(Prisma.sql`
      INSERT INTO information_admin_read ("submissionId", "adminId", "readAt")
      SELECT s.id, ${admin.id}, NOW()
      FROM information_submission s
      WHERE s."deletedAt" IS NULL
        ${statusSql}
        ${caseSql}
        AND NOT EXISTS (
          SELECT 1 FROM information_admin_read r
          WHERE r."submissionId" = s.id AND r."adminId" = ${admin.id}
        )
      ON CONFLICT DO NOTHING
    `);

    return { marked };
  }

  async markCaseRead(admin: CurrentUserDto, missingPersonId: string) {
    return this.markAllRead(admin, { missingPersonId });
  }

  async markCaseUnread(admin: CurrentUserDto, missingPersonId: string) {
    const result = await this.prisma.informationAdminRead.deleteMany({
      where: { adminId: admin.id, submission: { missingPersonId } },
    });
    return { updated: result.count };
  }

  // Unread queue: urgent first, then oldest first.
  async findUnread(admin: CurrentUserDto, query: ListInformationSubmissionsQueryDto) {
    const { page, limit, skip } = this.informationSubmissionCommonService.pageArgs(query);
    const where = this.unreadWhere(admin.id, query.status ? { status: query.status } : {});

    const [data, total] = await this.prisma.$transaction([
      this.prisma.informationSubmission.findMany({
        where,
        include: {
          missingPerson: { select: { id: true, name: true, personType: true } },
          assignedTo: { select: { id: true, name: true } },
        },
        orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
        skip,
        take: limit,
      }),
      this.prisma.informationSubmission.count({ where }),
    ]);

    return { data, meta: this.informationSubmissionCommonService.pageMeta(page, limit, total) };
  }

  async countUnread(admin: CurrentUserDto) {
    const count = await this.prisma.informationSubmission.count({
      where: this.unreadWhere(admin.id),
    });
    return { count };
  }

  async countUnreadByStatus(admin: CurrentUserDto) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['status'],
      where: this.unreadWhere(admin.id),
      _count: { _all: true },
    });

    const counts = Object.fromEntries(
      Object.values(InformationStatus).map((s) => [s, 0]),
    ) as Record<InformationStatus, number>;
    for (const row of rows) counts[row.status] = row._count._all;

    return { total: Object.values(counts).reduce((a, b) => a + b, 0), byStatus: counts };
  }

  async countUnreadByCase(admin: CurrentUserDto) {
    const rows = await this.prisma.informationSubmission.groupBy({
      by: ['missingPersonId'],
      where: this.unreadWhere(admin.id),
      _count: { _all: true },
      orderBy: { _count: { missingPersonId: 'desc' } },
      take: 200,
    });

    const cases = await this.informationSubmissionCommonService.caseNameMap(rows.map((r) => r.missingPersonId));

    return rows.map((r) => ({
      missingPersonId: r.missingPersonId,
      name: cases.get(r.missingPersonId)?.name ?? null,
      unread: r._count._all,
    }));
  }

  async getReadCounts(admin: CurrentUserDto) {
    const [total, unread] = await Promise.all([
      this.prisma.informationSubmission.count({ where: { deletedAt: null } }),
      this.prisma.informationSubmission.count({ where: this.unreadWhere(admin.id) }),
    ]);
    return { total, read: total - unread, unread };
  }

  async recordAdminView(admin: CurrentUserDto, id: string): Promise<void> {
    await this.prisma.informationAccessLog.create({
      data: { submissionId: id, adminId: admin.id, action: 'VIEWED' },
    });
  }
}
