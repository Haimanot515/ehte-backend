import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';

import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';

import { AuditEventPayload } from '../events/audit.events';

import { AuditLogService } from '../service/audit-log.service';

@Injectable()
export class AuditLogListener {
  private readonly logger = new Logger(AuditLogListener.name);

  constructor(private readonly auditLogService: AuditLogService) {}

  @OnEvent(Object.values(AuditEventEnum))
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