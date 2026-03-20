-- supabase/migrations/007_global_settings_extensions.sql
ALTER TABLE global_settings
  ADD COLUMN daily_budget_limit numeric(10,4),
  ADD COLUMN default_model text NOT NULL DEFAULT 'claude-sonnet-4-6';
