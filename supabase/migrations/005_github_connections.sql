-- 005_github_connections.sql
-- Depends on: 001_initial.sql (requires is_admin(), is_member(), vault.decrypted_secrets)

-- ============================================================
-- github_connections: system-level GitHub OAuth tokens
-- ============================================================
CREATE TABLE github_connections (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  display_name     text        NOT NULL,
  github_login     text        NOT NULL,
  avatar_url       text,
  connection_type  text        NOT NULL DEFAULT 'oauth_token',
  encrypted_token  bytea       NOT NULL,
  token_expires_at timestamptz,
  scopes           text,
  status           text        NOT NULL DEFAULT 'active',
  created_by       uuid        NOT NULL REFERENCES auth.users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE github_connections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read github_connections"
  ON github_connections FOR SELECT USING (is_member());
CREATE POLICY "admins insert github_connections"
  ON github_connections FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "admins update github_connections"
  ON github_connections FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "admins delete github_connections"
  ON github_connections FOR DELETE USING (is_admin());

-- Prevent authenticated users from selecting the raw token column
REVOKE SELECT (encrypted_token) ON github_connections FROM authenticated;

-- ============================================================
-- github_orgs: orgs accessible via a connection
-- ============================================================
CREATE TABLE github_orgs (
  id            uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  connection_id uuid    NOT NULL REFERENCES github_connections(id) ON DELETE CASCADE,
  github_id     bigint  NOT NULL,
  login         text    NOT NULL,
  name          text,
  avatar_url    text,
  is_selected   boolean NOT NULL DEFAULT false,
  UNIQUE (connection_id, github_id)
);

ALTER TABLE github_orgs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members read github_orgs"
  ON github_orgs FOR SELECT USING (is_member());
CREATE POLICY "admins insert github_orgs"
  ON github_orgs FOR INSERT WITH CHECK (is_admin());
CREATE POLICY "admins update github_orgs"
  ON github_orgs FOR UPDATE USING (is_admin()) WITH CHECK (is_admin());
CREATE POLICY "admins delete github_orgs"
  ON github_orgs FOR DELETE USING (is_admin());

-- ============================================================
-- Extend repos
-- ============================================================
ALTER TABLE repos
  ADD COLUMN connection_id  uuid REFERENCES github_connections(id) ON DELETE SET NULL,
  ADD COLUMN github_status  text NOT NULL DEFAULT 'ok';

-- ============================================================
-- store_github_connection: admin-only, encrypts token in vault
-- ============================================================
CREATE OR REPLACE FUNCTION store_github_connection(
  p_display_name    text,
  p_github_login    text,
  p_avatar_url      text,
  p_connection_type text,
  p_plaintext_token text,
  p_scopes          text
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = public, extensions, vault AS $$
DECLARE
  v_enc_key text;
  v_id      uuid;
BEGIN
  IF NOT is_admin() THEN RAISE EXCEPTION 'permission denied'; END IF;
  SELECT decrypted_secret INTO v_enc_key
    FROM vault.decrypted_secrets WHERE name = 'encryption_key' LIMIT 1;
  INSERT INTO github_connections
    (display_name, github_login, avatar_url, connection_type,
     encrypted_token, scopes, status, created_by)
  VALUES
    (p_display_name, p_github_login, p_avatar_url, p_connection_type,
     pgp_sym_encrypt(p_plaintext_token, v_enc_key), p_scopes, 'active', auth.uid())
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
REVOKE EXECUTE ON FUNCTION store_github_connection FROM PUBLIC;
GRANT EXECUTE ON FUNCTION store_github_connection TO authenticated;

-- ============================================================
-- decrypt_github_token: service-role only
-- ============================================================
CREATE OR REPLACE FUNCTION decrypt_github_token(p_connection_id uuid)
RETURNS text LANGUAGE sql SECURITY DEFINER
  SET search_path = public, extensions, vault AS $$
  SELECT pgp_sym_decrypt(
    encrypted_token,
    (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'encryption_key' LIMIT 1)
  )::text
  FROM github_connections
  WHERE id = p_connection_id;
$$;
REVOKE EXECUTE ON FUNCTION decrypt_github_token FROM PUBLIC;

-- ============================================================
-- Indexes
-- ============================================================
CREATE INDEX idx_github_orgs_connection_id ON github_orgs (connection_id);
CREATE INDEX idx_repos_connection_id ON repos (connection_id) WHERE connection_id IS NOT NULL;
