const ETHIOPIAN_MOBILE_REGEX = /^\+251[79]\d{8}$/;

export function normalizePhoneNumber(phone: string): string {
  if (!phone) {
    throw new Error('invalid_phone_number');
  }

  let cleaned = phone.replace(/\s+/g, '').replace(/-/g, '');

  if (cleaned.startsWith('0')) {
    cleaned = '+251' + cleaned.substring(1);
  } else if (cleaned.startsWith('9') || cleaned.startsWith('7')) {
    // Ethio Telecom mobile ranges: legacy 9xxxxxxxx and newer 7xxxxxxxx
    cleaned = '+251' + cleaned;
  } else if (cleaned.startsWith('251')) {
    cleaned = '+' + cleaned;
  }
  // else: assume it's already in +251... form (or garbage — caught below)

  if (!ETHIOPIAN_MOBILE_REGEX.test(cleaned)) {
    throw new Error('invalid_phone_number');
  }

  return cleaned;
}