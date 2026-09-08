/*
  Warnings:

  - You are about to drop the column `password` on the `user` table. All the data in the column will be lost.

*/
-- AlterTable
ALTER TABLE "information_submission" ADD COLUMN     "reviewNote" TEXT;

-- AlterTable
ALTER TABLE "user" DROP COLUMN "password",
ADD COLUMN     "discreetModePasscodeHash" TEXT,
ADD COLUMN     "passwordHash" TEXT;

-- AlterTable
ALTER TABLE "victim_profile" ADD COLUMN     "isChildSafetyReviewed" BOOLEAN NOT NULL DEFAULT false;
