import { Injectable } from '@nestjs/common';
import { PostStatus, PostType, Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import {
  AdminPostQueryDto,
  PostAuthorRollupQueryDto,
  PostsByAuthorQueryDto,
} from '../dto/post.dto';
import { PostCommonService } from './post-common.service';

@Injectable()
export class PostAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly postCommonService: PostCommonService,
  ) {}

  async findAll(query: AdminPostQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const postType: PostType | undefined = query.type;

    const where: Prisma.PostWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(postType ? { type: postType } : {}),
      ...(query.involvesChild !== undefined ? { involvesChild: query.involvesChild } : {}),
      ...(query.authorId ? { userId: query.authorId } : {}),
    };

    const [items, total] = await this.prisma.$transaction([
      this.prisma.post.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.post.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };
  }

  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('POST_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    const posts = await this.prisma.post.findMany({
      where: { status: PostStatus.PENDING, createdAt: { lt: cutoff } },
      orderBy: { createdAt: 'asc' },
    });

    return posts.map((post) => ({
      ...post,
      pendingHours: Math.floor((Date.now() - post.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  async getHistory(postId: string) {
    await this.postCommonService.findOne(postId);

    return this.prisma.auditLog.findMany({
      where: { entity: 'Post', entityId: postId },
      orderBy: { createdAt: 'asc' },
    });
  }

  // ── Admin per-author views ────────────────────

  // GET /posts/by-author
  async findAuthorRollup(query: PostAuthorRollupQueryDto) {
    const { page, limit, skip } = this.postCommonService.pageArgs(query);

    const rows = await this.prisma.post.groupBy({
      by: ['userId', 'status'],
      _count: { _all: true },
      _max: { createdAt: true },
      orderBy: [{ userId: 'asc' }, { status: 'asc' }],
    });

    const authors = new Map<
      string,
      {
        userId: string;
        totalPosts: number;
        pending: number;
        lastPostAt: Date | null;
        byStatus: Record<string, number>;
      }
    >();

    for (const row of rows) {
      const count = (row._count as { _all?: number } | undefined)?._all ?? 0;
      const last = row._max?.createdAt ?? null;
      const entry = authors.get(row.userId) ?? {
        userId: row.userId,
        totalPosts: 0,
        pending: 0,
        lastPostAt: null,
        byStatus: {},
      };
      entry.totalPosts += count;
      entry.byStatus[row.status] = count;
      if (row.status === PostStatus.PENDING) entry.pending = count;
      if (last && (!entry.lastPostAt || last > entry.lastPostAt)) entry.lastPostAt = last;
      authors.set(row.userId, entry);
    }

    const sortBy = query.sortBy ?? 'lastPostAt';
    const dir = (query.order ?? 'desc') === 'asc' ? 1 : -1;
    const sortValue = (a: { totalPosts: number; pending: number; lastPostAt: Date | null }) =>
      sortBy === 'lastPostAt' ? (a.lastPostAt?.getTime() ?? 0) : a[sortBy];

    const sorted = [...authors.values()].sort((a, b) => (sortValue(a) - sortValue(b)) * dir);

    return {
      items: sorted.slice(skip, skip + limit),
      ...this.postCommonService.pageMeta(sorted.length, page, limit),
    };
  }

  // GET /posts/by-author/:authorId
  async findPostsByAuthor(authorId: string, query: PostsByAuthorQueryDto) {
    const { page, limit, skip, take } = this.postCommonService.pageArgs(query);

    const where: Prisma.PostWhereInput = {
      userId: authorId,
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
