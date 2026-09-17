// Dedicated template for AdminAuthService.adminChangeEmailInitiate(). Previously this
// flow borrowed otp-email.template.ts as a stand-in, passing the verification LINK into
// a field meant for a 6-digit CODE — the copy read wrong ("Your OTP is: https://...").
// This template is link-based throughout, matching the pattern already used by
// admin-registration-email.template.ts and promotion-email.template.ts.

export interface EmailChangeVerificationTemplateParams {
  changeEmailLink: string;
  expiresInHours: number;
}

export function renderEmailChangeVerificationSubject(): string {
  const appName = process.env.APP_NAME || 'Ehte';

  return `Confirm your new ${appName} login email`;
}

export function renderEmailChangeVerificationHtml(
  params: EmailChangeVerificationTemplateParams,
): string {
  const appName = process.env.APP_NAME || 'Ehte';
  const { changeEmailLink, expiresInHours } = params;

  const hourLabel = expiresInHours === 1 ? '1 hour' : `${expiresInHours} hours`;

  return `
    <!DOCTYPE html>
    <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>${renderEmailChangeVerificationSubject()}</title>
      </head>
      <body style="margin:0; padding:0; background-color:#f4f4f5; font-family: Arial, Helvetica, sans-serif;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5; padding:24px 0;">
          <tr>
            <td align="center">
              <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background-color:#ffffff; border-radius:8px; overflow:hidden;">
                <tr>
                  <td style="padding:32px 32px 16px 32px;">
                    <h1 style="margin:0; font-size:20px; color:#111827;">${appName} — Confirm your new login email</h1>
                  </td>
                </tr>
                <tr>
                  <td style="padding:0 32px 24px 32px;">
                    <p style="margin:0 0 16px 0; font-size:14px; line-height:1.6; color:#374151;">
                      You (or someone with access to your admin account) requested to change the
                      login email for your ${appName} admin account to this address.
                      Click the button below to confirm the change.
                    </p>
                    <p style="margin:0 0 24px 0; font-size:14px; line-height:1.6; color:#374151;">
                      This link expires in <strong>${hourLabel}</strong>. If you didn't request
                      this change, you can safely ignore this email — your login email will stay
                      the same.
                    </p>
                    <table role="presentation" cellpadding="0" cellspacing="0">
                      <tr>
                        <td style="border-radius:6px; background-color:#2563eb;">
                          <a href="${changeEmailLink}"
                             style="display:inline-block; padding:12px 24px; font-size:14px; font-weight:bold; color:#ffffff; text-decoration:none; border-radius:6px;">
                            Confirm new email
                          </a>
                        </td>
                      </tr>
                    </table>
                    <p style="margin:24px 0 0 0; font-size:12px; line-height:1.6; color:#6b7280;">
                      If the button doesn't work, copy and paste this link into your browser:<br />
                      <a href="${changeEmailLink}" style="color:#2563eb; word-break:break-all;">${changeEmailLink}</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>
      </body>
    </html>
  `;
}