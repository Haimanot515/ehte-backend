import { applyDecorators, SetMetadata, Type, UseInterceptors } from '@nestjs/common';
import { FileFieldsInterceptor } from '@nestjs/platform-express';
import { ApiBody, ApiConsumes, ApiPropertyOptional, OmitType } from '@nestjs/swagger';

import { MediaFolder } from '../enums/media-folder.enum';
import {
  DEFAULT_MEDIA_FIELDS,
  MAX_FILES_PER_FIELD,
  MAX_UPLOAD_BYTES,
  MEDIA_UPLOAD_FIELDS_KEY,
  MediaFieldSpec,
  MediaUploadInterceptor,
} from '../interceptors/media-upload.interceptor';

// Ready-made field sets for the endpoints that are not the standard six arrays.
export const PROFILE_PICTURE_FIELDS: MediaFieldSpec[] = [
  { name: 'filepath', folder: MediaFolder.PHOTO, multiple: false },
];
export const RESPONSE_FILES_FIELDS: MediaFieldSpec[] = [
  { name: 'responseFiles', folder: MediaFolder.DOCUMENT, multiple: true },
];

// The re-auth guard runs BEFORE multipart is parsed, so it cannot read these
// from a multipart body. Send them in the X-Reauth-Credential header instead.
const HIDDEN_IN_MULTIPART = ['credential', 'password'];

const cache = new Map<string, Type<unknown>>();

function buildMultipartDto<T>(dto: Type<T>, fields: MediaFieldSpec[]): Type<unknown> {
  const cacheKey = `${dto.name}:${fields.map((f) => f.name).join(',')}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const omitted = [...fields.map((f) => f.name), ...HIDDEN_IN_MULTIPART];

  // Cast: with a generic `dto`, OmitType's return type has no statically known
  // members, and TS refuses to extend it (TS2509).
  const Base = OmitType(dto, omitted as never[]) as Type<object>;
  class Multipart extends Base {}
  Object.defineProperty(Multipart, 'name', { value: `${dto.name}Multipart` });

  for (const field of fields) {
    ApiPropertyOptional(
      field.multiple
        ? {
            type: 'array',
            items: { type: 'string', format: 'binary' },
            description: `Pick one or more ${field.folder} files (max ${MAX_FILES_PER_FIELD}). They are uploaded for you and the keys are saved on the record.`,
          }
        : {
            type: 'string',
            format: 'binary',
            description: `Pick one ${field.folder} file. It is uploaded for you and its key is saved.`,
          },
    )(Multipart.prototype, field.name);
  }

  cache.set(cacheKey, Multipart);
  return Multipart;
}

/**
 * Adds real file pickers in Swagger to an endpoint that takes object keys.
 * The endpoint still accepts normal JSON with keys (frontend presigned flow).
 * Keep @Body() typed with the ORIGINAL dto.
 *
 *   @MediaUpload(CreatePostDto)                                   // photo/video/audio/pdf/document/other
 *   @MediaUpload(UpdateProfilePictureDto, PROFILE_PICTURE_FIELDS) // single `filepath`
 */
export function MediaUpload<T>(dto: Type<T>, fields: MediaFieldSpec[] = DEFAULT_MEDIA_FIELDS) {
  return applyDecorators(
    SetMetadata(MEDIA_UPLOAD_FIELDS_KEY, fields),
    ApiConsumes('multipart/form-data', 'application/json'),
    ApiBody({ type: buildMultipartDto(dto, fields) }),
    UseInterceptors(
      FileFieldsInterceptor(
        fields.map((f) => ({ name: f.name, maxCount: f.multiple ? MAX_FILES_PER_FIELD : 1 })),
        { limits: { fileSize: MAX_UPLOAD_BYTES } },
      ),
      MediaUploadInterceptor,
    ),
  );
}