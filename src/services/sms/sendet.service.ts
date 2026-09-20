import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { normalizePhoneNumber } from 'src/common/utils/phone.util';

export type SendSmsResponse = {
  success: boolean;
  messageId?: string;
  message?: string;
};

// SendET contract: POST {SENDET_URL}/api/v1/messages with { from, to, body } and Bearer auth.
@Injectable()
export class SendetService implements OnModuleInit {
  private readonly logger = new Logger(SendetService.name);

  constructor(private readonly configService: ConfigService) {}

  onModuleInit(): void {
    initializeSmsService(this);
  }

  async sendSms(phone: string, message: string): Promise<SendSmsResponse> {
    const normalizedPhone = normalizePhoneNumber(phone);
    const maskedPhone = this.maskPhone(normalizedPhone);

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

    // Message body is never logged: it carries OTP codes.
    if (debugLoggingEnabled) {
      this.logger.debug(`SMS to ${maskedPhone} (${message.length} chars)`);
    }

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
          from: senderName,
          to: normalizedPhone,
          body: message,
        }),
        signal: controller.signal,
      });

      const data = await response.json().catch(() => null);

      if (!response.ok) {
        const code = data?.error?.code ? ` (${data.error.code})` : '';
        const detail = data?.error?.message || 'request failed';

        throw new Error(`SendET HTTP ${response.status}${code}: ${detail}`);
      }

      this.logger.log(`SMS sent successfully to ${maskedPhone}`);

      return {
        success: true,
        messageId: data?.message_id ?? data?.id ?? data?.data?.message_id,
        message: data?.message ?? 'SMS sent successfully',
      };
    } catch (error) {
      const failure =
        error instanceof Error && error.name === 'AbortError'
          ? new Error(`SendET request timed out after ${timeoutMs}ms`)
          : error;

      this.logger.error(
        `Failed to send SMS to ${maskedPhone}`,
        failure instanceof Error ? failure.stack : String(failure),
      );

      throw failure;
    } finally {
      clearTimeout(timeout);
    }
  }

  private maskPhone(phone: string): string {
    return phone.length <= 4 ? '****' : `${'*'.repeat(phone.length - 4)}${phone.slice(-4)}`;
  }
}

let smsService: SendetService | null = null;

export function initializeSmsService(service: SendetService): void {
  smsService = service;
}

export async function sendSms(phone: string, message: string): Promise<SendSmsResponse> {
  if (!smsService) {
    throw new Error(
      'SendetService has not been initialized: check that it is registered as a provider ' +
        'and instantiated before any auth flow runs (see onModuleInit in sendet.service.ts)',
    );
  }

  return smsService.sendSms(phone, message);
}