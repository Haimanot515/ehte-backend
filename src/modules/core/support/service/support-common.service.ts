import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditSeverity,
  Prisma,
  SupportDisputeSide,
  SupportDisputeStatus,
  SupportType,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/audit-log/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { CreateSupportDisputeDto, SupportStatsQueryDto } from '../dto/support.dto';
import { ADMIN_ROLE_NAMES, COUNTED_STATUSES, DISPUTE_SELECT } from './support.constants';

@Injectable()
export class SupportCommonService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  getRoles(user: CurrentUserDto): string[] {
    return (
      (
        user as unknown as {
          roles?: string[];
        }
      ).roles ?? []
    );
  }

  isAdmin(user: CurrentUserDto): boolean {
    return this.getRoles(user).some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));
  }

  // Labels by transferReference (the off-platform reference an admin verifies against).
  buildSupportLabel(support: { id: string; transferReference: string | null }): string {
    return support.transferReference ?? `support:${support.id.slice(0, 8)}`;
  }

  paging(q?: { page?: number; limit?: number }) {
    const page = q?.page ?? 1;
    const limit = q?.limit ?? 20;
    return { page, limit, skip: (page - 1) * limit, take: limit };
  }

  // Raw SQL returns bigint for COUNT(); the API returns plain numbers.
  num(v: unknown): number {
    if (v === null || v === undefined) return 0;
    return typeof v === 'bigint' ? Number(v) : Number(v);
  }

  toJson(v: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull {
    return v === null || v === undefined ? Prisma.JsonNull : (v as Prisma.InputJsonValue);
  }

  emitSupportAudit(
    actor: CurrentUserDto,
    action: AuditEventEnum,
    support: { id: string; userId?: string | null; transferReference?: string | null },
    extra: Partial<AuditEventPayload> & Record<string, unknown> = {},
  ): void {
    this.emitAudit({
      userId: actor.id,
      ...(support.userId && support.userId !== actor.id ? { targetUserId: support.userId } : {}),
      actorType: resolveActorType(this.getRoles(actor)),
      action,
      entity: 'Support',
      entityId: support.id,
      entityLabel: this.buildSupportLabel({
        id: support.id,
        transferReference: support.transferReference ?? null,
      }),
      ...extra,
    } as AuditEventPayload);
  }

  async findSupportOrThrow(id: string) {
    const support = await this.prisma.support.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        victimProfileId: true,
        transferReference: true,
        victimProfile: { select: { claimedByUserId: true } },
      },
    });
    if (!support) throw new NotFoundException('support_not_found');
    return support;
  }

  async findOwnedOrThrow(id: string, user: CurrentUserDto) {
    const support = await this.findSupportOrThrow(id);
    if (support.userId !== user.id) throw new ForbiddenException('not_allowed_to_modify_support');
    return support;
  }

  // The user who claimed the victim profile, and nobody else.
  async findAsRecipientOrThrow(id: string, user: CurrentUserDto, forbiddenCode: string) {
    const support = await this.findSupportOrThrow(id);
    const claimant = support.victimProfile.claimedByUserId;
    if (!claimant || claimant !== user.id) throw new ForbiddenException(forbiddenCode);
    return support;
  }

  // A new supporter message or proof file puts the offer back in every admin's unread list.
  async markUnreadForAllAdmins(supportId: string): Promise<void> {
    await this.prisma.supportAdminRead.deleteMany({ where: { supportId } });
  }

  async touchSupporterUpdate(supportId: string): Promise<void> {
    await this.prisma.support.updateMany({
      where: { id: supportId },
      data: { lastUpdateAt: new Date() },
    });
  }

  mapAdminRow<T extends { adminReads: unknown[] }>(row: T) {
    const { adminReads, ...rest } = row;
    return { ...rest, isRead: adminReads.length > 0 };
  }

  async openDispute(
    support: Awaited<ReturnType<SupportCommonService['findSupportOrThrow']>>,
    user: CurrentUserDto,
    side: SupportDisputeSide,
    data: CreateSupportDisputeDto,
  ) {
    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('disputes_are_for_non_financial_support');
    }
    if (!COUNTED_STATUSES.includes(support.status)) {
      throw new BadRequestException('support_not_ready_for_dispute');
    }

    const open = await this.prisma.supportDispute.count({
      where: { supportId: support.id, side, status: SupportDisputeStatus.OPEN },
    });
    if (open > 0) throw new BadRequestException('dispute_already_open');

    const dispute = await this.prisma.supportDispute.create({
      data: {
        supportId: support.id,
        supporterUserId: support.userId,
        raisedByUserId: user.id,
        side,
        reason: data.reason,
        details: data.details.trim(),
      },
      select: DISPUTE_SELECT,
    });

    await this.markUnreadForAllAdmins(support.id);
    if (side === SupportDisputeSide.RECIPIENT) await this.touchSupporterUpdate(support.id);

    this.emitSupportAudit(user, AuditEventEnum.SUPPORT_DISPUTE_CREATED, support, {
      severity: AuditSeverity.WARNING,
      diff: { result: 'success', disputeId: dispute.id, side, reason: data.reason },
      metadata: { victimProfileId: support.victimProfileId },
    });

    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_DISPUTE_OPENED, {
      supportId: support.id,
      disputeId: dispute.id,
      side,
      supporterUserId: support.userId,
      victimProfileId: support.victimProfileId,
    });

    return dispute;
  }

  // ═════════════════ admin: search, facets, export (SP-55 .. SP-60) ═════════════════

  // Filters shared by search, facets, export and every stats route.
  buildStatsWhere(q: SupportStatsQueryDto): Prisma.SupportWhereInput {
    const createdAt: Prisma.DateTimeFilter = {};
    if (q.from) createdAt.gte = new Date(q.from);
    if (q.to) createdAt.lte = new Date(q.to);
    return {
      ...(q.from || q.to ? { createdAt } : {}),
      ...(q.status ? { status: q.status } : {}),
      ...(q.type ? { type: q.type } : {}),
      ...(q.victimProfileId ? { victimProfileId: q.victimProfileId } : {}),
      ...(q.supporterId ? { userId: q.supporterId } : {}),
    };
  }
}
