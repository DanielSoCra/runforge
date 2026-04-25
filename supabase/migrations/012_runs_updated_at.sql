-- Add updated_at column to runs table (briefing-summarizer dependency, #398)
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS updated_at timestamptz;

-- Backfill existing rows with the most informative timestamp we have
UPDATE runs
   SET updated_at = COALESCE(completed_at, started_at, now())
 WHERE updated_at IS NULL
    OR updated_at < COALESCE(completed_at, started_at, updated_at);

ALTER TABLE runs
  ALTER COLUMN updated_at SET DEFAULT now(),
  ALTER COLUMN updated_at SET NOT NULL;

-- Index for the briefing-summarizer's "recent runs" query
CREATE INDEX IF NOT EXISTS idx_runs_updated_at ON runs(updated_at DESC);

-- Auto-update on row change
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_runs_updated_at ON runs;
CREATE TRIGGER trg_runs_updated_at
BEFORE UPDATE ON runs
FOR EACH ROW
EXECUTE FUNCTION set_updated_at();
