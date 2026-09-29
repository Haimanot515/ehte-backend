import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  renderOtpEmailSubject,
  renderOtpEmailHtml,
  renderOtpEmailText,
} from './templates/otp-email.template';

import {
  renderAdminRegistrationEmailSubject,
  renderAdminRegistrationEmailHtml,
  renderAdminRegistrationEmailText,
} from './templates/admin-registration-email.template';

import {
  renderPromotionEmailSubject,
  renderPromotionEmailHtml,
} from './templates/promotion-email.template';

import {
  EmailChangeVerificationTemplateParams,
  renderEmailChangeVerificationSubject,
  renderEmailChangeVerificationHtml,
} from './templates/email-change-verification.template';

interface AdminRegistrationParams {
  registrationLink: string;
  expiresInHours: number;
  recipientName?: string;
}

interface PromotionParams {
  promotionLink: string;
  expiresInHours: number;
}

@Injectable()
export class EmailTemplateService {
  private readonly appName: string;
  private readonly appUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.appName = this.configService.get<string>('app.name', 'Ehte');

    this.appUrl = this.configService.get<string>('app.url', 'https://ehte.org');
  }

  getAppName(): string {
    return this.appName;
  }

  getAppUrl(): string {
    return this.appUrl;
  }

  otpSubject(): string {
    return renderOtpEmailSubject();
  }

  otpHtml(otp: string, expiresInMinutes: number): string {
    return renderOtpEmailHtml({
      otp,
      expiresInMinutes,
    });
  }

  otpText(otp: string, expiresInMinutes: number): string {
    return renderOtpEmailText({
      otp,
      expiresInMinutes,
    });
  }

  adminRegistrationSubject(): string {
    return renderAdminRegistrationEmailSubject();
  }

  adminRegistrationHtml(params: AdminRegistrationParams): string {
    return renderAdminRegistrationEmailHtml(params);
  }

  adminRegistrationText(params: AdminRegistrationParams): string {
    return renderAdminRegistrationEmailText(params);
  }

  promotionSubject(): string {
    return renderPromotionEmailSubject();
  }

  promotionHtml(params: PromotionParams): string {
    return renderPromotionEmailHtml(params);
  }

  emailChangeSubject(): string {
    return renderEmailChangeVerificationSubject();
  }

  emailChangeHtml(params: EmailChangeVerificationTemplateParams): string {
    return renderEmailChangeVerificationHtml(params);
  }
}