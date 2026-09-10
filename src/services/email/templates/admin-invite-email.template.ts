interface AdminInviteEmailParams {
  inviteLink: string;
  expiresInHours: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderAdminInviteEmailSubject(): string {
  return 'You have been invited to Ehte Admin';
}

export function renderAdminInviteEmailHtml({
  inviteLink,
  expiresInHours,
}: AdminInviteEmailParams): string {
  const safeLink = escapeHtml(inviteLink);
  const safeExpiry = escapeHtml(String(expiresInHours));

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />
  <title>Ehte Admin Invitation</title>
</head>

<body
  style="
    margin: 0;
    padding: 0;
    background-color: #f5f7fa;
    font-family: Arial, Helvetica, sans-serif;
    color: #1f2937;
  "
>
  <div
    style="
      max-width: 600px;
      margin: 40px auto;
      background-color: #ffffff;
      border-radius: 12px;
      overflow: hidden;
      border: 1px solid #e5e7eb;
    "
  >
    <div
      style="
        padding: 28px 32px;
        background-color: #111827;
        color: #ffffff;
      "
    >
      <h1 style="margin: 0; font-size: 28px;">
        Ehte
      </h1>

      <p
        style="
          margin: 6px 0 0;
          font-size: 14px;
          color: #d1d5db;
        "
      >
        Admin Portal
      </p>
    </div>

    <div style="padding: 32px;">
      <h2
        style="
          margin: 0 0 16px;
          font-size: 22px;
          color: #111827;
        "
      >
        You have been invited
      </h2>

      <p
        style="
          margin: 0 0 18px;
          line-height: 1.6;
          color: #4b5563;
        "
      >
        You have been invited to join the Ehte administration
        platform.
      </p>

      <p
        style="
          margin: 0 0 24px;
          line-height: 1.6;
          color: #4b5563;
        "
      >
        Use the button below to set your password and activate
        your administrator account.
      </p>

      <div style="text-align: center; margin: 30px 0;">
        <a
          href="${safeLink}"
          style="
            display: inline-block;
            padding: 14px 24px;
            background-color: #111827;
            color: #ffffff;
            text-decoration: none;
            border-radius: 8px;
            font-weight: 600;
          "
        >
          Set your password
        </a>
      </div>

      <p
        style="
          margin: 0 0 12px;
          line-height: 1.6;
          color: #6b7280;
          font-size: 14px;
        "
      >
        This invitation expires in
        <strong>${safeExpiry} hours</strong>.
      </p>

      <p
        style="
          margin: 0;
          line-height: 1.6;
          color: #6b7280;
          font-size: 14px;
        "
      >
        If you were not expecting this invitation, you can
        safely ignore this email.
      </p>
    </div>

    <div
      style="
        padding: 20px 32px;
        border-top: 1px solid #e5e7eb;
        background-color: #f9fafb;
      "
    >
      <p
        style="
          margin: 0;
          font-size: 12px;
          color: #6b7280;
        "
      >
        Ehte — My Sister
      </p>

      <p
        style="
          margin: 4px 0 0;
          font-size: 12px;
          color: #9ca3af;
        "
      >
        This is an automated email. Please do not reply.
      </p>
    </div>
  </div>
</body>
</html>
`.trim();
}

export function renderAdminInviteEmailText({
  inviteLink,
  expiresInHours,
}: AdminInviteEmailParams): string {
  return `
Ehte — My Sister

You have been invited to join the Ehte administration platform.

Use the following link to set your password and activate your administrator account:

${inviteLink}

This invitation expires in ${expiresInHours} hours.

If you were not expecting this invitation, you can safely ignore this email.

This is an automated email. Please do not reply.
`.trim();
}