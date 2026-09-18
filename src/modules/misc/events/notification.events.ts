export interface ReportReceivedEvent {
  userId: string;
  reportId: string;
  caseReference: string;
}

export interface ReportUpdatedEvent {
  userId: string;
  reportId: string;
  caseReference: string;
  status: string;
}

export interface ReportMoreInformationRequestedEvent {
  userId: string;
  reportId: string;
  caseReference: string;
}

// NEW — backs NotificationListener.handleNewReport(). Previously
// NEW_REPORT was emitted by ReportService.create() with no matching
// event interface or listener.
export interface NewReportEvent {
  reportId: string;
  caseReference: string;
}

// NEW — backs NotificationListener.handleHighPriorityReport().
// Previously HIGH_PRIORITY_REPORT was emitted by ReportService.escalate()
// with no matching event interface or listener.
export interface HighPriorityReportEvent {
  reportId: string;
  caseReference: string;
  reason?: string;
}

// NEW — backs NotificationListener.handleReportAssigned(). Previously
// REPORT_ASSIGNED was emitted by ReportService.assign() with no
// matching event interface or listener.
export interface ReportAssignedEvent {
  reportId: string;
  caseReference: string;
  assignedToUserId: string;
}

// NEW — backs NotificationListener.handleInformationRequestResponded().
// Previously INFORMATION_REQUEST_RESPONDED was emitted by
// ReportService.respondToInformationRequest() with no matching event
// interface or listener.
export interface InformationRequestRespondedEvent {
  reportId: string;
  caseReference: string;
  informationRequestId: string;
  requestedById: string;
}

export interface NewPostEvent {
  postId: string;
  userId: string;
}

export interface PostApprovedEvent {
  userId: string;
  postId: string;
  title?: string;
}

export interface PostRejectedEvent {
  userId: string;
  postId: string;
  title?: string;
}

// NEW — backs NotificationListener.handlePostChangesRequested().
// Previously POST_CHANGES_REQUESTED was emitted by
// PostService.requestChanges() with no matching event interface or
// listener.
export interface PostChangesRequestedEvent {
  postId: string;
  userId: string;
  message: string;
}

// NEW — backs NotificationListener.handlePostUnpublished(). Previously
// POST_UNPUBLISHED was emitted by PostService.unpublish() with no
// matching event interface or listener.
export interface PostUnpublishedEvent {
  postId: string;
  userId: string;
}

export interface MissingPersonRequestUpdatedEvent {
  userId: string;
  missingPersonId: string;
  status: string;
}

export interface SupportPaymentConfirmedEvent {
  userId: string;
  supportId: string;
  amount?: string | number;
}

// ─────────────────────────────────────────────
// MISSING PERSON (status-transition events)
// ─────────────────────────────────────────────

// NEW — backs NotificationListener.handleNewMissingPersonRequest().
// Previously NEW_MISSING_PERSON_REQUEST was emitted by
// MissingPersonService.create() with no matching event interface or
// listener.
export interface NewMissingPersonRequestEvent {
  userId: string;
  missingPersonId: string;
}

// NEW — backs NotificationListener.handleMissingPersonApproved().
// Previously MISSING_PERSON_APPROVED was emitted by
// MissingPersonService.updateStatus() with no matching event
// interface or listener.
export interface MissingPersonApprovedEvent {
  userId: string;
  missingPersonId: string;
  previousStatus?: string;
}

// NEW — backs NotificationListener.handleMissingPersonRejected().
// Previously MISSING_PERSON_REJECTED was emitted by
// MissingPersonService.updateStatus() with no matching event
// interface or listener.
export interface MissingPersonRejectedEvent {
  userId: string;
  missingPersonId: string;
  previousStatus?: string;
  reviewNote?: string;
}

// NEW — backs NotificationListener.handleMissingPersonFound().
// Previously MISSING_PERSON_FOUND was emitted by
// MissingPersonService.updateStatus() with no matching event
// interface or listener.
export interface MissingPersonFoundEvent {
  userId: string;
  missingPersonId: string;
  previousStatus?: string;
}

// NEW — backs NotificationListener.handleMissingPersonMoreInformationRequested().
// Previously MISSING_PERSON_MORE_INFORMATION_REQUESTED was emitted by
// MissingPersonService.updateStatus() with no matching event
// interface or listener.
export interface MissingPersonMoreInformationRequestedEvent {
  userId: string;
  missingPersonId: string;
  reviewNote?: string;
}

