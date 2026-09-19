/**
 * Outside-channel dispatch contract.
 *
 * Put this file at: src/modules/misc/service/notification-channel.provider.ts
 *
 * NotificationService never talks to an email, SMS or push vendor directly.
 * Each channel is a small provider that implements this interface. A provider
 * is registered under NOTIFICATION_CHANNEL_PROVIDERS (see misc.module.ts notes).
 *
 * A channel with no provider is simply never planned: no delivery rows are
 * created for it, so nothing is stuck waiting.
 *
 * DISCREET MODE is already applied before send() is called. When
 * `message.discreet` is true the title and body are generic and `actionUrl`
 * is null. A provider must send exactly what it receives and must not add
 * anything that reveals the event (no entity names, no deep links).
 *
 * send() must throw on failure. The service retries with backoff and marks
 * the delivery FAILED after the last attempt. Do not put phone numbers or
 * email addresses in error messages (they are also redacted before storing).
 */

export const NOTIFICATION_CHANNEL_PROVIDERS = Symbol('NOTIFICATION_CHANNEL_PROVIDERS');

export type NotificationOutboundChannel = 'EMAIL' | 'SMS' | 'PUSH';

export interface NotificationChannelMessage {
  deliveryId: string;
  userId: string;
  type: string;
  priority: string;
  title: string;
  body: string;
  actionUrl: string | null;
  /** true = generic text, nothing about the event is included. */
  discreet: boolean;
  to: {
    email?: string;
    phone?: string;
    /** PUSH only: every registered device token of the user. */
    deviceTokens?: string[];
  };
}

export interface NotificationChannelProvider {
  readonly channel: NotificationOutboundChannel;
  send(message: NotificationChannelMessage): Promise<void>;
}