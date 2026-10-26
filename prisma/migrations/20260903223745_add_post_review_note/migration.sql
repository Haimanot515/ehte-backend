/*
  Warnings:

  - Changed the type of `category` on the `report` table. No cast exists, the column would be dropped and recreated, which cannot be done if there is data, since the column is required.

*/
-- CreateEnum
CREATE TYPE "ReportCategory" AS ENUM ('HARASSMENT', 'ABUSE', 'FRAUD', 'THREAT', 'DISCRIMINATION', 'SAFETY_CONCERN', 'OTHER');

-- CreateEnum
CREATE TYPE "InformationRequestStatus" AS ENUM ('PENDING', 'RESPONDED');

-- AlterTable
ALTER TABLE "post" ADD COLUMN     "reviewNote" TEXT;

-- AlterTable
ALTER TABLE "report" ADD COLUMN     "assignedToId" TEXT,
DROP COLUMN "category",
ADD COLUMN     "category" "ReportCategory" NOT NULL;

-- CreateTable
CREATE TABLE "report_information_request" (
    "id" TEXT NOT NULL,
    "reportId" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "status" "InformationRequestStatus" NOT NULL DEFAULT 'PENDING',
    "responseMessage" TEXT,
    "responseFiles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "report_information_request_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "report_information_request_reportId_idx" ON "report_information_request"("reportId");

-- CreateIndex
CREATE INDEX "report_information_request_requestedById_idx" ON "report_information_request"("requestedById");

-- CreateIndex
CREATE INDEX "report_information_request_status_idx" ON "report_information_request"("status");

-- CreateIndex
CREATE INDEX "report_assignedToId_idx" ON "report"("assignedToId");

-- CreateIndex
CREATE INDEX "report_category_idx" ON "report"("category");

-- AddForeignKey
ALTER TABLE "report" ADD CONSTRAINT "report_assignedToId_fkey" FOREIGN KEY ("assignedToId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_information_request" ADD CONSTRAINT "report_information_request_reportId_fkey" FOREIGN KEY ("reportId") REFERENCES "report"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "report_information_request" ADD CONSTRAINT "report_information_request_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
