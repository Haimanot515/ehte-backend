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

  const host = process.env.SMTP_HOST;
  const port = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === 'true';
  const user = process.env.SMTP_USER;
  const password = process.env.SMTP_PASSWORD;

  if (!host) {
    throw new Error('[EHTE EMAIL] SMTP_HOST is not configured.');
  }

  if (!user) {
    throw new Error('[EHTE EMAIL] SMTP_USER is not configured.');
  }

  if (!password) {
    throw new Error('[EHTE EMAIL] SMTP_PASSWORD is not configured.');
  }

  const transportOptions = {
    host,
    port,
    secure,
    auth: {
      user,
      pass: password,
    },
    // Forces IPv4 to avoid ENETUNREACH on networks with broken IPv6 routes; `as any` below since @types/nodemailer lacks this valid runtime option.
    family: 4,
  };

  transporter = nodemailer.createTransport(transportOptions as any);

  return transporter;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  text?: string,
): Promise<void> {
  const from = process.env.SMTP_FROM || 'no-reply@ehte.org';
  const fromName = process.env.SMTP_FROM_NAME || 'Ehte';

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