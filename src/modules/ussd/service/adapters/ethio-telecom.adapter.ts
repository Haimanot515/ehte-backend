import { Injectable } from '@nestjs/common';
import { UssdGatewayAdapter } from './ussd-gateway-adapter.interface';
import { UssdInboundDto, UssdOutboundResult } from '../../dto/ussd-session.dto';

/**
 * PLACEHOLDER — fill in against Ethio Telecom's actual USSD webhook contract once you have it
 * from their short-code/USSD provisioning process (separate from the public telebirr API docs
 * at https://developer.ethiotelecom.et). Field names below are guesses and MUST be corrected.
 */
@Injectable()
export class EthioTelecomAdapter implements UssdGatewayAdapter {
  parseInbound(rawBody: any): UssdInboundDto {
    // TODO: replace field names once confirmed with Ethio Telecom's spec
    const { sessionId, msisdn, ussdString = '', serviceCode } = rawBody ?? {};
    return { sessionId, phoneNumber: msisdn, input: ussdString, serviceCode };
  }

  formatOutbound(result: UssdOutboundResult): { body: string; contentType: string } {
    // TODO: replace with the confirmed response shape
    return {
      body: JSON.stringify({ message: result.text, continueSession: result.continueSession }),
      contentType: 'application/json',
    };
  }
}
