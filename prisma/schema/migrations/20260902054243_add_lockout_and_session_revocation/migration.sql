-- AlterEnum
ALTER TYPE "UserOtpPurposeEnum" ADD VALUE 'admin_verification';

-- AlterTable
ALTER TABLE "session" ADD COLUMN     "revokedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "support" ADD COLUMN     "transferReference" TEXT;

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "lockedUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "victim_profile" ADD COLUMN     "bankAccountName" TEXT,
ADD COLUMN     "bankAccountNumber" TEXT,
ADD COLUMN     "bankName" TEXT;
