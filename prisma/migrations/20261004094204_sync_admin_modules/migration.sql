-- CreateEnum
CREATE TYPE "AccessReviewStatus" AS ENUM ('OPEN', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "AccessReviewDecision" AS ENUM ('PENDING', 'KEEP', 'REVOKE');

-- CreateEnum
CREATE TYPE "InformationPriority" AS ENUM ('LOW', 'NORMAL', 'HIGH', 'URGENT');

-- CreateEnum
CREATE TYPE "InformationCredibility" AS ENUM ('UNVERIFIED', 'LOW', 'MEDIUM', 'HIGH');

-- CreateEnum
CREATE TYPE "InformationResolution" AS ENUM ('DUPLICATE', 'ALREADY_KNOWN');

-- CreateEnum
CREATE TYPE "InformationTimelineEventType" AS ENUM ('QUESTION_ASKED', 'QUESTION_ANSWERED', 'MESSAGE', 'EVIDENCE_ADDED', 'APPEAL_FILED');

-- CreateEnum
CREATE TYPE "InformationAppealStatus" AS ENUM ('PENDING', 'UPHELD', 'OVERTURNED');

-- CreateEnum
CREATE TYPE "InformationScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "InformationRedactionMode" AS ENUM ('BLUR_FACES', 'BLUR_REGION');

-- CreateEnum
CREATE TYPE "InformationRedactionStatus" AS ENUM ('NONE', 'REQUESTED', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "InformationIdentityAccessKind" AS ENUM ('REVEAL', 'INFORMANT_LOOKUP');

-- CreateEnum
CREATE TYPE "InformationExportJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "LoginResultEnum" AS ENUM ('SUCCESS', 'FAILED', 'LOCKED', 'TWO_FACTOR_REQUIRED');

-- CreateEnum
CREATE TYPE "MissingPersonFlagState" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "MissingPersonAppealState" AS ENUM ('PENDING', 'ACCEPTED', 'DECLINED');

-- CreateEnum
CREATE TYPE "MissingPersonUpdateAuthorType" AS ENUM ('OWNER', 'STAFF');

-- CreateEnum
CREATE TYPE "MissingPersonMessageKind" AS ENUM ('MESSAGE', 'WARNING');

-- CreateEnum
CREATE TYPE "MissingPersonRedactionStatus" AS ENUM ('PENDING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "MissingPersonExportStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "PostFlagStatus" AS ENUM ('OPEN', 'DISMISSED', 'ACTIONED');

-- CreateEnum
CREATE TYPE "PostAppealStatus" AS ENUM ('OPEN', 'UPHELD', 'OVERTURNED');

-- CreateEnum
CREATE TYPE "PostAppealTarget" AS ENUM ('REJECTION', 'TAKEDOWN');

-- CreateEnum
CREATE TYPE "ReportPriority" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "ReportSensitivity" AS ENUM ('STANDARD', 'RESTRICTED', 'CHILD_INVOLVED');

-- CreateEnum
CREATE TYPE "ReportContactMethod" AS ENUM ('IN_APP', 'EMAIL', 'PHONE', 'SMS', 'NONE');

-- CreateEnum
CREATE TYPE "ReportResolutionOutcome" AS ENUM ('RESOLVED', 'NO_ACTION', 'REFERRED', 'UNFOUNDED');

-- CreateEnum
CREATE TYPE "ReportIntegrityFlag" AS ENUM ('SPAM', 'FALSE_REPORT', 'MALICIOUS_FALSE_REPORT');

-- CreateEnum
CREATE TYPE "ReportEvidenceKind" AS ENUM ('PHOTO', 'VIDEO', 'AUDIO', 'PDF', 'DOCUMENT', 'OTHER');

-- CreateEnum
CREATE TYPE "ReportLinkRecordType" AS ENUM ('REPORT', 'MISSING_PERSON', 'VICTIM_PROFILE', 'INFORMATION_SUBMISSION', 'POST');

-- CreateEnum
CREATE TYPE "ReportEmailDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateEnum
CREATE TYPE "ReportErasureRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'DENIED');

-- CreateEnum
CREATE TYPE "ReportExportFormat" AS ENUM ('csv', 'xlsx');

-- CreateEnum
CREATE TYPE "ReportExportJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "RoleAssignmentRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TemporaryAssignmentStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'REVOKED');

-- CreateEnum
CREATE TYPE "SupportDisputeReason" AS ENUM ('NOT_DELIVERED', 'MISMATCH', 'RECIPIENT_DENIES_RECEIPT', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportDisputeStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "SupportDisputeOutcome" AS ENUM ('DELIVERED', 'NOT_DELIVERED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SupportDisputeSide" AS ENUM ('SUPPORTER', 'RECIPIENT');

-- CreateEnum
CREATE TYPE "SupportFlagReason" AS ENUM ('ASKS_FOR_CONTACT', 'ASKS_FOR_PAYMENT', 'ASKS_FOR_MEETING', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportMessageAuthor" AS ENUM ('SUPPORTER', 'STAFF');

-- CreateEnum
CREATE TYPE "SupportAttachmentScanStatus" AS ENUM ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "SupportAttachmentAccessAction" AS ENUM ('VIEWED', 'DOWNLOADED');

-- CreateEnum
CREATE TYPE "SupportExportJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "TwoFactorMethodEnum" AS ENUM ('TOTP', 'SMS');

-- CreateEnum
CREATE TYPE "TwoFactorChallengePurposeEnum" AS ENUM ('LOGIN', 'STEP_UP');

-- CreateEnum
CREATE TYPE "TwoFactorResetRequestStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "VictimProfileFlagStatus" AS ENUM ('OPEN', 'DISMISSED', 'ACTIONED');

-- CreateEnum
CREATE TYPE "VictimProfileAppealStatus" AS ENUM ('OPEN', 'UPHELD', 'OVERTURNED');

-- CreateEnum
CREATE TYPE "VictimProfileExportJobStatus" AS ENUM ('QUEUED', 'RUNNING', 'COMPLETED', 'FAILED', 'EXPIRED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "InformationRequestStatus" ADD VALUE 'ACCEPTED';
ALTER TYPE "InformationRequestStatus" ADD VALUE 'CANCELLED';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_QUESTION_ASKED';
ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_QUESTION_ANSWERED';
ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_MESSAGE';
ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_APPEALED';
ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_ESCALATED';
ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_EVIDENCE_ADDED';

-- AlterEnum
ALTER TYPE "UserOtpPurposeEnum" ADD VALUE 'account_reactivation';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "VictimProfileStatus" ADD VALUE 'CHANGES_REQUESTED';
ALTER TYPE "VictimProfileStatus" ADD VALUE 'WITHDRAWN';
ALTER TYPE "VictimProfileStatus" ADD VALUE 'COMPLETED';

-- AlterTable
ALTER TABLE "Support" ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedReviewerId" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "confirmedAt" TIMESTAMP(3),
ADD COLUMN     "declineReason" TEXT,
ADD COLUMN     "declinedAt" TIMESTAMP(3),
ADD COLUMN     "declinedByUserId" TEXT,
ADD COLUMN     "failedAt" TIMESTAMP(3),
ADD COLUMN     "lastUpdateAt" TIMESTAMP(3),
ADD COLUMN     "recipientOpenedAt" TIMESTAMP(3),
ADD COLUMN     "supporterSeenAt" TIMESTAMP(3),
ADD COLUMN     "thanksSentAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "information_submission" ADD COLUMN     "anonymizedAt" TIMESTAMP(3),
ADD COLUMN     "anonymizedById" TEXT,
ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedById" TEXT,
ADD COLUMN     "assignedToId" TEXT,
ADD COLUMN     "credibility" "InformationCredibility" NOT NULL DEFAULT 'UNVERIFIED',
ADD COLUMN     "credibilityReason" TEXT,
ADD COLUMN     "credibilitySetAt" TIMESTAMP(3),
ADD COLUMN     "credibilitySetById" TEXT,
ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "duplicateOfId" TEXT,
ADD COLUMN     "informantSeenAt" TIMESTAMP(3),
ADD COLUMN     "informantSeenStatus" "InformationStatus" NOT NULL DEFAULT 'PENDING',
ADD COLUMN     "legalHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legalHoldAt" TIMESTAMP(3),
ADD COLUMN     "legalHoldById" TEXT,
ADD COLUMN     "legalHoldReason" TEXT,
ADD COLUMN     "priority" "InformationPriority" NOT NULL DEFAULT 'NORMAL',
ADD COLUMN     "resolution" "InformationResolution";

-- AlterTable
ALTER TABLE "missing_person" ADD COLUMN     "ageGroup" TEXT,
ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedById" TEXT,
ADD COLUMN     "assignedToUserId" TEXT,
ADD COLUMN     "childFlagProposedAt" TIMESTAMP(3),
ADD COLUMN     "childFlagProposedById" TEXT,
ADD COLUMN     "childFlagProposedReason" TEXT,
ADD COLUMN     "childFlagProposedValue" BOOLEAN,
ADD COLUMN     "copiedFromId" TEXT,
ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "deletedPreviousStatus" "MissingPersonStatus",
ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "foundReportConfirmed" BOOLEAN,
ADD COLUMN     "foundReportDate" TIMESTAMP(3),
ADD COLUMN     "foundReportDetails" TEXT,
ADD COLUMN     "foundReportLocation" TEXT,
ADD COLUMN     "foundReportResolvedAt" TIMESTAMP(3),
ADD COLUMN     "foundReportedAt" TIMESTAMP(3),
ADD COLUMN     "gender" TEXT,
ADD COLUMN     "lastRenewedAt" TIMESTAMP(3),
ADD COLUMN     "legalHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legalHoldAt" TIMESTAMP(3),
ADD COLUMN     "legalHoldById" TEXT,
ADD COLUMN     "legalHoldReason" TEXT,
ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "mergedById" TEXT,
ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "ownerLastSeenAt" TIMESTAMP(3),
ADD COLUMN     "renewalCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "takedownAt" TIMESTAMP(3),
ADD COLUMN     "takedownById" TEXT,
ADD COLUMN     "takedownPreviousStatus" "MissingPersonStatus",
ADD COLUMN     "takedownReason" TEXT;

-- AlterTable
ALTER TABLE "post" ADD COLUMN     "takedownAt" TIMESTAMP(3),
ADD COLUMN     "takedownById" TEXT,
ADD COLUMN     "takedownReason" TEXT;

-- AlterTable
ALTER TABLE "report" ADD COLUMN     "archiveReason" TEXT,
ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" TEXT,
ADD COLUMN     "assignedTeamId" TEXT,
ADD COLUMN     "clientCreatedAt" TIMESTAMP(3),
ADD COLUMN     "closedAt" TIMESTAMP(3),
ADD COLUMN     "contactMethod" "ReportContactMethod" NOT NULL DEFAULT 'IN_APP',
ADD COLUMN     "contactWindow" TEXT,
ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "firstRespondedAt" TIMESTAMP(3),
ADD COLUMN     "integrityById" TEXT,
ADD COLUMN     "integrityFlag" "ReportIntegrityFlag",
ADD COLUMN     "integrityFlagAt" TIMESTAMP(3),
ADD COLUMN     "integrityReason" TEXT,
ADD COLUMN     "isAnonymous" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "lastActivityAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "latitude" DOUBLE PRECISION,
ADD COLUMN     "legalHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legalHoldAt" TIMESTAMP(3),
ADD COLUMN     "legalHoldById" TEXT,
ADD COLUMN     "legalHoldReason" TEXT,
ADD COLUMN     "locationAccuracyMeters" DOUBLE PRECISION,
ADD COLUMN     "locationAddress" TEXT,
ADD COLUMN     "locationCapturedAt" TIMESTAMP(3),
ADD COLUMN     "locationNote" TEXT,
ADD COLUMN     "locationVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "locationVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "locationVerifiedById" TEXT,
ADD COLUMN     "longitude" DOUBLE PRECISION,
ADD COLUMN     "mergedAt" TIMESTAMP(3),
ADD COLUMN     "mergedIntoId" TEXT,
ADD COLUMN     "priority" "ReportPriority" NOT NULL DEFAULT 'MEDIUM',
ADD COLUMN     "region" TEXT,
ADD COLUMN     "reporterSeenAt" TIMESTAMP(3),
ADD COLUMN     "reporterUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "resolutionOutcome" "ReportResolutionOutcome",
ADD COLUMN     "resolutionSummary" TEXT,
ADD COLUMN     "resolvedById" TEXT,
ADD COLUMN     "sensitivity" "ReportSensitivity" NOT NULL DEFAULT 'STANDARD',
ADD COLUMN     "splitFromId" TEXT,
ADD COLUMN     "updatesMuted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "updatesMutedUntil" TIMESTAMP(3),
ADD COLUMN     "urgentDetails" TEXT,
ADD COLUMN     "urgentFlaggedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "report_information_request" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "remindCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "remindedAt" TIMESTAMP(3),
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewedAt" TIMESTAMP(3),
ADD COLUMN     "reviewedById" TEXT;

-- AlterTable
ALTER TABLE "role" ADD COLUMN     "archivedAt" TIMESTAMP(3),
ADD COLUMN     "archivedById" TEXT;

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "deviceLabel" TEXT,
ADD COLUMN     "ipAddress" TEXT,
ADD COLUMN     "lastActiveAt" TIMESTAMP(3),
ADD COLUMN     "userAgent" TEXT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "anonymizedAt" TIMESTAMP(3),
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "legalHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "twoFactorRequiredAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "victim_profile" ADD COLUMN     "anonymizedAt" TIMESTAMP(3),
ADD COLUMN     "assignedAt" TIMESTAMP(3),
ADD COLUMN     "assignedReviewerId" TEXT,
ADD COLUMN     "childFlagProposedAt" TIMESTAMP(3),
ADD COLUMN     "childFlagProposedById" TEXT,
ADD COLUMN     "childFlagProposedReason" TEXT,
ADD COLUMN     "childFlagProposedValue" BOOLEAN,
ADD COLUMN     "completedAt" TIMESTAMP(3),
ADD COLUMN     "completionNote" TEXT,
ADD COLUMN     "consentDocuments" TEXT[],
ADD COLUMN     "consentNotes" TEXT,
ADD COLUMN     "consentedBy" TEXT,
ADD COLUMN     "creatorSeenAt" TIMESTAMP(3),
ADD COLUMN     "deleteReason" TEXT,
ADD COLUMN     "deletedAt" TIMESTAMP(3),
ADD COLUMN     "deletedById" TEXT,
ADD COLUMN     "donationsPaused" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "donationsPausedAt" TIMESTAMP(3),
ADD COLUMN     "donationsPausedReason" TEXT,
ADD COLUMN     "featuredAt" TIMESTAMP(3),
ADD COLUMN     "fundingEndsAt" TIMESTAMP(3),
ADD COLUMN     "isFeatured" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legalHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "legalHoldAt" TIMESTAMP(3),
ADD COLUMN     "legalHoldById" TEXT,
ADD COLUMN     "legalHoldReason" TEXT,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "reviewNoteAt" TIMESTAMP(3),
ADD COLUMN     "takedownAt" TIMESTAMP(3),
ADD COLUMN     "takedownById" TEXT,
ADD COLUMN     "takedownReason" TEXT;

-- CreateTable
CREATE TABLE "access_review" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "AccessReviewStatus" NOT NULL DEFAULT 'OPEN',
    "startedById" TEXT NOT NULL,
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "access_review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "access_review_item" (
    "id" TEXT NOT NULL,
    "reviewId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "decision" "AccessReviewDecision" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "note" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "access_review_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "information_admin_read" (
    "submissionId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "information_admin_read_pkey" PRIMARY KEY ("submissionId","adminId")
);

-- CreateTable
CREATE TABLE "information_question" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "askedById" TEXT,
    "question" TEXT NOT NULL,
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "information_question_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "information_timeline_event" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "type" "InformationTimelineEventType" NOT NULL,
    "actorId" TEXT,
    "message" TEXT,
    "data" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "information_timeline_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "information_appeal" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "userId" TEXT,
    "reason" TEXT NOT NULL,
    "status" "InformationAppealStatus" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "information_appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "information_escalation" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "escalatedById" TEXT NOT NULL,
    "priority" "InformationPriority" NOT NULL,
    "note" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "information_escalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "information_attachment" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "size" INTEGER NOT NULL DEFAULT 0,
    "contentType" TEXT,
    "etag" TEXT,
    "sha256" TEXT,
    "scanStatus" "InformationScanStatus" NOT NULL DEFAULT 'PENDING',
    "scannedAt" TIMESTAMP(3),
    "redactionStatus" "InformationRedactionStatus" NOT NULL DEFAULT 'NONE',
    "redactionMode" "InformationRedactionMode",
    "redactionReason" TEXT,
    "redactionById" TEXT,
    "redactionAt" TIMESTAMP(3),
    "redactedKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "information_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "information_revision" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "actorId" TEXT,
    "field" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "information_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "information_access_log" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "information_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "information_identity_access" (
    "id" TEXT NOT NULL,
    "submissionId" TEXT,
    "informantId" TEXT,
    "adminId" TEXT NOT NULL,
    "kind" "InformationIdentityAccessKind" NOT NULL,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "information_identity_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "information_export_job" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "filters" JSONB,
    "status" "InformationExportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "storageKey" TEXT,
    "rowCount" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "information_export_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_attempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "identifier" TEXT NOT NULL,
    "result" "LoginResultEnum" NOT NULL,
    "failureReason" TEXT,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "deviceLabel" TEXT,
    "country" TEXT,
    "city" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_attempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missing_person_read_state" (
    "missingPersonId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_person_read_state_pkey" PRIMARY KEY ("missingPersonId","adminId")
);

-- CreateTable
CREATE TABLE "missing_person_flag" (
    "id" TEXT NOT NULL,
    "missingPersonId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" "MissingPersonFlagState" NOT NULL DEFAULT 'OPEN',
    "resolvedAction" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "resolutionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_person_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missing_person_appeal" (
    "id" TEXT NOT NULL,
    "missingPersonId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "MissingPersonAppealState" NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_person_appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missing_person_update" (
    "id" TEXT NOT NULL,
    "missingPersonId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorType" "MissingPersonUpdateAuthorType" NOT NULL,
    "message" TEXT NOT NULL,
    "photo" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_person_update_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missing_person_message" (
    "id" TEXT NOT NULL,
    "missingPersonId" TEXT NOT NULL,
    "authorId" TEXT,
    "kind" "MissingPersonMessageKind" NOT NULL DEFAULT 'MESSAGE',
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_person_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missing_person_revision" (
    "id" TEXT NOT NULL,
    "missingPersonId" TEXT NOT NULL,
    "field" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "changedById" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_person_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missing_person_redaction" (
    "id" TEXT NOT NULL,
    "missingPersonId" TEXT NOT NULL,
    "mediaKey" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "reason" TEXT,
    "status" "MissingPersonRedactionStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_person_redaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missing_person_view" (
    "id" TEXT NOT NULL,
    "missingPersonId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "viewedOn" DATE NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "missing_person_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missing_person_export_job" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "filter" JSONB,
    "status" "MissingPersonExportStatus" NOT NULL DEFAULT 'PENDING',
    "rowCount" INTEGER NOT NULL DEFAULT 0,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "content" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "missing_person_export_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_read_state" (
    "postId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_read_state_pkey" PRIMARY KEY ("postId","adminId")
);

-- CreateTable
CREATE TABLE "post_flag" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" "PostFlagStatus" NOT NULL DEFAULT 'OPEN',
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post_appeal" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "target" "PostAppealTarget" NOT NULL,
    "message" TEXT NOT NULL,
    "status" "PostAppealStatus" NOT NULL DEFAULT 'OPEN',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "post_appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_evidence" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "kind" "ReportEvidenceKind" NOT NULL,
    "storageKey" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "note" TEXT,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "redactedAt" TIMESTAMP(3),
    "redactedById" TEXT,
    "redactionReason" TEXT,
    "redactedStorageKey" TEXT,
    "redactedRegions" JSONB,
    "removedAt" TIMESTAMP(3),
    "removedById" TEXT,
    "removalReason" TEXT,

    CONSTRAINT "report_evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_evidence_custody" (
    "id" TEXT NOT NULL,
    "evidenceId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "actorId" TEXT,
    "note" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_evidence_custody_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_message" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "authorId" TEXT,
    "authorType" "ActorType" NOT NULL,
    "message" TEXT NOT NULL,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_status_history" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "fromStatus" "ReportStatus",
    "toStatus" "ReportStatus" NOT NULL,
    "changedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_status_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_assignment_history" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "assignedToId" TEXT,
    "assignedById" TEXT,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_assignment_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_revision" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "editedById" TEXT,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_escalation" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "escalatedById" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deEscalatedAt" TIMESTAMP(3),
    "deEscalatedById" TEXT,
    "deEscalationReason" TEXT,

    CONSTRAINT "report_escalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_reopen_request" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "requestedById" TEXT,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "handledAt" TIMESTAMP(3),
    "handledById" TEXT,
    "approved" BOOLEAN,

    CONSTRAINT "report_reopen_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_erasure_request" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "requestedById" TEXT,
    "reason" TEXT,
    "status" "ReportErasureRequestStatus" NOT NULL DEFAULT 'PENDING',
    "handledById" TEXT,
    "handledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_erasure_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_feedback" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "userId" TEXT,
    "rating" INTEGER NOT NULL,
    "comment" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_feedback_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_draft" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_draft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_admin_read" (
    "reportId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_admin_read_pkey" PRIMARY KEY ("reportId","adminId")
);

-- CreateTable
CREATE TABLE "report_watcher" (
    "reportId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_watcher_pkey" PRIMARY KEY ("reportId","adminId")
);

-- CreateTable
CREATE TABLE "report_follow_up" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "remindAt" TIMESTAMP(3) NOT NULL,
    "note" TEXT,
    "notifiedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_follow_up_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_tag" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_tag_on_report" (
    "reportId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "addedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_tag_on_report_pkey" PRIMARY KEY ("reportId","tagId")
);

-- CreateTable
CREATE TABLE "report_saved_view" (
    "id" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_saved_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_link" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "recordType" "ReportLinkRecordType" NOT NULL,
    "recordId" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_link_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_merge" (
    "id" TEXT NOT NULL,
    "sourceReportId" TEXT NOT NULL,
    "targetReportId" TEXT NOT NULL,
    "mergedById" TEXT,
    "reason" TEXT,
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unmergedAt" TIMESTAMP(3),
    "unmergedById" TEXT,
    "unmergeReason" TEXT,

    CONSTRAINT "report_merge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_access_grant" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "grantedById" TEXT,
    "reason" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_access_grant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_access_log" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "userId" TEXT,
    "action" TEXT NOT NULL,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_access_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_reporter_reveal" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "revealedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "ticketRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_reporter_reveal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_email" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "direction" "ReportEmailDirection" NOT NULL,
    "subject" TEXT,
    "body" TEXT NOT NULL,
    "fromAddress" TEXT,
    "toAddress" TEXT,
    "messageId" TEXT,
    "sentById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_email_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report_export_job" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "format" "ReportExportFormat" NOT NULL DEFAULT 'csv',
    "filters" JSONB,
    "status" "ReportExportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "storageKey" TEXT,
    "rowCount" INTEGER,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "report_export_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_assignment_request" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "RoleAssignmentRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "role_assignment_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_temporary_assignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "grantedById" TEXT,
    "reason" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "TemporaryAssignmentStatus" NOT NULL DEFAULT 'ACTIVE',
    "endedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_temporary_assignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_status_event" (
    "id" TEXT NOT NULL,
    "supportId" TEXT NOT NULL,
    "fromStatus" "SupportStatus",
    "toStatus" "SupportStatus" NOT NULL,
    "actorUserId" TEXT,
    "actorType" "ActorType",
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_status_event_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_attachment" (
    "id" TEXT NOT NULL,
    "supportId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "mimeType" TEXT,
    "sizeBytes" INTEGER,
    "sha256" TEXT,
    "scanStatus" "SupportAttachmentScanStatus" NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "uploadedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "removedAt" TIMESTAMP(3),
    "removedByUserId" TEXT,
    "removalReason" TEXT,

    CONSTRAINT "support_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_attachment_access" (
    "id" TEXT NOT NULL,
    "attachmentId" TEXT NOT NULL,
    "userId" TEXT,
    "action" "SupportAttachmentAccessAction" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_attachment_access_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_message" (
    "id" TEXT NOT NULL,
    "supportId" TEXT NOT NULL,
    "authorUserId" TEXT,
    "authorType" "SupportMessageAuthor" NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_dispute" (
    "id" TEXT NOT NULL,
    "supportId" TEXT NOT NULL,
    "supporterUserId" TEXT,
    "raisedByUserId" TEXT,
    "side" "SupportDisputeSide" NOT NULL,
    "reason" "SupportDisputeReason" NOT NULL,
    "details" TEXT NOT NULL,
    "status" "SupportDisputeStatus" NOT NULL DEFAULT 'OPEN',
    "outcome" "SupportDisputeOutcome",
    "resolutionReason" TEXT,
    "resolvedByUserId" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_dispute_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_flag" (
    "id" TEXT NOT NULL,
    "supportId" TEXT NOT NULL,
    "reason" "SupportFlagReason" NOT NULL,
    "details" TEXT,
    "flaggedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supporter_restriction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "restrictedByUserId" TEXT,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "endsAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "liftedByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supporter_restriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_admin_read" (
    "supportId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_admin_read_pkey" PRIMARY KEY ("supportId","adminId")
);

-- CreateTable
CREATE TABLE "support_revision" (
    "id" TEXT NOT NULL,
    "supportId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "field" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support_export_job" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "filters" JSONB,
    "status" "SupportExportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "rowCount" INTEGER,
    "csv" TEXT,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "support_export_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_secret" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" "TwoFactorMethodEnum" NOT NULL DEFAULT 'TOTP',
    "secretEncrypted" TEXT NOT NULL,
    "isEnabled" BOOLEAN NOT NULL DEFAULT false,
    "confirmedAt" TIMESTAMP(3),
    "lastUsedStep" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "two_factor_secret_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_recovery_code" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_recovery_code_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_challenge" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "TwoFactorChallengePurposeEnum" NOT NULL DEFAULT 'LOGIN',
    "methods" "TwoFactorMethodEnum"[],
    "smsCodeHash" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "two_factor_challenge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_reset_request" (
    "id" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "TwoFactorResetRequestStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewNote" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "two_factor_reset_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "two_factor_policy" (
    "id" TEXT NOT NULL DEFAULT 'default',
    "adminRequired" BOOLEAN NOT NULL DEFAULT true,
    "userRequired" BOOLEAN NOT NULL DEFAULT false,
    "graceDays" INTEGER NOT NULL DEFAULT 7,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "two_factor_policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_deletion_request" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "scheduledFor" TIMESTAMP(3) NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_deletion_request_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_restriction" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "ability" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "endsAt" TIMESTAMP(3),
    "liftedAt" TIMESTAMP(3),
    "liftedById" TEXT,
    "liftReason" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_restriction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_warning" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "issuedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_warning_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_consent" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "document" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_export_job" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "filters" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "rowCount" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "resultCsv" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),

    CONSTRAINT "user_export_job_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "abuse_report" (
    "id" TEXT NOT NULL,
    "targetUserId" TEXT,
    "reporterId" TEXT,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "abuse_report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "victim_profile_read_state" (
    "profileId" TEXT NOT NULL,
    "adminId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "victim_profile_read_state_pkey" PRIMARY KEY ("profileId","adminId")
);

-- CreateTable
CREATE TABLE "victim_profile_update" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "authorId" TEXT,
    "isStaff" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "victim_profile_update_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "victim_profile_flag" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "reporterId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "details" TEXT,
    "status" "VictimProfileFlagStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" TEXT,
    "resolvedById" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "victim_profile_flag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "victim_profile_appeal" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "VictimProfileAppealStatus" NOT NULL DEFAULT 'OPEN',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "victim_profile_appeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "victim_profile_follow" (
    "profileId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "victim_profile_follow_pkey" PRIMARY KEY ("profileId","userId")
);

-- CreateTable
CREATE TABLE "victim_profile_view" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "victim_profile_view_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "victim_profile_revision" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "editedById" TEXT,
    "reason" TEXT NOT NULL,
    "changes" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "victim_profile_revision_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "victim_profile_export_job" (
    "id" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "filters" JSONB,
    "status" "VictimProfileExportJobStatus" NOT NULL DEFAULT 'QUEUED',
    "storageKey" TEXT,
    "rowCount" INTEGER,
    "truncated" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "victim_profile_export_job_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "access_review_status_idx" ON "access_review"("status");

-- CreateIndex
CREATE INDEX "access_review_startedById_idx" ON "access_review"("startedById");

-- CreateIndex
CREATE INDEX "access_review_item_reviewId_decision_idx" ON "access_review_item"("reviewId", "decision");

-- CreateIndex
CREATE INDEX "access_review_item_userId_idx" ON "access_review_item"("userId");

-- CreateIndex
CREATE INDEX "access_review_item_roleId_idx" ON "access_review_item"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "access_review_item_reviewId_userId_roleId_key" ON "access_review_item"("reviewId", "userId", "roleId");

-- CreateIndex
CREATE INDEX "information_admin_read_adminId_idx" ON "information_admin_read"("adminId");

-- CreateIndex
CREATE INDEX "information_question_submissionId_answeredAt_idx" ON "information_question"("submissionId", "answeredAt");

-- CreateIndex
CREATE INDEX "information_question_createdAt_idx" ON "information_question"("createdAt");

-- CreateIndex
CREATE INDEX "information_timeline_event_submissionId_createdAt_idx" ON "information_timeline_event"("submissionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "information_appeal_submissionId_key" ON "information_appeal"("submissionId");

-- CreateIndex
CREATE INDEX "information_appeal_status_createdAt_idx" ON "information_appeal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "information_escalation_submissionId_createdAt_idx" ON "information_escalation"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "information_escalation_createdAt_idx" ON "information_escalation"("createdAt");

-- CreateIndex
CREATE INDEX "information_attachment_scanStatus_idx" ON "information_attachment"("scanStatus");

-- CreateIndex
CREATE INDEX "information_attachment_redactionStatus_idx" ON "information_attachment"("redactionStatus");

-- CreateIndex
CREATE UNIQUE INDEX "information_attachment_submissionId_key_key" ON "information_attachment"("submissionId", "key");

-- CreateIndex
CREATE INDEX "information_revision_submissionId_createdAt_idx" ON "information_revision"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "information_access_log_submissionId_createdAt_idx" ON "information_access_log"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "information_access_log_adminId_createdAt_idx" ON "information_access_log"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "information_identity_access_submissionId_createdAt_idx" ON "information_identity_access"("submissionId", "createdAt");

-- CreateIndex
CREATE INDEX "information_identity_access_informantId_createdAt_idx" ON "information_identity_access"("informantId", "createdAt");

-- CreateIndex
CREATE INDEX "information_identity_access_adminId_createdAt_idx" ON "information_identity_access"("adminId", "createdAt");

-- CreateIndex
CREATE INDEX "information_export_job_requestedById_createdAt_idx" ON "information_export_job"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "information_export_job_status_idx" ON "information_export_job"("status");

-- CreateIndex
CREATE INDEX "information_export_job_expiresAt_idx" ON "information_export_job"("expiresAt");

-- CreateIndex
CREATE INDEX "login_attempt_userId_createdAt_idx" ON "login_attempt"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "login_attempt_result_createdAt_idx" ON "login_attempt"("result", "createdAt");

-- CreateIndex
CREATE INDEX "login_attempt_createdAt_idx" ON "login_attempt"("createdAt");

-- CreateIndex
CREATE INDEX "missing_person_read_state_adminId_idx" ON "missing_person_read_state"("adminId");

-- CreateIndex
CREATE INDEX "missing_person_flag_status_createdAt_idx" ON "missing_person_flag"("status", "createdAt");

-- CreateIndex
CREATE INDEX "missing_person_flag_missingPersonId_status_idx" ON "missing_person_flag"("missingPersonId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "missing_person_flag_missingPersonId_reporterId_key" ON "missing_person_flag"("missingPersonId", "reporterId");

-- CreateIndex
CREATE INDEX "missing_person_appeal_status_createdAt_idx" ON "missing_person_appeal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "missing_person_appeal_missingPersonId_idx" ON "missing_person_appeal"("missingPersonId");

-- CreateIndex
CREATE INDEX "missing_person_appeal_authorId_createdAt_idx" ON "missing_person_appeal"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "missing_person_update_missingPersonId_createdAt_idx" ON "missing_person_update"("missingPersonId", "createdAt");

-- CreateIndex
CREATE INDEX "missing_person_update_authorId_idx" ON "missing_person_update"("authorId");

-- CreateIndex
CREATE INDEX "missing_person_message_missingPersonId_createdAt_idx" ON "missing_person_message"("missingPersonId", "createdAt");

-- CreateIndex
CREATE INDEX "missing_person_revision_missingPersonId_createdAt_idx" ON "missing_person_revision"("missingPersonId", "createdAt");

-- CreateIndex
CREATE INDEX "missing_person_redaction_missingPersonId_mediaKey_idx" ON "missing_person_redaction"("missingPersonId", "mediaKey");

-- CreateIndex
CREATE INDEX "missing_person_redaction_status_createdAt_idx" ON "missing_person_redaction"("status", "createdAt");

-- CreateIndex
CREATE INDEX "missing_person_view_missingPersonId_idx" ON "missing_person_view"("missingPersonId");

-- CreateIndex
CREATE UNIQUE INDEX "missing_person_view_missingPersonId_userId_viewedOn_key" ON "missing_person_view"("missingPersonId", "userId", "viewedOn");

-- CreateIndex
CREATE INDEX "missing_person_export_job_requestedById_createdAt_idx" ON "missing_person_export_job"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "missing_person_export_job_expiresAt_idx" ON "missing_person_export_job"("expiresAt");

-- CreateIndex
CREATE INDEX "post_read_state_adminId_idx" ON "post_read_state"("adminId");

-- CreateIndex
CREATE INDEX "post_flag_status_createdAt_idx" ON "post_flag"("status", "createdAt");

-- CreateIndex
CREATE INDEX "post_flag_postId_status_idx" ON "post_flag"("postId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "post_flag_postId_reporterId_key" ON "post_flag"("postId", "reporterId");

-- CreateIndex
CREATE INDEX "post_appeal_status_createdAt_idx" ON "post_appeal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "post_appeal_postId_idx" ON "post_appeal"("postId");

-- CreateIndex
CREATE INDEX "post_appeal_authorId_createdAt_idx" ON "post_appeal"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "report_evidence_reportId_idx" ON "report_evidence"("reportId");

-- CreateIndex
CREATE INDEX "report_evidence_reportId_removedAt_idx" ON "report_evidence"("reportId", "removedAt");

-- CreateIndex
CREATE INDEX "report_evidence_custody_evidenceId_createdAt_idx" ON "report_evidence_custody"("evidenceId", "createdAt");

-- CreateIndex
CREATE INDEX "report_message_reportId_createdAt_idx" ON "report_message"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "report_status_history_reportId_createdAt_idx" ON "report_status_history"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "report_status_history_toStatus_createdAt_idx" ON "report_status_history"("toStatus", "createdAt");

-- CreateIndex
CREATE INDEX "report_assignment_history_reportId_createdAt_idx" ON "report_assignment_history"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "report_assignment_history_assignedToId_createdAt_idx" ON "report_assignment_history"("assignedToId", "createdAt");

-- CreateIndex
CREATE INDEX "report_revision_reportId_createdAt_idx" ON "report_revision"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "report_escalation_reportId_createdAt_idx" ON "report_escalation"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "report_escalation_createdAt_idx" ON "report_escalation"("createdAt");

-- CreateIndex
CREATE INDEX "report_reopen_request_reportId_idx" ON "report_reopen_request"("reportId");

-- CreateIndex
CREATE INDEX "report_reopen_request_createdAt_idx" ON "report_reopen_request"("createdAt");

-- CreateIndex
CREATE INDEX "report_erasure_request_reportId_idx" ON "report_erasure_request"("reportId");

-- CreateIndex
CREATE INDEX "report_erasure_request_status_idx" ON "report_erasure_request"("status");

-- CreateIndex
CREATE UNIQUE INDEX "report_feedback_reportId_key" ON "report_feedback"("reportId");

-- CreateIndex
CREATE INDEX "report_feedback_rating_idx" ON "report_feedback"("rating");

-- CreateIndex
CREATE INDEX "report_draft_userId_updatedAt_idx" ON "report_draft"("userId", "updatedAt");

-- CreateIndex
CREATE INDEX "report_draft_expiresAt_idx" ON "report_draft"("expiresAt");

-- CreateIndex
CREATE INDEX "report_admin_read_adminId_idx" ON "report_admin_read"("adminId");

-- CreateIndex
CREATE INDEX "report_watcher_adminId_idx" ON "report_watcher"("adminId");

-- CreateIndex
CREATE INDEX "report_follow_up_adminId_doneAt_remindAt_idx" ON "report_follow_up"("adminId", "doneAt", "remindAt");

-- CreateIndex
CREATE INDEX "report_follow_up_reportId_idx" ON "report_follow_up"("reportId");

-- CreateIndex
CREATE INDEX "report_follow_up_remindAt_notifiedAt_idx" ON "report_follow_up"("remindAt", "notifiedAt");

-- CreateIndex
CREATE UNIQUE INDEX "report_tag_name_key" ON "report_tag"("name");

-- CreateIndex
CREATE INDEX "report_tag_on_report_tagId_idx" ON "report_tag_on_report"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "report_saved_view_adminId_name_key" ON "report_saved_view"("adminId", "name");

-- CreateIndex
CREATE INDEX "report_link_recordType_recordId_idx" ON "report_link"("recordType", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "report_link_reportId_recordType_recordId_key" ON "report_link"("reportId", "recordType", "recordId");

-- CreateIndex
CREATE INDEX "report_merge_sourceReportId_idx" ON "report_merge"("sourceReportId");

-- CreateIndex
CREATE INDEX "report_merge_targetReportId_idx" ON "report_merge"("targetReportId");

-- CreateIndex
CREATE INDEX "report_access_grant_reportId_revokedAt_idx" ON "report_access_grant"("reportId", "revokedAt");

-- CreateIndex
CREATE INDEX "report_access_grant_adminId_revokedAt_idx" ON "report_access_grant"("adminId", "revokedAt");

-- CreateIndex
CREATE INDEX "report_access_grant_expiresAt_idx" ON "report_access_grant"("expiresAt");

-- CreateIndex
CREATE INDEX "report_access_log_reportId_createdAt_idx" ON "report_access_log"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "report_access_log_userId_createdAt_idx" ON "report_access_log"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "report_reporter_reveal_reportId_createdAt_idx" ON "report_reporter_reveal"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "report_reporter_reveal_revealedById_createdAt_idx" ON "report_reporter_reveal"("revealedById", "createdAt");

-- CreateIndex
CREATE INDEX "report_email_reportId_createdAt_idx" ON "report_email"("reportId", "createdAt");

-- CreateIndex
CREATE INDEX "report_export_job_requestedById_createdAt_idx" ON "report_export_job"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "report_export_job_status_idx" ON "report_export_job"("status");

-- CreateIndex
CREATE INDEX "report_export_job_expiresAt_idx" ON "report_export_job"("expiresAt");

-- CreateIndex
CREATE INDEX "role_assignment_request_status_expiresAt_idx" ON "role_assignment_request"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "role_assignment_request_roleId_idx" ON "role_assignment_request"("roleId");

-- CreateIndex
CREATE INDEX "role_assignment_request_targetUserId_idx" ON "role_assignment_request"("targetUserId");

-- CreateIndex
CREATE INDEX "role_assignment_request_requestedById_idx" ON "role_assignment_request"("requestedById");

-- CreateIndex
CREATE INDEX "role_temporary_assignment_status_expiresAt_idx" ON "role_temporary_assignment"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "role_temporary_assignment_userId_idx" ON "role_temporary_assignment"("userId");

-- CreateIndex
CREATE INDEX "role_temporary_assignment_roleId_idx" ON "role_temporary_assignment"("roleId");

-- CreateIndex
CREATE INDEX "support_status_event_supportId_createdAt_idx" ON "support_status_event"("supportId", "createdAt");

-- CreateIndex
CREATE INDEX "support_status_event_toStatus_createdAt_idx" ON "support_status_event"("toStatus", "createdAt");

-- CreateIndex
CREATE INDEX "support_attachment_supportId_removedAt_idx" ON "support_attachment"("supportId", "removedAt");

-- CreateIndex
CREATE INDEX "support_attachment_supportId_key_idx" ON "support_attachment"("supportId", "key");

-- CreateIndex
CREATE INDEX "support_attachment_access_attachmentId_createdAt_idx" ON "support_attachment_access"("attachmentId", "createdAt");

-- CreateIndex
CREATE INDEX "support_message_supportId_createdAt_idx" ON "support_message"("supportId", "createdAt");

-- CreateIndex
CREATE INDEX "support_dispute_supportId_idx" ON "support_dispute"("supportId");

-- CreateIndex
CREATE INDEX "support_dispute_status_createdAt_idx" ON "support_dispute"("status", "createdAt");

-- CreateIndex
CREATE INDEX "support_dispute_supporterUserId_idx" ON "support_dispute"("supporterUserId");

-- CreateIndex
CREATE INDEX "support_flag_supportId_idx" ON "support_flag"("supportId");

-- CreateIndex
CREATE INDEX "support_flag_reason_createdAt_idx" ON "support_flag"("reason", "createdAt");

-- CreateIndex
CREATE INDEX "supporter_restriction_userId_liftedAt_idx" ON "supporter_restriction"("userId", "liftedAt");

-- CreateIndex
CREATE INDEX "support_admin_read_adminId_idx" ON "support_admin_read"("adminId");

-- CreateIndex
CREATE INDEX "support_revision_supportId_createdAt_idx" ON "support_revision"("supportId", "createdAt");

-- CreateIndex
CREATE INDEX "support_export_job_requestedById_createdAt_idx" ON "support_export_job"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "support_export_job_status_idx" ON "support_export_job"("status");

-- CreateIndex
CREATE INDEX "support_export_job_expiresAt_idx" ON "support_export_job"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "two_factor_secret_userId_key" ON "two_factor_secret"("userId");

-- CreateIndex
CREATE INDEX "two_factor_recovery_code_userId_usedAt_idx" ON "two_factor_recovery_code"("userId", "usedAt");

-- CreateIndex
CREATE INDEX "two_factor_challenge_userId_consumedAt_idx" ON "two_factor_challenge"("userId", "consumedAt");

-- CreateIndex
CREATE INDEX "two_factor_challenge_expiresAt_idx" ON "two_factor_challenge"("expiresAt");

-- CreateIndex
CREATE INDEX "two_factor_reset_request_status_expiresAt_idx" ON "two_factor_reset_request"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "two_factor_reset_request_targetUserId_idx" ON "two_factor_reset_request"("targetUserId");

-- CreateIndex
CREATE INDEX "two_factor_reset_request_requestedById_idx" ON "two_factor_reset_request"("requestedById");

-- CreateIndex
CREATE INDEX "user_deletion_request_userId_status_idx" ON "user_deletion_request"("userId", "status");

-- CreateIndex
CREATE INDEX "user_deletion_request_status_scheduledFor_idx" ON "user_deletion_request"("status", "scheduledFor");

-- CreateIndex
CREATE INDEX "user_restriction_userId_liftedAt_idx" ON "user_restriction"("userId", "liftedAt");

-- CreateIndex
CREATE INDEX "user_warning_userId_idx" ON "user_warning"("userId");

-- CreateIndex
CREATE INDEX "user_consent_userId_idx" ON "user_consent"("userId");

-- CreateIndex
CREATE INDEX "user_export_job_requestedById_idx" ON "user_export_job"("requestedById");

-- CreateIndex
CREATE INDEX "abuse_report_targetUserId_status_idx" ON "abuse_report"("targetUserId", "status");

-- CreateIndex
CREATE INDEX "victim_profile_read_state_adminId_idx" ON "victim_profile_read_state"("adminId");

-- CreateIndex
CREATE INDEX "victim_profile_update_profileId_createdAt_idx" ON "victim_profile_update"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "victim_profile_flag_status_createdAt_idx" ON "victim_profile_flag"("status", "createdAt");

-- CreateIndex
CREATE INDEX "victim_profile_flag_profileId_status_idx" ON "victim_profile_flag"("profileId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "victim_profile_flag_profileId_reporterId_key" ON "victim_profile_flag"("profileId", "reporterId");

-- CreateIndex
CREATE INDEX "victim_profile_appeal_status_createdAt_idx" ON "victim_profile_appeal"("status", "createdAt");

-- CreateIndex
CREATE INDEX "victim_profile_appeal_profileId_idx" ON "victim_profile_appeal"("profileId");

-- CreateIndex
CREATE INDEX "victim_profile_appeal_authorId_createdAt_idx" ON "victim_profile_appeal"("authorId", "createdAt");

-- CreateIndex
CREATE INDEX "victim_profile_follow_userId_idx" ON "victim_profile_follow"("userId");

-- CreateIndex
CREATE INDEX "victim_profile_view_profileId_createdAt_idx" ON "victim_profile_view"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "victim_profile_view_profileId_userId_createdAt_idx" ON "victim_profile_view"("profileId", "userId", "createdAt");

-- CreateIndex
CREATE INDEX "victim_profile_revision_profileId_createdAt_idx" ON "victim_profile_revision"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "victim_profile_export_job_requestedById_createdAt_idx" ON "victim_profile_export_job"("requestedById", "createdAt");

-- CreateIndex
CREATE INDEX "victim_profile_export_job_status_idx" ON "victim_profile_export_job"("status");

-- CreateIndex
CREATE INDEX "victim_profile_export_job_expiresAt_idx" ON "victim_profile_export_job"("expiresAt");

-- CreateIndex
CREATE INDEX "Support_victimProfileId_status_idx" ON "Support"("victimProfileId", "status");

-- CreateIndex
CREATE INDEX "Support_type_status_idx" ON "Support"("type", "status");

-- CreateIndex
CREATE INDEX "Support_status_createdAt_idx" ON "Support"("status", "createdAt");

-- CreateIndex
CREATE INDEX "Support_createdAt_idx" ON "Support"("createdAt");

-- CreateIndex
CREATE INDEX "Support_assignedReviewerId_idx" ON "Support"("assignedReviewerId");

-- CreateIndex
CREATE INDEX "Support_userId_lastUpdateAt_idx" ON "Support"("userId", "lastUpdateAt");

-- CreateIndex
CREATE INDEX "information_submission_userId_status_idx" ON "information_submission"("userId", "status");

-- CreateIndex
CREATE INDEX "information_submission_missingPersonId_status_idx" ON "information_submission"("missingPersonId", "status");

-- CreateIndex
CREATE INDEX "information_submission_assignedToId_status_idx" ON "information_submission"("assignedToId", "status");

-- CreateIndex
CREATE INDEX "information_submission_priority_idx" ON "information_submission"("priority");

-- CreateIndex
CREATE INDEX "information_submission_deletedAt_idx" ON "information_submission"("deletedAt");

-- CreateIndex
CREATE INDEX "information_submission_duplicateOfId_idx" ON "information_submission"("duplicateOfId");

-- CreateIndex
CREATE INDEX "missing_person_assignedToUserId_idx" ON "missing_person"("assignedToUserId");

-- CreateIndex
CREATE INDEX "missing_person_claimedByUserId_idx" ON "missing_person"("claimedByUserId");

-- CreateIndex
CREATE INDEX "missing_person_deletedAt_idx" ON "missing_person"("deletedAt");

-- CreateIndex
CREATE INDEX "missing_person_takedownAt_idx" ON "missing_person"("takedownAt");

-- CreateIndex
CREATE INDEX "missing_person_mergedIntoId_idx" ON "missing_person"("mergedIntoId");

-- CreateIndex
CREATE INDEX "missing_person_foundReportedAt_idx" ON "missing_person"("foundReportedAt");

-- CreateIndex
CREATE INDEX "missing_person_expiresAt_idx" ON "missing_person"("expiresAt");

-- CreateIndex
CREATE INDEX "missing_person_lastKnownArea_idx" ON "missing_person"("lastKnownArea");

-- CreateIndex
CREATE INDEX "post_takedownAt_idx" ON "post"("takedownAt");

-- CreateIndex
CREATE INDEX "report_priority_idx" ON "report"("priority");

-- CreateIndex
CREATE INDEX "report_status_priority_createdAt_idx" ON "report"("status", "priority", "createdAt");

-- CreateIndex
CREATE INDEX "report_assignedTeamId_idx" ON "report"("assignedTeamId");

-- CreateIndex
CREATE INDEX "report_region_idx" ON "report"("region");

-- CreateIndex
CREATE INDEX "report_dueAt_idx" ON "report"("dueAt");

-- CreateIndex
CREATE INDEX "report_lastActivityAt_idx" ON "report"("lastActivityAt");

-- CreateIndex
CREATE INDEX "report_deletedAt_idx" ON "report"("deletedAt");

-- CreateIndex
CREATE INDEX "report_archivedAt_idx" ON "report"("archivedAt");

-- CreateIndex
CREATE INDEX "report_integrityFlag_idx" ON "report"("integrityFlag");

-- CreateIndex
CREATE INDEX "report_mergedIntoId_idx" ON "report"("mergedIntoId");

-- CreateIndex
CREATE INDEX "report_latitude_longitude_idx" ON "report"("latitude", "longitude");

-- CreateIndex
CREATE INDEX "report_information_request_status_dueAt_idx" ON "report_information_request"("status", "dueAt");

-- CreateIndex
CREATE INDEX "role_archivedAt_idx" ON "role"("archivedAt");

-- CreateIndex
CREATE INDEX "session_userId_revokedAt_idx" ON "session"("userId", "revokedAt");

-- CreateIndex
CREATE INDEX "victim_profile_createdByUserId_createdAt_idx" ON "victim_profile"("createdByUserId", "createdAt");

-- CreateIndex
CREATE INDEX "victim_profile_assignedReviewerId_idx" ON "victim_profile"("assignedReviewerId");

-- CreateIndex
CREATE INDEX "victim_profile_claimedByUserId_idx" ON "victim_profile"("claimedByUserId");

-- CreateIndex
CREATE INDEX "victim_profile_deletedAt_idx" ON "victim_profile"("deletedAt");

-- CreateIndex
CREATE INDEX "victim_profile_isFeatured_status_idx" ON "victim_profile"("isFeatured", "status");

-- AddForeignKey
ALTER TABLE "access_review" ADD CONSTRAINT "access_review_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_review_item" ADD CONSTRAINT "access_review_item_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "access_review"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_review_item" ADD CONSTRAINT "access_review_item_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_review_item" ADD CONSTRAINT "access_review_item_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "access_review_item" ADD CONSTRAINT "access_review_item_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_submission" ADD CONSTRAINT "information_submission_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_submission" ADD CONSTRAINT "information_submission_duplicateOfId_fkey" FOREIGN KEY ("duplicateOfId") REFERENCES "information_submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_admin_read" ADD CONSTRAINT "information_admin_read_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "information_submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_admin_read" ADD CONSTRAINT "information_admin_read_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_question" ADD CONSTRAINT "information_question_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "information_submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_timeline_event" ADD CONSTRAINT "information_timeline_event_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "information_submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_appeal" ADD CONSTRAINT "information_appeal_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "information_submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_escalation" ADD CONSTRAINT "information_escalation_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "information_submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_attachment" ADD CONSTRAINT "information_attachment_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "information_submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_revision" ADD CONSTRAINT "information_revision_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "information_submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_access_log" ADD CONSTRAINT "information_access_log_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "information_submission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_identity_access" ADD CONSTRAINT "information_identity_access_submissionId_fkey" FOREIGN KEY ("submissionId") REFERENCES "information_submission"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_export_job" ADD CONSTRAINT "information_export_job_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_attempt" ADD CONSTRAINT "login_attempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person" ADD CONSTRAINT "missing_person_assignedToUserId_fkey" FOREIGN KEY ("assignedToUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person" ADD CONSTRAINT "missing_person_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "missing_person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_read_state" ADD CONSTRAINT "missing_person_read_state_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_read_state" ADD CONSTRAINT "missing_person_read_state_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_flag" ADD CONSTRAINT "missing_person_flag_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_flag" ADD CONSTRAINT "missing_person_flag_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_appeal" ADD CONSTRAINT "missing_person_appeal_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_appeal" ADD CONSTRAINT "missing_person_appeal_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_update" ADD CONSTRAINT "missing_person_update_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_update" ADD CONSTRAINT "missing_person_update_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_message" ADD CONSTRAINT "missing_person_message_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_message" ADD CONSTRAINT "missing_person_message_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_revision" ADD CONSTRAINT "missing_person_revision_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_revision" ADD CONSTRAINT "missing_person_revision_changedById_fkey" FOREIGN KEY ("changedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_redaction" ADD CONSTRAINT "missing_person_redaction_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_redaction" ADD CONSTRAINT "missing_person_redaction_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_view" ADD CONSTRAINT "missing_person_view_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_view" ADD CONSTRAINT "missing_person_view_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person_export_job" ADD CONSTRAINT "missing_person_export_job_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_read_state" ADD CONSTRAINT "post_read_state_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_read_state" ADD CONSTRAINT "post_read_state_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_flag" ADD CONSTRAINT "post_flag_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_flag" ADD CONSTRAINT "post_flag_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_appeal" ADD CONSTRAINT "post_appeal_postId_fkey" FOREIGN KEY ("postId") REFERENCES "post"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post_appeal" ADD CONSTRAINT "post_appeal_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_mergedIntoId_fkey" FOREIGN KEY ("mergedIntoId") REFERENCES "report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_splitFromId_fkey" FOREIGN KEY ("splitFromId") REFERENCES "report"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_evidence" ADD CONSTRAINT "report_evidence_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_evidence_custody" ADD CONSTRAINT "report_evidence_custody_evidenceId_fkey" FOREIGN KEY ("evidenceId") REFERENCES "report_evidence"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_message" ADD CONSTRAINT "report_message_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_status_history" ADD CONSTRAINT "report_status_history_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_assignment_history" ADD CONSTRAINT "report_assignment_history_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_revision" ADD CONSTRAINT "report_revision_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_escalation" ADD CONSTRAINT "report_escalation_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_reopen_request" ADD CONSTRAINT "report_reopen_request_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_erasure_request" ADD CONSTRAINT "report_erasure_request_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_feedback" ADD CONSTRAINT "report_feedback_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_draft" ADD CONSTRAINT "report_draft_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_admin_read" ADD CONSTRAINT "report_admin_read_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_admin_read" ADD CONSTRAINT "report_admin_read_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_watcher" ADD CONSTRAINT "report_watcher_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_watcher" ADD CONSTRAINT "report_watcher_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_follow_up" ADD CONSTRAINT "report_follow_up_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_follow_up" ADD CONSTRAINT "report_follow_up_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_tag_on_report" ADD CONSTRAINT "report_tag_on_report_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_tag_on_report" ADD CONSTRAINT "report_tag_on_report_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "report_tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_saved_view" ADD CONSTRAINT "report_saved_view_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_link" ADD CONSTRAINT "report_link_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_merge" ADD CONSTRAINT "report_merge_sourceReportId_fkey" FOREIGN KEY ("sourceReportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_access_grant" ADD CONSTRAINT "report_access_grant_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_access_grant" ADD CONSTRAINT "report_access_grant_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_access_log" ADD CONSTRAINT "report_access_log_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_reporter_reveal" ADD CONSTRAINT "report_reporter_reveal_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_email" ADD CONSTRAINT "report_email_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_export_job" ADD CONSTRAINT "report_export_job_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role" ADD CONSTRAINT "role_archivedById_fkey" FOREIGN KEY ("archivedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment_request" ADD CONSTRAINT "role_assignment_request_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment_request" ADD CONSTRAINT "role_assignment_request_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment_request" ADD CONSTRAINT "role_assignment_request_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_assignment_request" ADD CONSTRAINT "role_assignment_request_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_temporary_assignment" ADD CONSTRAINT "role_temporary_assignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_temporary_assignment" ADD CONSTRAINT "role_temporary_assignment_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_temporary_assignment" ADD CONSTRAINT "role_temporary_assignment_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Support" ADD CONSTRAINT "Support_assignedReviewerId_fkey" FOREIGN KEY ("assignedReviewerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_status_event" ADD CONSTRAINT "support_status_event_supportId_fkey" FOREIGN KEY ("supportId") REFERENCES "Support"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_attachment" ADD CONSTRAINT "support_attachment_supportId_fkey" FOREIGN KEY ("supportId") REFERENCES "Support"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_attachment_access" ADD CONSTRAINT "support_attachment_access_attachmentId_fkey" FOREIGN KEY ("attachmentId") REFERENCES "support_attachment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_message" ADD CONSTRAINT "support_message_supportId_fkey" FOREIGN KEY ("supportId") REFERENCES "Support"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_dispute" ADD CONSTRAINT "support_dispute_supportId_fkey" FOREIGN KEY ("supportId") REFERENCES "Support"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_flag" ADD CONSTRAINT "support_flag_supportId_fkey" FOREIGN KEY ("supportId") REFERENCES "Support"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supporter_restriction" ADD CONSTRAINT "supporter_restriction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_admin_read" ADD CONSTRAINT "support_admin_read_supportId_fkey" FOREIGN KEY ("supportId") REFERENCES "Support"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_admin_read" ADD CONSTRAINT "support_admin_read_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_revision" ADD CONSTRAINT "support_revision_supportId_fkey" FOREIGN KEY ("supportId") REFERENCES "Support"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support_export_job" ADD CONSTRAINT "support_export_job_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_secret" ADD CONSTRAINT "two_factor_secret_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_recovery_code" ADD CONSTRAINT "two_factor_recovery_code_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_challenge" ADD CONSTRAINT "two_factor_challenge_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_reset_request" ADD CONSTRAINT "two_factor_reset_request_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_reset_request" ADD CONSTRAINT "two_factor_reset_request_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_reset_request" ADD CONSTRAINT "two_factor_reset_request_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "two_factor_policy" ADD CONSTRAINT "two_factor_policy_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_deletion_request" ADD CONSTRAINT "user_deletion_request_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_restriction" ADD CONSTRAINT "user_restriction_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_warning" ADD CONSTRAINT "user_warning_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_consent" ADD CONSTRAINT "user_consent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "abuse_report" ADD CONSTRAINT "abuse_report_targetUserId_fkey" FOREIGN KEY ("targetUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile" ADD CONSTRAINT "victim_profile_assignedReviewerId_fkey" FOREIGN KEY ("assignedReviewerId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_read_state" ADD CONSTRAINT "victim_profile_read_state_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "victim_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_read_state" ADD CONSTRAINT "victim_profile_read_state_adminId_fkey" FOREIGN KEY ("adminId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_update" ADD CONSTRAINT "victim_profile_update_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "victim_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_update" ADD CONSTRAINT "victim_profile_update_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_flag" ADD CONSTRAINT "victim_profile_flag_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "victim_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_flag" ADD CONSTRAINT "victim_profile_flag_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_appeal" ADD CONSTRAINT "victim_profile_appeal_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "victim_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_appeal" ADD CONSTRAINT "victim_profile_appeal_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_follow" ADD CONSTRAINT "victim_profile_follow_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "victim_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_follow" ADD CONSTRAINT "victim_profile_follow_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_view" ADD CONSTRAINT "victim_profile_view_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "victim_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_view" ADD CONSTRAINT "victim_profile_view_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_revision" ADD CONSTRAINT "victim_profile_revision_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "victim_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_revision" ADD CONSTRAINT "victim_profile_revision_editedById_fkey" FOREIGN KEY ("editedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile_export_job" ADD CONSTRAINT "victim_profile_export_job_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
