import { Prisma } from '@prisma/client';

// One definition of "an invited admin who has not registered yet", used by the pending list,
// the user search filter, the cleanup job and the reactivate guard. It is derived from real
// columns (there is no registrationStatus column): no password, an open invite, still inactive.
export const PENDING_REGISTRATION_WHERE: Prisma.UserWhereInput = {
  passwordHash: null,
  inviteTokenHash: { not: null },
  isActive: false,
};

export function isRegistrationPending(user: {
  passwordHash: string | null;
  inviteTokenHash: string | null;
  isActive: boolean;
}): boolean {
  return !user.passwordHash && !!user.inviteTokenHash && !user.isActive;
}