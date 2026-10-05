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
  action: AuditEventEnum;
  entityType: string;
  entityId: string;
  entityLabel?: string | null;
  reason?: string | null;
  metadata?: Record<string, unknown>;
  outcome?: AuditOutcome;
  severity?: AuditSeverity;
};

@Injectable()
export class BillingEventsService {
  constructor(private readonly emitter: EventEmitter2) {}

  async log(input: BillingAuditInput): Promise<void> {
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

  notify<E extends object>(event: NotificationEventEnum, payload: E): void {
    this.emitter.emit(event, payload);
  }
}
