DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_enum
        WHERE enumlabel = 'VICTIM_PROFILE_CREATED'
    ) THEN
        ALTER TYPE "NotificationType" ADD VALUE 'VICTIM_PROFILE_CREATED';
    END IF;
END$$;
