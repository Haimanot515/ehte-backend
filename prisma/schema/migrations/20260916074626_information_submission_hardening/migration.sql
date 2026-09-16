/*
  Warnings:

  - A unique constraint covering the columns `[userId,idempotencyKey]` on the table `information_submission` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterTable
ALTER TABLE "information_submission" ADD COLUMN     "idempotencyKey" TEXT,
ADD COLUMN     "mediaTotalBytes" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE INDEX "information_submission_status_createdAt_idx" ON "information_submission"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "information_submission_userId_idempotencyKey_key" ON "information_submission"("userId", "idempotencyKey");
