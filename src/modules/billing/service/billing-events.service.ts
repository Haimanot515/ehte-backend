// src/modules/billing/service/billing-events.service.ts
//
// Adapter between billing and your event-driven audit/notification system.
// Same convention as SupportService.emitAudit(): the payload carries the action
// and the channel is derived from it (emit(payload.action, payload)).

import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActorType, AuditOutcome, AuditSeverity } from '@prisma/client';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';
import { AuditEventPayload } from '../../misc/events/audit.events';
import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

/** Internal (non-audit) event: Support/Reward modules react to a settled payment. */
export const BILLING_PAYMENT_PAID = 'billing.payment.paid';

export type BillingPaymentPaid = {
  paymentId: string;
  supportId: string | null;
  missingPersonId: string | null;
};

export type BillingAuditInput = {
  actorId: string | null; // null = system (webhook / cron)
  // FIX: was `action: string`. AuditLogListener only fires for event names
  // that exist as AuditEventEnum values (@OnEvent(Object.values(AuditEventEnum))),
  // so a plain string let every billing call site emit action names
  // (AGREEMENT_CREATED, DISBURSEMENT_EXECUTED, REWARD_FUNDED, etc.) that had
  // no matching enum member — the listener never subscribed to them, and the
  // events were silently dropped with no compiler error and no runtime
  // warning. Typing this as AuditEventEnum makes a missing/misspelled action
  // a compile-time error instead of a silent audit gap.
  action: AuditEventEnum;
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  // FIX: this type had no outcome/severity fields at all, so no billing
  // call site could mark a row as a failure or denial — every billing
  // audit row landed indistinguishable from a success, unlike
  // ReportService.emitAudit()'s calls, which pass
  // outcome: AuditOutcome.FAILURE/DENIED and severity: AuditSeverity.WARNING
  // for exactly this class of event. Both optional so existing success-path
  // call sites (which omit them and rely on the DB default) don't need to change.
  outcome?: AuditOutcome;
  severity?: AuditSeverity;
};

@Injectable()
export class BillingEventsService {
  constructor(private readonly emitter: EventEmitter2) {}

  async log(input: BillingAuditInput): Promise<void> {
    // System actions (webhook/cron) have no user. Adjust if your AuditEventPayload
    // requires a SYSTEM actor type or a non-null userId.
    // Webhook and cron callers pass actorId: null -> ActorType.SYSTEM, matching
    // NotificationService.audit()'s pattern (this.audit(null, ...) there too).
    const payload = {
      userId: input.actorId,
      actorType: input.actorId ? ActorType.ADMIN : ActorType.SYSTEM,
      action: input.action,
      outcome: input.outcome,
      severity: input.severity,
      entity: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel ?? null,
      reason: input.reason ?? null,
      metadata: input.metadata,
    } as unknown as AuditEventPayload;
    this.emitter.emit(input.action, payload);
  }

  async paymentPaid(payload: BillingPaymentPaid): Promise<void> {
    this.emitter.emit(BILLING_PAYMENT_PAID, payload);
  }

  // Same shape as AuthService/PostService's direct eventEmitter.emit(...)
  // calls to NotificationEventEnum members — routed through this wrapper
  // only so every billing call site stays off EventEmitter2 directly,
  // matching how they already do it for audit via log() above.
  // NotificationListener has one @OnEvent handler per NotificationEventEnum
  // member (see misc module), so `event` must be a real enum member with a
  // matching interface in notification.events.ts — passing a plain string
  // here silently drops the notification, same failure mode BillingAuditInput
  // was typed to prevent for audit events.
  notify<E extends object>(event: NotificationEventEnum, payload: E): void {
    this.emitter.emit(event, payload);
  }
}