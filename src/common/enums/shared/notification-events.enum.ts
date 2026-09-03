export enum NotificationEventEnum {
  REPORT_RECEIVED = 'REPORT_RECEIVED',
  REPORT_UPDATED = 'REPORT_UPDATED',
  MORE_INFORMATION_REQUESTED = 'MORE_INFORMATION_REQUESTED',
  INFORMATION_REQUEST_RESPONDED = 'INFORMATION_REQUEST_RESPONDED',
  REPORT_ASSIGNED = 'REPORT_ASSIGNED',

  POST_APPROVED = 'POST_APPROVED',
  POST_REJECTED = 'POST_REJECTED',
  POST_CHANGES_REQUESTED = 'POST_CHANGES_REQUESTED',
  // Added — used by PostService.unpublish() to notify the post
  // owner when their published post is taken down. Previously
  // there was no notification at all on this path, unlike
  // approve/reject/request-changes.
  POST_UNPUBLISHED = 'POST_UNPUBLISHED',

  MISSING_PERSON_UPDATED = 'MISSING_PERSON_UPDATED',

  NEW_MISSING_PERSON_INFORMATION = 'NEW_MISSING_PERSON_INFORMATION',

  SUPPORT_PAYMENT_CONFIRMED = 'SUPPORT_PAYMENT_CONFIRMED',

  NEW_REPORT = 'NEW_REPORT',
  HIGH_PRIORITY_REPORT = 'HIGH_PRIORITY_REPORT',
  NEW_POST = 'NEW_POST',
  NEW_MISSING_PERSON_REQUEST = 'NEW_MISSING_PERSON_REQUEST',

  SECURITY_ALERT = 'SECURITY_ALERT',

  // AUTH — distinct string values (deliberately NOT matching
  // AuditEventEnum's PASSWORD_CHANGED / PASSWORD_RESET), so
  // AuthService emits these explicitly and separately from the
  // audit event, with no dependency on event-name collision.
  PASSWORD_CHANGED = 'notification.password_changed',
  PASSWORD_RESET = 'notification.password_reset',
} 