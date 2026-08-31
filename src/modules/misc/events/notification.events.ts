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
// AUTH
// ─────────────────────────────────────────────

export interface PasswordChangedEvent {
  userId: string;
}

export interface PasswordResetEvent {
  userId: string;
}