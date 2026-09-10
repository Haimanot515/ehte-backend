import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import {
  renderOtpEmailSubject,
  renderOtpEmailHtml,
  renderOtpEmailText,
} from './templates/otp-email.template';

import {
  renderAdminInviteEmailSubject,
  renderAdminInviteEmailHtml,
  renderAdminInviteEmailText,
} from './templates/admin-invite-email.template';

@Injectable()
export class EmailTemplateService {
  private readonly appName: string;
  private readonly appUrl: string;

  constructor(private readonly configService: ConfigService) {
    this.appName = this.configService.get<string>(
      'app.name',
      'Ehte',
    );

    this.appUrl = this.configService.get<string>(
      'app.url',
      'https://ehte.org',
    );
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

  adminInviteSubject(): string {
    return renderAdminInviteEmailSubject();
  }

  adminInviteHtml(params: {
    inviteLink: string;
    expiresInHours: number;
  }): string {
    return renderAdminInviteEmailHtml(params);
  }

  adminInviteText(params: {
    inviteLink: string;
    expiresInHours: number;
  }): string {
    return renderAdminInviteEmailText(params);
  }
}