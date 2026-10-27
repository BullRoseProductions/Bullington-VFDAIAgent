-- =====================================================================
-- WS-4c (B-4) — members_view gains `separated` (boolean). DRAFT for gate review — NOT APPLIED.
-- Ruling B-4 (B4C_WS4_Metrics_Directive.md): a SEPARATED member (status still Active) is not counted. The server's readiness
-- and probation functions already exclude them (dept_readiness_packet / dept_probation_board: `not exists (select 1 from
-- public.member_separation s where s.member_id = m.id)`); the client could not, because member_separation is sealed and
-- members_view did not say. This exposes exactly that rule — a yes/no, nothing more — so shared/members.js can apply it.
--
-- WHAT CHANGES — ONE THING: members_view is replaced with its LIVE definition (pinned by md5 below) plus ONE appended
-- column:
--     separated = CASE WHEN is_leader() THEN EXISTS (member_separation row for this member) ELSE NULL END
--   · the SAME predicate as the server functions (a row exists — including a future-dated termination, as they do);
--   · MASKED for non-leaders exactly like status / role / access / participation already are (separation is a DA record;
--     a plain member learns nothing they couldn't before). Leaders already see it in effect: the readiness packet's
--     headcount omits separated members;
--   · terminated_on is NOT exposed (the membership_window post-condition — no view carries that column — still holds).
--
-- NOT CHANGED: every existing column, in order, byte-for-byte (the replacement is the live text + the appended line); the
-- view's owner, security_invoker=false, and its ACL (CREATE OR REPLACE VIEW keeps grants — proven, not assumed: the ACL
-- string is captured before and compared after); member_separation stays sealed (RLS on, 0 policies, no anon /
-- authenticated privilege); no function, policy, table or trigger is created, altered or dropped. verified untouched.
--
-- PREFLIGHT REFUSES on drift: the members_view definition md5, the two functions it calls (is_leader, my_department_id)
-- by md5, member_separation's shape + seal, the view's options/owner, and "already applied" (a separated column exists).
-- ONE STATEMENT — a single DO block, all-or-nothing; NOTIFY pgrst after (memory: migration-notify-pgrst-reload); state row.
-- Live reads behind the pins: docs/review/ws4c_LIVEDEFS.json (2026-10-27). Dry run: docs/review/ws4c_members_view_DRYRUN.txt.
-- RETEST (separately, after): sql/ws4c_members_view_separated_RETEST.sql — rolled-back SENTINEL, every department.
-- =====================================================================
DO $migrate$
DECLARE
  c_view_md5  constant text := '5c78c518a924963a3f0acf61e8184e19';   -- pg_get_viewdef('public.members_view', true), live 2026-10-27
  v_acl_before text; v_acl_after text; v_cols_before text; v_cols_after text; v_opts text; v_pol_before bigint; v_pol_after bigint;
  v_fn_before bigint; v_fn_after bigint; v_ver_before bigint; v_ver_after bigint; v_t text; v_md5 text;
