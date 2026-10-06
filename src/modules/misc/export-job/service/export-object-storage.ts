import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';

import { MinioService } from 'src/infrastructure/minio/minio.service';

/**
 * Object storage used by background exports (notification and audit CSV jobs)
 * and by audit archive retrieval. Provide it under EXPORT_OBJECT_STORAGE:
 *
 *   { provide: EXPORT_OBJECT_STORAGE, useClass: MinioExportObjectStorage }
 */
export const EXPORT_OBJECT_STORAGE = Symbol('EXPORT_OBJECT_STORAGE');

export interface ExportObjectStorage {
  /** Stores one object and confirms the stored size matches. */
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** A link that works for `ttlSeconds` only. */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  /** Reads a small object fully (used for archive manifests). */
  getBuffer(key: string): Promise<Buffer>;
}

/**
 * MinioService methods this file relies on:
 *   known from MinioAuditArchiveStorage: ensureBucket(), uploadFile(key, body, contentType),
 *   statObject(key) -> { size }, deleteFile(key)
 *   NOT visible to me, so called by name below (rename here if yours differ):
 *   presignedGetUrl(key, ttlSeconds) -> Promise<string>
 *   getFileBuffer(key) -> Promise<Buffer>
 * If a name does not exist at runtime the call fails with a clear 503 instead of crashing.
 */
type MinioReadApi = {
  presignedGetUrl?: (key: string, ttlSeconds: number) => Promise<string>;
  getFileBuffer?: (key: string) => Promise<Buffer>;
};

@Injectable()
export class MinioExportObjectStorage implements ExportObjectStorage {
  private readonly logger = new Logger(MinioExportObjectStorage.name);

  constructor(private readonly minio: MinioService) {}

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    await this.minio.ensureBucket();
    await this.minio.uploadFile(key, body, contentType);
    const stat = await this.minio.statObject(key);
    if (stat.size !== body.length) {
      throw new Error(
        `object_size_mismatch key=${key} expected=${body.length} actual=${stat.size}`,
      );
    }
  }

  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    const api = this.minio as unknown as MinioReadApi;
    if (typeof api.presignedGetUrl !== 'function') {
      this.logger.error(
        'MinioService has no presignedGetUrl(key, ttlSeconds): map it in export-object-storage.ts',
      );
      throw new ServiceUnavailableException('object_storage_cannot_create_download_links');
    }
    return api.presignedGetUrl.call(this.minio, key, ttlSeconds);
  }

  async getBuffer(key: string): Promise<Buffer> {
    const api = this.minio as unknown as MinioReadApi;
    if (typeof api.getFileBuffer !== 'function') {
      this.logger.error(
        'MinioService has no getFileBuffer(key): map it in export-object-storage.ts',
      );
      throw new ServiceUnavailableException('object_storage_cannot_read_objects');
    }
    return api.getFileBuffer.call(this.minio, key);
  }
}
