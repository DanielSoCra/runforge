-- Migration 002: Switch encryption key storage from GUC to Supabase Vault
--
-- On Supabase hosted, ALTER DATABASE SET custom GUCs requires superuser.
-- Instead, we store the encryption key in vault.secrets and read it at runtime.
--
-- Seed the encryption key once after migration:
--   SELECT vault.create_secret('<hex-key>', 'encryption_key', 'pgcrypto key for api_keys table');

-- Helper: retrieve encryption key from vault
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
