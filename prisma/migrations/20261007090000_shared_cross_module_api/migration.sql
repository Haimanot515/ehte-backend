-- Shared and cross-module API (SH-01 to SH-95): new tables, enums and columns.

-- CreateEnum
CREATE TYPE "SharedRecordType" AS ENUM ('REPORT', 'POST', 'MISSING_PERSON', 'VICTIM_PROFILE', 'INFORMATION_SUBMISSION', 'SUPPORT');

-- CreateEnum
CREATE TYPE "FollowableType" AS ENUM ('MISSING_PERSON', 'VICTIM_PROFILE');

-- CreateEnum
CREATE TYPE "ReferralStatus" AS ENUM ('SENT', 'ACKNOWLEDGED', 'IN_PROGRESS', 'CLOSED');

-- CreateEnum
CREATE TYPE "LegalDocumentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'RETIRED');

-- CreateEnum
CREATE TYPE "HelpTicketStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'WAITING_ON_USER', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "HelpTicketPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "HelpMessageAuthor" AS ENUM ('USER', 'STAFF');

-- CreateEnum
CREATE TYPE "AnnouncementSeverity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AnnouncementEventKind" AS ENUM ('SHOWN', 'CLICKED');

-- CreateEnum
CREATE TYPE "ContentKind" AS ENUM ('FAQ', 'SAFETY_GUIDE');

-- CreateEnum
CREATE TYPE "ContentStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ApiClientStatus" AS ENUM ('ACTIVE', 'REVOKED');

-- CreateEnum
CREATE TYPE "AbuseReportOutcome" AS ENUM ('DISMISS', 'WARN', 'SUSPEND');

-- AlterTable
ALTER TABLE "abuse_report" ADD COLUMN     "details" TEXT,
ADD COLUMN     "evidenceKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "outcome" "AbuseReportOutcome",
ADD COLUMN     "resolutionReason" TEXT,
ADD COLUMN     "resolvedAt" TIMESTAMP(3),
ADD COLUMN     "resolvedById" TEXT,
ADD COLUMN     "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- AlterTable
ALTER TABLE "notification_delivery" ADD COLUMN     "deliveredAt" TIMESTAMP(3),
ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "providerMessageId" TEXT,
ADD COLUMN     "providerStatus" TEXT;

