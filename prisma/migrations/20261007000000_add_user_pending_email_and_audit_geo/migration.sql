ALTER TABLE "audit_log" ADD COLUMN     "asn" INTEGER,
ADD COLUMN     "clientVersion" TEXT,
ADD COLUMN     "deviceLabel" TEXT,
ADD COLUMN     "isp" TEXT,
ADD COLUMN     "region" TEXT,
ADD COLUMN     "timezone" TEXT;

ALTER TABLE "user" ADD COLUMN     "pendingEmail" TEXT;

CREATE INDEX "audit_log_country_createdAt_idx" ON "audit_log"("country", "createdAt");
