import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UserOtpPurposeEnum, OtpChannelEnum } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { randomInt } from 'crypto';

import { PrismaService } from 'src/prisma/prisma.service';

import { sendSms } from 'src/services/sms/afro-message.service';
import { renderOtpSms } from 'src/services/sms/templates/sms-otp.template';

import { sendEmail } from 'src/services/email/email.service';
import {
  renderOtpEmailSubject,
  renderOtpEmailHtml,
} from 'src/services/email/templates/otp-email.template';

// Extracted from AuthService: shared OTP issue/send logic used by signup, login,
// forgot-password (user + admin), and every resend endpoint.

@Injectable()
export class OtpUtil {
  constructor(
    private readonly prisma: PrismaService,
    private readonly configService: ConfigService,
  ) {}

  // Invalidates prior unused OTP of this purpose, creates a new one, sends via the channel.
  async issueAndSendOtp(
    userId: string,
    contact: string,
    purpose: UserOtpPurposeEnum,
    channel: OtpChannelEnum = OtpChannelEnum.sms,
  ): Promise<{ verificationId: string }> {
    const cooldownSeconds = this.configService.get<number>('otp.resendCooldownSeconds', 60);

    const otpExpiresInMinutes = this.configService.get<number>('otp.expiresInMinutes', 10);

    const otp = this.generateOtp();
    const otpHash = await bcrypt.hash(otp, 12);

    // Cooldown check + create/invalidate wrapped in one transaction.
    const result = await this.prisma.$transaction(async (tx) => {
      // Scoped to channel too, so SMS and email OTPs don't share one cooldown window.
      const latestOtp = await tx.userOtp.findFirst({
        where: { userId, purpose, channel },
        orderBy: { createdAt: 'desc' },
      });

      const cooldownActive =
        !!latestOtp &&
        !latestOtp.usedAt &&
        Date.now() - latestOtp.createdAt.getTime() < cooldownSeconds * 1000;

      if (cooldownActive) {
        // Reuse existing OTP/verificationId; nothing regenerated, no message sent
        return { reused: true as const, verificationId: latestOtp.id };
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

    if (result.reused) {
      // Cooldown active: no message, no dev log
      return { verificationId: result.verificationId };
    }

    if (channel === OtpChannelEnum.email) {
      try {
        await sendEmail(
          contact,
          renderOtpEmailSubject(),
          renderOtpEmailHtml({ otp, expiresInMinutes: otpExpiresInMinutes }),
        );
      } catch (error) {
        console.error(`[EHTE EMAIL] Failed to send OTP (${purpose}) to ${contact}`, error);
      }
    } else {
      const smsMessage = renderOtpSms({ otp, expiresInMinutes: otpExpiresInMinutes });

      try {
        await sendSms(contact, smsMessage);
      } catch (error) {
        console.error(`[EHTE SMS] Failed to send OTP (${purpose}) to ${contact}`, error);
      }
    }

    // DEV ONLY
    if (this.configService.get<boolean>('app.debug', false)) {
      console.log(`[EHTE DEV] OTP (${purpose}, ${channel}) for ${contact}: ${otp}`);
    }

    return { verificationId: result.verificationId };
  }

  // Uses crypto.randomInt (CSPRNG), never Math.random().
  generateOtp(): string {
    return randomInt(100000, 1000000).toString();
  }
}
