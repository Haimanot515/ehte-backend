import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';

import { AuditEventPayload } from '../events/audit.events';

import { AuditLogService } from '../service/audit-log.service';

@Injectable()
export class AuditLogListener implements OnModuleInit {
  private readonly logger = new Logger(AuditLogListener.name);

  constructor(
    private readonly auditLogService: AuditLogService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  // OnEvent with an array registers one joined key, so each action is subscribed on its own here
  onModuleInit(): void {
    for (const action of Object.values(AuditEventEnum)) {
      this.eventEmitter.on(action, (payload: AuditEventPayload) => this.handleAuditEvent(payload));
    }
  }

  async handleAuditEvent(payload: AuditEventPayload): Promise<void> {
    // Some event names are shared with the notification module, which sends a different payload
    if (!payload?.actorType || !payload?.entity || !payload?.action) {
      this.logger.debug('Ignored event with a non-audit payload shape');
      return;
    }

    try {
      await this.auditLogService.record(payload);
    } catch (error) {
      this.logger.error(
        `Audit write failed: action=${payload.action} entity=${payload.entity} entityId=${payload.entityId ?? '-'}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}