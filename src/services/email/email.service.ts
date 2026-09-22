import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter;

  constructor(private readonly config: ConfigService) {
    const transportOptions = {
      host: this.config.getOrThrow<string>('email.host'),
      port: this.config.get<number>('email.port', 587),
      secure: this.config.get<boolean>('email.secure', false),
      auth: {
        user: this.config.getOrThrow<string>('email.user'),
        pass: this.config.getOrThrow<string>('email.password'),
      },
      // Forces IPv4 to avoid ENETUNREACH; @types/nodemailer lacks this option, hence `as any`.
      family: 4,
    };

    this.transporter = nodemailer.createTransport(transportOptions as any);
  }

  async onModuleInit(): Promise<void> {
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

  async sendEmail(to: string, subject: string, html: string, text?: string): Promise<void> {
    const from = this.config.get<string>('email.from', 'no-reply@ehte.org');
    const fromName = this.config.get<string>('email.fromName', 'Ehte');
    const fromAddress = `"${fromName}" <${from}>`;

    const options: SendEmailOptions = { to, subject, html };
    if (text) {
      options.text = text;
    }

    try {
      await this.transporter.sendMail({
        from: fromAddress,
        to: options.to,
        subject: options.subject,
        html: options.html,
        text: options.text,
      });

      this.logger.log(`Email sent: subject="${subject}" to=${this.maskRecipient(to)}`);
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