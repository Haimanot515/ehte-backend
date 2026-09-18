-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


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
