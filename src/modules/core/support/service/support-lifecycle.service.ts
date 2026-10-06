import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditOutcome,
  AuditSeverity,
  SupportDisputeOutcome,
  SupportDisputeStatus,
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
  BulkSupportIdsDto,
  BulkSupportReasonDto,
  DeclineIncomingSupportDto,
  ResolveSupportDisputeDto,
  SupportReasonDto,
} from '../dto/support.dto';
import { COUNTED_STATUSES, SUPPORT_OWNER_SELECT, DISPUTE_SELECT } from './support.constants';
import { SupportCommonService } from './support-common.service';

@Injectable()
export class SupportLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly supportCommonService: SupportCommonService,
  ) {}

  // Allowed moves. Completed financial supports can still be cancelled by an admin (paid by mistake).
  private isTransitionAllowed(from: SupportStatus, to: SupportStatus, type: SupportType): boolean {
    switch (to) {
      case SupportStatus.CONFIRMED:
        return from === SupportStatus.PENDING;
      case SupportStatus.COMPLETED:
        return from === SupportStatus.CONFIRMED;
      case SupportStatus.CANCELLED:
        return (
          from === SupportStatus.PENDING ||
          from === SupportStatus.CONFIRMED ||
          (from === SupportStatus.COMPLETED && type === SupportType.FINANCIAL)
        );
      default:
        return false;
    }
  }

  // Keeps VictimProfile.totalRaised in sync atomically. Only FINANCIAL supports count, and they count
  // while CONFIRMED or COMPLETED. Non-financial supports never touch the total.
  private async updateStatus(
    id: string,
    status: SupportStatus,
    actor: CurrentUserDto,
    reason?: string,
  ) {
    const actorRoles = this.supportCommonService.getRoles(actor);
    const actorType = resolveActorType(actorRoles);

    const support = await this.prisma.support.findUnique({
      where: { id },
      include: {
        user: { select: { name: true } },
        victimProfile: { select: { claimedByUserId: true } },
      },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    const previousStatus = support.status;
    const label = this.supportCommonService.buildSupportLabel(support);

    // Set only when the actor is someone other than the supporter — a self-cancel isn't "against" anyone.
    const targetUserFields = actor.id === support.userId ? {} : { targetUserId: support.userId };

    if (previousStatus === status) {
      this.supportCommonService.emitAudit({
        userId: actor.id,
        ...targetUserFields,
        actorType,
        action: AuditEventEnum.SUPPORT_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'support_already_has_status',
          currentStatus: previousStatus,
          attemptedStatus: status,
        },
      });
      throw new BadRequestException('support_already_has_status');
    }

    if (!this.isTransitionAllowed(previousStatus, status, support.type)) {
      this.supportCommonService.emitAudit({
        userId: actor.id,
        ...targetUserFields,
        actorType,
        action: AuditEventEnum.SUPPORT_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'support_invalid_transition',
          currentStatus: previousStatus,
          attemptedStatus: status,
          type: support.type,
        },
      });
      throw new BadRequestException('support_invalid_transition');
    }

    const isFinancial = support.type === SupportType.FINANCIAL;
    const wasCounted = isFinancial && COUNTED_STATUSES.includes(previousStatus);
    const isCounted = isFinancial && COUNTED_STATUSES.includes(status);
    const amount = Number(support.recipientAmount ?? support.amount ?? 0);

    // Non-zero only when a financial support enters or leaves the counted statuses.
    let totalRaisedDelta = 0;
    if (!wasCounted && isCounted) totalRaisedDelta = amount;
    if (wasCounted && !isCounted) totalRaisedDelta = -amount;

    // Returns null on a lost race so the transaction commits as a no-op instead of rolling back.
    const updatedSupport = await this.prisma.$transaction(async (tx) => {
      const result = await tx.support.updateMany({
        where: { id, status: previousStatus },
        data: { status },
      });

      if (result.count === 0) {
        return null;
      }

      if (totalRaisedDelta !== 0) {
        await tx.victimProfile.update({
          where: { id: support.victimProfileId },
          data: { totalRaised: { increment: totalRaisedDelta } },
        });
      }

      return tx.support.findUniqueOrThrow({ where: { id }, select: SUPPORT_OWNER_SELECT });
    });

    if (!updatedSupport) {
      this.supportCommonService.emitAudit({
        userId: actor.id,
        ...targetUserFields,
        actorType,
        action: AuditEventEnum.SUPPORT_UPDATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'support_transition_conflict',
          expectedStatus: previousStatus,
          attemptedStatus: status,
        },
      });
      throw new BadRequestException('support_transition_conflict');
    }

    let auditEvent:
      | AuditEventEnum.SUPPORT_CONFIRMED
      | AuditEventEnum.SUPPORT_COMPLETED
      | AuditEventEnum.SUPPORT_CANCELLED
      | AuditEventEnum.SUPPORT_FAILED
      | null = null;

    switch (status) {
      case SupportStatus.CONFIRMED:
        auditEvent = AuditEventEnum.SUPPORT_CONFIRMED;
        break;
      case SupportStatus.COMPLETED:
        auditEvent = AuditEventEnum.SUPPORT_COMPLETED;
        break;
      case SupportStatus.CANCELLED:
        auditEvent = AuditEventEnum.SUPPORT_CANCELLED;
        break;
      case SupportStatus.FAILED:
        auditEvent = AuditEventEnum.SUPPORT_FAILED;
        break;
    }

    if (auditEvent) {
      this.supportCommonService.emitAudit({
        userId: actor.id,
        ...targetUserFields,
        actorType,
        action: auditEvent,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        reason: reason ?? null,

        diff: {
          result: 'success',
          previousStatus,
          currentStatus: updatedSupport.status,
        },

        metadata: {
          victimProfileId: support.victimProfileId,
          type: support.type,
          amount,
          totalRaisedDelta,
          categories: support.categories,
          transferReference: support.transferReference ?? null,
        },
      });
    }

    if (status === SupportStatus.CONFIRMED) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_PAYMENT_CONFIRMED, {
        supportId: updatedSupport.id,
        userId: support.userId,
      });
    }

    // Victim messages for non-financial offers: only at confirm and at complete, and only when the
    // profile has been claimed. Unclaimed profiles are handled by the admin.
    const claimedByUserId = support.victimProfile.claimedByUserId;
    if (
      support.type === SupportType.NON_FINANCIAL &&
      claimedByUserId &&
      (status === SupportStatus.CONFIRMED || status === SupportStatus.COMPLETED)
    ) {
      this.eventEmitter.emit(
        status === SupportStatus.CONFIRMED
          ? NotificationEventEnum.SUPPORT_OFFER_CONFIRMED
          : NotificationEventEnum.SUPPORT_OFFER_COMPLETED,
        {
          userId: claimedByUserId,
          supportId: support.id,
          victimProfileId: support.victimProfileId,
          supporterName: support.anonymous ? null : (support.user?.name ?? null),
          categories: support.categories,
        },
      );
    }

    return updatedSupport;
  }

  // Admin-only (controller enforces @Roles). Accepts a PENDING non-financial offer. Financial
  // supports are created already CONFIRMED by a successful payment.
  async confirm(id: string, admin: CurrentUserDto, reason?: string) {
    return this.updateStatus(id, SupportStatus.CONFIRMED, admin, reason);
  }

  // Admin-only (controller enforces @Roles). The note is required and is kept in the audit trail.
  async complete(id: string, admin: CurrentUserDto, note: string) {
    const trimmed = note?.trim();
    if (!trimmed) {
      throw new BadRequestException('completion_note_required');
    }
    return this.updateStatus(id, SupportStatus.COMPLETED, admin, trimmed);
  }

  // Cancellable by an admin, or by the supporter for their own non-financial offer while PENDING.
  async cancel(id: string, requestingUser: CurrentUserDto, reason?: string) {
    const support = await this.prisma.support.findUnique({
      where: { id },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    const roles = this.supportCommonService.getRoles(requestingUser);
    const actorType = resolveActorType(roles);
    const label = this.supportCommonService.buildSupportLabel(support);

    const isOwner = support.userId === requestingUser.id;
    const isAdmin = this.supportCommonService.isAdmin(requestingUser);

    if (!isOwner && !isAdmin) {
      this.supportCommonService.emitAudit({
        userId: requestingUser.id,
        targetUserId: support.userId,
        actorType,
        action: AuditEventEnum.SUPPORT_CANCELLED,
        outcome: AuditOutcome.DENIED,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        diff: { result: 'denied', reason: 'not_allowed_to_cancel_support' },
        metadata: {
          victimProfileId: support.victimProfileId,
          currentStatus: support.status,
        },
      });
      throw new ForbiddenException('not_allowed_to_cancel_support');
    }

    // A paid financial support cannot be cancelled by the supporter. A refund is a separate admin action.
    if (
      !isAdmin &&
      support.type === SupportType.FINANCIAL &&
      support.status !== SupportStatus.PENDING
    ) {
      this.supportCommonService.emitAudit({
        userId: requestingUser.id,
        actorType,
        action: AuditEventEnum.SUPPORT_CANCELLED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'cannot_cancel_financial_support',
          currentStatus: support.status,
        },
        metadata: { victimProfileId: support.victimProfileId },
      });
      throw new BadRequestException('cannot_cancel_financial_support');
    }

    // A supporter can only cancel a non-financial offer while it is still PENDING.
    if (
      !isAdmin &&
      support.status !== SupportStatus.PENDING &&
      support.status !== SupportStatus.CANCELLED
    ) {
      this.supportCommonService.emitAudit({
        userId: requestingUser.id,
        actorType,
        action: AuditEventEnum.SUPPORT_CANCELLED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'Support',
        entityId: support.id,
        entityLabel: label,
        diff: {
          result: 'failure',
          reason: 'cannot_cancel_confirmed_support',
          currentStatus: support.status,
        },
        metadata: { victimProfileId: support.victimProfileId },
      });
      throw new BadRequestException('cannot_cancel_confirmed_support');
    }

    return this.updateStatus(id, SupportStatus.CANCELLED, requestingUser, reason);
  }

  private httpMessage(e: unknown): string {
    if (e instanceof HttpException) {
      const r = e.getResponse();
      if (typeof r === 'string') return r;
      const m = (r as { message?: string | string[] }).message;
      return Array.isArray(m) ? m.join(', ') : (m ?? e.message);
    }
    return 'unexpected_error';
  }

  // SP-15. The offer is cancelled; the supporter is told, the stated reason stays with the team.
  async declineIncoming(id: string, user: CurrentUserDto, data: DeclineIncomingSupportDto) {
    const support = await this.supportCommonService.findAsRecipientOrThrow(id, user, 'not_allowed_to_decline_offer');
    if (support.type !== SupportType.NON_FINANCIAL) {
      throw new BadRequestException('only_non_financial_offers_can_be_declined');
    }
    if (support.status !== SupportStatus.CONFIRMED) {
      throw new BadRequestException('only_confirmed_offers_can_be_declined');
    }

    const reason = data.reason.trim();
    const cancelled = await this.updateStatus(
      id,
      SupportStatus.CANCELLED,
      user,
      `declined_by_recipient: ${reason}`,
    );

    await this.prisma.support.updateMany({
      where: { id, declinedAt: null },
      data: { declinedAt: new Date(), declineReason: reason, declinedByUserId: user.id },
    });

    this.supportCommonService.emitSupportAudit(user, AuditEventEnum.SUPPORT_DECLINED, support, {
      reason,
      diff: { result: 'success', currentStatus: cancelled.status },
      metadata: { victimProfileId: support.victimProfileId },
    });
    if (support.userId) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_OFFER_DECLINED, {
        userId: support.userId,
        supportId: id,
        victimProfileId: support.victimProfileId,
      });
    }

    return { id, status: cancelled.status, declined: true };
  }

  // SP-36. The outcome is applied to the offer where the move is allowed; otherwise it is only recorded.
  async resolveDispute(disputeId: string, admin: CurrentUserDto, data: ResolveSupportDisputeDto) {
    const dispute = await this.prisma.supportDispute.findUnique({
      where: { id: disputeId },
      select: {
        id: true,
        status: true,
        supportId: true,
        raisedByUserId: true,
        support: {
          select: {
            id: true,
            userId: true,
            type: true,
            status: true,
            victimProfileId: true,
            transferReference: true,
            victimProfile: { select: { claimedByUserId: true } },
          },
        },
      },
    });
    if (!dispute) throw new NotFoundException('dispute_not_found');
    if (dispute.status !== SupportDisputeStatus.OPEN) {
      throw new BadRequestException('dispute_already_resolved');
    }

    const reason = data.reason.trim();
    const support = dispute.support;
    let appliedStatus: SupportStatus | null = null;

    // Change the offer first: if the move is refused the dispute stays open.
    if (
      data.outcome === SupportDisputeOutcome.DELIVERED &&
      support.status === SupportStatus.CONFIRMED
    ) {
      appliedStatus = (await this.updateStatus(support.id, SupportStatus.COMPLETED, admin, reason))
        .status;
    } else if (
      data.outcome === SupportDisputeOutcome.NOT_DELIVERED &&
      this.isAdminTransitionAllowed(support.status, SupportStatus.FAILED, support.type)
    ) {
      appliedStatus = (await this.adminTransition(support.id, SupportStatus.FAILED, admin, reason))
        .status;
    } else if (
      data.outcome === SupportDisputeOutcome.CANCELLED &&
      this.isTransitionAllowed(support.status, SupportStatus.CANCELLED, support.type)
    ) {
      appliedStatus = (await this.updateStatus(support.id, SupportStatus.CANCELLED, admin, reason))
        .status;
    }

    const { count } = await this.prisma.supportDispute.updateMany({
      where: { id: disputeId, status: SupportDisputeStatus.OPEN },
      data: {
        status: SupportDisputeStatus.RESOLVED,
        outcome: data.outcome,
        resolutionReason: reason,
        resolvedByUserId: admin.id,
        resolvedAt: new Date(),
      },
    });
    if (count === 0) throw new BadRequestException('dispute_already_resolved');

    this.supportCommonService.emitSupportAudit(admin, AuditEventEnum.SUPPORT_DISPUTE_RESOLVED, support, {
      reason,
      diff: { result: 'success', disputeId, outcome: data.outcome, appliedStatus },
      metadata: { victimProfileId: support.victimProfileId },
    });

    const notify = new Set(
      [support.userId, support.victimProfile.claimedByUserId, dispute.raisedByUserId].filter(
        (v): v is string => Boolean(v),
      ),
    );
    for (const userId of notify) {
      this.eventEmitter.emit(NotificationEventEnum.SUPPORT_DISPUTE_RESOLVED, {
        userId,
        supportId: support.id,
        disputeId,
        outcome: data.outcome,
      });
    }

    const resolved = await this.prisma.supportDispute.findUniqueOrThrow({
      where: { id: disputeId },
      select: DISPUTE_SELECT,
    });
    return { ...resolved, appliedStatus };
  }

  // ═════════════════ admin: bulk and case management (SP-43 .. SP-54) ═════════════════

  private summariseBulk(results: Array<{ id: string; ok: boolean; error?: string }>) {
    const succeeded = results.filter((r) => r.ok).length;
    return { requested: results.length, succeeded, failed: results.length - succeeded, results };
  }

  // SP-43. Each offer goes through confirm(), so audit and notifications are the same as one by one.
  async bulkConfirm(admin: CurrentUserDto, data: BulkSupportIdsDto) {
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of [...new Set(data.ids)]) {
      try {
        const s = await this.prisma.support.findUnique({ where: { id }, select: { type: true } });
        if (!s) throw new NotFoundException('support_not_found');
        if (s.type !== SupportType.NON_FINANCIAL) {
          throw new BadRequestException('only_non_financial_offers_can_be_bulk_confirmed');
        }
        await this.confirm(id, admin);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: this.httpMessage(e) });
      }
    }
    return this.summariseBulk(results);
  }

  // SP-44
  async bulkCancel(admin: CurrentUserDto, data: BulkSupportReasonDto) {
    const reason = data.reason.trim();
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const id of [...new Set(data.ids)]) {
      try {
        await this.cancel(id, admin, reason);
        results.push({ id, ok: true });
      } catch (e) {
        results.push({ id, ok: false, error: this.httpMessage(e) });
      }
    }
    return this.summariseBulk(results);
  }

  // Moves that updateStatus() does not cover. Reopening is limited to non-financial offers so a
  // refunded or cancelled payment can never come back to life and change total raised by accident.
  private isAdminTransitionAllowed(
    from: SupportStatus,
    to: SupportStatus,
    type: SupportType,
  ): boolean {
    if (to === SupportStatus.FAILED) {
      return (
        from === SupportStatus.PENDING ||
        from === SupportStatus.CONFIRMED ||
        (from === SupportStatus.COMPLETED && type === SupportType.NON_FINANCIAL)
      );
    }
    if (to === SupportStatus.PENDING) {
      return (
        (from === SupportStatus.CANCELLED || from === SupportStatus.FAILED) &&
        type === SupportType.NON_FINANCIAL
      );
    }
    return false;
  }

  private async adminTransition(
    id: string,
    to: typeof SupportStatus.FAILED | typeof SupportStatus.PENDING,
    admin: CurrentUserDto,
    reason: string,
  ) {
    const support = await this.prisma.support.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        type: true,
        status: true,
        victimProfileId: true,
        amount: true,
        recipientAmount: true,
        transferReference: true,
      },
    });
    if (!support) throw new NotFoundException('support_not_found');

    const from = support.status;
    const action =
      to === SupportStatus.FAILED ? AuditEventEnum.SUPPORT_FAILED : AuditEventEnum.SUPPORT_REOPENED;

    if (from === to || !this.isAdminTransitionAllowed(from, to, support.type)) {
      this.supportCommonService.emitSupportAudit(admin, AuditEventEnum.SUPPORT_UPDATED, support, {
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        diff: {
          result: 'failure',
          reason: from === to ? 'support_already_has_status' : 'support_invalid_transition',
          currentStatus: from,
          attemptedStatus: to,
          type: support.type,
        },
      });
      throw new BadRequestException(
        from === to ? 'support_already_has_status' : 'support_invalid_transition',
      );
    }

    // A counted financial support that fails stops counting towards total raised.
    const amount = Number(support.recipientAmount ?? support.amount ?? 0);
    const wasCounted = support.type === SupportType.FINANCIAL && COUNTED_STATUSES.includes(from);
    const totalRaisedDelta = wasCounted && to === SupportStatus.FAILED ? -amount : 0;

    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.support.updateMany({
        where: { id, status: from },
        data: {
          status: to,
          ...(to === SupportStatus.PENDING
            ? {
                declinedAt: null,
                declineReason: null,
                declinedByUserId: null,
                recipientOpenedAt: null,
              }
            : {}),
        },
      });
      if (result.count === 0) return null;

      if (totalRaisedDelta !== 0) {
        await tx.victimProfile.update({
          where: { id: support.victimProfileId },
          data: { totalRaised: { increment: totalRaisedDelta } },
        });
      }
      return tx.support.findUniqueOrThrow({ where: { id }, select: SUPPORT_OWNER_SELECT });
    });

    if (!updated) {
      this.supportCommonService.emitSupportAudit(admin, AuditEventEnum.SUPPORT_UPDATED, support, {
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        diff: {
          result: 'failure',
          reason: 'support_transition_conflict',
          expectedStatus: from,
          attemptedStatus: to,
        },
      });
      throw new BadRequestException('support_transition_conflict');
    }

    this.supportCommonService.emitSupportAudit(admin, action, support, {
      reason,
      diff: { result: 'success', previousStatus: from, currentStatus: updated.status },
      metadata: {
        victimProfileId: support.victimProfileId,
        type: support.type,
        amount,
        totalRaisedDelta,
      },
    });

    if (support.userId) {
      this.eventEmitter.emit(
        to === SupportStatus.FAILED
          ? NotificationEventEnum.SUPPORT_OFFER_FAILED
          : NotificationEventEnum.SUPPORT_OFFER_REOPENED,
        { userId: support.userId, supportId: id, victimProfileId: support.victimProfileId },
      );
    }
    return updated;
  }

  // SP-46
  async markFailed(id: string, admin: CurrentUserDto, data: SupportReasonDto) {
    return this.adminTransition(id, SupportStatus.FAILED, admin, data.reason.trim());
  }

  // SP-47
  async reopen(id: string, admin: CurrentUserDto, data: SupportReasonDto) {
    return this.adminTransition(id, SupportStatus.PENDING, admin, data.reason.trim());
  }

  // SP-49
  async getTransitions(id: string, admin: CurrentUserDto) {
    void admin;
    const support = await this.supportCommonService.findSupportOrThrow(id);
    const { status: from, type } = support;

    const allowed: Array<{
      to: SupportStatus;
      action: string;
      method: string;
      path: string;
      requires: string[];
    }> = [];
    const add = (to: SupportStatus, action: string, path: string, requires: string[]) =>
      allowed.push({ to, action, method: 'PATCH', path: `/support/${id}/${path}`, requires });

    if (
      type === SupportType.NON_FINANCIAL &&
      this.isTransitionAllowed(from, SupportStatus.CONFIRMED, type)
    ) {
      add(SupportStatus.CONFIRMED, 'confirm', 'confirm', []);
    }
    if (this.isTransitionAllowed(from, SupportStatus.COMPLETED, type)) {
      add(SupportStatus.COMPLETED, 'complete', 'complete', ['note']);
    }
    if (this.isTransitionAllowed(from, SupportStatus.CANCELLED, type)) {
      add(SupportStatus.CANCELLED, 'cancel', 'cancel', []);
    }
    if (this.isAdminTransitionAllowed(from, SupportStatus.FAILED, type)) {
      add(SupportStatus.FAILED, 'mark-failed', 'mark-failed', ['reason']);
    }
    if (this.isAdminTransitionAllowed(from, SupportStatus.PENDING, type)) {
      add(SupportStatus.PENDING, 'reopen', 'reopen', ['reason']);
    }

    return { supportId: id, currentStatus: from, type, allowed };
  }
}
