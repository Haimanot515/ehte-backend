-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('USER', 'ADMIN', 'SUPER_ADMIN', 'SYSTEM');

-- CreateEnum
CREATE TYPE "InformationStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'REVIEWED', 'REJECTED');

-- CreateEnum
CREATE TYPE "MissingPersonType" AS ENUM ('WOMAN', 'CHILD');

-- CreateEnum
CREATE TYPE "MissingPersonStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'APPROVED', 'REJECTED', 'FOUND');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('GENERAL', 'REPORT_RECEIVED', 'REPORT_UPDATED', 'MORE_INFORMATION_REQUESTED', 'POST_APPROVED', 'POST_REJECTED', 'MISSING_PERSON_UPDATED', 'NEW_MISSING_PERSON_INFORMATION', 'SUPPORT_PAYMENT_CONFIRMED', 'NEW_REPORT', 'HIGH_PRIORITY_REPORT', 'NEW_POST', 'NEW_MISSING_PERSON_REQUEST', 'SECURITY_ALERT');

-- CreateEnum
CREATE TYPE "PostType" AS ENUM ('INCIDENT', 'AWARENESS');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('DRAFT', 'PENDING', 'APPROVED', 'PUBLISHED', 'REJECTED', 'UNPUBLISHED', 'CHANGES_REQUESTED');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('PENDING', 'RECEIVED', 'UNDER_REVIEW', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED', 'CLOSED', 'UNABLE_TO_VERIFY', 'REJECTED');

-- CreateEnum
CREATE TYPE "SupportType" AS ENUM ('FINANCIAL', 'NON_FINANCIAL', 'OTHER');

-- CreateEnum
CREATE TYPE "SupportStatus" AS ENUM ('PENDING', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "SupportAgreementType" AS ENUM ('DIRECT', 'PARTNER_ORGANIZATION', 'INSTITUTIONAL');

-- CreateEnum
CREATE TYPE "UserOtpPurposeEnum" AS ENUM ('email_verification', 'phone_verification', 'password_reset', 'login_2fa');

-- CreateEnum
CREATE TYPE "VictimProfileStatus" AS ENUM ('PENDING', 'UNDER_REVIEW', 'VERIFIED', 'CONSENT_PENDING', 'APPROVED', 'PUBLISHED', 'REJECTED', 'UNPUBLISHED');

-- CreateTable
CREATE TABLE "audit_log" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "action" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" TEXT,
    "diff" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "information_submission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "missingPersonId" TEXT NOT NULL,
    "information" TEXT NOT NULL,
    "location" TEXT,
    "photo" TEXT[],
    "video" TEXT[],
    "audio" TEXT[],
    "pdf" TEXT[],
    "document" TEXT[],
    "other" TEXT[],
    "status" "InformationStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "information_submission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "missing_person" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "personType" "MissingPersonType" NOT NULL,
    "name" TEXT,
    "description" TEXT NOT NULL,
    "dateLastSeen" TIMESTAMP(3) NOT NULL,
    "lastKnownArea" TEXT NOT NULL,
    "photo" TEXT[],
    "video" TEXT[],
    "audio" TEXT[],
    "pdf" TEXT[],
    "document" TEXT[],
    "other" TEXT[],
    "status" "MissingPersonStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "missing_person_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification" (
    "id" TEXT NOT NULL,
    "userId" TEXT,
    "type" "NotificationType" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "isRead" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permission" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "post" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "title" TEXT,
    "content" TEXT NOT NULL,
    "type" "PostType" NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "photo" TEXT[],
    "video" TEXT[],
    "audio" TEXT[],
    "pdf" TEXT[],
    "document" TEXT[],
    "other" TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "post_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "report" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "caseReference" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "location" TEXT,
    "incidentAt" TIMESTAMP(3),
    "photo" TEXT[],
    "video" TEXT[],
    "audio" TEXT[],
    "pdf" TEXT[],
    "document" TEXT[],
    "other" TEXT[],
    "status" "ReportStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role_permission" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,

    CONSTRAINT "role_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "role" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "refreshToken" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "support" (
    "id" TEXT NOT NULL,
    "victimProfileId" TEXT NOT NULL,
    "userId" TEXT,
    "type" "SupportType" NOT NULL DEFAULT 'FINANCIAL',
    "status" "SupportStatus" NOT NULL DEFAULT 'PENDING',
    "agreementType" "SupportAgreementType" NOT NULL DEFAULT 'DIRECT',
    "amount" DECIMAL(12,2),
    "recipientAmount" DECIMAL(12,2),
    "organizationAmount" DECIMAL(12,2),
    "platformAmount" DECIMAL(12,2),
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "support_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_otps" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "purpose" "UserOtpPurposeEnum" NOT NULL,
    "otpHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_otps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_role" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "phone" TEXT NOT NULL,
    "password" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "discreetModeEnabled" BOOLEAN NOT NULL DEFAULT false,
    "discreetModeUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "victim_profile" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "description" TEXT,
    "story" TEXT,
    "supportType" "SupportType",
    "supportGoal" DECIMAL(12,2),
    "photo" TEXT[],
    "video" TEXT[],
    "audio" TEXT[],
    "pdf" TEXT[],
    "document" TEXT[],
    "other" TEXT[],
    "involvesChild" BOOLEAN NOT NULL DEFAULT false,
    "status" "VictimProfileStatus" NOT NULL DEFAULT 'PENDING',
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "isSafetyReviewed" BOOLEAN NOT NULL DEFAULT false,
    "hasConsent" BOOLEAN NOT NULL DEFAULT false,
    "consentAt" TIMESTAMP(3),
    "consentRecordedBy" TEXT,
    "isPrivacyReviewed" BOOLEAN NOT NULL DEFAULT false,
    "isAdminApproved" BOOLEAN NOT NULL DEFAULT false,
    "isPublished" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "victim_profile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_log_userId_idx" ON "audit_log"("userId");

-- CreateIndex
CREATE INDEX "audit_log_createdAt_idx" ON "audit_log"("createdAt");

-- CreateIndex
CREATE INDEX "audit_log_entity_entityId_idx" ON "audit_log"("entity", "entityId");

-- CreateIndex
CREATE INDEX "audit_log_action_idx" ON "audit_log"("action");

-- CreateIndex
CREATE INDEX "information_submission_userId_idx" ON "information_submission"("userId");

-- CreateIndex
CREATE INDEX "information_submission_missingPersonId_idx" ON "information_submission"("missingPersonId");

-- CreateIndex
CREATE INDEX "information_submission_status_idx" ON "information_submission"("status");

-- CreateIndex
CREATE INDEX "missing_person_userId_idx" ON "missing_person"("userId");

-- CreateIndex
CREATE INDEX "missing_person_status_idx" ON "missing_person"("status");

-- CreateIndex
CREATE INDEX "missing_person_personType_idx" ON "missing_person"("personType");

-- CreateIndex
CREATE INDEX "notification_userId_idx" ON "notification"("userId");

-- CreateIndex
CREATE INDEX "notification_userId_isRead_idx" ON "notification"("userId", "isRead");

-- CreateIndex
CREATE INDEX "notification_type_idx" ON "notification"("type");

-- CreateIndex
CREATE UNIQUE INDEX "permission_name_key" ON "permission"("name");

-- CreateIndex
CREATE INDEX "post_userId_idx" ON "post"("userId");

-- CreateIndex
CREATE INDEX "post_status_idx" ON "post"("status");

-- CreateIndex
CREATE INDEX "post_type_idx" ON "post"("type");

-- CreateIndex
CREATE UNIQUE INDEX "report_caseReference_key" ON "report"("caseReference");

-- CreateIndex
CREATE INDEX "report_userId_idx" ON "report"("userId");

-- CreateIndex
CREATE INDEX "report_status_idx" ON "report"("status");

-- CreateIndex
CREATE INDEX "report_caseReference_idx" ON "report"("caseReference");

-- CreateIndex
CREATE INDEX "role_permission_roleId_idx" ON "role_permission"("roleId");

-- CreateIndex
CREATE INDEX "role_permission_permissionId_idx" ON "role_permission"("permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "role_permission_roleId_permissionId_key" ON "role_permission"("roleId", "permissionId");

-- CreateIndex
CREATE UNIQUE INDEX "role_name_key" ON "role"("name");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");

-- CreateIndex
CREATE INDEX "support_victimProfileId_idx" ON "support"("victimProfileId");

-- CreateIndex
CREATE INDEX "support_userId_idx" ON "support"("userId");

-- CreateIndex
CREATE INDEX "support_status_idx" ON "support"("status");

-- CreateIndex
CREATE INDEX "user_otps_userId_purpose_idx" ON "user_otps"("userId", "purpose");

-- CreateIndex
CREATE INDEX "user_otps_expiresAt_idx" ON "user_otps"("expiresAt");

-- CreateIndex
CREATE INDEX "user_role_userId_idx" ON "user_role"("userId");

-- CreateIndex
CREATE INDEX "user_role_roleId_idx" ON "user_role"("roleId");

-- CreateIndex
CREATE UNIQUE INDEX "user_role_userId_roleId_key" ON "user_role"("userId", "roleId");

-- CreateIndex
CREATE UNIQUE INDEX "user_phone_key" ON "user"("phone");

-- CreateIndex
CREATE INDEX "victim_profile_status_idx" ON "victim_profile"("status");

-- CreateIndex
CREATE INDEX "victim_profile_involvesChild_idx" ON "victim_profile"("involvesChild");

-- AddForeignKey
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_submission" ADD CONSTRAINT "information_submission_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "information_submission" ADD CONSTRAINT "information_submission_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "missing_person" ADD CONSTRAINT "missing_person_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification" ADD CONSTRAINT "notification_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "post" ADD CONSTRAINT "post_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permission" ADD CONSTRAINT "role_permission_permissionId_fkey" FOREIGN KEY ("permissionId") REFERENCES "permission"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support" ADD CONSTRAINT "support_victimProfileId_fkey" FOREIGN KEY ("victimProfileId") REFERENCES "victim_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "support" ADD CONSTRAINT "support_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_otps" ADD CONSTRAINT "user_otps_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_role" ADD CONSTRAINT "user_role_roleId_fkey" FOREIGN KEY ("roleId") REFERENCES "role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
