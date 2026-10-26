-- CreateEnum
CREATE TYPE "PaymentDisputeStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "PaymentDisputeOutcome" AS ENUM ('UPHELD', 'DISMISSED');

-- CreateEnum
CREATE TYPE "RewardClaimAppealStatus" AS ENUM ('OPEN', 'UPHELD', 'DECLINED');

-- AlterTable
ALTER TABLE "audit_saved_filter" ADD COLUMN     "sharedWithAdmins" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "disbursements" ADD COLUMN     "heldAt" TIMESTAMP(3),
ADD COLUMN     "heldById" TEXT,
ADD COLUMN     "holdReason" TEXT;

-- AlterTable
ALTER TABLE "notification_broadcast" ADD COLUMN     "approvedAt" TIMESTAMP(3),
ADD COLUMN     "approvedById" TEXT,
ADD COLUMN     "rejectedAt" TIMESTAMP(3),
ADD COLUMN     "rejectedById" TEXT,
ADD COLUMN     "rejectionReason" TEXT,
ADD COLUMN     "requiresApproval" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stopRequestedAt" TIMESTAMP(3),
ADD COLUMN     "stopRequestedById" TEXT,
ADD COLUMN     "stoppedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "notification_template" ADD COLUMN     "retiredAt" TIMESTAMP(3),
ADD COLUMN     "retiredById" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "heldAt" TIMESTAMP(3),
ADD COLUMN     "heldById" TEXT,
ADD COLUMN     "holdReason" TEXT,
ADD COLUMN     "refundDecidedById" TEXT,
ADD COLUMN     "refundReference" TEXT,
ADD COLUMN     "refundRequestedAt" TIMESTAMP(3),
ADD COLUMN     "refundRequestedById" TEXT,
ADD COLUMN     "refundedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "payout_destinations" ADD COLUMN     "lastEditedById" TEXT,
ADD COLUMN     "verifiedAt" TIMESTAMP(3),
ADD COLUMN     "verifiedById" TEXT,
ADD COLUMN     "verifiedNote" TEXT;

