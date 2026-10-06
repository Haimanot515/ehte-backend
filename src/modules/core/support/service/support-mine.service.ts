import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  ActorType,
  AuditOutcome,
  AuditSeverity,
  Prisma,
  SupportDisputeSide,
  SupportMessageAuthor,
  SupportStatus,
  SupportType,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import {
  CreateSupportDisputeDto,
  CreateSupportMessageDto,
  SupportPagedQueryDto,
} from '../dto/support.dto';
import {
  COUNTED_STATUSES,
  SUPPORT_OWNER_SELECT,
  VICTIM_PROFILE_SUMMARY_SELECT,
  SUPPORTER_DISPUTE_REASONS,
} from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportMineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  async findMine(user: CurrentUserDto) {
    return this.prisma.support.findMany({
      where: { userId: user.id },

      select: {
        ...SUPPORT_OWNER_SELECT,
        victimProfile: { select: VICTIM_PROFILE_SUMMARY_SELECT },
      },

      orderBy: { createdAt: 'desc' },
    });
  }

  // Only the supporter or an admin. Admins also see the supporter's contact; the full User record
  // (which holds password and passcode hashes) is never selected.
  async findOne(id: string, requestingUser: CurrentUserDto) {
    const isAdmin = this.supportCommonService.isAdmin(requestingUser);

    const support = await this.prisma.support.findUnique({
      where: { id },
      select: {
        ...SUPPORT_OWNER_SELECT,
        victimProfile: { select: VICTIM_PROFILE_SUMMARY_SELECT },
        ...(isAdmin
          ? {
              allocationSnapshot: true,
              user: { select: { id: true, name: true, phone: true, email: true } },
            }
          : {}),
      },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    if (!isAdmin && support.userId !== requestingUser.id) {
      throw new ForbiddenException('not_allowed_to_view_support');
    }

    return support;
  }

  // The claimed victim confirms, with one tap, that non-financial help arrived. Optional.
  async confirmReceipt(id: string, user: CurrentUserDto) {
    const actorType = resolveActorType(this.supportCommonService.getRoles(user));

    const support = await this.prisma.support.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        victimProfileId: true,
        victimConfirmedReceiptAt: true,
        victimProfile: { select: { claimedByUserId: true } },
      },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    if (
      !support.victimProfile.claimedByUserId ||
      support.victimProfile.claimedByUserId !== user.id
    ) {
      this.supportCommonService.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.SUPPORT_RECEIPT_CONFIRMED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        diff: { result: 'denied', reason: 'not_allowed_to_confirm_receipt' },
        metadata: { victimProfileId: support.victimProfileId },
      });
      throw new ForbiddenException('not_allowed_to_confirm_receipt');
    }

    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('receipt_confirmation_is_for_non_financial_support');
    }

    if (!COUNTED_STATUSES.includes(support.status)) {
      throw new BadRequestException('support_not_ready_for_receipt_confirmation');
    }

    if (support.victimConfirmedReceiptAt) {
      return {
        id: support.id,
        status: support.status,
        victimConfirmedReceiptAt: support.victimConfirmedReceiptAt,
      };
    }

    const now = new Date();
    const { count } = await this.prisma.support.updateMany({
      where: { id, victimConfirmedReceiptAt: null },
      data: { victimConfirmedReceiptAt: now },
    });

    if (count > 0) {
      this.supportCommonService.emitAudit({
        userId: user.id,
        targetUserId: support.userId,
        actorType,
        action: AuditEventEnum.SUPPORT_RECEIPT_CONFIRMED,
        entity: 'Support',
        entityId: support.id,
        diff: { result: 'success', victimConfirmedReceiptAt: now.toISOString() },
        metadata: { victimProfileId: support.victimProfileId },
      });
    }

    const fresh = await this.prisma.support.findUniqueOrThrow({
      where: { id },
      select: { id: true, status: true, victimConfirmedReceiptAt: true },
    });
    return fresh;
  }

  // Owner or admin may read; anyone else is refused.
  private async findReadableOrThrow(id: string, user: CurrentUserDto) {
    const support = await this.supportCommonService.findSupportOrThrow(id);
    if (support.userId !== user.id && !this.supportCommonService.isAdmin(user)) {
      throw new ForbiddenException('not_allowed_to_view_support');
    }
    return support;
  }

  // SP-06. Status history only: no internal reasons, no admin names.
  async getTimeline(id: string, user: CurrentUserDto) {
    const support = await this.findReadableOrThrow(id, user);
    const [head, events] = await Promise.all([
      this.prisma.support.findUniqueOrThrow({
        where: { id },
        select: { status: true, createdAt: true },
      }),
      this.prisma.supportStatusEvent.findMany({
        where: { supportId: id },
        orderBy: { createdAt: 'asc' },
        select: { fromStatus: true, toStatus: true, actorType: true, createdAt: true },
        take: 200,
      }),
    ]);

    const by = (t: ActorType | null) =>
      t === ActorType.SYSTEM
        ? 'SYSTEM'
        : t === ActorType.ADMIN || t === ActorType.SUPER_ADMIN
          ? 'STAFF'
          : 'PARTICIPANT';

    return {
      supportId: support.id,
      currentStatus: head.status,
      timeline: [
        {
          status: SupportStatus.PENDING,
          previousStatus: null,
          at: head.createdAt,
          by: 'PARTICIPANT',
          event: 'CREATED',
        },
        ...events.map((e) => ({
          status: e.toStatus,
          previousStatus: e.fromStatus,
          at: e.createdAt,
          by: by(e.actorType),
          event: 'STATUS_CHANGED',
        })),
      ],
    };
  }

  // SP-07
  async createDispute(id: string, user: CurrentUserDto, data: CreateSupportDisputeDto) {
    if (!SUPPORTER_DISPUTE_REASONS.includes(data.reason)) {
      throw new BadRequestException('dispute_reason_not_allowed_for_supporter');
    }
    const support = await this.supportCommonService.findOwnedOrThrow(id, user);
    return this.supportCommonService.openDispute(support, user, SupportDisputeSide.SUPPORTER, data);
  }

  // SP-08
  async sendMessage(id: string, user: CurrentUserDto, data: CreateSupportMessageDto) {
    const support = await this.supportCommonService.findOwnedOrThrow(id, user);
    const body = data.body.trim();
    if (!body) throw new BadRequestException('message_body_required');

    const message = await this.prisma.supportMessage.create({
      data: {
        supportId: id,
        authorUserId: user.id,
        authorType: SupportMessageAuthor.SUPPORTER,
        body,
      },
      select: { id: true, authorType: true, body: true, createdAt: true },
    });

    await this.supportCommonService.markUnreadForAllAdmins(id);

    this.supportCommonService.emitSupportAudit(user, AuditEventEnum.SUPPORT_MESSAGE_SENT, support, {
      diff: { result: 'success', messageId: message.id, authorType: message.authorType },
    });
    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_MESSAGE_RECEIVED, {
      supportId: id,
      messageId: message.id,
      supporterUserId: support.userId,
    });

    return message;
  }

  // SP-09. The supporter and the staff see the same thread.
  async getMessages(id: string, user: CurrentUserDto, query: SupportPagedQueryDto) {
    await this.findReadableOrThrow(id, user);
    const { page, limit, skip, take } = this.supportCommonService.paging(query);

    const [total, items] = await this.prisma.$transaction([
      this.prisma.supportMessage.count({ where: { supportId: id } }),
      this.prisma.supportMessage.findMany({
        where: { supportId: id },
        orderBy: { createdAt: 'asc' },
        skip,
        take,
        select: { id: true, authorType: true, body: true, createdAt: true },
      }),
    ]);
    return { total, page, limit, items };
  }

  private unseenWhere(userId: string): Prisma.SupportWhereInput {
    return {
      userId,
      lastUpdateAt: { not: null },
      OR: [
        { supporterSeenAt: null },
        { supporterSeenAt: { lt: this.prisma.support.fields.lastUpdateAt } },
      ],
    };
  }

  // SP-04
  async getMySupportSummary(user: CurrentUserDto) {
    const [byStatus, byType] = await Promise.all([
      this.prisma.support.groupBy({
        by: ['status'],
        where: { userId: user.id },
        _count: { _all: true },
        orderBy: { status: 'asc' },
      }),
      this.prisma.support.groupBy({
        by: ['type'],
        where: { userId: user.id },
        _count: { _all: true },
        orderBy: { type: 'asc' },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      Object.values(SupportStatus).map((s) => [s, 0]),
    ) as Record<SupportStatus, number>;
    for (const row of byStatus)
      statusCounts[row.status] = (row._count as { _all?: number })?._all ?? 0;

    const typeCounts = Object.fromEntries(Object.values(SupportType).map((t) => [t, 0])) as Record<
      SupportType,
      number
    >;
    for (const row of byType) typeCounts[row.type] = (row._count as { _all?: number })?._all ?? 0;

    return {
      total: Object.values(statusCounts).reduce((a, b) => a + b, 0),
      byStatus: statusCounts,
      byType: typeCounts,
    };
  }

  // SP-05
  async getMySupportImpact(user: CurrentUserDto) {
    const [completed, inProgress, profiles, financial] = await Promise.all([
      this.prisma.support.count({
        where: {
          userId: user.id,
          type: SupportType.NON_FINANCIAL,
          status: SupportStatus.COMPLETED,
        },
      }),
      this.prisma.support.count({
        where: {
          userId: user.id,
          type: SupportType.NON_FINANCIAL,
          status: { in: [SupportStatus.PENDING, SupportStatus.CONFIRMED] },
        },
      }),
      this.prisma.support.groupBy({
        by: ['victimProfileId'],
        where: { userId: user.id, status: { in: COUNTED_STATUSES } },
        orderBy: { victimProfileId: 'asc' },
      }),
      this.prisma.support.aggregate({
        where: { userId: user.id, type: SupportType.FINANCIAL, status: { in: COUNTED_STATUSES } },
        _count: { _all: true },
        _sum: { amount: true },
      }),
    ]);

    return {
      offersCompleted: completed,
      offersInProgress: inProgress,
      profilesHelped: profiles.length,
      financialContributions: {
        count: financial._count._all,
        totalAmount: Number(financial._sum.amount ?? 0),
      },
    };
  }

  // SP-10
  async countMyUnreadUpdates(user: CurrentUserDto) {
    const count = await this.prisma.support.count({ where: this.unseenWhere(user.id) });
    return { count };
  }

  // SP-11
  async markSeen(id: string, user: CurrentUserDto) {
    await this.supportCommonService.findOwnedOrThrow(id, user);
    const supporterSeenAt = new Date();
    await this.prisma.support.updateMany({
      where: { id, userId: user.id },
      data: { supporterSeenAt },
    });
    return { id, supporterSeenAt };
  }

  // SP-12
  async markAllMineSeen(user: CurrentUserDto) {
    const { count } = await this.prisma.support.updateMany({
      where: this.unseenWhere(user.id),
      data: { supporterSeenAt: new Date() },
    });
    return { marked: count };
  }
}
