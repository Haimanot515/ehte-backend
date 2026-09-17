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
// AUTH
// ─────────────────────────────────────────────

export interface PasswordChangedEvent {
  userId: string;
}

export interface PasswordResetEvent {
  userId: string;
}