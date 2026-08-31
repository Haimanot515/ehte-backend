
import { Injectable } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { NotificationType } from '@prisma/client';

import { NotificationService } from '../service/notification.service';

import {
  NotificationEventEnum,
} from 'src/common/enums/shared/notification-events.enum';

import {
  ReportReceivedEvent,
  ReportUpdatedEvent,
  ReportMoreInformationRequestedEvent,
  PostApprovedEvent,
  PostRejectedEvent,
  MissingPersonRequestUpdatedEvent,
  SupportPaymentConfirmedEvent,
} from '../events/notification.events';

@Injectable()
export class NotificationListener {
  constructor(
    private readonly notificationService: NotificationService,
  ) {}

  @OnEvent(NotificationEventEnum.REPORT_RECEIVED)
  async handleReportReceived(
    event: ReportReceivedEvent,
  ) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.REPORT_RECEIVED,
      title: 'Report Received',
      body: `Your report ${event.caseReference} has been received successfully.`,
    });
  }

  @OnEvent(NotificationEventEnum.REPORT_UPDATED)
  async handleReportUpdated(
    event: ReportUpdatedEvent,
  ) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.REPORT_UPDATED,
      title: 'Report Updated',
      body: `Your report ${event.caseReference} has been updated. Status: ${event.status}.`,
    });
  }

  @OnEvent(
    NotificationEventEnum.MORE_INFORMATION_REQUESTED,
  )
  async handleMoreInformationRequested(
    event: ReportMoreInformationRequestedEvent,
  ) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.MORE_INFORMATION_REQUESTED,
      title: 'More Information Requested',
      body: `Additional information has been requested for report ${event.caseReference}.`,
    });
  }

  @OnEvent(NotificationEventEnum.POST_APPROVED)
  async handlePostApproved(
    event: PostApprovedEvent,
  ) {
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
  async handlePostRejected(
    event: PostRejectedEvent,
  ) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.POST_REJECTED,
      title: 'Post Rejected',
      body: event.title
        ? `Your post "${event.title}" has been rejected.`
        : 'Your post has been rejected.',
    });
  }

  @OnEvent(
    NotificationEventEnum.MISSING_PERSON_UPDATED,
  )
  async handleMissingPersonUpdated(
    event: MissingPersonRequestUpdatedEvent,
  ) {
    await this.notificationService.create({
      userId: event.userId,
      type: NotificationType.MISSING_PERSON_UPDATED,
      title: 'Missing Person Case Updated',
      body: `The missing person case has been updated. Status: ${event.status}.`,
    });
  }

  @OnEvent(
    NotificationEventEnum.SUPPORT_PAYMENT_CONFIRMED,
  )
  async handleSupportPaymentConfirmed(
    event: SupportPaymentConfirmedEvent,
  ) {
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
}
