import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { AuditOutcome, AuditSeverity, Prisma, VictimProfileStatus } from '@prisma/client';
import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { ChapaService } from 'src/infrastructure/chapa/chapa.service';
import {
  DateRangeQueryDto,
  UpdateBankDetailsDto,
  UpdateGoalDto,
  VerifyBankDetailsDto,
} from '../dto/victim-profile.dto';
import { money, mapWithConcurrency, maskAccount } from './victim-profile.constants';
import { VictimProfileCommonService } from './victim-profile-common.service';

@Injectable()
export class VictimProfileFundingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly eventEmitter: EventEmitter2,
    private readonly cache: CacheService,
    private readonly chapa: ChapaService,
    private readonly victimProfileCommonService: VictimProfileCommonService,
  ) {}

  async findBankDetails(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: {
        id: true,
        payoutDestination: {
          select: {
            rail: true,
            bankName: true,
            bankCode: true,
            accountNumber: true,
            accountHolder: true,
            isVerified: true,
            verifiedAt: true,
          },
        },
      },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    return profile;
  }

  async getSupportsSummary(id: string) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
      select: { id: true },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const supports = await this.prisma.support.findMany({
      where: {
        victimProfileId: id,
        status: { in: ['CONFIRMED', 'COMPLETED'] },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Only financial supports carry money; non-financial offers never count toward the total.
    const totalReceived = supports
      .filter((support) => support.type === 'FINANCIAL')
      .reduce((sum, support) => sum + Number(support.recipientAmount ?? support.amount ?? 0), 0);

    return {
      totalReceived,
      supportCount: supports.length,
      supports,
    };
  }

  async updateBankDetails(admin: CurrentUserDto, id: string, data: UpdateBankDetailsDto) {
    const profile = await this.prisma.victimProfile.findUnique({
      where: { id },
    });

    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
    );

    if (profile.involvesChild && data.accountHolderRelationship === 'SELF') {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
        profile,
        'account_holder_cannot_be_the_child',
      );
      throw new BadRequestException('account_holder_cannot_be_the_child');
    }

    // The bank name is taken from Chapa's list for the given bank code, never from free text,
    // so the name and the code that actually receives the money cannot disagree.
    const banks = await this.chapa.getBanks();
    const bank = banks.find((b) => String(b.id) === data.bankCode);
    if (!bank || bank.is_mobilemoney === 1 || bank.is_mobilemoney === true) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
        profile,
        'invalid_bank_code',
      );
      throw new BadRequestException('invalid_bank_code');
    }
    const bankName = String(bank.name);

    const previousDestination = await this.prisma.payoutDestination.findUnique({
      where: { victimProfileId: id },
      select: { accountHolder: true, accountNumber: true, bankCode: true },
    });

    const wasApproved = profile.isAdminApproved;
    const isAdminApproved = wasApproved ? false : profile.isAdminApproved;

    const status = this.victimProfileCommonService.deriveStatus({
      involvesChild: profile.involvesChild,
      isVerified: profile.isVerified,
      isSafetyReviewed: profile.isSafetyReviewed,
      isChildSafetyReviewed: profile.isChildSafetyReviewed,
      hasConsent: profile.hasConsent,
      isPrivacyReviewed: profile.isPrivacyReviewed,
      isAdminApproved,
    });

    const updatedProfile = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      {
        isAdminApproved,
        isPublished: wasApproved ? false : profile.isPublished,
        status,
      },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED, profile },
    );

    // Editing always resets verification: a different admin must re-verify before any payout.
    await this.prisma.payoutDestination.upsert({
      where: { victimProfileId: id },
      create: {
        rail: 'BANK',
        bankName,
        bankCode: data.bankCode,
        accountNumber: data.bankAccountNumber,
        accountHolder: data.accountHolderName,
        lastEditedById: admin.id,
        victimProfileId: id,
      },
      update: {
        rail: 'BANK',
        bankName,
        bankCode: data.bankCode,
        accountNumber: data.bankAccountNumber,
        accountHolder: data.accountHolderName,
        lastEditedById: admin.id,
        isVerified: false,
        verifiedById: null,
        verifiedAt: null,
        verifiedNote: null,
      },
    });

    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.emitAudit({
      userId: admin.id,
      ...this.victimProfileCommonService.targetUserFor(admin, profile),
      actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
      action: AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
      entity: 'VictimProfile',
      entityId: id,
      entityLabel: this.victimProfileCommonService.profileLabel(profile),
      diff: {
        result: 'success',
        previousStatus: profile.status,
        newStatus: status,
        previousIsPublished: profile.isPublished,
        newIsPublished: wasApproved ? false : profile.isPublished,

        reapprovalRequired: wasApproved,
      },
      metadata: {
        accountNameChanged: data.accountHolderName !== previousDestination?.accountHolder,
        accountNumberChanged: data.bankAccountNumber !== previousDestination?.accountNumber,
        bankNameChanged: data.bankCode !== previousDestination?.bankCode,
        accountHolderRelationship: data.accountHolderRelationship,
        bankCode: data.bankCode,
      },
    });

    this.eventEmitter.emit(NotificationEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED, {
      userId: profile.createdByUserId,
      victimProfileId: id,
      reapprovalRequired: wasApproved,
      actorId: admin.id,
    });

    return updatedProfile;
  }

  async reconcileProfileTotal(admin: CurrentUserDto, id: string, autoCorrect: boolean) {
    const profile = await this.prisma.victimProfile.findUnique({ where: { id } });
    if (!profile) {
      throw new NotFoundException('victim_profile_not_found');
    }

    const agg = await this.prisma.paymentAllocation.aggregate({
      where: {
        partyType: 'RECIPIENT',
        payment: {
          victimProfileId: id,
          type: 'SUPPORT',
          status: 'PAID',
          support: { status: { not: 'CANCELLED' } },
        },
      },
      _sum: { amount: true },
      _count: true,
    });

    const liveTotal = new Prisma.Decimal(agg._sum.amount ?? 0);
    const cachedTotal = new Prisma.Decimal(profile.totalRaised);
    const mismatch = liveTotal.sub(cachedTotal).abs().gt('0.01');

    let corrected = false;

    if (mismatch && autoCorrect) {
      await this.victimProfileCommonService.conditionalUpdate(
        id,
        profile.updatedAt,
        { totalRaised: liveTotal },
        { admin, action: AuditEventEnum.VICTIM_PROFILE_TOTAL_RECONCILED, profile },
      );
      corrected = true;
      await this.cache.invalidateVictimProfileEverywhere(id);
    }

    if (mismatch) {
      this.victimProfileCommonService.emitAudit({
        userId: admin.id,
        actorType: resolveActorType(this.victimProfileCommonService.getRoles(admin)),
        action: AuditEventEnum.VICTIM_PROFILE_TOTAL_RECONCILED,
        severity: AuditSeverity.WARNING,
        entity: 'VictimProfile',
        entityId: id,
        entityLabel: this.victimProfileCommonService.profileLabel(profile),
        diff: {
          result: corrected ? 'success' : 'mismatch_detected',
          previousCachedTotal: money(cachedTotal),
          liveTotal: money(liveTotal),
          corrected,
        },
        metadata: {
          difference: money(liveTotal.sub(cachedTotal)),
          paidPaymentCount: agg._count,
        },
      });
    }

    return {
      victimProfileId: id,
      cachedTotal: money(cachedTotal),
      liveTotal: money(liveTotal),
      mismatch,
      corrected,
    };
  }

  async reconcileAllTotals(admin: CurrentUserDto, autoCorrect: boolean) {
    const profiles = await this.prisma.victimProfile.findMany({ select: { id: true } });

    const results = await mapWithConcurrency(profiles, 10, (p) =>
      this.reconcileProfileTotal(admin, p.id, autoCorrect),
    );

    return results.filter((r) => r.mismatch);
  }

  // VP-72
  async resumeDonations(admin: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    if (!profile.donationsPaused) throw new BadRequestException('donations_not_paused');
    if (profile.takedownAt) throw new BadRequestException('cannot_resume_during_takedown');
    if (profile.deletedAt) throw new BadRequestException('victim_profile_deleted');
    if (profile.status === VictimProfileStatus.COMPLETED) {
      throw new BadRequestException('victim_profile_completed_reopen_first');
    }

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      { donationsPaused: false, donationsPausedReason: null, donationsPausedAt: null },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_DONATIONS_RESUMED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);
    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_DONATIONS_RESUMED,
      profile,
      {
        diff: { previousReason: profile.donationsPausedReason },
      },
    );
    return updated;
  }

  // VP-73
  async updateGoal(admin: CurrentUserDto, id: string, data: UpdateGoalDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_GOAL_UPDATED,
    );

    const goal = new Prisma.Decimal(data.supportGoal);
    if (goal.gt(0) && goal.lt(profile.totalRaised)) {
      throw new BadRequestException('goal_below_total_raised');
    }

    const updated = await this.victimProfileCommonService.conditionalUpdate(
      id,
      profile.updatedAt,
      { supportGoal: goal },
      { admin, action: AuditEventEnum.VICTIM_PROFILE_GOAL_UPDATED, profile },
    );
    await this.cache.invalidateVictimProfileEverywhere(id);

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_GOAL_UPDATED,
      profile,
      {
        severity: AuditSeverity.WARNING,
        reason: data.reason,
        diff: {
          previousGoal: profile.supportGoal ? money(profile.supportGoal) : null,
          newGoal: money(goal),
          totalRaised: money(profile.totalRaised),
        },
      },
    );
    return updated;
  }

  // VP-74  (the audit trail never stored the numbers, so history is who/when/what-kind, plus the current masked value)
  async getBankDetailsHistory(admin: CurrentUserDto, id: string) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.logAdminView(admin, profile, 'bank_history');

    const [events, destination] = await Promise.all([
      this.prisma.auditLog.findMany({
        where: {
          entity: 'VictimProfile',
          entityId: id,
          action: {
            in: [
              AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
              AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_VERIFIED,
            ],
          },
          outcome: AuditOutcome.SUCCESS,
        },
        orderBy: { createdAt: 'desc' },
        select: { action: true, userId: true, createdAt: true, metadata: true },
      }),
      this.prisma.payoutDestination.findUnique({
        where: { victimProfileId: id },
        select: {
          rail: true,
          bankName: true,
          bankCode: true,
          accountNumber: true,
          accountHolder: true,
          isVerified: true,
          updatedAt: true,
        },
      }),
    ]);

    return {
      current: destination
        ? {
            rail: destination.rail,
            bankName: destination.bankName,
            bankCode: destination.bankCode,
            accountNumberMasked: maskAccount(destination.accountNumber),
            accountHolder: destination.accountHolder,
            isVerified: destination.isVerified,
            updatedAt: destination.updatedAt,
          }
        : null,
      history: events.map((e) => {
        const meta = (e.metadata ?? {}) as Record<string, unknown>;
        return {
          event: e.action,
          by: e.userId,
          at: e.createdAt,
          accountNameChanged: meta.accountNameChanged,
          accountNumberChanged: meta.accountNumberChanged,
          bankNameChanged: meta.bankNameChanged,
          accountHolderRelationship: meta.accountHolderRelationship,
        };
      }),
    };
  }

  // VP-75  (four eyes: the admin who typed the destination cannot be the one who verifies it)
  async verifyBankDetails(admin: CurrentUserDto, id: string, data: VerifyBankDetailsDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.assertAdminCanAccessProfile(
      admin,
      profile,
      AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_VERIFIED,
    );

    const destination = await this.prisma.payoutDestination.findUnique({
      where: { victimProfileId: id },
    });
    if (!destination) throw new BadRequestException('payout_destination_not_set');
    if (destination.isVerified) throw new ConflictException('payout_destination_already_verified');

    const lastEdit = await this.prisma.auditLog.findFirst({
      where: {
        entity: 'VictimProfile',
        entityId: id,
        action: AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
        outcome: AuditOutcome.SUCCESS,
      },
      orderBy: { createdAt: 'desc' },
      select: { userId: true },
    });
    if (lastEdit?.userId === admin.id) {
      this.victimProfileCommonService.emitProfileFailure(
        admin,
        AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_VERIFIED,
        profile,
        'verifier_must_differ_from_editor',
        {
          outcome: AuditOutcome.DENIED,
        },
      );
      throw new ForbiddenException('verifier_must_differ_from_editor');
    }

    // Compare-and-set so a concurrent bank-details edit (which resets isVerified) can't be verified over.
    const result = await this.prisma.payoutDestination.updateMany({
      where: { id: destination.id, isVerified: false, updatedAt: destination.updatedAt },
      data: {
        isVerified: true,
        verifiedById: admin.id,
        verifiedAt: new Date(),
        verifiedNote: data.notes ?? null,
      },
    });
    if (result.count === 0) throw new ConflictException('victim_profile_transition_conflict');

    this.victimProfileCommonService.auditSuccess(
      admin,
      AuditEventEnum.VICTIM_PROFILE_BANK_DETAILS_VERIFIED,
      profile,
      {
        severity: AuditSeverity.WARNING,
        reason: data.notes ?? null,
        diff: { accountNumberMasked: maskAccount(destination.accountNumber) },
      },
    );
    return { id, verified: true, accountNumberMasked: maskAccount(destination.accountNumber) };
  }

  // VP-76
  async getFundingTimeline(admin: CurrentUserDto, id: string, query: DateRangeQueryDto) {
    const profile = await this.victimProfileCommonService.getProfileOr404(id);
    this.victimProfileCommonService.logAdminView(admin, profile, 'funding_timeline');
    const { from, to } = this.victimProfileCommonService.parseRange(query);

    const payments = await this.prisma.payment.findMany({
      where: {
        victimProfileId: id,
        type: 'SUPPORT',
        status: 'PAID',
        support: { status: { not: 'CANCELLED' } },
        ...(from || to
          ? { paidAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } }
          : {}),
      },
      select: {
        paidAt: true,
        createdAt: true,
        allocations: { where: { partyType: 'RECIPIENT' }, select: { amount: true } },
      },
      take: 50_000,
    });

    const days = new Map<string, { count: number; total: Prisma.Decimal }>();
    for (const p of payments) {
      const day = (p.paidAt ?? p.createdAt).toISOString().slice(0, 10);
      const cur = days.get(day) ?? { count: 0, total: new Prisma.Decimal(0) };
      cur.count += 1;
      for (const a of p.allocations) cur.total = cur.total.add(a.amount);
      days.set(day, cur);
    }

    return [...days.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, v]) => ({ date, donations: v.count, recipientAmount: money(v.total) }));
  }
}
