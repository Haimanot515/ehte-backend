import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

interface SendEmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

let transporter: nodemailer.Transporter | null = null;

function getTransporter(): nodemailer.Transporter {
  if (transporter) {
    return transporter;
  }

  const configService = new ConfigService();

  const host = configService.get<string>('email.host');
  const port = configService.get<number>('email.port', 587);
  const secure = configService.get<boolean>('email.secure', false);
  const user = configService.get<string>('email.user');
  const password = configService.get<string>('email.password');

  if (!host) {
    throw new Error('[EHTE EMAIL] SMTP_HOST is not configured.');
  }

  if (!user) {
    throw new Error('[EHTE EMAIL] SMTP_USER is not configured.');
  }

  if (!password) {
    throw new Error('[EHTE EMAIL] SMTP_PASSWORD is not configured.');
  }

  transporter = nodemailer.createTransport({
    host,
    port,
    secure,
    auth: {
      user,
      pass: password,
    },
  });

  return transporter;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text?: string,
): Promise<void> {
  const configService = new ConfigService();

  const from = configService.get<string>(
    'email.from',
    'no-reply@ehte.org',
  );

  const fromName = configService.get<string>(
    'email.fromName',
    'Ehte',
  );

  const mailTransporter = getTransporter();

  const fromAddress = `"${fromName}" <${from}>`;

  const options: SendEmailOptions = {
    to,
    subject,
    html,
  };

  if (text) {
    options.text = text;
  }

  await mailTransporter.sendMail({
    from: fromAddress,
    to: options.to,
    subject: options.subject,
    html: options.html,
    text: options.text,
  });
}