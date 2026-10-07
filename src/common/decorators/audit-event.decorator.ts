import { SetMetadata } from '@nestjs/common';
import { AuditSeverity } from '@prisma/client';
import { AuditEventEnum } from 'src/common/enums/shared/audit-events.enum';

export const AUDIT_EVENT_KEY = 'audit_event_options';

export interface AuditEventOptions {
  action: AuditEventEnum;
  entity: string;
  /** Where the entity id comes from. `response` lists candidate keys on the returned object. */
  entityId?: { param?: string; query?: string; body?: string; response?: string[] };
  /** Route param holding the user the action is about (sets targetUserId). */
  targetUserParam?: string;
  /** Copy these request parts (primitive values only, secrets skipped) into metadata. */
  capture?: Array<'params' | 'query'>;
  metadata?: Record<string, unknown>;
  severity?: AuditSeverity;
  /** Set false to record only failures (for example rejected webhooks). Default true. */
  onSuccess?: boolean;
  /** Action to record when the handler throws; return null to skip. */
  onError?: AuditEventEnum | ((err: unknown) => AuditEventEnum | null);
}

/**
 * Records an audit event when the handler finishes. Use for controller endpoints that have no
 * audit emit of their own. The actor, IP, session and request id come from the request context.
 */
export const AuditEvent = (options: AuditEventOptions) => SetMetadata(AUDIT_EVENT_KEY, options);
