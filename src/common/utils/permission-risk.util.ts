import { PermissionsEnum as P } from 'src/common/enums/permissions.enum';

// ── Tier 1: flagged "sensitive" in GET /permissions/sensitive (AR-53) ──
// A role holding any of these deserves a second look in an access review.
const SENSITIVE: ReadonlySet<string> = new Set<string>([
  // Identity and evidence
  P.REPORT_REVEAL_REPORTER,
  P.REPORTER_INFO_READ,
  P.REPORT_EVIDENCE_MANAGE,
  P.REPORT_SENSITIVITY_MANAGE,
  P.REPORT_AUDIT_READ,
  P.REPORT_LOCATION_READ,
  P.REPORT_EXPORT,
  P.REPORT_DELETE,
  P.MISSING_PERSON_DELETE,
  P.MISSING_PERSON_REDACT,
  P.POST_DELETE,
  P.POST_TAKEDOWN,
  P.POST_APPEAL_DECIDE,

  // Victim profiles, consent, bank details
  P.PROFILE_DELETE,
  P.PROFILE_CHILD_SAFETY_REVIEW,
  P.PROFILE_BANK_DETAILS_MANAGE,
  P.PROFILE_CONSENT_MANAGE,

  // Money
  P.SUPPORT_PAYMENT_MANAGE,
  P.DISBURSEMENTS_CREATE,
  P.DISBURSEMENTS_APPROVE,
  P.DISBURSEMENTS_EXECUTE,

  // Accounts, roles and permissions
  P.USER_SUSPEND,
  P.USER_DELETE,
  P.USER_FORCE_LOGOUT,
  P.USER_UNLOCK,
  P.USER_ROLE_ASSIGN,
  P.USER_PROMOTE,
  P.ROLE_CREATE,
  P.ROLE_UPDATE,
  P.ROLE_DELETE,
  P.PERMISSION_ASSIGN,
  P.PERMISSION_REVOKE,
  P.PERMISSION_MANAGE,
  P.USER_2FA_RESET,

  // Audit, notifications, settings
  P.AUDIT_LOG_READ_SENSITIVE,
  P.AUDIT_LOG_EXPORT,
  P.AUDIT_LOG_PURGE,
  P.AUDIT_LOG_ANONYMIZE,
  P.AUDIT_ALERT_MANAGE,
  P.NOTIFICATION_BROADCAST_SEND,
  P.NOTIFICATION_USER_DATA_EXPORT,
  P.NOTIFICATION_USER_DATA_ERASE,
  P.SECURITY_SETTINGS_UPDATE,
]);

const TWO_PERSON_APPROVAL: ReadonlySet<string> = new Set<string>([
  P.REPORT_REVEAL_REPORTER,
  P.PROFILE_BANK_DETAILS_MANAGE,
  P.SUPPORT_PAYMENT_MANAGE,
  P.DISBURSEMENTS_CREATE,
  P.DISBURSEMENTS_APPROVE,
  P.DISBURSEMENTS_EXECUTE,
  P.USER_DELETE,
  P.USER_ROLE_ASSIGN,
  P.USER_PROMOTE,
  P.USER_2FA_RESET,
  P.ROLE_CREATE,
  P.ROLE_UPDATE,
  P.ROLE_DELETE,
  P.PERMISSION_ASSIGN,
  P.PERMISSION_REVOKE,
  P.PERMISSION_MANAGE,
  P.SECURITY_SETTINGS_UPDATE,
  P.AUDIT_LOG_PURGE,
  P.AUDIT_LOG_ANONYMIZE,
  P.NOTIFICATION_USER_DATA_ERASE,
]);

export function isSensitivePermission(name: string): boolean {
  return SENSITIVE.has(name);
}

export function requiresTwoPersonApproval(name: string): boolean {
  return TWO_PERSON_APPROVAL.has(name);
}

// ── Separation of duties (AR-54) ──
// One person should not hold both halves of any rule below. Each rule names the risk it prevents.
type DutyRule = { id: string; permissions: [string, string]; why: string };

const DUTY_RULES: DutyRule[] = [
  {
    id: 'disbursement-create-approve',
    permissions: [P.DISBURSEMENTS_CREATE, P.DISBURSEMENTS_APPROVE],
    why: 'The person who creates a disbursement could also approve it.',
  },
  {
    id: 'disbursement-approve-execute',
    permissions: [P.DISBURSEMENTS_APPROVE, P.DISBURSEMENTS_EXECUTE],
    why: 'The person who approves a disbursement could also pay it out.',
  },
  {
    id: 'disbursement-create-execute',
    permissions: [P.DISBURSEMENTS_CREATE, P.DISBURSEMENTS_EXECUTE],
    why: 'The person who creates a disbursement could also pay it out.',
  },
  {
    id: 'profile-create-approve',
    permissions: [P.PROFILE_CREATE, P.PROFILE_APPROVE],
    why: 'The person who creates a victim profile could also approve it.',
  },
  {
    id: 'official-post-create-approve',
    permissions: [P.POST_CREATE_OFFICIAL, P.POST_APPROVE],
    why: 'The person who writes an official post could also approve it.',
  },
  {
    id: 'role-edit-assign',
    permissions: [P.PERMISSION_ASSIGN, P.USER_ROLE_ASSIGN],
    why: 'Someone could give a role more permissions and then give that role to themselves.',
  },
  {
    id: 'role-update-assign',
    permissions: [P.ROLE_UPDATE, P.USER_ROLE_ASSIGN],
    why: 'Someone could change a role and then give that role to themselves.',
  },
  {
    id: 'audit-purge-read',
    permissions: [P.AUDIT_LOG_PURGE, P.AUDIT_LOG_READ_SENSITIVE],
    why: 'The person who can read sensitive logs could also erase them.',
  },
];

export type DutyConflict = { rule: string; permissions: [string, string]; why: string };

export function findDutyConflicts(permissionNames: Iterable<string>): DutyConflict[] {
  const held = new Set(permissionNames);

  return DUTY_RULES.filter(
    ({ permissions }) => held.has(permissions[0]) && held.has(permissions[1]),
  ).map(({ id, permissions, why }) => ({ rule: id, permissions, why }));
}
