import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NotificationType, Prisma } from '@prisma/client';
import { createHash, createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from 'src/prisma/prisma.service';
import { NotificationService } from 'src/modules/misc/notification/service/notification.service';
import { pageMeta, paging } from '../../common/paging.util';
import { ProviderEventKind, ProviderEventResult, ReceivedWebhooksQueryDto } from '../dto/delivery-webhooks.dto';

type Headers = Record<string, string | string[] | undefined>;
type Channel = 'SMS' | 'EMAIL';
type Outcome = 'delivered' | 'failed' | 'bounced' | 'complaint' | 'ignored';

interface ChannelSettings {
  provider: string;
  secret?: string;
  signatureHeader: string;
  timestampHeader: string;
  toleranceSeconds: number;
}

interface ParsedEvent {
  payload: Record<string, unknown>;
  eventId: string;
  providerMessageId: string | null;
  eventType: string | null;
  outcome: Outcome;
  address: string | null;
  reason: string | null;
  providerCode: string | null;
}

// Security notifications are never switched off by a complaint. Same list as the notification service.
const LOCKED_TYPES = new Set<string>(['SECURITY_ALERT', 'PASSWORD_CHANGED', 'PASSWORD_RESET']);

const DEFAULT_TOLERANCE_SECONDS = 300;
const ID_KEYS = ['messageId', 'message_id', 'msgId', 'msg_id', 'MessageSid', 'sg_message_id', 'id'];
const EVENT_ID_KEYS = ['eventId', 'event_id', 'webhookId', 'webhook_id', 'id'];
const STATUS_KEYS = ['event', 'eventType', 'event_type', 'status', 'state', 'delivery_status', 'deliveryStatus'];
const ADDRESS_KEYS = ['email', 'recipient', 'to', 'address', 'phone', 'msisdn', 'phoneNumber'];
const REASON_KEYS = ['reason', 'error', 'error_message', 'errorMessage', 'description', 'response'];
const CODE_KEYS = ['code', 'error_code', 'errorCode', 'status_code', 'smtp_code'];
const TIME_KEYS = ['timestamp', 'time', 'ts', 'occurredAt', 'occurred_at'];
const PII_KEYS = /^(to|phone|phonenumber|msisdn|recipient|email|address|from)$/i;

const DELIVERED = new Set(['delivered', 'delivery', 'success', 'successful', 'sent_ok']);
const FAILED = new Set(['failed', 'failure', 'undelivered', 'rejected', 'expired', 'error', 'dropped', 'deferred_expired']);
const BOUNCED = new Set(['bounce', 'bounced', 'hard_bounce', 'hardbounce', 'blocked']);
const COMPLAINT = new Set(['complaint', 'complained', 'spamreport', 'spam_report', 'spam']);

@Injectable()
export class DeliveryWebhooksService {
  private readonly logger = new Logger(DeliveryWebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly notifications: NotificationService,
  ) {}

  // SH-85
  ingestSms(raw: Buffer, headers: Headers) {
    return this.ingest('SMS', raw, headers);
  }

  // SH-86
  ingestEmail(raw: Buffer, headers: Headers) {
    return this.ingest('EMAIL', raw, headers);
  }

  // SH-87
  async listReceived(q: ReceivedWebhooksQueryDto) {
    const { page, limit, skip } = paging(q);
    const where: Prisma.ProviderEventWhereInput = {
      ...(q.provider ? { provider: q.provider } : {}),
      ...(q.kind ? { kind: q.kind } : {}),
      ...(q.result ? { result: q.result } : {}),
      ...(q.eventType ? { eventType: q.eventType } : {}),
      ...(q.providerMessageId ? { providerMessageId: q.providerMessageId } : {}),
      ...(q.signatureValid !== undefined ? { signatureValid: q.signatureValid } : {}),
      ...(q.from || q.to
        ? {
            receivedAt: {
              ...(q.from ? { gte: new Date(q.from) } : {}),
              ...(q.to ? { lte: new Date(q.to) } : {}),
            },
          }
        : {}),
    };

    const [rows, total] = await this.prisma.$transaction([
      this.prisma.providerEvent.findMany({
        where,
        orderBy: { receivedAt: 'desc' },
        skip,
        take: limit,
        // The payload is left out on purpose: it can hold phone numbers and email addresses
        select: {
          id: true,
          provider: true,
          kind: true,
          eventId: true,
          providerMessageId: true,
          eventType: true,
          signatureValid: true,
          result: true,
          error: true,
          receivedAt: true,
          processedAt: true,
        },
      }),
      this.prisma.providerEvent.count({ where }),
    ]);

    return { data: rows, meta: pageMeta(page, limit, total) };
  }

  // ── ingest pipeline ───────────────────────────────────────────────────────

  private async ingest(channel: Channel, raw: Buffer, headers: Headers) {
    const settings = this.settings(channel);
    const kind: ProviderEventKind = channel === 'SMS' ? 'SMS_DELIVERY' : 'EMAIL_EVENT';

    // 1. Signature, against the raw bytes. Nothing is stored for a bad signature, so a stranger
    //    cannot fill the table. The controller audits the rejection.
    this.verifySignature(settings, raw, headers);

    // 2. Payload. A malformed body is a 400, never a 500.
    const payload = this.parseBody(raw);
    const eventId = this.eventIdOf(payload, raw);

    // 3. Replay window. The signature is good here, so the attempt is kept in the events table.
    const timestamp = this.timestampOf(headers, settings, payload);
    if (!timestamp || Math.abs(Date.now() - timestamp.getTime()) > settings.toleranceSeconds * 1000) {
      await this.storeRejected(settings, kind, eventId, payload, 'timestamp_outside_window');
      throw new UnauthorizedException('Invalid signature');
    }

    // 4. Store the verified event. The unique (provider, eventId) key is the replay guard.
    const parsed = this.parseEvent(channel, payload, eventId);
    let eventRowId: string;
    try {
      const row = await this.prisma.providerEvent.create({
        data: {
          provider: settings.provider,
          kind,
          eventId,
          providerMessageId: parsed.providerMessageId,
          eventType: parsed.eventType,
          payload: this.redact(payload) as Prisma.InputJsonValue,
          signatureValid: true,
          result: 'RECEIVED',
        },
        select: { id: true },
      });
      eventRowId = row.id;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return { received: true, result: 'DUPLICATE' as ProviderEventResult };
      }
      throw err;
    }

    // 5. Apply it. A failure here is recorded on the event and answered with 200,
    //    otherwise the provider would retry the same event forever.
    try {
      const outcome = await this.apply(channel, parsed);
      await this.finish(eventRowId, outcome.result, outcome.error);
      return { received: true, result: outcome.result };
    } catch (err) {
      this.logger.error(`Applying ${kind} ${eventId} failed: ${this.safeError(err)}`);
      await this.finish(eventRowId, 'ERROR', this.safeError(err));
      return { received: true, result: 'ERROR' as ProviderEventResult };
    }
  }

  private async apply(channel: Channel, e: ParsedEvent): Promise<{ result: ProviderEventResult; error?: string }> {
    if (e.outcome === 'ignored') return { result: 'IGNORED', error: 'event_type_not_tracked' };
    if (!e.providerMessageId) return { result: 'IGNORED', error: 'missing_message_id' };

    const delivery = await this.prisma.notificationDelivery.findFirst({
      where: { providerMessageId: e.providerMessageId, channel },
      select: { id: true, status: true },
    });

    const now = new Date();
    const providerStatus = (e.eventType ?? e.outcome).slice(0, 100);

    if (delivery) {
      if (e.outcome === 'delivered') {
        await this.prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: { providerStatus, deliveredAt: now },
        });
      } else {
        await this.prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: {
            providerStatus,
            status: 'FAILED',
            failedAt: now,
            lastError: (e.reason ?? e.outcome).slice(0, 500),
          },
        });
      }
    }

    // Side effects that matter even when the delivery row is gone
    if (channel === 'EMAIL' && e.address) {
      if (e.outcome === 'bounced') {
        await this.notifications.recordBounce({
          channel: 'EMAIL',
          address: e.address,
          reason: e.reason ?? 'bounced',
          providerCode: e.providerCode,
        });
      } else if (e.outcome === 'complaint') {
        await this.optOutOfNonSecurityEmail(e.address);
      }
    }

    if (!delivery && e.outcome !== 'bounced' && e.outcome !== 'complaint') {
      return { result: 'IGNORED', error: 'unknown_message' };
    }
    return { result: 'APPLIED' };
  }

  // A complaint means "stop emailing me". Security emails stay on, they are locked.
  private async optOutOfNonSecurityEmail(address: string) {
    const user = await this.prisma.user.findFirst({
      where: { email: { equals: address.trim(), mode: 'insensitive' } },
      select: { id: true },
    });
    if (!user) return;

    const types = (Object.values(NotificationType) as string[]).filter((t) => !LOCKED_TYPES.has(t));
    await this.prisma.$transaction(
      types.map((type) =>
        this.prisma.notificationPreference.upsert({
          where: { userId_type: { userId: user.id, type: type as NotificationType } },
          create: { userId: user.id, type: type as NotificationType, email: false },
          update: { email: false },
        }),
      ),
    );
  }

  // ── signature and parsing ─────────────────────────────────────────────────

  private verifySignature(settings: ChannelSettings, raw: Buffer, headers: Headers) {
    // Fail closed: no secret configured means nothing can be trusted
    if (!settings.secret) {
      this.logger.error(`No webhook secret configured for ${settings.provider}`);
      throw new UnauthorizedException('Invalid signature');
    }

    const given = this.header(headers, settings.signatureHeader)?.replace(/^sha256=/i, '').trim();
    if (!given) throw new UnauthorizedException('Invalid signature');

    // When the provider sends a timestamp header it is part of the signed text
    const timestampHeader = this.header(headers, settings.timestampHeader);
    const signed = timestampHeader ? Buffer.concat([Buffer.from(`${timestampHeader}.`), raw]) : raw;
    const expected = createHmac('sha256', settings.secret).update(signed).digest();

    // Providers send hex or base64
    const candidates = [Buffer.from(given, 'hex'), Buffer.from(given, 'base64')];
    const ok = candidates.some((c) => c.length === expected.length && timingSafeEqual(c, expected));
    if (!ok) throw new UnauthorizedException('Invalid signature');
  }

  private parseBody(raw: Buffer): Record<string, unknown> {
    const text = raw.toString('utf8').trim();
    if (!text) throw new BadRequestException('invalid_payload');

    let parsed: unknown;
    try {
      parsed = text.startsWith('{') || text.startsWith('[')
        ? JSON.parse(text)
        : Object.fromEntries(new URLSearchParams(text)); // some SMS providers post form data
    } catch {
      throw new BadRequestException('invalid_payload');
    }

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new BadRequestException('invalid_payload');
    }
    return parsed as Record<string, unknown>;
  }

  private parseEvent(channel: Channel, payload: Record<string, unknown>, eventId: string): ParsedEvent {
    const status = this.pick(payload, STATUS_KEYS)?.toLowerCase().replace(/[\s-]+/g, '_') ?? null;

    let outcome: Outcome = 'ignored';
    if (status) {
      if (DELIVERED.has(status)) outcome = 'delivered';
      else if (BOUNCED.has(status)) outcome = channel === 'EMAIL' ? 'bounced' : 'failed';
      else if (COMPLAINT.has(status)) outcome = channel === 'EMAIL' ? 'complaint' : 'ignored';
      else if (FAILED.has(status)) outcome = 'failed';
    }

    return {
      payload,
      eventId,
      providerMessageId: this.pick(payload, ID_KEYS)?.slice(0, 200) ?? null,
      eventType: status?.slice(0, 50) ?? null,
      outcome,
      address: this.pick(payload, ADDRESS_KEYS),
      reason: this.pick(payload, REASON_KEYS)?.slice(0, 500) ?? null,
      providerCode: this.pick(payload, CODE_KEYS)?.slice(0, 50) ?? null,
    };
  }

  // The provider's own event id when it sends one, else a hash of the body, so exact replays still collide
  private eventIdOf(payload: Record<string, unknown>, raw: Buffer): string {
    return this.pick(payload, EVENT_ID_KEYS)?.slice(0, 200) ?? createHash('sha256').update(raw).digest('hex');
  }

  private timestampOf(headers: Headers, settings: ChannelSettings, payload: Record<string, unknown>): Date | null {
    const value = this.header(headers, settings.timestampHeader) ?? this.pick(payload, TIME_KEYS);
    if (!value) return null;

    if (/^\d+(\.\d+)?$/.test(value)) {
      const n = Number(value);
      return new Date(n < 1e12 ? n * 1000 : n); // seconds or milliseconds
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  // ── small helpers ─────────────────────────────────────────────────────────

  private settings(channel: Channel): ChannelSettings {
    const key = channel === 'SMS' ? 'sms' : 'email';
    const base = `webhooks.${key}`;
    return {
      provider: this.config.get<string>(`${base}.provider`) ?? (channel === 'SMS' ? 'sms-provider' : 'email-provider'),
      secret: this.config.get<string>(`${base}.secret`),
      signatureHeader: (this.config.get<string>(`${base}.signatureHeader`) ?? 'x-signature').toLowerCase(),
      timestampHeader: (this.config.get<string>(`${base}.timestampHeader`) ?? 'x-timestamp').toLowerCase(),
      toleranceSeconds: this.config.get<number>('webhooks.toleranceSeconds') ?? DEFAULT_TOLERANCE_SECONDS,
    };
  }

  private async storeRejected(
    settings: ChannelSettings,
    kind: ProviderEventKind,
    eventId: string,
    payload: Record<string, unknown>,
    error: string,
  ) {
    try {
      await this.prisma.providerEvent.create({
        data: {
          provider: settings.provider,
          kind,
          eventId,
          payload: this.redact(payload) as Prisma.InputJsonValue,
          signatureValid: true,
          result: 'REJECTED',
          error,
          processedAt: new Date(),
        },
      });
    } catch {
      // The same event id is already stored, that row is the record
    }
  }

  private finish(id: string, result: ProviderEventResult, error?: string) {
    return this.prisma.providerEvent.update({
      where: { id },
      data: { result, error: error ?? null, processedAt: new Date() },
    });
  }

  private header(headers: Headers, name: string): string | undefined {
    const value = headers[name];
    return Array.isArray(value) ? value[0] : value;
  }

  private pick(source: Record<string, unknown>, keys: string[]): string | null {
    for (const key of keys) {
      const v = source[key];
      if (typeof v === 'string' && v.trim()) return v.trim();
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return null;
  }

  // Keep the payload for debugging but hide the person it was about
  private redact(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (!value || typeof value !== 'object') return value;

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => {
        if (typeof v === 'string' && PII_KEYS.test(k)) return [k, this.mask(v)];
        return [k, this.redact(v)];
      }),
    );
  }

  private mask(value: string): string {
    if (value.includes('@')) {
      const [local, domain] = value.split('@');
      return `${local.slice(0, 1)}***@${domain}`;
    }
    return value.length > 4 ? `••••${value.slice(-4)}` : '••••';
  }

  private safeError(err: unknown): string {
    return (err instanceof Error ? err.message : String(err)).slice(0, 500);
  }
}
