import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { PostAppealTarget, PostStatus, Prisma } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AppealPostDto } from '../dto/post.dto';
import { PostCommonService } from './post-common.service';
import { APPEAL_OPEN, SUMMARY_STATUSES, AUTHOR_VISIBLE_REASON_STATUSES } from './post.constants';

@Injectable()
export class PostMineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly postCommonService: PostCommonService,
  ) {}

  async findMyPosts(userId: string) {
    return this.prisma.post.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findMyPost(userId: string, postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, userId },
    });

    if (!post) {
      throw new NotFoundException('post_not_found');
    }

    return post;
  }

  // ── Owner routes ──────────────────────────────

  // GET /posts/me/summary
  async getMyPostSummary(userId: string) {
    const rows = await this.prisma.post.groupBy({
      by: ['status'],
      where: { userId },
      _count: { status: true },
      orderBy: { status: 'asc' },
    });

    const counts = Object.fromEntries(SUMMARY_STATUSES.map((s) => [s, 0])) as Record<
      PostStatus,
      number
    >;
    for (const row of rows) {
      const rowCount = row._count as { status?: number } | undefined;
      counts[row.status] = rowCount?.status ?? 0;
    }

    return {
      total: Object.values(counts).reduce((sum, n) => sum + n, 0),
      draft: counts[PostStatus.DRAFT],
      pending: counts[PostStatus.PENDING],
      changesRequested: counts[PostStatus.CHANGES_REQUESTED],
      approved: counts[PostStatus.APPROVED],
      published: counts[PostStatus.PUBLISHED],
      unpublished: counts[PostStatus.UNPUBLISHED],
      rejected: counts[PostStatus.REJECTED],
    };
  }

  // GET /posts/me/:id/history (status changes only, no admin identities or internal notes)
  async getMyPostHistory(userId: string, postId: string) {
    await this.findMyPost(userId, postId);

    const rows = await this.prisma.auditLog.findMany({
      where: { entity: 'Post', entityId: postId },
      orderBy: { createdAt: 'asc' },
    });

    return rows.flatMap((row) => {
      const diff = row.diff as Prisma.JsonObject | null;
      const to = typeof diff?.newStatus === 'string' ? diff.newStatus : null;
      if (!to || diff?.result !== 'success') return [];

      const showReason = diff?.takedown === true || AUTHOR_VISIBLE_REASON_STATUSES.includes(to);
      return [
        {
          at: row.createdAt,
          from: typeof diff?.previousStatus === 'string' ? diff.previousStatus : null,
          to,
          reason: showReason ? (row.reason ?? null) : null,
        },
      ];
    });
  }

  // POST /posts/me/:id/appeal
  async appealMyPost(userId: string, postId: string, data: AppealPostDto) {
    const post = await this.findMyPost(userId, postId);

    const wasTakenDown = post.status === PostStatus.UNPUBLISHED && post.takedownAt !== null;
    if (post.status !== PostStatus.REJECTED && !wasTakenDown) {
      throw new BadRequestException('post_not_appealable');
    }

    const open = await this.prisma.postAppeal.findFirst({
      where: { postId, status: APPEAL_OPEN },
      select: { id: true },
    });
    if (open) {
      throw new BadRequestException('appeal_already_open');
    }

    const target = wasTakenDown ? PostAppealTarget.TAKEDOWN : PostAppealTarget.REJECTION;

    const appeal = await this.prisma.postAppeal.create({
      data: { postId, authorId: userId, target, message: data.message },
    });

    this.postCommonService.emitAudit({
      userId,
      actorType: 'USER',
      action: AuditEventEnum.POST_APPEAL_SUBMITTED,
      entity: 'Post',
      entityId: postId,
      entityLabel: this.postCommonService.postLabel(post),
      reason: 'post_appeal_submitted',
      diff: { appealId: appeal.id, result: 'appeal_open' },
      metadata: { postType: post.type, appealTarget: target },
    });

    return appeal;
  }

  // GET /posts/me/:id/appeals
  async findMyPostAppeals(userId: string, postId: string) {
    await this.findMyPost(userId, postId);

    return this.prisma.postAppeal.findMany({
      where: { postId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        target: true,
        message: true,
        status: true,
        decisionNote: true,
        decidedAt: true,
        createdAt: true,
      },
    });
  }
}
