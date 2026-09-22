import { Injectable, Logger } from '@nestjs/common';

import { EmailService } from 'src/services/email/email.service';

import {
  NotificationChannelMessage,
  NotificationChannelProvider,
  NotificationOutboundChannel,
} from './notification-channel.provider';

// Wraps EmailService for the EMAIL outbound channel. Title/body arrive
// already discreet-transformed by dispatchOne — sent through as-is.
@Injectable()
export class EmailNotificationProvider implements NotificationChannelProvider {
  readonly channel: NotificationOutboundChannel = 'EMAIL';

  private readonly logger = new Logger(EmailNotificationProvider.name);

  constructor(private readonly email: EmailService) {}

  async send(params: NotificationChannelMessage): Promise<void> {
    const to = params.to.email;
    if (!to) {
      throw new Error('no_email_address');
    }

    const html = this.renderHtml(params);
    const text = params.actionUrl ? `${params.body}\n\n${params.actionUrl}` : params.body;

    await this.email.sendEmail(to, params.title, html, text);
  }

  // Minimal inline template — no external assets or tracking pixels, both
  // of which would defeat discreet mode by revealing content in previews.
  private renderHtml(params: NotificationChannelMessage): string {
    const bodyHtml = this.escapeHtml(params.body);
    const link = params.actionUrl
      ? `<p><a href="${this.escapeHtml(params.actionUrl)}">Open in Ehte</a></p>`
      : '';

    return `<div><p>${bodyHtml}</p>${link}</div>`;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}