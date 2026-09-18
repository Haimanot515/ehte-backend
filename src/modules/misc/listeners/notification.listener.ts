import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationType } from '@prisma/client';

import { NotificationService } from '../service/notification.service';

import { NotificationEventEnum } from 'src/common/enums/shared/notification-events.enum';

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
  // NEW — payload types for the missing-person events that were
  // previously emitted by MissingPersonService with no listener
  // bound, so EventEmitter2 silently dropped them. Named/shaped to
  // match MissingPersonRequestUpdatedEvent (userId, missingPersonId,
  // status) plus the extra fields each specific emit call actually
  // sends (previousStatus, reviewNote). If your events file doesn't
  // yet export these, add them there — see the shape used below.
  NewMissingPersonRequestEvent,
  MissingPersonApprovedEvent,
  MissingPersonRejectedEvent,
  MissingPersonFoundEvent,
  MissingPersonMoreInformationRequestedEvent,
  // NEW — payload types for the VictimProfile events. Previously
  // VictimProfileService emitted 'notification.victim_profile.X'
  // string literals with no matching enum member, event interface,
  // or listener, so EventEmitter2 silently dropped every one of
  // them. See notification.events.ts for the recipient-resolution
  // note (userId here is VictimProfile.createdByUserId).
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
  // NEW — payload types for the two InformationSubmission review
  // events. InformationSubmissionService.review() already emitted
  // these correctly via the shared NotificationEventEnum (a dynamic
  // enum reference, not a raw string), but no listener handler and
  // no NotificationType member existed for either, so both silently
  // dropped — same failure mode as VictimProfile, just one call site.
  // Shape matches the payload InformationSubmissionService.review()
  // actually sends: { userId, informationSubmissionId,
  // missingPersonId, status, reviewNote }.
  InformationSubmissionReviewedEvent,
  InformationSubmissionRejectedEvent,
  // TODO: confirm emit site — see notification.events.ts for the
  // full caveat. These two have no confirmed emit call anywhere in
  // the reviewed services; handlers below exist so the listener
  // fails loudly (via the TODO log) rather than silently if one
  // turns up in an unreviewed module.
  NewMissingPersonInformationEvent,
  SecurityAlertEvent,
} from '../events/notification.events';

@Injectable()
export class NotificationListener {
  constructor(private readonly notificationService: NotificationService) {}

