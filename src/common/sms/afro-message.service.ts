import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { normalizePhoneNumber } from 'src/common/utils/phone.util';

export type SendSmsResponse = {
  success: boolean;
  messageId?: string;
  message?: string;
};

@Injectable()
export class AfroMessageService implements OnModuleInit {
  private readonly logger = new Logger(
    AfroMessageService.name,
  );

  constructor(
    private readonly configService: ConfigService,
  ) {}

  /*
   * Registers this instance with the module-level
   * `sendSms()` compatibility function as soon as Nest
   * finishes wiring dependencies — not in the
   * constructor, which can run before the provider is
   * fully resolved, and not left to chance in main.ts.
   *
   * onModuleInit is guaranteed to run exactly once per
   * provider instance, after construction, as long as
   * something in the app actually injects
   * AfroMessageService (e.g. via AuthModule). If nothing
   * injects it, Nest never instantiates it at all — so
   * make sure it's listed as a provider AND either
   * injected somewhere or exported+imported explicitly.
   */
  onModuleInit(): void {
    initializeSmsService(this);
  }

  async sendSms(
    phone: string,
    message: string,
  ): Promise<SendSmsResponse> {
    const normalizedPhone =
      normalizePhoneNumber(phone);

    /*
     * Single flag controls all sensitive logging
     * (OTPs, raw SMS bodies) across the whole auth
     * flow. This MUST be the same flag auth.service.ts
     * checks for its own dev logging — two separate
     * flags (NODE_ENV here vs app.debug there) is how
     * OTPs end up logged in production by accident.
     *
     * Defaults to false — i.e. fails CLOSED. A missing
     * or unpropagated env var must never fail open into
     * logging OTPs and phone numbers.
     */
    const debugLoggingEnabled =
      this.configService.get<boolean>(
        'app.debug',
        false,
      );

    const apiUrl =
      this.configService.get<string>(
        'sms.afroMessage.apiUrl',
      );

    const apiKey =
      this.configService.get<string>(
        'sms.afroMessage.apiKey',
      );

    const senderName =
      this.configService.get<string>(
        'sms.afroMessage.senderName',
        'Ehte',
      );

    /*
     * Validate AfroMessage configuration.
     */
    if (!apiUrl) {
      throw new Error(
        'AfroMessage API URL is not configured',
      );
    }

    if (!apiKey) {
      throw new Error(
        'AfroMessage API key is not configured',
      );
    }

    /*
     * DEBUG-ONLY LOGGING
     *
     * Real SMS is always sent regardless of this flag —
     * this only controls whether the recipient/message
     * are ALSO written to logs for local debugging.
     * Never enable app.debug in production.
     */
    if (debugLoggingEnabled) {
      this.logger.debug(
        `[DEBUG] SMS recipient: ${normalizedPhone}`,
      );

      this.logger.debug(
        `[DEBUG] SMS message: ${message}`,
      );
    }

    try {
      const response = await fetch(
        apiUrl,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            Authorization:
              `Bearer ${apiKey}`,
          },

          body: JSON.stringify({
            from: senderName,
            to: normalizedPhone,
            message,
          }),
        },
      );

      const data =
        await response
          .json()
          .catch(() => null);

      if (!response.ok) {
        this.logger.error(
          `AfroMessage SMS failed: ${response.status}`,
        );

        throw new Error(
          data?.message ||
            `AfroMessage returned HTTP ${response.status}`,
        );
      }

      /*
       * Successful SMS.
       *
       * We only log the phone number.
       * We NEVER log the SMS body here.
       */
      this.logger.log(
        `SMS sent successfully to ${normalizedPhone}`,
      );

      return {
        success: true,

        messageId:
          data?.messageId ??
          data?.id,

        message:
          data?.message ??
          'SMS sent successfully',
      };
    } catch (error) {
      /*
       * Do not log the SMS message here.
       *
       * The error log may safely contain the
       * destination phone number, but never:
       *
       * - OTP
       * - password
       * - password hash
       * - access token
       * - refresh token
       */
      this.logger.error(
        `Failed to send SMS to ${normalizedPhone}`,

        error instanceof Error
          ? error.stack
          : String(error),
      );

      throw error;
    }
  }
}

/*
 * ─────────────────────────────────────────────
 * COMPATIBILITY FUNCTION
 * ─────────────────────────────────────────────
 *
 * Kept so existing callers using:
 *
 * import { sendSms } from
 * 'src/common/sms/afro-message.service';
 *
 * continue to work. Set by AfroMessageService's
 * onModuleInit(), not by hand — do not call
 * initializeSmsService() elsewhere.
 *
 * PREFERRED FIX (not done here to keep this a
 * drop-in patch): stop using this free-function
 * singleton entirely. Have AuthService inject
 * AfroMessageService directly via the constructor
 * and call `this.afroMessageService.sendSms(...)`.
 * That removes the uninitialized-singleton failure
 * mode completely and makes the dependency explicit
 * and unit-testable via normal Nest DI/mocking,
 * instead of relying on module load order.
 */

let smsService:
  AfroMessageService | null = null;

export function initializeSmsService(
  service: AfroMessageService,
): void {
  smsService = service;
}

export async function sendSms(
  phone: string,
  message: string,
): Promise<SendSmsResponse> {
  if (!smsService) {
    /*
     * This should be loud, not swallowed. If it fires,
     * something in AuthModule/AppModule isn't wiring
     * AfroMessageService as a provider — this is a
     * startup/config bug, not a transient SMS failure,
     * and auth.service.ts's generic catch block will
     * otherwise mask it as "SMS send failed."
     */
    throw new Error(
      'AfroMessageService has not been initialized — ' +
        'check that AfroMessageService is registered as ' +
        'a provider and instantiated before any auth flow ' +
        'runs (see onModuleInit in afro-message.service.ts)',
    );
  }

  return smsService.sendSms(
    phone,
    message,
  );
}