// src/modules/billing/services/allocation.service.ts
//
// Produces the exact breakdown shown to the payer BEFORE paying.
// The same object is stored on Payment.allocationSnapshot, so what was shown
// is what is recorded, even if the agreement changes later.
//
// PRD alignment (Sep 2026): three financial directions share this same
// rule-lookup + snapshot machinery (section 33) — Victim Profile support
// (SUPPORT), Missing Person Reward (MISSING_PERSON_REWARD), and the two
// posting/promotion fee flows (*_POSTING_FEE). Support and posting fees use
// RECIPIENT / PLATFORM respectively as their "whatever the rules don't
// claim" remainder party; reward funding uses REWARD_BENEFICIARY as the
// remainder, representing the informant pool that RewardService later
// splits across approved claims (section 12-14) — institution/platform
// shares now come from the agreement's MISSING_PERSON_REWARD rules instead
// of the reward being 100% beneficiary as before.

import { BadRequestException, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PartyType, PaymentType, Prisma, SupportAgreementType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PROFILE_PUBLIC_STATUS } from '../billing.constants';

export type AllocationLine = {
  partyType: PartyType;
  institutionId: string | null;
  amount: string; // "800.00"
  ruleId: string | null;
};

export type AllocationPreview = {
  paymentType: PaymentType;
  currency: 'ETB';
  total: string;
  lines: AllocationLine[];
  agreementId: string | null;
  agreementVersion: number | null;
  agreementType: SupportAgreementType | null;
  hash: string;
};

type MinorLine = Omit<AllocationLine, 'amount'> & { minor: number };

