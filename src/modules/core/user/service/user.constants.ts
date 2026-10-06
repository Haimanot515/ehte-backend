import { DeletionRequestStatus } from '../dto/user.dto';

export const DELETION_GRACE_DAYS = 30;
export const EXPORT_ROW_CAP = 5000;
export const EXPORT_JOB_ROW_CAP = 50000;
export const EXPORT_JOB_TTL_MS = 24 * 60 * 60 * 1000;
export const OTP_RESEND_COOLDOWN_MS = 60_000;
export const LINKED_PROVIDERS = ['google', 'facebook', 'apple'];
export const OPEN_DELETION_STATUSES = [DeletionRequestStatus.PENDING, DeletionRequestStatus.DELAYED];
export const VIEW_ENTITY = 'UserRecordView';

// key -> [prisma model, column pointing at the user]. Edit to match the schema.
export const USER_CONTENT_SOURCES: Record<string, [string, string]> = {
  reports: ['report', 'reporterId'],
  informationSubmissions: ['informationSubmission', 'ownerId'],
  posts: ['post', 'ownerId'],
  missingPersons: ['missingPerson', 'ownerId'],
  victimProfiles: ['victimProfile', 'createdById'],
  supports: ['support', 'supporterId'],
  payments: ['payment', 'userId'],
};

// Profile fields now live on the related UserProfile table (one row per
// user, created lazily on first updateMe() call touching those fields).
export const PROFILE_FIELDS_SELECT = {
  region: true,
  zone: true,
  city: true,
  subCity: true,
  woreda: true,
  kebele: true,
  preferredLanguage: true,
  dateOfBirth: true,
  gender: true,
  alternatePhone: true,
  occupation: true,
  profilePictureUrl: true,
} as const;

// Returned when a user has no UserProfile row yet (pre-migration users,
// or anyone who's never touched a profile field).
export const EMPTY_PROFILE_FIELDS = {
  region: null,
  zone: null,
  city: null,
  subCity: null,
  woreda: null,
  kebele: null,
  preferredLanguage: null,
  dateOfBirth: null,
  gender: null,
  alternatePhone: null,
  occupation: null,
  profilePictureUrl: null,
} as const;

// Shared select for getMe/getUserById. Excluded from listUsers()'s
// select on purpose — see that method.
export const FULL_PROFILE_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  isActive: true,
  discreetModeEnabled: true,
  discreetModeUpdatedAt: true,
  createdAt: true,
  updatedAt: true,
  profile: { select: PROFILE_FIELDS_SELECT },
  userRoles: {
    select: { role: { select: { id: true, name: true } } },
  },
} as const;

export const LIST_USER_SELECT = {
  id: true,
  name: true,
  phone: true,
  email: true,
  isActive: true,
  lockedUntil: true,
  createdAt: true,
  userRoles: { select: { role: { select: { id: true, name: true } } } },
} as const;
