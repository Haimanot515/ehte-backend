import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  ActorType,
  AuditOutcome,
  AuditSeverity,
  Prisma,
  SupportStatus,
  SupportType,
} from '@prisma/client';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { DEFAULT_OFFER_EXPIRY_DAYS } from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportAutomationService {
  private readonly logger = new Logger(SupportAutomationService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly config: ConfigService,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  // Cancels non-financial offers nobody answered in time, and tells the supporter.
  @Cron(CronExpression.EVERY_HOUR)
  async expireStaleOffers(): Promise<void> {
    const configured = Number(
      this.config.get<number>('support.offerExpiryDays', DEFAULT_OFFER_EXPIRY_DAYS),
    );
    const expiryDays =
      Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_OFFER_EXPIRY_DAYS;
    const cutoff = new Date(Date.now() - expiryDays * 86_400_000);

    const stale = await this.prisma.support.findMany({
      where: {
        type: SupportType.NON_FINANCIAL,
        status: SupportStatus.PENDING,
        createdAt: { lt: cutoff },
      },
      select: { id: true, userId: true, victimProfileId: true, transferReference: true },
      take: 200,
    });

    for (const support of stale) {
      try {
        const { count } = await this.prisma.support.updateMany({
          where: { id: support.id, status: SupportStatus.PENDING },
          data: { status: SupportStatus.CANCELLED },
        });
        if (count === 0) continue;

        this.supportCommonService.emitAudit({
          actorType: ActorType.SYSTEM,
          ...(support.userId ? { targetUserId: support.userId } : {}),
          action: AuditEventEnum.SUPPORT_EXPIRED,
          severity: AuditSeverity.INFO,
          entity: 'Support',
          entityId: support.id,
          entityLabel: this.supportCommonService.buildSupportLabel(support),
          reason: 'unanswered_offer_expired',
          diff: {
            result: 'success',
            previousStatus: SupportStatus.PENDING,
            currentStatus: SupportStatus.CANCELLED,
          },
          metadata: { victimProfileId: support.victimProfileId, expiryDays },
        });

        if (support.userId) {
          this.eventEmitter.emit(NotificationEventEnum.SUPPORT_OFFER_EXPIRED, {
            userId: support.userId,
            supportId: support.id,
            expiryDays,
          });
        }
      } catch (error) {
        this.logger.error(
          `Could not expire support ${support.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }
  }

  @OnEvent(AuditEventEnum.SUPPORT_CONFIRMED)
  async onSupportConfirmed(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.CONFIRMED);
  }

  @OnEvent(AuditEventEnum.SUPPORT_COMPLETED)
  async onSupportCompleted(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.COMPLETED);
  }

  @OnEvent(AuditEventEnum.SUPPORT_CANCELLED)
  async onSupportCancelled(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.CANCELLED);
  }

  @OnEvent(AuditEventEnum.SUPPORT_EXPIRED)
  async onSupportExpired(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.CANCELLED);
  }

  @OnEvent(AuditEventEnum.SUPPORT_FAILED)
  async onSupportFailed(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.FAILED);
  }

  @OnEvent(AuditEventEnum.SUPPORT_REOPENED)
  async onSupportReopened(p: AuditEventPayload) {
    await this.trackStatusChange(p, SupportStatus.PENDING);
  }

  private async trackStatusChange(p: AuditEventPayload, to: SupportStatus): Promise<void> {
    try {
      if (p.outcome && p.outcome !== AuditOutcome.SUCCESS) return;
      if (!p.entityId) return;

      const diff = (p.diff ?? {}) as Record<string, unknown>;
      const prev = diff.previousStatus as SupportStatus | undefined;
      const fromStatus =
        prev && (Object.values(SupportStatus) as string[]).includes(prev) ? prev : null;
      const now = new Date();

      const stamp: Prisma.SupportUncheckedUpdateManyInput = {
        ...(to === SupportStatus.CONFIRMED ? { confirmedAt: now } : {}),
        ...(to === SupportStatus.COMPLETED ? { completedAt: now } : {}),
        ...(to === SupportStatus.CANCELLED ? { cancelledAt: now } : {}),
        ...(to === SupportStatus.FAILED ? { failedAt: now } : {}),
        ...(to === SupportStatus.PENDING
          ? { confirmedAt: null, completedAt: null, cancelledAt: null, failedAt: null }
          : {}),
        // targetUserId is only set when someone other than the supporter made the change.
        ...(p.targetUserId ? { lastUpdateAt: now } : {}),
      };

      await this.prisma.$transaction([
        this.prisma.supportStatusEvent.create({
          data: {
            supportId: p.entityId,
            fromStatus,
            toStatus: to,
            actorUserId: p.userId ?? null,
            actorType: p.actorType ?? null,
            reason: p.reason ?? null,
          },
        }),
        this.prisma.support.updateMany({ where: { id: p.entityId }, data: stamp }),
      ]);
    } catch (error) {
      this.logger.error(
        `Could not record status change for support ${p.entityId ?? '?'}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
