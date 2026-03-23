-- Fix SEC-30 (GitHub Issue #303): Validate p_provider_handle matches the
-- caller's actual identity in bootstrap_user_access. Without this check, any
-- authenticated user could claim another user's pending invitation by passing
-- the victim's GitHub handle. Also adds REVOKE/GRANT pattern (same class as
-- the SEC-14 fix in migration 008).

CREATE OR REPLACE FUNCTION bootstrap_user_access(
  p_user_id uuid,
  p_provider_handle text
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_role team_role;
  v_jwt_handle text;
BEGIN
  IF p_user_id <> auth.uid() THEN
    RAISE EXCEPTION 'permission denied: p_user_id must match caller identity';
  END IF;

  -- Validate provider_handle matches the caller's OAuth identity.
  -- The callback sends user_metadata.user_name (GitHub) or falls back to email.
  v_jwt_handle := coalesce(
    auth.jwt()->'user_metadata'->>'user_name',
    auth.jwt()->>'email'
  );
  IF v_jwt_handle IS NULL OR lower(p_provider_handle) <> lower(v_jwt_handle) THEN
    RAISE EXCEPTION 'permission denied: p_provider_handle must match caller OAuth identity';
  END IF;

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

-- Defense-in-depth: restrict callable scope (matches 008 pattern)
REVOKE EXECUTE ON FUNCTION bootstrap_user_access FROM PUBLIC;
GRANT EXECUTE ON FUNCTION bootstrap_user_access TO authenticated;
