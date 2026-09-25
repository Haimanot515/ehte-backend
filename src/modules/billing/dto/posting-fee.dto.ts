// src/modules/billing/dto/posting-fee.dto.ts
//
// Section 5 / 8 / 27: the posting/promotion fee is a separate financial movement
// from supporter contributions and from the reward principal (section 33). Its
// amount/allocation come from the resolved agreement's *_POSTING_FEE rules, same
// as SUPPORT does today — the payer never types an amount in for a fee.

import { IsIn, IsUUID } from 'class-validator';

export class InitiatePostingFeeDto {
  // Which business object the fee is for. The controller route already scopes
  // this (victim-profiles/:id vs missing-persons/:id), so this only exists for
  // services that need to disambiguate a shared code path.
  @IsIn(['VICTIM_PROFILE', 'MISSING_PERSON'])
  objectType!: 'VICTIM_PROFILE' | 'MISSING_PERSON';

  @IsUUID() objectId!: string;
}
