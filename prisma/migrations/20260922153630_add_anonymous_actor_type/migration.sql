/*
  Warnings:

  - A unique constraint covering the columns `[type,institutionId,version]` on the table `agreements` will be added. If there are existing duplicate values, this will fail.

*/
-- AlterEnum
ALTER TYPE "ActorType" ADD VALUE 'ANONYMOUS';

-- AlterTable
ALTER TABLE "information_submission" ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "missing_person" ADD COLUMN     "contactPhone" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "report" ALTER COLUMN "userId" DROP NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "agreements_type_institutionId_version_key" ON "agreements"("type", "institutionId", "version");
