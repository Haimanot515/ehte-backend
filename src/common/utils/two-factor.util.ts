import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'crypto';

// Helpers for two-factor authentication. Standard-library only (RFC 6238 TOTP, RFC 4648 base32),
// so no new dependency is needed. Used by AuthService.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const TOTP_PERIOD_SECONDS = 30;
const TOTP_DIGITS = 6;

export function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    out += BASE32[(value << (5 - bits)) & 31];
  }

  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];

  for (const char of clean) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error('invalid_base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

function hotp(secret: Buffer, counter: number): string {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac('sha1', secret).update(buffer).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary =
    ((digest[offset] & 0x7f) << 24) |
    (digest[offset + 1] << 16) |
    (digest[offset + 2] << 8) |
    digest[offset + 3];

  return (binary % 10 ** TOTP_DIGITS).toString().padStart(TOTP_DIGITS, '0');
}

// Returns the matched time step, or null. The caller stores the step so the same code
// cannot be used twice (replay). `window` of 1 allows one step of clock drift either way.
export function verifyTotp(
  secretBase32: string,
  code: string,
  lastUsedStep: number | null,
  window = 1,
  now = Date.now(),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;

  const secret = base32Decode(secretBase32);
  const currentStep = Math.floor(now / 1000 / TOTP_PERIOD_SECONDS);

  for (let drift = -window; drift <= window; drift += 1) {
    const step = currentStep + drift;
    if (lastUsedStep !== null && step <= lastUsedStep) continue;
    if (timingSafeEqualStrings(hotp(secret, step), code)) return step;
  }

  return null;
}

function timingSafeEqualStrings(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function buildOtpAuthUri(args: { issuer: string; account: string; secret: string }): string {
  const label = encodeURIComponent(`${args.issuer}:${args.account}`);
  const params = new URLSearchParams({
    secret: args.secret,
    issuer: args.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// ── secret storage: AES-256-GCM, key derived from the configured string ──

function deriveKey(keyMaterial: string): Buffer {
  return createHash('sha256').update(keyMaterial).digest();
}

export function encryptSecret(plain: string, keyMaterial: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, encrypted].map((part) => part.toString('base64')).join('.');
}

export function decryptSecret(stored: string, keyMaterial: string): string {
  const [iv, tag, encrypted] = stored.split('.').map((part) => Buffer.from(part, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', deriveKey(keyMaterial), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

// ── recovery codes: high-entropy, so a fast hash is enough (no bcrypt cost needed) ──

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(12);
    const chars = Array.from(bytes, (b) => RECOVERY_ALPHABET[b % RECOVERY_ALPHABET.length]).join('');
    return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8, 12)}`;
  });
}

export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

export function hashRecoveryCode(input: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(input)).digest('hex');
}