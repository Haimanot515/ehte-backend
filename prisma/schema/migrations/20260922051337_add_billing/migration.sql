-- CreateEnum
CREATE TYPE "AgreementStatus" AS ENUM ('DRAFT', 'ACTIVE', 'RETIRED');

-- CreateEnum
CREATE TYPE "RuleMode" AS ENUM ('PERCENT_BPS', 'FLAT');

-- CreateEnum
CREATE TYPE "DisbursementMethod" AS ENUM ('MANUAL_BANK', 'CHAPA_TRANSFER');

-- CreateEnum
CREATE TYPE "DisbursementStatus" AS ENUM ('PENDING_APPROVAL', 'APPROVED', 'PROCESSING', 'PAID_OUT', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "InstitutionStatus" AS ENUM ('PROSPECT', 'AGREEMENT_SIGNED', 'SUSPENDED');

-- CreateEnum
CREATE TYPE "PaymentType" AS ENUM ('SUPPORT', 'MISSING_PERSON_REWARD');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('PENDING', 'PAID', 'FAILED', 'EXPIRED', 'REVIEW_REQUIRED', 'REFUNDED');

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('RECIPIENT', 'RESPONSIBLE_ORGANIZATION', 'PLATFORM', 'REWARD_BENEFICIARY');

-- CreateEnum
CREATE TYPE "SettlementStatus" AS ENUM ('PENDING', 'PAID_OUT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RewardClaimStatus" AS ENUM ('PENDING', 'APPROVED', 'PAID_OUT', 'REFUND_DUE', 'REFUNDED');

-- AlterTable
ALTER TABLE "support" ADD COLUMN     "agreementId" TEXT,
ADD COLUMN     "agreementVersion" INTEGER,
ADD COLUMN     "allocationSnapshot" JSONB;

-- AlterTable
ALTER TABLE "victim_profile" ADD COLUMN     "agreementId" TEXT;

-- CreateTable
CREATE TABLE "agreements" (
    "id" TEXT NOT NULL,
    "type" "SupportAgreementType" NOT NULL,
    "institutionId" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "status" "AgreementStatus" NOT NULL DEFAULT 'DRAFT',
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveTo" TIMESTAMP(3),
    "approvedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agreements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "allocation_rules" (
    "id" TEXT NOT NULL,
    "agreementId" TEXT NOT NULL,
    "paymentType" "PaymentType" NOT NULL,
    "partyType" "PartyType" NOT NULL,
    "institutionId" TEXT,
    "mode" "RuleMode" NOT NULL,
    "valueBps" INTEGER,
    "flatAmount" DECIMAL(14,2),

    CONSTRAINT "allocation_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "disbursements" (
    "id" TEXT NOT NULL,
    "allocationId" TEXT NOT NULL,
    "method" "DisbursementMethod" NOT NULL,
    "status" "DisbursementStatus" NOT NULL DEFAULT 'PENDING_APPROVAL',
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" TEXT NOT NULL,
    "externalReference" TEXT,
    "createdById" TEXT NOT NULL,
    "approvedById" TEXT,
    "executedById" TEXT,
    "executedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "disbursements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "institutions" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "InstitutionStatus" NOT NULL DEFAULT 'PROSPECT',
    "signedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "institutions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payments" (
    "id" TEXT NOT NULL,
    "type" "PaymentType" NOT NULL,
    "status" "PaymentStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'ETB',
    "txRef" TEXT NOT NULL,
    "chapaReference" TEXT,
    "chapaFee" DECIMAL(14,2),
    "payerUserId" TEXT NOT NULL,
    "victimProfileId" TEXT,
    "supportId" TEXT,
    "missingPersonId" TEXT,
    "agreementId" TEXT,
    "agreementVersion" INTEGER,
    "allocationSnapshot" JSONB NOT NULL,
    "previewShownAt" TIMESTAMP(3) NOT NULL,
    "paidAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_allocations" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "partyType" "PartyType" NOT NULL,
    "institutionId" TEXT,
    "amount" DECIMAL(14,2) NOT NULL,
    "ruleId" TEXT,
    "settlementStatus" "SettlementStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reward_claims" (
    "id" TEXT NOT NULL,
    "missingPersonId" TEXT NOT NULL,
    "informationSubmissionId" TEXT,
    "status" "RewardClaimStatus" NOT NULL DEFAULT 'PENDING',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "closedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "reward_claims_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "allocation_rules_agreementId_paymentType_idx" ON "allocation_rules"("agreementId", "paymentType");

-- CreateIndex
CREATE UNIQUE INDEX "disbursements_reference_key" ON "disbursements"("reference");

-- CreateIndex
CREATE INDEX "disbursements_status_idx" ON "disbursements"("status");

-- CreateIndex
CREATE UNIQUE INDEX "payments_txRef_key" ON "payments"("txRef");

-- CreateIndex
CREATE INDEX "payments_status_createdAt_idx" ON "payments"("status", "createdAt");

-- CreateIndex
CREATE INDEX "payments_victimProfileId_idx" ON "payments"("victimProfileId");

-- CreateIndex
CREATE INDEX "payments_supportId_idx" ON "payments"("supportId");

-- CreateIndex
CREATE INDEX "payments_missingPersonId_idx" ON "payments"("missingPersonId");

-- CreateIndex
CREATE INDEX "payment_allocations_paymentId_idx" ON "payment_allocations"("paymentId");

-- CreateIndex
CREATE UNIQUE INDEX "reward_claims_missingPersonId_key" ON "reward_claims"("missingPersonId");

-- AddForeignKey
ALTER TABLE "agreements" ADD CONSTRAINT "agreements_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "institutions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "allocation_rules" ADD CONSTRAINT "allocation_rules_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "agreements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "disbursements" ADD CONSTRAINT "disbursements_allocationId_fkey" FOREIGN KEY ("allocationId") REFERENCES "payment_allocations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "agreements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_allocations" ADD CONSTRAINT "payment_allocations_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
