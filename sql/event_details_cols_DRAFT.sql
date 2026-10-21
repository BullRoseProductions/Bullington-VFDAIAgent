-- =====================================================================
-- EVENT DETAILS — DB (three nullable columns on two tables) — Review PASS 2026-10-21 (5504b18). Not yet applied.
-- Order: claude/B4C_EventDetails_DB_BuildOrder.md. Off the live Step 0 (2026-10-21, docs/review/event_details_STEP0_OUTPUT.md
-- + docs/review/event_details_STEP0_app_side.md).
--
-- THE CHANGE — purely additive, both funding_events and recruitment_events, all nullable, no default:
--   start_time time   (matches training_sessions.start_time)
--   end_time   time   (new — training has none)
--   location_label text (matches training_sessions.location_label; reviewer ruling E3)
-- NOT added: notes (exists on both). NO GRANT (Step 0 E2: no column ACLs; table grants full — RLS is the gate). NO policy
-- change (E4: the four department-scoped policies per table already cover INSERT / UPDATE / DELETE via is_canmanage_ops()).
-- Every existing event (7) reads all-day / no location afterward. No table merge — the combined calendar is UI-only.
--
-- Single all-or-nothing DO block; refuses a second apply (the three columns must be absent on both) and refuses on
-- drift (the eight policies pinned verbatim; notes present; RLS on). Post-conditions: exactly the three columns added
-- per table with the right types, nullable, no default; every other column, constraint, index and trigger unchanged;
-- every policy byte-identical and the count unchanged; table + column ACLs unchanged and the new columns writable by
-- authenticated; my_department_rollup() (the one reader) unchanged at md5 7b12e359…; the locked-token function count
-- unchanged. The locked verification column is never touched. State check at the end.
-- =====================================================================
DO $migrate$
DECLARE
  TBLS constant text[] := array['funding_events', 'recruitment_events'];
  NEWCOLS constant text[] := array['start_time', 'end_time', 'location_label'];
  ROLLUP_MD5 constant text := '7b12e359bf7af9343565435658253a23';
  -- the eight policies, verbatim as Step 0 read them: name | cmd | roles | USING | CHECK  (one block per table, %s = table)
  POL_SHAPE constant text :=
       'leaders delete %1$s|DELETE|{authenticated}|((department_id = my_department_id()) AND is_canmanage_ops())|' || E'\n'
    || 'leaders update %1$s|UPDATE|{authenticated}|((department_id = my_department_id()) AND is_canmanage_ops())|((department_id = my_department_id()) AND is_canmanage_ops())' || E'\n'
    || 'leaders write %1$s|INSERT|{authenticated}||((department_id = my_department_id()) AND is_canmanage_ops())' || E'\n'
    || 'members read %1$s|SELECT|{authenticated}|(department_id = my_department_id())|';
  t text; v_n int; v_got text;
  v_cols_before text; v_cols_after text; v_obj_before text; v_obj_after text; v_acl_before text; v_acl_after text;
  v_pol_before text; v_pol_after text; v_total_before int; v_tok_before int; v_fns_before text; v_fns_after text;
