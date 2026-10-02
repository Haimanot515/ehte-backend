import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';

import { AuditEventPayload } from '../events/audit.events';

import { AuditLogService } from '../service/audit-log.service';

/**
 * FIX: the previous version used @OnEvent(Object.values(AuditEventEnum)).
 * EventEmitter2 treats an array as ONE event name (a path), so no real
 * event such as 'LOGIN_FAILED' ever matched it and every audit event sent
 * through the event bus was silently dropped.
 *
 * Now each audit action is subscribed individually, so an emit of
 * 'LOGIN_SUCCESS' or 'LOGIN_FAILED' reaches the handler.
 */
@Injectable()
export class AuditLogListener implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AuditLogListener.name);

  private readonly events: string[] = Object.values(AuditEventEnum);
  private readonly handler = (payload: AuditEventPayload): Promise<void> =>
    this.handleAuditEvent(payload);

  constructor(
    private readonly auditLogService: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  onModuleInit(): void {
    for (const event of this.events) {
      this.eventEmitter.on(event, this.handler);
    }
    this.logger.log(`Audit listener subscribed to ${this.events.length} events`);
  }

  onModuleDestroy(): void {
    for (const event of this.events) {
      this.eventEmitter.off(event, this.handler);
    }
  }

  async handleAuditEvent(payload: AuditEventPayload): Promise<void> {
    // Guards against a non-audit payload arriving on a shared event name
    if (!payload?.actorType || !payload?.entity || !payload?.action) {
      this.logger.warn('Ignored event with a non-audit payload shape');
      return;
    }

    try {
      await this.auditLogService.record(payload);
    } catch (error) {
      // Never log the payload itself: log only identifiers
      this.logger.error(
        `Audit write failed: action=${payload.action} entity=${payload.entity} entityId=${payload.entityId ?? '-'}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}