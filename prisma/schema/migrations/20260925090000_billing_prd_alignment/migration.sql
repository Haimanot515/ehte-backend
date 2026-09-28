-- EHTE BILLIG SYSTEMN alignment pass (Sep 2026):
--   * posting/promotion fees as a payment type + per-object fee state
--   * reward funding method (PROMISE_TO_PAY / PREPAID) + partial funding state
--   * multi-informant reward claims with scoring/splitting (was 1 row per case)
--   * financial-account (payout destination) country/currency
--   * split reward payouts across several disbursements per allocation
--   * agreement refund/cancellation policy + retirement audit fields

-- ── New / extended enums ─────────────────────────────────────────────────

-- AlterEnum (additive only — safe within a transaction)
ALTER TYPE "PaymentType" ADD VALUE 'VICTIM_PROFILE_POSTING_FEE';
ALTER TYPE "PaymentType" ADD VALUE 'MISSING_PERSON_POSTING_FEE';

ALTER TYPE "SettlementStatus" ADD VALUE 'PARTIALLY_PAID_OUT';

ALTER TYPE "MissingPersonStatus" ADD VALUE 'EXPIRED';
ALTER TYPE "MissingPersonStatus" ADD VALUE 'CANCELLED';

-- CreateEnum
CREATE TYPE "RewardFundingMethod" AS ENUM ('PROMISE_TO_PAY', 'PREPAID');

-- CreateEnum
CREATE TYPE "RewardFundingStatus" AS ENUM (
  'UNFUNDED', 'PARTIALLY_FUNDED', 'FULLY_FUNDED',
  'PAYMENT_DUE', 'PAYMENT_OVERDUE', 'PAYMENT_DEFAULTED',
  'REFUND_DUE', 'REFUNDED'
);

-- CreateEnum
CREATE TYPE "PostingFeeStatus" AS ENUM ('NOT_REQUIRED', 'PENDING', 'PAID', 'WAIVED', 'REFUND_DUE', 'REFUNDED');

-- RewardClaimStatus: value set changed (PENDING/APPROVED removed, several added).
-- Postgres cannot rename/drop enum values in place, so swap the type instead of
-- ALTER TYPE ... ADD VALUE, and backfill existing rows via the CASE below.
ALTER TYPE "RewardClaimStatus" RENAME TO "RewardClaimStatus_old";

CREATE TYPE "RewardClaimStatus" AS ENUM (
  'SUBMITTED', 'UNDER_REVIEW', 'VALID', 'INVALID', 'DUPLICATE',
  'ALREADY_KNOWN', 'INELIGIBLE', 'APPROVED_FOR_REWARD', 'REJECTED',
  'PAID_OUT', 'REFUND_DUE', 'REFUNDED'
);

ALTER TABLE "reward_claims" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "reward_claims"
  ALTER COLUMN "status" TYPE "RewardClaimStatus" USING (
    CASE "status"::text
      WHEN 'PENDING' THEN 'SUBMITTED'
      WHEN 'APPROVED' THEN 'APPROVED_FOR_REWARD'
      ELSE "status"::text
    END
  )::"RewardClaimStatus";
ALTER TABLE "reward_claims" ALTER COLUMN "status" SET DEFAULT 'SUBMITTED';

DROP TYPE "RewardClaimStatus_old";

-- ── payments ──────────────────────────────────────────────────────────────

ALTER TABLE "payments"
  ADD COLUMN "fxRate" DECIMAL(18,8),
  ADD COLUMN "fxRateCapturedAt" TIMESTAMP(3),
  ADD COLUMN "settlementCurrency" TEXT,
  ADD COLUMN "idempotencyKey" TEXT,
  ADD COLUMN "refundStatus" TEXT,
  ADD COLUMN "refundAmount" DECIMAL(14,2),
  ADD COLUMN "refundReason" TEXT;

CREATE INDEX "payments_type_missingPersonId_status_idx" ON "payments"("type", "missingPersonId", "status");
CREATE INDEX "payments_type_victimProfileId_status_idx" ON "payments"("type", "victimProfileId", "status");

-- ── agreements ────────────────────────────────────────────────────────────

ALTER TABLE "agreements"
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'ETB',
  ADD COLUMN "refundPolicy" TEXT,
  ADD COLUMN "cancellationPolicy" TEXT,
  ADD COLUMN "retirementReason" TEXT,
  ADD COLUMN "retiredById" TEXT,
  ADD COLUMN "retiredAt" TIMESTAMP(3);

-- ── victim_profile ────────────────────────────────────────────────────────

