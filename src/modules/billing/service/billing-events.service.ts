// src/modules/billing/service/billing-events.service.ts
//
// Adapter between billing and your event-driven audit/notification system.
// Same convention as SupportService.emitAudit(): the payload carries the action
// and the channel is derived from it (emit(payload.action, payload)).

import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ActorType } from '@prisma/client';
import { AuditEventPayload } from '../../misc/events/audit.events';

/** Internal (non-audit) event: Support/Reward modules react to a settled payment. */
export const BILLING_PAYMENT_PAID = 'billing.payment.paid';

export type BillingPaymentPaid = {
  paymentId: string;
  supportId: string | null;
  missingPersonId: string | null;
};

export type BillingAuditInput = {
  actorId: string | null; // null = system (webhook / cron)
  action: string; // must exist in AuditEventEnum and have a listener handler
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
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

  // notifyNeutralUpdate() removed: NotificationService already substitutes
  // DISCREET_TITLE/DISCREET_BODY at send time based on user.discreetModeEnabled
  // (see dispatchOne() in notification.service.ts). Billing calls the real
  // NotificationService with genuine content and Discreet Mode is handled for free.
  // TODO: swap this stub for the actual NotificationService injection once its
  // public create() signature is confirmed (only the private internals were seen).
  async notify(userId: string, type: string, title: string, body: string, entity?: string, entityId?: string): Promise<void> {
    this.emitter.emit('notification.create', { userId, type, title, body, entity, entityId });
  }
}
