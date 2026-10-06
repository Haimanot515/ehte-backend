import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, SupportDisputeSide, SupportStatus, SupportType } from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import {
  CreateSupportDisputeDto,
  SendThanksDto,
  SupportPagedQueryDto,
} from '../dto/support.dto';
import {
  COUNTED_STATUSES,
  ANONYMOUS_LABEL,
  RECIPIENT_DISPUTE_REASONS,
  INCOMING_SELECT,
} from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportIncomingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  private incomingWhere(userId: string): Prisma.SupportWhereInput {
    return {
      type: SupportType.NON_FINANCIAL,
      victimProfile: { claimedByUserId: userId },
      OR: [{ status: { in: COUNTED_STATUSES } }, { declinedAt: { not: null } }],
    };
  }

  private mapIncoming(
    s: Prisma.SupportGetPayload<{ select: typeof INCOMING_SELECT }>,
  ) {
    return {
      id: s.id,
      status: s.status,
      categories: s.categories,
      note: s.message,
      supporterName: s.anonymous || !s.user?.name ? ANONYMOUS_LABEL : s.user.name,
      victimProfile: s.victimProfile,
      receiptConfirmedAt: s.victimConfirmedReceiptAt,
      thanksSentAt: s.thanksSentAt,
      declinedAt: s.declinedAt,
      opened: s.recipientOpenedAt !== null,
      createdAt: s.createdAt,
    };
  }

  // SP-13
  async findIncoming(user: CurrentUserDto, query: SupportPagedQueryDto) {
    const { page, limit, skip, take } = this.supportCommonService.paging(query);
    const where = this.incomingWhere(user.id);
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.support.count({ where }),
      this.prisma.support.findMany({
        where,
        select: INCOMING_SELECT,
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items: rows.map((r) => this.mapIncoming(r)) };
  }

  // SP-18
  async getIncomingSummary(user: CurrentUserDto) {
    const where = this.incomingWhere(user.id);
    const [byStatus, declined, awaitingReceipt] = await Promise.all([
      this.prisma.support.groupBy({
        by: ['status'],
        where,
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.support.count({ where: { ...where, declinedAt: { not: null } } }),
      this.prisma.support.count({
        where: { ...where, status: { in: COUNTED_STATUSES }, victimConfirmedReceiptAt: null },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(SupportStatus).map((s) => [s, 0]),
    ) as Record<SupportStatus, number>;
    for (const row of byStatus)
      statusCounts[row.status] = (row._count as { _all?: number })?._all ?? 0;

    return {
      total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      byStatus: statusCounts,
      declined,
      awaitingReceiptConfirmation: awaitingReceipt,
    };
  }

  // SP-19
  async countIncomingUnread(user: CurrentUserDto) {
    const count = await this.prisma.support.count({
      where: {
        ...this.incomingWhere(user.id),
        status: { in: COUNTED_STATUSES },
        recipientOpenedAt: null,
      },
    });
    return { count };
  }

  // SP-14. Opening an offer marks it as opened.
  async findOneIncoming(id: string, user: CurrentUserDto) {
    const row = await this.prisma.support.findFirst({
      where: { id, ...this.incomingWhere(user.id) },
      select: INCOMING_SELECT,
    });
    if (!row) throw new NotFoundException('support_not_found');

    if (!row.recipientOpenedAt) {
      const now = new Date();
      await this.prisma.support.updateMany({
        where: { id, recipientOpenedAt: null },
        data: { recipientOpenedAt: now },
      });
      row.recipientOpenedAt = now;
    }
    return this.mapIncoming(row);
  }

  // SP-16
  async disputeReceipt(id: string, user: CurrentUserDto, data: CreateSupportDisputeDto) {
    if (!RECIPIENT_DISPUTE_REASONS.includes(data.reason)) {
      throw new BadRequestException('dispute_reason_not_allowed_for_recipient');
    }
    const support = await this.supportCommonService.findAsRecipientOrThrow(id, user, 'not_allowed_to_dispute_receipt');
    return this.supportCommonService.openDispute(support, user, SupportDisputeSide.RECIPIENT, data);
  }

  // SP-17. One thank-you per offer. The text travels in the notification event.
  async sendThanks(id: string, user: CurrentUserDto, data: SendThanksDto) {
    const support = await this.supportCommonService.findAsRecipientOrThrow(id, user, 'not_allowed_to_send_thanks');
    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('thanks_are_for_non_financial_support');
    }
    if (!COUNTED_STATUSES.includes(support.status)) {
      throw new BadRequestException('support_not_ready_for_thanks');
    }

    const now = new Date();
    const { count } = await this.prisma.support.updateMany({
      where: { id, thanksSentAt: null },
      data: { thanksSentAt: now, lastUpdateAt: now },
    });
    if (count === 0) throw new BadRequestException('thanks_already_sent');

    const message = data.message?.trim() || null;
    this.supportCommonService.emitSupportAudit(user, AuditEventEnum.SUPPORT_THANKS_SENT, support, {
      diff: { result: 'success', hasMessage: Boolean(message) },
    });
    if (support.userId) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_THANKS_RECEIVED, {
        userId: support.userId,
        supportId: id,
        message,
      });
    }
    return { id, thanksSentAt: now };
  }
}
