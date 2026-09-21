import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PostStatus } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { MinioService } from 'src/services/minio/minio.service';

// Handles #2 (stale DRAFT purge) and #12 (old REJECTED purge); thresholds fall back from POST_*-specific to shared CONTENT_* env vars.

const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;

@Injectable()
export class PostRetentionService {
  private readonly logger = new Logger(PostRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredPosts(): Promise<void> {
    await this.purgeStaleDrafts();
    await this.purgeOldRejected();
  }

  private async purgeStaleDrafts(): Promise<void> {
    const ttlDays = Number(
      this.configService.get<string>('POST_DRAFT_TTL_DAYS') ??
        this.configService.get<string>('CONTENT_DRAFT_TTL_DAYS') ??
        30,
    );
    const cutoff = new Date(Date.now() - ttlDays * 24 * 60 * 60 * 1000);

    const stale = await this.prisma.post.findMany({
      where: { status: PostStatus.DRAFT, updatedAt: { lt: cutoff } },
    });

    await this.purgePosts(stale, 'draft_ttl_expired');
  }

  private async purgeOldRejected(): Promise<void> {
    const retentionDays = Number(
      this.configService.get<string>('POST_REJECTED_RETENTION_DAYS') ??
        this.configService.get<string>('CONTENT_REJECTED_RETENTION_DAYS') ??
        90,
    );
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const old = await this.prisma.post.findMany({
      where: { status: PostStatus.REJECTED, updatedAt: { lt: cutoff } },
    });

    await this.purgePosts(old, 'rejected_retention_expired');
  }

  private async purgePosts(
    posts: Array<Record<string, unknown> & { id: string }>,
    reason: string,
  ): Promise<void> {
    for (const post of posts) {
      try {
        await this.prisma.post.delete({ where: { id: post.id } });

        const filepaths = MEDIA_FIELD_NAMES.flatMap((field) => (post[field] as string[]) ?? []);
        await Promise.allSettled(filepaths.map((fp) => this.minioService.deleteFile(fp)));

        this.logger.log(`purged post ${post.id} (${reason})`);
      } catch (err) {
        this.logger.error(`failed to purge post ${post.id}: ${(err as Error).message}`);
      }
    }
  }
}