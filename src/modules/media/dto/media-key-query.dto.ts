import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

export class MediaKeyQueryDto {
  @ApiProperty({
    description:
      'The object key/filepath in the media bucket, e.g. victim-profiles/photos/<uuid>.jpg',
    example: 'victim-profiles/photos/550e8400-e29b-41d4-a716-446655440000.jpg',
  })
  @IsString()
  @IsNotEmpty()
  key: string;
}