ALTER TABLE "victim_profile"
  ADD COLUMN "postingFeeAmount" DECIMAL(14,2),
  ADD COLUMN "postingFeeCurrency" TEXT NOT NULL DEFAULT 'ETB',
  ADD COLUMN "postingFeeStatus" "PostingFeeStatus" NOT NULL DEFAULT 'NOT_REQUIRED';

-- ── missing_person ────────────────────────────────────────────────────────

ALTER TABLE "missing_person"
  ADD COLUMN "rewardCurrency" TEXT NOT NULL DEFAULT 'ETB',
  ADD COLUMN "publicRewardVersion" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "rewardConditions" TEXT,
  ADD COLUMN "fundingMethod" "RewardFundingMethod",
  ADD COLUMN "fundingStatus" "RewardFundingStatus" NOT NULL DEFAULT 'UNFUNDED',
  ADD COLUMN "fundedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "reservedAmount" DECIMAL(14,2) NOT NULL DEFAULT 0,
  ADD COLUMN "sponsorUserId" TEXT,
  ADD COLUMN "postingFeeAmount" DECIMAL(14,2),
  ADD COLUMN "postingFeeCurrency" TEXT NOT NULL DEFAULT 'ETB',
  ADD COLUMN "postingFeeStatus" "PostingFeeStatus" NOT NULL DEFAULT 'NOT_REQUIRED',
  ADD COLUMN "timeWeight" INTEGER,
  ADD COLUMN "evidenceWeight" INTEGER,
  ADD COLUMN "credibilityWeight" INTEGER,
  ADD COLUMN "agreementId" TEXT,
  ADD COLUMN "agreementVersion" INTEGER,
  ADD COLUMN "closureReason" TEXT,
  ADD COLUMN "closedAt" TIMESTAMP(3);

CREATE INDEX "missing_person_fundingStatus_idx" ON "missing_person"("fundingStatus");

ALTER TABLE "missing_person"
  ADD CONSTRAINT "missing_person_agreementId_fkey" FOREIGN KEY ("agreementId") REFERENCES "agreements"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ── payout_destinations (financial account) ──────────────────────────────

ALTER TABLE "payout_destinations"
  ADD COLUMN "country" TEXT NOT NULL DEFAULT 'ET',
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'ETB';

-- ── disbursements: split reward payouts ──────────────────────────────────

ALTER TABLE "disbursements"
  ADD COLUMN "rewardClaimId" TEXT,
  ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'ETB',
  ADD COLUMN "fxRate" DECIMAL(18,8);

CREATE INDEX "disbursements_allocationId_idx" ON "disbursements"("allocationId");
CREATE INDEX "disbursements_rewardClaimId_idx" ON "disbursements"("rewardClaimId");

-- ── reward_claims: 1-per-case -> many-per-case, plus scoring/splitting ───

DROP INDEX "reward_claims_missingPersonId_key";

ALTER TABLE "reward_claims"
  ADD COLUMN "informantUserId" TEXT,
  ADD COLUMN "timeScore" INTEGER,
  ADD COLUMN "evidenceScore" INTEGER,
  ADD COLUMN "credibilityScore" INTEGER,
  ADD COLUMN "timeWeight" INTEGER,
  ADD COLUMN "evidenceWeight" INTEGER,
  ADD COLUMN "credibilityWeight" INTEGER,
  ADD COLUMN "weightedScore" DECIMAL(6,2),
  ADD COLUMN "rewardPercentage" DECIMAL(5,2),
  ADD COLUMN "rewardAmount" DECIMAL(14,2),
  ADD COLUMN "agreementId" TEXT,
  ADD COLUMN "agreementVersion" INTEGER,
  ADD COLUMN "duplicateOfClaimId" TEXT,
  ADD COLUMN "decisionReason" TEXT,
  ADD COLUMN "reviewedById" TEXT,
  ADD COLUMN "reviewedAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "reward_claims_missingPersonId_informationSubmissionId_key" ON "reward_claims"("missingPersonId", "informationSubmissionId");
CREATE INDEX "reward_claims_missingPersonId_status_idx" ON "reward_claims"("missingPersonId", "status");
CREATE INDEX "reward_claims_informantUserId_idx" ON "reward_claims"("informantUserId");

ALTER TABLE "reward_claims"
  ADD CONSTRAINT "reward_claims_missingPersonId_fkey" FOREIGN KEY ("missingPersonId") REFERENCES "missing_person"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "disbursements"
  ADD CONSTRAINT "disbursements_rewardClaimId_fkey" FOREIGN KEY ("rewardClaimId") REFERENCES "reward_claims"("id") ON DELETE SET NULL ON UPDATE CASCADE;
