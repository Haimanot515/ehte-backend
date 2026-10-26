import { Injectable } from '@nestjs/common';
import { MissingPersonStatus, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import {
  ListMissingPersonsAdminQueryDto,
  MarkAllMissingPersonsReadDto,
  PaginationQueryDto,
} from '../dto/missing-person.dto';
import { ADMIN_BASE_WHERE } from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

    async markRead(admin: CurrentUserDto, id: string) {
    await this.missingPersonCommonService.loadCase(id);
    await this.prisma.missingPersonReadState.upsert({
      where: { missingPersonId_adminId: { missingPersonId: id, adminId: admin.id } },
      create: { missingPersonId: id, adminId: admin.id },
      update: {},
    });
    return { id, isRead: true };
  }

  async markUnread(admin: CurrentUserDto, id: string) {
    await this.missingPersonCommonService.loadCase(id);
    await this.prisma.missingPersonReadState.deleteMany({
      where: { missingPersonId: id, adminId: admin.id },
    });
    return { id, isRead: false };
  }

  async bulkMarkRead(admin: CurrentUserDto, ids: string[]) {
    const unique = [...new Set(ids)];
    const found = await this.prisma.missingPerson.findMany({
      where: { id: { in: unique } },
      select: { id: true },
    });
    const { count } = await this.prisma.missingPersonReadState.createMany({
      data: found.map((c) => ({ missingPersonId: c.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    const foundIds = new Set(found.map((c) => c.id));
    return { updated: count, notFound: unique.filter((id) => !foundIds.has(id)) };
  }

  async bulkMarkUnread(admin: CurrentUserDto, ids: string[]) {
    const { count } = await this.prisma.missingPersonReadState.deleteMany({
      where: { adminId: admin.id, missingPersonId: { in: [...new Set(ids)] } },
    });
    return { updated: count };
  }

  async markAllRead(admin: CurrentUserDto, data: MarkAllMissingPersonsReadDto) {
    const where: Prisma.MissingPersonWhereInput = {
      ...ADMIN_BASE_WHERE,
      readStates: { none: { adminId: admin.id } },
      ...(data.status !== undefined ? { status: data.status } : {}),
      ...(data.personType !== undefined ? { personType: data.personType } : {}),
      ...(data.area ? { lastKnownArea: { contains: data.area, mode: 'insensitive' } } : {}),
    };

    const cases = await this.prisma.missingPerson.findMany({
      where,
      select: { id: true },
      take: 5000,
    });
    const { count } = await this.prisma.missingPersonReadState.createMany({
      data: cases.map((c) => ({ missingPersonId: c.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    return { updated: count };
  }

  async findUnread(admin: CurrentUserDto, query: ListMissingPersonsAdminQueryDto) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const where: Prisma.MissingPersonWhereInput = {
      ...ADMIN_BASE_WHERE,
      readStates: { none: { adminId: admin.id } },
      ...(query.status !== undefined ? { status: query.status } : {}),
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data: data.map((item) => ({ ...item, isRead: false })),
      meta: this.missingPersonCommonService.pageMeta(page, limit, total),
    };
  }

  async countUnread(admin: CurrentUserDto) {
    const count = await this.prisma.missingPerson.count({
      where: { ...ADMIN_BASE_WHERE, readStates: { none: { adminId: admin.id } } },
    });
    return { count };
  }

  async countUnreadByStatus(admin: CurrentUserDto) {
    const rows = await this.prisma.$queryRaw<{ status: string; count: number }[]>`
      SELECT mp.status::text AS status, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE mp."deletedAt" IS NULL AND mp."mergedIntoId" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM missing_person_read_state rs
          WHERE rs."missingPersonId" = mp.id AND rs."adminId" = ${admin.id}
        )
      GROUP BY 1
    `;
    const byStatus = Object.fromEntries(
      Object.values(MissingPersonStatus).map((s) => [s, 0]),
    ) as Record<string, number>;
    for (const row of rows) byStatus[row.status] = row.count;
    return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), byStatus };
  }

  async countUnreadByArea(admin: CurrentUserDto) {
    const rows = await this.prisma.$queryRaw<{ area: string; count: number }[]>`
      SELECT mp."lastKnownArea" AS area, COUNT(*)::int AS count
      FROM missing_person mp
      WHERE mp."deletedAt" IS NULL AND mp."mergedIntoId" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM missing_person_read_state rs
          WHERE rs."missingPersonId" = mp.id AND rs."adminId" = ${admin.id}
        )
      GROUP BY 1
      ORDER BY count DESC, area ASC
      LIMIT 100
    `;
    return { data: rows };
  }

  async getReadCounts(admin: CurrentUserDto) {
    const [total, read] = await Promise.all([
      this.prisma.missingPerson.count({ where: ADMIN_BASE_WHERE }),
      this.prisma.missingPerson.count({
        where: { ...ADMIN_BASE_WHERE, readStates: { some: { adminId: admin.id } } },
      }),
    ]);
    return { total, read, unread: total - read };
  }

    async listByOwner(admin: CurrentUserDto, query: PaginationQueryDto) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);

    const rows = await this.prisma.$queryRaw<
      {
        ownerId: string;
        total: number;
        read: number;
        unread: number;
        pending: number;
        owners: number;
      }[]
    >`
      SELECT mp."userId" AS "ownerId",
             COUNT(*)::int AS total,
             COUNT(*) FILTER (WHERE rs."missingPersonId" IS NOT NULL)::int AS read,
             COUNT(*) FILTER (WHERE rs."missingPersonId" IS NULL)::int AS unread,
             COUNT(*) FILTER (WHERE mp.status = 'PENDING')::int AS pending,
             COUNT(*) OVER()::int AS owners
      FROM missing_person mp
      LEFT JOIN missing_person_read_state rs
        ON rs."missingPersonId" = mp.id AND rs."adminId" = ${admin.id}
      WHERE mp."deletedAt" IS NULL AND mp."mergedIntoId" IS NULL AND mp."userId" IS NOT NULL
      GROUP BY mp."userId"
      ORDER BY unread DESC, total DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.ownerId) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));
    const total = rows[0]?.owners ?? 0;

    return {
      data: rows.map(({ owners: _owners, ...r }) => ({
        ...r,
        ownerName: nameOf.get(r.ownerId) ?? null,
      })),
      meta: this.missingPersonCommonService.pageMeta(page, limit, total),
    };
  }

  async listRepeatRejections(query: PaginationQueryDto) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const threshold = Number(
      this.configService.get<string>('MISSING_PERSON_REPEAT_REJECTION_COUNT') ?? 2,
    );

    const rows = await this.prisma.$queryRaw<
      { ownerId: string; rejected: number; falseFlags: number; owners: number }[]
    >`
      WITH r AS (
        SELECT "userId", COUNT(*)::int AS rejected
        FROM missing_person
        WHERE status = 'REJECTED' AND "userId" IS NOT NULL
        GROUP BY "userId"
      ), f AS (
        SELECT mp."userId", COUNT(*)::int AS false_flags
        FROM missing_person_flag fl
        JOIN missing_person mp ON mp.id = fl."missingPersonId"
        WHERE fl.reason = 'FALSE_LISTING' AND mp."userId" IS NOT NULL
        GROUP BY mp."userId"
      )
      SELECT COALESCE(r."userId", f."userId") AS "ownerId",
             COALESCE(r.rejected, 0)::int AS rejected,
             COALESCE(f.false_flags, 0)::int AS "falseFlags",
             COUNT(*) OVER()::int AS owners
      FROM r FULL JOIN f ON f."userId" = r."userId"
      WHERE COALESCE(r.rejected, 0) >= ${threshold} OR COALESCE(f.false_flags, 0) >= ${threshold}
      ORDER BY rejected DESC, "falseFlags" DESC
      LIMIT ${limit} OFFSET ${skip}
    `;

    const users = await this.prisma.user.findMany({
      where: { id: { in: rows.map((r) => r.ownerId) } },
      select: { id: true, name: true },
    });
    const nameOf = new Map(users.map((u) => [u.id, u.name]));

    return {
      data: rows.map(({ owners: _owners, ...r }) => ({
        ...r,
        ownerName: nameOf.get(r.ownerId) ?? null,
      })),
      meta: this.missingPersonCommonService.pageMeta(page, limit, rows[0]?.owners ?? 0),
    };
  }

  async findByOwner(
    admin: CurrentUserDto,
    ownerId: string,
    query: ListMissingPersonsAdminQueryDto,
  ) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const where: Prisma.MissingPersonWhereInput = {
      ...ADMIN_BASE_WHERE,
      userId: ownerId,
      ...(query.status !== undefined ? { status: query.status } : {}),
      ...(query.isRead === true ? { readStates: { some: { adminId: admin.id } } } : {}),
      ...(query.isRead === false ? { readStates: { none: { adminId: admin.id } } } : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: { readStates: { where: { adminId: admin.id }, select: { adminId: true } } },
      }),
      this.prisma.missingPerson.count({ where }),
    ]);

    return {
      data: rows.map(({ readStates, ...item }) => ({ ...item, isRead: readStates.length > 0 })),
      meta: this.missingPersonCommonService.pageMeta(page, limit, total),
    };
  }

  async getOwnerSummary(admin: CurrentUserDto, ownerId: string) {
    const base: Prisma.MissingPersonWhereInput = { ...ADMIN_BASE_WHERE, userId: ownerId };
    const [grouped, total, read] = await Promise.all([
      this.prisma.missingPerson.groupBy({
        by: ['status'],
        where: base,
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.missingPerson.count({ where: base }),
      this.prisma.missingPerson.count({
        where: { ...base, readStates: { some: { adminId: admin.id } } },
      }),
    ]);

    const byStatus = Object.fromEntries(
      Object.values(MissingPersonStatus).map((s) => [s, 0]),
    ) as Record<MissingPersonStatus, number>;
    for (const row of grouped) {
      const c = row._count as { status?: number } | undefined;
      byStatus[row.status] = c?.status ?? 0;
    }
    return { ownerId, total, read, unread: total - read, byStatus };
  }

  async markOwnerRead(admin: CurrentUserDto, ownerId: string) {
    const cases = await this.prisma.missingPerson.findMany({
      where: { ...ADMIN_BASE_WHERE, userId: ownerId },
      select: { id: true },
    });
    const { count } = await this.prisma.missingPersonReadState.createMany({
      data: cases.map((c) => ({ missingPersonId: c.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    return { updated: count };
  }

  async markOwnerUnread(admin: CurrentUserDto, ownerId: string) {
    const { count } = await this.prisma.missingPersonReadState.deleteMany({
      where: { adminId: admin.id, missingPerson: { userId: ownerId } },
    });
    return { updated: count };
  }
}