@Injectable()
export class AllocationService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Reward funding. The amount comes from MissingPerson.rewardAmount (Int, whole ETB) —
   * there is no separate reward escrow model, so this does not take an `amount` argument.
   * ASSUMPTION TO VERIFY: rewardAmount is stored as whole ETB with no cents; if fractional
   * rewards are ever needed this needs a schema change, not a silent *100 here going wrong.
   *
   * Institution/platform shares now come from the case's resolved agreement's
   * MISSING_PERSON_REWARD rules (section 13/14), same as SUPPORT does for support
   * payments. REWARD_BENEFICIARY is the remainder and represents the whole
   * informant pool for the case, not one person — RewardService splits that pool
   * across approved RewardClaim rows once informants are decided (section 12).
   * A case with no MISSING_PERSON_REWARD rules on its agreement (or no agreement
   * at all) falls back to 100% REWARD_BENEFICIARY, preserving old behavior rather
   * than silently blocking reward funding for cases created before this rule type existed.
   */
  async previewReward(missingPersonId: string): Promise<AllocationPreview> {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: {
        rewardOffered: true,
        rewardApproved: true,
        rewardAmount: true,
        agreementId: true,
      },
    });
    if (!mp?.rewardOffered || !mp.rewardApproved || !mp.rewardAmount) {
      throw new BadRequestException('Reward is not approved for funding');
    }
    const totalMinor = mp.rewardAmount * 100;

    if (!mp.agreementId) {
      return this.build(
        PaymentType.MISSING_PERSON_REWARD,
        totalMinor,
        [
          {
            partyType: PartyType.REWARD_BENEFICIARY,
            institutionId: null,
            minor: totalMinor,
            ruleId: null,
          },
        ],
        null,
        null,
        null,
      );
    }

    const agreement = await this.resolveActiveAgreement(mp.agreementId, PaymentType.MISSING_PERSON_REWARD);
    if (!agreement || agreement.rules.length === 0) {
      return this.build(
        PaymentType.MISSING_PERSON_REWARD,
        totalMinor,
        [
          {
            partyType: PartyType.REWARD_BENEFICIARY,
            institutionId: null,
            minor: totalMinor,
            ruleId: null,
          },
        ],
        agreement?.id ?? null,
        agreement?.version ?? null,
        agreement?.type ?? null,
      );
    }

    const lines = this.applyRulesWithRemainder(
      agreement.rules,
      totalMinor,
      PartyType.REWARD_BENEFICIARY,
    );
    return this.build(
      PaymentType.MISSING_PERSON_REWARD,
      totalMinor,
      lines,
      agreement.id,
      agreement.version,
      agreement.type,
    );
  }

  /** SUPPORT only. For reward funding use previewReward(missingPersonId). */
  async preview(
    type: Extract<PaymentType, 'SUPPORT'>,
    amount: Prisma.Decimal,
    victimProfileId: string,
  ): Promise<AllocationPreview> {
    const totalMinor = this.toMinor(amount);
    if (totalMinor <= 0) throw new BadRequestException('Amount must be positive');
    if (!victimProfileId) throw new BadRequestException('victimProfileId is required');

    const profile = await this.prisma.victimProfile.findFirst({
      where: { id: victimProfileId, status: PROFILE_PUBLIC_STATUS, isPublished: true },
      select: {
        agreementId: true,
        bankAccountName: true,
        bankAccountNumber: true,
        bankName: true,
      },
    });
    if (!profile?.agreementId) {
      throw new BadRequestException('Support is not available for this profile');
    }
    // A published profile always has bank details today (publish() requires all gates), but this
    // stays a defensive check: money must never be collected for a profile that cannot be paid out.
    if (!profile.bankAccountName || !profile.bankAccountNumber || !profile.bankName) {
      throw new BadRequestException('Support is not available for this profile');
    }

    const agreement = await this.resolveActiveAgreement(profile.agreementId, type);
    if (!agreement) {
      throw new BadRequestException('No active agreement covers this profile');
    }

    const lines = this.applyRulesWithRemainder(agreement.rules, totalMinor, PartyType.RECIPIENT);
    return this.build(type, totalMinor, lines, agreement.id, agreement.version, agreement.type);
  }

  /**
   * Posting/promotion fee (section 5 / 8 / 27). The fee AMOUNT is resolved once,
   * at case-creation time, onto VictimProfile.postingFeeAmount /
   * MissingPerson.postingFeeAmount (step 3 of section 4's flow) — this method
   * only computes how that fixed amount is split. There is no natural
   * "recipient" for a fee the way SUPPORT has the beneficiary, so any amount
   * the agreement's rules don't claim falls to PLATFORM by default rather than
   * being left unaccounted for.
   */
  async previewPostingFee(
    type: Extract<PaymentType, 'VICTIM_PROFILE_POSTING_FEE' | 'MISSING_PERSON_POSTING_FEE'>,
    feeAmount: Prisma.Decimal,
    agreementId: string | null,
  ): Promise<AllocationPreview> {
    const totalMinor = this.toMinor(feeAmount);
    if (totalMinor <= 0) throw new BadRequestException('No posting fee is configured');

    if (!agreementId) {
      return this.build(
        type,
        totalMinor,
        [{ partyType: PartyType.PLATFORM, institutionId: null, minor: totalMinor, ruleId: null }],
        null,
        null,
        null,
      );
    }

    const agreement = await this.resolveActiveAgreement(agreementId, type);
    if (!agreement || agreement.rules.length === 0) {
      return this.build(
        type,
        totalMinor,
        [{ partyType: PartyType.PLATFORM, institutionId: null, minor: totalMinor, ruleId: null }],
        agreement?.id ?? null,
        agreement?.version ?? null,
        agreement?.type ?? null,
      );
    }

    const lines = this.applyRulesWithRemainder(agreement.rules, totalMinor, PartyType.PLATFORM);
    return this.build(type, totalMinor, lines, agreement.id, agreement.version, agreement.type);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

  private async resolveActiveAgreement(agreementId: string, paymentType: PaymentType) {
    const now = new Date();
    return this.prisma.agreement.findFirst({
      where: {
        id: agreementId,
        status: 'ACTIVE',
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      include: {
        rules: {
          where: { paymentType, partyType: { not: PartyType.RECIPIENT } },
          orderBy: { id: 'asc' },
        },
      },
    });
  }

  private applyRulesWithRemainder(
    rules: {
      id: string;
      partyType: PartyType;
      institutionId: string | null;
      mode: string;
      valueBps: number | null;
      flatAmount: Prisma.Decimal | null;
    }[],
    totalMinor: number,
    remainderParty: PartyType,
  ): MinorLine[] {
    const lines: MinorLine[] = [];
    let others = 0;
    for (const r of rules) {
      const minor =
        r.mode === 'PERCENT_BPS'
          ? Math.floor((totalMinor * (r.valueBps ?? 0)) / 10_000)
          : this.toMinor(r.flatAmount ?? new Prisma.Decimal(0));
      if (minor <= 0) continue;
      others += minor;
      lines.push({
        partyType: r.partyType,
        institutionId: r.institutionId,
        minor,
        ruleId: r.id,
      });
    }
    if (others >= totalMinor) {
      throw new BadRequestException('Allocation rules exceed the payment amount');
    }

    // The remainder party is always first and always the true remainder, so
    // lines sum exactly to the total regardless of rounding on the other lines.
    lines.unshift({
      partyType: remainderParty,
      institutionId: null,
      minor: totalMinor - others,
      ruleId: null,
    });
    return lines;
  }

  private build(
    type: PaymentType,
    totalMinor: number,
    lines: MinorLine[],
    agreementId: string | null,
    agreementVersion: number | null,
    agreementType: SupportAgreementType | null,
  ): AllocationPreview {
    const out: AllocationLine[] = lines.map(({ minor, ...rest }) => ({
      ...rest,
      amount: this.fromMinor(minor),
    }));
    const body = {
      paymentType: type,
      currency: 'ETB' as const,
      total: this.fromMinor(totalMinor),
      lines: out,
      agreementId,
      agreementVersion,
      agreementType,
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    return { ...body, hash };
  }

  private toMinor(amount: Prisma.Decimal): number {
    if (amount.decimalPlaces() > 2) {
      throw new BadRequestException('Amount can have at most 2 decimal places');
    }
    return amount.mul(100).toNumber();
  }

  private fromMinor(minor: number): string {
    return new Prisma.Decimal(minor).div(100).toFixed(2);
  }
}
