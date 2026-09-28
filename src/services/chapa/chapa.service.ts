// src/services/chapa/chapa.service.ts
//
// Ehte version. Differences from the Pitron Entertainment service:
//   - base URL via ConfigService (with default), no process.env reads
//   - safe webhook signature check (no RangeError on bad header)
//   - exact Decimal amount match, no float tolerance
//   - opaque tx_ref (no user/profile ids ever reach Chapa)
//   - no PII in logs
//   - transfer() for payouts

import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';
import { Prisma } from '@prisma/client';

type ChapaMessage = string | Record<string, string[]> | null | undefined;

function messageToString(msg: ChapaMessage): string {
  if (!msg) return 'Unknown error';
  if (typeof msg === 'string') return msg;
  return Object.entries(msg)
    .map(([field, errs]) => `${field}: ${errs.join(', ')}`)
    .join(' | ');
}

type ChapaEnvelope = { status: string; message?: ChapaMessage };

export type ChapaVerifyData = {
  currency: string;
  amount: string;
  charge?: string;
  status: 'success' | 'failed' | 'pending';
  reference?: string;
  tx_ref: string;
};

export type ChapaInitInput = {
  amount: Prisma.Decimal;
  email: string;
  firstName: string;
  lastName: string;
  txRef: string;
  returnUrl: string;
  callbackUrl: string;
  title: string; // keep generic, e.g. "Ehte"
  description: string; // keep generic, e.g. "Ehte support"
};

export type ChapaTransferInput = {
  accountName: string;
  accountNumber: string;
  bankCode: string | number;
  amount: Prisma.Decimal;
  reference: string;
};

@Injectable()
export class ChapaService {
  private readonly logger = new Logger(ChapaService.name);
  private readonly secretKey: string;
  private readonly webhookSecret: string;
  private readonly baseUrl: string;

  // Single source of truth for the settlement currency. Was hardcoded as
  // 'ETB' independently in initialize() and transfer() — now read once here
  // from the same SUPPORT_CURRENCY config the rest of billing uses, so the
  // two call sites can't drift out of sync with each other again.
  private readonly currency: string;

  // Request timeout, checkout title/description length caps. Were literals
  // (15_000 / 16 / 50) inline at each call site; now config-driven so they
  // can be tuned per environment without a code change.
  private readonly requestTimeoutMs: number;
  private readonly titleMaxLength: number;
  private readonly descriptionMaxLength: number;

  constructor(config: ConfigService) {
    this.secretKey = config.get<string>('chapa.secretKey', '');
    this.webhookSecret = config.get<string>('chapa.webhookSecret', '');
    this.baseUrl = config
      .get<string>('chapa.baseUrl', 'https://api.chapa.co/v1')
      .replace(/\/+$/, '');

    this.currency = config.get<string>('support.currency', 'ETB');
    this.requestTimeoutMs = config.get<number>('chapa.timeoutMs', 15_000);
    this.titleMaxLength = config.get<number>('chapa.titleMaxLength', 16);
    this.descriptionMaxLength = config.get<number>('chapa.descriptionMaxLength', 50);
  }

  // ── Low-level request ─────────────────────────────────────────────────────