BEGIN
  -- ---------------------------------------------------------------- 0. preflight
  IF to_regclass('public.members_view') IS NULL THEN RAISE EXCEPTION 'PREFLIGHT: public.members_view not found. Refusing.'; END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'members_view' AND column_name = 'separated') THEN
    RAISE EXCEPTION 'PREFLIGHT: members_view already has a separated column — WS-4c looks applied. Refusing.';
  END IF;
  v_md5 := md5(pg_get_viewdef('public.members_view'::regclass, true));
  IF v_md5 IS DISTINCT FROM c_view_md5 THEN
    RAISE EXCEPTION 'PREFLIGHT: members_view definition drifted (md5 % <> pinned %). Re-read it before applying. Refusing.', v_md5, c_view_md5;
  END IF;
  FOR v_t IN SELECT unnest(ARRAY[
      'public.is_leader()|3f462af26a46909309f856f769226baa',
      'public.my_department_id()|87f546659c3804a943b48e419e017f18']) LOOP
    IF to_regprocedure(split_part(v_t, '|', 1)) IS NULL
       OR md5(pg_get_functiondef(to_regprocedure(split_part(v_t, '|', 1)))) IS DISTINCT FROM split_part(v_t, '|', 2) THEN
      RAISE EXCEPTION 'PREFLIGHT: % drifted from its pinned body. Refusing.', split_part(v_t, '|', 1);
    END IF;
  END LOOP;
  SELECT coalesce(array_to_string(reloptions, ','), '') || '|' || pg_get_userbyid(relowner) INTO v_opts FROM pg_class WHERE oid = 'public.members_view'::regclass;
  IF v_opts IS DISTINCT FROM 'security_invoker=false|postgres' THEN
    RAISE EXCEPTION 'PREFLIGHT: members_view options/owner are "%" (expected security_invoker=false|postgres). Refusing.', v_opts;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'member_separation' AND column_name = 'member_id' AND data_type = 'uuid') THEN
    RAISE EXCEPTION 'PREFLIGHT: member_separation.member_id (uuid) not found — apply sql/membership_window_2026-10-16.sql first. Refusing.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.member_separation'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_separation')
     OR has_table_privilege('anon', 'public.member_separation', 'SELECT') OR has_table_privilege('authenticated', 'public.member_separation', 'SELECT') THEN
    RAISE EXCEPTION 'PREFLIGHT: member_separation is no longer sealed (RLS on, no policies, no anon/authenticated SELECT). Refusing.';
  END IF;
  SELECT relacl::text INTO v_acl_before FROM pg_class WHERE oid = 'public.members_view'::regclass;
  SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) INTO v_cols_before
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'members_view';
  SELECT count(*) INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_fn_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
  SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;

  -- ---------------------------------------------------------------- 1. the view: live text + ONE appended column
  EXECUTE $view$
  CREATE OR REPLACE VIEW public.members_view WITH (security_invoker = false) AS
   SELECT id,
    department_id,
    name,
        CASE
            WHEN is_leader() THEN role
            ELSE NULL::text
        END AS role,
        CASE
            WHEN is_leader() THEN access
            ELSE NULL::text[]
        END AS access,
        CASE
            WHEN is_leader() THEN status
            ELSE NULL::text
        END AS status,
    phone,
    joined,
        CASE
            WHEN is_leader() THEN participation
            ELSE NULL::integer
        END AS participation,
    created_at,
    email,
    mentor_id,
        CASE
            WHEN is_leader() THEN (EXISTS ( SELECT 1
               FROM member_separation s
              WHERE s.member_id = members.id))
            ELSE NULL::boolean
        END AS separated
   FROM members
  WHERE department_id = my_department_id()
  $view$;

  -- ---------------------------------------------------------------- 2. post-conditions
  SELECT string_agg(column_name || ':' || data_type, ',' ORDER BY ordinal_position) INTO v_cols_after
    FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'members_view';
  IF v_cols_after IS DISTINCT FROM v_cols_before || ',separated:boolean' THEN
    RAISE EXCEPTION 'Post-condition failed: columns are "%" (expected the old list + separated:boolean). Rolling back.', v_cols_after;
  END IF;
  SELECT relacl::text INTO v_acl_after FROM pg_class WHERE oid = 'public.members_view'::regclass;
  IF v_acl_after IS DISTINCT FROM v_acl_before THEN
    RAISE EXCEPTION 'Post-condition failed: members_view grants changed (% -> %). Rolling back.', v_acl_before, v_acl_after;
  END IF;
  SELECT coalesce(array_to_string(reloptions, ','), '') || '|' || pg_get_userbyid(relowner) INTO v_opts FROM pg_class WHERE oid = 'public.members_view'::regclass;
  IF v_opts IS DISTINCT FROM 'security_invoker=false|postgres' THEN RAISE EXCEPTION 'Post-condition failed: options/owner now "%". Rolling back.', v_opts; END IF;
  -- the old columns' expressions are untouched: the new definition = the old one with ONLY the separated column added
  IF md5(regexp_replace(pg_get_viewdef('public.members_view'::regclass, true),
           E',\\s+CASE\\s+WHEN is_leader\\(\\) THEN \\(EXISTS \\( SELECT 1\\s+FROM member_separation s\\s+WHERE s\\.member_id = members\\.id\\)\\)\\s+ELSE NULL::boolean\\s+END AS separated', ''))
     IS DISTINCT FROM c_view_md5 THEN
    RAISE EXCEPTION 'Post-condition failed: removing the separated column does not give back the pinned definition — something else changed. Rolling back.';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns c JOIN information_schema.views v ON v.table_schema = c.table_schema AND v.table_name = c.table_name
              WHERE c.table_schema = 'public' AND c.column_name = 'terminated_on') THEN
    RAISE EXCEPTION 'Post-condition failed: a view exposes terminated_on. Rolling back.';
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.member_separation'::regclass)
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_separation')
     OR has_table_privilege('anon', 'public.member_separation', 'SELECT') OR has_table_privilege('authenticated', 'public.member_separation', 'SELECT') THEN
    RAISE EXCEPTION 'Post-condition failed: member_separation is no longer sealed. Rolling back.';
  END IF;
  SELECT count(*) INTO v_pol_after FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_fn_after FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
  IF v_pol_after <> v_pol_before OR v_fn_after <> v_fn_before THEN
    RAISE EXCEPTION 'Post-condition failed: policies %->% / functions %->% changed. Rolling back.', v_pol_before, v_pol_after, v_fn_before, v_fn_after;
  END IF;
  -- verified untouched (nothing here writes station_presence; prove it)
  SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
  IF v_ver_after <> v_ver_before THEN RAISE EXCEPTION 'Post-condition failed: verified presence changed (% -> %). Rolling back.', v_ver_before, v_ver_after; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------- state row (expected live: see the header of the RETEST)
SELECT jsonb_build_object(
  'separated_column',     (SELECT data_type FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'members_view' AND column_name = 'separated'),
  'view_columns',         (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'members_view'),
  'view_options_owner',   (SELECT coalesce(array_to_string(reloptions, ','), '') || '|' || pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public.members_view'::regclass),
  'view_acl',             (SELECT relacl::text FROM pg_class WHERE oid = 'public.members_view'::regclass),
  'new_view_md5',         md5(pg_get_viewdef('public.members_view'::regclass, true)),
  'terminated_on_in_view',(SELECT count(*) FROM information_schema.columns c JOIN information_schema.views v ON v.table_schema = c.table_schema AND v.table_name = c.table_name
                            WHERE c.table_schema = 'public' AND c.column_name = 'terminated_on'),
  'sep_sealed',           (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.member_separation'::regclass)
                            AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'member_separation')
                            AND NOT has_table_privilege('authenticated', 'public.member_separation', 'SELECT'),
  'members_with_separation_row', (SELECT count(*) FROM public.members m WHERE EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)),
  'separated_active_or_prob',    (SELECT count(*) FROM public.members m WHERE m.status IN ('Active','Probationary') AND EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)),
  'total_policies',       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'fn_count',             (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'verified_presence',    (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
