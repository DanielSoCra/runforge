-- Extensions
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ============================================================
-- ENUMS
-- ============================================================
CREATE TYPE run_outcome AS ENUM ('in-progress', 'complete', 'stuck', 'escalated');
CREATE TYPE team_role AS ENUM ('admin', 'viewer');
CREATE TYPE key_type AS ENUM ('source-control', 'model-provider');
CREATE TYPE session_type AS ENUM ('planning', 'implementation', 'validation', 'diagnosis', 'fix');
CREATE TYPE invite_status AS ENUM ('pending', 'accepted');

-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE global_settings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  concurrency_limit integer NOT NULL DEFAULT 3,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Seed one row — this is a single-row settings table
INSERT INTO global_settings (concurrency_limit) VALUES (3);

CREATE TABLE repos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner text NOT NULL,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  staging_branch text NOT NULL DEFAULT 'staging',
  production_branch text NOT NULL DEFAULT 'main',
  budget_limit numeric(10,4),
  concurrency_limit integer NOT NULL DEFAULT 1,
  poll_interval_ms integer,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (owner, name)
);

CREATE TABLE api_keys (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid NOT NULL REFERENCES repos(id) ON DELETE CASCADE,
  key_type key_type NOT NULL,
  encrypted_value bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (repo_id, key_type)
);

CREATE TABLE team_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role team_role NOT NULL DEFAULT 'viewer',
  granted_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

CREATE TABLE invitations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_handle text NOT NULL,
  role team_role NOT NULL DEFAULT 'viewer',
  invited_by uuid REFERENCES auth.users(id),
  status invite_status NOT NULL DEFAULT 'pending',
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (provider_handle, status)
);

CREATE TABLE runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id uuid REFERENCES repos(id) ON DELETE SET NULL,
  repo_owner text NOT NULL,
  repo_name text NOT NULL,
  issue_number integer NOT NULL,
  issue_title text NOT NULL,
  pipeline_variant text NOT NULL DEFAULT 'standard',
  current_phase text,
  outcome run_outcome NOT NULL DEFAULT 'in-progress',
  total_cost numeric(10,6) NOT NULL DEFAULT 0,
  phases jsonb NOT NULL DEFAULT '[]',
  fix_attempts integer NOT NULL DEFAULT 0,
  report text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE cost_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  session_type session_type NOT NULL,
  cost numeric(10,6) NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now()
);

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
ALTER TABLE global_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE repos ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_events ENABLE ROW LEVEL SECURITY;

-- Helper: check if current user is an admin
CREATE OR REPLACE FUNCTION is_admin()
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members
    WHERE user_id = auth.uid() AND role = 'admin'
  );
$$;

-- Helper: check if current user has any team membership
CREATE OR REPLACE FUNCTION is_member()
RETURNS boolean LANGUAGE sql SECURITY DEFINER AS $$
  SELECT EXISTS (
    SELECT 1 FROM team_members WHERE user_id = auth.uid()
  );
$$;

-- global_settings: all members read, only admins write
CREATE POLICY "members read settings" ON global_settings FOR SELECT USING (is_member());
CREATE POLICY "admins update settings" ON global_settings FOR UPDATE USING (is_admin());

-- repos: members read non-deleted; admins write
CREATE POLICY "members read repos" ON repos FOR SELECT USING (is_member() AND deleted_at IS NULL);
CREATE POLICY "admins insert repos" ON repos FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "admins update repos" ON repos FOR UPDATE USING (is_admin());
-- No DELETE policy — soft delete only (set deleted_at via UPDATE)

-- api_keys: admins only (write-only pattern enforced in app layer)
CREATE POLICY "admins manage api_keys" ON api_keys FOR ALL USING (is_admin());

-- team_members: members read; admins write
CREATE POLICY "members read team" ON team_members FOR SELECT USING (is_member());
CREATE POLICY "admins manage team" ON team_members FOR ALL USING (is_admin());

-- invitations: admins manage; no read needed by non-admin
CREATE POLICY "admins manage invitations" ON invitations FOR ALL USING (is_admin());

