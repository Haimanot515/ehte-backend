import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as admin from 'firebase-admin';

export interface FcmSendResult {
  success: number;
  failed: number;
  invalidTokens: string[];
}

const FCM_BATCH_LIMIT = 500;

@Injectable()
export class FirebaseService implements OnModuleInit {
  private readonly logger = new Logger(FirebaseService.name);
  private initialized = false;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    if (this.initialized || admin.apps.length) {
      this.initialized = true;
      return;
    }

    const projectId = this.config.get<string>('firebase.projectId');
    const clientEmail = this.config.get<string>('firebase.clientEmail');
    const privateKeyRaw = this.config.get<string>('firebase.privateKey');

    if (!projectId || !clientEmail || !privateKeyRaw) {
      this.logger.warn(
        `[FCM] Firebase not configured — projectId=${projectId ? 'set' : 'MISSING'}, ` +
          `clientEmail=${clientEmail ? 'set' : 'MISSING'}, ` +
          `privateKey=${privateKeyRaw ? 'set' : 'MISSING'}. PUSH delivery is disabled.`,
      );
      return;
    }

    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId,
          clientEmail,
          // Already unescaped in configuration.ts — used as-is here.
          privateKey: privateKeyRaw,
        }),
      });
      this.initialized = true;
      this.logger.log(`[FCM] Firebase Admin initialized — project: ${projectId}`);
    } catch (error) {
      this.logger.error(
        '[FCM] Firebase Admin initialization threw',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }

  isReady(): boolean {
    return this.initialized;
  }

  // Chunks tokens into FCM_BATCH_LIMIT-sized calls automatically.
  // Never logs title/body — only lengths and counts.
  async sendNotification(
    tokens: string[],
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<FcmSendResult> {
    if (!this.initialized) {
      this.logger.error('[FCM] sendNotification called before Firebase was initialized');
      return { success: 0, failed: tokens.length, invalidTokens: [] };
    }
    if (!tokens.length) {
      return { success: 0, failed: 0, invalidTokens: [] };
    }

    const chunks = this.chunk(tokens, FCM_BATCH_LIMIT);
    let success = 0;
    let failed = 0;
    const invalidTokens: string[] = [];

    for (const chunk of chunks) {
      try {
        const response = await admin.messaging().sendEachForMulticast({
          notification: { title, body },
          tokens: chunk,
          data,
        });

        success += response.successCount;
        failed += response.failureCount;

        response.responses.forEach((r, i) => {
          if (r.success) return;
          const code = r.error?.code ?? 'unknown';
          this.logger.warn(`[FCM] Token failed — code: ${code}`);
          if (this.isInvalidTokenError(code)) {
            invalidTokens.push(chunk[i]);
          }
        });
      } catch (error) {
        failed += chunk.length;
        this.logger.error(
          `[FCM] sendNotification chunk threw (size ${chunk.length})`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    this.logger.log(
      `[FCM] sendNotification result — success: ${success}, failed: ${failed}, invalid: ${invalidTokens.length}`,
    );

    return { success, failed, invalidTokens };
  }

  async sendTopicNotification(
    topic: string,
    title: string,
    body: string,
    data?: Record<string, string>,
  ): Promise<{ success: boolean; messageId?: string }> {
    if (!this.initialized) {
      this.logger.error('[FCM] sendTopicNotification called before Firebase was initialized');
      return { success: false };
    }

    try {
      const messageId = await admin.messaging().send({
        notification: { title, body },
        topic,
        data,
      });
      return { success: true, messageId };
    } catch (error) {
      this.logger.error(
        `[FCM] sendTopicNotification failed — topic: "${topic}"`,
        error instanceof Error ? error.stack : String(error),
      );
      return { success: false };
    }
  }

  private isInvalidTokenError(code?: string): boolean {
    return (
      code === 'messaging/registration-token-not-registered' ||
      code === 'messaging/invalid-registration-token' ||
      code === 'messaging/invalid-argument'
    );
  }

  private chunk<T>(arr: T[], size: number): T[][] {
    return Array.from({ length: Math.ceil(arr.length / size) }, (_, i) =>
      arr.slice(i * size, i * size + size),
    );
  }
}