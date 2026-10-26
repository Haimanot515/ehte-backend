import { ArrayMaxSize, ArrayUnique, IsArray, IsEnum, IsIn, IsOptional, IsUUID } from 'class-validator';
import { FollowableEntity } from 'src/common/enums/shared/followable-entity.enum';
import { PagedQueryDto } from '../../common/paged-query.dto';

export const FOLLOW_UPDATE_KINDS = ['STATUS_CHANGE', 'CASE_UPDATE', 'FOUND', 'FUNDING'];
export const FOLLOW_CHANNELS = ['IN_APP', 'PUSH', 'SMS', 'EMAIL'];

export class CreateFollowDto {
  @IsEnum(FollowableEntity)
  entity: FollowableEntity;

  @IsUUID()
  entityId: string;

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(FOLLOW_UPDATE_KINDS.length)
  @IsIn(FOLLOW_UPDATE_KINDS, { each: true })
  updateKinds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(FOLLOW_CHANNELS.length)
  @IsIn(FOLLOW_CHANNELS, { each: true })
  channels?: string[];
}

export class UpdateFollowSettingsDto {
  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(FOLLOW_UPDATE_KINDS.length)
  @IsIn(FOLLOW_UPDATE_KINDS, { each: true })
  updateKinds?: string[];

  @IsOptional()
  @IsArray()
  @ArrayUnique()
  @ArrayMaxSize(FOLLOW_CHANNELS.length)
  @IsIn(FOLLOW_CHANNELS, { each: true })
  channels?: string[];
}

export class FollowListQueryDto extends PagedQueryDto {
  @IsOptional()
  @IsEnum(FollowableEntity)
  entity?: FollowableEntity;
}
