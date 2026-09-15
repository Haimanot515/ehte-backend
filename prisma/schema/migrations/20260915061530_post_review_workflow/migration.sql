/*
  Warnings:

  - A unique constraint covering the columns `[userId,idempotencyKey]` on the table `post` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "post" ADD COLUMN     "childSafetyFirstConfirmedAt" TIMESTAMP(3),
ADD COLUMN     "childSafetyFirstConfirmedByUserId" TEXT,
ADD COLUMN     "claimedAt" TIMESTAMP(3),
ADD COLUMN     "claimedByUserId" TEXT,
ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "ownerSuspendedAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "post_claimedByUserId_idx" ON "post"("claimedByUserId");

-- CreateIndex
CREATE INDEX "post_status_createdAt_idx" ON "post"("status", "createdAt");

-- CreateIndex
CREATE INDEX "post_status_updatedAt_idx" ON "post"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "post_userId_idempotencyKey_key" ON "post"("userId", "idempotencyKey");
