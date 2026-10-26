import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  HttpCode,
  Post,
  Query,
  RawBodyRequest,
  Req,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { AllowAnonymous } from 'src/common/decorators/public.decorator';
import { Roles } from 'src/common/decorators/roles.decorator';
import { RolesEnum } from 'src/common/enums/roles.enum';
import { AuditEvent } from 'src/common/decorators/audit-event.decorator';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { DeliveryWebhooksService } from '../service/delivery-webhooks.service';
import { ReceivedWebhooksQueryDto } from '../dto/delivery-webhooks.dto';

/**
 * DELIVERY CALLBACKS (SH-85 to SH-87).
 *
 * SH-85 and SH-86 are the only machine routes with no login: they are @AllowAnonymous and
 * trust nothing until the provider signature checks out. The service must:
 *   1. verify the signature against the RAW body (needs rawBody: true in main.ts, as for Chapa),
 *   2. reject replays (timestamp window + event id seen before),
 *   3. store every verified event in the provider-events table, then update the delivery record.
 * A rejected callback is audited; a verified one is not (it is already in the events table).
 * A malformed payload is a 400, never a 500. Email complaints opt the address out of
 * non-security email (service).
 */
@ApiTags('Delivery callbacks')
@Controller()
export class DeliveryWebhooksController {
  constructor(private readonly webhooks: DeliveryWebhooksService) {}

  // SH-85
  @AllowAnonymous()
  @SkipThrottle()
  @Post('webhooks/sms/delivery')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @AuditEvent({
    action: AuditEventEnum.PROVIDER_WEBHOOK_REJECTED,
    entity: 'ProviderEvent',
    onSuccess: false,
    onError: (e) => (e instanceof UnauthorizedException || e instanceof BadRequestException ? AuditEventEnum.PROVIDER_WEBHOOK_REJECTED : null),
  })
  async smsDelivery(@Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.webhooks.ingestSms(this.rawBody(req), headers);
  }

  // SH-86
  @AllowAnonymous()
  @SkipThrottle()
  @Post('webhooks/email/events')
  @HttpCode(200)
  @ApiExcludeEndpoint()
  @AuditEvent({
    action: AuditEventEnum.PROVIDER_WEBHOOK_REJECTED,
    entity: 'ProviderEvent',
    onSuccess: false,
    onError: (e) => (e instanceof UnauthorizedException || e instanceof BadRequestException ? AuditEventEnum.PROVIDER_WEBHOOK_REJECTED : null),
  })
  async emailEvents(@Req() req: RawBodyRequest<Request>, @Headers() headers: Record<string, string | string[] | undefined>) {
    return this.webhooks.ingestEmail(this.rawBody(req), headers);
  }

  // SH-87
  @ApiBearerAuth('access-token')
  @Roles(RolesEnum.SUPER_ADMIN)
  @Get('admin/webhooks/received')
  @ApiOperation({ summary: 'Super admin: log of received provider callbacks with the result' })
  received(@Query() q: ReceivedWebhooksQueryDto) {
    return this.webhooks.listReceived(q);
  }

  private rawBody(req: RawBodyRequest<Request>): Buffer {
    if (!req.rawBody) throw new UnauthorizedException('Invalid signature');
    return req.rawBody;
  }
}
