/**
 * Event names emitted on the EventEmitter for NOTIFICATIONS.
 *
 * Every value is prefixed with `notification.` so it can never collide with
 * an AuditEventEnum value (audit values such as REPORT_ASSIGNED are stored in
 * audit_log.action and must NOT be changed). Event names are not persisted,
 * so changing these values is safe. Emit sites that use the enum
 * (NotificationEventEnum.X) need no edits.
 *
 * Verify no raw-string emits remain:
 *   grep -rnE "emit\(\s*['\"]" src
 */
export enum NotificationEventEnum {
  REPORT_RECEIVED = 'notification.report_received',
  REPORT_UPDATED = 'notification.report_updated',
  MORE_INFORMATION_REQUESTED = 'notification.more_information_requested',
  INFORMATION_REQUEST_RESPONDED = 'notification.information_request_responded',
  REPORT_ASSIGNED = 'notification.report_assigned',

  POST_APPROVED = 'notification.post_approved',
  POST_REJECTED = 'notification.post_rejected',
  POST_CHANGES_REQUESTED = 'notification.post_changes_requested',
  POST_UNPUBLISHED = 'notification.post_unpublished',

  MISSING_PERSON_UPDATED = 'notification.missing_person_updated',
  MISSING_PERSON_APPROVED = 'notification.missing_person_approved',
  MISSING_PERSON_REJECTED = 'notification.missing_person_rejected',
  MISSING_PERSON_MORE_INFORMATION_REQUESTED = 'notification.missing_person_more_information_requested',
  MISSING_PERSON_FOUND = 'notification.missing_person_found',

  NEW_MISSING_PERSON_INFORMATION = 'notification.new_missing_person_information',
  INFORMATION_SUBMISSION_REVIEWED = 'notification.information_submission_reviewed',
  INFORMATION_SUBMISSION_REJECTED = 'notification.information_submission_rejected',

  // Emitted by SupportService.create() (status PENDING).
  // SUPPORT_PAYMENT_CONFIRMED is reserved for the CONFIRMED transition only.
  SUPPORT_PLEDGE_CREATED = 'notification.support_pledge_created',
  SUPPORT_PAYMENT_CONFIRMED = 'notification.support_payment_confirmed',

  NEW_REPORT = 'notification.new_report',
  HIGH_PRIORITY_REPORT = 'notification.high_priority_report',
  NEW_POST = 'notification.new_post',
  NEW_MISSING_PERSON_REQUEST = 'notification.new_missing_person_request',

  SECURITY_ALERT = 'notification.security_alert',

  // VICTIM PROFILE
  VICTIM_PROFILE_CREATED = 'notification.victim_profile_created',
  VICTIM_PROFILE_UPDATED = 'notification.victim_profile_updated',
  VICTIM_PROFILE_DELETED = 'notification.victim_profile_deleted',
  VICTIM_PROFILE_GATES_UPDATED = 'notification.victim_profile_gates_updated',
  VICTIM_PROFILE_CHILD_SAFETY_REVIEWED = 'notification.victim_profile_child_safety_reviewed',
  VICTIM_PROFILE_CONSENT_REVOKED = 'notification.victim_profile_consent_revoked',
  VICTIM_PROFILE_BANK_DETAILS_UPDATED = 'notification.victim_profile_bank_details_updated',
  VICTIM_PROFILE_PUBLISHED = 'notification.victim_profile_published',
  VICTIM_PROFILE_UNPUBLISHED = 'notification.victim_profile_unpublished',
  VICTIM_PROFILE_REJECTED = 'notification.victim_profile_rejected',
  VICTIM_PROFILE_RESUBMITTED = 'notification.victim_profile_resubmitted',

  // AUTH (already namespaced before)
  PASSWORD_CHANGED = 'notification.password_changed',
  PASSWORD_RESET = 'notification.password_reset',
}