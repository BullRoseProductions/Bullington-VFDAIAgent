-- =====================================================================
-- APPARATUS IN-SERVICE / OUT-OF-SERVICE - Slice 5b (transition RPCs)
-- The two leadership actions that flip the availability dimension and record
-- the out-of-service period. Both SECURITY DEFINER, is_canmanage()-gated,
-- dept-checked, FOR UPDATE row lock (serializes take/return on a rig).
-- Writes to apparatus_service_periods happen ONLY here (5a left it RLS
-- SELECT-only). Idempotent: CREATE OR REPLACE. Run VERIFICATION after.
-- =====================================================================

-- ---------------------------------------------------------------------
-- take_apparatus_out_of_service: Active -> Out of service, with a reason.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.take_apparatus_out_of_service(
  p_apparatus_id uuid,
  p_reason       text
)
RETURNS public.apparatus
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_member public.members;
  v_app    public.apparatus;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  -- identity + leadership gate
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  if not public.is_canmanage() then
    raise exception 'Only leadership (Board, Department Admin, or Officer) can change apparatus service status';
  end if;

  -- reason required
  if v_reason is null then
    raise exception 'A reason is required to take an apparatus out of service';
  end if;

  -- lock the rig (serializes concurrent take/return on this apparatus)
  select * into v_app from public.apparatus where id = p_apparatus_id for update;
  if v_app.id is null then
    raise exception 'Apparatus not found';
  end if;
  if v_app.department_id <> v_member.department_id then
    raise exception 'Not authorized: this apparatus belongs to another department';
  end if;

  -- already out?
  if v_app.in_service = false then
    raise exception 'This apparatus is already out of service';
  end if;

  -- flip availability + open a service period (one_open index guards double-open)
  update public.apparatus set in_service = false where id = p_apparatus_id
    returning * into v_app;
  insert into public.apparatus_service_periods
    (department_id, apparatus_id, out_at, out_by, out_by_name, out_reason, back_at)
  values
    (v_member.department_id, p_apparatus_id, now(), v_member.id, v_member.name, v_reason, null);

  return v_app;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.take_apparatus_out_of_service(uuid, text) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.take_apparatus_out_of_service(uuid, text) TO authenticated;

-- ---------------------------------------------------------------------
-- return_apparatus_to_service: Out of service -> Active. Closes the open
-- period AND resets readiness to 'Needs attention' (a returning rig must be
-- re-checked before it is trusted green).
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.return_apparatus_to_service(
  p_apparatus_id uuid
)
RETURNS public.apparatus
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_member public.members;
  v_app    public.apparatus;
begin
  -- identity + leadership gate
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  if not public.is_canmanage() then
    raise exception 'Only leadership (Board, Department Admin, or Officer) can change apparatus service status';
  end if;

  -- lock the rig
  select * into v_app from public.apparatus where id = p_apparatus_id for update;
  if v_app.id is null then
    raise exception 'Apparatus not found';
  end if;
  if v_app.department_id <> v_member.department_id then
    raise exception 'Not authorized: this apparatus belongs to another department';
  end if;

  -- already in service?
  if v_app.in_service = true then
    raise exception 'This apparatus is already in service';
  end if;

  -- flip availability + reset readiness (returning rig must be re-checked)
  update public.apparatus
     set in_service = true,
         status     = 'Needs attention'
   where id = p_apparatus_id
   returning * into v_app;

  -- close the open service period (no-op if somehow none is open)
  update public.apparatus_service_periods
     set back_at      = now(),
         back_by      = v_member.id,
         back_by_name = v_member.name
   where apparatus_id = p_apparatus_id and back_at is null;

  return v_app;
end;
$function$;

REVOKE EXECUTE ON FUNCTION public.return_apparatus_to_service(uuid) FROM anon, public;
GRANT  EXECUTE ON FUNCTION public.return_apparatus_to_service(uuid) TO authenticated;

-- =====================================================================
-- VERIFICATION (run separately; the editor shows the LAST grid = grant check)
-- =====================================================================

-- (a) both functions exist, SECURITY DEFINER, return the apparatus row:
select proname, prosecdef, pg_get_function_result(oid) as returns
from pg_proc
where proname in ('take_apparatus_out_of_service', 'return_apparatus_to_service')
order by proname;
--   expect 2 rows | prosecdef = t | returns = apparatus

-- (b) grant quirk check - anon must be FALSE for BOTH:
select p.proname, r.rolname, has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
from pg_proc p
cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
where p.proname in ('take_apparatus_out_of_service', 'return_apparatus_to_service')
order by p.proname, r.rolname;
--   expect: anon = f for BOTH ; authenticated = t ; service_role = t
