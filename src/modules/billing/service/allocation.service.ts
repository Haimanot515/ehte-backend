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

import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import * as crypto from 'crypto';
import { PartyType, PaymentType, Prisma, SupportAgreementType } from '@prisma/client';
import { PrismaService } from '../../../prisma/prisma.service';
import { PROFILE_PUBLIC_STATUS } from '../billing.constants';
import { FxSnapshotDto } from '../dto/fx.dto';
import { FX_RATE_PROVIDER, FxRateProvider } from './fx-rate.provider';

// Decimal places each payout currency's smallest unit has. Extend as new
// payout currencies are actually onboarded — deliberately NOT defaulting
// silently to "2 unless listed", since a wrong minor-unit count rounds
// FX conversions wrong in a way that's easy to miss in review. Currencies
// with a genuinely non-2 minor unit (e.g. JPY has none) must be added here
// before AllocationService will convert into them.
const CURRENCY_MINOR_UNITS: Record<string, number> = {
  ETB: 2,
  USD: 2,
  EUR: 2,
  GBP: 2,
  KES: 2,
};

export type AllocationLine = {
  partyType: PartyType;
  institutionId: string | null;
  amount: string; // "800.00", in the TRANSACTION currency (see AllocationPreview.currency)
  ruleId: string | null;
  /**
   * GAP 7 / Section 29: set only when this line's recipient is paid out in a
   * currency other than the transaction currency. Null means "same currency,
   * no conversion happened" — never a stand-in for "conversion skipped".
   */
  fxSnapshot: FxSnapshotDto | null;
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

type MinorLine = Omit<AllocationLine, 'amount' | 'fxSnapshot'> & { minor: number };
type MinorLineWithFx = MinorLine & { fxSnapshot: FxSnapshotDto | null };

@Injectable()
export class AllocationService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(FX_RATE_PROVIDER) private readonly fxRates: FxRateProvider,
  ) {}

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
      { institutionPayoutCurrencies: await this.resolveInstitutionPayoutCurrencies(agreement.rules) },
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
        // GAP 7: PayoutDestination.currency already exists in the schema
        // (default "ETB") — this is the only field this method needs from
        // it. The legacy bank* checks below are untouched; G40's cutover to
        // reading bank details from payoutDestination instead of these
        // legacy columns is a separate, not-yet-done fix.
        payoutDestination: { select: { currency: true } },
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
    return this.build(type, totalMinor, lines, agreement.id, agreement.version, agreement.type, {
      // undefined (not "ETB") when no PayoutDestination row exists yet, so
      // attachFx() falls through to the transactionCurrency default instead
      // of comparing "ETB" to a made-up value.
      recipientPayoutCurrency: profile.payoutDestination?.currency,
    });
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
    return this.build(type, totalMinor, lines, agreement.id, agreement.version, agreement.type, {
      institutionPayoutCurrencies: await this.resolveInstitutionPayoutCurrencies(agreement.rules),
    });
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

  private async build(
    type: PaymentType,
    totalMinor: number,
    lines: MinorLine[],
    agreementId: string | null,
    agreementVersion: number | null,
    agreementType: SupportAgreementType | null,
    fx?: {
      /** Set when the line's remainder party (RECIPIENT) is known to be paid out off-platform. */
      recipientPayoutCurrency?: string;
      /** institutionId -> payout currency, for rule lines tied to a specific institution. */
      institutionPayoutCurrencies?: Record<string, string>;
    },
  ): Promise<AllocationPreview> {
    const transactionCurrency = 'ETB' as const;
    const linesWithFx = await this.attachFx(lines, transactionCurrency, fx);
    const out: AllocationLine[] = linesWithFx.map(({ minor, fxSnapshot, ...rest }) => ({
      ...rest,
      amount: this.fromMinor(minor),
      fxSnapshot,
    }));
    const body = {
      paymentType: type,
      currency: transactionCurrency,
      total: this.fromMinor(totalMinor),
      lines: out,
      agreementId,
      agreementVersion,
      agreementType,
    };
    const hash = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
    return { ...body, hash };
  }

  /**
   * GAP 7 / Section 29: attaches an FxSnapshotDto to every line whose
   * resolved payout currency differs from `transactionCurrency`, and null to
   * every line that doesn't. Never converts silently — a line that needs
   * conversion but has no live rate available makes the WHOLE preview throw
   * (via buildFxSnapshot -> FxRateProvider), rather than shipping a preview
   * with some lines converted and one silently skipped.
   */
  private async attachFx(
    lines: MinorLine[],
    transactionCurrency: string,
    fx?: {
      recipientPayoutCurrency?: string;
      institutionPayoutCurrencies?: Record<string, string>;
    },
  ): Promise<MinorLineWithFx[]> {
    const out: MinorLineWithFx[] = [];
    for (const line of lines) {
      const destinationCurrency =
        (line.institutionId && fx?.institutionPayoutCurrencies?.[line.institutionId]) ||
        (line.partyType === PartyType.RECIPIENT ? fx?.recipientPayoutCurrency : undefined) ||
        transactionCurrency;

      if (destinationCurrency === transactionCurrency) {
        out.push({ ...line, fxSnapshot: null });
        continue;
      }

      out.push({
        ...line,
        fxSnapshot: await this.buildFxSnapshot(line, transactionCurrency, destinationCurrency),
      });
    }
    return out;
  }

  private async buildFxSnapshot(
    line: MinorLine,
    sourceCurrency: string,
    destinationCurrency: string,
  ): Promise<FxSnapshotDto> {
    // Hard-fail rather than guess: if the feed is unconfigured or down, this
    // throws FxRateUnavailableException straight out of preview()/
    // previewReward()/previewPostingFee() — no allocation line is ever
    // attached to a converted amount without a recorded, live-quoted rate
    // behind it (see fx-rate.provider.ts).
    const quote = await this.fxRates.getRate(sourceCurrency, destinationCurrency);
    const rate = new Prisma.Decimal(quote.rate);

    const sourceAmount = new Prisma.Decimal(line.minor).div(100); // major units, sourceCurrency
    const rawConverted = sourceAmount.mul(rate);

    const destinationDecimals = CURRENCY_MINOR_UNITS[destinationCurrency];
    if (destinationDecimals === undefined) {
      throw new BadRequestException(
        `Unsupported payout currency: ${destinationCurrency} (add it to CURRENCY_MINOR_UNITS first)`,
      );
    }

    const convertedRounded = rawConverted.toDecimalPlaces(destinationDecimals, Prisma.Decimal.ROUND_HALF_UP);
    const roundingAdjustment = convertedRounded.sub(rawConverted);

    return {
      rate: rate.toString(),
      rateTimestamp: quote.rateTimestamp,
      rateSource: quote.rateSource,
      sourceCurrency,
      destinationCurrency,
      convertedAmount: convertedRounded.toFixed(destinationDecimals),
      roundingAdjustment: roundingAdjustment.toFixed(destinationDecimals),
    };
  }

  /**
   * GAP 7: institutions' payout currency lives on PayoutDestination
   * (institutionId FK, `currency` column, default "ETB") — same model G40
   * uses for victim profiles. One query for every distinct institutionId a
   * rule set references; institutions with no PayoutDestination row yet
   * (or none at all, since institutionId can be null) are simply absent
   * from the returned map, which attachFx() treats as "transaction currency".
   */
  private async resolveInstitutionPayoutCurrencies(
    rules: { institutionId: string | null }[],
  ): Promise<Record<string, string>> {
    const institutionIds = [...new Set(rules.map((r) => r.institutionId).filter((id): id is string => !!id))];
    if (institutionIds.length === 0) return {};

    const destinations = await this.prisma.payoutDestination.findMany({
      where: { institutionId: { in: institutionIds } },
      select: { institutionId: true, currency: true },
    });
    const out: Record<string, string> = {};
    for (const d of destinations) {
      // If an institution ever has more than one PayoutDestination, this
      // takes whichever one the query returns last — fine while institutions
      // have at most one in practice; revisit if that stops being true.
      if (d.institutionId) out[d.institutionId] = d.currency;
    }
    return out;
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