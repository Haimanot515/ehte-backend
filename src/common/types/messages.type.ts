
import { MessageTypeEnum } from '../enums/shared/message-types.enum';

export type OtpTemplateParams = {
  otp: string;
  expiresInMinutes: number;
  recipientName?: string;
};

export type TempPasswordTemplateParams = {
  tempPassword: string;
};

export type MessagePayloadByType = {
  [MessageTypeEnum.OTP]: OtpTemplateParams;
};
