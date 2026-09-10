/*
  Warnings:

  - A unique constraint covering the columns `[email]` on the table `user` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[inviteTokenHash]` on the table `user` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "OtpChannelEnum" AS ENUM ('sms', 'email');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "UserOtpPurposeEnum" ADD VALUE 'admin_invite_activation';
ALTER TYPE "UserOtpPurposeEnum" ADD VALUE 'promotion_verification';

-- AlterTable
ALTER TABLE "user" ADD COLUMN     "email" TEXT,
ADD COLUMN     "inviteTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "inviteTokenHash" TEXT,
ADD COLUMN     "isEmailVerified" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "user_otps" ADD COLUMN     "channel" "OtpChannelEnum" NOT NULL DEFAULT 'sms';

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE UNIQUE INDEX "user_inviteTokenHash_key" ON "user"("inviteTokenHash");
