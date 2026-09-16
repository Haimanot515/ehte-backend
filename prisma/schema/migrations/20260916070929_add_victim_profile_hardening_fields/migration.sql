/*
  Warnings:

  - A unique constraint covering the columns `[userId,idempotencyKey]` on the table `missing_person` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,idempotencyKey]` on the table `report` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[createdByUserId,idempotencyKey]` on the table `victim_profile` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "missing_person" ADD COLUMN     "childSafetyFirstConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "childSafetyFirstConfirmedByUserId" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedByUserId" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "mediaTotalBytes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ownerSuspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "report" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "mediaTotalBytes" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "ownerSuspendedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "victim_profile" ADD COLUMN     "childSafetyFirstConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "childSafetyFirstConfirmedByUserId" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedByUserId" TEXT,
ADD COLUMN     "createdByUserId" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "mediaTotalBytes" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "missing_person_status_createdAt_idx" ON "missing_person"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "missing_person_userId_idempotencyKey_key" ON "missing_person"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "report_status_createdAt_idx" ON "report"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "report_userId_idempotencyKey_key" ON "report"("userId", "idempotencyKey");

-- CreateIndex
CREATE INDEX "victim_profile_status_createdAt_idx" ON "victim_profile"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "victim_profile_createdByUserId_idempotencyKey_key" ON "victim_profile"("createdByUserId", "idempotencyKey");
