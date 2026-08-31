-- AlterEnum
ALTER TYPE "MissingPersonStatus" ADD VALUE 'MORE_INFORMATION_REQUESTED';

-- AlterTable
ALTER TABLE "missing_person" ADD COLUMN     "childSafetyConfirmed" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "reviewNote" TEXT,
ADD COLUMN     "rewardAmount" INTEGER,
ADD COLUMN     "rewardApproved" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "rewardDetails" TEXT,
ADD COLUMN     "rewardOffered" BOOLEAN NOT NULL DEFAULT false;
