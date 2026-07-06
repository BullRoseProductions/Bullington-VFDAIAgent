-- ============================================================
-- Project Admin (PA) support actions — Phase 1
-- ------------------------------------------------------------
-- Narrow, PA-gated (is_project_admin()) helpers backing the two
-- one-click support actions on the Program Overview radar. No
-- impersonation, no scoping changes: these do NOT widen
-- is_leader()/is_department_admin() or touch my_department_id().
--
-- Scope is deliberately limited to ACCESS/LOGIN fixes only. PA
-- support actions must never alter records that represent a
-- real-world fact the department is accountable for (cert dates,
-- duty completion, attendance) — that would be falsifying records.
--
-- Both functions verified against the live DB. Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- pa_members_missing_email() — list the members of a department who
-- have no email (can't log in), so the PA can drill in and fix them.
-- Read-only companion to pa_set_member_email().
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pa_members_missing_email(p_department_id uuid)
 RETURNS TABLE (member_id uuid, name text, access text[], status text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;

  return query
    select m.id, m.name, m.access, m.status
    from members m
    where m.department_id = p_department_id
      and (m.email is null or btrim(m.email) = '')
    order by m.name asc;
end;
$function$;

GRANT EXECUTE ON FUNCTION public.pa_members_missing_email(uuid) TO authenticated;


-- ------------------------------------------------------------
-- pa_set_member_email() — set one member's email so they can sign in.
-- PA-gated, validates + lowercases, rejects duplicates (identity resolves
-- by email with .single(), so a duplicate would break login for that address).
-- One narrow write; no scoping change.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.pa_set_member_email(p_member_id uuid, p_email text)
 RETURNS void
 LANGUAGE plpgsql
 VOLATILE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
begin
  -- PA-only gate
  if not is_project_admin() then
    raise exception 'Not authorized';
  end if;

  -- validate
  if v_email = '' or v_email !~ '^\S+@\S+\.\S+$' then
    raise exception 'A valid email is required';
  end if;

  -- reject duplicates across ALL members (global email uniqueness — identity is by email)
  if exists (select 1 from members where lower(email) = v_email and id <> p_member_id) then
    raise exception 'A member with the email % already exists', v_email;
  end if;

  update members set email = v_email where id = p_member_id;
  if not found then
    raise exception 'Member not found';
  end if;
end;
$function$;

GRANT EXECUTE ON FUNCTION public.pa_set_member_email(uuid, text) TO authenticated;
