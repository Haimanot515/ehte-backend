import { BadRequestException, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PartyType, PaymentType, Prisma, SupportAgreementType } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import { PROFILE_PUBLIC_STATUS } from '../allocation.constants';

export type AllocationLine = {
  partyType: PartyType;
  institutionId: string | null;
  amount: string;
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

    const agreement = await this.resolveActiveAgreement(
      mp.agreementId,
      PaymentType.MISSING_PERSON_REWARD,
    );
    if (!agreement) throw new BadRequestException('No active agreement covers this case');
    if (agreement.rules.length === 0) {
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
        payoutDestination: {
          select: {
            rail: true,
            bankName: true,
            bankCode: true,
            accountNumber: true,
            accountHolder: true,
            isVerified: true,
          },
        },
      },
    });
    if (!profile?.agreementId) {
      throw new BadRequestException('Support is not available for this profile');
    }
    const dest = profile.payoutDestination;
    if (
      !dest ||
      !dest.isVerified ||
      dest.rail !== 'BANK' ||
      !dest.accountNumber ||
      !dest.accountHolder ||
      !dest.bankName ||
      !dest.bankCode
    ) {
      throw new BadRequestException('Support is not available for this profile');
    }

    const agreement = await this.resolveActiveAgreement(profile.agreementId, type);
    if (!agreement) {
      throw new BadRequestException('No active agreement covers this profile');
    }

    const lines = this.applyRulesWithRemainder(agreement.rules, totalMinor, PartyType.RECIPIENT);
    return this.build(type, totalMinor, lines, agreement.id, agreement.version, agreement.type);
  }

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
    if (!agreement) throw new BadRequestException('No active agreement covers this object');
    if (agreement.rules.length === 0) {
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