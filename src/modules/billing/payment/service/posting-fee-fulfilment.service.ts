import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { PaymentType } from '@prisma/client';
import { PrismaService } from '../../../../prisma/prisma.service';
import {
  BILLING_PAYMENT_PAID,
  BillingPaymentPaid,
} from 'src/modules/billing/billing-events/service/billing-events.service';

/**
 * When a posting-fee payment is confirmed, mark the profile / case fee as PAID.
 * Safe to run twice: the update only touches objects that are not already PAID or WAIVED,
 * and PaymentService.repairUnfulfilledPayments re-emits the event if this ever fails.
 */
@Injectable()
export class PostingFeeFulfilmentService {
  private readonly logger = new Logger(PostingFeeFulfilmentService.name);

  constructor(private readonly prisma: PrismaService) {}

  @OnEvent(BILLING_PAYMENT_PAID)
  async onPaymentPaid(e: BillingPaymentPaid): Promise<void> {
    try {
      await this.fulfil(e.paymentId);
    } catch (error) {
      this.logger.error(
        `Could not mark posting fee paid for payment ${e.paymentId}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  private async fulfil(paymentId: string): Promise<void> {
    const payment = await this.prisma.payment.findUnique({
      where: { id: paymentId },
      select: { type: true, status: true, victimProfileId: true, missingPersonId: true },
    });
    // Only a still-PAID payment counts: a refunded payment must never mark the fee paid again.
    if (!payment || payment.status !== 'PAID') return;

    const notYetPaid = { notIn: ['PAID', 'WAIVED'] as ('PAID' | 'WAIVED')[] };

    if (payment.type === PaymentType.VICTIM_PROFILE_POSTING_FEE && payment.victimProfileId) {
      await this.prisma.$transaction([
        this.prisma.victimProfile.updateMany({
          where: { id: payment.victimProfileId, postingFeeStatus: notYetPaid },
          data: { postingFeeStatus: 'PAID' },
        }),
        this.prisma.payment.updateMany({
          where: { id: paymentId, fulfilledAt: null },
          data: { fulfilledAt: new Date() },
        }),
      ]);
    } else if (payment.type === PaymentType.MISSING_PERSON_POSTING_FEE && payment.missingPersonId) {
      await this.prisma.$transaction([
        this.prisma.missingPerson.updateMany({
          where: { id: payment.missingPersonId, postingFeeStatus: notYetPaid },
          data: { postingFeeStatus: 'PAID' },
        }),
        this.prisma.payment.updateMany({
          where: { id: paymentId, fulfilledAt: null },
          data: { fulfilledAt: new Date() },
        }),
      ]);
    }
  }
}
