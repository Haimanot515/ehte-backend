import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { createHash } from 'crypto';
import { AuditOutcome, AuditSeverity, Payment, PaymentStatus, Prisma } from '@prisma/client';

import { PrismaService } from 'src/prisma/prisma.service';
import { CurrentUserDto } from 'src/common/dtos/current-user.dto';
import { resolveActorType } from 'src/common/utils/actor-type.util';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { ChapaService } from 'src/infrastructure/chapa/chapa.service';
import { CacheService } from 'src/infrastructure/redis/cache.service';
import { money } from 'src/modules/core/victim-profile/service/victim-profile.constants';

import { ChapaWebhookService, SettleResult } from './chapa-webhook.service';
import { CreateDonationDto, PagedDto } from '../dto/payments.dto';

// Same rule as VictimProfileCommonService.publicWhere(): only a fully reviewed, published profile may be shown or funded.
const PUBLIC_PROFILE_WHERE: Prisma.VictimProfileWhereInput = {
  status: 'PUBLISHED',
  isPublished: true,
  isVerified: true,
  isSafetyReviewed: true,
  hasConsent: true,
  isPrivacyReviewed: true,
  isAdminApproved: true,
  deletedAt: null,
};

const PUBLIC_TOTALS_TTL_SECONDS = 30;
const CHECKOUT_URL_TTL_SECONDS = 24 * 60 * 60;

export type StartDonationResult = {
  paymentId: string;
  txRef: string;
  checkoutUrl: string;
};

