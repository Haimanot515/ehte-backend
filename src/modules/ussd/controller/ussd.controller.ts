import { Body, Controller, HttpCode, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { AllowAnonymous } from '../../../common/decorators/public.decorator';
import { UssdMenuService } from '../service/ussd-menu.service';
import { AfricasTalkingStyleAdapter } from '../service/adapters/africastalking-style.adapter';
// import { EthioTelecomAdapter } from '../service/adapters/ethio-telecom.adapter'; // swap in once confirmed

@Controller('v1/ussd')
export class UssdController {
  constructor(
    private readonly menu: UssdMenuService,
    private readonly adapter: AfricasTalkingStyleAdapter, // swap for EthioTelecomAdapter later
  ) {}

  // The gateway calls this webhook directly — no end-user auth applies here, matching your
  // existing @AllowAnonymous() convention. Confirm this is the right guard bypass for this route.
  @AllowAnonymous()
  @Post('session')
  @HttpCode(200)
  async handleSession(@Body() rawBody: any, @Res() res: Response) {
    const inbound = this.adapter.parseInbound(rawBody);
    const result = await this.menu.handle(inbound);
    const { body, contentType } = this.adapter.formatOutbound(result);
    res.set('Content-Type', contentType);
    res.send(body);
  }
}