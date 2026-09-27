import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

type MailInfo = { messageId?: string; message?: string };

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;
  private readonly isConfigured: boolean;

  constructor(private readonly config: ConfigService) {
    const host = this.config.get<string>('email.host', '');
    const port = this.config.get<number>('email.port', 587);
    const secure = this.config.get<boolean>('email.secure', false);
    const user = this.config.get<string>('email.user', '');
    const pass = this.config.get<string>('email.password', '');
    const fromAddress = this.config.get<string>('email.from', 'no-reply@ehte.org');
    const fromName = this.config.get<string>('email.fromName', 'Ehte');

    this.from = `"${fromName}" <${fromAddress}>`;
    this.isConfigured = !!(host && user && pass);

    if (this.isConfigured) {
      this.transporter = nodemailer.createTransport({
        host,
        port,
        secure: secure || port === 465,
        auth: { user, pass },
        // Forces IPv4 to avoid ENETUNREACH on networks with broken IPv6 routes.
        family: 4,
      } as any);
    } else {
      // Missing config: log instead of throwing at boot — a misconfigured mailer
      // shouldn't crash the whole app. In practice this branch should be
      // unreachable in production since SMTP_HOST/USER/PASSWORD are all
      // Joi .required() in app.module.ts and boot fails first if they're unset.
      this.logger.warn('SMTP not fully configured — emails will be logged, not sent.');
      this.transporter = nodemailer.createTransport({ jsonTransport: true });
    }
  }

  async onModuleInit(): Promise<void> {
    if (!this.isConfigured) {
      // Nothing to verify — we're in log-only mode.
      return;
    }

    try {
      await this.transporter.verify();
      this.logger.log('SMTP connection verified successfully');
    } catch (error) {
      this.logger.error(
        `SMTP verification failed: ${(error as Error).message}`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  async send(to: string, subject: string, html: string, text = ''): Promise<void> {
    const options: SendEmailOptions = { to, subject, html };
    if (text) {
      options.text = text;
    }

    try {
      const info = (await this.transporter.sendMail({
        from: this.from,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      })) as MailInfo;

      if (info.message) {
        // jsonTransport (no SMTP configured) — log the email body instead of delivering it.
        this.logger.warn('══════════════════════════════════════════');
        this.logger.warn(' EMAIL (no SMTP configured — not delivered)');
        this.logger.warn(`  To      : ${this.maskRecipient(to)}`);
        this.logger.warn(`  Subject : ${subject}`);
        this.logger.warn('══════════════════════════════════════════');
      } else {
        this.logger.log(`Email sent: subject="${subject}" to=${this.maskRecipient(to)}`);
      }
    } catch (error) {
      this.logger.error(
        `Failed to send email: subject="${subject}" to=${this.maskRecipient(to)} — ${
          (error as Error).message
        }`,
        (error as Error).stack,
      );
      throw error;
    }
  }

  private maskRecipient(email: string): string {
    const [local, domain] = email.split('@');
    if (!domain) return '***';
    const maskedLocal = local.length <= 2 ? '**' : `${local[0]}***${local[local.length - 1]}`;
    return `${maskedLocal}@${domain}`;
  }
}