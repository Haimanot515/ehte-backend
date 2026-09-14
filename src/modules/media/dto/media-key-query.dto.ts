import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString } from 'class-validator';

// NOTE: `key` is passed as a query param rather than a route param
// (`:key`) deliberately. Object keys contain slashes —
// `victim-profiles/photos/<uuid>.jpg` — and a plain Express/Nest
// `:key` path segment does not span multiple `/`-delimited segments.
// A route param here would silently truncate the key at the first
// slash. Query params don't have that problem and need no
// encode/decode handling on either side.
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