-- CreateTable
CREATE TABLE "audit_legal_hold" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'FILTER',
    "caseReference" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "filter" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "appliedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedById" TEXT,
    "releaseRequestedById" TEXT,
    "releaseReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_legal_hold_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_approval_request" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "targetKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "payload" JSONB,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "approvedById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_approval_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_purge_schedule" (
    "id" TEXT NOT NULL,
    "olderThan" TIMESTAMP(3) NOT NULL,
    "runAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "createdById" TEXT NOT NULL,
    "cancelledById" TEXT,
    "cancelReason" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "purgeRunId" TEXT,
    "error" TEXT,
    "executedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_purge_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_retention_policy" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "retentionDays" INTEGER NOT NULL,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_retention_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_integrity_run" (
    "id" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "requestedById" TEXT,
    "ok" BOOLEAN NOT NULL,
    "complete" BOOLEAN NOT NULL,
    "checked" INTEGER NOT NULL,
    "unchainedRows" INTEGER NOT NULL,
    "rangeFrom" TIMESTAMP(3),
    "rangeTo" TIMESTAMP(3),
    "firstBreak" JSONB,
    "head" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_integrity_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_integrity_schedule" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "intervalHours" INTEGER NOT NULL DEFAULT 24,
    "lastRunAt" TIMESTAMP(3),
    "nextRunAt" TIMESTAMP(3),
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_integrity_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_health_snapshot" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastWriteAt" TIMESTAMP(3),
    "lagSeconds" INTEGER,
    "writeFailures" INTEGER NOT NULL DEFAULT 0,
    "estimatedRows" DOUBLE PRECISION,
    "sizeBytes" DOUBLE PRECISION,
    "unchainedRows" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "audit_health_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_alert_trigger" (
    "id" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,
    "firedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "matchCount" INTEGER NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "sampleIds" JSONB,
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedById" TEXT,
    "acknowledgeNote" TEXT,

    CONSTRAINT "audit_alert_trigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_saved_filter_share" (
    "id" TEXT NOT NULL,
    "filterId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_saved_filter_share_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_disputes" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "payerUserId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "PaymentDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "outcome" "PaymentDisputeOutcome",
    "resolutionNote" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_webhook_events" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL DEFAULT 'chapa',
    "txRef" TEXT,
    "payload" JSONB NOT NULL,
    "result" TEXT NOT NULL,
    "error" TEXT,
    "replayCount" INTEGER NOT NULL DEFAULT 0,
    "lastReplayedAt" TIMESTAMP(3),
    "lastReplayedById" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "payment_webhook_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_claim_appeals" (
    "id" TEXT NOT NULL,
    "claimId" TEXT NOT NULL,
    "informantUserId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "RewardClaimAppealStatus" NOT NULL DEFAULT 'OPEN',
    "decisionNote" TEXT,
    "decidedByUserId" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_claim_appeals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "misc_export_job" (
    "id" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "filter" JSONB,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "partCount" INTEGER NOT NULL DEFAULT 0,
    "fileKeys" JSONB,
    "error" TEXT,
    "expiresAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "misc_export_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_snooze" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "until" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_snooze_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_entity_mute" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_entity_mute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_bounce" (
    "id" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "userId" TEXT,
    "reason" TEXT NOT NULL,
    "providerCode" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "bounceCount" INTEGER NOT NULL DEFAULT 1,
    "firstBouncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastBouncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "clearedById" TEXT,
    "clearNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_bounce_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_setting" (
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_setting_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "notification_queue_state" (
    "channel" TEXT NOT NULL,
    "paused" BOOLEAN NOT NULL DEFAULT false,
    "reason" TEXT,
    "pausedAt" TIMESTAMP(3),
    "pausedById" TEXT,
    "resumedAt" TIMESTAMP(3),
    "resumedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_queue_state_pkey" PRIMARY KEY ("channel")
);

-- CreateIndex
CREATE INDEX "audit_legal_hold_status_createdAt_idx" ON "audit_legal_hold"("status", "createdAt");

-- CreateIndex
CREATE INDEX "audit_legal_hold_caseReference_idx" ON "audit_legal_hold"("caseReference");

-- CreateIndex
CREATE INDEX "audit_approval_request_kind_targetKey_status_idx" ON "audit_approval_request"("kind", "targetKey", "status");

-- CreateIndex
CREATE INDEX "audit_approval_request_status_expiresAt_idx" ON "audit_approval_request"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "audit_purge_schedule_status_runAt_idx" ON "audit_purge_schedule"("status", "runAt");

-- CreateIndex
CREATE UNIQUE INDEX "audit_retention_policy_scope_key_key" ON "audit_retention_policy"("scope", "key");

-- CreateIndex
CREATE INDEX "audit_integrity_run_createdAt_idx" ON "audit_integrity_run"("createdAt");

-- CreateIndex
CREATE INDEX "audit_integrity_run_ok_createdAt_idx" ON "audit_integrity_run"("ok", "createdAt");

-- CreateIndex
CREATE INDEX "audit_health_snapshot_createdAt_idx" ON "audit_health_snapshot"("createdAt");

-- CreateIndex
CREATE INDEX "audit_alert_trigger_alertId_firedAt_idx" ON "audit_alert_trigger"("alertId", "firedAt");

-- CreateIndex
CREATE INDEX "audit_alert_trigger_acknowledgedAt_firedAt_idx" ON "audit_alert_trigger"("acknowledgedAt", "firedAt");

-- CreateIndex
CREATE INDEX "audit_saved_filter_share_userId_idx" ON "audit_saved_filter_share"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "audit_saved_filter_share_filterId_userId_key" ON "audit_saved_filter_share"("filterId", "userId");

-- CreateIndex
CREATE INDEX "payment_disputes_paymentId_idx" ON "payment_disputes"("paymentId");

-- CreateIndex
CREATE INDEX "payment_disputes_status_createdAt_idx" ON "payment_disputes"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payment_disputes_payerUserId_idx" ON "payment_disputes"("payerUserId");

-- CreateIndex
CREATE INDEX "payment_webhook_events_txRef_idx" ON "payment_webhook_events"("txRef");

-- CreateIndex
CREATE INDEX "payment_webhook_events_receivedAt_idx" ON "payment_webhook_events"("receivedAt");

-- CreateIndex
CREATE INDEX "payment_webhook_events_result_idx" ON "payment_webhook_events"("result");

-- CreateIndex
CREATE INDEX "reward_claim_appeals_claimId_idx" ON "reward_claim_appeals"("claimId");

-- CreateIndex
CREATE INDEX "reward_claim_appeals_status_createdAt_idx" ON "reward_claim_appeals"("status", "createdAt");

-- CreateIndex
CREATE INDEX "reward_claim_appeals_informantUserId_idx" ON "reward_claim_appeals"("informantUserId");

-- CreateIndex
CREATE INDEX "misc_export_job_scope_requestedById_createdAt_idx" ON "misc_export_job"("scope", "requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "misc_export_job_status_updatedAt_idx" ON "misc_export_job"("status", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "notification_snooze_userId_key" ON "notification_snooze"("userId");

-- CreateIndex
CREATE INDEX "notification_snooze_until_idx" ON "notification_snooze"("until");

-- CreateIndex
CREATE INDEX "notification_entity_mute_entity_entityId_idx" ON "notification_entity_mute"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_entity_mute_userId_entity_entityId_key" ON "notification_entity_mute"("userId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "notification_bounce_status_lastBouncedAt_idx" ON "notification_bounce"("status", "lastBouncedAt");

-- CreateIndex
CREATE INDEX "notification_bounce_userId_idx" ON "notification_bounce"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "notification_bounce_channel_address_key" ON "notification_bounce"("channel", "address");

-- CreateIndex
CREATE INDEX "payments_refundStatus_idx" ON "payments"("refundStatus");

-- CreateIndex
CREATE INDEX "payments_payerUserId_idx" ON "payments"("payerUserId");

-- AddForeignKey
ALTER TABLE "audit_alert_trigger" ADD CONSTRAINT "audit_alert_trigger_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "audit_alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_saved_filter_share" ADD CONSTRAINT "audit_saved_filter_share_filterId_fkey" FOREIGN KEY ("filterId") REFERENCES "audit_saved_filter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_disputes" ADD CONSTRAINT "payment_disputes_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reward_claim_appeals" ADD CONSTRAINT "reward_claim_appeals_claimId_fkey" FOREIGN KEY ("claimId") REFERENCES "reward_claims"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_snooze" ADD CONSTRAINT "notification_snooze_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_entity_mute" ADD CONSTRAINT "notification_entity_mute_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

