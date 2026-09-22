// src/modules/billing/services/allocation.service.ts
//
// Produces the exact breakdown shown to the payer BEFORE paying.
// The same object is stored on Payment.allocationSnapshot, so what was shown
// is what is recorded, even if the agreement changes later.

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
   * The PRD gives no Pitron/organization portion for rewards — 100% to the beneficiary
   * until a legal decision says otherwise.
   */
  async previewReward(missingPersonId: string): Promise<AllocationPreview> {
    const mp = await this.prisma.missingPerson.findUnique({
      where: { id: missingPersonId },
      select: { rewardOffered: true, rewardApproved: true, rewardAmount: true },
    });
    if (!mp?.rewardOffered || !mp.rewardApproved || !mp.rewardAmount) {
      throw new BadRequestException('Reward is not approved for funding');
    }
    const totalMinor = mp.rewardAmount * 100;
    return this.build(
      PaymentType.MISSING_PERSON_REWARD,
      totalMinor,
      [{ partyType: PartyType.REWARD_BENEFICIARY, institutionId: null, minor: totalMinor, ruleId: null }],
      null,
      null,
      null,
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

    const now = new Date();
    const agreement = await this.prisma.agreement.findFirst({
      where: {
        id: profile.agreementId,
        status: 'ACTIVE',
        effectiveFrom: { lte: now },
        OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
      },
      include: {
        rules: {
          where: { paymentType: type, partyType: { not: PartyType.RECIPIENT } },
          orderBy: { id: 'asc' },
        },
      },
    });
    if (!agreement) {
      throw new BadRequestException('No active agreement covers this profile');
    }

    const lines: MinorLine[] = [];
    let others = 0;
    for (const r of agreement.rules) {
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

    // Recipient is always the remainder, so lines sum exactly to the total.
    lines.unshift({
      partyType: PartyType.RECIPIENT,
      institutionId: null,
      minor: totalMinor - others,
      ruleId: null,
    });

    return this.build(type, totalMinor, lines, agreement.id, agreement.version, agreement.type);
  }

  // ── helpers ───────────────────────────────────────────────────────────────

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
    const hash = crypto
      .createHash('sha256')
      .update(JSON.stringify(body))
      .digest('hex');
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
