import { Prisma } from '@prisma/client';

export const REDACTED = '[REDACTED]';

const EXACT_KEYS = new Set(['otp', 'authorization', 'cookie', 'apikey', 'privatekey', 'signedurl']);

// Catches passwordHash, refreshToken, inviteTokenHash, discreetModePasscodeHash, loginOtp, clientSecret...
const SENSITIVE_SUFFIX = /(password|passcode|secret|token|hash|otp)$/;

// Signed/private URLs that slipped into a value
const SENSITIVE_VALUE = /(X-Amz-Signature|X-Goog-Signature|[?&](token|signature)=)/i;

const MAX_DEPTH = 8;

function isSensitiveKey(key: string): boolean {
  const k = key.toLowerCase().replace(/[_-]/g, '');
  return EXACT_KEYS.has(k) || SENSITIVE_SUFFIX.test(k);
}

export function redact(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return REDACTED;

  if (typeof value === 'string') {
    return SENSITIVE_VALUE.test(value) ? REDACTED : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return REDACTED;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSensitiveKey(key) ? REDACTED : redact(val, depth + 1);
    }
    return out;
  }

  return value;
}

export function toAuditJson(value: unknown): Prisma.InputJsonValue | undefined {
  if (value === null || value === undefined) return undefined;
  return redact(value) as Prisma.InputJsonValue;
}