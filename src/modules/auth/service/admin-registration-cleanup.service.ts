import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';

import { PrismaService } from 'src/prisma/prisma.service';
import { PENDING_REGISTRATION_WHERE } from 'src/common/utils/registration-state.util';

// Admin invitations that expired and were never used would otherwise sit in the pending list
// forever and keep their email address taken. This removes them after a grace period; a
// super admin can still re-invite during the grace period, and again afterwards from scratch.

@Injectable()
export class AdminRegistrationCleanupService {
  private readonly logger = new Logger(AdminRegistrationCleanupService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeExpiredInvitations(): Promise<void> {
    const graceDays = Number(this.configService.get<string>('ADMIN_INVITE_PURGE_AFTER_DAYS') ?? 7);
    const cutoff = new Date(Date.now() - graceDays * 24 * 60 * 60 * 1000);

    const stale = await this.prisma.user.findMany({
      where: { ...PENDING_REGISTRATION_WHERE, inviteTokenExpiresAt: { lt: cutoff } },
      select: { id: true },
    });

    let purged = 0;

    for (const { id } of stale) {
      try {
        await this.prisma.user.delete({ where: { id } });
        purged += 1;
      } catch (error) {
        // Something still references this row; leave it for a person to look at.
        this.logger.warn(`Could not purge expired admin invitation ${id}: ${String(error)}`);
      }
    }

    if (stale.length > 0) {
      this.logger.log(`Purged ${purged} of ${stale.length} expired admin invitations`);
    }
  }
}