import { IsIn, IsUUID } from 'class-validator';

export class InitiatePostingFeeDto {
  @IsIn(['VICTIM_PROFILE', 'MISSING_PERSON'])
  objectType!: 'VICTIM_PROFILE' | 'MISSING_PERSON';

  @IsUUID() objectId!: string;
}
