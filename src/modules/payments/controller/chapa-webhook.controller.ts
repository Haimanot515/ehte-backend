import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  HttpCode,
  Post,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiExcludeEndpoint, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';

import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { ChapaService } from 'src/infrastructure/chapa/chapa.service';

import { ChapaWebhookService } from '../service/chapa-webhook.service';
import { TransferApprovalDto } from '../dto/payments.dto';

/**
 * CHAPA CALLBACKS. Both routes are @AllowAnonymous: they trust nothing until the signature checks out.
 *
 * Service methods expected on ChapaWebhookService:
 *   handleEvent(payload)        -> void
 *       NEVER trusts the body. Takes tx_ref (or the transfer reference) from it, asks Chapa to verify,
 *       then updates Payment or Disbursement. Safe to receive twice (idempotent).
 *       After a Payment becomes PAID it asks PayoutService to send that victim's unsent balance.
 *   approveTransfer(dto)        -> boolean
 *       Approve ONLY when a Disbursement with dto.reference exists in CREATED or SUBMITTED, the amount
 *       equals Disbursement.amount, account number + holder match destinationSnapshot, the victim has
 *       payoutsPaused = false, and the payment total still covers it. Anything else -> false.
 *
 * ChapaService additions expected:
 *   verifyApprovalSignature(signature?: string): boolean
 *       Chapa-Signature = HMAC-SHA256(approvalSecret, approvalSecret), hex, constant-time compare.
 *       New env: CHAPA_APPROVAL_SECRET (add to configuration.ts and the Joi schema).
 */
@ApiTags('Chapa callbacks')
@Controller('webhooks/chapa')
export class ChapaWebhookController {
  constructor(
    private readonly chapa: ChapaService,
    private readonly webhooks: ChapaWebhookService,
  ) {}

  // Payment (and transfer) events.
  @Post()
  @AllowAnonymous()
  @SkipThrottle()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @AuditEvent({
    action: AuditEventEnum.PROVIDER_WEBHOOK_REJECTED,
    entity: 'ProviderEvent',
    onSuccess: false,
    onError: (e) =>
      e instanceof UnauthorizedException || e instanceof BadRequestException
        ? AuditEventEnum.PROVIDER_WEBHOOK_REJECTED
        : null,
  })
  async events(
    @Req() req: RawBodyRequest<Request>,
    @Headers('x-chapa-signature') payloadSignature?: string,
    @Headers('chapa-signature') secretSignature?: string,
  ) {
    const raw = req.rawBody;
    if (!raw) throw new BadRequestException('raw_body_missing');

    if (!this.chapa.verifyWebhookSignature(raw, payloadSignature, secretSignature)) {
      throw new UnauthorizedException('invalid_signature');
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw new BadRequestException('invalid_json');
    }

    await this.webhooks.handleEvent(payload);
    return { received: true };
  }

  // Transfer approval URL (Chapa "Server approval"). Chapa wants exactly 200 (approve) or 400 (reject).
  // Fail closed: any doubt or error means 400, so money is never sent on an unclear check.
  @Post('transfer-approval')
  @AllowAnonymous()
  @SkipThrottle()
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @AuditEvent({
    action: AuditEventEnum.PROVIDER_WEBHOOK_REJECTED,
    entity: 'ProviderEvent',
    onSuccess: false,
    onError: () => AuditEventEnum.PROVIDER_WEBHOOK_REJECTED,
  })
  async approveTransfer(
    @Body() body: TransferApprovalDto,
    @Headers('chapa-signature') signature?: string,
  ) {
    // Approval calls carry only the chapa-signature header (HMAC of the webhook secret), no body signature.
    if (!this.chapa.verifyWebhookSignature(Buffer.alloc(0), undefined, signature)) {
      throw new BadRequestException('transfer_rejected');
    }

    let approved = false;
    try {
      approved = await this.webhooks.approveTransfer(body);
    } catch {
      approved = false;
    }
    if (!approved) throw new BadRequestException('transfer_rejected');

    return { approved: true };
  }
}