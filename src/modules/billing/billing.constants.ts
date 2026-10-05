export const PROFILE_PUBLIC_STATUS = 'PUBLISHED' as const; // VictimProfile
export const MISSING_PERSON_PUBLIC_STATUS = 'PUBLISHED' as const; // MissingPerson

export const POSTING_FEE_GATE_STATUSES = ['PAID', 'WAIVED', 'NOT_REQUIRED'] as const;

// Section 11: evaluation weights must sum to exactly this many whole percent.
export const EVALUATION_WEIGHTS_TOTAL = 100;
