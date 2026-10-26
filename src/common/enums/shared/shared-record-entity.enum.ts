import { SharedRecordType } from '@prisma/client';

// Re-exports the Prisma enum so controllers and DTOs share one source of truth
export const SharedRecordEntity = SharedRecordType;
export type SharedRecordEntity = SharedRecordType;
