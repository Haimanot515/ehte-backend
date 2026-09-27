-- AlterEnum
--
-- Adds every VICTIM_PROFILE_* and INFORMATION_SUBMISSION_* value that
-- NotificationEventEnum / VictimProfileService already emit at runtime.
-- Each addition is wrapped in its own guarded DO block (IF NOT EXISTS)
-- so this migration is safe to re-run even if some of these values were
-- already added on a given environment by an earlier partial version of
-- this migration.
--
-- Note: PostgreSQL requires each `ALTER TYPE ... ADD VALUE` to run in its
-- own transaction/block — they cannot be merged into a single IF check.
-- That's why there are 13 separate DO $$ ... END$$; blocks below rather
-- than one block with 13 ALTER statements inside it.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_CREATED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_CREATED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_UPDATED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_UPDATED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_DELETED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_DELETED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_GATES_UPDATED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_GATES_UPDATED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_CHILD_SAFETY_REVIEWED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_CHILD_SAFETY_REVIEWED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_CONSENT_REVOKED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_CONSENT_REVOKED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_BANK_DETAILS_UPDATED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_BANK_DETAILS_UPDATED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_PUBLISHED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_PUBLISHED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_UNPUBLISHED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_UNPUBLISHED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_REJECTED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_REJECTED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'VICTIM_PROFILE_RESUBMITTED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_RESUBMITTED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'INFORMATION_SUBMISSION_REVIEWED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_REVIEWED';
    END IF;
END$$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_enum WHERE enumlabel = 'INFORMATION_SUBMISSION_REJECTED') THEN
        ALTER TYPE "NotificationType" ADD VALUE 'INFORMATION_SUBMISSION_REJECTED';
    END IF;
END$$;
