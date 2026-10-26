import { renderBrandMark } from './email-logo';

/**
 * Admin-only password emails.
 *
 *  1. OTP email for the admin "forgot password" flow (purpose: password_reset)
 *     and the admin "change password" flow (purpose: password_change).
 *  2. Security confirmation sent after an admin password was reset or changed.
 *
 * Normal (non-admin) users never receive these: they use SMS.
 */

export type AdminPasswordOtpPurpose = 'password_reset' | 'password_change';
export type AdminPasswordSuccessKind = 'reset' | 'changed';

interface AdminPasswordOtpEmailParams {
  purpose: AdminPasswordOtpPurpose;
  otp: string;
  expiresInMinutes: number;
  recipientName?: string;
  logoUrl?: string;
}

interface AdminPasswordSuccessEmailParams {
  kind: AdminPasswordSuccessKind;
  occurredAt?: Date;
  recipientName?: string;
  logoUrl?: string;
}

const brand = {
  soft: '#e3eff3',
  onSoft: '#1d4a5c',
  ink: '#0f2a35',
  body: '#3f5761',
  muted: '#6b8590',
  page: '#eef5f8',
  card: '#ffffff',
  callout: '#f4f9fb',
  line: '#dbe7ec',
  hero: '#1d4a5c',
  warnBg: '#fff6e5',
  warnLine: '#f3d9a4',
  warnText: '#7a4b00',
};

const brandDark = {
  soft: '#1b3a46',
  onSoft: '#a9d3e0',
  ink: '#eaf3f6',
  body: '#b6c9d0',
  muted: '#86a0aa',
  page: '#0b1a20',
  card: '#12262e',
  callout: '#0f2027',
  line: '#223c46',
  hero: '#163a49',
  warnBg: '#2b2210',
  warnLine: '#5c4720',
  warnText: '#f1cf8b',
};

const styles = `
  @media (max-width: 600px) {
    .px { padding-left: 22px !important; padding-right: 22px !important; }
    .hero-title { font-size: 24px !important; }
    .otp { font-size: 28px !important; letter-spacing: 6px !important; padding-left: 6px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg-page { background-color: ${brandDark.page} !important; }
    .bg-card { background-color: ${brandDark.card} !important; }
    .bg-hero { background-color: ${brandDark.hero} !important; }
    .bg-soft { background-color: ${brandDark.soft} !important; }
    .bg-callout { background-color: ${brandDark.callout} !important; }
    .bg-warn { background-color: ${brandDark.warnBg} !important; }
    .txt-ink { color: ${brandDark.ink} !important; }
    .txt-body { color: ${brandDark.body} !important; }
    .txt-muted { color: ${brandDark.muted} !important; }
    .txt-onsoft { color: ${brandDark.onSoft} !important; }
    .txt-warn { color: ${brandDark.warnText} !important; }
    .bd-line { border-color: ${brandDark.line} !important; }
    .bd-warn { border-color: ${brandDark.warnLine} !important; }
  }
`;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMinutes(minutes: number): string {
  return minutes === 1 ? '1 minute' : `${minutes} minutes`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatUtc(date: Date): string {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}, ${hh}:${mm} UTC`;
}

function greeting(recipientName?: string): string {
  const name = recipientName?.trim();
  return name ? `Hello ${escapeHtml(name)},` : 'Hello,';
}

interface LayoutParams {
  title: string;
  preheader: string;
  badge: string;
  heroTitle: string;
  heroSub: string;
  bodyHtml: string;
  logoUrl?: string;
}

function renderLayout(p: LayoutParams): string {
  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>${escapeHtml(p.title)}</title>
  <style>${styles}</style>
</head>

<body class="bg-page" style="margin:0;padding:0;background-color:${brand.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    ${escapeHtml(p.preheader)}
  </div>

  <table class="bg-page" role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:${brand.page};">
    <tr>
      <td align="center" style="padding:40px 16px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;border-collapse:separate;">
          <tr>
            <td class="bg-card bd-line" style="background-color:${brand.card};border:1px solid ${brand.line};border-radius:16px;overflow:hidden;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td class="px bg-hero" style="background-color:${brand.hero};padding:32px 36px 34px;">
                    ${renderBrandMark(p.logoUrl, 'Ehte')}
                    <span style="display:inline-block;margin-left:10px;padding:3px 10px;border-radius:999px;background-color:rgba(255,255,255,0.16);color:#ffffff;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;vertical-align:middle;">${escapeHtml(p.badge)}</span>
                    <h1 class="hero-title" style="margin:26px 0 8px;font-size:28px;line-height:1.25;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">
                      ${escapeHtml(p.heroTitle)}
                    </h1>
                    <p style="margin:0;font-size:15px;line-height:1.6;color:rgba(255,255,255,0.8);">
                      ${escapeHtml(p.heroSub)}
                    </p>
                  </td>
                </tr>

                <tr>
                  <td class="px" style="padding:34px 36px 36px;">
                    ${p.bodyHtml}
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <tr>
            <td style="padding:22px 8px 0;text-align:center;">
              <p class="txt-muted" style="margin:0;font-size:12px;line-height:1.6;color:${brand.muted};">
                Ehte, My Sister. This is an automated email, please do not reply.
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>
`.trim();
}

