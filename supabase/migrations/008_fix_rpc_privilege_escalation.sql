-- Fix SEC-14 (GitHub Issue #26): Add is_admin() authorization checks to
-- change_member_role and remove_team_member RPCs. Without these guards, any
-- authenticated user could call these SECURITY DEFINER functions directly via
-- the Supabase client to escalate privileges or remove other team members.

-- Re-create change_member_role with admin authorization check
CREATE OR REPLACE FUNCTION change_member_role(
  p_member_id uuid,
  p_new_role team_role
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Only admins may change roles
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'permission denied';
  END IF;

  LOCK TABLE team_members IN EXCLUSIVE MODE;

  -- Prevent demoting the last admin
  IF p_new_role <> 'admin' THEN
    IF (SELECT COUNT(*) FROM team_members WHERE role = 'admin' AND id = p_member_id) > 0 THEN
      IF (SELECT COUNT(*) FROM team_members WHERE role = 'admin') <= 1 THEN
        RETURN 'last_admin';
      END IF;
    END IF;
  END IF;

  UPDATE team_members SET role = p_new_role WHERE id = p_member_id;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE EXECUTE ON FUNCTION change_member_role FROM PUBLIC;
GRANT EXECUTE ON FUNCTION change_member_role TO authenticated;

-- Re-create remove_team_member with admin authorization check
CREATE OR REPLACE FUNCTION remove_team_member(
  p_member_id uuid
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  -- Only admins may remove team members
  IF NOT is_admin() THEN
    RAISE EXCEPTION 'permission denied';
  END IF;

  LOCK TABLE team_members IN EXCLUSIVE MODE;

  -- Prevent removing the last admin
  IF (SELECT COUNT(*) FROM team_members WHERE role = 'admin' AND id = p_member_id) > 0 THEN
    IF (SELECT COUNT(*) FROM team_members WHERE role = 'admin') <= 1 THEN
      RETURN 'last_admin';
    END IF;
  END IF;

  DELETE FROM team_members WHERE id = p_member_id;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  RETURN 'ok';
END;
$$;

REVOKE EXECUTE ON FUNCTION remove_team_member FROM PUBLIC;
GRANT EXECUTE ON FUNCTION remove_team_member TO authenticated;
