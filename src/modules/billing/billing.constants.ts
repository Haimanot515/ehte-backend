// src/modules/billing/billing.constants.ts
//
// Status values that live in YOUR existing models. Set them to whatever your
// enums use for "publicly visible". A wrong value fails at compile time here
// instead of silently at runtime.

export const PROFILE_PUBLIC_STATUS = 'PUBLISHED' as const; // VictimProfile
export const MISSING_PERSON_PUBLIC_STATUS = 'PUBLISHED' as const; // MissingPerson
