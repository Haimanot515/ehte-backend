import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import { AuditOutcome, AuditSeverity, SupportStatus } from '@prisma/client';

import { EventEmitter2 } from '@nestjs/event-emitter';

import { PrismaService } from 'src/prisma/prisma.service';

import { CurrentUserDto } from 'src/common/dtos/current-user.dto';

import { resolveActorType } from 'src/common/utils/actor-type.util';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from 'src/modules/misc/events/audit.events';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { RolesEnum } from 'src/common/enums/roles.enum';

import { CreateSupportDto } from '../dto/support.dto';

const ADMIN_ROLE_NAMES = [RolesEnum.ADMIN, RolesEnum.SUPER_ADMIN];

@Injectable()
export class SupportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // ─────────────────────────────────────────────
  // AUDIT HELPER
  //
  // FIX (audit review): every call site previously built an
  // AuditEventPayload inline and emitted it with
  // `this.eventEmitter.emit(AuditEventEnum.X, payload)` — which meant
  // the action name was written twice per call site and could drift
  // apart. Mirrors ReportService/PostService: the payload carries the
  // action, and emitAudit() derives the channel from it.
  // ─────────────────────────────────────────────

  private emitAudit(payload: AuditEventPayload): void {
    this.eventEmitter.emit(payload.action, payload);
  }

  private getRoles(user: CurrentUserDto): string[] {
    return (
      (
        user as unknown as {
          roles?: string[];
        }
      ).roles ?? []
    );
  }

  private isAdmin(user: CurrentUserDto): boolean {
    return this.getRoles(user).some((name) => ADMIN_ROLE_NAMES.includes(name as RolesEnum));
  }

  // ─────────────────────────────────────────────
  // ENTITY LABEL
  //
  // FIX (audit review, item #4): not one audit row in this service
  // carried an entityLabel, so an audit list showed nothing but a
  // bare Support uuid — with no way to tell which transfer a row is
  // about without joining back to the supports table.
  //
  // Support has no case-reference-style field the way Report does, so
  // transferReference (the off-platform bank/mobile-money reference
  // the payer supplies) is the closest human-meaningful identifier —
  // it's exactly what an admin verifying a transfer searches by. It's
  // optional, so a short id prefix is the fallback.
  //
  // NOTE: if your Support model gains a human reference of its own
  // (e.g. SUP-2026-XXXXXX, the way Report has caseReference), switch
  // this over to it — that would be strictly better than a uuid
  // prefix.
  // ─────────────────────────────────────────────

  private buildSupportLabel(support: { id: string; transferReference: string | null }): string {
    return support.transferReference ?? `support:${support.id.slice(0, 8)}`;
  }

  // ─────────────────────────────────────────────
  // CREATE SUPPORT
  //
  // FIX (money-collected addition, notification correction): this
  // previously emitted a "payment confirmed"-shaped notification at
  // creation time, even though a brand-new support is PENDING and
  // hasn't been verified by anyone. Now emits SUPPORT_PLEDGE_CREATED
  // instead — SUPPORT_PAYMENT_CONFIRMED is reserved solely for the
  // CONFIRMED transition in updateStatus() below.
  //
  // FIX (audit review, item #1): the two *post-lookup* guards here —
  // profile not available for support, and a breakdown that doesn't
  // add up to the total — both threw with no audit row at all. The
  // second one in particular is a money-integrity signal worth
  // tracing (someone submitting a breakdown that doesn't reconcile,
  // repeatedly, is exactly the pattern you'd want visible). There's
  // no Support row yet at that point, but there IS a VictimProfile to
  // hang the row off, so both now emit a FAILURE row against
  // entity: 'VictimProfile' before throwing.
  //
  // NOTE (audit review, item #1 — deliberately NOT fixed): the
  // victim_profile_not_found branch above them still throws without a
  // row, for the same reason create() in ReportService does — there
  // is no entity to attach it to (the id the client sent doesn't
  // resolve to anything). Closing that needs a schema/product call on
  // nullable entityIds, not a guess made here.
  //
  // FIX (audit review, item #4): entityLabel added throughout.
  //
  // FIX (audit review, item #5): amount, the full breakdown, and the
  // target victimProfileId are the investigative context you actually
  // want on a money row, and none of it was captured anywhere —
  // the old diff only recorded status/type/agreementType. Amounts are
  // not a "diff" of anything (nothing changed — the row was just
  // created), so they go in metadata.
  // ─────────────────────────────────────────────

  async create(user: CurrentUserDto, data: CreateSupportDto) {
    const roles = this.getRoles(user);
    const actorType = resolveActorType(roles);

    const victimProfile = await this.prisma.victimProfile.findUnique({
      where: { id: data.victimProfileId },
    });

    if (!victimProfile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    if (victimProfile.status !== 'PUBLISHED' || !victimProfile.isPublished) {
      this.emitAudit({
        userId: user.id,
        actorType,
        action: AuditEventEnum.SUPPORT_CREATED,
        outcome: AuditOutcome.FAILURE,
        severity: AuditSeverity.WARNING,
        entity: 'VictimProfile',
        entityId: victimProfile.id,
        // NOTE: swap in the profile's display-name field here if it
        // has one (fullName/title/etc.) — left off rather than
        // guessing at a column that may not exist.
        diff: {
          result: 'failure',
          reason: 'victim_profile_not_available_for_support',
          profileStatus: victimProfile.status,
          isPublished: victimProfile.isPublished,
        },
        metadata: { amount: data.amount },
      });
      throw new BadRequestException('victim_profile_not_available_for_support');
    }

    // If a breakdown is provided, it must add up to the total —
    // this is what the payer sees before transferring money.
    const breakdownProvided =
      data.recipientAmount !== undefined ||
      data.organizationAmount !== undefined ||
      data.platformAmount !== undefined;

    if (breakdownProvided) {
      const sum =
        (data.recipientAmount ?? 0) + (data.organizationAmount ?? 0) + (data.platformAmount ?? 0);

      // Guard against floating point noise.
      if (Math.abs(sum - data.amount) > 0.01) {
        this.emitAudit({
          userId: user.id,
          actorType,
          action: AuditEventEnum.SUPPORT_CREATED,
          outcome: AuditOutcome.FAILURE,
          severity: AuditSeverity.WARNING,
          entity: 'VictimProfile',
          entityId: victimProfile.id,
          diff: {
            result: 'failure',
            reason: 'support_breakdown_does_not_match_amount',
          },
          metadata: {
            amount: data.amount,
            breakdownSum: sum,
            recipientAmount: data.recipientAmount ?? null,
            organizationAmount: data.organizationAmount ?? null,
            platformAmount: data.platformAmount ?? null,
          },
        });
        throw new BadRequestException('support_breakdown_does_not_match_amount');
      }
    }

    const support = await this.prisma.support.create({
      data: {
        victimProfileId: data.victimProfileId,

        userId: user.id,

        type: data.type ?? 'FINANCIAL',
        agreementType: data.agreementType ?? 'DIRECT',

        amount: data.amount,

        recipientAmount: data.recipientAmount,
        organizationAmount: data.organizationAmount,
        platformAmount: data.platformAmount,

        transferReference: data.transferReference,
        message: data.message,

        status: SupportStatus.PENDING,
      },
    });

    this.emitAudit({
      userId: user.id,
      actorType,
      action: AuditEventEnum.SUPPORT_CREATED,
      entity: 'Support',
      entityId: support.id,
      entityLabel: this.buildSupportLabel(support),

      // FIX (audit review, item #3): data.message is the supporter's
      // own human-written note attached to the pledge — the one piece
      // of free text a human wrote about this action. Promoted out of
      // the row's guts into the top-level reason column so it's
      // readable without expanding JSON.
      reason: data.message ?? null,

      diff: {
        result: 'success',
        status: support.status,
        type: support.type,
        agreementType: support.agreementType,
      },

      metadata: {
        victimProfileId: support.victimProfileId,
        amount: Number(support.amount ?? 0),
        recipientAmount: support.recipientAmount ?? null,
        organizationAmount: support.organizationAmount ?? null,
        platformAmount: support.platformAmount ?? null,
        transferReference: support.transferReference ?? null,
      },
    });

    // FIX: was firing as if payment were confirmed at creation time,
    // which is misleading — a PENDING support hasn't been confirmed
    // by anyone yet. This now signals "pledge recorded, pending
    // verification" instead; SUPPORT_PAYMENT_CONFIRMED fires only
    // from the CONFIRMED transition in updateStatus() below.
    this.eventEmitter.emit(NotificationEventEnum.SUPPORT_PLEDGE_CREATED, {
      supportId: support.id,
      userId: support.userId,
      victimProfileId: support.victimProfileId,
    });

    return support;
  }

  // ─────────────────────────────────────────────
  // MY SUPPORT REQUESTS
  // ─────────────────────────────────────────────

  async findMine(user: CurrentUserDto) {
    return this.prisma.support.findMany({
      where: { userId: user.id },

      include: { victimProfile: true },

      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // SUPPORT FOR VICTIM PROFILE
  // ─────────────────────────────────────────────

  async findForVictimProfile(victimProfileId: string) {
    return this.prisma.support.findMany({
      where: { victimProfileId },

      orderBy: { createdAt: 'desc' },
    });
  }

  // ─────────────────────────────────────────────
  // GET ONE SUPPORT
  // ─────────────────────────────────────────────

  async findOne(id: string) {
    const support = await this.prisma.support.findUnique({
      where: { id },

      include: {
        victimProfile: true,
        user: true,
      },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    return support;
  }

  // ─────────────────────────────────────────────
  // UPDATE STATUS (internal — callers below enforce who's allowed)
  //
  // FIX (money-collected addition): a status transition that crosses
  // into or out of SupportStatus.CONFIRMED now keeps
  // VictimProfile.totalRaised in sync, atomically, in the same
  // transaction as the status write.
  //
  // Counting rule (deliberately simple, not abstracted): a support
  // counts toward totalRaised strictly while status === CONFIRMED.
  // Moving to COMPLETED, CANCELLED, or FAILED all remove it from the
  // total the same way — see the module-level note in
  // VictimProfileService for why this isn't pulled into a shared
  // helper yet.
  //
  // FIX (audit review, item #2 — the significant one): every status
  // row emitted from here recorded `userId: support.userId` — the
  // *supporter*, i.e. the person the action was done TO — as the
  // actor, with `actorType: resolveActorType([])` hardcoding an
  // empty role list on top of it. So an admin confirming or
  // cancelling someone else's payment produced a row that reads as
  // though the supporter did it themselves, attributed to a roleless
  // actor. On a money trail that is the one field you cannot afford
  // to have wrong.
  //
  //   - actor  -> userId       (the admin, or the supporter cancelling
  //                             their own pledge)
  //   - subject -> targetUserId (the supporter whose money this is),
  //                             set only when actor !== supporter, so
  //                             a genuine self-cancel isn't recorded
  //                             as an action against someone else
  //   - actorType -> resolved from the ACTOR's real roles
  //
  // This required threading the acting user through confirm() /
  // complete() / cancel(). ⚠️ BREAKING (small): confirm() and
  // complete() now take the CurrentUserDto — the controllers must
  // pass @CurrentUser() through. Without it there is no honest way to
  // record who verified the transfer.
  //
  // FIX (audit review, item #1): support_already_has_status threw
  // with no row, and the read-then-write below could silently
  // double-count totalRaised under two concurrent admins (see the
  // concurrency fix). Both failure paths now emit FAILURE first.
  //
  // FIX (item #22/#26, concurrency): the status write is now a
  // conditional updateMany guarded on the status read a moment
  // earlier, inside an interactive transaction with the totalRaised
  // increment — same discipline as ReportService.updateStatus. Before
  // this, two admins racing PENDING -> CONFIRMED could both pass the
  // read and both apply +amount to the profile's totalRaised, quietly
  // inflating the public figure. The loser now gets
  // support_transition_conflict.
  //
  // FIX (audit review, item #3): an optional human-written reason
  // (cancellation reason, verification note) is now threaded through
  // and lands in the top-level reason column rather than nowhere.
  //
  // FIX (audit review, item #5): totalRaisedDelta and victimProfileId
  // moved out of diff into metadata — diff should describe the change
  // to *this* entity (the Support's status), and the delta is a
  // side-effect on a different row entirely.
  // ─────────────────────────────────────────────

  private async updateStatus(
    id: string,
    status: SupportStatus,
    actor: CurrentUserDto,
    reason?: string,
  ) {
    const actorRoles = this.getRoles(actor);
    const actorType = resolveActorType(actorRoles);

    const support = await this.prisma.support.findUnique({
      where: { id },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    const previousStatus = support.status;
    const label = this.buildSupportLabel(support);

    // Only set when the actor is someone other than the supporter —
    // a supporter cancelling their own pledge is a self-action, not
    // an action taken against another user.
    const targetUserFields =
      actor.id === support.userId ? {} : { targetUserId: support.userId };

    if (previousStatus === status) {
      this.emitAudit({
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

    const wasCounted = previousStatus === SupportStatus.CONFIRMED;
    const isCounted = status === SupportStatus.CONFIRMED;
    const amount = Number(support.recipientAmount ?? support.amount ?? 0);

    // Only non-zero when the support is entering or leaving CONFIRMED.
    // E.g. PENDING -> CONFIRMED: +amount.
    //      CONFIRMED -> COMPLETED: -amount (per the strict rule above).
    //      CONFIRMED -> CANCELLED: -amount.
    //      COMPLETED -> CANCELLED: 0 (wasn't counted, still isn't).
    let totalRaisedDelta = 0;
    if (!wasCounted && isCounted) totalRaisedDelta = amount;
    if (wasCounted && !isCounted) totalRaisedDelta = -amount;

    // Returns null (rather than throwing) when the guarded update
    // matches nothing, so the transaction commits as a no-op instead
    // of rolling back — there's nothing to roll back, and the audit
    // row for the loss belongs outside the transaction anyway.
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

      return tx.support.findUniqueOrThrow({ where: { id } });
    });

    if (!updatedSupport) {
      this.emitAudit({
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
      this.emitAudit({
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
          amount,
          totalRaisedDelta,
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

    return updatedSupport;
  }

  // ─────────────────────────────────────────────
  // CONFIRM — admin only (controller enforces @Roles)
  // Represents an admin verifying the off-platform transfer arrived.
  //
  // ⚠️ SIGNATURE CHANGE: takes the acting admin so the audit row
  // records who actually verified the money, and an optional
  // verification note that lands in the audit reason column. Update
  // the controller to pass @CurrentUser() (and the note from the body
  // if you add one).
  // ─────────────────────────────────────────────

  async confirm(id: string, admin: CurrentUserDto, reason?: string) {
    return this.updateStatus(id, SupportStatus.CONFIRMED, admin, reason);
  }

  // ─────────────────────────────────────────────
  // COMPLETE — admin only (controller enforces @Roles)
  //
  // ⚠️ SIGNATURE CHANGE: same as confirm() above.
  // ─────────────────────────────────────────────

  async complete(id: string, admin: CurrentUserDto, reason?: string) {
    return this.updateStatus(id, SupportStatus.COMPLETED, admin, reason);
  }

  // ─────────────────────────────────────────────
  // CANCEL — the support's own creator, or an admin
  //
  // FIX (audit review, item #1): both guards here threw silently.
  // A ForbiddenException on a money record — someone attempting to
  // cancel a support that is neither theirs nor within their admin
  // remit — is precisely the event an audit log exists for, and it
  // previously left no trace whatsoever. Both now emit before
  // throwing: DENIED/WARNING for the authorization failure,
  // FAILURE/WARNING for the "confirmed, so a non-admin can't cancel"
  // business-rule failure.
  //
  // FIX (audit review, item #2): on the denied path the support's
  // owner is recorded as targetUserId — the whole point of that row
  // is "user A tried to touch user B's payment record."
  //
  // FIX (audit review, item #3): an optional cancellation reason is
  // accepted and forwarded to updateStatus, where it lands in the
  // top-level reason column. ⚠️ The controller needs to pass it
  // through from the request body for it to ever be populated; the
  // parameter is optional so existing callers still compile.
  //
  // NOTE (not changed): a COMPLETED support can still be cancelled by
  // its owner. Whether that should be allowed is a product decision,
  // not one to slip in under an audit pass — flagging it rather than
  // silently tightening the rule.
  // ─────────────────────────────────────────────

  async cancel(id: string, requestingUser: CurrentUserDto, reason?: string) {
    const support = await this.prisma.support.findUnique({
      where: { id },
    });

    if (!support) {
      throw new NotFoundException('support_not_found');
    }

    const roles = this.getRoles(requestingUser);
    const actorType = resolveActorType(roles);
    const label = this.buildSupportLabel(support);

    const isOwner = support.userId === requestingUser.id;
    const isAdmin = this.isAdmin(requestingUser);

    if (!isOwner && !isAdmin) {
      this.emitAudit({
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

    // Once an admin has confirmed money arrived, a supporter
    // shouldn't be able to unilaterally cancel that record.
    if (support.status === SupportStatus.CONFIRMED && !isAdmin) {
      this.emitAudit({
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
}