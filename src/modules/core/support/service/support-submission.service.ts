import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  ActorType,
  AuditOutcome,
  AuditSeverity,
  PartyType,
  Prisma,
  SupportAgreementType,
  SupportCategory,
  SupportStatus,
  SupportType,
} from '@prisma/client';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { CreateSupportDto, UpdateSupportDto, UploadSupportProofDto } from '../dto/support.dto';
import {
  BILLING_PAYMENT_PAID,
  BillingPaymentPaid,
} from 'src/modules/billing/billing-events/service/billing-events.service';
import type { AllocationPreview } from 'src/modules/billing/allocation/service/allocation.service';
import {
  SUPPORT_OWNER_SELECT,
  MAX_ACTIVE_ATTACHMENTS,
  MIME_BY_EXTENSION,
  ATTACHMENT_OWNER_SELECT,
} from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportSubmissionService {
  private readonly logger = new Logger(SupportSubmissionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  // Non-financial offers only. Money is never accepted here: financial support is created by
  // onPaymentPaid() after Chapa confirms a payment.
  async create(user: CurrentUserDto, data: CreateSupportDto) {
    const roles = this.supportCommonService.getRoles(user);
    const actorType = resolveActorType(roles);

    const victimProfile = await this.prisma.victimProfile.findUnique({
      where: { id: data.victimProfileId },
    });

    if (!victimProfile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (victimProfile.status !== 'PUBLISHED' || !victimProfile.isPublished) {
      this.supportCommonService.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.SUPPORT_CREATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'VictimProfile',
        entityId: victimProfile.id,
        diff: {
          result: 'failure',
          reason: 'victim_profile_not_available_for_support',
          profileStatus: victimProfile.status,
          isPublished: victimProfile.isPublished,
        },
        metadata: { categories: data.categories },
      });
      throw new BadRequestException('victim_profile_not_available_for_support');
    }

    const categories = [...new Set(data.categories)];
    if (categories.length === 0) {
      throw new BadRequestException('support_categories_required');
    }

    const note = data.message?.trim() || undefined;
    if (categories.includes(SupportCategory.OTHER) && !note) {
      throw new BadRequestException('support_note_required_for_other');
    }

    const support = await this.prisma.support.create({
      data: {
        victimProfileId: data.victimProfileId,
        userId: user.id,
        type: SupportType.NON_FINANCIAL,
        status: SupportStatus.PENDING,
        categories,
        message: note,
        anonymous: data.anonymous ?? true,
        contactMayBeShared: data.contactMayBeShared ?? false,
      },
      select: SUPPORT_OWNER_SELECT,
    });

    this.supportCommonService.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.SUPPORT_CREATED,
      entity: 'Support',
      entityId: support.id,
      entityLabel: this.supportCommonService.buildSupportLabel(support),
      reason: note ?? null,
      diff: {
        result: 'success',
        status: support.status,
        type: support.type,
      },
      metadata: {
        victimProfileId: support.victimProfileId,
        categories: support.categories,
        anonymous: support.anonymous,
        contactMayBeShared: support.contactMayBeShared,
      },
    });

    // The supporter is told right away. The victim is NOT told until an admin confirms the offer.
    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_PLEDGE_CREATED, {
      supportId: support.id,
      userId: support.userId,
      victimProfileId: support.victimProfileId,
    });

    return support;
  }

  // Runs when Chapa has confirmed a support payment. Safe to run twice: the payment's fulfilledAt
  // is claimed in the same transaction that creates the Support, so a repeat does nothing.
  @OnEvent(BILLING_PAYMENT_PAID)
  async onPaymentPaid(e: BillingPaymentPaid): Promise<void> {
    try {
      await this.fulfilSupportPayment(e.paymentId);
    } catch (error) {
      // The repair job re-emits the event for PAID support payments that are still unfulfilled.
      this.logger.error(
        `Could not create support for payment ${e.paymentId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async fulfilSupportPayment(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: {
        id: true,
        type: true,
        status: true,
        amount: true,
        payerUserId: true,
        victimProfileId: true,
        agreementId: true,
        agreementVersion: true,
        allocationSnapshot: true,
        supportAnonymous: true,
        supportId: true,
        fulfilledAt: true,
      },
    });

    if (!payment || payment.type !== 'SUPPORT') return;
    if (payment.status !== 'PAID' || payment.fulfilledAt || payment.supportId) return;

    if (!payment.victimProfileId) {
      this.logger.warn(`Paid support payment ${payment.id} has no victim profile; not fulfilled`);
      return;
    }
    const victimProfileId = payment.victimProfileId;

    const snapshot = payment.allocationSnapshot as unknown as AllocationPreview;
    const shareOf = (party: PartyType): Prisma.Decimal =>
      (snapshot.lines ?? [])
        .filter((line) => line.partyType === party)
        .reduce((sum, line) => sum.add(new Prisma.Decimal(line.amount)), new Prisma.Decimal(0));

    const recipientAmount = shareOf(PartyType.RECIPIENT);
    const organizationAmount = shareOf(PartyType.RESPONSIBLE_ORGANIZATION);
    const platformAmount = shareOf(PartyType.PLATFORM);
    const anonymous = payment.supportAnonymous;

    const supporterName = anonymous
      ? null
      : ((
          await this.prisma.user.findUnique({
            where: { id: payment.payerUserId },
            select: { name: true },
          })
        )?.name ?? null);

    const result = await this.prisma.$transaction(async (tx) => {
      const claimed = await tx.payment.updateMany({
        where: { id: payment.id, status: 'PAID', fulfilledAt: null, supportId: null },
        data: { fulfilledAt: new Date() },
      });
      if (claimed.count === 0) return null;

      const support = await tx.support.create({
        data: {
          victimProfileId,
          userId: payment.payerUserId,
          type: SupportType.FINANCIAL,
          status: SupportStatus.CONFIRMED,
          agreementType: snapshot.agreementType ?? SupportAgreementType.DIRECT,
          agreementId: payment.agreementId,
          agreementVersion: payment.agreementVersion,
          allocationSnapshot: payment.allocationSnapshot as Prisma.InputJsonValue,
          amount: payment.amount,
          recipientAmount,
          organizationAmount,
          platformAmount,
          anonymous,
        },
        select: { id: true },
      });

      await tx.payment.update({
        where: { id: payment.id },
        data: { supportId: support.id },
      });

      // The total is read from the same statement that increments it, so the message adds up.
      const profile = await tx.victimProfile.update({
        where: { id: victimProfileId },
        data: { totalRaised: { increment: recipientAmount } },
        select: { totalRaised: true, claimedByUserId: true },
      });

      return {
        supportId: support.id,
        totalRaised: profile.totalRaised,
        claimedByUserId: profile.claimedByUserId,
      };
    });

    if (!result) return;

    this.supportCommonService.emitAudit({
      actorType: ActorType.SYSTEM,
      targetUserId: payment.payerUserId,
      action: AuditEventEnum.SUPPORT_CREATED,
      entity: 'Support',
      entityId: result.supportId,
      entityLabel: `support:${result.supportId.slice(0, 8)}`,
      diff: {
        result: 'success',
        status: SupportStatus.CONFIRMED,
        type: SupportType.FINANCIAL,
      },
      metadata: {
        victimProfileId,
        paymentId: payment.id,
        amount: payment.amount.toFixed(2),
        recipientAmount: recipientAmount.toFixed(2),
        organizationAmount: organizationAmount.toFixed(2),
        platformAmount: platformAmount.toFixed(2),
        anonymous,
        totalRaised: result.totalRaised.toFixed(2),
      },
    });

    // Only the claiming user is told. An unclaimed profile gets no automatic message.
    if (result.claimedByUserId) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_RECEIVED, {
        userId: result.claimedByUserId,
        supportId: result.supportId,
        victimProfileId,
        supporterName,
        recipientAmount: recipientAmount.toFixed(2),
        totalRaised: result.totalRaised.toFixed(2),
      });
    }
  }

  // ═══════════════════════════ supporter side (SP-01 .. SP-12) ═══════════════════════════

  // SP-01
  async updateMyOffer(id: string, user: CurrentUserDto, data: UpdateSupportDto) {
    const support = await this.prisma.support.findUnique({
      where: { id },
      select: SUPPORT_OWNER_SELECT,
    });
    if (!support) throw new NotFoundException('support_not_found');
    if (support.userId !== user.id) throw new ForbiddenException('not_allowed_to_modify_support');
    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('only_non_financial_offers_can_be_edited');
    }
    if (support.status !== SupportStatus.PENDING) {
      throw new BadRequestException('only_pending_offers_can_be_edited');
    }

    const nextCategories = data.categories ? [...new Set(data.categories)] : support.categories;
    const nextMessage =
      data.message !== undefined ? data.message.trim() || null : (support.message ?? null);

    if (nextCategories.length === 0) throw new BadRequestException('support_categories_required');
    if (nextCategories.includes(SupportCategory.OTHER) && !nextMessage) {
      throw new BadRequestException('support_note_required_for_other');
    }

    const nextAnonymous = data.anonymous ?? support.anonymous;
    const nextContact = data.contactMayBeShared ?? support.contactMayBeShared;

    const sameCategories =
      [...nextCategories].sort().join(',') === [...support.categories].sort().join(',');

    const changes: Array<{ field: string; oldValue: unknown; newValue: unknown }> = [];
    if (!sameCategories) {
      changes.push({ field: 'categories', oldValue: support.categories, newValue: nextCategories });
    }
    if (nextMessage !== (support.message ?? null)) {
      changes.push({ field: 'message', oldValue: support.message ?? null, newValue: nextMessage });
    }
    if (nextAnonymous !== support.anonymous) {
      changes.push({ field: 'anonymous', oldValue: support.anonymous, newValue: nextAnonymous });
    }
    if (nextContact !== support.contactMayBeShared) {
      changes.push({
        field: 'contactMayBeShared',
        oldValue: support.contactMayBeShared,
        newValue: nextContact,
      });
    }

    if (changes.length === 0) return support;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.support.updateMany({
        where: { id, userId: user.id, status: SupportStatus.PENDING },
        data: {
          categories: nextCategories,
          message: nextMessage,
          anonymous: nextAnonymous,
          contactMayBeShared: nextContact,
        },
      });
      if (result.count === 0) return null;

      await tx.supportRevision.createMany({
        data: changes.map((c) => ({
          supportId: id,
          actorUserId: user.id,
          field: c.field,
          oldValue: this.supportCommonService.toJson(c.oldValue),
          newValue: this.supportCommonService.toJson(c.newValue),
        })),
      });
      // The team should see that the offer changed.
      await tx.supportAdminRead.deleteMany({ where: { supportId: id } });

      return tx.support.findUniqueOrThrow({ where: { id }, select: SUPPORT_OWNER_SELECT });
    });

    if (!updated) throw new BadRequestException('only_pending_offers_can_be_edited');

    this.supportCommonService.emitSupportAudit(user, AuditEventEnum.SUPPORT_UPDATED, support, {
      diff: { result: 'success', fields: changes.map((c) => c.field) },
      metadata: { victimProfileId: support.victimProfileId },
    });

    return updated;
  }

  // SP-02. Files are already stored by @MediaUpload; the DTO arrays hold their keys.
  async uploadProof(id: string, user: CurrentUserDto, data: UploadSupportProofDto) {
    const support = await this.supportCommonService.findOwnedOrThrow(id, user);

    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('proof_is_for_non_financial_support');
    }
    if (support.status !== SupportStatus.PENDING && support.status !== SupportStatus.CONFIRMED) {
      throw new BadRequestException('support_not_open_for_proof');
    }

    const incoming = new Map<string, string>();
    for (const [kind, keys] of [
      ['photo', data.photo],
      ['pdf', data.pdf],
      ['document', data.document],
    ] as const) {
      for (const key of keys ?? []) {
        const trimmed = key.trim();
        if (trimmed && !incoming.has(trimmed)) incoming.set(trimmed, kind);
      }
    }
    if (incoming.size === 0) throw new BadRequestException('proof_file_required');

    const existing = await this.prisma.supportAttachment.findMany({
      where: { supportId: id, removedAt: null },
      select: { key: true },
    });
    const existingKeys = new Set(existing.map((a) => a.key));
    const fresh = [...incoming.entries()].filter(([key]) => !existingKeys.has(key));

    if (existing.length + fresh.length > MAX_ACTIVE_ATTACHMENTS) {
      throw new BadRequestException('too_many_proof_files');
    }

    const note = data.note?.trim() || null;
    const created = await this.prisma.$transaction(
      fresh.map(([key, kind]) => {
        const ext = key.split('.').pop()?.toLowerCase() ?? '';
        return this.prisma.supportAttachment.create({
          data: {
            supportId: id,
            key,
            kind,
            mimeType: MIME_BY_EXTENSION[ext] ?? null,
            note,
            uploadedByUserId: user.id,
          },
          select: ATTACHMENT_OWNER_SELECT,
        });
      }),
    );

    if (created.length > 0) {
      await this.supportCommonService.markUnreadForAllAdmins(id);
      this.supportCommonService.emitSupportAudit(user, AuditEventEnum.SUPPORT_PROOF_UPLOADED, support, {
        diff: { result: 'success', files: created.length },
        metadata: { victimProfileId: support.victimProfileId, kinds: created.map((c) => c.kind) },
      });
    }

    return { supportId: id, added: created.length, attachments: created };
  }

  // SP-03. Only while the offer is still PENDING.
  async removeProof(id: string, key: string, user: CurrentUserDto) {
    const support = await this.supportCommonService.findOwnedOrThrow(id, user);
    if (support.status !== SupportStatus.PENDING) {
      throw new BadRequestException('proof_can_only_be_removed_while_pending');
    }

    const { count } = await this.prisma.supportAttachment.updateMany({
      where: { supportId: id, key, removedAt: null },
      data: {
        removedAt: new Date(),
        removedByUserId: user.id,
        removalReason: 'removed_by_supporter',
      },
    });
    if (count === 0) throw new NotFoundException('proof_not_found');

    this.supportCommonService.emitSupportAudit(user, AuditEventEnum.SUPPORT_PROOF_REMOVED, support, {
      diff: { result: 'success', key },
    });
    return { supportId: id, key, removed: true };
  }
}
