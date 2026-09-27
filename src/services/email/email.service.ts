import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

type MailInfo = { messageId?: string; message?: string };

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);
  private readonly transporter: nodemailer.Transporter;
  private readonly from: string;

  constructor(private readonly configService: ConfigService) {
    const host = this.configService.get<string>('email.host', '');
    const port = this.configService.get<number>('email.port', 587);
    const secure = this.configService.get<boolean>('email.secure', false);
    const user = this.configService.get<string>('email.user', '');
    const pass = this.configService.get<string>('email.password', '');
    const fromAddress = this.configService.get<string>('email.from', 'no-reply@ehte.org');
    const fromName = this.configService.get<string>('email.fromName', 'Ehte');

    this.from = `"${fromName}" <${fromAddress}>`;

    if (host && user && pass) {
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

  async send(to: string, subject: string, html: string, text = ''): Promise<void> {
    try {
      const info = (await this.transporter.sendMail({
        from: this.from,
        to,
        subject,
        html,
        text,
      })) as MailInfo;

      if (info.message) {
        // jsonTransport (no SMTP configured) — log the email body instead of delivering it.
        this.logger.warn('══════════════════════════════════════════');
        this.logger.warn(' EMAIL (no SMTP configured — not delivered)');
        this.logger.warn(`  To      : ${to}`);
        this.logger.warn(`  Subject : ${subject}`);
        this.logger.warn('══════════════════════════════════════════');
      } else {
        this.logger.log(`[Email] sent -> ${to} (subject: "${subject}")`);
      }
    } catch (err) {
      this.logger.error(`Email delivery failed -> ${to}: ${(err as Error).message}`);
      throw err;
    }
  }
}