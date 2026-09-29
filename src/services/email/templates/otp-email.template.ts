interface OtpEmailParams {
  otp: string;
  expiresInMinutes: number;
}

const brand = {
  primary: '#1d4a5c',
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
    .txt-ink { color: ${brandDark.ink} !important; }
    .txt-body { color: ${brandDark.body} !important; }
    .txt-muted { color: ${brandDark.muted} !important; }
    .txt-onsoft { color: ${brandDark.onSoft} !important; }
    .bd-line { border-color: ${brandDark.line} !important; }
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

export function renderOtpEmailSubject(): string {
  return 'Your Ehte verification code';
}

export function renderOtpEmailHtml({ otp, expiresInMinutes }: OtpEmailParams): string {
  const safeOtp = escapeHtml(otp);
  const safeExpiry = escapeHtml(formatMinutes(expiresInMinutes));

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>Ehte Verification Code</title>
  <style>${styles}</style>
</head>

<body class="bg-page" style="margin:0;padding:0;background-color:${brand.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    Your Ehte verification code is ${safeOtp}. It expires in ${safeExpiry}.
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
                    <span style="font-size:20px;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">Ehte</span>
                    <span style="display:inline-block;margin-left:10px;padding:3px 10px;border-radius:999px;background-color:rgba(255,255,255,0.16);color:#ffffff;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;vertical-align:2px;">Verification</span>
                    <h1 class="hero-title" style="margin:26px 0 8px;font-size:28px;line-height:1.25;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">
                      Your verification code
                    </h1>
                    <p style="margin:0;font-size:15px;line-height:1.6;color:rgba(255,255,255,0.8);">
                      Enter this code to continue with your account.
                    </p>
                  </td>
                </tr>

                <tr>
                  <td class="px" style="padding:34px 36px 36px;">
                    <p class="txt-body" style="margin:0 0 24px;font-size:15px;line-height:1.7;color:${brand.body};">
                      Use the code below to continue with your Ehte account.
                    </p>

                    <div class="bg-soft" style="margin:0 0 16px;padding:24px 16px;text-align:center;border-radius:12px;background-color:${brand.soft};">
                      <span class="otp txt-ink" style="display:inline-block;padding-left:10px;font-family:'SF Mono',Menlo,Consolas,'Courier New',monospace;font-size:34px;line-height:1.2;font-weight:700;letter-spacing:10px;color:${brand.ink};">${safeOtp}</span>
                    </div>

                    <p style="margin:0 0 30px;text-align:center;">
                      <span class="bg-soft txt-onsoft" style="display:inline-block;padding:5px 12px;border-radius:999px;background-color:${brand.soft};color:${brand.onSoft};font-size:12px;font-weight:600;">Expires in ${safeExpiry}</span>
                    </p>

                    <div class="bg-callout bd-line" style="margin:0;padding:14px 16px;border-radius:10px;background-color:${brand.callout};border:1px solid ${brand.line};">
                      <p class="txt-body" style="margin:0;font-size:13px;line-height:1.6;color:${brand.body};">
                        Never share this code with anyone. Ehte staff will never ask for it.
                        If you did not request it, you can safely ignore this email.
                      </p>
                    </div>
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

export function renderOtpEmailText({ otp, expiresInMinutes }: OtpEmailParams): string {
  return `
Ehte, My Sister

Your verification code: ${otp}

This code expires in ${formatMinutes(expiresInMinutes)}.

Never share this code with anyone. Ehte staff will never ask for it.

If you did not request this code, you can safely ignore this email.

This is an automated email, please do not reply.
`.trim();
}