-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'PASSWORD_CHANGED';
ALTER TYPE "NotificationType" ADD VALUE 'PASSWORD_RESET';
ALTER TYPE "NotificationType" ADD VALUE 'REPORT_ASSIGNED';
ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_REQUEST_RESPONDED';
ALTER TYPE "NotificationType" ADD VALUE 'POST_CHANGES_REQUESTED';
ALTER TYPE "NotificationType" ADD VALUE 'POST_UNPUBLISHED';
ALTER TYPE "NotificationType" ADD VALUE 'MISSING_PERSON_APPROVED';
ALTER TYPE "NotificationType" ADD VALUE 'MISSING_PERSON_REJECTED';
ALTER TYPE "NotificationType" ADD VALUE 'MISSING_PERSON_FOUND';
ALTER TYPE "NotificationType" ADD VALUE 'MISSING_PERSON_MORE_INFORMATION_REQUESTED';

-- AlterEnum
ALTER TYPE "UserOtpPurposeEnum" ADD VALUE 'password_change';
