-- =====================================================================
-- RETEST for e1e3_sliceR_session_reactions. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Everything runs inside ONE sub-block ending in RAISE 'SENTINEL' (rolled back): synthetic sessions, a synthetic roll, Finalize,
-- votes, Correct, Reopen — NOTHING STAYS. The final RAISE is the report — the "ERROR" IS the report.
-- Acts as REAL people through the API path (JWT email claim, role authenticated): a real Department Admin whose department has
-- ≥ 4 other active members (unique emails, inside their membership window for the oldest synthetic date), and four of those
-- members (non-leaders first). Synthetic sessions + their rolls are written as the table owner, as in Slice T's RETEST.
--   S0  the slice is in place: the table, RLS on, exactly the one own-row SELECT policy, authenticated SELECT only, anon nothing,
--       both functions SECURITY DEFINER and not executable by anon
--   R1  a member votes 1: reads back their own row and nothing else
--   R2  re-vote -1: the same row changes (still one row for that member + session) — no duplicate
--   R3  THE ANONYMITY PROOF: 4 votes on session A; the real DA's raw SELECT returns 0 rows of anyone else's, while the tally
--       returns the counts (up 2, down 2)
--   R4  a 2-vote session returns NO tally row (≥ 3 enforced in the DB), while the 4-vote session in the same call does
--   R5  a member NOT on the roll → NOT_PRESENT, nothing written
--   R6  the window: a session dated 15 days ago → CLOSED; 14 days ago → accepted
--   R7  refusals: not finalized · value 0 · value 2 · NULL · an unknown session → refused by the RPC; value 0 written raw by the
--       owner → the CHECK
--   R8  no write path but the RPC: a member's raw INSERT / UPDATE / DELETE on the table → permission denied
--   R9  removed from the roll (via Correct) → their vote stops counting (up 2, down 1); remove one more → below 3 → NO row
--   R10 a non-leader calling the tally → NOT_ALLOWED
--   R11 a reopened session refuses new votes (NOT_FINALIZED) and keeps the existing ones
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_email text; v_me uuid; v_dept uuid; v_m uuid[]; v_e text[]; v_lead boolean[]; v_nl int;
  sA uuid; sB uuid; s14 uuid; s15 uuid; sN uuid; v_ok boolean; v_t text; v_n bigint; v_n2 bigint; v_n3 bigint; v_r jsonb; v_up int; v_down int;