/* ───────────────────────── OTP email (forgot / change password) ───────────────────────── */

const OTP_COPY: Record<
  AdminPasswordOtpPurpose,
  { subject: string; badge: string; title: string; sub: string; intro: string; ignore: string }
> = {
  password_reset: {
    subject: 'Reset your Ehte admin password',
    badge: 'Password reset',
    title: 'Reset your admin password',
    sub: 'We received a request to reset the password for your admin account.',
    intro: 'Use the code below to reset your Ehte admin password.',
    ignore:
      'If you did not request a password reset, ignore this email. Your password stays unchanged. If you keep receiving these emails, tell a super admin.',
  },
  password_change: {
    subject: 'Confirm your Ehte admin password change',
    badge: 'Password change',
    title: 'Confirm your password change',
    sub: 'Confirm that you want to change your admin account password.',
    intro: 'Use the code below to confirm changing your Ehte admin password.',
    ignore:
      'If you did not start a password change, ignore this email and sign in to review your account security as soon as possible.',
  },
};

export function renderAdminPasswordOtpEmailSubject(purpose: AdminPasswordOtpPurpose): string {
  return OTP_COPY[purpose].subject;
}

export function renderAdminPasswordOtpEmailHtml(p: AdminPasswordOtpEmailParams): string {
  const copy = OTP_COPY[p.purpose];
  const safeOtp = escapeHtml(p.otp);
  const safeExpiry = escapeHtml(formatMinutes(p.expiresInMinutes));

  const bodyHtml = `
                    <p class="txt-body" style="margin:0 0 6px;font-size:15px;line-height:1.7;color:${brand.body};">${greeting(p.recipientName)}</p>
                    <p class="txt-body" style="margin:0 0 24px;font-size:15px;line-height:1.7;color:${brand.body};">
                      ${escapeHtml(copy.intro)}
                    </p>

                    <div class="bg-soft" style="margin:0 0 16px;padding:24px 16px;text-align:center;border-radius:12px;background-color:${brand.soft};">
                      <span class="otp txt-ink" style="display:inline-block;padding-left:10px;font-family:'SF Mono',Menlo,Consolas,'Courier New',monospace;font-size:34px;line-height:1.2;font-weight:700;letter-spacing:10px;color:${brand.ink};">${safeOtp}</span>
                    </div>

                    <p style="margin:0 0 26px;text-align:center;">
                      <span class="bg-soft txt-onsoft" style="display:inline-block;padding:5px 12px;border-radius:999px;background-color:${brand.soft};color:${brand.onSoft};font-size:12px;font-weight:600;">Expires in ${safeExpiry}</span>
                    </p>

                    <div class="bg-warn bd-warn" style="margin:0 0 14px;padding:14px 16px;border-radius:10px;background-color:${brand.warnBg};border:1px solid ${brand.warnLine};">
                      <p class="txt-warn" style="margin:0;font-size:13px;line-height:1.6;color:${brand.warnText};">
                        Never share this code with anyone. Ehte staff will never ask for it.
                      </p>
                    </div>

                    <div class="bg-callout bd-line" style="margin:0;padding:14px 16px;border-radius:10px;background-color:${brand.callout};border:1px solid ${brand.line};">
                      <p class="txt-body" style="margin:0;font-size:13px;line-height:1.6;color:${brand.body};">
                        ${escapeHtml(copy.ignore)}
                      </p>
                    </div>`;

  return renderLayout({
    title: `Ehte ${copy.badge}`,
    preheader: `Your Ehte admin ${copy.badge.toLowerCase()} code is ${p.otp}. It expires in ${formatMinutes(p.expiresInMinutes)}.`,
    badge: copy.badge,
    heroTitle: copy.title,
    heroSub: copy.sub,
    bodyHtml,
    logoUrl: p.logoUrl,
  });
}

