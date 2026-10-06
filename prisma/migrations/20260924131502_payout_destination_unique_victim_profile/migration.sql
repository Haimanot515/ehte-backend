/*
  Warnings:

  - You are about to drop the `support` table. If the table is not empty, all the data it contains will be lost.

*/
-- CreateEnum
CREATE TYPE "PayoutRail" AS ENUM ('BANK', 'TELEBIRR');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PAYMENT_VERIFIED';
ALTER TYPE "NotificationType" ADD VALUE 'REWARD_CLAIM_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'DISBURSEMENT_PAID_OUT';
ALTER TYPE "NotificationType" ADD VALUE 'INSTITUTION_SIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'AGREEMENT_CREATED';
ALTER TYPE "NotificationType" ADD VALUE 'AGREEMENT_ACTIVATED';
ALTER TYPE "NotificationType" ADD VALUE 'AGREEMENT_RETIRED';
ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_AGREEMENT_ASSIGNED';

-- DropForeignKey
ALTER TABLE "support" DROP CONSTRAINT "support_userId_fkey";

-- DropForeignKey
ALTER TABLE "support" DROP CONSTRAINT "support_victimProfileId_fkey";

-- AlterTable
ALTER TABLE "disbursements" ADD COLUMN     "destinationSnapshot" JSONB,
ADD COLUMN     "payoutDestinationId" TEXT;

-- DropTable
DROP TABLE "support";

-- CreateTable
CREATE TABLE "payout_destinations" (
    "id" TEXT NOT NULL,
    "rail" "PayoutRail" NOT NULL,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "telebirrPhone" TEXT,
    "accountHolder" TEXT NOT NULL,
    "isVerified" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "institutionId" TEXT,
    "victimProfileId" TEXT,

    CONSTRAINT "payout_destinations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Support" (
    "id" TEXT NOT NULL,
    "victimProfileId" TEXT NOT NULL,
    "userId" TEXT,
    "type" "SupportType" NOT NULL DEFAULT 'FINANCIAL',
    "status" "SupportStatus" NOT NULL DEFAULT 'PENDING',
    "agreementType" "SupportAgreementType" NOT NULL DEFAULT 'DIRECT',
    "message" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "transferReference" TEXT,
    "agreementId" TEXT,
    "agreementVersion" INTEGER,
    "allocationSnapshot" JSONB,
    "amount" DECIMAL(14,2),
    "recipientAmount" DECIMAL(14,2),
    "organizationAmount" DECIMAL(14,2),
    "platformAmount" DECIMAL(14,2),

    CONSTRAINT "Support_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payout_destinations_victimProfileId_key" ON "payout_destinations"("victimProfileId");

-- CreateIndex
CREATE INDEX "payout_destinations_institutionId_idx" ON "payout_destinations"("institutionId");

-- CreateIndex
CREATE INDEX "Support_victimProfileId_idx" ON "Support"("victimProfileId");

-- CreateIndex
CREATE INDEX "Support_userId_idx" ON "Support"("userId");

-- CreateIndex
CREATE INDEX "Support_status_idx" ON "Support"("status");

-- AddForeignKey
ALTER TABLE "allocation_rules" ADD CONSTRAINT "allocation_rules_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preference" ADD CONSTRAINT "notification_preference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "device_token" ADD CONSTRAINT "device_token_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payerUserId_fkey" FOREIGN KEY ("payerUserId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_victimProfileId_fkey" FOREIGN KEY ("victimProfileId") REFERENCES "victim_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_supportId_fkey" FOREIGN KEY ("supportId") REFERENCES "Support"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payout_destinations" ADD CONSTRAINT "payout_destinations_victimProfileId_fkey" FOREIGN KEY ("victimProfileId") REFERENCES "victim_profile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_payoutDestinationId_fkey" FOREIGN KEY ("payoutDestinationId") REFERENCES "payout_destinations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Support" ADD CONSTRAINT "Support_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "agreements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Support" ADD CONSTRAINT "Support_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Support" ADD CONSTRAINT "Support_victimProfileId_fkey" FOREIGN KEY ("victimProfileId") REFERENCES "victim_profile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "victim_profile" ADD CONSTRAINT "victim_profile_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "agreements"("id") ON DELETE SET NULL ON UPDATE CASCADE;