  private async request<T extends ChapaEnvelope>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    if (!this.secretKey) {
      throw new ServiceUnavailableException('Payments are not configured');
    }

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.secretKey}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(this.requestTimeoutMs),
    });

    const raw = await res.text();
    let data: T;
    try {
      data = JSON.parse(raw) as T;
    } catch {
      this.logger.error(`[Chapa] ${method} ${path} non-JSON (HTTP ${res.status})`);
      throw new BadRequestException(`Chapa request failed: HTTP ${res.status}`);
    }

    if (!res.ok || data.status !== 'success') {
      const msg = messageToString(data.message) || `HTTP ${res.status}`;
      this.logger.error(`[Chapa] ${method} ${path} failed (HTTP ${res.status}): ${msg}`);
      throw new BadRequestException(`Chapa request failed: ${msg}`);
    }
    return data;
  }

  // Chapa rejects title/description with characters outside [a-zA-Z0-9-_ .]
  private sanitize(str: string, maxLen: number): string {
    const clean = str
      .replace(/[^a-zA-Z0-9\-_ .]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .substring(0, maxLen);
    return clean || 'Ehte';
  }

  // ── Collection ────────────────────────────────────────────────────────────

  async initialize(input: ChapaInitInput): Promise<{ checkoutUrl: string; txRef: string }> {
    const res = await this.request<ChapaEnvelope & { data: { checkout_url: string } }>(
      'POST',
      '/transaction/initialize',
      {
        amount: input.amount.toFixed(2),
        currency: this.currency,
        email: input.email.trim(),
        first_name: (input.firstName || 'Supporter').trim(),
        last_name: (input.lastName || 'Ehte').trim(),
        tx_ref: input.txRef,
        return_url: input.returnUrl,
        callback_url: input.callbackUrl,
        customization: {
          title: this.sanitize(input.title, this.titleMaxLength),
          description: this.sanitize(input.description, this.descriptionMaxLength),
        },
      },
    );

    this.logger.log(`[Chapa] initialized tx_ref=${input.txRef}`);
    return { checkoutUrl: res.data.checkout_url, txRef: input.txRef };
  }

  async verify(txRef: string): Promise<ChapaVerifyData> {
    const res = await this.request<ChapaEnvelope & { data: ChapaVerifyData }>(
      'GET',
      `/transaction/verify/${encodeURIComponent(txRef)}`,
    );
    return res.data;
  }

  /** Exact match on amount and currency. Returns false instead of throwing. */
  paidAmountMatches(
    returned: { amount: string; currency: string },
    expected: { amount: Prisma.Decimal; currency: string },
  ): boolean {
    try {
      return (
        new Prisma.Decimal(returned.amount).equals(expected.amount) &&
        returned.currency.toUpperCase() === expected.currency.toUpperCase()
      );
    } catch {
      return false;
    }
  }

  // ── Webhook signature ─────────────────────────────────────────────────────
  // Confirm the exact scheme and header names in Chapa's webhook docs.

  verifyWebhookSignature(rawBody: Buffer, signature?: string): boolean {
    if (!this.webhookSecret || !signature) return false;
    const expected = crypto.createHmac('sha256', this.webhookSecret).update(rawBody).digest();
    const received = Buffer.from(signature, 'hex');
    return received.length === expected.length && crypto.timingSafeEqual(received, expected);
  }

  // ── Payouts ───────────────────────────────────────────────────────────────
  // Chapa transfers may sit in a validation/approval step before they are
  // queued, so a successful call means "accepted", not "paid". Not safe to
  // retry blindly on failure — confirm with Chapa's docs whether a repeated
  // call with the same `reference` is rejected as a duplicate before adding
  // any automatic retry logic around this method.

  async transfer(input: ChapaTransferInput): Promise<void> {
    await this.request('POST', '/transfers', {
      account_name: input.accountName,
      account_number: input.accountNumber,
      bank_code: input.bankCode,
      amount: input.amount.toFixed(2),
      currency: this.currency,
      reference: input.reference,
    });
    this.logger.log(`[Chapa] transfer accepted reference=${input.reference}`);
  }

  /**
   * Banks Chapa can pay out to. Transfers need Chapa's bank code, and VictimProfile.bankName is free text,
   * so the admin picks the code at payout time. Confirm the endpoint/shape in Chapa's docs.
   */
  async getBanks(): Promise<Array<Record<string, unknown>>> {
    const res = await this.request<ChapaEnvelope & { data: Array<Record<string, unknown>> }>(
      'GET',
      '/banks',
    );
    return res.data;
  }

  /** Check the exact verify-transfer endpoint in Chapa's docs before shipping. */
  async verifyTransfer(reference: string): Promise<{ status: string }> {
    const res = await this.request<ChapaEnvelope & { data: { status: string } }>(
      'GET',
      `/transfers/verify/${encodeURIComponent(reference)}`,
    );
    return res.data;
  }

  // ── References ────────────────────────────────────────────────────────────

  /** Random, opaque, <= 50 chars. Do not embed any identifier. */
  generateTxRef(prefix = 'ehte'): string {
    return `${prefix}-${crypto.randomBytes(12).toString('hex')}`;
  }
}