@Injectable()
export class DonationService {
  private readonly enabled: boolean;
  private readonly currency: string;
  private readonly minAmount: Prisma.Decimal;
  private readonly returnUrl: string;
  private readonly callbackUrl: string;
  private readonly fallbackEmail: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly chapa: ChapaService,
    private readonly webhooks: ChapaWebhookService,
    private readonly cache: CacheService,
    private readonly eventEmitter: EventEmitter2,
    config: ConfigService,
  ) {
    this.enabled = config.get<boolean>('payments.enabled', false);
    this.currency = config.get<string>('support.currency', 'ETB');
    this.minAmount = new Prisma.Decimal(config.get<string>('payments.minSupportEtb', '10'));
    this.returnUrl = config.get<string>('payments.returnUrl', '');
    // Chapa's server notification arrives at the webhook route set in the Chapa dashboard.
    // callback_url is only required by the initialize call, so it falls back to the return page.
    this.callbackUrl = config.get<string>('chapa.callbackUrl', '') || this.returnUrl;
    this.fallbackEmail = config.get<string>('chapa.fallbackEmail', '') ?? '';
  }

  // ── Start a donation ──────────────────────────────────────────────────────

  /**
   * 1. Check the profile may take money.  2. Record Payment(PENDING) with its own txRef.
   * 3. Only then ask Chapa for the checkout page.
   * A repeat with the same Idempotency-Key returns the same Payment and the same checkout URL,
   * so a double tap never creates two donations.
   */
  async start(
    user: CurrentUserDto,
    dto: CreateDonationDto,
    idempotencyKey?: string,
  ): Promise<StartDonationResult> {
    if (!this.enabled) throw new ServiceUnavailableException('payments_disabled');
    if (!this.returnUrl) {
      throw new ServiceUnavailableException('payments_return_url_not_configured');
    }

    const amount = this.parseAmount(dto.amount);
    const key = this.cleanKey(idempotencyKey);

    const profile = await this.getDonatableProfile(dto.victimProfileId);

    const payer = await this.prisma.user.findUnique({
      where: { id: user.id },
      select: { email: true, name: true },
    });
    if (!payer) throw new NotFoundException('user_not_found');

    const email = payer.email?.trim() || this.fallbackEmail;
    if (!email) throw new BadRequestException('donor_email_required');

    const txRef = key
      ? `ehte-${createHash('sha256').update(`${user.id}:${key}`).digest('hex').slice(0, 24)}`
      : this.chapa.generateTxRef();

    // Record first, so a payment that Chapa knows about is always one we know about.
    let payment: Payment;
    let created = true;
    try {
      payment = await this.prisma.payment.create({
        data: {
          victimProfileId: profile.id,
          payerUserId: user.id,
          isAnonymous: dto.isAnonymous ?? false,
          amount,
          currency: this.currency,
          txRef,
        },
      });
    } catch (err) {
      const duplicate = err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
      if (!key || !duplicate) throw err;

      const existing = await this.prisma.payment.findUnique({ where: { txRef } });
      if (!existing) throw err;
      if (
        existing.payerUserId !== user.id ||
        existing.victimProfileId !== profile.id ||
        !existing.amount.equals(amount)
      ) {
        throw new ConflictException('idempotency_key_reused');
      }
      if (existing.status !== PaymentStatus.PENDING) {
        throw new ConflictException('donation_already_processed');
      }
      payment = existing;
      created = false;
    }

    if (created) {
      this.audit(AuditEventEnum.PAYMENT_INITIATED, payment, user, {
        amount: amount.toFixed(2),
        isAnonymous: payment.isAnonymous,
      });
    }

    const [firstName, ...rest] = (payer.name ?? '').trim().split(/\s+/);
    const initialize = () =>
      this.chapa.initialize({
        amount,
        email,
        firstName: firstName || 'Supporter',
        lastName: rest.join(' ') || 'Ehte',
        txRef,
        returnUrl: this.buildReturnUrl(txRef),
        callbackUrl: this.callbackUrl,
        title: 'Ehte',
        description: 'Ehte support',
      });

    try {
      // With a key, the checkout URL is kept so a repeat call gets the same page back
      // (Chapa refuses to initialize one tx_ref twice).
      const { checkoutUrl } = key
        ? await this.cache.wrap(`payments:checkout:${txRef}`, initialize, CHECKOUT_URL_TTL_SECONDS)
        : await initialize();
      return { paymentId: payment.id, txRef, checkoutUrl };
    } catch (err) {
      // Only a clear refusal by Chapa proves no checkout exists. A timeout or 5xx leaves the payment
      // PENDING, because the page may exist and the payment can still be verified later.
      if (created && this.chapa.isDefiniteRejection(err)) {
        await this.prisma.payment.updateMany({
          where: { id: payment.id, status: PaymentStatus.PENDING },
          data: { status: PaymentStatus.FAILED, failureReason: 'chapa_initialize_rejected' },
        });
        this.audit(AuditEventEnum.PAYMENT_FAILED, payment, user, {}, AuditOutcome.FAILURE);
      }
      throw err;
    }
  }

  // ── Verify (donor return page) ────────────────────────────────────────────

  /**
   * Same code path as the webhook, so the result is the same whoever asks first.
   * Only the donor who started the payment can ask; anyone else gets "not found".
   */
  async verifyForPayer(user: CurrentUserDto, txRef: string): Promise<SettleResult> {
    const payment = await this.prisma.payment.findFirst({
      where: { txRef, payerUserId: user.id },
      select: { id: true },
    });
    if (!payment) throw new NotFoundException('payment_not_found');

    return this.webhooks.settlePayment(txRef);
  }

  // ── Donor's own list ──────────────────────────────────────────────────────

  async findMine(user: CurrentUserDto, query: PagedDto) {
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const where: Prisma.PaymentWhereInput = { payerUserId: user.id };

    const [rows, total] = await Promise.all([
      this.prisma.payment.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
        select: {
          id: true,
          txRef: true,
          status: true,
          amount: true,
          currency: true,
          isAnonymous: true,
          paidAt: true,
          createdAt: true,
          victimProfile: { select: { id: true, name: true, involvesChild: true } },
        },
      }),
      this.prisma.payment.count({ where }),
    ]);

    return {
      data: rows.map((r) => ({
        id: r.id,
        txRef: r.txRef,
        status: r.status,
        amount: money(r.amount),
        currency: r.currency,
        isAnonymous: r.isAnonymous,
        paidAt: r.paidAt,
        createdAt: r.createdAt,
        // Never fees, Chapa references, failure reasons or transfer state. A child's name is never shown.
        victimProfile: {
          id: r.victimProfile.id,
          name: r.victimProfile.involvesChild ? null : r.victimProfile.name,
        },
      })),
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  // ── Public totals ─────────────────────────────────────────────────────────

  async getPublicTotals(victimProfileId: string): Promise<{ raised: string; donorCount: number }> {
    const profile = await this.prisma.victimProfile.findFirst({
      where: { id: victimProfileId, ...PUBLIC_PROFILE_WHERE },
      select: { id: true },
    });
    if (!profile) throw new NotFoundException('victim_profile_not_found');

    return this.cache.wrap(
      `payments:public-totals:${victimProfileId}`,
      async () => {
        const where = { victimProfileId, status: PaymentStatus.PAID };
        const [sum, donors] = await Promise.all([
          this.prisma.payment.aggregate({ where, _sum: { amount: true } }),
          this.prisma.payment.groupBy({ by: ['payerUserId'], where, _count: { _all: true } }),
        ]);

        // Each signed-in donor counts once; payments with no donor attached count one by one.
        const donorCount = donors.reduce(
          (n, g) => n + (g.payerUserId === null ? g._count._all : 1),
          0,
        );
        return { raised: money(sum._sum.amount), donorCount };
      },
      PUBLIC_TOTALS_TTL_SECONDS,
    );
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private parseAmount(value: string): Prisma.Decimal {
    let amount: Prisma.Decimal;
    try {
      amount = new Prisma.Decimal(value);
    } catch {
      throw new BadRequestException('amount_invalid');
    }
    if (amount.lt(this.minAmount)) {
      throw new BadRequestException(`amount_below_minimum_${this.minAmount.toFixed(0)}`);
    }
    return amount;
  }

  private cleanKey(key?: string): string | null {
    const k = key?.trim();
    if (!k) return null;
    if (k.length < 8 || k.length > 100) throw new BadRequestException('idempotency_key_invalid');
    return k;
  }

  private buildReturnUrl(txRef: string): string {
    try {
      const url = new URL(this.returnUrl);
      url.searchParams.set('tx_ref', txRef);
      return url.toString();
    } catch {
      throw new ServiceUnavailableException('payments_return_url_invalid');
    }
  }

  /** Published and fully reviewed, open for donations, and able to receive the money. */
  private async getDonatableProfile(id: string) {
    const profile = await this.prisma.victimProfile.findFirst({
      where: { id, ...PUBLIC_PROFILE_WHERE },
      select: {
        id: true,
        donationsPaused: true,
        takedownAt: true,
        legalHold: true,
        completedAt: true,
        fundingEndsAt: true,
        payoutDestination: { select: { isVerified: true } },
      },
    });
    if (!profile) throw new NotFoundException('victim_profile_not_found');

    if (profile.donationsPaused) throw new ConflictException('donations_paused');
    if (profile.takedownAt || profile.legalHold) {
      throw new ConflictException('profile_not_accepting_donations');
    }
    if (profile.completedAt) throw new ConflictException('profile_completed');
    if (profile.fundingEndsAt && profile.fundingEndsAt.getTime() < Date.now()) {
      throw new ConflictException('funding_ended');
    }
    // Money that cannot be sent on must not be collected.
    if (!profile.payoutDestination?.isVerified) {
      throw new ConflictException('profile_not_accepting_donations');
    }
    return profile;
  }

  private audit(
    action: AuditEventEnum,
    payment: Pick<Payment, 'id' | 'victimProfileId'>,
    actor: CurrentUserDto,
    diff: Record<string, unknown>,
    outcome: AuditOutcome = AuditOutcome.SUCCESS,
  ) {
    this.eventEmitter.emit(action, {
      userId: actor.id,
      actorType: resolveActorType(actor.roles),
      action,
      outcome,
      severity: outcome === AuditOutcome.SUCCESS ? AuditSeverity.INFO : AuditSeverity.WARNING,
      entity: 'Payment',
      entityId: payment.id,
      diff,
      metadata: { victimProfileId: payment.victimProfileId },
    });
  }
}