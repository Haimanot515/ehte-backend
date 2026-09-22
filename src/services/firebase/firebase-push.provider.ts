import { Injectable, Logger } from '@nestjs/common';

import { PrismaService } from 'src/prisma/prisma.service';
import { FirebaseService } from 'src/services/firebase/firebase.service';

import {
  NotificationChannelMessage,
  NotificationChannelProvider,
  NotificationOutboundChannel,
} from './notification-channel.provider';

// Converts a NotificationDelivery send request into an FCM multicast call.
// Title/body arrive already discreet-transformed by dispatchOne.
@Injectable()
export class FirebasePushProvider implements NotificationChannelProvider {
  readonly channel: NotificationOutboundChannel = 'PUSH';

  private readonly logger = new Logger(FirebasePushProvider.name);

  constructor(
    private readonly firebase: FirebaseService,
    private readonly prisma: PrismaService,
  ) {}

  async send(params: NotificationChannelMessage): Promise<void> {
    const tokens = params.to.deviceTokens ?? [];
    if (tokens.length === 0) {
      throw new Error('no_device_tokens');
    }

    // actionUrl is navigation only, never authorization.
    // Omitted entirely in discreet mode, same as the title/body swap.
    const data: Record<string, string> = {
      type: params.type,
      priority: params.priority,
      deliveryId: params.deliveryId,
      discreet: String(params.discreet),
      ...(params.actionUrl ? { actionUrl: params.actionUrl } : {}),
    };

    const result = await this.firebase.sendNotification(tokens, params.title, params.body, data);

    if (result.invalidTokens.length > 0) {
      await this.deactivateTokens(result.invalidTokens);
    }

    // Any failure means nothing was delivered, so throw and let the
    // delivery be recorded as FAILED rather than silently counted as SENT.
    if (result.success === 0) {
      throw new Error(
        result.invalidTokens.length === tokens.length
          ? 'all_device_tokens_invalid'
          : 'fcm_send_failed_for_all_tokens',
      );
    }
  }

  // Best-effort cleanup — a failure here must never fail the delivery.
  private async deactivateTokens(tokens: string[]): Promise<void> {
    try {
      const result = await this.prisma.deviceToken.deleteMany({
        where: { token: { in: tokens } },
      });
      if (result.count > 0) {
        this.logger.log(`[FCM] Deactivated ${result.count} invalid device token(s)`);
      }
    } catch (error) {
      this.logger.error(
        '[FCM] Failed to deactivate invalid device tokens',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}