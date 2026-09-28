// src/modules/billing/controller/chapa-webhook.controller.ts
//
// Public route (no JWT). Requires main.ts: NestFactory.create(AppModule, { rawBody: true })
// The webhook body is never trusted: reconcile() re-verifies with Chapa.

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
import { AllowAnonymous } from '../../../common/decorators/public.decorator';
import { ChapaService } from '../../../services/chapa/chapa.service';
import { PaymentService } from '../service/payment.service';

@ApiExcludeController()
@Controller('billing')
export class ChapaWebhookController {
  constructor(
    private readonly chapa: ChapaService,
    private readonly payments: PaymentService,
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

    if (body.tx_ref) await this.payments.reconcile(body.tx_ref);
    return { received: true };
  }
}
