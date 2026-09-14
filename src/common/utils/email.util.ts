// Mirrors phone.util.ts: pure normalization, throws on malformed input, no framework deps.

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(email: string): string {
  const trimmed = email.trim().toLowerCase();

  if (!EMAIL_REGEX.test(trimmed)) {
    throw new Error('invalid_email');
  }

  return trimmed;
}
