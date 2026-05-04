-- 013_repo_credential_status.sql
-- Surface daemon credential decryption failures on repository rows.

ALTER TABLE repos
  ADD COLUMN credential_status text NOT NULL DEFAULT 'ok',
  ADD COLUMN credential_error text,
  ADD CONSTRAINT repos_credential_status_check
    CHECK (credential_status IN ('ok', 'error'));