BEGIN
  -- ---------------------------------------------------------------- preconditions
  FOREACH t IN ARRAY TBLS LOOP
    IF to_regclass('public.' || t) IS NULL THEN RAISE EXCEPTION 'Precondition failed: public.% is missing. Nothing changed.', t; END IF;
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || t)::regclass) THEN
      RAISE EXCEPTION 'Precondition failed: RLS is off on %. Nothing changed.', t;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = 'notes' AND data_type = 'text') THEN
      RAISE EXCEPTION 'Precondition failed: %.notes (text) is missing — Step 0 found it on both tables. Nothing changed.', t;
    END IF;
    SELECT count(*) INTO v_n FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = ANY (NEWCOLS);
    IF v_n = 3 THEN RAISE EXCEPTION 'Precondition failed: % already has start_time / end_time / location_label — already applied. Nothing changed.', t; END IF;
    IF v_n <> 0 THEN RAISE EXCEPTION 'Precondition failed: % has % of the three new columns — a partial earlier change. Nothing changed.', t, v_n; END IF;
    SELECT string_agg(policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY policyname)
      INTO v_got FROM pg_policies WHERE schemaname = 'public' AND tablename = t;
    IF v_got IS DISTINCT FROM format(POL_SHAPE, t) THEN
      RAISE EXCEPTION E'Precondition failed: the % policies are not the four Step 0 read. Found:\n%\nNothing changed.', t, v_got;
    END IF;
  END LOOP;
  IF md5(pg_get_functiondef('public.my_department_rollup()'::regprocedure)) <> ROLLUP_MD5 THEN
    RAISE EXCEPTION 'Precondition failed: my_department_rollup() is not the G2-fixed version (md5 7b12e359…). Nothing changed.';
  END IF;

  -- snapshots: columns, constraints / indexes / triggers, ACLs (table + column), every policy, every function
  SELECT string_agg(c.relname || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|'
                    || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), E'\n' ORDER BY c.relname, a.attnum)
    INTO v_cols_before FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (TBLS) AND a.attnum > 0 AND NOT a.attisdropped;
  SELECT string_agg(x, E'\n' ORDER BY x) INTO v_obj_before FROM (
    SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) AS x FROM pg_constraint WHERE conrelid IN ('public.funding_events'::regclass, 'public.recruitment_events'::regclass)
    UNION ALL SELECT 'idx|' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY (TBLS)
    UNION ALL SELECT 'trg|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.funding_events'::regclass, 'public.recruitment_events'::regclass)) s;
  SELECT string_agg(c.relname || '|' || coalesce(c.relacl::text, '') || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|'
                    || coalesce((SELECT string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL), ''), E'\n' ORDER BY c.relname)
    INTO v_acl_before FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (TBLS);
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_total_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_tok_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_before FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p');

  -- ---------------------------------------------------------------- the change
  ALTER TABLE public.funding_events
    ADD COLUMN start_time time,
    ADD COLUMN end_time time,
    ADD COLUMN location_label text;
  ALTER TABLE public.recruitment_events
    ADD COLUMN start_time time,
    ADD COLUMN end_time time,
    ADD COLUMN location_label text;

  -- ---------------------------------------------------------------- post-conditions
  -- (1) exactly the old columns + the three new ones, in that order, with the right types, nullable, no default
  SELECT string_agg(c.relname || '.' || a.attname || '|' || format_type(a.atttypid, a.atttypmod) || '|' || a.attnotnull::text || '|'
                    || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), E'\n' ORDER BY c.relname, a.attnum)
    INTO v_cols_after FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
   WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (TBLS) AND a.attnum > 0 AND NOT a.attisdropped;
  IF v_cols_after IS DISTINCT FROM (
       SELECT string_agg(blk, E'\n' ORDER BY tb) FROM (
         SELECT tb, (SELECT string_agg(l, E'\n') FROM unnest(string_to_array(v_cols_before, E'\n')) l WHERE l LIKE tb || '.%')
                    || E'\n' || tb || '.start_time|time without time zone|false|'
                    || E'\n' || tb || '.end_time|time without time zone|false|'
                    || E'\n' || tb || '.location_label|text|false|' AS blk
           FROM unnest(TBLS) tb) s) THEN
    RAISE EXCEPTION E'Post-condition failed: the columns are not exactly the old set + start_time time, end_time time, location_label text (nullable, no default). Got:\n%', v_cols_after;
  END IF;
  -- (2) constraints / indexes / triggers, ACLs + RLS, policies, functions: all unchanged
  SELECT string_agg(x, E'\n' ORDER BY x) INTO v_obj_after FROM (
    SELECT 'con|' || conrelid::regclass::text || '|' || conname || '|' || pg_get_constraintdef(oid) AS x FROM pg_constraint WHERE conrelid IN ('public.funding_events'::regclass, 'public.recruitment_events'::regclass)
    UNION ALL SELECT 'idx|' || indexdef FROM pg_indexes WHERE schemaname = 'public' AND tablename = ANY (TBLS)
    UNION ALL SELECT 'trg|' || tgname || '|' || pg_get_triggerdef(oid) FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN ('public.funding_events'::regclass, 'public.recruitment_events'::regclass)) s;
  IF v_obj_after IS DISTINCT FROM v_obj_before THEN RAISE EXCEPTION 'Post-condition failed: a constraint, index or trigger on the two tables changed.'; END IF;
  SELECT string_agg(c.relname || '|' || coalesce(c.relacl::text, '') || '|' || c.relrowsecurity::text || '|' || c.relforcerowsecurity::text || '|'
                    || coalesce((SELECT string_agg(a.attname || '=' || a.attacl::text, ',' ORDER BY a.attnum) FROM pg_attribute a WHERE a.attrelid = c.oid AND a.attacl IS NOT NULL), ''), E'\n' ORDER BY c.relname)
    INTO v_acl_after FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY (TBLS);
  IF v_acl_after IS DISTINCT FROM v_acl_before THEN RAISE EXCEPTION 'Post-condition failed: a table or column ACL, or RLS, changed on the two tables.'; END IF;
  IF EXISTS (SELECT 1 FROM unnest(TBLS) tb CROSS JOIN unnest(NEWCOLS) col
              WHERE NOT (has_column_privilege('authenticated', 'public.' || tb, col, 'INSERT') AND has_column_privilege('authenticated', 'public.' || tb, col, 'UPDATE')
                         AND has_column_privilege('authenticated', 'public.' || tb, col, 'SELECT'))) THEN
    RAISE EXCEPTION 'Post-condition failed: a new column is not selectable / insertable / updatable by authenticated.';
  END IF;
  SELECT string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), E'\n' ORDER BY tablename, policyname)
    INTO v_pol_after FROM pg_policies WHERE schemaname = 'public';
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy changed.'; END IF;
  IF (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') <> v_total_before THEN RAISE EXCEPTION 'Post-condition failed: the policy count changed.'; END IF;
  SELECT string_agg(p.oid::regprocedure::text || '|' || md5(pg_get_functiondef(p.oid)), E'\n' ORDER BY p.oid::regprocedure::text)
    INTO v_fns_after FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind IN ('f', 'p');
  IF v_fns_after IS DISTINCT FROM v_fns_before THEN RAISE EXCEPTION 'Post-condition failed: a public function changed.'; END IF;
  IF md5(pg_get_functiondef('public.my_department_rollup()'::regprocedure)) <> ROLLUP_MD5 THEN
    RAISE EXCEPTION 'Post-condition failed: my_department_rollup() changed.';
  END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) <> v_tok_before THEN
    RAISE EXCEPTION 'Post-condition failed: the locked verification token count changed.';
  END IF;
  -- (3) every existing event reads all-day / no location
  IF EXISTS (SELECT 1 FROM public.funding_events WHERE start_time IS NOT NULL OR end_time IS NOT NULL OR location_label IS NOT NULL)
     OR EXISTS (SELECT 1 FROM public.recruitment_events WHERE start_time IS NOT NULL OR end_time IS NOT NULL OR location_label IS NOT NULL) THEN
    RAISE EXCEPTION 'Post-condition failed: an existing event has a non-null new field.';
  END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (expect: funding_new_cols 3 · recruitment_new_cols 3 · nullable_new_cols 6 · event_policies 8 · rollup_md5_ok true ·
--              total_policies 169 · locked_token_fns 17)
SELECT
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'funding_events'
      AND column_name IN ('start_time', 'end_time', 'location_label')) AS funding_new_cols,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'recruitment_events'
      AND column_name IN ('start_time', 'end_time', 'location_label')) AS recruitment_new_cols,
  (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name IN ('funding_events', 'recruitment_events')
      AND column_name IN ('start_time', 'end_time', 'location_label') AND is_nullable = 'YES') AS nullable_new_cols,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('funding_events', 'recruitment_events')) AS event_policies,
  md5(pg_get_functiondef('public.my_department_rollup()'::regprocedure)) = '7b12e359bf7af9343565435658253a23' AS rollup_md5_ok,
  (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies,
  (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND position(('verifie' || 'd') in prosrc) > 0) AS locked_token_fns;
