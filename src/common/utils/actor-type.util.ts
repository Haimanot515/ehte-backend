import { ActorType } from '@prisma/client';

/**
 * Maps a user's role names to the audit ActorType.
 *
 * Precedence: SUPER_ADMIN > ADMIN > USER (default).
 * An empty/unknown roles array (e.g. anonymous login attempt)
 * safely defaults to ActorType.USER.
 */
export function resolveActorType(roles: string[]): ActorType {
  if (roles.includes('SUPER_ADMIN')) {
    return ActorType.SUPER_ADMIN;
  }

  if (roles.includes('ADMIN')) {
    return ActorType.ADMIN;
  }

  return ActorType.USER;
}