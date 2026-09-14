// Promotion email — sent when a Super Admin promotes an existing USER to
// ADMIN. Mirrors admin-invite-email.template.ts's link-based pattern rather
// than the numeric-code pattern used by otp-email.template.ts, since the
// link itself (not a typed-in code) is the proof of inbox ownership.
//
// NOTE: align the HTML styling here with your existing
// admin-invite-email.template.ts so the two emails look consistent — this
// is a functional placeholder, not final branding.

export function renderPromotionEmailSubject(): string {
  return "You've been promoted to Admin — confirm your email";
}

export function renderPromotionEmailHtml(params: {
  promotionLink: string;
  expiresInHours: number;
}): string {
  const { promotionLink, expiresInHours } = params;

  return `
    <div style="font-family: sans-serif; max-width: 480px; margin: 0 auto;">
      <h2>You've been promoted to Admin</h2>
      <p>
        A Super Admin has granted your account Admin access on Ehte.
        Click the button below to confirm this is your email address and
        activate your new Admin permissions.
      </p>
      <p style="margin: 24px 0;">
        <a
          href="${promotionLink}"
          style="background:#111827;color:#ffffff;padding:12px 24px;border-radius:6px;text-decoration:none;display:inline-block;"
        >
          Confirm and activate Admin access
        </a>
      </p>
      <p style="color:#6b7280;font-size:14px;">
        This link expires in ${expiresInHours} hours and can only be used once.
        Your existing password is unchanged — after confirming, log in at
        the Admin login page with your email and current password.
      </p>
      <p style="color:#6b7280;font-size:12px;">
        If you weren't expecting this, you can safely ignore this email.
      </p>
    </div>
  `;
}
