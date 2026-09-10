import { registerAs } from '@nestjs/config';

export default registerAs('email', () => ({
  host: process.env.SMTP_HOST || '',
  port: Number(process.env.SMTP_PORT || 587),

  secure:
    String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',

  user: process.env.SMTP_USER || '',
  password: process.env.SMTP_PASSWORD || '',

  from:
    process.env.SMTP_FROM ||
    process.env.SMTP_USER ||
    'no-reply@ehte.org',

  fromName: process.env.SMTP_FROM_NAME || 'Ehte',
}));