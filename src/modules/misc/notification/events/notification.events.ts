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

export interface NewReportEvent {
  reportId: string;
  caseReference: string;
  userId?: string;
}

export interface HighPriorityReportEvent {
  reportId: string;
  caseReference: string;
  reason?: string;
}

export interface ReportAssignedEvent {
  reportId: string;
  caseReference: string;
  assignedToUserId: string;
}

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

export interface PostChangesRequestedEvent {
  postId: string;
  userId: string;
  message: string;
}

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

// Victim-facing: userId is the profile's claimedByUserId (never createdByUserId).
export interface SupportReceivedEvent {
  userId: string;
  supportId: string;
  victimProfileId: string;
  // Name of the supporter, or null when they chose to stay anonymous.
  supporterName: string | null;
  // The recipient's share (not the gross amount the supporter paid).
  recipientAmount: string;
  // Profile total raised, read in the same transaction that added recipientAmount.
  totalRaised: string;
}

// Victim-facing, non-financial: sent when an admin confirms and again when it is completed.
export interface SupportOfferVictimEvent {
  userId: string;
  supportId: string;
  victimProfileId: string;
  supporterName: string | null;
  categories: string[];
}

// Supporter-facing: an unanswered non-financial offer was auto-cancelled.
export interface SupportOfferExpiredEvent {
  userId: string;
  supportId: string;
  expiryDays: number;
}

export interface NewMissingPersonRequestEvent {
  userId: string;
  missingPersonId: string;
}

export interface MissingPersonApprovedEvent {
  userId: string;
  missingPersonId: string;
  previousStatus?: string;
}

export interface MissingPersonRejectedEvent {
  userId: string;
  missingPersonId: string;
  previousStatus?: string;
  reviewNote?: string;
}

export interface MissingPersonFoundEvent {
  userId: string;
  missingPersonId: string;
  previousStatus?: string;
}

export interface MissingPersonMoreInformationRequestedEvent {
  userId: string;
  missingPersonId: string;
  reviewNote?: string;
}

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

export interface NewMissingPersonInformationEvent {
  missingPersonId: string;
  informationSubmissionId: string;
  userId: string;
}

export interface SecurityAlertEvent {
  userId?: string;
  reason?: string;
}

export interface PaymentVerifiedEvent {
  userId: string;
  paymentId: string;
  supportId?: string;
  missingPersonId?: string;
}

export interface RewardClaimApprovedEvent {
  userId: string;
  rewardClaimId: string;
  missingPersonId: string;
}

export interface DisbursementPaidOutEvent {
  userId: string;
  disbursementId: string;
  partyType: string;
}

export interface InstitutionSignedEvent {
  institutionId: string;
  actorId: string;
}

export interface AgreementCreatedEvent {
  agreementId: string;
  actorId: string;
}

export interface AgreementActivatedEvent {
  agreementId: string;
  actorId: string;
}

export interface AgreementRetiredEvent {
  agreementId: string;
  actorId: string;
}

export interface VictimProfileAgreementAssignedEvent {
  profileId: string;
  agreementId: string;
  actorId: string;
}

export interface PasswordChangedEvent {
  userId: string;
}

export interface PasswordResetEvent {
  userId: string;
}
