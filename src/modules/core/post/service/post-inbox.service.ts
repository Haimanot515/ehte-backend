import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { UnreadPostsQueryDto } from '../dto/post.dto';
import { PostCommonService } from './post-common.service';

@Injectable()
export class PostInboxService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postCommonService: PostCommonService,
  ) {}

  // ── Admin read state ──────────────────────────

  // PATCH /posts/:id/read
  async markRead(admin: CurrentUserDto, postId: string) {
    await this.postCommonService.findOne(postId);

    await this.prisma.postReadState.upsert({
      where: { postId_adminId: { postId, adminId: admin.id } },
      create: { postId, adminId: admin.id },
      update: {},
    });

    return { postId, read: true };
  }

  // PATCH /posts/:id/unread
  async markUnread(admin: CurrentUserDto, postId: string) {
    await this.postCommonService.findOne(postId);

    await this.prisma.postReadState.deleteMany({ where: { postId, adminId: admin.id } });

    return { postId, read: false };
  }

  // PATCH /posts/bulk/read
  async bulkMarkRead(admin: CurrentUserDto, ids: string[]) {
    const uniqueIds = [...new Set(ids)];
    const existing = await this.prisma.post.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true },
    });
    const existingIds = existing.map((p) => p.id);

    await this.prisma.postReadState.createMany({
      data: existingIds.map((postId) => ({ postId, adminId: admin.id })),
      skipDuplicates: true,
    });

    const found = new Set(existingIds);
    return { marked: existingIds.length, notFound: uniqueIds.filter((id) => !found.has(id)) };
  }

  // PATCH /posts/read-all
  async markAllRead(admin: CurrentUserDto) {
    const unread = await this.prisma.post.findMany({
      where: { readStates: { none: { adminId: admin.id } } },
      select: { id: true },
    });

    await this.prisma.postReadState.createMany({
      data: unread.map((p) => ({ postId: p.id, adminId: admin.id })),
      skipDuplicates: true,
    });

    return { marked: unread.length };
  }

  // GET /posts/unread-count
  async getUnreadCount(admin: CurrentUserDto) {
    const [total, read] = await this.prisma.$transaction([
      this.prisma.post.count(),
      this.prisma.postReadState.count({ where: { adminId: admin.id } }),
    ]);

    return { total, read, unread: Math.max(0, total - read) };
  }

  // GET /posts/unread
  async findUnread(admin: CurrentUserDto, query: UnreadPostsQueryDto) {
    const { page, limit, skip, take } = this.postCommonService.pageArgs(query);

    const where: Prisma.PostWhereInput = {
      readStates: { none: { adminId: admin.id } },
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({ where, orderBy: { createdAt: 'desc' }, skip, take }),
      this.prisma.post.count({ where }),
    ]);

    return { items, ...this.postCommonService.pageMeta(total, page, limit) };
  }
}
