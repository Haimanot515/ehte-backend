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