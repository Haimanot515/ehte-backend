import { ApiProperty } from '@nestjs/swagger';
import { IsEnum } from 'class-validator';

import { MediaFolder } from '../../../common/enums/media-folder.enum';

export class UploadMediaDto {
  @ApiProperty({ enum: MediaFolder, example: MediaFolder.PHOTO })
  @IsEnum(MediaFolder)
  folder: MediaFolder;
}