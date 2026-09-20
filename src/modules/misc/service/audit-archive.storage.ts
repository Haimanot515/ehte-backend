import { AuditLog } from '@prisma/client';

/**
 * Cold-storage target for audit rows that are about to be purged.
 * Implement this with your MinIO bucket and provide it under AUDIT_ARCHIVE_STORAGE:
 *
 *   { provide: AUDIT_ARCHIVE_STORAGE, useClass: MinioAuditArchiveStorage }
 *
 * Purge refuses to run until this is provided, and never deletes a row
 * before `finish()` has succeeded.
 *
 * A typical implementation streams the batches as NDJSON into one object
 * (e.g. audit-archive/2026/<runId>.ndjson.gz) and returns that object key.
 */
export const AUDIT_ARCHIVE_STORAGE = Symbol('AUDIT_ARCHIVE_STORAGE');

export interface AuditArchiveWriter {
  /** Append one batch of full rows (unredacted). */
  write(rows: AuditLog[]): Promise<void>;
  /** Flush and close. Must only resolve once the object is durably stored. */
  finish(): Promise<{ key: string }>;
  /** Discard partial output after a failure. */
  abort(): Promise<void>;
}

export interface AuditArchiveStorage {
  open(meta: { runId: string; cutoff: string }): Promise<AuditArchiveWriter>;
}