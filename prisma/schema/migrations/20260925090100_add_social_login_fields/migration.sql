-- AlterTable
ALTER TABLE "user" ADD COLUMN "googleId" TEXT,
ADD COLUMN "facebookId" TEXT,
ADD COLUMN "appleId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "user_googleId_key" ON "user"("googleId");

-- CreateIndex
CREATE UNIQUE INDEX "user_facebookId_key" ON "user"("facebookId");

-- CreateIndex
CREATE UNIQUE INDEX "user_appleId_key" ON "user"("appleId");
