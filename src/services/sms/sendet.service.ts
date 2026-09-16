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
 * SendET API CONTRACT — SOURCED FROM A "PREVIEW" PAGE, NOT CONFIRMED FINAL
 * ─────────────────────────────────────────────
 * Implemented against https://send.et/api-docs, which is explicitly
 * labeled by send.et themselves as a documentation PREVIEW:
 *
 *   "This page previews structure and payloads. Final paths, headers,
 *    and enums will ship with the public release notes for send.et."
 *
 * What that preview shows for sending a single SMS:
 *
 *   POST https://api.send.et/v1/messages
 *   Authorization: Bearer <api_key>
 *   Content-Type: application/json
 *   {
 *     "to": "+251911xxxxxx",
 *     "sender": "ApprovedSenderName",
 *     "body": "message text"
 *   }
 *
 *   Error shape (used for non-2xx, including 429 rate limiting):
 *   {
 *     "error": {
 *       "code": "invalid_parameter",
 *       "message": "...",
 *       "request_id": "req_...",
 *       "retry_after_seconds": 2   // only present on 429
 *     }
 *   }
 *
 * What it does NOT show, and is still genuinely unconfirmed:
 *   - the success-response shape (no example given) — messageId
 *     extraction below is a best guess across a few common field
 *     names, not a confirmed field
 *   - whether the base env value SENDET_URL (https://api01.send.et)
 *     matches the preview's api.send.et host at all — this
 *     implementation trusts configuration's SENDET_URL + appends
 *     /v1/messages, but if your issued production URL already
 *     includes a path or a different host, this will 404
 *   - required phone-number format beyond the example
 *     (+251911xxxxxx suggests E.164, so normalizePhoneNumber()'s
 *     output is assumed to already produce that — verify it does)
 *   - whether SENDET_SENDER_NAME needs prior approval/registration
 *     before SendET will accept it (their KYB/sender-name-approval
 *     flow suggests yes)
 *
 * DO NOT treat this as production-verified. Confirm against your
 * real API key + a real send once issued, and update this comment
 * block (and the implementation, if anything differs) at that point.
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

    // Preview docs show the send endpoint at https://api.send.et/v1/messages.
    // SENDET_URL in your .env is currently https://api01.send.et, a
    // different host — this appends /v1/messages to whatever SENDET_URL
    // is configured as, but the host mismatch itself is unconfirmed and
    // worth checking against your issued production URL.
    const endpoint = `${baseUrl.replace(/\/+$/, '')}/v1/messages`;

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
          to: normalizedPhone,
          sender: senderName,
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