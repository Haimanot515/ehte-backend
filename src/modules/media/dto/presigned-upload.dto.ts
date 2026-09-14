import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsNotEmpty, IsOptional, IsString } from 'class-validator';

import { MediaFolder } from '../../../common/enums/media-folder.enum';

export class PresignedUploadDto {
  @ApiProperty({
    description: 'Original filename from the client, used to derive the object key extension.',
    example: 'passport-photo.jpg',
  })
  @IsString()
  @IsNotEmpty()
  originalname: string;

  @ApiProperty({
    enum: MediaFolder,
    description: 'Which media kind this upload belongs to — maps 1:1 onto the domain media arrays (photo/video/audio/pdf/document/other).',
    example: MediaFolder.PHOTO,
  })
  @IsEnum(MediaFolder)
  folder: MediaFolder;

  @ApiPropertyOptional({
    description: 'MIME type of the file being uploaded, set as Content-Type on the presigned PUT.',
    example: 'image/jpeg',
  })
  @IsOptional()
  @IsString()
  contentType?: string;
}