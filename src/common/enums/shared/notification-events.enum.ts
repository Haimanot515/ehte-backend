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
  // Added — used by MissingPersonService.updateStatus() so each
  // outcome gets its own event/copy instead of all four statuses
  // (approved, rejected, more-info, found) sharing the generic
  // MISSING_PERSON_UPDATED message. MISSING_PERSON_UPDATED itself
  // is kept for the plain edit-confirmation path (update()).
  MISSING_PERSON_APPROVED = 'MISSING_PERSON_APPROVED',
  MISSING_PERSON_REJECTED = 'MISSING_PERSON_REJECTED',
  MISSING_PERSON_MORE_INFORMATION_REQUESTED = 'MISSING_PERSON_MORE_INFORMATION_REQUESTED',
  MISSING_PERSON_FOUND = 'MISSING_PERSON_FOUND',

  NEW_MISSING_PERSON_INFORMATION = 'NEW_MISSING_PERSON_INFORMATION',
  // Added — used by InformationSubmissionService.review() to tell
  // the submitter their tip was accepted or rejected (reviewNote
  // included in the payload for REJECTED). Previously review()
  // emitted no notification at all.
  INFORMATION_SUBMISSION_REVIEWED = 'INFORMATION_SUBMISSION_REVIEWED',
  INFORMATION_SUBMISSION_REJECTED = 'INFORMATION_SUBMISSION_REJECTED',

  SUPPORT_PAYMENT_CONFIRMED = 'SUPPORT_PAYMENT_CONFIRMED',

  NEW_REPORT = 'NEW_REPORT',
  HIGH_PRIORITY_REPORT = 'HIGH_PRIORITY_REPORT',
  NEW_POST = 'NEW_POST',
  NEW_MISSING_PERSON_REQUEST = 'NEW_MISSING_PERSON_REQUEST',

  SECURITY_ALERT = 'SECURITY_ALERT',

  // VICTIM PROFILE
  // NEW — added to fix VictimProfileService's raw-string event-name bug:
  // that service was calling eventEmitter.emit('notification.victim_profile.created', ...)
  // etc. with literal strings that didn't exist in this enum at all, so
  // there was never any way for a listener to bind to them. These 11
  // cover every VictimProfile action that already had a paired
  // 'notification.victim_profile.X' emit call in the original code
  // (create, update, delete, approval-gates update, both stages of
  // child-safety review, consent revocation, bank-detail update,
  // publish, unpublish, reject, resubmit). claim/unclaim/media-download/
  // child-safety-first-confirm are audit-only in the original code (no
  // paired notification emit existed for them) and are deliberately
  // NOT given notification events here — only VICTIM_PROFILE_* entries
  // in AuditEventEnum cover those four.
  //
  // Recipient: NotificationListener notifies VictimProfile.createdByUserId
  // (the admin who created the profile) and skips sending a notification
  // when createdByUserId is null, since VictimProfile has no submitter/
  // owner relation the way Report/Post/MissingPerson do. Revisit this
  // recipient choice if the intended audience is different (e.g. broadcast
  // to all admins for review-needed actions, mirroring createForAdmins()).
  VICTIM_PROFILE_CREATED = 'VICTIM_PROFILE_CREATED',
  VICTIM_PROFILE_UPDATED = 'VICTIM_PROFILE_UPDATED',
  VICTIM_PROFILE_DELETED = 'VICTIM_PROFILE_DELETED',
  VICTIM_PROFILE_GATES_UPDATED = 'VICTIM_PROFILE_GATES_UPDATED',
  VICTIM_PROFILE_CHILD_SAFETY_REVIEWED = 'VICTIM_PROFILE_CHILD_SAFETY_REVIEWED',
  VICTIM_PROFILE_CONSENT_REVOKED = 'VICTIM_PROFILE_CONSENT_REVOKED',
  VICTIM_PROFILE_BANK_DETAILS_UPDATED = 'VICTIM_PROFILE_BANK_DETAILS_UPDATED',
  VICTIM_PROFILE_PUBLISHED = 'VICTIM_PROFILE_PUBLISHED',
  VICTIM_PROFILE_UNPUBLISHED = 'VICTIM_PROFILE_UNPUBLISHED',
  VICTIM_PROFILE_REJECTED = 'VICTIM_PROFILE_REJECTED',
  VICTIM_PROFILE_RESUBMITTED = 'VICTIM_PROFILE_RESUBMITTED',

  // AUTH — distinct string values (deliberately NOT matching
  // AuditEventEnum's PASSWORD_CHANGED / PASSWORD_RESET), so
  // AuthService emits these explicitly and separately from the
  // audit event, with no dependency on event-name collision.
  PASSWORD_CHANGED = 'notification.password_changed',
  PASSWORD_RESET = 'notification.password_reset',
}