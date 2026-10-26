-- CreateEnum
CREATE TYPE "SubmissionChannel" AS ENUM ('APP', 'USSD');

-- AlterTable
ALTER TABLE "information_submission" ADD COLUMN     "channel" "SubmissionChannel" NOT NULL DEFAULT 'APP';

-- AlterTable
ALTER TABLE "missing_person" ADD COLUMN     "channel" "SubmissionChannel" NOT NULL DEFAULT 'APP';

-- AlterTable
ALTER TABLE "report" ADD COLUMN     "channel" "SubmissionChannel" NOT NULL DEFAULT 'APP';

-- CreateIndex
CREATE INDEX "report_channel_idx" ON "report"("channel");
