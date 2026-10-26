import { Transform } from 'class-transformer';
import { IsBoolean, IsDateString, IsEnum, IsOptional, IsString, IsUUID, MaxLength, MinLength } from 'class-validator';
import { SharedRecordEntity } from 'src/common/enums/shared/shared-record-entity.enum';
import { PagedQueryDto } from '../../common/paged-query.dto';

export const NOTE_MAX_LENGTH = 5000;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBool = ({ value }: { value: unknown }) => value === true || value === 'true' || value === '1';

export class CreateNoteDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(NOTE_MAX_LENGTH)
  body: string;
}

export class UpdateNoteDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(NOTE_MAX_LENGTH)
  body: string;
}

export class NotesListQueryDto extends PagedQueryDto {
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  pinnedOnly?: boolean;
}

export class NotesSearchQueryDto extends PagedQueryDto {
  @Transform(trim)
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  q: string;

  @IsOptional()
  @IsEnum(SharedRecordEntity)
  entity?: SharedRecordEntity;

  @IsOptional()
  @IsUUID()
  authorId?: string;

  @IsOptional()
  @IsDateString()
  from?: string;

  @IsOptional()
  @IsDateString()
  to?: string;
}
