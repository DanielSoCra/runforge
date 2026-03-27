-- Add 'failed' to run_outcome enum to support the failure urgency tier
-- in the briefing panel's Needs Attention live panel.
ALTER TYPE run_outcome ADD VALUE IF NOT EXISTS 'failed';
