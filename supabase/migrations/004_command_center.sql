-- 003_command_center.sql

-- Add webhook-secret to key_type enum
ALTER TYPE key_type ADD VALUE IF NOT EXISTS 'webhook-secret';

-- Add matrix_status to repos table
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typname = 'matrix_status'
      AND typnamespace = (SELECT oid FROM pg_namespace WHERE nspname = 'public')
  ) THEN
    CREATE TYPE matrix_status AS ENUM ('ok', 'degraded', 'failed');
  END IF;
END $$;

ALTER TABLE repos
  ADD COLUMN IF NOT EXISTS matrix_status matrix_status NOT NULL DEFAULT 'ok';