BEGIN
  BEGIN
    SELECT lower(m.email), m.id, m.department_id INTO v_email, v_me, v_dept FROM public.members m
     WHERE m.access && array['Department Admin']::text[] AND m.status = 'Active' AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members y WHERE lower(y.email) = lower(m.email)) = 1
           AND public.membership_window_allows(m.id, v_today - 15)
       AND (SELECT count(*) FROM public.members o WHERE o.department_id = m.department_id AND o.id <> m.id AND o.status = 'Active' AND o.email IS NOT NULL AND (SELECT count(*) FROM public.members y WHERE lower(y.email) = lower(o.email)) = 1
           AND public.membership_window_allows(o.id, v_today - 15)) >= 4
     ORDER BY m.department_id, m.id LIMIT 1;
    IF v_email IS NULL THEN RAISE EXCEPTION 'SKIPALL: no real Department Admin whose department has 4 other eligible active members'; END IF;
    SELECT array_agg(z.id ORDER BY z.ord), array_agg(z.em ORDER BY z.ord), array_agg(z.lead ORDER BY z.ord) INTO v_m, v_e, v_lead FROM (
      SELECT o.id, lower(o.email) AS em, (o.access && array['Project Admin','Department Admin','Board Member','Officer']::text[]) AS lead,
             row_number() OVER (ORDER BY (o.access && array['Project Admin','Department Admin','Board Member','Officer']::text[]), o.id) AS ord
        FROM public.members o WHERE o.department_id = v_dept AND o.id <> v_me AND o.status = 'Active' AND o.email IS NOT NULL AND (SELECT count(*) FROM public.members y WHERE lower(y.email) = lower(o.email)) = 1
           AND public.membership_window_allows(o.id, v_today - 15)) z WHERE z.ord <= 4;

    -- S0
    IF to_regclass('public.training_session_reactions') IS NOT NULL AND (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_reactions') = 1
     AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_reactions' AND policyname = 'members read own reaction'
                   AND cmd = 'SELECT' AND roles::text = '{authenticated}' AND qual = '(member_id = my_member_id())' AND with_check IS NULL AND permissive = 'PERMISSIVE')
     AND (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.training_session_reactions'::regclass)
       AND has_table_privilege('authenticated', 'public.training_session_reactions', 'SELECT')
     AND NOT has_table_privilege('authenticated', 'public.training_session_reactions', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     AND NOT has_table_privilege('anon', 'public.training_session_reactions', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     AND NOT EXISTS (SELECT 1 FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = 'public.training_session_reactions'::regclass)) g WHERE g.grantee = 0)
     AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'training_session_reactions' AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT')
       AND (SELECT prosecdef AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM pg_proc WHERE oid = 'public.set_session_reaction(uuid, integer)'::regprocedure)
       AND (SELECT prosecdef AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM pg_proc WHERE oid = 'public.session_reaction_tally(uuid[])'::regprocedure) THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  S0 table + RLS on + exactly the one own-row SELECT policy; authenticated SELECT only, anon nothing; both RPCs SECURITY DEFINER, anon cannot execute' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  S0 the slice is not in place as intended%s', chr(10)); END IF;

    -- synthetic sessions + rolls (owner), finalized as the real DA (the membership-window trigger still runs — eligible members only)
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-R RETEST A', v_today - 1, '19:00') RETURNING id INTO sA;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-R RETEST B', v_today - 1, '19:00') RETURNING id INTO sB;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-R RETEST 14', v_today - 14, '19:00') RETURNING id INTO s14;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-R RETEST 15', v_today - 15, '19:00') RETURNING id INTO s15;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-R RETEST N', v_today - 1, '19:00') RETURNING id INTO sN;
    BEGIN
      INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES
        (v_dept, sA, v_me, now()), (v_dept, sA, v_m[1], now()), (v_dept, sA, v_m[2], now()), (v_dept, sA, v_m[3], now()),
        (v_dept, sB, v_m[1], now()), (v_dept, sB, v_m[2], now()),
        (v_dept, s14, v_m[1], now()), (v_dept, s15, v_m[1], now()), (v_dept, sN, v_m[1], now());
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SKIPALL: the synthetic roll was refused (%)', SQLERRM;
    END;
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.finalize_training_session(p_session_id => sA, p_duration_min => 60);
    PERFORM public.finalize_training_session(p_session_id => sB, p_duration_min => 60);
    PERFORM public.finalize_training_session(p_session_id => s14, p_duration_min => 60);
    PERFORM public.finalize_training_session(p_session_id => s15, p_duration_min => 60);
    EXECUTE 'RESET ROLE';

    -- R1
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[1])::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    v_r := public.set_session_reaction(sA, 1);
    SELECT count(*) FILTER (WHERE member_id <> v_m[1]), count(*) FILTER (WHERE session_id = sA AND value = 1) INTO v_n, v_n2 FROM public.training_session_reactions;
    EXECUTE 'RESET ROLE';
    IF (v_r->>'value')::int = 1 AND v_n = 0 AND v_n2 = 1 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  R1 a member votes 1 and reads back their own row — no one else''s' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R1 vote/read-back: %s, others visible %s, own %s%s', v_r, v_n, v_n2, chr(10)); END IF;

    -- R2
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[1])::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.set_session_reaction(sA, -1);
    EXECUTE 'RESET ROLE';
    SELECT count(*), min(value) INTO v_n, v_up FROM public.training_session_reactions WHERE session_id = sA AND member_id = v_m[1];
    IF v_n = 1 AND v_up = -1 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  R2 re-vote -1 updates the same row (one row, value -1) — no duplicate' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R2 re-vote: %s rows, value %s%s', v_n, v_up, chr(10)); END IF;

    -- R3 the anonymity proof
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.set_session_reaction(sA, 1); EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[2])::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.set_session_reaction(sA, 1); EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[3])::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.set_session_reaction(sA, -1); EXECUTE 'RESET ROLE';
    SELECT count(*) INTO v_n3 FROM public.training_session_reactions WHERE session_id = sA;
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) FILTER (WHERE member_id <> v_me), count(*) FILTER (WHERE member_id = v_me AND session_id = sA) INTO v_n, v_n2 FROM public.training_session_reactions;
    SELECT t.up, t.down INTO v_up, v_down FROM public.session_reaction_tally(ARRAY[sA]) t;
    EXECUTE 'RESET ROLE';
    IF v_n3 = 4 AND v_n = 0 AND v_n2 = 1 AND v_up = 2 AND v_down = 2 THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  R3 4 votes on session A: the real DA''s raw SELECT returns 0 rows of anyone else''s (only their own), while the tally returns up 2 · down 2' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R3 rows on A %s; DA sees %s others / %s own; tally up %s down %s%s', v_n3, v_n, v_n2, v_up, v_down, chr(10)); END IF;

    -- R4 the ≥ 3 threshold
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[1])::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.set_session_reaction(sB, 1); EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[2])::text, true); EXECUTE 'SET LOCAL ROLE authenticated'; PERFORM public.set_session_reaction(sB, -1); EXECUTE 'RESET ROLE';
    SELECT count(*) INTO v_n3 FROM public.training_session_reactions WHERE session_id = sB;
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    SELECT count(*) FILTER (WHERE t.session_id = sB), count(*) FILTER (WHERE t.session_id = sA) INTO v_n, v_n2 FROM public.session_reaction_tally(ARRAY[sA, sB]) t;
    EXECUTE 'RESET ROLE';
    IF v_n3 = 2 AND v_n = 0 AND v_n2 = 1 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  R4 a 2-vote session returns NO tally row (≥ 3 enforced in the DB); the 4-vote session in the same call does' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R4 B has %s votes; tally rows B %s, A %s%s', v_n3, v_n, v_n2, chr(10)); END IF;

    -- R5 not on the roll
    v_t := NULL;
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[4])::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN PERFORM public.set_session_reaction(sA, 1); EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    EXECUTE 'RESET ROLE';
    IF v_t LIKE 'NOT_PRESENT%' AND NOT EXISTS (SELECT 1 FROM public.training_session_reactions WHERE member_id = v_m[4] AND session_id = sA) THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  R5 a member not on the roll → NOT_PRESENT, nothing written' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R5 %s%s', coalesce(v_t, 'accepted'), chr(10)); END IF;

    -- R6 the 14-day window (America/Chicago)
    v_t := NULL;
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[1])::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN PERFORM public.set_session_reaction(s15, 1); EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    v_r := public.set_session_reaction(s14, 1);
    EXECUTE 'RESET ROLE';
    IF v_t LIKE 'CLOSED%' AND (v_r->>'value')::int = 1 AND NOT EXISTS (SELECT 1 FROM public.training_session_reactions WHERE session_id = s15) THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  R6 a session dated 15 days ago → CLOSED; 14 days ago → accepted' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R6 15 days: %s; 14 days: %s%s', coalesce(v_t, 'accepted'), v_r, chr(10)); END IF;

    -- R7 refusals
    v_n := 0;
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[1])::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN PERFORM public.set_session_reaction(sN, 1); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'NOT_FINALIZED%' THEN v_n := v_n + 1; END IF; END;
    BEGIN PERFORM public.set_session_reaction(sA, 0); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF; END;
    BEGIN PERFORM public.set_session_reaction(sA, 2); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF; END;
    BEGIN PERFORM public.set_session_reaction(sA, NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF; END;
    BEGIN PERFORM public.set_session_reaction(gen_random_uuid(), 1); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'NOT_FOUND%' THEN v_n := v_n + 1; END IF; END;
    EXECUTE 'RESET ROLE';
    BEGIN INSERT INTO public.training_session_reactions (department_id, session_id, member_id, value) VALUES (v_dept, sN, v_m[1], 0); EXCEPTION WHEN check_violation THEN v_n := v_n + 1; END;
    IF v_n = 6 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  R7 refused: not finalized · value 0 · value 2 · NULL · unknown session (RPC); value 0 written raw → the CHECK' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R7 %s of 6 refused%s', v_n, chr(10)); END IF;

    -- R8 no write path but the RPC
    v_n := 0;
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[1])::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN INSERT INTO public.training_session_reactions (department_id, session_id, member_id, value) VALUES (v_dept, sB, v_m[1], 1); EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; WHEN OTHERS THEN NULL; END;
    BEGIN UPDATE public.training_session_reactions SET value = 1 WHERE member_id = v_m[1]; EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; WHEN OTHERS THEN NULL; END;
    BEGIN DELETE FROM public.training_session_reactions WHERE member_id = v_m[1]; EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; WHEN OTHERS THEN NULL; END;
    EXECUTE 'RESET ROLE';
    IF v_n = 3 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  R8 a member''s raw INSERT / UPDATE / DELETE on the table → permission denied (the RPC is the only write path)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R8 %s of 3 raw writes refused%s', v_n, chr(10)); END IF;

    -- R9 removed from the roll → stops counting (A: m1 -1, DA 1, m2 1, m3 -1)
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.correct_training_session(sA, '{}'::jsonb, '{}'::uuid[], ARRAY[v_m[3]], 'RETEST: remove from the roll');
    SELECT t.up, t.down INTO v_up, v_down FROM public.session_reaction_tally(ARRAY[sA]) t;
    PERFORM public.correct_training_session(sA, '{}'::jsonb, '{}'::uuid[], ARRAY[v_m[2]], 'RETEST: remove one more from the roll');
    SELECT count(*) INTO v_n FROM public.session_reaction_tally(ARRAY[sA]) t;
    EXECUTE 'RESET ROLE';
    SELECT count(*) INTO v_n2 FROM public.training_session_reactions WHERE session_id = sA;
    IF v_up = 2 AND v_down = 1 AND v_n = 0 AND v_n2 = 4 THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  R9 removed from the roll via Correct → that vote stops counting (up 2 · down 1); one more removed → 2 counted → NO row (the votes themselves stay)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R9 after one removal up %s down %s; after two %s rows; stored votes %s%s', v_up, v_down, v_n, v_n2, chr(10)); END IF;

    -- R10 a non-leader cannot read the tally
    SELECT min(i) INTO v_nl FROM generate_subscripts(v_lead, 1) i WHERE NOT v_lead[i];
    IF v_nl IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || 'SKIP  R10 the four members picked are all leaders — the PGlite dry run carries this case' || chr(10);
    ELSE
      v_t := NULL;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[v_nl])::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
      BEGIN PERFORM * FROM public.session_reaction_tally(ARRAY[sA]); EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
      EXECUTE 'RESET ROLE';
      IF v_t LIKE 'NOT_ALLOWED%' THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  R10 a non-leader calling the tally → NOT_ALLOWED' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R10 %s%s', coalesce(v_t, 'returned rows'), chr(10)); END IF;
    END IF;

    -- R11 reopened: new votes refused, existing ones kept
    v_t := NULL;
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.reopen_training_session(sB, 'RETEST: reopen to check reactions');
    EXECUTE 'RESET ROLE';
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_e[1])::text, true); EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN PERFORM public.set_session_reaction(sB, 1); EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    EXECUTE 'RESET ROLE';
    IF v_t LIKE 'NOT_FINALIZED%' AND (SELECT count(*) FROM public.training_session_reactions WHERE session_id = sB) = 2 AND (SELECT value FROM public.training_session_reactions WHERE session_id = sB AND member_id = v_m[1]) = 1 THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  R11 a reopened session refuses new votes (NOT_FINALIZED) and keeps the existing two' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  R11 %s%s', coalesce(v_t, 'accepted'), chr(10)); END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SKIPALL:%' THEN v_skip := v_skip + 1; rpt := rpt || 'SKIP  ' || SQLERRM || chr(10);
    ELSIF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('FAIL  the RETEST block aborted: %s%s', SQLERRM, chr(10)); END IF;
  END;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
