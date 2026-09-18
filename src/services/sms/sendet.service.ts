import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { normalizePhoneNumber } from 'src/common/utils/phone.util';

export type SendSmsResponse = {
  success: boolean;
  messageId?: string;
  message?: string;
};

/*
 * ─────────────────────────────────────────────
 * SendET API CONTRACT — CONFIRMED AGAINST A KNOWN-WORKING REFERENCE
 * IMPLEMENTATION (see below), NOT JUST THE PREVIEW DOCS
 * ─────────────────────────────────────────────
 * Originally implemented against https://send.et/api-docs (a page
 * explicitly labeled by send.et as a documentation PREVIEW). Two
 * details from that preview turned out to be wrong once compared
 * against a working reference SMS service hitting the same API:
 *
 *   1. Endpoint path — preview implied POST https://api.send.et/v1/messages,
 *      and this file appended just "/v1/messages" to SENDET_URL. The
 *      working reference instead hits "/api/v1/messages" against
 *      SENDET_URL (https://api01.send.et), i.e. the full path is:
 *
 *        POST https://api01.send.et/api/v1/messages
 *
 *      The missing "/api" segment meant every request 404'd.
 *
 *   2. Request body field — preview showed "sender" as the field
 *      name for the approved sender name. The working reference
 *      uses "from" instead:
 *
 *        { "from": "ApprovedSenderName", "to": "+251911xxxxxx", "body": "..." }
 *
 * Both fixes below are applied per the working reference. Auth header
 * (Authorization: Bearer <api_key>, Content-Type: application/json)
 * was already correct and unchanged.
 *
 * Still genuinely unconfirmed (unchanged from before):
 *   - the success-response shape (no example given in the preview) —
 *     messageId extraction below is still a best guess across a few
 *     plausible field names, not a confirmed field
 *   - required phone-number format beyond the example
 *     (+251911xxxxxx suggests E.164, so normalizePhoneNumber()'s
 *     output is assumed to already produce that — verify it does)
 *   - whether SENDET_SENDER_NAME needs prior approval/registration
 *     before SendET will accept it (their KYB/sender-name-approval
 *     flow suggests yes)
 *
 * Confirm against your real API key + a real send, and update this
 * comment block (and the implementation, if anything differs) at
 * that point.
 */
@Injectable()
export class SendetService implements OnModuleInit {
  private readonly logger = new Logger(SendetService.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    initializeSmsService(this);
  }

  async sendSms(phone: string, message: string): Promise<SendSmsResponse> {
    const normalizedPhone = normalizePhoneNumber(phone);

    const debugLoggingEnabled = this.configService.get<boolean>('app.debug', false);

    const baseUrl = this.configService.get<string>('sms.sendet.apiUrl');
    const apiToken = this.configService.get<string>('sms.sendet.token');
    const senderName = this.configService.get<string>('sms.sendet.senderName', 'PITRON TECH');
    const timeoutMs = this.configService.get<number>('sms.sendet.timeoutMs', 10000);

    if (!baseUrl) {
      throw new Error('SendET API URL is not configured');
    }

    if (!apiToken) {
      throw new Error('SendET API token is not configured');
    }

    if (debugLoggingEnabled) {
      this.logger.debug(`[DEBUG] SMS recipient: ${normalizedPhone}`);
      this.logger.debug(`[DEBUG] SMS message: ${message}`);
    }

    // FIXED: confirmed working path is /api/v1/messages, not /v1/messages.
    // SENDET_URL is the bare host (e.g. https://api01.send.et) — this
    // appends /api/v1/messages to it.
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/api/v1/messages`;

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiToken}`,
        },
        body: JSON.stringify({
          // FIXED: confirmed field name is "from", not "sender".
          from: senderName,
          to: normalizedPhone,
          body: message,
        }),
        signal: controller.signal,
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        // Preview's error shape: { error: { code, message, request_id, retry_after_seconds? } }
        const errorMessage = data?.error?.message || `SendET returned HTTP ${response.status}`;

        this.logger.error(
          `SendET SMS failed: ${response.status}${
            data?.error?.code ? ` (${data.error.code})` : ''
          }`,
        );

        throw new Error(errorMessage);
      }

      this.logger.log(`SMS sent successfully to ${normalizedPhone}`);

      // Success-response shape was not shown in the preview docs — trying
      // a few plausible field names rather than assuming one confirmed
      // name. Verify the real field once you can inspect an actual response.
      return {
        success: true,
        messageId: data?.message_id ?? data?.id ?? data?.data?.message_id,
        message: data?.message ?? 'SMS sent successfully',
      };
    } catch (error) {
      this.logger.error(
        `Failed to send SMS to ${normalizedPhone}`,
        error instanceof Error ? error.stack : String(error),
      );

      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}

/*
 * ─────────────────────────────────────────────
 * COMPATIBILITY FUNCTION
 * ─────────────────────────────────────────────
 * Kept so existing callers using:
 *
 *   import { sendSms } from 'src/services/sms/sendet.service';
 *
 * continue to work exactly like they did against AfroMessage.
 * Set by SendetService's onModuleInit(), not by hand.
 */
let smsService: SendetService | null = null;

export function initializeSmsService(service: SendetService): void {
  smsService = service;
}

export async function sendSms(phone: string, message: string): Promise<SendSmsResponse> {
  if (!smsService) {
    throw new Error(
      'SendetService has not been initialized — check that SendetService is ' +
        'registered as a provider and instantiated before any auth flow runs ' +
        '(see onModuleInit in sendet.service.ts)',
    );
  }

  return smsService.sendSms(phone, message);
}