-- CreateTable
CREATE TABLE "staff_note" (
    "id" TEXT NOT NULL,
    "entity" "SharedRecordType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinnedAt" TIMESTAMP(3),
    "pinnedById" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_note_revision" (
    "id" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "editedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "staff_note_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "entity" "SharedRecordType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "status" "ReferralStatus" NOT NULL DEFAULT 'SENT',
    "reason" TEXT NOT NULL,
    "includesSensitive" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ackDueAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closeOutcome" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "referral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_status_event" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "fromStatus" "ReferralStatus",
    "toStatus" "ReferralStatus" NOT NULL,
    "note" TEXT,
    "changedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_status_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_document" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "mediaKey" TEXT NOT NULL,
    "fileName" TEXT,
    "mimeType" TEXT,
    "addedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "referral_details_reveal" (
    "id" TEXT NOT NULL,
    "referralId" TEXT NOT NULL,
    "revealedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "referral_details_reveal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "entity" "FollowableType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "updateKinds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "channels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "follow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_document" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "language" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" "LegalDocumentStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveAt" TIMESTAMP(3) NOT NULL,
    "requiresReacceptance" BOOLEAN NOT NULL DEFAULT false,
    "createdById" TEXT NOT NULL,
    "publishedById" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "legal_document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "legal_acceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "ipAddress" TEXT,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "legal_acceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "help_ticket" (
    "id" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "status" "HelpTicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "HelpTicketPriority" NOT NULL DEFAULT 'NORMAL',
    "linkedEntity" "SharedRecordType",
    "linkedEntityId" TEXT,
    "assignedToId" TEXT,
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "closedAt" TIMESTAMP(3),
    "closedBy" "HelpMessageAuthor",
    "reopenCount" INTEGER NOT NULL DEFAULT 0,
    "ratingScore" INTEGER,
    "ratingComment" TEXT,
    "ratedAt" TIMESTAMP(3),
    "lastMessageAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "help_ticket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "help_ticket_message" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "authorType" "HelpMessageAuthor" NOT NULL,
    "authorId" TEXT,
    "body" TEXT NOT NULL,
    "attachmentKeys" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "help_ticket_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "help_canned_reply" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "category" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "help_canned_reply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement" (
    "id" TEXT NOT NULL,
    "translations" JSONB NOT NULL,
    "severity" "AnnouncementSeverity" NOT NULL DEFAULT 'INFO',
    "audienceRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "regions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "languages" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "linkUrl" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "endedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_dismissal" (
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "dismissedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_dismissal_pkey" PRIMARY KEY ("announcementId","userId")
);

-- CreateTable
CREATE TABLE "announcement_event" (
    "id" TEXT NOT NULL,
    "announcementId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" "AnnouncementEventKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "content_entry" (
    "id" TEXT NOT NULL,
    "kind" "ContentKind" NOT NULL,
    "slug" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'en',
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "category" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "status" "ContentStatus" NOT NULL DEFAULT 'DRAFT',
    "createdById" TEXT NOT NULL,
    "updatedById" TEXT,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "content_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_block" (
    "id" TEXT NOT NULL,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_block_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "provider_event" (
    "id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "eventId" TEXT,
    "providerMessageId" TEXT,
    "eventType" TEXT,
    "payload" JSONB NOT NULL,
    "signatureValid" BOOLEAN NOT NULL DEFAULT true,
    "result" TEXT NOT NULL,
    "error" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "provider_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_client" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "previousSecretHash" TEXT,
    "previousSecretExpiresAt" TIMESTAMP(3),
    "secretRotatedAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ipAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rateLimitPerMinute" INTEGER,
    "institutionId" TEXT,
    "status" "ApiClientStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "api_client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "api_client_call" (
    "id" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "route" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "durationMs" INTEGER,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "api_client_call_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "admin_recent_record" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "entity" "SharedRecordType" NOT NULL,
    "entityId" TEXT NOT NULL,
    "label" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_recent_record_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "abuse_report_status_createdAt_idx" ON "abuse_report"("status", "createdAt");

-- CreateIndex
CREATE INDEX "abuse_report_reporterId_idx" ON "abuse_report"("reporterId");

-- CreateIndex
CREATE INDEX "notification_delivery_providerMessageId_idx" ON "notification_delivery"("providerMessageId");

-- CreateIndex
CREATE INDEX "staff_note_entity_entityId_deletedAt_idx" ON "staff_note"("entity", "entityId", "deletedAt");

-- CreateIndex
CREATE INDEX "staff_note_authorId_createdAt_idx" ON "staff_note"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "staff_note_createdAt_idx" ON "staff_note"("createdAt");

-- CreateIndex
CREATE INDEX "staff_note_revision_noteId_createdAt_idx" ON "staff_note_revision"("noteId", "createdAt");

-- CreateIndex
CREATE INDEX "referral_institutionId_status_idx" ON "referral"("institutionId", "status");

-- CreateIndex
CREATE INDEX "referral_entity_entityId_idx" ON "referral"("entity", "entityId");

-- CreateIndex
CREATE INDEX "referral_status_ackDueAt_idx" ON "referral"("status", "ackDueAt");

-- CreateIndex
CREATE INDEX "referral_createdAt_idx" ON "referral"("createdAt");

-- CreateIndex
CREATE INDEX "referral_status_event_referralId_createdAt_idx" ON "referral_status_event"("referralId", "createdAt");

-- CreateIndex
CREATE INDEX "referral_document_referralId_idx" ON "referral_document"("referralId");

-- CreateIndex
CREATE INDEX "referral_details_reveal_referralId_createdAt_idx" ON "referral_details_reveal"("referralId", "createdAt");

-- CreateIndex
CREATE INDEX "referral_details_reveal_revealedById_idx" ON "referral_details_reveal"("revealedById");

-- CreateIndex
CREATE INDEX "follow_entity_entityId_idx" ON "follow"("entity", "entityId");

-- CreateIndex
CREATE UNIQUE INDEX "follow_userId_entity_entityId_key" ON "follow"("userId", "entity", "entityId");

-- CreateIndex
CREATE INDEX "legal_document_type_language_status_effectiveAt_idx" ON "legal_document"("type", "language", "status", "effectiveAt");

-- CreateIndex
CREATE UNIQUE INDEX "legal_document_type_language_version_key" ON "legal_document"("type", "language", "version");

-- CreateIndex
CREATE INDEX "legal_acceptance_documentId_idx" ON "legal_acceptance"("documentId");

-- CreateIndex
CREATE INDEX "legal_acceptance_userId_documentType_acceptedAt_idx" ON "legal_acceptance"("userId", "documentType", "acceptedAt");

-- CreateIndex
CREATE UNIQUE INDEX "legal_acceptance_userId_documentId_key" ON "legal_acceptance"("userId", "documentId");

-- CreateIndex
CREATE UNIQUE INDEX "help_ticket_reference_key" ON "help_ticket"("reference");

-- CreateIndex
CREATE INDEX "help_ticket_userId_status_idx" ON "help_ticket"("userId", "status");

-- CreateIndex
CREATE INDEX "help_ticket_status_category_createdAt_idx" ON "help_ticket"("status", "category", "createdAt");

-- CreateIndex
CREATE INDEX "help_ticket_assignedToId_status_idx" ON "help_ticket"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "help_ticket_linkedEntity_linkedEntityId_idx" ON "help_ticket"("linkedEntity", "linkedEntityId");

-- CreateIndex
CREATE INDEX "help_ticket_message_ticketId_createdAt_idx" ON "help_ticket_message"("ticketId", "createdAt");

-- CreateIndex
CREATE INDEX "help_canned_reply_language_active_idx" ON "help_canned_reply"("language", "active");

-- CreateIndex
CREATE INDEX "announcement_startsAt_endsAt_idx" ON "announcement"("startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "announcement_endedAt_idx" ON "announcement"("endedAt");

-- CreateIndex
CREATE INDEX "announcement_dismissal_userId_idx" ON "announcement_dismissal"("userId");

-- CreateIndex
CREATE INDEX "announcement_event_announcementId_kind_idx" ON "announcement_event"("announcementId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "announcement_event_announcementId_userId_kind_key" ON "announcement_event"("announcementId", "userId", "kind");

-- CreateIndex
CREATE INDEX "content_entry_kind_language_status_deletedAt_idx" ON "content_entry"("kind", "language", "status", "deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "content_entry_kind_slug_language_key" ON "content_entry"("kind", "slug", "language");

-- CreateIndex
CREATE INDEX "user_block_blockedId_idx" ON "user_block"("blockedId");

-- CreateIndex
CREATE UNIQUE INDEX "user_block_blockerId_blockedId_key" ON "user_block"("blockerId", "blockedId");

-- CreateIndex
CREATE INDEX "provider_event_receivedAt_idx" ON "provider_event"("receivedAt");

-- CreateIndex
CREATE INDEX "provider_event_result_idx" ON "provider_event"("result");

-- CreateIndex
CREATE INDEX "provider_event_providerMessageId_idx" ON "provider_event"("providerMessageId");

-- CreateIndex
CREATE UNIQUE INDEX "provider_event_provider_eventId_key" ON "provider_event"("provider", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "api_client_clientId_key" ON "api_client"("clientId");

-- CreateIndex
CREATE INDEX "api_client_status_idx" ON "api_client"("status");

-- CreateIndex
CREATE INDEX "api_client_call_clientId_createdAt_idx" ON "api_client_call"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "api_client_call_createdAt_idx" ON "api_client_call"("createdAt");

-- CreateIndex
CREATE INDEX "admin_recent_record_adminId_openedAt_idx" ON "admin_recent_record"("adminId", "openedAt");

-- CreateIndex
CREATE UNIQUE INDEX "admin_recent_record_adminId_entity_entityId_key" ON "admin_recent_record"("adminId", "entity", "entityId");

-- AddForeignKey
ALTER TABLE "staff_note_revision" ADD CONSTRAINT "staff_note_revision_noteId_fkey" FOREIGN KEY ("noteId") REFERENCES "staff_note"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral" ADD CONSTRAINT "referral_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_status_event" ADD CONSTRAINT "referral_status_event_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_document" ADD CONSTRAINT "referral_document_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "referral_details_reveal" ADD CONSTRAINT "referral_details_reveal_referralId_fkey" FOREIGN KEY ("referralId") REFERENCES "referral"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow" ADD CONSTRAINT "follow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_acceptance" ADD CONSTRAINT "legal_acceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "legal_acceptance" ADD CONSTRAINT "legal_acceptance_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "legal_document"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_ticket" ADD CONSTRAINT "help_ticket_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "help_ticket_message" ADD CONSTRAINT "help_ticket_message_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "help_ticket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_dismissal" ADD CONSTRAINT "announcement_dismissal_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_dismissal" ADD CONSTRAINT "announcement_dismissal_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_event" ADD CONSTRAINT "announcement_event_announcementId_fkey" FOREIGN KEY ("announcementId") REFERENCES "announcement"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_event" ADD CONSTRAINT "announcement_event_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_block" ADD CONSTRAINT "user_block_blockerId_fkey" FOREIGN KEY ("blockerId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_block" ADD CONSTRAINT "user_block_blockedId_fkey" FOREIGN KEY ("blockedId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "api_client_call" ADD CONSTRAINT "api_client_call_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "api_client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Copy existing victim-profile follows into the generic follow table so SH-21 lists them.
INSERT INTO "follow" ("id", "userId", "entity", "entityId", "createdAt", "updatedAt")
SELECT gen_random_uuid()::text, "userId", 'VICTIM_PROFILE'::"FollowableType", "profileId", "createdAt", CURRENT_TIMESTAMP
FROM "victim_profile_follow"
ON CONFLICT DO NOTHING;
