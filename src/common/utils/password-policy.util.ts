import { BadRequestException } from '@nestjs/common';

/**
 * Password policy (NIST SP 800-63B / OWASP ASVS style).
 *
 *  - Length is the main rule: users 8+, admins 12+ (both configurable via .env).
 *  - NO composition rules (no forced uppercase / number / symbol).
 *  - Reject common passwords, trivially simple ones, and ones built from the
 *    person's own phone / email.
 *  - Never truncate, allow spaces and any characters, up to 128.
 *
 * Applies only where a password is CHOSEN (signup, reset, change, set, admin
 * registration). Login is never checked against the policy.
 */

export const PASSWORD_MAX_LENGTH = 128;
export const DEFAULT_USER_PASSWORD_MIN_LENGTH = 8;
export const DEFAULT_ADMIN_PASSWORD_MIN_LENGTH = 12;

export type PasswordPolicyReason =
  | 'password_too_short'
  | 'password_too_long'
  | 'password_too_common'
  | 'password_too_simple'
  | 'password_contains_personal_info';

export interface PasswordCheckOptions {
  minLength?: number;
  maxLength?: number;
  /** Values the password must not be built from (phone, email, name...). */
  personal?: Array<string | null | undefined>;
}

// Most common / breached passwords and the bases people build on (Password1!, Welcome2024 ...).
const COMMON_PASSWORDS = new Set<string>([
  'password', 'passw0rd', 'p@ssword', 'p@ssw0rd', 'pass1234', 'password1', 'password12',
  'password123', 'password1234', 'passwordpassword', 'letmein', 'letmein1', 'welcome',
  'welcome1', 'welcome123', 'admin', 'admin123', 'admin1234', 'administrator', 'root',
  'toor', 'qwerty', 'qwerty1', 'qwerty12', 'qwerty123', 'qwertyuiop', 'qwertyui',
  'asdfghjk', 'asdfghjkl', 'zxcvbnm', 'zxcvbnm1', '1qaz2wsx', '1q2w3e4r', '1q2w3e4r5t',
  'abc123', 'abc12345', 'abcd1234', 'abcdefgh', 'abcdefg1', 'iloveyou', 'iloveyou1',
  'monkey', 'monkey123', 'dragon', 'dragon123', 'master', 'master123', 'sunshine',
  'princess', 'football', 'baseball', 'superman', 'batman', 'trustno1', 'shadow',
  'michael', 'jennifer', 'jordan', 'hunter', 'ranger', 'buster', 'soccer', 'hockey',
  'killer', 'george', 'charlie', 'andrew', 'michelle', 'jessica', 'pepper', 'daniel',
  'access', 'flower', 'freedom', 'whatever', 'qazwsx', 'qazwsxedc', 'login', 'hello',
  'hello123', 'secret', 'secret123', 'default', 'guest', 'test', 'test1234', 'testtest',
  'changeme', 'changeme1', 'temp1234', 'user', 'user1234', 'ehte', 'ehte1234', 'ehte123',
  'ehtepassword', 'ethiopia', 'ethiopia1', 'ethiopia123', 'addisababa', 'habesha',
  'summer', 'winter', 'spring', 'autumn', 'google', 'facebook', 'internet', 'computer',
  'samsung', 'iphone', 'android', 'mypassword', 'newpassword', 'yourpassword',
  'strongpassword', 'strongpassword123', 'newstrongpassword123', 'qwerty12345',
]);

function stripNonLetters(value: string): string {
  return value.replace(/^[^a-z]+|[^a-z]+$/g, '');
}

function isSingleRepeatedCharacter(value: string): boolean {
  return value.length > 0 && new Set(value).size === 1;
}

// 12345678, 87654321, abcdefgh ...
function isSequentialRun(value: string): boolean {
  if (value.length < 4) return false;
  let step = 0;
  for (let i = 1; i < value.length; i++) {
    const diff = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (diff !== 1 && diff !== -1) return false;
    if (step === 0) step = diff;
    else if (diff !== step) return false;
  }
  return true;
}

function isCommon(lower: string): boolean {
  if (COMMON_PASSWORDS.has(lower)) return true;
  const base = stripNonLetters(lower);
  return base.length >= 4 && COMMON_PASSWORDS.has(base);
}

function containsPersonalInfo(lower: string, personal: PasswordCheckOptions['personal']): boolean {
  if (!personal?.length) return false;
  const digitsOnly = lower.replace(/\D/g, '');

  for (const raw of personal) {
    const value = raw?.trim().toLowerCase();
    if (!value) continue;

    if (value.includes('@')) {
      const local = value.split('@')[0];
      if (local.length >= 4 && lower.includes(local)) return true;
      if (lower === value) return true;
      continue;
    }

    const phoneDigits = value.replace(/\D/g, '');
    if (phoneDigits.length >= 7) {
      // Compare on the national part (last 9 digits) so +2519… and 09… both match.
      const national = phoneDigits.slice(-9);
      if (digitsOnly.includes(national)) return true;
      continue;
    }

    if (value.length >= 4 && lower.includes(value)) return true;
  }

  return false;
}

export function checkPassword(
  password: string,
  options: PasswordCheckOptions = {},
): PasswordPolicyReason | null {
  const minLength = options.minLength ?? DEFAULT_USER_PASSWORD_MIN_LENGTH;
  const maxLength = options.maxLength ?? PASSWORD_MAX_LENGTH;

  if (typeof password !== 'string' || password.length < minLength) return 'password_too_short';
  if (password.length > maxLength) return 'password_too_long';

  const lower = password.toLowerCase();

  if (isCommon(lower)) return 'password_too_common';
  if (isSingleRepeatedCharacter(password) || isSequentialRun(lower)) return 'password_too_simple';
  if (containsPersonalInfo(lower, options.personal)) return 'password_contains_personal_info';

  return null;
}

/** Throws BadRequestException('<reason code>') when the password breaks the policy. */
export function assertStrongPassword(password: string, options: PasswordCheckOptions = {}): void {
  const reason = checkPassword(password, options);
  if (reason) throw new BadRequestException(reason);
}

export function userPasswordMinLengthFromEnv(): number {
  const value = parseInt(process.env.PASSWORD_MIN_LENGTH ?? '', 10);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_USER_PASSWORD_MIN_LENGTH;
}