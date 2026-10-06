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
  account_reactivation: 'account reactivation code',
};

// Sign-in messages must not name the app: a stranger could read them on a lock screen
// (discreet mode). Only login_2fa is listed; every other purpose keeps the app name.
const DISCREET_PURPOSES: UserOtpPurposeEnum[] = [UserOtpPurposeEnum.login_2fa];

export function renderOtpSms(params: SmsOtpTemplateParams): string {
  const appName = process.env.APP_NAME || 'Ehte';
  const label = (params.purpose && PURPOSE_LABELS[params.purpose]) || 'verification code';
  const discreet = params.purpose ? DISCREET_PURPOSES.includes(params.purpose) : false;
  const subject = discreet ? `Your ${label}` : `Your ${appName} ${label}`;

  return `${subject} is ${params.otp}. It expires in ${params.expiresInMinutes} minutes. Never share this code. If you didn't request it, ignore this message.`;
}