export enum AuditEventEnum {
  REPORT_MEDIA_DOWNLOADED = 'REPORT_MEDIA_DOWNLOADED',
  // USER
  USER_CREATED = 'USER_CREATED',
  USER_UPDATED = 'USER_UPDATED',
  USER_DEACTIVATED = 'USER_DEACTIVATED',
  USER_DEACTIVATED_BY_ADMIN = 'USER_DEACTIVATED_BY_ADMIN',
  USER_REACTIVATED = 'USER_REACTIVATED',
  USER_SESSIONS_REVOKED = 'USER_SESSIONS_REVOKED',
  USER_ROLE_ASSIGNED = 'USER_ROLE_ASSIGNED',
  USER_ROLE_REVOKED = 'USER_ROLE_REVOKED',
  // Added — used by UserService.unlockUser(). Distinct from
  // USER_REACTIVATED: unlocking clears a temporary login lockout
  // (lockedUntil/failedLoginAttempts), it does not touch isActive.
  // Conflating the two in the audit trail would misrepresent which
  // account state actually changed.
  USER_UNLOCKED = 'USER_UNLOCKED',
  // Added (item #21, automatic flags) — used by
  // PostService.maybeFlagUserForRejections() /
  // ReportService.maybeFlagUserForRejections() /
  // MissingPersonService.maybeFlagUserForRejections() (and, going
  // forward, the equivalent VictimProfile service) after a
  // rejection pushes a user's recent-rejection count past the
  // configured threshold. Flag only — this event never blocks or
  // auto-rejects anything; it just surfaces the account for admin
  // review.
  USER_AUTO_FLAGGED = 'USER_AUTO_FLAGGED',
  // AUTH
  LOGIN_SUCCESS = 'LOGIN_SUCCESS',
  LOGIN_FAILED = 'LOGIN_FAILED',
  LOGOUT = 'LOGOUT',
  PASSWORD_CHANGED = 'PASSWORD_CHANGED',
  PASSWORD_RESET = 'PASSWORD_RESET',
  OTP_VERIFIED = 'OTP_VERIFIED',
  // DISCREET MODE
  DISCREET_MODE_ENABLED = 'DISCREET_MODE_ENABLED',
  DISCREET_MODE_DISABLED = 'DISCREET_MODE_DISABLED',
  // Added — used by UserService.updateDiscreetMode() when the user
  // rotates their passcode while Discreet Mode is already enabled.
  // Distinct from DISCREET_MODE_ENABLED so the audit trail can tell
  // first-time setup apart from a later passcode change.
  DISCREET_MODE_PASSCODE_CHANGED = 'DISCREET_MODE_PASSCODE_CHANGED',
  // ADMIN ONBOARDING / REGISTRATION
  // Added — used by AuthService's admin registration-link flow
  // (adminRegister() / adminRegisterResend() / adminCancelRegistration())
  // and the self-service email-change flow (adminChangeEmailInitiate() /
  // adminChangeEmailVerify()). Previously all five fell back to reusing
  // USER_CREATED, USER_DEACTIVATED_BY_ADMIN, USER_UPDATED, or OTP_VERIFIED
  // as placeholders — these give each its own first-class event instead.
  ADMIN_REGISTERED = 'ADMIN_REGISTERED',
  ADMIN_REGISTRATION_RESENT = 'ADMIN_REGISTRATION_RESENT',
  ADMIN_REGISTRATION_CANCELLED = 'ADMIN_REGISTRATION_CANCELLED',
  ADMIN_EMAIL_CHANGE_INITIATED = 'ADMIN_EMAIL_CHANGE_INITIATED',
  ADMIN_EMAIL_CHANGE_VERIFIED = 'ADMIN_EMAIL_CHANGE_VERIFIED',
  // USER PROMOTION
  // Added — used by AuthService.promoteUserInitiate() /
  // promoteUserResend(). Previously both fell back to reusing
  // USER_CREATED as a placeholder.
  USER_PROMOTION_INITIATED = 'USER_PROMOTION_INITIATED',
  USER_PROMOTION_RESENT = 'USER_PROMOTION_RESENT',
  // REPORT
  REPORT_CREATED = 'REPORT_CREATED',
  REPORT_UPDATED = 'REPORT_UPDATED',
  REPORT_OPENED = 'REPORT_OPENED',
  REPORTER_INFORMATION_OPENED = 'REPORTER_INFORMATION_OPENED',
  REPORT_STATUS_CHANGED = 'REPORT_STATUS_CHANGED',
  REPORT_MORE_INFORMATION_REQUESTED = 'REPORT_MORE_INFORMATION_REQUESTED',
  REPORT_INFORMATION_RESPONDED = 'REPORT_INFORMATION_RESPONDED',
  REPORT_ASSIGNED = 'REPORT_ASSIGNED',
  REPORT_UNASSIGNED = 'REPORT_UNASSIGNED',
  REPORT_ESCALATED = 'REPORT_ESCALATED',
  REPORT_CLOSED = 'REPORT_CLOSED',
  REPORT_REJECTED = 'REPORT_REJECTED',
  REPORT_WITHDRAWN = 'REPORT_WITHDRAWN',
  // POST
  POST_CREATED = 'POST_CREATED',
  POST_UPDATED = 'POST_UPDATED',
  POST_APPROVED = 'POST_APPROVED',
  POST_REJECTED = 'POST_REJECTED',
  POST_PUBLISHED = 'POST_PUBLISHED',
  POST_UNPUBLISHED = 'POST_UNPUBLISHED',
  // Added — used by PostService.deleteMyPost. Previously
  // deleteMyPost had no matching audit action and fell back to
  // POST_UPDATED with a diff.deleted flag; this gives delete its
  // own first-class event like every other terminal Post action.
  POST_DELETED = 'POST_DELETED',
  // MISSING PERSON
  MISSING_PERSON_CREATED = 'MISSING_PERSON_CREATED',
  MISSING_PERSON_UPDATED = 'MISSING_PERSON_UPDATED',
  MISSING_PERSON_APPROVED = 'MISSING_PERSON_APPROVED',
  MISSING_PERSON_REJECTED = 'MISSING_PERSON_REJECTED',
  MISSING_PERSON_FOUND = 'MISSING_PERSON_FOUND',
  MISSING_PERSON_MORE_INFO_REQUESTED = 'MISSING_PERSON_MORE_INFO_REQUESTED',
  MISSING_PERSON_REDACTED = 'MISSING_PERSON_REDACTED',
  MISSING_PERSON_REWARD_REVIEWED = 'MISSING_PERSON_REWARD_REVIEWED',
  // Added — used by MissingPersonService.remove. Previously delete
  // was intentionally left un-audited because this event didn't
  // exist; deletion now gets its own first-class audit event like
  // create/update/approve/reject/found.
  MISSING_PERSON_DELETED = 'MISSING_PERSON_DELETED',
  // Added — used by MissingPersonService.getMediaDownloadUrl()
  // (the admin media-download route), mirroring
  // REPORT_MEDIA_DOWNLOADED above. Was referenced by the hardening
  // pass on MissingPersonService but never declared here, which is
  // what TS2339 was flagging.
  MISSING_PERSON_MEDIA_DOWNLOADED = 'MISSING_PERSON_MEDIA_DOWNLOADED',
  // INFORMATION SUBMISSION
  INFORMATION_SUBMITTED = 'INFORMATION_SUBMITTED',
  // Added — used by InformationSubmissionService.updateStatus()
  // for the PENDING → UNDER_REVIEW transition, which previously
  // emitted no audit event at all.
  INFORMATION_UNDER_REVIEW = 'INFORMATION_UNDER_REVIEW',
  INFORMATION_REVIEWED = 'INFORMATION_REVIEWED',
  INFORMATION_REJECTED = 'INFORMATION_REJECTED',
  // Added — used by InformationSubmissionService.remove(). Only
  // PENDING submissions are deletable by their owner.
  INFORMATION_SUBMISSION_DELETED = 'INFORMATION_SUBMISSION_DELETED',
  // VICTIM PROFILE
  VICTIM_PROFILE_CREATED = 'VICTIM_PROFILE_CREATED',
  VICTIM_PROFILE_UPDATED = 'VICTIM_PROFILE_UPDATED',
  VICTIM_PROFILE_VERIFIED = 'VICTIM_PROFILE_VERIFIED',
  VICTIM_PROFILE_CONSENT_RECORDED = 'VICTIM_PROFILE_CONSENT_RECORDED',
  VICTIM_PROFILE_PRIVACY_REVIEWED = 'VICTIM_PROFILE_PRIVACY_REVIEWED',
  VICTIM_PROFILE_APPROVED = 'VICTIM_PROFILE_APPROVED',
  VICTIM_PROFILE_PUBLISHED = 'VICTIM_PROFILE_PUBLISHED',
  VICTIM_PROFILE_REJECTED = 'VICTIM_PROFILE_REJECTED',
  // SUPPORT
  SUPPORT_CREATED = 'SUPPORT_CREATED',
  SUPPORT_CONFIRMED = 'SUPPORT_CONFIRMED',
  SUPPORT_COMPLETED = 'SUPPORT_COMPLETED',
  SUPPORT_CANCELLED = 'SUPPORT_CANCELLED',
  SUPPORT_FAILED = 'SUPPORT_FAILED',
  // ROLE
  ROLE_CREATED = 'ROLE_CREATED',
  ROLE_UPDATED = 'ROLE_UPDATED',
  ROLE_DELETED = 'ROLE_DELETED',
  // PERMISSION
  // Added — used by PermissionService.assignToRole() /
  // revokeFromRole(). No permission-assignment audit event existed
  // before PermissionController was built; these mirror the
  // ROLE_* / USER_ROLE_* pairs above (grant/revoke) for a role's
  // assigned permissions.
  PERMISSION_ASSIGNED = 'PERMISSION_ASSIGNED',
  PERMISSION_REVOKED = 'PERMISSION_REVOKED',
  // SECURITY
  SECURITY_ALERT = 'SECURITY_ALERT',
}