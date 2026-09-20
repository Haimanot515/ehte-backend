/*
  Warnings:

  - A unique constraint covering the columns `[seq]` on the table `audit_log` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[userId,dedupeKey]` on the table `notification` will be added. If there are existing duplicate values, this will fail.
  - Made the column `userId` on table `notification` required. This step will fail if there are existing NULL values in that column.

*/
-- CreateEnum
CREATE TYPE "AuditOutcome" AS ENUM ('SUCCESS', 'FAILURE', 'DENIED');

-- CreateEnum
CREATE TYPE "AuditSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AuditSource" AS ENUM ('WEB', 'MOBILE', 'API', 'SYSTEM');

-- CreateEnum
CREATE TYPE "NotificationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'SUPPORT_PLEDGE_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_DELETED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_GATES_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_CHILD_SAFETY_REVIEWED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_CONSENT_REVOKED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_BANK_DETAILS_UPDATED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_PUBLISHED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_UNPUBLISHED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_RESUBMITTED';
ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_REVIEWED';
ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_REJECTED';

-- AlterEnum
ALTER TYPE "UserOtpPurposeEnum" ADD VALUE 'phone_change';

-- DropIndex
DROP INDEX "audit_log_action_idx";

-- DropIndex
DROP INDEX "audit_log_entity_entityId_idx";

-- DropIndex
DROP INDEX "audit_log_userId_idx";

-- DropIndex
DROP INDEX "notification_userId_idx";

-- AlterTable
ALTER TABLE "audit_log" ADD COLUMN     "actorName" TEXT,
ADD COLUMN     "actorRole" TEXT,
ADD COLUMN     "anonymizedAt" TIMESTAMP(3),
ADD COLUMN     "city" TEXT,
ADD COLUMN     "country" TEXT,
ADD COLUMN     "entityLabel" TEXT,
ADD COLUMN     "hash" TEXT,
ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "legalHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "method" TEXT,
ADD COLUMN     "outcome" "AuditOutcome" NOT NULL DEFAULT 'SUCCESS',
ADD COLUMN     "path" TEXT,
ADD COLUMN     "prevHash" TEXT,
ADD COLUMN     "reason" TEXT,
ADD COLUMN     "requestId" TEXT,
ADD COLUMN     "seq" INTEGER,
ADD COLUMN     "sessionId" TEXT,
ADD COLUMN     "severity" "AuditSeverity" NOT NULL DEFAULT 'INFO',
ADD COLUMN     "source" "AuditSource",
ADD COLUMN     "targetUserId" TEXT,
ADD COLUMN     "userAgent" TEXT;

-- AlterTable
ALTER TABLE "notification" ADD COLUMN     "actionUrl" TEXT,
ADD COLUMN     "actorId" TEXT,
ADD COLUMN     "actorName" TEXT,
ADD COLUMN     "actorRole" TEXT,
ADD COLUMN     "broadcastId" TEXT,
ADD COLUMN     "data" JSONB,
ADD COLUMN     "dedupeKey" TEXT,
ADD COLUMN     "entity" TEXT,
ADD COLUMN     "entityId" TEXT,
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "readAt" TIMESTAMP(3),
ALTER COLUMN "userId" SET NOT NULL;

-- AlterTable
ALTER TABLE "role" ADD COLUMN     "description" TEXT,
ADD COLUMN     "isProtected" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "pendingPhone" TEXT;

-- AlterTable
ALTER TABLE "user_role" ADD COLUMN     "assignedBy" TEXT;

