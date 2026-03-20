-- 006_agency_plugin.sql
-- Depends on: 003_plugins.sql (requires repo_plugins table)

-- Per-repo plugin config (extends existing repo_plugins table)
ALTER TABLE repo_plugins
  ADD COLUMN config jsonb NOT NULL DEFAULT '{}';

-- Dashboard-editable global defaults per plugin
CREATE TABLE plugin_global_settings (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plugin_id  text NOT NULL UNIQUE,
  settings   jsonb NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES auth.users
);

ALTER TABLE plugin_global_settings ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read plugin_global_settings"
  ON plugin_global_settings FOR SELECT USING (is_member());

CREATE POLICY "admins write plugin_global_settings"
  ON plugin_global_settings FOR ALL USING (is_admin()) WITH CHECK (is_admin());

-- Seed the agency plugin global defaults
INSERT INTO plugin_global_settings (plugin_id, settings) VALUES (
  'agency',
  '{
    "github_org": "",
    "deploy_target": "github-pages",
    "default_language": "de",
    "default_stack": "astro",
    "checkpoints": {
      "intelligence": "checkpoint",
      "brand":        "checkpoint",
      "design":       "checkpoint",
      "seo":          "auto",
      "content":      "checkpoint",
      "assets":       "auto",
      "build":        "auto",
      "qa":           "auto",
      "launch":       "checkpoint"
    }
  }'
);

CREATE INDEX idx_plugin_global_settings_plugin_id ON plugin_global_settings (plugin_id);
