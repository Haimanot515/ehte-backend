import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PostStatus } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { MinioService } from 'src/services/minio/minio.service';

// ─────────────────────────────────────────────────
// NEW FILE — handles items #2 and #12 from the punch
// list:
//   #2  auto-delete DRAFT posts nobody ever finished
//       (and their attached media) after CONTENT_DRAFT_TTL_DAYS
//   #12 auto-delete REJECTED posts (and their media)
//       after CONTENT_REJECTED_RETENTION_DAYS, so rejected
//       content doesn't sit in the DB forever
//
// These two thresholds are shared across every submission
// type (Reports, Missing Person requests, Victim Profiles,
// Posts) rather than Post-specific — same privacy reasoning
// (§33: "sensitive information should not be kept longer
// than necessary") applies to all of them equally. Each
// still falls back from an optional module-specific override
// (POST_DRAFT_TTL_DAYS / POST_REJECTED_RETENTION_DAYS) to the
// shared CONTENT_* default, so Posts can diverge later without
// touching this file.
//
// SETUP REQUIRED:
//   1. `npm install @nestjs/schedule`
//   2. `ScheduleModule.forRoot()` imported once in AppModule
//   3. `PostRetentionService` added to PostModule's providers
// ─────────────────────────────────────────────────

const MEDIA_FIELD_NAMES = ['photo', 'video', 'audio', 'pdf', 'document', 'other'] as const;

@Injectable()
export class PostRetentionService {
  private readonly logger = new Logger(PostRetentionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly minioService: MinioService,
    private readonly configService: ConfigService,
  ) {}

  // Runs once a day. Adjust the schedule via CronExpression if a
  // different cadence is preferred.
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredPosts(): Promise<void> {
    await this.purgeStaleDrafts();
    await this.purgeOldRejected();
  }

  // Item #2: an abandoned DRAFT (and any photos/videos/etc.
  // attached to it) is a lingering privacy risk with no upside —
  // nobody is coming back to finish or review it.
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

  // Item #12: once rejected, a post (and its media) has no
  // further purpose except a paper trail — which the audit log
  // already preserves independently of the Post row itself.
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