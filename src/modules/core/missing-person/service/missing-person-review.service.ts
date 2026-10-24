import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  AuditOutcome,
  AuditSeverity,
  MissingPersonStatus,
  MissingPersonType,
  Prisma,
} from '@prisma/client';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { PaginationQueryDto } from '../dto/missing-person.dto';
import {
  MissingPersonAuditRef,
  TERMINAL_STATUSES,
  BulkResult,
  ALLOWED_TRANSITIONS,
  ADMIN_BASE_WHERE,
} from './missing-person.constants';
import { MissingPersonCommonService } from './missing-person-common.service';

@Injectable()
export class MissingPersonReviewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly configService: ConfigService,
    private readonly cache: CacheService,
    private readonly missingPersonCommonService: MissingPersonCommonService,
  ) {}

  private auditEventForStatus(status: MissingPersonStatus): AuditEventEnum {
    switch (status) {
      case MissingPersonStatus.APPROVED:
        return AuditEventEnum.MISSING_PERSON_APPROVED;
      case MissingPersonStatus.REJECTED:
        return AuditEventEnum.MISSING_PERSON_REJECTED;
      case MissingPersonStatus.FOUND:
        return AuditEventEnum.MISSING_PERSON_FOUND;
      case MissingPersonStatus.MORE_INFORMATION_REQUESTED:
        return AuditEventEnum.MISSING_PERSON_MORE_INFO_REQUESTED;
      default:
        return AuditEventEnum.MISSING_PERSON_UPDATED;
    }
  }

  async claimMissingPerson(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }
    this.missingPersonCommonService.assertNotClaimedByOther(
      admin,
      existing,
      AuditEventEnum.MISSING_PERSON_UPDATED,
    );

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { claimedByUserId: admin.id, claimedAt: new Date() },
    });

    this.missingPersonCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: id,
      entityLabel: this.missingPersonCommonService.caseLabel(updated),
      diff: { claimedBy: admin.id, result: 'success' },
      metadata: { operation: 'claim' },
    });

    return updated;
  }

  async unclaimMissingPerson(admin: CurrentUserDto, id: string) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });
    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }
    this.missingPersonCommonService.assertNotClaimedByOther(
      admin,
      existing,
      AuditEventEnum.MISSING_PERSON_UPDATED,
    );

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { claimedByUserId: null, claimedAt: null },
    });

    this.missingPersonCommonService.emitAudit({
      userId: admin.id,
      actorType: resolveActorType(admin.roles ?? []),
      action: AuditEventEnum.MISSING_PERSON_UPDATED,
      entity: 'MissingPerson',
      entityId: id,
      entityLabel: this.missingPersonCommonService.caseLabel(updated),
      diff: { unclaimedBy: admin.id, result: 'success' },
      metadata: { operation: 'unclaim' },
    });

    return updated;
  }

  // CHILD approval needs confirmation from two different admins.
  private async ensureChildSafetySatisfied(
    missingPerson: MissingPersonAuditRef & { childSafetyFirstConfirmedByUserId: string | null },
    admin: CurrentUserDto,
    confirmed: boolean | undefined,
  ): Promise<'not_required' | 'first_confirmation_recorded' | 'satisfied'> {
    if (missingPerson.personType !== MissingPersonType.CHILD) return 'not_required';

    if (confirmed !== true) {
      this.missingPersonCommonService.emitCaseFailure(
        admin,
        AuditEventEnum.MISSING_PERSON_APPROVED,
        missingPerson,
        'child_safety_confirmation_required',
      );
      throw new BadRequestException('child_safety_confirmation_required');
    }

    if (!missingPerson.childSafetyFirstConfirmedByUserId) {
      await this.prisma.missingPerson.update({
        where: { id: missingPerson.id },
        data: {
          childSafetyFirstConfirmedByUserId: admin.id,
          childSafetyFirstConfirmedAt: new Date(),
        },
      });
      return 'first_confirmation_recorded';
    }

    if (missingPerson.childSafetyFirstConfirmedByUserId === admin.id) {
      this.missingPersonCommonService.emitCaseFailure(
        admin,
        AuditEventEnum.MISSING_PERSON_APPROVED,
        missingPerson,
        'child_safety_requires_second_distinct_admin',
        {
          outcome: AuditOutcome.DENIED,
          metadata: { firstConfirmedBy: missingPerson.childSafetyFirstConfirmedByUserId },
        },
      );
      throw new BadRequestException('child_safety_requires_second_distinct_admin');
    }

    return 'satisfied';
  }

  // Audit flag only; never blocks or rejects anything.
  private async maybeFlagUserForRejections(userId: string): Promise<void> {
    const threshold = Number(
      this.configService.get<string>('MISSING_PERSON_AUTO_FLAG_REJECTION_COUNT') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_REJECTION_COUNT') ??
        3,
    );
    const windowDays = Number(
      this.configService.get<string>('MISSING_PERSON_AUTO_FLAG_WINDOW_DAYS') ??
        this.configService.get<string>('CONTENT_AUTO_FLAG_WINDOW_DAYS') ??
        7,
    );
    const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);

    const recentRejections = await this.prisma.missingPerson.count({
      where: { userId, status: MissingPersonStatus.REJECTED, updatedAt: { gte: since } },
    });

    if (recentRejections >= threshold) {
      const flaggedUser = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { name: true },
      });

      this.missingPersonCommonService.emitAudit({
        targetUserId: userId,
        actorType: 'SYSTEM',
        action: AuditEventEnum.USER_AUTO_FLAGGED,
        entity: 'User',
        entityId: userId,
        entityLabel: flaggedUser?.name ?? undefined,
        diff: {
          reason: 'repeated_missing_person_rejections',
          rejectionCount: recentRejections,
          windowDays,
          result: 'flagged_for_review',
        },
      });
    }
  }

  // Informational only; nothing here changes status, ownership or claim.
  async findStalePending() {
    const staleHours = Number(
      this.configService.get<string>('MISSING_PERSON_STALE_PENDING_HOURS') ??
        this.configService.get<string>('CONTENT_STALE_PENDING_HOURS') ??
        48,
    );
    const cutoff = new Date(Date.now() - staleHours * 60 * 60 * 1000);

    const items = await this.prisma.missingPerson.findMany({
      where: {
        status: { notIn: TERMINAL_STATUSES },
        createdAt: { lt: cutoff },
      },
      orderBy: { createdAt: 'asc' },
    });

    return items.map((item) => ({
      ...item,
      pendingHours: Math.floor((Date.now() - item.createdAt.getTime()) / (60 * 60 * 1000)),
    }));
  }

  async updateStatus(
    admin: CurrentUserDto,
    id: string,
    status: MissingPersonStatus,
    reviewNote?: string,
    childSafetyConfirmed?: boolean,
  ) {
    const existing = await this.prisma.missingPerson.findUnique({ where: { id } });

    if (!existing) {
      throw new NotFoundException('missing_person_not_found');
    }

    if (existing.status === status) {
      return existing;
    }

    const auditEvent = this.auditEventForStatus(status);

    this.missingPersonCommonService.assertNotClaimedByOther(admin, existing, auditEvent);

    const allowedNext = ALLOWED_TRANSITIONS[existing.status] ?? [];

    if (!allowedNext.includes(status)) {
      this.missingPersonCommonService.emitCaseFailure(
        admin,
        auditEvent,
        existing,
        'invalid_status_transition',
        {
          diff: { attemptedStatus: status, currentStatus: existing.status },
        },
      );
      throw new BadRequestException(`invalid_status_transition: ${existing.status} -> ${status}`);
    }

    if (
      (status === MissingPersonStatus.REJECTED ||
        status === MissingPersonStatus.MORE_INFORMATION_REQUESTED) &&
      !reviewNote?.trim()
    ) {
      this.missingPersonCommonService.emitCaseFailure(
        admin,
        auditEvent,
        existing,
        'review_note_required_for_this_status',
        {
          diff: { attemptedStatus: status, currentStatus: existing.status },
        },
      );
      throw new BadRequestException('review_note_required_for_this_status');
    }

    const isChildApproval =
      status === MissingPersonStatus.APPROVED && existing.personType === MissingPersonType.CHILD;

    if (isChildApproval) {
      const safety = await this.ensureChildSafetySatisfied(existing, admin, childSafetyConfirmed);
      if (safety === 'first_confirmation_recorded') {
        // Not yet APPROVED — nothing public changes, so no cache invalidation here.
        const partial = await this.prisma.missingPerson.findUniqueOrThrow({ where: { id } });
        this.missingPersonCommonService.emitAudit({
          userId: admin.id,
          ...this.missingPersonCommonService.targetUserFor(admin, existing),
          actorType: resolveActorType(admin.roles ?? []),
          action: AuditEventEnum.MISSING_PERSON_UPDATED,
          entity: 'MissingPerson',
          entityId: id,
          entityLabel: this.missingPersonCommonService.caseLabel(existing),
          reason: reviewNote ?? null,
          diff: {
            childSafetyFirstConfirmationBy: admin.id,
            result: 'pending_second_admin_confirmation',
          },
          metadata: { operation: 'child_safety_first_confirmation' },
        });
        return { ...partial, pendingSecondConfirmation: true };
      }
    }

    const result = await this.prisma.missingPerson.updateMany({
      where: { id, status: existing.status },
      data: {
        status,
        ...(reviewNote !== undefined ? { reviewNote } : {}),
        claimedByUserId: null,
        claimedAt: null,
      },
    });

    if (result.count === 0) {
      this.missingPersonCommonService.emitCaseFailure(
        admin,
        auditEvent,
        existing,
        'missing_person_transition_conflict',
        {
          diff: { attemptedStatus: status, currentStatus: existing.status },
        },
      );
      throw new BadRequestException('missing_person_transition_conflict');
    }

    const updated = await this.prisma.missingPerson.findUniqueOrThrow({ where: { id } });

    await this.cache.invalidateMissingPersonEverywhere(id);

    this.missingPersonCommonService.emitAudit({
      userId: admin.id,
      ...this.missingPersonCommonService.targetUserFor(admin, existing),
      actorType: resolveActorType(admin.roles ?? []),
      action: auditEvent,
      entity: 'MissingPerson',
      entityId: updated.id,
      entityLabel: this.missingPersonCommonService.caseLabel(updated),
      reason: reviewNote ?? null,
      diff: {
        previousStatus: existing.status,
        newStatus: updated.status,
        ...(isChildApproval ? { childSafetyDualControlSatisfied: true } : {}),
        result: 'success',
      },
      metadata: {
        claimReleased: existing.claimedByUserId !== null,
        ...(isChildApproval
          ? {
              childSafetyFirstConfirmedBy: existing.childSafetyFirstConfirmedByUserId,
              childSafetySecondConfirmedBy: admin.id,
            }
          : {}),
      },
    });

    let notificationEvent: NotificationEventEnum;

    switch (status) {
      case MissingPersonStatus.APPROVED:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_APPROVED;
        break;

      case MissingPersonStatus.REJECTED:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_REJECTED;
        break;

      case MissingPersonStatus.FOUND:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_FOUND;
        break;

      case MissingPersonStatus.MORE_INFORMATION_REQUESTED:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_MORE_INFORMATION_REQUESTED;
        break;

      default:
        notificationEvent = NotificationEventEnum.MISSING_PERSON_UPDATED;
        break;
    }

    this.eventEmitter.emit(notificationEvent, {
      userId: existing.userId,
      missingPersonId: updated.id,
      previousStatus: existing.status,
      status: updated.status,
      reviewNote,
    });

    if (status === MissingPersonStatus.REJECTED && existing.userId) {
      await this.maybeFlagUserForRejections(existing.userId);
    }

    return updated;
  }

  private async assertAssignable(adminId: string): Promise<void> {
    const target = await this.prisma.user.findUnique({
      where: { id: adminId },
      select: {
        id: true,
        isActive: true,
        userRoles: { select: { role: { select: { name: true } } } },
      },
    });
    if (!target) throw new NotFoundException('assignee_not_found');
    if (!target.isActive) throw new BadRequestException('assignee_inactive');

    const roleNames = target.userRoles.map((ur) => ur.role.name);
    if (!roleNames.includes(RolesEnum.ADMIN) && !roleNames.includes(RolesEnum.SUPER_ADMIN)) {
      throw new BadRequestException('assignee_must_be_an_admin');
    }
  }

  async assign(admin: CurrentUserDto, id: string, assigneeId: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    await this.assertAssignable(assigneeId);

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { assignedToUserId: assigneeId, assignedById: admin.id, assignedAt: new Date() },
    });

    this.missingPersonCommonService.auditOp(admin, updated, 'assign', {
      previousAssignee: existing.assignedToUserId,
      assignedTo: assigneeId,
    });
    return updated;
  }

  async unassign(admin: CurrentUserDto, id: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { assignedToUserId: null, assignedById: null, assignedAt: null },
    });
    this.missingPersonCommonService.auditOp(admin, updated, 'unassign', {
      previousAssignee: existing.assignedToUserId,
    });
    return updated;
  }

  async bulkAssign(admin: CurrentUserDto, ids: string[], assigneeId: string): Promise<BulkResult> {
    await this.assertAssignable(assigneeId);
    return this.runBulk(ids, async (id) => {
      await this.assign(admin, id, assigneeId);
    });
  }

  private async runBulk(ids: string[], fn: (id: string) => Promise<void>): Promise<BulkResult> {
    const result: BulkResult = { succeeded: [], failed: [] };
    for (const id of [...new Set(ids)]) {
      try {
        await fn(id);
        result.succeeded.push(id);
      } catch (err) {
        const reason =
          err instanceof Error ? err.message : typeof err === 'string' ? err : 'unknown_error';
        result.failed.push({ id, reason });
      }
    }
    return result;
  }

  // PENDING has to pass through UNDER_REVIEW before any decision.
  private async moveToUnderReview(admin: CurrentUserDto, id: string, status: MissingPersonStatus) {
    if (status === MissingPersonStatus.PENDING) {
      await this.updateStatus(admin, id, MissingPersonStatus.UNDER_REVIEW);
    }
  }

  async bulkApprove(admin: CurrentUserDto, ids: string[]): Promise<BulkResult> {
    return this.runBulk(ids, async (id) => {
      const existing = await this.missingPersonCommonService.loadCase(id);
      if (existing.personType === MissingPersonType.CHILD) {
        throw new BadRequestException('child_cases_need_individual_dual_confirmation');
      }
      if (existing.deletedAt || existing.mergedIntoId) {
        throw new BadRequestException('case_not_available');
      }
      await this.moveToUnderReview(admin, id, existing.status);
      await this.updateStatus(admin, id, MissingPersonStatus.APPROVED);
    });
  }

  async bulkReject(admin: CurrentUserDto, ids: string[], reviewNote: string): Promise<BulkResult> {
    return this.runBulk(ids, async (id) => {
      const existing = await this.missingPersonCommonService.loadCase(id);
      if (existing.deletedAt || existing.mergedIntoId) {
        throw new BadRequestException('case_not_available');
      }
      await this.moveToUnderReview(admin, id, existing.status);
      await this.updateStatus(admin, id, MissingPersonStatus.REJECTED, reviewNote);
    });
  }

  async bulkExpire(admin: CurrentUserDto, ids: string[], reason: string): Promise<BulkResult> {
    return this.runBulk(ids, async (id) => {
      const existing = await this.missingPersonCommonService.loadCase(id);
      if (existing.legalHold) throw new ConflictException('case_under_legal_hold');
      await this.updateStatus(admin, id, MissingPersonStatus.EXPIRED, reason);
      await this.prisma.missingPerson.update({
        where: { id },
        data: { closureReason: reason, closedAt: new Date() },
      });
    });
  }

  async listFoundClaims(query: PaginationQueryDto) {
    const { page, limit, skip } = this.missingPersonCommonService.pageArgs(query);
    const where: Prisma.MissingPersonWhereInput = {
      ...ADMIN_BASE_WHERE,
      status: MissingPersonStatus.APPROVED,
      foundReportedAt: { not: null },
      foundReportResolvedAt: null,
    };

    const [data, total] = await this.prisma.$transaction([
      this.prisma.missingPerson.findMany({
        where,
        orderBy: { foundReportedAt: 'asc' },
        skip,
        take: limit,
        select: {
          id: true,
          name: true,
          personType: true,
          lastKnownArea: true,
          foundReportedAt: true,
          foundReportDetails: true,
          foundReportDate: true,
          foundReportLocation: true,
          userId: true,
          claimedByUserId: true,
          assignedToUserId: true,
        },
      }),
      this.prisma.missingPerson.count({ where }),
    ]);
    return { data, meta: this.missingPersonCommonService.pageMeta(page, limit, total) };
  }

  async verifyFound(admin: CurrentUserDto, id: string, confirmed: boolean, reviewNote?: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    if (!existing.foundReportedAt || existing.foundReportResolvedAt) {
      throw new BadRequestException('no_pending_found_report');
    }

    if (confirmed) {
      // Reuses the normal APPROVED -> FOUND path so claims and notifications all run.
      await this.updateStatus(admin, id, MissingPersonStatus.FOUND, reviewNote);
      const updated = await this.prisma.missingPerson.update({
        where: { id },
        data: {
          foundReportResolvedAt: new Date(),
          foundReportConfirmed: true,
          closedAt: new Date(),
          closureReason: 'found_verified',
        },
      });
      this.missingPersonCommonService.auditOp(
        admin,
        updated,
        'found_report_confirmed',
        {},
        { reason: reviewNote ?? null },
      );
      return updated;
    }

    const updated = await this.prisma.missingPerson.update({
      where: { id },
      data: { foundReportResolvedAt: new Date(), foundReportConfirmed: false },
    });
    await this.prisma.missingPersonMessage.create({
      data: {
        missingPersonId: id,
        authorId: admin.id,
        message: reviewNote?.trim() || 'Your found report could not be confirmed.',
      },
    });
    this.missingPersonCommonService.auditOp(
      admin,
      updated,
      'found_report_declined',
      {},
      { reason: reviewNote ?? null },
    );
    this.missingPersonCommonService.notifyOwner(updated);
    return updated;
  }

  // FOUND and EXPIRED return to APPROVED, a cancelled case returns to review.
  async reopen(admin: CurrentUserDto, id: string, reason: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    const reopenable: MissingPersonStatus[] = [
      MissingPersonStatus.EXPIRED,
      MissingPersonStatus.CANCELLED,
      MissingPersonStatus.FOUND,
    ];

    if (existing.deletedAt) throw new BadRequestException('deleted_case_must_be_restored_first');
    if (existing.mergedIntoId) throw new BadRequestException('merged_case_cannot_be_reopened');
    if (existing.takedownAt)
      throw new BadRequestException('use_lift_takedown_for_taken_down_cases');
    if (!reopenable.includes(existing.status)) {
      throw new BadRequestException('only_expired_cancelled_or_found_cases_can_be_reopened');
    }

    const target =
      existing.status === MissingPersonStatus.CANCELLED
        ? MissingPersonStatus.UNDER_REVIEW
        : MissingPersonStatus.APPROVED;

    const defaultDays = Number(
      this.configService.get<string>('MISSING_PERSON_RENEW_DEFAULT_DAYS') ?? 30,
    );

    const result = await this.prisma.missingPerson.updateMany({
      where: { id, status: existing.status },
      data: {
        status: target,
        closedAt: null,
        closureReason: null,
        foundReportedAt: null,
        foundReportDetails: null,
        foundReportDate: null,
        foundReportLocation: null,
        foundReportResolvedAt: null,
        foundReportConfirmed: null,
        ...(existing.status === MissingPersonStatus.EXPIRED
          ? { expiresAt: new Date(Date.now() + defaultDays * 24 * 60 * 60 * 1000) }
          : {}),
      },
    });
    if (result.count === 0) throw new ConflictException('missing_person_transition_conflict');

    await this.cache.invalidateMissingPersonEverywhere(id);
    const updated = await this.missingPersonCommonService.loadCase(id);

    this.missingPersonCommonService.auditOp(
      admin,
      updated,
      'reopen',
      { previousStatus: existing.status, newStatus: updated.status },
      { severity: AuditSeverity.WARNING, reason },
    );
    this.missingPersonCommonService.notifyOwner(updated);
    return updated;
  }

  async getTransitions(id: string) {
    const existing = await this.missingPersonCommonService.loadCase(id);
    return {
      id,
      currentStatus: existing.status,
      allowedNext: ALLOWED_TRANSITIONS[existing.status] ?? [],
      reviewNoteRequiredFor: [
        MissingPersonStatus.REJECTED,
        MissingPersonStatus.MORE_INFORMATION_REQUESTED,
      ],
      requiresChildSafetyDualConfirmation: existing.personType === MissingPersonType.CHILD,
      childSafetyFirstConfirmedByUserId: existing.childSafetyFirstConfirmedByUserId,
      claimedByUserId: existing.claimedByUserId,
    };
  }
}
