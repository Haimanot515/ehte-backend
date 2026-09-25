import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationPriority, NotificationType } from '@prisma/client';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

import { NotificationContent, NotificationService } from '../service/notification.service';

import {
  ReportReceivedEvent,
  ReportUpdatedEvent,
  ReportMoreInformationRequestedEvent,
  NewReportEvent,
  HighPriorityReportEvent,
  ReportAssignedEvent,
  InformationRequestRespondedEvent,
  NewPostEvent,
  PostApprovedEvent,
  PostRejectedEvent,
  PostChangesRequestedEvent,
  PostUnpublishedEvent,
  MissingPersonRequestUpdatedEvent,
  SupportPaymentConfirmedEvent,
  PasswordChangedEvent,
  PasswordResetEvent,
  NewMissingPersonRequestEvent,
  MissingPersonApprovedEvent,
  MissingPersonRejectedEvent,
  MissingPersonFoundEvent,
  MissingPersonMoreInformationRequestedEvent,
  VictimProfileCreatedEvent,
  VictimProfileUpdatedEvent,
  VictimProfileDeletedEvent,
  VictimProfileGatesUpdatedEvent,
  VictimProfileChildSafetyReviewedEvent,
  VictimProfileConsentRevokedEvent,
  VictimProfileBankDetailsUpdatedEvent,
  VictimProfilePublishedEvent,
  VictimProfileUnpublishedEvent,
  VictimProfileRejectedEvent,
  VictimProfileResubmittedEvent,
  InformationSubmissionReviewedEvent,
  InformationSubmissionRejectedEvent,
  NewMissingPersonInformationEvent,
  SecurityAlertEvent,
  // NEW — billing (see service/payment.service.ts, service/reward.service.ts,
  // service/disbursement.service.ts). Add these three interfaces to
  // notification.events.ts if they aren't there yet.
  PaymentVerifiedEvent,
  RewardClaimApprovedEvent,
  DisbursementPaidOutEvent,
  InstitutionSignedEvent,
  AgreementCreatedEvent,
  AgreementActivatedEvent,
  AgreementRetiredEvent,
  VictimProfileAgreementAssignedEvent,
} from '../events/notification.events';

// ASSUMPTION: these are the frontend routes. Change them here, in one place.
// actionUrl is navigation only; the backend still authorizes every request.
const URLS = {
  report: (id: string) => `/reports/${id}`,
  post: (id: string) => `/posts/${id}`,
  missingPerson: (id: string) => `/missing-persons/${id}`,
  informationSubmission: (id: string) => `/information-submissions/${id}`,
  victimProfile: (id: string) => `/victim-profiles/${id}`,
  support: (id: string) => `/supports/${id}`,
  security: () => `/security/sessions`,
  // NEW — billing
  payment: (id: string) => `/payments/${id}`,
  disbursement: (id: string) => `/disbursements/${id}`,
  institution: (id: string) => `/admin/billing/institutions/${id}`,
  agreement: (id: string) => `/admin/billing/agreements/${id}`,
  victimProfileAgreement: (profileId: string) => `/admin/billing/profiles/${profileId}/agreement`,
};

// Turns domain events into notifications. Bodies stay generic — free-text
// notes and financial specifics are never copied in; open the linked page.
@Injectable()
export class NotificationListener {
  private readonly logger = new Logger(NotificationListener.name);

  constructor(private readonly notificationService: NotificationService) {}

  // ───────────────────────────────────────────
  // helpers
  // ───────────────────────────────────────────

