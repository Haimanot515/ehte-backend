import { ActorType, AuditOutcome, AuditSeverity, AuditSource } from '@prisma/client';

export interface AuditEventPayload {
  userId?: string | null;

  actorType: ActorType;
  actorName?: string | null;
  actorRole?: string | null;
  sessionId?: string | null;
  targetUserId?: string | null;

  action: string;
  outcome?: AuditOutcome;
  severity?: AuditSeverity;
  reason?: string | null;

  entity: string;
  entityId?: string | null;
  entityLabel?: string | null;

  /** New code should send { before, after }. Old flat objects still work. */
  diff?: Record<string, unknown> | null;
  metadata?: Record<string, unknown> | null;

  // Normally filled from RequestContext, not by business code
  ipAddress?: string | null;
  userAgent?: string | null;
  country?: string | null;
  city?: string | null;
  source?: AuditSource | null;
  method?: string | null;
  path?: string | null;
  requestId?: string | null;
}