import { Injectable } from '@nestjs/common';
import { UssdGatewayAdapter } from './ussd-gateway-adapter.interface';
import { UssdInboundDto, UssdOutboundResult } from '../../dto/ussd-session.dto';

/**
 * Generic fallback adapter matching the widely-used "Africa's Talking style" USSD contract.
 * Useful for local testing with curl/simulators even though it is NOT confirmed to be Ethio
 * Telecom's actual contract — see ethio-telecom.adapter.ts for the real integration point.
 */
@Injectable()
export class AfricasTalkingStyleAdapter implements UssdGatewayAdapter {
  parseInbound(rawBody: any): UssdInboundDto {
    const { sessionId, phoneNumber, text = '', serviceCode } = rawBody ?? {};
    const segments = String(text).split('*').filter(Boolean);
    const input = segments.length > 0 ? segments[segments.length - 1] : '';
    return { sessionId, phoneNumber, input, serviceCode };
  }

  formatOutbound(result: UssdOutboundResult): { body: string; contentType: string } {
    const prefix = result.continueSession ? 'CON ' : 'END ';
    return { body: prefix + result.text, contentType: 'text/plain' };
  }
}