-- runs: all members read
CREATE POLICY "members read runs" ON runs FOR SELECT USING (is_member());
-- Service role writes runs (daemon) — no auth.uid() policy needed, service role bypasses RLS

-- cost_events: all members read
CREATE POLICY "members read cost_events" ON cost_events FOR SELECT USING (is_member());

-- ============================================================
-- FUNCTIONS
-- ============================================================

-- Atomic first-user-is-admin + invitation acceptance
CREATE OR REPLACE FUNCTION bootstrap_user_access(
  p_user_id uuid,
  p_provider_handle text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_role team_role;
BEGIN
  LOCK TABLE team_members IN EXCLUSIVE MODE;

  -- First user: always admin
  IF NOT EXISTS (SELECT 1 FROM team_members) THEN
    INSERT INTO team_members (user_id, role) VALUES (p_user_id, 'admin');
    RETURN 'admin';
  END IF;

  -- Already a member (re-login)
  IF EXISTS (SELECT 1 FROM team_members WHERE user_id = p_user_id) THEN
    SELECT role INTO v_role FROM team_members WHERE user_id = p_user_id;
    RETURN v_role::text;
  END IF;

  -- Check for pending invitation
  SELECT role INTO v_role FROM invitations
  WHERE provider_handle = p_provider_handle
    AND status = 'pending'
    AND expires_at > now()
  LIMIT 1;

  IF v_role IS NULL THEN
    RETURN 'denied';
  END IF;

  INSERT INTO team_members (user_id, role) VALUES (p_user_id, v_role);
  UPDATE invitations SET status = 'accepted'
    WHERE provider_handle = p_provider_handle AND status = 'pending';
  RETURN v_role::text;
END;
$$;

-- Helper: retrieve encryption key from vault
-- The key is stored in vault.secrets with name 'encryption_key'
-- To seed it: SELECT vault.create_secret('<hex-key>', 'encryption_key', 'pgcrypto key for api_keys');
CREATE OR REPLACE FUNCTION get_encryption_key()
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, vault AS $$
  SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'encryption_key' LIMIT 1;
$$;

-- Daemon: decrypt API key (SECURITY DEFINER, callable only by service role)
CREATE OR REPLACE FUNCTION decrypt_api_key(p_repo_id uuid, p_key_type text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path = public, extensions, vault AS $$
  SELECT pgp_sym_decrypt(
    encrypted_value,
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'encryption_key' LIMIT 1)
  )::text
  FROM api_keys
  WHERE repo_id = p_repo_id AND key_type = p_key_type::key_type;
$$;
-- Revoke from public so only service role can call
REVOKE EXECUTE ON FUNCTION decrypt_api_key FROM PUBLIC;

-- Dashboard: write encrypted API key (called by Server Action, not daemon)
CREATE OR REPLACE FUNCTION upsert_api_key_encrypted(
  p_repo_id uuid, p_key_type text, p_plaintext text
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, extensions, vault AS $$
DECLARE
  v_enc_key text;
BEGIN
  SELECT decrypted_secret INTO v_enc_key FROM vault.decrypted_secrets WHERE name = 'encryption_key' LIMIT 1;
  INSERT INTO api_keys (repo_id, key_type, encrypted_value, updated_at)
  VALUES (p_repo_id, p_key_type::key_type, pgp_sym_encrypt(p_plaintext, v_enc_key), now())
  ON CONFLICT (repo_id, key_type) DO UPDATE
    SET encrypted_value = pgp_sym_encrypt(p_plaintext, v_enc_key), updated_at = now();
END;
$$;

-- Note: Seed the encryption key once after migration:
-- SELECT vault.create_secret('<your-hex-key>', 'encryption_key', 'pgcrypto key for api_keys table');

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX idx_repos_enabled ON repos (enabled) WHERE deleted_at IS NULL;
CREATE INDEX idx_runs_repo_id ON runs (repo_id);
CREATE INDEX idx_runs_started_at ON runs (started_at DESC);
CREATE INDEX idx_cost_events_run_id ON cost_events (run_id);
CREATE INDEX idx_cost_events_recorded_at ON cost_events (recorded_at DESC);
