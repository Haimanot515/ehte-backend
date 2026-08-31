
import { ActorType } from '@prisma/client';

export interface AuditEventPayload {
  userId?: string | null;

  actorType: ActorType;

  action: string;

  entity: string;

  entityId?: string | null;

  diff?: Record<string, unknown> | null;
}
