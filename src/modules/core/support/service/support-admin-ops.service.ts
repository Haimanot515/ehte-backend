import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  AuditSeverity,
  Prisma,
  SupportAttachmentAccessAction,
  SupportMessageAuthor,
  SupportStatus,
  SupportType,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import {
  AssignSupportReviewerDto,
  BulkExpireSupportDto,
  CreateSupportMessageDto,
  ListSupportQueryDto,
  ReassignSupportProfileDto,
} from '../dto/support.dto';
import {
  ADMIN_ROLE_NAMES,
  DEFAULT_OFFER_EXPIRY_DAYS,
  SUPPORT_OWNER_SELECT,
  BULK_EXPIRE_MAX,
} from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportAdminOpsService {
  private readonly logger = new Logger(SupportAdminOpsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  // Admin queue. Includes the supporter's contact because the team follows up off the platform.
  async listForAdmin(query: ListSupportQueryDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;

    const where: Prisma.SupportWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.type ? { type: query.type } : {}),
    };

    const [total, items] = await this.prisma.$transaction([
      this.prisma.support.count({ where }),
      this.prisma.support.findMany({
        where,
        select: {
          ...SUPPORT_OWNER_SELECT,
          user: { select: { id: true, name: true, phone: true, email: true } },
          victimProfile: { select: { id: true, name: true, claimedByUserId: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
    ]);

    return { total, page, limit, items };
  }

  // SP-42 (super admin only; the controller enforces the role)
  async assignReviewer(id: string, admin: CurrentUserDto, data: AssignSupportReviewerDto) {
    const support = await this.supportCommonService.findSupportOrThrow(id);

    const reviewer = await this.prisma.user.findFirst({
      where: {
        id: data.reviewerId,
        isActive: true,
        userRoles: { some: { role: { name: { in: ADMIN_ROLE_NAMES } } } },
      },
      select: { id: true, name: true },
    });
    if (!reviewer) throw new BadRequestException('reviewer_must_be_an_active_admin');

    const before = await this.prisma.support.findUniqueOrThrow({
      where: { id },
      select: { assignedReviewerId: true },
    });
    if (before.assignedReviewerId === reviewer.id) {
      throw new BadRequestException('reviewer_already_assigned');
    }

    await this.prisma.$transaction([
      this.prisma.support.update({
        where: { id },
        data: { assignedReviewerId: reviewer.id, assignedAt: new Date() },
        select: { id: true },
      }),
      this.prisma.supportRevision.create({
        data: {
          supportId: id,
          actorUserId: admin.id,
          field: 'assignedReviewerId',
          oldValue: this.supportCommonService.toJson(before.assignedReviewerId),
          newValue: this.supportCommonService.toJson(reviewer.id),
        },
      }),
    ]);

    this.supportCommonService.emitSupportAudit(admin, AuditEventEnum.SUPPORT_REVIEWER_ASSIGNED, support, {
      diff: {
        result: 'success',
        previousReviewerId: before.assignedReviewerId,
        reviewerId: reviewer.id,
      },
    });
    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_REVIEWER_ASSIGNED, {
      userId: reviewer.id,
      supportId: id,
    });

    return { id, assignedReviewerId: reviewer.id, reviewerName: reviewer.name };
  }

  // SP-45. Same effect as the hourly job, run on demand with a shorter or longer cut-off.
  async bulkExpire(admin: CurrentUserDto, data: BulkExpireSupportDto) {
    const days = data.olderThanDays ?? DEFAULT_OFFER_EXPIRY_DAYS;
    const cutoff = new Date(Date.now() - days * 86_400_000);
    const reason = data.reason?.trim() || 'expired_by_admin';

    const stale = await this.prisma.support.findMany({
      where: {
        type: SupportType.NON_FINANCIAL,
        status: SupportStatus.PENDING,
        createdAt: { lt: cutoff },
      },
      select: { id: true, userId: true, victimProfileId: true, transferReference: true },
      orderBy: { createdAt: 'asc' },
      take: BULK_EXPIRE_MAX,
    });

    let expired = 0;
    for (const support of stale) {
      try {
        const { count } = await this.prisma.support.updateMany({
          where: { id: support.id, status: SupportStatus.PENDING },
          data: { status: SupportStatus.CANCELLED },
        });
        if (count === 0) continue;
        expired += 1;

        this.supportCommonService.emitSupportAudit(admin, AuditEventEnum.SUPPORT_EXPIRED, support, {
          severity: AuditSeverity.INFO,
          reason,
          diff: {
            result: 'success',
            previousStatus: SupportStatus.PENDING,
            currentStatus: SupportStatus.CANCELLED,
          },
          metadata: { victimProfileId: support.victimProfileId, expiryDays: days, bulk: true },
        });
        if (support.userId) {
          this.eventEmitter.emit(NotificationEventEnum.SUPPORT_OFFER_EXPIRED, {
            userId: support.userId,
            supportId: support.id,
            expiryDays: days,
          });
        }
      } catch (error) {
        this.logger.error(
          `Could not expire support ${support.id}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    return {
      olderThanDays: days,
      matched: stale.length,
      expired,
      more: stale.length === BULK_EXPIRE_MAX,
    };
  }

  // SP-48. Non-financial only: money stays on the profile its payment was made for.
  async reassignProfile(id: string, admin: CurrentUserDto, data: ReassignSupportProfileDto) {
    const support = await this.prisma.support.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        victimProfileId: true,
        transferReference: true,
        anonymous: true,
        categories: true,
        user: { select: { name: true } },
      },
    });
    if (!support) throw new NotFoundException('support_not_found');
    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('only_non_financial_offers_can_be_reassigned');
    }
    if (support.status !== SupportStatus.PENDING && support.status !== SupportStatus.CONFIRMED) {
      throw new BadRequestException('support_not_open_for_reassignment');
    }
    if (support.victimProfileId === data.victimProfileId) {
      throw new BadRequestException('support_already_on_this_profile');
    }

    const target = await this.prisma.victimProfile.findFirst({
      where: { id: data.victimProfileId, status: 'PUBLISHED', isPublished: true },
      select: { id: true, claimedByUserId: true },
    });
    if (!target) throw new NotFoundException('victim_profile_not_found');

    const reason = data.reason.trim();
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.support.updateMany({
        where: {
          id,
          victimProfileId: support.victimProfileId,
          status: { in: [SupportStatus.PENDING, SupportStatus.CONFIRMED] },
        },
        data: {
          victimProfileId: target.id,
          recipientOpenedAt: null,
          victimConfirmedReceiptAt: null,
          lastUpdateAt: new Date(),
        },
      });
      if (result.count === 0) return null;
      await tx.supportRevision.create({
        data: {
          supportId: id,
          actorUserId: admin.id,
          field: 'victimProfileId',
          oldValue: this.supportCommonService.toJson(support.victimProfileId),
          newValue: this.supportCommonService.toJson(target.id),
        },
      });
      return tx.support.findUniqueOrThrow({ where: { id }, select: SUPPORT_OWNER_SELECT });
    });
    if (!updated) throw new BadRequestException('support_transition_conflict');

    this.supportCommonService.emitSupportAudit(admin, AuditEventEnum.SUPPORT_PROFILE_REASSIGNED, support, {
      reason,
      diff: { result: 'success', fromProfileId: support.victimProfileId, toProfileId: target.id },
    });

    // The new profile's owner is only told once the offer is already confirmed.
    if (support.status === SupportStatus.CONFIRMED && target.claimedByUserId) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_OFFER_CONFIRMED, {
        userId: target.claimedByUserId,
        supportId: id,
        victimProfileId: target.id,
        supporterName: support.anonymous ? null : (support.user?.name ?? null),
        categories: support.categories,
      });
    }
    return updated;
  }

  // SP-50
  async getRevisions(id: string, admin: CurrentUserDto) {
    void admin;
    await this.supportCommonService.findSupportOrThrow(id);
    return this.prisma.supportRevision.findMany({
      where: { supportId: id },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        field: true,
        oldValue: true,
        newValue: true,
        actorUserId: true,
        createdAt: true,
      },
      take: 500,
    });
  }

  // SP-51
  async sendStaffMessage(id: string, admin: CurrentUserDto, data: CreateSupportMessageDto) {
    const support = await this.supportCommonService.findSupportOrThrow(id);
    const body = data.body.trim();
    if (!body) throw new BadRequestException('message_body_required');

    const [message] = await this.prisma.$transaction([
      this.prisma.supportMessage.create({
        data: {
          supportId: id,
          authorUserId: admin.id,
          authorType: SupportMessageAuthor.STAFF,
          body,
        },
        select: { id: true, authorType: true, body: true, createdAt: true },
      }),
      this.prisma.support.update({
        where: { id },
        data: { lastUpdateAt: new Date() },
        select: { id: true },
      }),
      this.prisma.supportAdminRead.upsert({
        where: { supportId_adminId: { supportId: id, adminId: admin.id } },
        create: { supportId: id, adminId: admin.id },
        update: {},
      }),
    ]);

    this.supportCommonService.emitSupportAudit(admin, AuditEventEnum.SUPPORT_MESSAGE_SENT, support, {
      diff: { result: 'success', messageId: message.id, authorType: message.authorType },
    });
    if (support.userId) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_STAFF_MESSAGE, {
        userId: support.userId,
        supportId: id,
        messageId: message.id,
      });
    }
    return message;
  }

  // SP-52. Includes removed files (flagged) so the team can see what was taken down.
  async getAttachments(id: string, admin: CurrentUserDto) {
    void admin;
    await this.supportCommonService.findSupportOrThrow(id);
    const rows = await this.prisma.supportAttachment.findMany({
      where: { supportId: id },
      orderBy: { createdAt: 'asc' },
      select: {
        id: true,
        key: true,
        kind: true,
        mimeType: true,
        sizeBytes: true,
        sha256: true,
        scanStatus: true,
        note: true,
        uploadedByUserId: true,
        createdAt: true,
        removedAt: true,
        removalReason: true,
      },
    });
    return rows.map(({ removedAt, ...rest }) => ({
      ...rest,
      removedAt,
      removed: removedAt !== null,
    }));
  }

  // SP-53. For example a photo that shows a face or an address.
  async adminRemoveProof(id: string, key: string, admin: CurrentUserDto) {
    const support = await this.supportCommonService.findSupportOrThrow(id);
    const { count } = await this.prisma.supportAttachment.updateMany({
      where: { supportId: id, key, removedAt: null },
      data: { removedAt: new Date(), removedByUserId: admin.id, removalReason: 'removed_by_staff' },
    });
    if (count === 0) throw new NotFoundException('proof_not_found');

    await this.supportCommonService.touchSupporterUpdate(id);
    this.supportCommonService.emitSupportAudit(admin, AuditEventEnum.SUPPORT_PROOF_REMOVED, support, {
      severity: AuditSeverity.WARNING,
      reason: 'removed_by_staff',
      diff: { result: 'success', key },
    });
    return { supportId: id, key, removed: true };
  }

  // SP-54
  async getProofCustody(id: string, key: string, admin: CurrentUserDto) {
    void admin;
    await this.supportCommonService.findSupportOrThrow(id);
    const attachment = await this.prisma.supportAttachment.findFirst({
      where: { supportId: id, key },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        key: true,
        kind: true,
        sha256: true,
        scanStatus: true,
        uploadedByUserId: true,
        createdAt: true,
        removedAt: true,
        removedByUserId: true,
        removalReason: true,
      },
    });
    if (!attachment) throw new NotFoundException('proof_not_found');

    const accesses = await this.prisma.supportAttachmentAccess.findMany({
      where: { attachmentId: attachment.id },
      orderBy: { createdAt: 'desc' },
      select: { userId: true, action: true, createdAt: true },
      take: 200,
    });
    const userIds = [
      ...new Set(
        [
          attachment.uploadedByUserId,
          attachment.removedByUserId,
          ...accesses.map((a) => a.userId),
        ].filter((v): v is string => Boolean(v)),
      ),
    ];
    const users = await this.prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, name: true },
    });
    const name = (uid: string | null) =>
      uid ? (users.find((u) => u.id === uid)?.name ?? null) : null;

    return {
      attachment,
      uploadedBy: { userId: attachment.uploadedByUserId, name: name(attachment.uploadedByUserId) },
      removedBy: attachment.removedByUserId
        ? { userId: attachment.removedByUserId, name: name(attachment.removedByUserId) }
        : null,
      accesses: accesses.map((a) => ({ ...a, name: name(a.userId) })),
    };
  }

  // Call this from whatever serves or signs proof-file URLs, so SP-54 has something to show.
  async recordProofAccess(
    attachmentId: string,
    userId: string | null,
    action: SupportAttachmentAccessAction,
  ): Promise<void> {
    await this.prisma.supportAttachmentAccess.create({ data: { attachmentId, userId, action } });
  }
}
