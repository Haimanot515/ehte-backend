// Link-based template sent when a Super Admin promotes an existing user to Admin

const brand = {
  primary: '#1d4a5c',
  onPrimary: '#ffffff',
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
  primary: '#6bbad4',
  onPrimary: '#06202a',
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
    .btn { display: block !important; text-align: center !important; }
    .btn-td { display: block !important; width: 100% !important; }
    .hero-title { font-size: 24px !important; }
  }
  @media (prefers-color-scheme: dark) {
    .bg-page { background-color: ${brandDark.page} !important; }
    .bg-card { background-color: ${brandDark.card} !important; }
    .bg-hero { background-color: ${brandDark.hero} !important; }
    .bg-soft { background-color: ${brandDark.soft} !important; }
    .bg-callout { background-color: ${brandDark.callout} !important; }
    .bg-btn { background-color: ${brandDark.primary} !important; }
    .txt-onbtn { color: ${brandDark.onPrimary} !important; }
    .txt-ink { color: ${brandDark.ink} !important; }
    .txt-body { color: ${brandDark.body} !important; }
    .txt-muted { color: ${brandDark.muted} !important; }
    .txt-onsoft { color: ${brandDark.onSoft} !important; }
    .txt-link { color: ${brandDark.onSoft} !important; }
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

function formatExpiry(hours: number): string {
  return hours === 1 ? '1 hour' : `${hours} hours`;
}

function renderStep(index: number, title: string, description: string, isLast: boolean): string {
  const gap = isLast ? '0' : '0 0 16px';

  return `
                <tr>
                  <td width="40" valign="top" style="padding:${gap};">
                    <div class="bg-soft txt-onsoft" style="width:28px;height:28px;line-height:28px;border-radius:50%;background-color:${brand.soft};color:${brand.onSoft};font-size:13px;font-weight:700;text-align:center;">${index}</div>
                  </td>
                  <td valign="top" style="padding:${gap};">
                    <p class="txt-ink" style="margin:0;font-size:14px;line-height:1.5;font-weight:600;color:${brand.ink};">${title}</p>
                    <p class="txt-muted" style="margin:2px 0 0;font-size:13px;line-height:1.5;color:${brand.muted};">${description}</p>
                  </td>
                </tr>`;
}

export function renderPromotionEmailSubject(): string {
  return 'You have been promoted to Admin: confirm your email';
}

export function renderPromotionEmailHtml(params: {
  promotionLink: string;
  expiresInHours: number;
}): string {
  const safeLink = escapeHtml(params.promotionLink);
  const safeExpiry = escapeHtml(formatExpiry(params.expiresInHours));

  const steps = [
    renderStep(1, 'Confirm your email', 'Use the button above to verify this address is yours.', false),
    renderStep(2, 'Admin access is activated', 'Your account gains its new Admin permissions.', false),
    renderStep(3, 'Sign in as usual', 'Use your email and current password on the Admin login page.', true),
  ].join('');

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>Ehte Admin Promotion</title>
  <style>${styles}</style>
</head>

<body class="bg-page" style="margin:0;padding:0;background-color:${brand.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    A Super Admin granted your account Admin access. Confirm your email to activate it.
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
                    <span style="display:inline-block;margin-left:10px;padding:3px 10px;border-radius:999px;background-color:rgba(255,255,255,0.16);color:#ffffff;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;vertical-align:2px;">Admin promotion</span>
                    <h1 class="hero-title" style="margin:26px 0 8px;font-size:28px;line-height:1.25;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">
                      You have been promoted to Admin
                    </h1>
                    <p style="margin:0;font-size:15px;line-height:1.6;color:rgba(255,255,255,0.8);">
                      One step left to activate your new permissions.
                    </p>
                  </td>
                </tr>

                <tr>
                  <td class="px" style="padding:34px 36px 36px;">
                    <p class="txt-body" style="margin:0 0 26px;font-size:15px;line-height:1.7;color:${brand.body};">
                      A Super Admin has granted your account Admin access on Ehte.
                      Confirm that this is your email address to activate it.
                    </p>

                    <table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;">
                      <tr>
                        <td class="btn-td bg-btn" style="border-radius:10px;background-color:${brand.primary};">
                          <a class="btn txt-onbtn" href="${safeLink}" style="display:inline-block;padding:15px 30px;font-size:15px;font-weight:600;color:${brand.onPrimary};text-decoration:none;border-radius:10px;">
                            Confirm and activate Admin access
                          </a>
                        </td>
                      </tr>
                    </table>

                    <p style="margin:0 0 30px;">
                      <span class="bg-soft txt-onsoft" style="display:inline-block;padding:5px 12px;border-radius:999px;background-color:${brand.soft};color:${brand.onSoft};font-size:12px;font-weight:600;">Expires in ${safeExpiry}, single use</span>
                    </p>

                    <p class="txt-muted" style="margin:0 0 14px;font-size:13px;font-weight:600;letter-spacing:0.04em;text-transform:uppercase;color:${brand.muted};">
                      What happens next
                    </p>
                    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 30px;">${steps}
                    </table>

                    <div class="bg-callout bd-line" style="margin:0 0 24px;padding:14px 16px;border-radius:10px;background-color:${brand.callout};border:1px solid ${brand.line};">
                      <p class="txt-body" style="margin:0;font-size:13px;line-height:1.6;color:${brand.body};">
                        Your existing password is unchanged. If you were not expecting this,
                        you can safely ignore this email and no access will be granted.
                      </p>
                    </div>

                    <p class="txt-muted" style="margin:0 0 6px;font-size:12px;line-height:1.6;color:${brand.muted};">
                      Button not working? Paste this link into your browser:
                    </p>
                    <p class="txt-link" style="margin:0;font-size:12px;line-height:1.6;color:${brand.primary};word-break:break-all;">
                      ${safeLink}
                    </p>
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