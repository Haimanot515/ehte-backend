import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Express, Request } from 'express';
import { Observable } from 'rxjs';

import { MediaFolder } from 'src/common/enums/media-folder.enum';
import { MinioService } from 'src/services/minio/minio.service';

export const MEDIA_UPLOAD_FIELDS_KEY = 'media_upload_fields';
export const MAX_FILES_PER_FIELD = 10;
export const MAX_UPLOAD_BYTES = 52_428_800; // same limit as POST /media/upload

/** One body field that gets a file picker in Swagger. */
export interface MediaFieldSpec {
  /** Body field name the object key(s) are written to, e.g. 'photo', 'filepath'. */
  name: string;
  /** MinIO folder the file is stored under (also decides the MIME check). */
  folder: MediaFolder;
  /** true = string[] of keys, false = one string key. */
  multiple: boolean;
}

// The default: the six media arrays used by missing-person, victim-profile, post, report...
export const DEFAULT_MEDIA_FIELDS: MediaFieldSpec[] = Object.values(MediaFolder).map((folder) => ({
  name: folder,
  folder,
  multiple: true,
}));

// Light sanity check on the declared MIME type. document/other accept anything
// (the services still apply MEDIA_ALLOWED_MIME_TYPES / size rules afterwards).
const MIME_RULES: Partial<Record<MediaFolder, (mime: string) => boolean>> = {
  [MediaFolder.PHOTO]: (m) => m.startsWith('image/'),
  [MediaFolder.VIDEO]: (m) => m.startsWith('video/'),
  [MediaFolder.AUDIO]: (m) => m.startsWith('audio/'),
  [MediaFolder.PDF]: (m) => m === 'application/pdf',
};

type FilesByField = Record<string, Express.Multer.File[]>;

/**
 * Runs AFTER FileFieldsInterceptor (multer). Uploads the picked files to
 * MinIO and writes the resulting object keys into req.body.<field>, so the
 * controller and DTO validation see exactly what the JSON + presigned flow
 * sends. JSON requests pass straight through, so the frontend flow is unchanged.
 */
@Injectable()
export class MediaUploadInterceptor implements NestInterceptor {
  constructor(
    private readonly minio: MinioService,
    private readonly reflector: Reflector,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    const req = context.switchToHttp().getRequest<Request & { files?: FilesByField }>();

    if (!req.is('multipart/form-data')) {
      return next.handle();
    }

    const specs =
      this.reflector.get<MediaFieldSpec[]>(MEDIA_UPLOAD_FIELDS_KEY, context.getHandler()) ??
      DEFAULT_MEDIA_FIELDS;

    // multer gives a null-prototype object with everything as strings.
    const body: Record<string, unknown> = { ...(req.body ?? {}) };
    for (const [name, value] of Object.entries(body)) {
      body[name] = this.coerce(value);
    }

    const uploadedKeys: string[] = [];
    try {
      for (const spec of specs) {
        const files = req.files?.[spec.name] ?? [];

        const rule = MIME_RULES[spec.folder];
        if (rule && files.some((file) => !rule(file.mimetype))) {
          throw new BadRequestException(`invalid_file_type_for_${spec.name}`);
        }

        const newKeys = await Promise.all(
          files.map((file) => this.minio.uploadMulterFile(file, spec.folder)),
        );
        uploadedKeys.push(...newKeys);

        if (spec.multiple) {
          // Keep any keys typed in as text (e.g. from the presigned flow).
          const existing = body[spec.name] === undefined ? [] : ([] as unknown[]).concat(body[spec.name]);
          if (existing.length || newKeys.length) {
            body[spec.name] = [...existing, ...newKeys];
          }
        } else if (newKeys.length) {
          body[spec.name] = newKeys[0];
        }
      }
    } catch (err) {
      // Don't leave half-uploaded objects behind.
      await Promise.allSettled(uploadedKeys.map((key) => this.minio.deleteFile(key)));
      throw err;
    }

    req.body = body;
    return next.handle();
  }

  // Multipart sends everything as text. ValidationPipe's implicit conversion
  // turns "false" into true (Boolean("false")), so booleans must be fixed here.
  private coerce(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    if (value.startsWith('[') || value.startsWith('{')) {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    }
    return value;
  }
}