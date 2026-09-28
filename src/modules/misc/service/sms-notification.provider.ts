import { Injectable, Logger } from '@nestjs/common';

import { SendetService } from 'src/services/sms/sendet.service';

import {
  NotificationChannelMessage,
  NotificationChannelProvider,
  NotificationOutboundChannel,
} from './notification-channel.provider';

// Two-segment budget: keeps a typical SMS to one or two parts.
const SMS_MAX_LENGTH = 300;

@Injectable()
export class SmsNotificationProvider implements NotificationChannelProvider {
  readonly channel: NotificationOutboundChannel = 'SMS';

  private readonly logger = new Logger(SmsNotificationProvider.name);

  constructor(private readonly sendet: SendetService) {}

  async send(params: NotificationChannelMessage): Promise<void> {
    const to = params.to.phone;
    if (!to) {
      throw new Error('no_phone_number');
    }

    const message = this.buildMessage(params);
    const result = await this.sendet.sendSms(to, message);

    if (!result.success) {
      throw new Error(result.message ?? 'sendet_send_failed');
    }
  }

  // actionUrl left out of SMS: a deep link over SMS is a bigger
  // discreet-mode/leak risk than over push or email.
  private buildMessage(params: NotificationChannelMessage): string {
    const combined = `${params.title}: ${params.body}`;
    return combined.length > SMS_MAX_LENGTH
      ? `${combined.slice(0, SMS_MAX_LENGTH - 1)}…`
      : combined;
  }
}
