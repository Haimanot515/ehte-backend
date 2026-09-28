// src/modules/billing/billing.constants.ts
//
// Status values that live in YOUR existing models. Set them to whatever your
// enums use for "publicly visible". A wrong value fails at compile time here
// instead of silently at runtime.

export const PROFILE_PUBLIC_STATUS = 'PUBLISHED' as const; // VictimProfile
export const MISSING_PERSON_PUBLIC_STATUS = 'PUBLISHED' as const; // MissingPerson

// Section 4 / 9 / 27: publish() must not be reachable until the posting fee is
// confirmed. Both VictimProfileService.publish() and MissingPersonService's
// publish path should assert postingFeeStatus === POSTING_FEE_REQUIRED_STATUS.PAID
// (or NOT_REQUIRED, for the pre-existing free tier / waived cases) before
// flipping status — this constant exists so that gate is written once, not
// copy-pasted per call site.
export const POSTING_FEE_GATE_STATUSES = ['PAID', 'WAIVED', 'NOT_REQUIRED'] as const;

// Section 11: evaluation weights must sum to exactly this many whole percent.
export const EVALUATION_WEIGHTS_TOTAL = 100;
