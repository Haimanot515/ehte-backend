-- AlterTable
ALTER TABLE "post" ADD COLUMN     "involvesChild" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "post_involvesChild_idx" ON "post"("involvesChild");