export function renderAdminPasswordOtpEmailText(p: AdminPasswordOtpEmailParams): string {
  const copy = OTP_COPY[p.purpose];
  const name = p.recipientName?.trim();

  return `
Ehte, My Sister

${name ? `Hello ${name},` : 'Hello,'}

${copy.intro}

Your code: ${p.otp}

This code expires in ${formatMinutes(p.expiresInMinutes)}.

Never share this code with anyone. Ehte staff will never ask for it.

${copy.ignore}

This is an automated email, please do not reply.
`.trim();
}

/* ───────────────────────── Success / security confirmation ───────────────────────── */

const SUCCESS_COPY: Record<
  AdminPasswordSuccessKind,
  { subject: string; badge: string; title: string; sub: string; line: string }
> = {
  reset: {
    subject: 'Your Ehte admin password was reset',
    badge: 'Security',
    title: 'Your password was reset',
    sub: 'Your admin account password has been reset successfully.',
    line: 'Your admin password was reset using a verification code.',
  },
  changed: {
    subject: 'Your Ehte admin password was changed',
    badge: 'Security',
    title: 'Your password was changed',
    sub: 'Your admin account password has been changed successfully.',
    line: 'Your admin password was changed using a verification code.',
  },
};

export function renderAdminPasswordSuccessEmailSubject(kind: AdminPasswordSuccessKind): string {
  return SUCCESS_COPY[kind].subject;
}

export function renderAdminPasswordSuccessEmailHtml(p: AdminPasswordSuccessEmailParams): string {
  const copy = SUCCESS_COPY[p.kind];
  const when = escapeHtml(formatUtc(p.occurredAt ?? new Date()));

  const bodyHtml = `
                    <p class="txt-body" style="margin:0 0 6px;font-size:15px;line-height:1.7;color:${brand.body};">${greeting(p.recipientName)}</p>
                    <p class="txt-body" style="margin:0 0 24px;font-size:15px;line-height:1.7;color:${brand.body};">
                      ${escapeHtml(copy.line)} For your security, you were signed out of all devices, so sign in again with your new password.
                    </p>

                    <div class="bg-soft" style="margin:0 0 24px;padding:18px 20px;border-radius:12px;background-color:${brand.soft};">
                      <p class="txt-onsoft" style="margin:0 0 4px;font-size:12px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${brand.onSoft};">When</p>
                      <p class="txt-ink" style="margin:0;font-size:15px;font-weight:600;color:${brand.ink};">${when}</p>
                    </div>

                    <div class="bg-warn bd-warn" style="margin:0;padding:14px 16px;border-radius:10px;background-color:${brand.warnBg};border:1px solid ${brand.warnLine};">
                      <p class="txt-warn" style="margin:0;font-size:13px;line-height:1.6;color:${brand.warnText};">
                        <strong>Was this not you?</strong> Contact a super admin immediately so your account can be secured.
                      </p>
                    </div>`;

  return renderLayout({
    title: `Ehte ${copy.title}`,
    preheader: `${copy.sub} If this wasn't you, contact a super admin immediately.`,
    badge: copy.badge,
    heroTitle: copy.title,
    heroSub: copy.sub,
    bodyHtml,
    logoUrl: p.logoUrl,
  });
}

export function renderAdminPasswordSuccessEmailText(p: AdminPasswordSuccessEmailParams): string {
  const copy = SUCCESS_COPY[p.kind];
  const name = p.recipientName?.trim();

  return `
Ehte, My Sister

${name ? `Hello ${name},` : 'Hello,'}

${copy.line}

When: ${formatUtc(p.occurredAt ?? new Date())}

For your security, you were signed out of all devices. Sign in again with your new password.

Was this not you? Contact a super admin immediately so your account can be secured.

This is an automated email, please do not reply.
`.trim();
}