-- AlterTable
ALTER TABLE "victim_profile" ADD COLUMN     "totalRaised" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "audit_export" (
    "id" TEXT NOT NULL,
    "exportedById" TEXT,
    "filter" JSONB,
    "rowCount" INTEGER NOT NULL,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_export_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_saved_filter" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_saved_filter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_alert" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "action" TEXT,
    "entity" TEXT,
    "outcome" "AuditOutcome",
    "severity" "AuditSeverity",
    "threshold" INTEGER NOT NULL,
    "windowMinutes" INTEGER NOT NULL,
    "cooldownMinutes" INTEGER NOT NULL DEFAULT 60,
    "lastTriggeredAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "audit_alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_purge_run" (
    "id" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "cutoff" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedById" TEXT,
    "archiveKey" TEXT,
    "archivedCount" INTEGER NOT NULL DEFAULT 0,
    "deletedCount" INTEGER NOT NULL DEFAULT 0,
    "heldCount" INTEGER NOT NULL DEFAULT 0,
    "minSeq" INTEGER,
    "maxSeq" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "audit_purge_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preference" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "email" BOOLEAN,
    "sms" BOOLEAN,
    "push" BOOLEAN,
    "quietHoursStart" TEXT,
    "quietHoursEnd" TEXT,
    "timezone" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preference_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_delivery" (
    "id" TEXT NOT NULL,
    "notificationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_delivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "device_token" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_token_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_broadcast" (
    "id" TEXT NOT NULL,
    "createdById" TEXT,
    "audience" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "priority" "NotificationPriority" NOT NULL DEFAULT 'NORMAL',
    "templateId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "recipientCount" INTEGER NOT NULL DEFAULT 0,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_broadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_template" (
    "id" TEXT NOT NULL,
    "type" "NotificationType" NOT NULL,
    "language" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_idempotency_key" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "result" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_idempotency_key_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_profile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "region" TEXT,
    "zone" TEXT,
    "city" TEXT,
    "subCity" TEXT,
    "woreda" TEXT,
    "kebele" TEXT,
    "preferredLanguage" TEXT,
    "dateOfBirth" TIMESTAMP(3),
    "gender" TEXT,
    "alternatePhone" TEXT,
    "occupation" TEXT,
    "profilePictureUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_export_createdAt_idx" ON "audit_export"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "audit_saved_filter_userId_name_key" ON "audit_saved_filter"("userId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "audit_purge_run_tokenId_key" ON "audit_purge_run"("tokenId");

-- CreateIndex
CREATE INDEX "notification_preference_userId_idx" ON "notification_preference"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_preference_userId_type_key" ON "notification_preference"("userId", "type");

-- CreateIndex
CREATE INDEX "notification_delivery_status_nextAttemptAt_idx" ON "notification_delivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "notification_delivery_userId_createdAt_idx" ON "notification_delivery"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_delivery_channel_status_idx" ON "notification_delivery"("channel", "status");

-- CreateIndex
CREATE UNIQUE INDEX "notification_delivery_notificationId_channel_key" ON "notification_delivery"("notificationId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "device_token_token_key" ON "device_token"("token");

-- CreateIndex
CREATE INDEX "device_token_userId_idx" ON "device_token"("userId");

-- CreateIndex
CREATE INDEX "notification_broadcast_status_scheduledAt_idx" ON "notification_broadcast"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "notification_broadcast_createdById_createdAt_idx" ON "notification_broadcast"("createdById", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_template_type_language_key" ON "notification_template"("type", "language");

-- CreateIndex
CREATE INDEX "notification_idempotency_key_createdAt_idx" ON "notification_idempotency_key"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_idempotency_key_actorId_key_key" ON "notification_idempotency_key"("actorId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "user_profile_userId_key" ON "user_profile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "audit_log_seq_key" ON "audit_log"("seq");

-- CreateIndex
CREATE INDEX "audit_log_userId_createdAt_idx" ON "audit_log"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_entity_entityId_createdAt_idx" ON "audit_log"("entity", "entityId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_action_createdAt_idx" ON "audit_log"("action", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_outcome_idx" ON "audit_log"("outcome");

-- CreateIndex
CREATE INDEX "audit_log_targetUserId_createdAt_idx" ON "audit_log"("targetUserId", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_ipAddress_idx" ON "audit_log"("ipAddress");

-- CreateIndex
CREATE INDEX "audit_log_requestId_idx" ON "audit_log"("requestId");

-- CreateIndex
CREATE INDEX "audit_log_actorType_idx" ON "audit_log"("actorType");

-- CreateIndex
CREATE INDEX "audit_log_severity_createdAt_idx" ON "audit_log"("severity", "createdAt");

-- CreateIndex
CREATE INDEX "audit_log_sessionId_idx" ON "audit_log"("sessionId");

-- CreateIndex
CREATE INDEX "notification_userId_createdAt_idx" ON "notification"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "notification_userId_readAt_createdAt_idx" ON "notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "notification_expiresAt_idx" ON "notification"("expiresAt");

-- CreateIndex
CREATE INDEX "notification_entity_entityId_idx" ON "notification"("entity", "entityId");

-- CreateIndex
CREATE INDEX "notification_broadcastId_idx" ON "notification"("broadcastId");

-- CreateIndex
CREATE INDEX "notification_actorId_createdAt_idx" ON "notification"("actorId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_userId_dedupeKey_key" ON "notification"("userId", "dedupeKey");

-- CreateIndex
CREATE INDEX "support_victimProfileId_status_idx" ON "support"("victimProfileId", "status");

-- AddForeignKey
ALTER TABLE "notification_delivery" ADD CONSTRAINT "notification_delivery_notificationId_fkey" FOREIGN KEY ("notificationId") REFERENCES "notification"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "notification_broadcast"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_profile" ADD CONSTRAINT "user_profile_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_assignedBy_fkey" FOREIGN KEY ("assignedBy") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;
