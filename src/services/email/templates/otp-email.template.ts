interface OtpEmailParams {
  otp: string;
  expiresInMinutes: number;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderOtpEmailSubject(): string {
  return 'Your Ehte verification code';
}

export function renderOtpEmailHtml({ otp, expiresInMinutes }: OtpEmailParams): string {
  const safeOtp = escapeHtml(otp);
  const safeExpiry = escapeHtml(String(expiresInMinutes));

  return `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />
  <title>Ehte Verification Code</title>
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
      <h1
        style="
          margin: 0;
          font-size: 28px;
          font-weight: 700;
        "
      >
        Ehte
      </h1>

      <p
        style="
          margin: 6px 0 0;
          font-size: 14px;
          color: #d1d5db;
        "
      >
        My Sister
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
        Verification code
      </h2>

      <p
        style="
          margin: 0 0 24px;
          line-height: 1.6;
          color: #4b5563;
        "
      >
        Use the verification code below to continue with your
        Ehte account.
      </p>

      <div
        style="
          margin: 24px 0;
          padding: 20px;
          text-align: center;
          background-color: #f3f4f6;
          border-radius: 10px;
        "
      >
        <span
          style="
            font-size: 32px;
            font-weight: 700;
            letter-spacing: 8px;
            color: #111827;
          "
        >
          ${safeOtp}
        </span>
      </div>

      <p
        style="
          margin: 0 0 12px;
          line-height: 1.6;
          color: #4b5563;
        "
      >
        This code expires in
        <strong>${safeExpiry} minutes</strong>.
      </p>

      <p
        style="
          margin: 0;
          line-height: 1.6;
          color: #6b7280;
          font-size: 14px;
        "
      >
        If you did not request this code, you can safely ignore
        this email.
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
          line-height: 1.5;
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

export function renderOtpEmailText({ otp, expiresInMinutes }: OtpEmailParams): string {
  return `
Ehte — My Sister

Verification code: ${otp}

This code expires in ${expiresInMinutes} minutes.

If you did not request this code, you can safely ignore this email.

This is an automated email. Please do not reply.
`.trim();
}
