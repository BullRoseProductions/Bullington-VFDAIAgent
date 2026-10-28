-- =====================================================================
-- WS-2 (DB half) — ai_call_usage + record_ai_call(p_route): per-member/day caps on the AI routes. DRAFT for gate
-- review — NOT APPLIED. Rulings (B4C_WS2_AIGate_Step0.md §6, Ashlea): D-1 member gate · D-2 claude 150/member/day +
-- 1,500/department/day backstop, concepts 30/member/day · D-3 assistant 60 / image 20 per member/day ON TOP of their
-- monthly department ceilings (record_assistant_turn / record_image_generation — untouched).
--
-- WHAT IT CREATES — TWO THINGS, NOTHING ELSE:
--   1. TABLE public.ai_call_usage (member_id, department_id, day, route, count, updated_at), PK (member_id, day, route).
--      The assistant_usage pattern: RLS ON, NO policies, NO anon / authenticated privilege (postgres + service_role only).
--      Only record_ai_call writes it; nothing reads it but that function (and the service role).
--   2. FUNCTION public.record_ai_call(p_route text) RETURNS jsonb {allowed, used, ceiling[, scope, dept_used, dept_ceiling]}.
--      SECURITY DEFINER, search_path=public; REVOKE ALL FROM PUBLIC, anon; GRANT EXECUTE TO authenticated.
--        · requires my_member_id() AND my_department_id() (the D-1 gate, the same resolution as all RLS) — else raises
--        · p_route allowlist: claude · concepts · assistant · image — else raises
--        · day = the America/Chicago calendar day (the other ceilings' clock)
--        · per member/day: atomic INSERT … ON CONFLICT DO UPDATE … WHERE count < ceiling (the record_assistant_turn shape)
--        · claude's department/day backstop (1,500): taken under a transaction-scoped advisory lock on
--          (department, day, route), so two concurrent calls can't both read 1,499 and both pass
--      The API treats ANYTHING but {allowed:true} — false, an exception, a missing function — as "do not call the
--      model" (429 / 503). Ceilings are constants: raising one is a one-line CREATE OR REPLACE.
--
-- NOT CHANGED: no existing table, function, policy or grant is created/altered/dropped besides the two above. The
-- four pinned functions (my_member_id, my_department_id, record_assistant_turn, record_image_generation) are proved
-- byte-identical. verified untouched. Additive; no data moves.
-- ONE STATEMENT — a single DO block, all-or-nothing; NOTIFY pgrst after; state row.
-- Live reads behind the pins: docs/review/ws2_LIVEDEFS.json (2026-10-27). Dry run: docs/review/ws2_ai_call_usage_DRYRUN.txt.
-- RETEST (separately, after): sql/ws2_ai_call_usage_RETEST.sql — rolled-back SENTINEL, every department.
-- =====================================================================
DO $migrate$
DECLARE
  v_t text; v_n bigint; v_pol_before bigint; v_pol_after bigint; v_fn_before bigint; v_fn_after bigint;
  v_ver_before bigint; v_ver_after bigint;
BEGIN
  -- ---------------------------------------------------------------- 0. preflight
  IF to_regclass('public.ai_call_usage') IS NOT NULL OR to_regprocedure('public.record_ai_call(text)') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: ai_call_usage / record_ai_call already exist — WS-2 looks applied. Refusing.';
  END IF;
  FOR v_t IN SELECT unnest(ARRAY[
      'public.my_member_id()|3f66369c8af7bc07ec59831af6536fee',
      'public.my_department_id()|87f546659c3804a943b48e419e017f18',
      'public.record_assistant_turn()|fc69fdaf65f51072cbdd8c1400e85467',
      'public.record_image_generation(text)|668c0a92223cd8187264c5f469844d69']) LOOP
    IF to_regprocedure(split_part(v_t, '|', 1)) IS NULL
       OR md5(pg_get_functiondef(to_regprocedure(split_part(v_t, '|', 1)))) IS DISTINCT FROM split_part(v_t, '|', 2) THEN
      RAISE EXCEPTION 'PREFLIGHT: % drifted from its pinned body. Refusing.', split_part(v_t, '|', 1);
    END IF;
  END LOOP;
  FOR v_t IN SELECT unnest(ARRAY['members.id:uuid', 'departments.id:uuid']) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = split_part(split_part(v_t, ':', 1), '.', 1) AND column_name = split_part(split_part(v_t, ':', 1), '.', 2)
                     AND data_type = split_part(v_t, ':', 2)) THEN
      RAISE EXCEPTION 'PREFLIGHT: % not found with that type. Refusing.', v_t;
    END IF;
  END LOOP;
  SELECT count(*) INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_fn_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
  SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;

  -- ---------------------------------------------------------------- 1. the table (assistant_usage pattern)
  CREATE TABLE public.ai_call_usage (
    member_id     uuid        NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
    department_id uuid        NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    day           date        NOT NULL,
    route         text        NOT NULL CHECK (route IN ('claude', 'concepts', 'assistant', 'image')),
    count         integer     NOT NULL DEFAULT 0 CHECK (count >= 0),
    updated_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (member_id, day, route)
  );
  CREATE INDEX ai_call_usage_dept_day_route ON public.ai_call_usage (department_id, day, route);   -- the backstop's sum
  COMMENT ON TABLE public.ai_call_usage IS
    'WS-2: per-member/day AI call counts (America/Chicago day). Written only by record_ai_call(); no policies, no anon/authenticated access.';
  ALTER TABLE public.ai_call_usage ENABLE ROW LEVEL SECURITY;
  REVOKE ALL ON TABLE public.ai_call_usage FROM PUBLIC, anon, authenticated;

  -- ---------------------------------------------------------------- 2. the function
  EXECUTE $fn$
  CREATE FUNCTION public.record_ai_call(p_route text)
   RETURNS jsonb
   LANGUAGE plpgsql
   SECURITY DEFINER
   SET search_path TO 'public'
  AS $body$
  -- B4C:ai_call_usage — per-member/day caps on the AI routes (WS-2). Never takes a member or department argument.
  declare
    v_me    uuid := public.my_member_id();
    v_dept  uuid := public.my_department_id();
    v_day   date := (now() at time zone 'America/Chicago')::date;
    v_cap   integer;
    v_dcap  integer;
    v_used  integer;
    v_dused integer;
  begin
    if p_route is null or p_route not in ('claude', 'concepts', 'assistant', 'image') then
      raise exception 'Unknown AI route.';
    end if;
    if v_me is null or v_dept is null then
      raise exception 'We could not match your login to a member record.';
    end if;
    v_cap := case p_route when 'claude' then 150 when 'concepts' then 30 when 'assistant' then 60 when 'image' then 20 end;   -- per member per day (D-2 / D-3)
    v_dcap := case p_route when 'claude' then 1500 end;                                                                        -- per department per day (D-2 backstop)
    if v_dcap is not null then
      perform pg_advisory_xact_lock(hashtextextended('ai_call:' || v_dept::text || ':' || v_day::text || ':' || p_route, 0));
      select coalesce(sum(u.count), 0) into v_dused from public.ai_call_usage u
       where u.department_id = v_dept and u.day = v_day and u.route = p_route;
      if v_dused >= v_dcap then
        select coalesce((select u.count from public.ai_call_usage u where u.member_id = v_me and u.day = v_day and u.route = p_route), 0) into v_used;
        return jsonb_build_object('allowed', false, 'used', v_used, 'ceiling', v_cap, 'scope', 'department', 'dept_used', v_dused, 'dept_ceiling', v_dcap);
      end if;
    end if;
    insert into public.ai_call_usage as u (member_id, department_id, day, route, count, updated_at)
    values (v_me, v_dept, v_day, p_route, 1, now())
    on conflict (member_id, day, route)
      do update set count = u.count + 1, updated_at = now()
      where u.count < v_cap
    returning u.count into v_used;
    if v_used is null then                               -- the WHERE refused the update: at (or over) the member's cap
      select u.count into v_used from public.ai_call_usage u where u.member_id = v_me and u.day = v_day and u.route = p_route;
      return jsonb_build_object('allowed', false, 'used', v_used, 'ceiling', v_cap, 'scope', 'member');
    end if;
    return jsonb_build_object('allowed', true, 'used', v_used, 'ceiling', v_cap);
  end;
  $body$
  $fn$;
  REVOKE ALL ON FUNCTION public.record_ai_call(text) FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION public.record_ai_call(text) TO authenticated;

  -- ---------------------------------------------------------------- 3. post-conditions
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_call_usage'::regclass) THEN
    RAISE EXCEPTION 'Post-condition failed: RLS is off on ai_call_usage. Rolling back.';
  END IF;
  SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_call_usage';
  IF v_n <> 0 THEN RAISE EXCEPTION 'Post-condition failed: ai_call_usage has % policies (expected none). Rolling back.', v_n; END IF;
  FOREACH v_t IN ARRAY ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE'] LOOP
    IF has_table_privilege('anon', 'public.ai_call_usage', v_t) OR has_table_privilege('authenticated', 'public.ai_call_usage', v_t) THEN
      RAISE EXCEPTION 'Post-condition failed: anon/authenticated hold % on ai_call_usage. Rolling back.', v_t;
    END IF;
  END LOOP;
  IF has_function_privilege('anon', 'public.record_ai_call(text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.record_ai_call(text)', 'EXECUTE')
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.record_ai_call(text)'::regprocedure)
     OR (SELECT proconfig FROM pg_proc WHERE oid = 'public.record_ai_call(text)'::regprocedure) IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'Post-condition failed: record_ai_call is not definer + search_path=public + authenticated-only. Rolling back.';
  END IF;
  FOR v_t IN SELECT unnest(ARRAY[
      'public.my_member_id()|3f66369c8af7bc07ec59831af6536fee',
      'public.my_department_id()|87f546659c3804a943b48e419e017f18',
      'public.record_assistant_turn()|fc69fdaf65f51072cbdd8c1400e85467',
      'public.record_image_generation(text)|668c0a92223cd8187264c5f469844d69']) LOOP
    IF md5(pg_get_functiondef(to_regprocedure(split_part(v_t, '|', 1)))) IS DISTINCT FROM split_part(v_t, '|', 2) THEN
      RAISE EXCEPTION 'Post-condition failed: % changed. Rolling back.', split_part(v_t, '|', 1);
    END IF;
  END LOOP;
  SELECT count(*) INTO v_pol_after FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_fn_after FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
  IF v_pol_after <> v_pol_before OR v_fn_after <> v_fn_before + 1 THEN
    RAISE EXCEPTION 'Post-condition failed: policies %->% (expected unchanged) / functions %->% (expected +1). Rolling back.', v_pol_before, v_pol_after, v_fn_before, v_fn_after;
  END IF;
  SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
  IF v_ver_after <> v_ver_before THEN RAISE EXCEPTION 'Post-condition failed: verified presence changed (% -> %). Rolling back.', v_ver_before, v_ver_after; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------- state row
SELECT jsonb_build_object(
  'table',              to_regclass('public.ai_call_usage') IS NOT NULL,
  'rls',                (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.ai_call_usage'::regclass),
  'policies',           (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ai_call_usage'),
  'table_acl',          (SELECT relacl::text FROM pg_class WHERE oid = 'public.ai_call_usage'::regclass),
  'auth_select',        has_table_privilege('authenticated', 'public.ai_call_usage', 'SELECT'),
  'rows',               (SELECT count(*) FROM public.ai_call_usage),
  'fn',                 'record_ai_call anon=' || has_function_privilege('anon', 'public.record_ai_call(text)', 'EXECUTE')
                          || ' auth=' || has_function_privilege('authenticated', 'public.record_ai_call(text)', 'EXECUTE')
                          || ' definer=' || (SELECT prosecdef FROM pg_proc WHERE oid = 'public.record_ai_call(text)'::regprocedure),
  'fn_md5',             md5(pg_get_functiondef('public.record_ai_call(text)'::regprocedure)),
  'total_policies',     (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'fn_count',           (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'verified_presence',  (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
