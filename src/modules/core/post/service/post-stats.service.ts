import { BadRequestException, Injectable } from '@nestjs/common';
import { PostStatus, PostType } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { PostTimelineQueryDto } from '../dto/post.dto';
import { FLAG_OPEN, APPEAL_OPEN } from './post.constants';

@Injectable()
export class PostStatsService {
  constructor(
    private readonly prisma: PrismaService,
  ) {}

  async getStats() {
    const [total, byStatus, byType] = await this.prisma.$transaction([
      this.prisma.post.count(),
      this.prisma.post.groupBy({
        by: ['status'],
        _count: { status: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.post.groupBy({
        by: ['type'],
        _count: { type: true },
        orderBy: { type: 'asc' },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(PostStatus).map((status) => [status, 0]),
    ) as Record<PostStatus, number>;

    for (const row of byStatus) {
      const rowCount = row._count as { status?: number } | undefined;
      statusCounts[row.status] = rowCount?.status ?? 0;
    }

    const typeCounts = Object.fromEntries(
      Object.values(PostType).map((type) => [type, 0]),
    ) as Record<PostType, number>;

    for (const row of byType) {
      const rowCount = row._count as { type?: number } | undefined;
      typeCounts[row.type] = rowCount?.type ?? 0;
    }

    return {
      total,
      draft: statusCounts[PostStatus.DRAFT] ?? 0,
      pending: statusCounts[PostStatus.PENDING] ?? 0,
      changesRequested: statusCounts[PostStatus.CHANGES_REQUESTED] ?? 0,
      approved: statusCounts[PostStatus.APPROVED] ?? 0,
      published: statusCounts[PostStatus.PUBLISHED] ?? 0,
      unpublished: statusCounts[PostStatus.UNPUBLISHED] ?? 0,
      rejected: statusCounts[PostStatus.REJECTED] ?? 0,
      byType: typeCounts,
    };
  }

  // ── Statistics ────────────────────────────────

  // Start of the day, ISO week (Monday) or month in UTC, as a stable bucket key.
  private bucketKey(date: Date, bucket: 'day' | 'week' | 'month'): string {
    const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
    if (bucket === 'month') d.setUTCDate(1);
    if (bucket === 'week') d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }

  // GET /posts/stats/timeline
  async getStatsTimeline(query: PostTimelineQueryDto) {
    const from = new Date(query.from);
    const to = new Date(query.to);
    if (from >= to) {
      throw new BadRequestException('timeline_from_must_be_before_to');
    }
    const bucket = query.bucket ?? 'day';

    const posts = await this.prisma.post.findMany({
      where: {
        createdAt: { gte: from, lt: to },
        ...(query.status ? { status: query.status } : {}),
        ...(query.type ? { type: query.type } : {}),
        ...(query.authorId ? { userId: query.authorId } : {}),
      },
      select: { createdAt: true },
    });

    const counts = new Map<string, number>();
    for (const post of posts) {
      const key = this.bucketKey(post.createdAt, bucket);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }

    const points = [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, count]) => ({ date, count }));

    return { from: query.from, to: query.to, bucket, total: posts.length, points };
  }

  // GET /posts/stats/moderation
  async getModerationStats() {
    const [openFlags, flaggedPosts, openAppeals, upheld, overturned, takedowns, decided] =
      await this.prisma.$transaction([
        this.prisma.postFlag.count({ where: { status: FLAG_OPEN } }),
        this.prisma.postFlag.groupBy({
          by: ['postId'],
          where: { status: FLAG_OPEN },
          orderBy: { postId: 'asc' },
        }),
        this.prisma.postAppeal.count({ where: { status: APPEAL_OPEN } }),
        this.prisma.postAppeal.count({ where: { status: 'UPHELD' } }),
        this.prisma.postAppeal.count({ where: { status: 'OVERTURNED' } }),
        this.prisma.post.count({ where: { takedownAt: { not: null } } }),
        this.prisma.postAppeal.findMany({
          where: { decidedAt: { not: null } },
          orderBy: { decidedAt: 'desc' },
          take: 500,
          select: { createdAt: true, decidedAt: true },
        }),
      ]);

    const totalHours = decided.reduce(
      (sum, a) => sum + ((a.decidedAt?.getTime() ?? a.createdAt.getTime()) - a.createdAt.getTime()),
      0,
    );
    const avgAppealTurnaroundHours = decided.length
      ? Math.round((totalHours / decided.length / 3_600_000) * 10) / 10
      : null;

    return {
      openFlags,
      flaggedPostsWithOpenFlags: flaggedPosts.length,
      openAppeals,
      appealsUpheld: upheld,
      appealsOverturned: overturned,
      takedowns,
      avgAppealTurnaroundHours,
    };
  }
}
