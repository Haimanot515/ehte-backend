
import { OtpTemplateParams } from 'src/common/types/messages.type';

export function renderOtpSms(params: OtpTemplateParams): string {
  const appName = process.env.APP_NAME || 'Ehte';

  const message = `Your ${appName} OTP code is ${params.otp}. It expires in ${params.expiresInMinutes} minutes. If you didn't request this, please ignore this message.`;

  return message;
}