// ─────────────────────────────────────────────
// INFORMATION SUBMISSION
//
// NEW — backs NotificationListener.handleInformationSubmissionReviewed()
// / handleInformationSubmissionRejected(). Previously
// InformationSubmissionService.review() emitted these two via the
// shared NotificationEventEnum (a dynamic enum reference, not a raw
// string) correctly, but with no matching event interface or
// listener, so EventEmitter2 silently dropped both — a submitter was
// never notified their tip was reviewed or rejected.
//
// `userId` here is InformationSubmission.userId — required (not
// nullable) on the schema, unlike VictimProfile.createdByUserId, so
// no optional/null handling needed and no null-guard in the listener.
// Shape matches exactly what review() sends:
//
//   this.eventEmitter.emit(notificationEvent, {
//     userId: submission.userId,
//     informationSubmissionId: updated.id,
//     missingPersonId: submission.missingPersonId,
//     status: updated.status,
//     reviewNote,
//   });
// ─────────────────────────────────────────────

export interface InformationSubmissionReviewedEvent {
  userId: string;
  informationSubmissionId: string;
  missingPersonId: string;
  status: string;
}

export interface InformationSubmissionRejectedEvent {
  userId: string;
  informationSubmissionId: string;
  missingPersonId: string;
  status: string;
  reviewNote?: string;
}

// ─────────────────────────────────────────────
// VICTIM PROFILE
//
// NEW — backs NotificationListener's VictimProfile handlers. Previously
// VictimProfileService emitted 'notification.victim_profile.X' string
// literals with no matching enum member, event interface, or listener,
// so EventEmitter2 silently dropped every one of them.
//
// `userId` here is VictimProfile.createdByUserId, resolved by the
// service before emitting — every handler skips sending a notification
// when it's null/undefined, since VictimProfile has no required
// submitter/owner relation the way Report/Post/MissingPerson do.
// ─────────────────────────────────────────────

export interface VictimProfileCreatedEvent {
  victimProfileId: string;
  userId?: string | null;
}

export interface VictimProfileUpdatedEvent {
  victimProfileId: string;
  userId?: string | null;
}

export interface VictimProfileDeletedEvent {
  victimProfileId: string;
  userId?: string | null;
}

export interface VictimProfileGatesUpdatedEvent {
  victimProfileId: string;
  userId?: string | null;
  status: string;
}

export interface VictimProfileChildSafetyReviewedEvent {
  victimProfileId: string;
  userId?: string | null;
  status: string;
}

export interface VictimProfileConsentRevokedEvent {
  victimProfileId: string;
  userId?: string | null;
}

export interface VictimProfileBankDetailsUpdatedEvent {
  victimProfileId: string;
  userId?: string | null;
  reapprovalRequired: boolean;
}

export interface VictimProfilePublishedEvent {
  victimProfileId: string;
  userId?: string | null;
}

export interface VictimProfileUnpublishedEvent {
  victimProfileId: string;
  userId?: string | null;
}

export interface VictimProfileRejectedEvent {
  victimProfileId: string;
  userId?: string | null;
}

export interface VictimProfileResubmittedEvent {
  victimProfileId: string;
  userId?: string | null;
  status: string;
}

// ─────────────────────────────────────────────
// UNCONFIRMED — NO KNOWN EMIT SITE
//
// NEW_MISSING_PERSON_INFORMATION and SECURITY_ALERT both exist in
// NotificationEventEnum and NotificationType, but no emit call for
// either turned up in report/post/missing-person/information-
// submission/victim-profile/user/auth/admin-auth/permission/role/
// support services. These two interfaces are best-guess placeholders
// so the listener at least compiles and fails loudly (via the
// `// TODO: confirm` handlers below) rather than silently, if an
// emit site is found in an unreviewed module. DO NOT treat these
// shapes as confirmed — verify against the real emit call the
// moment one is found, and adjust both the interface and the
// handler's field usage to match.
// ─────────────────────────────────────────────

// TODO: confirm emit site and payload shape. Best guess: emitted by
// InformationSubmissionService.create() (or a missing-person-scoped
// equivalent) to tell admins new information came in on a case and
// needs review — mirroring the NEW_REPORT/NEW_POST/
// NEW_MISSING_PERSON_REQUEST admin-broadcast pattern rather than
// notifying a specific user. If it turns out to target the missing
// person's original submitter instead, this needs a `userId` field
// and the handler needs to switch from createForAdmins to create().
export interface NewMissingPersonInformationEvent {
  missingPersonId: string;
  informationSubmissionId?: string;
}

// TODO: confirm emit site and payload shape. Best guess: security-
// relevant account activity (e.g. repeated failed logins, lockout,
// suspicious admin action) targeting a specific account — userId
// optional here since some SECURITY_ALERT cases might be
// admin-facing broadcasts rather than per-user, until a real emit
// call clarifies which.
export interface SecurityAlertEvent {
  userId?: string;
  reason?: string;
}

// ─────────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────────

export interface PasswordChangedEvent {
  userId: string;
}

export interface PasswordResetEvent {
  userId: string;
}