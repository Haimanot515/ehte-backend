import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import {
  BulkSupportIdsDto,
  ListUnreadSupportQueryDto,
  ReadAllSupportDto,
} from '../dto/support.dto';
import {
  MARK_ALL_READ_BATCH,
  MARK_ALL_READ_MAX_BATCHES,
  adminListSelect,
} from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  // ═════════════════════ admin: read state and counts (SP-20 .. SP-27) ═════════════════════

  // SP-20
  async markRead(id: string, admin: CurrentUserDto) {
    await this.supportCommonService.findSupportOrThrow(id);
    await this.prisma.supportAdminRead.upsert({
      where: { supportId_adminId: { supportId: id, adminId: admin.id } },
      create: { supportId: id, adminId: admin.id },
      update: {},
    });
    return { id, read: true };
  }

  // SP-21
  async markUnread(id: string, admin: CurrentUserDto) {
    await this.supportCommonService.findSupportOrThrow(id);
    await this.prisma.supportAdminRead.deleteMany({ where: { supportId: id, adminId: admin.id } });
    return { id, read: false };
  }

  // SP-22
  async bulkMarkRead(admin: CurrentUserDto, data: BulkSupportIdsDto) {
    const ids = [...new Set(data.ids)];
    const found = await this.prisma.support.findMany({
      where: { id: { in: ids } },
      select: { id: true },
    });
    const { count } = await this.prisma.supportAdminRead.createMany({
      data: found.map((s) => ({ supportId: s.id, adminId: admin.id })),
      skipDuplicates: true,
    });
    return { requested: ids.length, matched: found.length, marked: count };
  }

  // SP-23
  async bulkMarkUnread(admin: CurrentUserDto, data: BulkSupportIdsDto) {
    const ids = [...new Set(data.ids)];
    const { count } = await this.prisma.supportAdminRead.deleteMany({
      where: { adminId: admin.id, supportId: { in: ids } },
    });
    return { requested: ids.length, marked: count };
  }

  // SP-24. Capped per call so one request cannot lock a huge table; call again if `more` is true.
  async markAllRead(admin: CurrentUserDto, data: ReadAllSupportDto) {
    const where: Prisma.SupportWhereInput = {
      ...(data.status ? { status: data.status } : {}),
      ...(data.type ? { type: data.type } : {}),
      adminReads: { none: { adminId: admin.id } },
    };

    let marked = 0;
    let more = false;
    for (let i = 0; i < MARK_ALL_READ_MAX_BATCHES; i++) {
      const batch = await this.prisma.support.findMany({
        where,
        select: { id: true },
        take: MARK_ALL_READ_BATCH,
      });
      if (batch.length === 0) break;
      const { count } = await this.prisma.supportAdminRead.createMany({
        data: batch.map((s) => ({ supportId: s.id, adminId: admin.id })),
        skipDuplicates: true,
      });
      marked += count;
      if (batch.length < MARK_ALL_READ_BATCH) break;
      if (i === MARK_ALL_READ_MAX_BATCHES - 1) more = true;
    }
    return { marked, more };
  }

  // SP-25
  async findUnread(admin: CurrentUserDto, query: ListUnreadSupportQueryDto) {
    const { page, limit, skip, take } = this.supportCommonService.paging(query);
    const where: Prisma.SupportWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
      adminReads: { none: { adminId: admin.id } },
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.support.count({ where }),
      this.prisma.support.findMany({
        where,
        select: adminListSelect(admin.id),
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items: rows.map((r) => this.supportCommonService.mapAdminRow(r)) };
  }

  // SP-26
  async countUnread(admin: CurrentUserDto) {
    const count = await this.prisma.support.count({
      where: { adminReads: { none: { adminId: admin.id } } },
    });
    return { count };
  }

  // SP-27
  async getReadCounts(admin: CurrentUserDto) {
    const [total, read] = await Promise.all([
      this.prisma.support.count(),
      this.prisma.support.count({ where: { adminReads: { some: { adminId: admin.id } } } }),
    ]);
    return { total, read, unread: total - read };
  }
}