  private async safely(handler: string, fn: () => Promise<unknown>): Promise<void> {
    try {
      await fn();
    } catch (error) {
      this.logger.error(
        `Notification handler failed: ${handler}`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  // Personal notification. Skips quietly when the recipient is unknown.
  private async toUser(
    handler: string,
    userId: string | null | undefined,
    content: NotificationContent,
    dedupeKey?: string,
  ) {
    if (!userId) {
      this.logger.warn(`Notification skipped (no recipient): ${handler}`);
      return;
    }
    await this.safely(handler, () =>
      this.notificationService.createForUser({ ...content, userId, dedupeKey }),
    );
  }

  // Admin-queue notification: one row per active admin.
  private async toAdmins(
    handler: string,
    content: NotificationContent,
    excludeUserId?: string | null,
  ) {
    await this.safely(handler, () =>
      this.notificationService.createForAdmins({ ...content, excludeUserId }),
    );
  }

  // ───────────────────────────────────────────
  // REPORT
  // ───────────────────────────────────────────

  @OnEvent(NotificationEventEnum.REPORT_RECEIVED)
  async handleReportReceived(event: ReportReceivedEvent) {
    await this.toUser('REPORT_RECEIVED', event.userId, {
      type: NotificationType.REPORT_RECEIVED,
      title: 'Report Received',
      body: `Your report ${event.caseReference} has been received successfully.`,
      entity: 'Report',
      entityId: event.reportId,
      actionUrl: URLS.report(event.reportId),
    });
  }

  @OnEvent(NotificationEventEnum.REPORT_UPDATED)
  async handleReportUpdated(event: ReportUpdatedEvent) {
    await this.toUser('REPORT_UPDATED', event.userId, {
      type: NotificationType.REPORT_UPDATED,
      title: 'Report Updated',
      body: `Your report ${event.caseReference} has been updated. Status: ${event.status}.`,
      entity: 'Report',
      entityId: event.reportId,
      actionUrl: URLS.report(event.reportId),
    });
  }

  @OnEvent(NotificationEventEnum.MORE_INFORMATION_REQUESTED)
  async handleMoreInformationRequested(event: ReportMoreInformationRequestedEvent) {
    await this.toUser('MORE_INFORMATION_REQUESTED', event.userId, {
      type: NotificationType.MORE_INFORMATION_REQUESTED,
      title: 'More Information Requested',
      body: `Additional information has been requested for report ${event.caseReference}.`,
      entity: 'Report',
      entityId: event.reportId,
      actionUrl: URLS.report(event.reportId),
    });
  }

  @OnEvent(NotificationEventEnum.NEW_REPORT)
  async handleNewReport(event: NewReportEvent) {
    await this.toAdmins('NEW_REPORT', {
      type: NotificationType.NEW_REPORT,
      title: 'New Report Submitted',
      body: `A new report ${event.caseReference} has been submitted and needs review.`,
      entity: 'Report',
      entityId: event.reportId,
      actionUrl: URLS.report(event.reportId),
    });
  }

  @OnEvent(NotificationEventEnum.HIGH_PRIORITY_REPORT)
  async handleHighPriorityReport(event: HighPriorityReportEvent) {
    await this.toAdmins('HIGH_PRIORITY_REPORT', {
      type: NotificationType.HIGH_PRIORITY_REPORT,
      title: 'High Priority Report',
      body: `Report ${event.caseReference} has been escalated and needs urgent attention.`,
      priority: NotificationPriority.HIGH,
      entity: 'Report',
      entityId: event.reportId,
      actionUrl: URLS.report(event.reportId),
    });
  }

  @OnEvent(NotificationEventEnum.REPORT_ASSIGNED)
  async handleReportAssigned(event: ReportAssignedEvent) {
    // No dedupeKey: the same report can legitimately be assigned to the same admin again.
    await this.toUser('REPORT_ASSIGNED', event.assignedToUserId, {
      type: NotificationType.REPORT_ASSIGNED,
      title: 'Report Assigned to You',
      body: `Report ${event.caseReference} has been assigned to you.`,
      entity: 'Report',
      entityId: event.reportId,
      actionUrl: URLS.report(event.reportId),
    });
  }

  @OnEvent(NotificationEventEnum.INFORMATION_REQUEST_RESPONDED)
  async handleInformationRequestResponded(event: InformationRequestRespondedEvent) {
    await this.toUser(
      'INFORMATION_REQUEST_RESPONDED',
      event.requestedById,
      {
        type: NotificationType.INFORMATION_REQUEST_RESPONDED,
        title: 'Information Request Responded',
        body: `The reporter responded to your information request on report ${event.caseReference}.`,
        entity: 'Report',
        entityId: event.reportId,
        actionUrl: URLS.report(event.reportId),
      },
      `INFORMATION_REQUEST_RESPONDED:${event.informationRequestId}`,
    );
  }

  // ───────────────────────────────────────────
  // POST
  // ───────────────────────────────────────────

  @OnEvent(NotificationEventEnum.NEW_POST)
  async handleNewPost(event: NewPostEvent) {
    await this.toAdmins(
      'NEW_POST',
      {
        type: NotificationType.NEW_POST,
        title: 'New Post Submitted',
        body: 'A new post has been submitted and needs review.',
        entity: 'Post',
        entityId: event.postId,
        actorId: event.userId,
        actionUrl: URLS.post(event.postId),
      },
      event.userId, // do not notify the submitter about their own post
    );
  }

  @OnEvent(NotificationEventEnum.POST_APPROVED)
  async handlePostApproved(event: PostApprovedEvent) {
    await this.toUser('POST_APPROVED', event.userId, {
      type: NotificationType.POST_APPROVED,
      title: 'Post Approved',
      body: event.title
        ? `Your post "${event.title}" has been approved.`
        : 'Your post has been approved.',
      entity: 'Post',
      entityId: event.postId,
      actionUrl: URLS.post(event.postId),
    });
  }

  @OnEvent(NotificationEventEnum.POST_REJECTED)
  async handlePostRejected(event: PostRejectedEvent) {
    await this.toUser('POST_REJECTED', event.userId, {
      type: NotificationType.POST_REJECTED,
      title: 'Post Rejected',
      body: event.title
        ? `Your post "${event.title}" has been rejected.`
        : 'Your post has been rejected.',
      entity: 'Post',
      entityId: event.postId,
      actionUrl: URLS.post(event.postId),
    });
  }

  @OnEvent(NotificationEventEnum.POST_CHANGES_REQUESTED)
  async handlePostChangesRequested(event: PostChangesRequestedEvent) {
    await this.toUser('POST_CHANGES_REQUESTED', event.userId, {
      type: NotificationType.POST_CHANGES_REQUESTED,
      title: 'Changes Requested on Your Post',
      body: 'Changes have been requested on your post. Open it to see the details.',
      entity: 'Post',
      entityId: event.postId,
      actionUrl: URLS.post(event.postId),
    });
  }

  @OnEvent(NotificationEventEnum.POST_UNPUBLISHED)
  async handlePostUnpublished(event: PostUnpublishedEvent) {
    await this.toUser('POST_UNPUBLISHED', event.userId, {
      type: NotificationType.POST_UNPUBLISHED,
      title: 'Post Unpublished',
      body: 'Your post has been unpublished and is no longer visible to the public.',
      entity: 'Post',
      entityId: event.postId,
      actionUrl: URLS.post(event.postId),
    });
  }

  // ───────────────────────────────────────────
  // MISSING PERSON
  // ───────────────────────────────────────────

  @OnEvent(NotificationEventEnum.NEW_MISSING_PERSON_REQUEST)
  async handleNewMissingPersonRequest(event: NewMissingPersonRequestEvent) {
    await this.toAdmins(
      'NEW_MISSING_PERSON_REQUEST',
      {
        type: NotificationType.NEW_MISSING_PERSON_REQUEST,
        title: 'New Missing Person Case Submitted',
        body: 'A new missing person case has been submitted and needs review.',
        entity: 'MissingPerson',
        entityId: event.missingPersonId,
        actorId: event.userId,
        actionUrl: URLS.missingPerson(event.missingPersonId),
      },
      event.userId,
    );
  }

  @OnEvent(NotificationEventEnum.MISSING_PERSON_UPDATED)
  async handleMissingPersonUpdated(event: MissingPersonRequestUpdatedEvent) {
    await this.toUser('MISSING_PERSON_UPDATED', event.userId, {
      type: NotificationType.MISSING_PERSON_UPDATED,
      title: 'Missing Person Case Updated',
      body: `The missing person case has been updated. Status: ${event.status}.`,
      entity: 'MissingPerson',
      entityId: event.missingPersonId,
      actionUrl: URLS.missingPerson(event.missingPersonId),
    });
  }

  @OnEvent(NotificationEventEnum.MISSING_PERSON_APPROVED)
  async handleMissingPersonApproved(event: MissingPersonApprovedEvent) {
    await this.toUser('MISSING_PERSON_APPROVED', event.userId, {
      type: NotificationType.MISSING_PERSON_APPROVED,
      title: 'Missing Person Case Approved',
      body: 'Your missing person case has been reviewed and approved. It is now publicly visible.',
      entity: 'MissingPerson',
      entityId: event.missingPersonId,
      actionUrl: URLS.missingPerson(event.missingPersonId),
    });
  }

  @OnEvent(NotificationEventEnum.MISSING_PERSON_REJECTED)
  async handleMissingPersonRejected(event: MissingPersonRejectedEvent) {
    await this.toUser('MISSING_PERSON_REJECTED', event.userId, {
      type: NotificationType.MISSING_PERSON_REJECTED,
      title: 'Missing Person Case Rejected',
      body: 'Your missing person case was rejected. Open it to see the details.',
      entity: 'MissingPerson',
      entityId: event.missingPersonId,
      actionUrl: URLS.missingPerson(event.missingPersonId),
    });
  }

  @OnEvent(NotificationEventEnum.MISSING_PERSON_FOUND)
  async handleMissingPersonFound(event: MissingPersonFoundEvent) {
    await this.toUser('MISSING_PERSON_FOUND', event.userId, {
      type: NotificationType.MISSING_PERSON_FOUND,
      title: 'Missing Person Found',
      body: 'Great news: the missing person case has been marked as found.',
      entity: 'MissingPerson',
      entityId: event.missingPersonId,
      actionUrl: URLS.missingPerson(event.missingPersonId),
    });
  }

  @OnEvent(NotificationEventEnum.MISSING_PERSON_MORE_INFORMATION_REQUESTED)
  async handleMissingPersonMoreInformationRequested(
    event: MissingPersonMoreInformationRequestedEvent,
  ) {
    await this.toUser('MISSING_PERSON_MORE_INFORMATION_REQUESTED', event.userId, {
      type: NotificationType.MISSING_PERSON_MORE_INFORMATION_REQUESTED,
      title: 'More Information Requested',
      body: 'Additional information has been requested for your missing person case.',
      entity: 'MissingPerson',
      entityId: event.missingPersonId,
      actionUrl: URLS.missingPerson(event.missingPersonId),
    });
  }

  // ───────────────────────────────────────────
  // INFORMATION SUBMISSION
  // ───────────────────────────────────────────

  @OnEvent(NotificationEventEnum.INFORMATION_SUBMISSION_REVIEWED)
  async handleInformationSubmissionReviewed(event: InformationSubmissionReviewedEvent) {
    await this.toUser(
      'INFORMATION_SUBMISSION_REVIEWED',
      event.userId,
      {
        type: NotificationType.INFORMATION_SUBMISSION_REVIEWED,
        title: 'Information Submission Reviewed',
        body: 'Your submitted information has been reviewed and accepted.',
        entity: 'InformationSubmission',
        entityId: event.informationSubmissionId,
        actionUrl: URLS.informationSubmission(event.informationSubmissionId),
      },
      `INFORMATION_SUBMISSION_REVIEWED:${event.informationSubmissionId}`,
    );
  }

  @OnEvent(NotificationEventEnum.INFORMATION_SUBMISSION_REJECTED)
  async handleInformationSubmissionRejected(event: InformationSubmissionRejectedEvent) {
    await this.toUser(
      'INFORMATION_SUBMISSION_REJECTED',
      event.userId,
      {
        type: NotificationType.INFORMATION_SUBMISSION_REJECTED,
        title: 'Information Submission Rejected',
        body: 'Your submitted information was rejected. Open it to see the details.',
        entity: 'InformationSubmission',
        entityId: event.informationSubmissionId,
        actionUrl: URLS.informationSubmission(event.informationSubmissionId),
      },
      `INFORMATION_SUBMISSION_REJECTED:${event.informationSubmissionId}`,
    );
  }

  // TODO: confirm emit site (see notification.events.ts). Best guess: admin-facing.
  @OnEvent(NotificationEventEnum.NEW_MISSING_PERSON_INFORMATION)
  async handleNewMissingPersonInformation(event: NewMissingPersonInformationEvent) {
    await this.toAdmins('NEW_MISSING_PERSON_INFORMATION', {
      type: NotificationType.NEW_MISSING_PERSON_INFORMATION,
      title: 'New Information Submitted',
      body: 'New information has been submitted on a missing person case and needs review.',
      entity: 'MissingPerson',
      entityId: event.missingPersonId,
      actionUrl: URLS.missingPerson(event.missingPersonId),
    });
  }

  // ───────────────────────────────────────────
  // SUPPORT
  // ───────────────────────────────────────────

  // Uses the same payload shape as SUPPORT_PAYMENT_CONFIRMED ({ userId, supportId, amount? }).
  @OnEvent(NotificationEventEnum.SUPPORT_PLEDGE_CREATED)
  async handleSupportPledgeCreated(event: SupportPaymentConfirmedEvent) {
    await this.toUser(
      'SUPPORT_PLEDGE_CREATED',
      event.userId,
      {
        type: NotificationType.SUPPORT_PLEDGE_CREATED,
        title: 'Support Pledge Received',
        body: 'Your support pledge was received. It will be confirmed once the payment is verified.',
        entity: 'Support',
        entityId: event.supportId,
        actionUrl: URLS.support(event.supportId),
      },
      `SUPPORT_PLEDGE_CREATED:${event.supportId}`,
    );
  }

  // Amount is deliberately left out of the body — financial specifics never
  // go into a notification (same rule as admin review notes above). Open
  // My Support / the linked page to see the confirmed amount.
  @OnEvent(NotificationEventEnum.SUPPORT_PAYMENT_CONFIRMED)
  async handleSupportPaymentConfirmed(event: SupportPaymentConfirmedEvent) {
    await this.toUser(
      'SUPPORT_PAYMENT_CONFIRMED',
      event.userId,
      {
        type: NotificationType.SUPPORT_PAYMENT_CONFIRMED,
        title: 'Support Payment Confirmed',
        body: 'Your support payment has been confirmed.',
        entity: 'Support',
        entityId: event.supportId,
        actionUrl: URLS.support(event.supportId),
      },
      `SUPPORT_PAYMENT_CONFIRMED:${event.supportId}`,
    );
  }

  // ───────────────────────────────────────────
  // BILLING
  //
  // NEW — payment.service.ts (reconcile -> PAID), reward.service.ts
  // (approveClaim), disbursement.service.ts (markPaidOut, both the
  // MANUAL_BANK branch of execute() and the CHAPA_TRANSFER branch of
  // syncProcessing()). Amount/fees are deliberately left out of every body
  // below, same rule as SUPPORT_PAYMENT_CONFIRMED above — open the linked
  // page for financial specifics.
  //
  // REQUIRES: NotificationType.PAYMENT_VERIFIED, .REWARD_CLAIM_APPROVED and
  // .DISBURSEMENT_PAID_OUT added to the Prisma enum in notification.prisma
  // (new migration) — this file only references them, it can't create them.
  // ───────────────────────────────────────────

  @OnEvent(NotificationEventEnum.PAYMENT_VERIFIED)
  async handlePaymentVerified(event: PaymentVerifiedEvent) {
    await this.toUser(
      'PAYMENT_VERIFIED',
      event.userId,
      {
        type: NotificationType.PAYMENT_VERIFIED,
        title: 'Payment Verified',
        body: 'Your payment has been verified.',
        entity: 'Payment',
        entityId: event.paymentId,
        actionUrl: URLS.payment(event.paymentId),
      },
      `PAYMENT_VERIFIED:${event.paymentId}`,
    );
  }

  @OnEvent(NotificationEventEnum.REWARD_CLAIM_APPROVED)
  async handleRewardClaimApproved(event: RewardClaimApprovedEvent) {
    await this.toUser(
      'REWARD_CLAIM_APPROVED',
      event.userId,
      {
        type: NotificationType.REWARD_CLAIM_APPROVED,
        title: 'Reward Claim Approved',
        body: 'Your reward claim has been approved. Payout is being processed.',
        entity: 'MissingPerson',
        entityId: event.missingPersonId,
        actionUrl: URLS.missingPerson(event.missingPersonId),
      },
      `REWARD_CLAIM_APPROVED:${event.rewardClaimId}`,
    );
  }

  @OnEvent(NotificationEventEnum.DISBURSEMENT_PAID_OUT)
  async handleDisbursementPaidOut(event: DisbursementPaidOutEvent) {
    await this.toUser(
      'DISBURSEMENT_PAID_OUT',
      event.userId,
      {
        type: NotificationType.DISBURSEMENT_PAID_OUT,
        title: 'Payout Sent',
        body: 'A payout has been sent to you.',
        entity: 'Disbursement',
        entityId: event.disbursementId,
        actionUrl: URLS.disbursement(event.disbursementId),
      },
      `DISBURSEMENT_PAID_OUT:${event.disbursementId}`,
    );
  }

  // ───────────────────────────────────────────
  // AGREEMENTS / INSTITUTIONS
  //
  // Back-office actions — nobody outside the admin team is waiting on these,
  // so they broadcast to admins (toAdmins) rather than targeting a userId,
  // same pattern as NEW_REPORT/NEW_POST. excludeUserId keeps the admin who
  // performed the action off their own notification feed.
  //
  // REQUIRES: NotificationType.INSTITUTION_SIGNED, .AGREEMENT_CREATED,
  // .AGREEMENT_ACTIVATED, .AGREEMENT_RETIRED and
  // .VICTIM_PROFILE_AGREEMENT_ASSIGNED added to the Prisma enum in
  // notification.prisma (new migration) — this file only references them,
  // it can't create them. Same for NotificationEventEnum.INSTITUTION_SIGNED
  // etc. in notification-events.enum.ts.
  // ───────────────────────────────────────────

  @OnEvent(NotificationEventEnum.INSTITUTION_SIGNED)
  async handleInstitutionSigned(event: InstitutionSignedEvent) {
    await this.toAdmins(
      'INSTITUTION_SIGNED',
      {
        type: NotificationType.INSTITUTION_SIGNED,
        title: 'Institution Agreement Signed',
        body: 'An institution has signed its billing agreement.',
        entity: 'Institution',
        entityId: event.institutionId,
        actionUrl: URLS.institution(event.institutionId),
      },
      event.actorId,
    );
  }

  @OnEvent(NotificationEventEnum.AGREEMENT_CREATED)
  async handleAgreementCreated(event: AgreementCreatedEvent) {
    await this.toAdmins(
      'AGREEMENT_CREATED',
      {
        type: NotificationType.AGREEMENT_CREATED,
        title: 'Agreement Draft Created',
        body: 'A new billing agreement draft has been created.',
        entity: 'Agreement',
        entityId: event.agreementId,
        actionUrl: URLS.agreement(event.agreementId),
      },
      event.actorId,
    );
  }

  @OnEvent(NotificationEventEnum.AGREEMENT_ACTIVATED)
  async handleAgreementActivated(event: AgreementActivatedEvent) {
    await this.toAdmins(
      'AGREEMENT_ACTIVATED',
      {
        type: NotificationType.AGREEMENT_ACTIVATED,
        title: 'Agreement Activated',
        body: 'A billing agreement has been activated and is now immutable.',
        entity: 'Agreement',
        entityId: event.agreementId,
        actionUrl: URLS.agreement(event.agreementId),
      },
      event.actorId,
    );
  }

  @OnEvent(NotificationEventEnum.AGREEMENT_RETIRED)
  async handleAgreementRetired(event: AgreementRetiredEvent) {
    await this.toAdmins(
      'AGREEMENT_RETIRED',
      {
        type: NotificationType.AGREEMENT_RETIRED,
        title: 'Agreement Retired',
        body: 'A billing agreement has been retired.',
        entity: 'Agreement',
        entityId: event.agreementId,
        actionUrl: URLS.agreement(event.agreementId),
      },
      event.actorId,
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_AGREEMENT_ASSIGNED)
  async handleVictimProfileAgreementAssigned(event: VictimProfileAgreementAssignedEvent) {
    // ID-only body, same privacy rule as the audit row: no profile name.
    await this.toAdmins(
      'VICTIM_PROFILE_AGREEMENT_ASSIGNED',
      {
        type: NotificationType.VICTIM_PROFILE_AGREEMENT_ASSIGNED,
        title: 'Profile Agreement Changed',
        body: "A victim profile's billing agreement has been reassigned.",
        entity: 'VictimProfile',
        entityId: event.profileId,
        actionUrl: URLS.victimProfileAgreement(event.profileId),
      },
      event.actorId,
    );
  }

  // ───────────────────────────────────────────
  // VICTIM PROFILE
  //
  // Recipient: event.userId = VictimProfile.createdByUserId. Handlers skip
  // quietly when it is missing. Revisit if some of these should go to all
  // admins instead of the creator.
  // ───────────────────────────────────────────

  private victimProfile(
    handler: string,
    event: { victimProfileId: string; userId?: string | null },
    type: NotificationType,
    title: string,
    body: string,
    priority?: NotificationPriority,
  ) {
    return this.toUser(handler, event.userId, {
      type,
      title,
      body,
      priority,
      entity: 'VictimProfile',
      entityId: event.victimProfileId,
      actionUrl: URLS.victimProfile(event.victimProfileId),
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_CREATED)
  async handleVictimProfileCreated(event: VictimProfileCreatedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_CREATED',
      event,
      NotificationType.VICTIM_PROFILE_CREATED,
      'Victim Profile Created',
      'A victim profile you created is now pending review.',
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_UPDATED)
  async handleVictimProfileUpdated(event: VictimProfileUpdatedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_UPDATED',
      event,
      NotificationType.VICTIM_PROFILE_UPDATED,
      'Victim Profile Updated',
      'A victim profile you created was updated and is now pending re-review.',
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_DELETED)
  async handleVictimProfileDeleted(event: VictimProfileDeletedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_DELETED',
      event,
      NotificationType.VICTIM_PROFILE_DELETED,
      'Victim Profile Deleted',
      'A victim profile you created has been deleted.',
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_GATES_UPDATED)
  async handleVictimProfileGatesUpdated(event: VictimProfileGatesUpdatedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_GATES_UPDATED',
      event,
      NotificationType.VICTIM_PROFILE_GATES_UPDATED,
      'Victim Profile Review Updated',
      `The review status of a victim profile you created has changed. Status: ${event.status}.`,
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED)
  async handleVictimProfileChildSafetyReviewed(event: VictimProfileChildSafetyReviewedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_CHILD_SAFETY_REVIEWED',
      event,
      NotificationType.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
      'Victim Profile Child-Safety Review Updated',
      `The child-safety review status of a victim profile you created has changed. Status: ${event.status}.`,
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_CONSENT_REVOKED)
  async handleVictimProfileConsentRevoked(event: VictimProfileConsentRevokedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_CONSENT_REVOKED',
      event,
      NotificationType.VICTIM_PROFILE_CONSENT_REVOKED,
      'Victim Profile Consent Revoked',
      'Consent on a victim profile you created has been revoked.',
      NotificationPriority.HIGH,
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED)
  async handleVictimProfileBankDetailsUpdated(event: VictimProfileBankDetailsUpdatedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_BANK_DETAILS_UPDATED',
      event,
      NotificationType.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
      'Victim Profile Bank Details Updated',
      event.reapprovalRequired
        ? 'Bank details were updated on a victim profile you created. It now requires re-approval.'
        : 'Bank details were updated on a victim profile you created.',
      NotificationPriority.HIGH,
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_PUBLISHED)
  async handleVictimProfilePublished(event: VictimProfilePublishedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_PUBLISHED',
      event,
      NotificationType.VICTIM_PROFILE_PUBLISHED,
      'Victim Profile Published',
      'A victim profile you created has been published and is now publicly visible.',
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_UNPUBLISHED)
  async handleVictimProfileUnpublished(event: VictimProfileUnpublishedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_UNPUBLISHED',
      event,
      NotificationType.VICTIM_PROFILE_UNPUBLISHED,
      'Victim Profile Unpublished',
      'A victim profile you created has been unpublished and is no longer visible to the public.',
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_REJECTED)
  async handleVictimProfileRejected(event: VictimProfileRejectedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_REJECTED',
      event,
      NotificationType.VICTIM_PROFILE_REJECTED,
      'Victim Profile Rejected',
      'A victim profile you created has been rejected.',
    );
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_RESUBMITTED)
  async handleVictimProfileResubmitted(event: VictimProfileResubmittedEvent) {
    await this.victimProfile(
      'VICTIM_PROFILE_RESUBMITTED',
      event,
      NotificationType.VICTIM_PROFILE_RESUBMITTED,
      'Victim Profile Resubmitted',
      `A victim profile you created has been resubmitted for review. Status: ${event.status}.`,
    );
  }

  // ───────────────────────────────────────────
  // SECURITY / AUTH
  // ───────────────────────────────────────────

  // TODO: confirm emit site (see notification.events.ts). Per-user only when userId is present.
  @OnEvent(NotificationEventEnum.SECURITY_ALERT)
  async handleSecurityAlert(event: SecurityAlertEvent) {
    await this.toUser('SECURITY_ALERT', event.userId, {
      type: NotificationType.SECURITY_ALERT,
      title: 'Security Alert',
      body: 'A security event was detected on your account. Review your active sessions.',
      priority: NotificationPriority.URGENT,
      entity: 'User',
      entityId: event.userId,
      actionUrl: URLS.security(),
    });
  }

  @OnEvent(NotificationEventEnum.PASSWORD_CHANGED)
  async handlePasswordChanged(event: PasswordChangedEvent) {
    await this.toUser('PASSWORD_CHANGED', event.userId, {
      type: NotificationType.PASSWORD_CHANGED,
      title: 'Password Changed',
      body: "Your password was changed successfully. If this wasn't you, contact support immediately.",
      priority: NotificationPriority.HIGH,
      entity: 'User',
      entityId: event.userId,
    });
  }

  @OnEvent(NotificationEventEnum.PASSWORD_RESET)
  async handlePasswordReset(event: PasswordResetEvent) {
    await this.toUser('PASSWORD_RESET', event.userId, {
      type: NotificationType.PASSWORD_RESET,
      title: 'Password Reset',
      body: "Your password was reset successfully. If this wasn't you, contact support immediately.",
      priority: NotificationPriority.HIGH,
      entity: 'User',
      entityId: event.userId,
    });
  }
}