import { renderBrandMark } from './email-logo';

export type ProfileEmailStatus =
  | 'request_received'
  | 'approved'
  | 'changes_requested'
  | 'rejected'
  | 'unpublished';

export interface ProfileEmailTemplateParams {
  status: ProfileEmailStatus;
  appUrl: string;
  logoUrl?: string;
  recipientName?: string;
  caseReference?: string;
  adminNote?: string;
}

interface ProfileContent {
  subject: string;
  label: string;
  title: string;
  lead: string;
  paragraphs: string[];
  actionLabel: string;
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

const content: Record<ProfileEmailStatus, ProfileContent> = {
  request_received: {
    subject: 'Ehte: your request was received',
    label: 'Profile',
    title: 'We received your request',
    lead: 'Your profile request is now waiting for review.',
    paragraphs: [
      'Thank you for contacting Ehte. Every profile goes through verification, a safety review, a consent check and a privacy review before anything is made public.',
      'This can take some time. We will let you know as soon as there is an update.',
    ],
    actionLabel: 'Open Ehte',
  },
  approved: {
    subject: 'Ehte: you have a new update',
    label: 'Profile',
    title: 'Your profile has been approved',
    lead: 'An Ehte administrator has approved your profile.',
    paragraphs: [
      'Your profile has passed all required reviews. Only the information approved for publication will be visible to the public.',
      'Private details stay protected and are never shown without approval.',
    ],
    actionLabel: 'Open Ehte',
  },
  changes_requested: {
    subject: 'Ehte: more information is needed',
    label: 'Profile',
    title: 'We need a little more information',
    lead: 'An administrator asked for changes before your profile can move forward.',
    paragraphs: [
      'Please open the app and follow the request shown there.',
      'Sensitive details are only shown inside the protected area of the app.',
    ],
    actionLabel: 'Open Ehte',
  },
  rejected: {
    subject: 'Ehte: you have a new update',
    label: 'Profile',
    title: 'Your profile was not approved',
    lead: 'After review, the profile could not be approved for publication at this time.',
    paragraphs: [
      'This does not mean your situation is not important. If you would like to understand the decision or send new information, please contact the Ehte administration through the app.',
    ],
    actionLabel: 'Contact administration',
  },
  unpublished: {
    subject: 'Ehte: you have a new update',
    label: 'Profile',
    title: 'Your profile is no longer public',
    lead: 'An Ehte administrator removed your profile from public view.',
    paragraphs: [
      'If you have questions or would like the profile reviewed again, please contact the Ehte administration through the app.',
    ],
    actionLabel: 'Contact administration',
  },
};

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderProfileEmailSubject(status: ProfileEmailStatus): string {
  return content[status].subject;
}

export function renderProfileEmailHtml(params: ProfileEmailTemplateParams): string {
  const item = content[params.status];
  const greeting = params.recipientName ? `Hello ${escapeHtml(params.recipientName)},` : 'Hello,';

  const paragraphs = item.paragraphs
    .map(
      (p) =>
        `<p class="txt-body" style="margin:0 0 16px;font-size:15px;line-height:1.7;color:${brand.body};">${escapeHtml(p)}</p>`,
    )
    .join('');

  const reference = params.caseReference
    ? `<div class="bg-soft" style="margin:8px 0 20px;padding:16px;text-align:center;border-radius:12px;background-color:${brand.soft};">
                      <span class="txt-onsoft" style="display:block;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${brand.onSoft};">Reference</span>
                      <span class="txt-ink" style="display:block;margin-top:4px;font-family:'SF Mono',Menlo,Consolas,'Courier New',monospace;font-size:20px;font-weight:700;letter-spacing:2px;color:${brand.ink};">${escapeHtml(params.caseReference)}</span>
                    </div>`
    : '';

  const note = params.adminNote
    ? `<div class="bg-callout bd-line" style="margin:0 0 20px;padding:14px 16px;border-radius:10px;background-color:${brand.callout};border:1px solid ${brand.line};">
                      <p class="txt-muted" style="margin:0 0 4px;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;color:${brand.muted};">Message from administrator</p>
                      <p class="txt-body" style="margin:0;font-size:14px;line-height:1.6;color:${brand.body};">${escapeHtml(params.adminNote)}</p>
                    </div>`
    : '';

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="color-scheme" content="light dark" />
  <meta name="supported-color-schemes" content="light dark" />
  <title>Ehte Profile Update</title>
  <style>${styles}</style>
</head>

<body class="bg-page" style="margin:0;padding:0;background-color:${brand.page};">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">
    You have a new update from Ehte.
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
                    ${renderBrandMark(params.logoUrl, 'Ehte')}
                    <span style="display:inline-block;margin-left:10px;padding:3px 10px;border-radius:999px;background-color:rgba(255,255,255,0.16);color:#ffffff;font-size:11px;font-weight:600;letter-spacing:0.05em;text-transform:uppercase;vertical-align:middle;">${escapeHtml(item.label)}</span>
                    <h1 class="hero-title" style="margin:26px 0 8px;font-size:28px;line-height:1.25;font-weight:700;letter-spacing:-0.02em;color:#ffffff;">
                      ${escapeHtml(item.title)}
                    </h1>
                    <p style="margin:0;font-size:15px;line-height:1.6;color:rgba(255,255,255,0.8);">
                      ${escapeHtml(item.lead)}
                    </p>
                  </td>
                </tr>

                <tr>
                  <td class="px" style="padding:34px 36px 36px;">
                    <p class="txt-body" style="margin:0 0 16px;font-size:15px;line-height:1.7;color:${brand.body};">
                      ${greeting}
                    </p>

                    ${paragraphs}

                    ${reference}

                    ${note}

                    <p style="margin:8px 0 30px;text-align:center;">
                      <a href="${escapeHtml(params.appUrl)}" style="display:inline-block;padding:13px 30px;border-radius:10px;background-color:${brand.primary};color:#ffffff;font-size:15px;font-weight:600;text-decoration:none;">${escapeHtml(item.actionLabel)}</a>
                    </p>

                    <div class="bg-callout bd-line" style="margin:0;padding:14px 16px;border-radius:10px;background-color:${brand.callout};border:1px solid ${brand.line};">
                      <p class="txt-body" style="margin:0;font-size:13px;line-height:1.6;color:${brand.body};">
                        Ehte staff will never ask for your password by email.
                        If you did not expect this email, you can safely ignore it.
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

export function renderProfileEmailText(params: ProfileEmailTemplateParams): string {
  const item = content[params.status];
  const lines: string[] = [
    'Ehte, My Sister',
    '',
    params.recipientName ? `Hello ${params.recipientName},` : 'Hello,',
    '',
    item.title,
    item.lead,
    '',
    ...item.paragraphs.flatMap((p) => [p, '']),
  ];

  if (params.caseReference) {
    lines.push(`Reference: ${params.caseReference}`, '');
  }

  if (params.adminNote) {
    lines.push(`Message from administrator: ${params.adminNote}`, '');
  }

  lines.push(
    `${item.actionLabel}: ${params.appUrl}`,
    '',
    'Ehte staff will never ask for your password by email.',
    'If you did not expect this email, you can safely ignore it.',
    '',
    'This is an automated email, please do not reply.',
  );

  return lines.join('\n').trim();
}
