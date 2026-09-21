import { createHash } from 'crypto';
import { promisify } from 'util';
import { gzip } from 'zlib';
import { Injectable, Logger } from '@nestjs/common';
import { AuditLog } from '@prisma/client';

import { MinioService } from 'src/services/minio/minio.service';

import { AuditArchiveStorage, AuditArchiveWriter } from './audit-archive.storage';

const gzipAsync = promisify(gzip);

/**
 * Everything lives under this prefix in the existing bucket:
 *
 *   audit-archive/<runId>/part-00001.ndjson.gz   (one object per write() batch)
 *   audit-archive/<runId>/manifest.json          (written LAST)
 *
 * The manifest is written only after every part is uploaded and size-checked, so
 * "manifest exists" means "archive is complete". A run without a manifest is
 * incomplete and safe to delete.
 *
 * Each part is newline-delimited JSON, gzipped, one full unredacted AuditLog row per line.
 */
const ARCHIVE_PREFIX = 'audit-archive';

type PartInfo = { key: string; rows: number; bytes: number; sha256: string };

@Injectable()
export class MinioAuditArchiveStorage implements AuditArchiveStorage {
  private readonly logger = new Logger(MinioAuditArchiveStorage.name);

  constructor(private readonly minio: MinioService) {}

  async open(meta: { runId: string; cutoff: string }): Promise<AuditArchiveWriter> {
    // Fails fast (before any row is read) if MinIO is not configured or unreachable.
    await this.minio.ensureBucket();

    const prefix = `${ARCHIVE_PREFIX}/${meta.runId}`;
    const manifestKey = `${prefix}/manifest.json`;
    const parts: PartInfo[] = [];
    let totalRows = 0;

    /** Uploads one object, then confirms MinIO really holds the bytes we sent. */
    const putVerified = async (key: string, body: Buffer, contentType: string) => {
      await this.minio.uploadFile(key, body, contentType);
      const stat = await this.minio.statObject(key);
      if (stat.size !== body.length) {
        throw new Error(`archive_size_mismatch key=${key} expected=${body.length} actual=${stat.size}`);
      }
    };

    return {
      write: async (rows: AuditLog[]) => {
        if (rows.length === 0) return;

        const ndjson = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
        const body = await gzipAsync(Buffer.from(ndjson, 'utf8'));
        const key = `${prefix}/part-${String(parts.length + 1).padStart(5, '0')}.ndjson.gz`;

        // Recorded before the upload so abort() also removes a part whose verification failed.
        parts.push({
          key,
          rows: rows.length,
          bytes: body.length,
          sha256: createHash('sha256').update(body).digest('hex'),
        });
        totalRows += rows.length;

        await putVerified(key, body, 'application/gzip');
      },

      finish: async () => {
        const manifest = {
          format: 'ndjson.gz',
          table: 'audit_log',
          runId: meta.runId,
          cutoff: meta.cutoff,
          createdAt: new Date().toISOString(),
          totalRows,
          parts,
        };

        await putVerified(manifestKey, Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'application/json');
        this.logger.log(`Audit archive complete: ${manifestKey} (${totalRows} rows, ${parts.length} parts)`);

        return { key: manifestKey };
      },

      abort: async () => {
        for (const key of [...parts.map((p) => p.key), manifestKey]) {
          try {
            await this.minio.deleteFile(key);
          } catch (err) {
            this.logger.warn(`Could not remove partial archive object ${key}: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      },
    };
  }
}