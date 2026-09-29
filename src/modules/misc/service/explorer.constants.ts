import { PermissionsEnum as P } from 'src/common/enums/permissions.enum';

export interface EntityPolicy {
  permission: P;
  audit: boolean;
}

// Entities not listed here (session, userOtp, deviceToken, idempotency keys) cannot be opened or reached through a relation
export const ENTITY_POLICY: Record<string, EntityPolicy> = {
  user: { permission: P.USER_READ, audit: true },
  userProfile: { permission: P.USER_READ, audit: true },
  userRole: { permission: P.USER_READ, audit: false },
  role: { permission: P.ROLE_READ, audit: false },
  rolePermission: { permission: P.ROLE_READ, audit: false },
  permission: { permission: P.PERMISSION_READ, audit: false },

  report: { permission: P.REPORT_READ, audit: true },
  reportInformationRequest: { permission: P.REPORT_READ, audit: true },
  post: { permission: P.POST_READ, audit: false },

  missingPerson: { permission: P.MISSING_PERSON_READ, audit: true },
  informationSubmission: { permission: P.MISSING_PERSON_INFO_READ, audit: true },
  rewardClaim: { permission: P.REWARDS_VERIFY_CLAIM, audit: true },

  victimProfile: { permission: P.PROFILE_READ, audit: true },
  support: { permission: P.SUPPORT_READ, audit: true },

  payment: { permission: P.SUPPORT_PAYMENT_READ, audit: true },
  paymentAllocation: { permission: P.SUPPORT_PAYMENT_READ, audit: true },
  disbursement: { permission: P.DISBURSEMENTS_CREATE, audit: true },
  payoutDestination: { permission: P.DISBURSEMENTS_CREATE, audit: true },
  agreement: { permission: P.AGREEMENTS_MANAGE, audit: false },
  allocationRule: { permission: P.AGREEMENTS_MANAGE, audit: false },
  institution: { permission: P.INSTITUTIONS_MANAGE, audit: false },

  notification: { permission: P.NOTIFICATION_READ, audit: false },
  notificationDelivery: { permission: P.NOTIFICATION_READ, audit: false },
  notificationBroadcast: { permission: P.NOTIFICATION_READ, audit: false },
  notificationTemplate: { permission: P.NOTIFICATION_READ, audit: false },

  auditLog: { permission: P.AUDIT_LOG_READ, audit: false },
  auditAlert: { permission: P.AUDIT_LOG_READ, audit: false },
};

export const ALWAYS_HIDDEN_FIELDS = new Set([
  'passwordHash',
  'inviteTokenHash',
  'discreetModePasscodeHash',
  'googleId',
  'facebookId',
  'appleId',
  'destinationSnapshot',
]);

export const MEDIA_FIELDS = new Set(['photo', 'video', 'audio', 'pdf', 'document', 'other', 'responseFiles']);

export const MASKED_FIELDS = new Set(['accountNumber', 'bankAccountNumber', 'telebirrPhone']);

export const CHILD_REDACTED_FIELDS = new Set(['name', 'story', 'description']);

export const GATED_FIELDS: Record<string, Record<string, P>> = {
  report: { userId: P.REPORTER_INFO_READ },
};

export const GATED_RELATIONS: Record<string, Record<string, P>> = {
  report: { user: P.REPORTER_INFO_READ },
  user: { reports: P.REPORTER_INFO_READ },
};

export const MAX_PAGE_SIZE = 100;