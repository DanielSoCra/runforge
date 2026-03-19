-- 003_plugins.sql
-- Depends on: 001_initial.sql (requires is_member(), is_admin() helpers)

CREATE TABLE repo_plugins (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id               uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  plugin_id             text NOT NULL,
  active                boolean NOT NULL DEFAULT false,
  recommended           boolean NOT NULL DEFAULT false,
  recommendation_reason text,
  recommended_at        timestamptz,
  activated_at          timestamptz,
  UNIQUE (repo_id, plugin_id)
);

ALTER TABLE repo_plugins ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read repo_plugins"
  ON repo_plugins FOR SELECT USING (is_member());

CREATE POLICY "admins insert repo_plugins"
  ON repo_plugins FOR INSERT WITH CHECK (is_admin());

CREATE POLICY "admins update repo_plugins"
  ON repo_plugins FOR UPDATE USING (is_admin());

CREATE POLICY "admins delete repo_plugins"
  ON repo_plugins FOR DELETE USING (is_admin());

-- Track which plugins were active at run start (best-effort snapshot, not audit trail)
ALTER TABLE runs ADD COLUMN active_plugins text[] NOT NULL DEFAULT '{}';

CREATE INDEX idx_repo_plugins_repo_id ON repo_plugins (repo_id);
CREATE INDEX idx_repo_plugins_active ON repo_plugins (repo_id, active) WHERE active = true;
