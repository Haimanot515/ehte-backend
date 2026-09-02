import { TempPasswordTemplateParams } from 'src/common/types/messages.type';

export function renderTempPasswordSms(params: TempPasswordTemplateParams): string {
  const appName = process.env.APP_NAME || 'Ehte';

  const message = `Your temporary password for ${appName} is ${params.tempPassword}. Please use it to log in and reset your password immediately. If you didn't request this, please ignore this message.`;

  return message;
}