  @OnEvent(NotificationEventEnum.REPORT_RECEIVED)
  async handleReportReceived(event: ReportReceivedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.REPORT_RECEIVED,
      title: 'Report Received',
      body: `Your report ${event.caseReference} has been received successfully.`,
    });
  }

  @OnEvent(NotificationEventEnum.REPORT_UPDATED)
  async handleReportUpdated(event: ReportUpdatedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.REPORT_UPDATED,
      title: 'Report Updated',
      body: `Your report ${event.caseReference} has been updated. Status: ${event.status}.`,
    });
  }

  @OnEvent(NotificationEventEnum.MORE_INFORMATION_REQUESTED)
  async handleMoreInformationRequested(event: ReportMoreInformationRequestedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.MORE_INFORMATION_REQUESTED,
      title: 'More Information Requested',
      body: `Additional information has been requested for report ${event.caseReference}.`,
    });
  }

  // NEW — was previously emitted by ReportService.create() with no
  // listener, so it was silently dropped by EventEmitter2. Notifies
  // every ADMIN/SUPER_ADMIN individually (see
  // NotificationService.createForAdmins) rather than broadcasting,
  // so regular reporting users never see admin-queue notifications.
  @OnEvent(NotificationEventEnum.NEW_REPORT)
  async handleNewReport(event: NewReportEvent) {
    await this.notificationService.createForAdmins({
      type: NotificationType.NEW_REPORT,
      title: 'New Report Submitted',
      body: `A new report ${event.caseReference} has been submitted and needs review.`,
    });
  }

  // NEW — was previously emitted by ReportService.escalate() with no
  // listener, so it was silently dropped by EventEmitter2. Same
  // per-admin fan-out as handleNewReport.
  @OnEvent(NotificationEventEnum.HIGH_PRIORITY_REPORT)
  async handleHighPriorityReport(event: HighPriorityReportEvent) {
    await this.notificationService.createForAdmins({
      type: NotificationType.HIGH_PRIORITY_REPORT,
      title: 'High Priority Report',
      body: `Report ${event.caseReference} has been escalated and needs urgent attention.`,
    });
  }

  // NEW — was previously emitted by ReportService.assign() with no
  // listener, so it was silently dropped by EventEmitter2. Goes to
  // the one assigned admin, so a personal notification is enough —
  // no admin fan-out needed here.
  @OnEvent(NotificationEventEnum.REPORT_ASSIGNED)
  async handleReportAssigned(event: ReportAssignedEvent) {
    await this.notificationService.create({
      userId: event.assignedToUserId,
      type: NotificationType.REPORT_ASSIGNED,
      title: 'Report Assigned to You',
      body: `Report ${event.caseReference} has been assigned to you.`,
    });
  }

  // NEW — was previously emitted by
  // ReportService.respondToInformationRequest() with no listener, so
  // it was silently dropped by EventEmitter2. Goes to the specific
  // admin who requested the information.
  @OnEvent(NotificationEventEnum.INFORMATION_REQUEST_RESPONDED)
  async handleInformationRequestResponded(event: InformationRequestRespondedEvent) {
    await this.notificationService.create({
      userId: event.requestedById,
      type: NotificationType.INFORMATION_REQUEST_RESPONDED,
      title: 'Information Request Responded',
      body: `The reporter responded to your information request on report ${event.caseReference}.`,
    });
  }

  // NEW — was previously emitted by PostService.createOfficial() and
  // PostService.submitMyPost() with no listener, so it was silently
  // dropped by EventEmitter2. Admin-facing (a post needs review), so
  // fanned out per-admin like handleNewReport — not a broadcast.
  @OnEvent(NotificationEventEnum.NEW_POST)
  async handleNewPost(event: NewPostEvent) {
    await this.notificationService.createForAdmins({
      type: NotificationType.NEW_POST,
      title: 'New Post Submitted',
      body: 'A new post has been submitted and needs review.',
    });
  }

  @OnEvent(NotificationEventEnum.POST_APPROVED)
  async handlePostApproved(event: PostApprovedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.POST_APPROVED,
      title: 'Post Approved',
      body: event.title
        ? `Your post "${event.title}" has been approved.`
        : 'Your post has been approved.',
    });
  }

  @OnEvent(NotificationEventEnum.POST_REJECTED)
  async handlePostRejected(event: PostRejectedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.POST_REJECTED,
      title: 'Post Rejected',
      body: event.title
        ? `Your post "${event.title}" has been rejected.`
        : 'Your post has been rejected.',
    });
  }

  // NEW — was previously emitted by PostService.requestChanges() with
  // no listener, so it was silently dropped by EventEmitter2. Goes to
  // the post's owner.
  @OnEvent(NotificationEventEnum.POST_CHANGES_REQUESTED)
  async handlePostChangesRequested(event: PostChangesRequestedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.POST_CHANGES_REQUESTED,
      title: 'Changes Requested on Your Post',
      body: `Changes have been requested on your post: ${event.message}`,
    });
  }

  // NEW — was previously emitted by PostService.unpublish() with no
  // listener, so it was silently dropped by EventEmitter2. Goes to
  // the post's owner.
  @OnEvent(NotificationEventEnum.POST_UNPUBLISHED)
  async handlePostUnpublished(event: PostUnpublishedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.POST_UNPUBLISHED,
      title: 'Post Unpublished',
      body: 'Your post has been unpublished and is no longer visible to the public.',
    });
  }

  @OnEvent(NotificationEventEnum.MISSING_PERSON_UPDATED)
  async handleMissingPersonUpdated(event: MissingPersonRequestUpdatedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.MISSING_PERSON_UPDATED,
      title: 'Missing Person Case Updated',
      body: `The missing person case has been updated. Status: ${event.status}.`,
    });
  }

  // NEW — was previously emitted by MissingPersonService.create()
  // with no listener, so it was silently dropped by EventEmitter2.
  // Mirrors handleNewReport/handleNewPost: a brand-new case needs
  // admin review, so this fans out to every ADMIN/SUPER_ADMIN via
  // createForAdmins rather than notifying the submitter (the
  // submitter already gets their own confirmation via the
  // REPORT_RECEIVED-style flow, if/when one exists for this module).
  // NOTE: MissingPersonService currently emits this event with a
  // `userId: user.id` field in the payload (the submitter's id) —
  // that field is unused here on purpose, since this event is an
  // admin broadcast, not a personal notification. Consider dropping
  // `userId` from the emit call for clarity.
  @OnEvent(NotificationEventEnum.NEW_MISSING_PERSON_REQUEST)
  async handleNewMissingPersonRequest(event: NewMissingPersonRequestEvent) {
    await this.notificationService.createForAdmins({
      type: NotificationType.NEW_MISSING_PERSON_REQUEST,
      title: 'New Missing Person Case Submitted',
      body: 'A new missing person case has been submitted and needs review.',
    });
  }

  // NEW — was previously emitted by
  // MissingPersonService.updateStatus() with no listener, so it was
  // silently dropped by EventEmitter2. Goes to the case's submitter.
  @OnEvent(NotificationEventEnum.MISSING_PERSON_APPROVED)
  async handleMissingPersonApproved(event: MissingPersonApprovedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.MISSING_PERSON_APPROVED,
      title: 'Missing Person Case Approved',
      body: 'Your missing person case has been reviewed and approved. It is now publicly visible.',
    });
  }

  // NEW — was previously emitted by
  // MissingPersonService.updateStatus() with no listener, so it was
  // silently dropped by EventEmitter2. Goes to the case's submitter;
  // includes the admin's reviewNote so the submitter knows why.
  @OnEvent(NotificationEventEnum.MISSING_PERSON_REJECTED)
  async handleMissingPersonRejected(event: MissingPersonRejectedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.MISSING_PERSON_REJECTED,
      title: 'Missing Person Case Rejected',
      body: event.reviewNote
        ? `Your missing person case was rejected: ${event.reviewNote}`
        : 'Your missing person case was rejected.',
    });
  }

  // NEW — was previously emitted by
  // MissingPersonService.updateStatus() with no listener, so it was
  // silently dropped by EventEmitter2. Goes to the case's submitter.
  @OnEvent(NotificationEventEnum.MISSING_PERSON_FOUND)
  async handleMissingPersonFound(event: MissingPersonFoundEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.MISSING_PERSON_FOUND,
      title: 'Missing Person Found',
      body: 'Great news — the missing person case has been marked as found.',
    });
  }

  // NEW — was previously emitted by
  // MissingPersonService.updateStatus() with no listener, so it was
  // silently dropped by EventEmitter2. Goes to the case's submitter;
  // includes the admin's reviewNote so the submitter knows what's
  // needed.
  @OnEvent(NotificationEventEnum.MISSING_PERSON_MORE_INFORMATION_REQUESTED)
  async handleMissingPersonMoreInformationRequested(
    event: MissingPersonMoreInformationRequestedEvent,
  ) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.MISSING_PERSON_MORE_INFORMATION_REQUESTED,
      title: 'More Information Requested',
      body: event.reviewNote
        ? `Additional information has been requested for your missing person case: ${event.reviewNote}`
        : 'Additional information has been requested for your missing person case.',
    });
  }

  @OnEvent(NotificationEventEnum.SUPPORT_PAYMENT_CONFIRMED)
  async handleSupportPaymentConfirmed(event: SupportPaymentConfirmedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.SUPPORT_PAYMENT_CONFIRMED,
      title: 'Support Payment Confirmed',
      body:
        event.amount !== undefined
          ? `Your support payment of ${event.amount} ETB has been confirmed.`
          : 'Your support payment has been confirmed.',
    });
  }

  // ─────────────────────────────────────────────
  // INFORMATION SUBMISSION
  //
  // NEW — InformationSubmissionService.review() already emitted
  // these two events correctly (via a dynamic reference to the
  // shared NotificationEventEnum, not a raw string), but neither had
  // a matching @OnEvent() handler here, so EventEmitter2 silently
  // dropped both — a submitter was never told their tip was reviewed
  // or rejected. Same failure mode as the VictimProfile gap, just
  // one call site instead of eighteen.
  //
  // Recipient: event.userId is InformationSubmission.userId (the
  // submitter), sent directly by review() — no null-check needed
  // here since userId is required on that model, unlike
  // VictimProfile.createdByUserId.
  // ─────────────────────────────────────────────

  @OnEvent(NotificationEventEnum.INFORMATION_SUBMISSION_REVIEWED)
  async handleInformationSubmissionReviewed(event: InformationSubmissionReviewedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.INFORMATION_SUBMISSION_REVIEWED,
      title: 'Information Submission Reviewed',
      body: 'Your submitted information has been reviewed and accepted.',
    });
  }

  @OnEvent(NotificationEventEnum.INFORMATION_SUBMISSION_REJECTED)
  async handleInformationSubmissionRejected(event: InformationSubmissionRejectedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.INFORMATION_SUBMISSION_REJECTED,
      title: 'Information Submission Rejected',
      body: event.reviewNote
        ? `Your submitted information was rejected: ${event.reviewNote}`
        : 'Your submitted information was rejected.',
    });
  }

  // ─────────────────────────────────────────────
  // VICTIM PROFILE
  //
  // NEW — VictimProfileService previously emitted
  // 'notification.victim_profile.X' string literals with no matching
  // enum member, event interface, or listener at all, so
  // EventEmitter2 silently dropped every one of them. These 11 cover
  // every VictimProfile action that had a paired notification emit
  // call in the original code.
  //
  // Recipient: event.userId is VictimProfile.createdByUserId,
  // resolved by the service before emitting. Every handler below
  // skips sending a notification when it's missing, since
  // VictimProfile has no required submitter/owner relation the way
  // Report/Post/MissingPerson do. Revisit this recipient choice if
  // the intended audience is actually "all admins" for some of these
  // (e.g. gates-updated, child-safety-reviewed) rather than the
  // creating admin.
  //
  // NOTE: NotificationType (prisma enum) needs a VICTIM_PROFILE_*
  // member added for each of these 11 — run
  // `npx prisma migrate dev` (or `db push` + `generate` for a
  // shared/prod DB) after adding them, same as the original
  // NotificationType hardening comment for the Report/Post values.
  // ─────────────────────────────────────────────

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_CREATED)
  async handleVictimProfileCreated(event: VictimProfileCreatedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_CREATED,
      title: 'Victim Profile Created',
      body: 'A victim profile you created is now pending review.',
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_UPDATED)
  async handleVictimProfileUpdated(event: VictimProfileUpdatedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_UPDATED,
      title: 'Victim Profile Updated',
      body: 'A victim profile you created was updated and is now pending re-review.',
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_DELETED)
  async handleVictimProfileDeleted(event: VictimProfileDeletedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_DELETED,
      title: 'Victim Profile Deleted',
      body: 'A victim profile you created has been deleted.',
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_GATES_UPDATED)
  async handleVictimProfileGatesUpdated(event: VictimProfileGatesUpdatedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_GATES_UPDATED,
      title: 'Victim Profile Review Updated',
      body: `The review status of a victim profile you created has changed. Status: ${event.status}.`,
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED)
  async handleVictimProfileChildSafetyReviewed(event: VictimProfileChildSafetyReviewedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_CHILD_SAFETY_REVIEWED,
      title: 'Victim Profile Child-Safety Review Updated',
      body: `The child-safety review status of a victim profile you created has changed. Status: ${event.status}.`,
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_CONSENT_REVOKED)
  async handleVictimProfileConsentRevoked(event: VictimProfileConsentRevokedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_CONSENT_REVOKED,
      title: 'Victim Profile Consent Revoked',
      body: 'Consent on a victim profile you created has been revoked.',
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_BANK_DETAILS_UPDATED)
  async handleVictimProfileBankDetailsUpdated(event: VictimProfileBankDetailsUpdatedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_BANK_DETAILS_UPDATED,
      title: 'Victim Profile Bank Details Updated',
      body: event.reapprovalRequired
        ? 'Bank details were updated on a victim profile you created — it now requires re-approval.'
        : 'Bank details were updated on a victim profile you created.',
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_PUBLISHED)
  async handleVictimProfilePublished(event: VictimProfilePublishedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_PUBLISHED,
      title: 'Victim Profile Published',
      body: 'A victim profile you created has been published and is now publicly visible.',
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_UNPUBLISHED)
  async handleVictimProfileUnpublished(event: VictimProfileUnpublishedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_UNPUBLISHED,
      title: 'Victim Profile Unpublished',
      body: 'A victim profile you created has been unpublished and is no longer visible to the public.',
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_REJECTED)
  async handleVictimProfileRejected(event: VictimProfileRejectedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_REJECTED,
      title: 'Victim Profile Rejected',
      body: 'A victim profile you created has been rejected.',
    });
  }

  @OnEvent(NotificationEventEnum.VICTIM_PROFILE_RESUBMITTED)
  async handleVictimProfileResubmitted(event: VictimProfileResubmittedEvent) {
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.VICTIM_PROFILE_RESUBMITTED,
      title: 'Victim Profile Resubmitted',
      body: `A victim profile you created has been resubmitted for review. Status: ${event.status}.`,
    });
  }

  // ─────────────────────────────────────────────
  // UNCONFIRMED — NO KNOWN EMIT SITE
  //
  // TODO: confirm emit site. NEW_MISSING_PERSON_INFORMATION and
  // SECURITY_ALERT both exist in NotificationEventEnum and
  // NotificationType, but no emit call for either was found across
  // report/post/missing-person/information-submission/victim-profile/
  // user/auth/admin-auth/permission/role/support services. These
  // handlers exist purely so the enum values aren't orphaned at the
  // listener level and so a real emit call — if one exists in an
  // unreviewed module — has somewhere to land instead of silently
  // dropping. The payload shape and recipient logic below are
  // best-guess (see notification.events.ts) and MUST be revisited
  // once the actual emit site is located; do not treat this as a
  // confirmed, production-ready implementation.
  // ─────────────────────────────────────────────

  @OnEvent(NotificationEventEnum.NEW_MISSING_PERSON_INFORMATION)
  async handleNewMissingPersonInformation(event: NewMissingPersonInformationEvent) {
    // Best guess: mirrors handleNewReport/handleNewPost/
    // handleNewMissingPersonRequest — admin-facing "needs review"
    // broadcast, not a personal notification. Revisit if the real
    // emit site targets a specific user instead.
    await this.notificationService.createForAdmins({
      type: NotificationType.NEW_MISSING_PERSON_INFORMATION,
      title: 'New Information Submitted',
      body: 'New information has been submitted on a missing person case and needs review.',
    });
  }

  @OnEvent(NotificationEventEnum.SECURITY_ALERT)
  async handleSecurityAlert(event: SecurityAlertEvent) {
    // Best guess: per-user alert when userId is present, otherwise
    // silently no-ops rather than guessing at an admin broadcast —
    // revisit once the real emit site clarifies who should receive
    // this.
    if (!event.userId) return;
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.SECURITY_ALERT,
      title: 'Security Alert',
      body: event.reason
        ? `A security event was detected on your account: ${event.reason}`
        : 'A security event was detected on your account.',
    });
  }

  // Fired by AuthService.changePasswordVerify() and
  // AdminAuthService.adminChangePasswordVerify() — the "I know my password, I'm
  // changing it" flows, for both USER and ADMIN accounts. Previously emitted with no
  // listener, so it was silently dropped by EventEmitter2.
  @OnEvent(NotificationEventEnum.PASSWORD_CHANGED)
  async handlePasswordChanged(event: PasswordChangedEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.PASSWORD_CHANGED,
      title: 'Password Changed',
      body: "Your password was changed successfully. If this wasn't you, contact support immediately.",
    });
  }

  // Fired by AuthService.resetPassword() and AdminAuthService.adminResetPassword() —
  // the "I forgot my password entirely" flows, for both USER and ADMIN accounts.
  // Previously emitted with no listener, so it was silently dropped by EventEmitter2.
  @OnEvent(NotificationEventEnum.PASSWORD_RESET)
  async handlePasswordReset(event: PasswordResetEvent) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.PASSWORD_RESET,
      title: 'Password Reset',
      body: "Your password was reset successfully. If this wasn't you, contact support immediately.",
    });
  }
}