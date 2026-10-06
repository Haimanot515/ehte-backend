import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import {
  AuditSeverity,
  Prisma,
  SupportDisputeStatus,
  SupportFlagReason,
  SupportStatus,
} from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import {
  FlagSupportDto,
  ListSupportDisputesQueryDto,
  ListSupportFlagsQueryDto,
} from '../dto/support.dto';
import { SUPPORT_OWNER_SELECT, DISPUTE_SELECT } from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportModerationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  // ═════════════════ admin: disputes, restrictions, flags (SP-34 .. SP-42) ═════════════════

  // SP-34. Open disputes unless a status is given.
  async findDisputes(admin: CurrentUserDto, query: ListSupportDisputesQueryDto) {
    void admin;
    const { page, limit, skip, take } = this.supportCommonService.paging(query);
    const where: Prisma.SupportDisputeWhereInput = {
      status: query.status ?? SupportDisputeStatus.OPEN,
      ...(query.outcome ? { outcome: query.outcome } : {}),
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.supportDispute.count({ where }),
      this.prisma.supportDispute.findMany({
        where,
        select: {
          ...DISPUTE_SELECT,
          supporterUserId: true,
          support: {
            select: {
              id: true,
              type: true,
              status: true,
              categories: true,
              transferReference: true,
              user: { select: { id: true, name: true } },
              victimProfile: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'asc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items };
  }

  // SP-35. Both sides plus the proof files (metadata only).
  async findOneDispute(disputeId: string, admin: CurrentUserDto) {
    void admin;
    const dispute = await this.prisma.supportDispute.findUnique({
      where: { id: disputeId },
      select: {
        ...DISPUTE_SELECT,
        supporterUserId: true,
        raisedByUserId: true,
        resolvedByUserId: true,
        support: {
          select: {
            ...SUPPORT_OWNER_SELECT,
            victimProfile: { select: { id: true, name: true, claimedByUserId: true } },
            attachments: {
              where: { removedAt: null },
              orderBy: { createdAt: 'asc' },
              select: {
                id: true,
                key: true,
                kind: true,
                mimeType: true,
                sizeBytes: true,
                scanStatus: true,
                note: true,
                createdAt: true,
              },
            },
          },
        },
      },
    });
    if (!dispute) throw new NotFoundException('dispute_not_found');

    const userIds = [
      dispute.supporterUserId,
      dispute.raisedByUserId,
      dispute.resolvedByUserId,
      dispute.support.victimProfile.claimedByUserId,
    ].filter((v): v is string => Boolean(v));
    const users = await this.prisma.user.findMany({
      where: { id: { in: [...new Set(userIds)] } },
      select: { id: true, name: true, phone: true, email: true },
    });
    const byId = new Map(users.map((u) => [u.id, u]));

    return {
      ...dispute,
      supporter: dispute.supporterUserId ? (byId.get(dispute.supporterUserId) ?? null) : null,
      recipient: dispute.support.victimProfile.claimedByUserId
        ? (byId.get(dispute.support.victimProfile.claimedByUserId) ?? null)
        : null,
      raisedBy: dispute.raisedByUserId ? (byId.get(dispute.raisedByUserId) ?? null) : null,
      resolvedBy: dispute.resolvedByUserId ? (byId.get(dispute.resolvedByUserId) ?? null) : null,
    };
  }

  // SP-37
  async findDisputesForSupport(id: string, admin: CurrentUserDto) {
    void admin;
    await this.supportCommonService.findSupportOrThrow(id);
    return this.prisma.supportDispute.findMany({
      where: { supportId: id },
      select: { ...DISPUTE_SELECT, raisedByUserId: true, resolvedByUserId: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  // SP-40
  async flagSupport(id: string, admin: CurrentUserDto, data: FlagSupportDto) {
    const support = await this.supportCommonService.findSupportOrThrow(id);
    const details = data.details?.trim() || null;
    if (data.reason === SupportFlagReason.OTHER && !details) {
      throw new BadRequestException('flag_details_required_for_other');
    }

    const flag = await this.prisma.supportFlag.create({
      data: { supportId: id, reason: data.reason, details, flaggedByUserId: admin.id },
      select: { id: true, supportId: true, reason: true, details: true, createdAt: true },
    });

    this.supportCommonService.emitSupportAudit(admin, AuditEventEnum.SUPPORT_FLAGGED, support, {
      severity: AuditSeverity.WARNING,
      reason: details,
      diff: { result: 'success', flagId: flag.id, flagReason: data.reason },
    });
    return flag;
  }

  // SP-41. Flags on offers that are still open (PENDING or CONFIRMED).
  async findFlags(admin: CurrentUserDto, query: ListSupportFlagsQueryDto) {
    void admin;
    const { page, limit, skip, take } = this.supportCommonService.paging(query);
    const where: Prisma.SupportFlagWhereInput = {
      ...(query.reason ? { reason: query.reason } : {}),
      support: { status: { in: [SupportStatus.PENDING, SupportStatus.CONFIRMED] } },
    };
    const [total, items] = await this.prisma.$transaction([
      this.prisma.supportFlag.count({ where }),
      this.prisma.supportFlag.findMany({
        where,
        select: {
          id: true,
          reason: true,
          details: true,
          flaggedByUserId: true,
          createdAt: true,
          support: {
            select: {
              id: true,
              type: true,
              status: true,
              categories: true,
              transferReference: true,
              user: { select: { id: true, name: true, phone: true, email: true } },
              victimProfile: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take,
      }),
    ]);
    return { total, page, limit, items };
  }
}
