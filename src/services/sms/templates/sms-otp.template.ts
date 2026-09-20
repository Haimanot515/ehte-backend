import { UserOtpPurposeEnum } from '@prisma/client';

import { OtpTemplateParams } from 'src/common/types/messages.type';

export type SmsOtpTemplateParams = OtpTemplateParams & {
  purpose?: UserOtpPurposeEnum;
};

// SMS purposes only; email-only purposes fall back to the generic label.
const PURPOSE_LABELS: Partial<Record<UserOtpPurposeEnum, string>> = {
  phone_verification: 'verification code',
  password_reset: 'password reset code',
  password_change: 'password change code',
  phone_change: 'phone number change code',
  login_2fa: 'login code',
};

export function renderOtpSms(params: SmsOtpTemplateParams): string {
  const appName = process.env.APP_NAME || 'Ehte';
  const label = (params.purpose && PURPOSE_LABELS[params.purpose]) || 'verification code';

  return `Your ${appName} ${label} is ${params.otp}. It expires in ${params.expiresInMinutes} minutes. Never share this code. If you didn't request it, ignore this message.`;
}