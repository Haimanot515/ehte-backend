import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserOtpPurposeEnum, OtpChannelEnum, Prisma } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';

import { PrismaService } from 'src/prisma/prisma.service';
import { CacheService } from 'src/infrastructure/redis/cache.service'; // REDIS

import { sendSms } from 'src/infrastructure/sms/sendet.service';
import { renderOtpSms } from 'src/infrastructure/sms/templates/sms-otp.template';

import { EmailService } from 'src/infrastructure/email/email.service';
import { EmailTemplateService } from 'src/infrastructure/email/email-template.service';
import {
  renderOtpEmailSubject,
  renderOtpEmailHtml,
} from 'src/infrastructure/email/templates/otp-email.template';

type OtpDb = Pick<Prisma.TransactionClient, 'userOtp'>;

@Injectable()
export class OtpUtil {
  private readonly logger = new Logger(OtpUtil.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
    private readonly emailService: EmailService,
    private readonly emailTemplates: EmailTemplateService,
    private readonly cache: CacheService, // REDIS
  ) {}

  async issueAndSendOtp(
    userId: string,
    contact: string,
    purpose: UserOtpPurposeEnum,
    channel: OtpChannelEnum = OtpChannelEnum.sms,
    // adminEmail: use the admin-only password email (reset/change) instead of the generic OTP email.
    options: { adminEmail?: boolean; recipientName?: string } = {},
  ): Promise<{ verificationId: string }> {
    const cooldownSeconds = this.configService.get<number>('otp.resendCooldownSeconds', 60);
    const otpExpiresInMinutes = this.configService.get<number>('otp.expiresInMinutes', 10);

    const cachedId = await this.cache.getOtpCooldown(userId, purpose, channel);
    if (cachedId) {
      return { verificationId: cachedId };
    }

    const cooling = await this.findCooldownOtp(
      this.prisma,
      userId,
      purpose,
      channel,
      cooldownSeconds,
    );

    if (cooling) {
      await this.cache.setOtpCooldown(userId, purpose, channel, cooling.id, cooldownSeconds);
      return { verificationId: cooling.id };
    }

    const otp = this.generateOtp();
    const otpHash = await bcrypt.hash(otp, 12);

    // Re-checked inside the transaction to cover concurrent requests.
    const result = await this.prisma.$transaction(async (tx) => {
      const active = await this.findCooldownOtp(tx, userId, purpose, channel, cooldownSeconds);

      if (active) {
        return { reused: true as const, verificationId: active.id };
      }

      await tx.userOtp.updateMany({
        where: { userId, purpose, channel, usedAt: null },
        data: { usedAt: new Date() },
      });

      const created = await tx.userOtp.create({
        data: {
          userId,
          otpHash,
          expiresAt: new Date(Date.now() + otpExpiresInMinutes * 60 * 1000),
          purpose,
          channel,
        },
      });

      return { reused: false as const, verificationId: created.id };
    });

    // REDIS: cache the cooldown regardless of which branch created it, so the NEXT repeat
    // tap (not this one) hits the fast path above instead of Postgres.
    await this.cache.setOtpCooldown(
      userId,
      purpose,
      channel,
      result.verificationId,
      cooldownSeconds,
    );

    if (result.reused) {
      return { verificationId: result.verificationId };
    }

    const maskedContact = this.maskContact(contact);

    if (channel === OtpChannelEnum.email) {
      try {
        const adminPurpose =
          options.adminEmail &&
          (purpose === UserOtpPurposeEnum.password_reset ||
            purpose === UserOtpPurposeEnum.password_change)
            ? purpose
            : null;

        if (adminPurpose) {
          const params = {
            purpose: adminPurpose,
            otp,
            expiresInMinutes: otpExpiresInMinutes,
            recipientName: options.recipientName,
          };
          await this.emailService.send(
            contact,
            this.emailTemplates.adminPasswordOtpSubject(adminPurpose),
            this.emailTemplates.adminPasswordOtpHtml(params),
            this.emailTemplates.adminPasswordOtpText(params),
          );
        } else {
          await this.emailService.send(
            contact,
            renderOtpEmailSubject(),
            renderOtpEmailHtml({ otp, expiresInMinutes: otpExpiresInMinutes }),
          );
        }
      } catch (error) {
        this.logger.error(
          `Failed to send OTP (${purpose}) to ${maskedContact}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    } else {
      const smsMessage = renderOtpSms({ otp, expiresInMinutes: otpExpiresInMinutes, purpose });

      try {
        await sendSms(contact, smsMessage);
      } catch (error) {
        this.logger.error(
          `Failed to send OTP (${purpose}) to ${maskedContact}`,
          error instanceof Error ? error.stack : String(error),
        );
      }
    }

    // Local development only; requires both NODE_ENV and the debug flag.
    if (
      process.env.NODE_ENV === 'development' &&
      this.configService.get<boolean>('app.debug', false)
    ) {
      this.logger.debug(`OTP (${purpose}, ${channel}) for ${maskedContact}: ${otp}`);
    }

    return { verificationId: result.verificationId };
  }

  generateOtp(): string {
    return randomInt(100000, 1000000).toString();
  }

  private async findCooldownOtp(
    db: OtpDb,
    userId: string,
    purpose: UserOtpPurposeEnum,
    channel: OtpChannelEnum,
    cooldownSeconds: number,
  ) {
    const latest = await db.userOtp.findFirst({
      where: { userId, purpose, channel },
      orderBy: { createdAt: 'desc' },
    });

    const active =
      !!latest &&
      !latest.usedAt &&
      Date.now() - latest.createdAt.getTime() < cooldownSeconds * 1000;

    return active ? latest : null;
  }

  private maskContact(contact: string): string {
    if (contact.includes('@')) {
      const [local, domain] = contact.split('@');
      return `${local.slice(0, 1)}***@${domain}`;
    }

    return contact.length <= 4 ? '****' : `${'*'.repeat(contact.length - 4)}${contact.slice(-4)}`;
  }
}