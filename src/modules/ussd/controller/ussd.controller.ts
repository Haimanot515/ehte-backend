import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { timingSafeEqual } from 'crypto';
import type { Request, Response } from 'express';
import { AllowAnonymous } from '../../../common/decorators/public.decorator';
import { UssdMenuService } from '../service/ussd-menu.service';
import { AfricasTalkingStyleAdapter } from '../service/adapters/africastalking-style.adapter';
// import { EthioTelecomAdapter } from '../service/adapters/ethio-telecom.adapter'; // swap in once confirmed

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

// No "v1/" here: URI versioning already adds /v1 (the old path was /v1/v1/ussd/session).
@Controller('ussd')
export class UssdController {
  constructor(
    private readonly menu: UssdMenuService,
    private readonly adapter: AfricasTalkingStyleAdapter, // swap for EthioTelecomAdapter later
    private readonly config: ConfigService,
  ) {}

  /**
   * Only the telecom gateway may call this. A request passes if it carries the shared
   * secret (header x-ussd-secret, or ?secret= for gateways that cannot send headers)
   * or comes from an allowed IP (USSD_ALLOWED_IPS, comma-separated).
   * Outside development, with neither setting configured, every request is refused.
   */
  private assertFromGateway(req: Request): void {
    const secret = this.config.get<string>('USSD_GATEWAY_SECRET') ?? '';
    const allowedIps = (this.config.get<string>('USSD_ALLOWED_IPS') ?? '')
      .split(',')
      .map((ip) => ip.trim())
      .filter(Boolean);

    if (!secret && allowedIps.length === 0) {
      const env = this.config.get<string>('app.env') ?? process.env.NODE_ENV ?? '';
      if (env === 'development' || env === 'test') return;
      throw new ForbiddenException('ussd_gateway_not_configured');
    }

    const headerValue = req.headers['x-ussd-secret'];
    const queryValue = req.query?.secret;
    const provided =
      (Array.isArray(headerValue) ? headerValue[0] : headerValue) ??
      (typeof queryValue === 'string' ? queryValue : '');

    if (secret && provided && safeEqual(provided, secret)) return;

    const ip = (req.ip ?? '').replace(/^::ffff:/, '');
    if (ip && allowedIps.includes(ip)) return;

    throw new ForbiddenException('ussd_caller_not_allowed');
  }

  // The gateway calls this webhook directly, so no end-user login applies; the caller check above protects it instead.
  @AllowAnonymous()
  @Post('session')
  @HttpCode(200)
  async handleSession(@Req() req: Request, @Body() rawBody: any, @Res() res: Response) {
    this.assertFromGateway(req);

    const inbound = this.adapter.parseInbound(rawBody);
    const result = await this.menu.handle(inbound);
    const { body, contentType } = this.adapter.formatOutbound(result);
    res.set('Content-Type', contentType);
    res.send(body);
  }
}
