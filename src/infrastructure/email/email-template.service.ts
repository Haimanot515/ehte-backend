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

import {
  ProfileEmailStatus,
  renderProfileEmailSubject,
  renderProfileEmailHtml,
  renderProfileEmailText,
} from './templates/profile-email.template';

import {
  AdminPasswordOtpPurpose,
  AdminPasswordSuccessKind,
  renderAdminPasswordOtpEmailSubject,
  renderAdminPasswordOtpEmailHtml,
  renderAdminPasswordOtpEmailText,
  renderAdminPasswordSuccessEmailSubject,
  renderAdminPasswordSuccessEmailHtml,
  renderAdminPasswordSuccessEmailText,
} from './templates/admin-password-email.template';

const DEFAULT_EMAIL_LOGO_URL =
  'https://res.cloudinary.com/dq3jkpys8/image/upload/v1790761570/ehte-logo-email-white_gavenx.png';

interface AdminRegistrationParams {
  registrationLink: string;
  expiresInHours: number;
  recipientName?: string;
}

interface PromotionParams {
  promotionLink: string;
  expiresInHours: number;
}

interface ProfileParams {
  status: ProfileEmailStatus;
  recipientName?: string;
  caseReference?: string;
  adminNote?: string;
}

@Injectable()
export class EmailTemplateService {
  private readonly appName: string;
  private readonly appUrl: string;
  private readonly logoUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.appName = this.configService.get<string>('app.name', 'Ehte');

    this.appUrl = this.configService.get<string>('app.url', 'https://ehte.org');

    // Public HTTPS PNG used in every email header.
    // Set EMAIL_LOGO_URL in .env to override; otherwise the Cloudinary default is used.
    this.logoUrl = this.configService.get<string>('app.emailLogoUrl') || DEFAULT_EMAIL_LOGO_URL;
  }

  getAppName(): string {
    return this.appName;
  }

  getAppUrl(): string {
    return this.appUrl;
  }

  getLogoUrl(): string {
    return this.logoUrl;
  }

  otpSubject(): string {
    return renderOtpEmailSubject();
  }

  otpHtml(otp: string, expiresInMinutes: number): string {
    return renderOtpEmailHtml({
      otp,
      expiresInMinutes,
      logoUrl: this.logoUrl,
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
    return renderAdminRegistrationEmailHtml({ ...params, logoUrl: this.logoUrl });
  }

  adminRegistrationText(params: AdminRegistrationParams): string {
    return renderAdminRegistrationEmailText(params);
  }

  // ── Admin-only password emails (forgot / change password + success confirmation) ──

  adminPasswordOtpSubject(purpose: AdminPasswordOtpPurpose): string {
    return renderAdminPasswordOtpEmailSubject(purpose);
  }

  adminPasswordOtpHtml(params: {
    purpose: AdminPasswordOtpPurpose;
    otp: string;
    expiresInMinutes: number;
    recipientName?: string;
  }): string {
    return renderAdminPasswordOtpEmailHtml({ ...params, logoUrl: this.logoUrl });
  }

  adminPasswordOtpText(params: {
    purpose: AdminPasswordOtpPurpose;
    otp: string;
    expiresInMinutes: number;
    recipientName?: string;
  }): string {
    return renderAdminPasswordOtpEmailText(params);
  }

  adminPasswordSuccessSubject(kind: AdminPasswordSuccessKind): string {
    return renderAdminPasswordSuccessEmailSubject(kind);
  }

  adminPasswordSuccessHtml(params: {
    kind: AdminPasswordSuccessKind;
    occurredAt?: Date;
    recipientName?: string;
  }): string {
    return renderAdminPasswordSuccessEmailHtml({ ...params, logoUrl: this.logoUrl });
  }

  adminPasswordSuccessText(params: {
    kind: AdminPasswordSuccessKind;
    occurredAt?: Date;
    recipientName?: string;
  }): string {
    return renderAdminPasswordSuccessEmailText(params);
  }

  promotionSubject(): string {
    return renderPromotionEmailSubject();
  }

  promotionHtml(params: PromotionParams): string {
    return renderPromotionEmailHtml({ ...params, logoUrl: this.logoUrl });
  }

  emailChangeSubject(): string {
    return renderEmailChangeVerificationSubject();
  }

  emailChangeHtml(params: EmailChangeVerificationTemplateParams): string {
    return renderEmailChangeVerificationHtml({ ...params, logoUrl: this.logoUrl });
  }

  profileSubject(status: ProfileEmailStatus): string {
    return renderProfileEmailSubject(status);
  }

  profileHtml(params: ProfileParams): string {
    return renderProfileEmailHtml({ ...params, appUrl: this.appUrl, logoUrl: this.logoUrl });
  }

  profileText(params: ProfileParams): string {
    return renderProfileEmailText({ ...params, appUrl: this.appUrl, logoUrl: this.logoUrl });
  }
}