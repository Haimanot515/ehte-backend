import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AllowAnonymous } from '../../../../common/decorators/public.decorator';
import { ChapaService } from '../../../../infrastructure/chapa/chapa.service';
import { PaymentService } from 'src/modules/billing/payment/service/payment.service';
import { PaymentAdminService } from 'src/modules/billing/payment-admin/service/payment-admin.service';

@ApiExcludeController()
@Controller('billing')
export class ChapaWebhookController {
  constructor(
    private readonly chapa: ChapaService,
    private readonly payments: PaymentService,
    private readonly paymentAdmin: PaymentAdminService,
  ) {}

  @AllowAnonymous()
  @SkipThrottle()
  @Post('webhook/chapa')
  @HttpCode(200)
  async handle(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-chapa-signature') sigA?: string,
    @Headers('chapa-signature') sigB?: string,
  ) {
    const raw = req.rawBody;
    if (!raw || !this.chapa.verifyWebhookSignature(raw, sigA ?? sigB)) {
      throw new UnauthorizedException('Invalid signature');
    }

    // Body is signature-verified but still attacker-shaped JSON: a malformed
    // or unexpectedly-encoded payload must not become an uncaught 500.
    let body: { tx_ref?: string };
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('invalid_payload');
    }

    // BL-17: keep a record of every signed callback. Never blocks the webhook.
    const eventId = await this.paymentAdmin.recordWebhookEvent(body);

    try {
      if (body.tx_ref) await this.payments.reconcile(body.tx_ref);
      await this.paymentAdmin.finishWebhookEvent(eventId, body.tx_ref ? 'RECONCILED' : 'IGNORED');
    } catch (err) {
      await this.paymentAdmin.finishWebhookEvent(eventId, 'ERROR', String((err as Error).message));
      throw err;
    }
    return { received: true };
  }
}
