-- Atomically change a team member's role, protecting the last admin
-- Returns: 'ok' | 'last_admin' | 'not_found'
CREATE OR REPLACE FUNCTION change_member_role(
  p_member_id uuid,
  p_new_role team_role
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
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

-- Atomically remove a team member, protecting the last admin
-- Returns: 'ok' | 'last_admin' | 'not_found'
CREATE OR REPLACE FUNCTION remove_team_member(
  p_member_id uuid
) RETURNS text LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
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
