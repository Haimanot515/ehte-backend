import { UssdInboundDto, UssdOutboundResult } from '../../dto/ussd-session.dto';

export interface UssdGatewayAdapter {
  /** Parse a raw inbound webhook payload (whatever shape the gateway sends) into a normalized DTO. */
  parseInbound(rawBody: any): UssdInboundDto;
  /** Format the normalized outbound text + continue flag into whatever shape/headers the gateway expects. */
  formatOutbound(result: UssdOutboundResult): { body: string; contentType: string };
}
