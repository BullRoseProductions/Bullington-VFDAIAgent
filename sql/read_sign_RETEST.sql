-- =====================================================================
-- RETEST for read_sign_2026-10-17.sql. RAN 2026-10-17 on live: 51 passed, 0 failed, 2 skipped (IH, Lipan, North Hood all 17/17;
-- Demo + Granbury skip). Honest audiences: IH 37 · Lipan 28 · North Hood 27. Run AFTER the migration, separately. NOTHING CHANGES: each department's checks run
-- inside a sub-block that ends in RAISE 'SENTINEL' (rolled back), on FIXTURE documents it creates itself — no real SOP
-- is configured, published or signed. The final RAISE is the report. The "ERROR" IS the report.
-- Per department (needs a DA, an Officer and two plain members with unique emails, plus a DA in another department):
--   S1 a new upload starts its own series        S2 replace_document (as the DA) -> the new row keeps the series
--   C1 a member can't configure                   C2 another department's DA can't configure this document
--   C3 the DA turns requires_ack on -> v1 published with a sha256 fingerprint
--   Q1 member A's queue: needs, with the v1 fingerprint
--   A1 wrong fingerprint / wrong version refused  A2 signing works; signing again is idempotent (one row)
--   R1 member B can't see A's signature; A sees their own
--   R2 a member's direct INSERT / UPDATE / DELETE on document_acknowledgments is refused
--   R3 append-only: even the owner's UPDATE / DELETE is refused by the trigger
--   P1 a member can't publish                     P2 the Officer publishes v2 -> A is "resign", the v1 row survives,
--                                                   re-signing adds a v2 row (2 rows)
--   L1 compliance as the DA: B outstanding, A current; as a member: refused
--   H1 honest denominator: audience = exactly the department's non-Inactive, non-former, non-Project-Admin members, and
--      none of the excluded kinds appears among the outstanding
--   N1 required_roles {Board Member}: A (not board) drops out of the queue and can't sign
--   Y1 annual re-sign: a 13-month-old current-version signature reads "resign"
-- DRY RUN 2026-10-17 — PGlite mock (2 departments, Supabase-style default grants, a mocked replace_document that sets
-- supersedes + archived_at): migration OK + idempotent; backfill put a replaced pair in one series; this RETEST 17 passed /
-- 0 failed / 1 skipped (mock dept 2 has one plain member). Re-run 2026-10-17 after switching to the live dept-scoped
-- is_canmanage_ops()/is_canmanage(): same 17/0/1. Mutations, each caught: the document's own department check dropped
-- -> C2 FAIL · leader read without is_canmanage() -> R1 FAIL · no append-only trigger -> migration rolls back · no fingerprint check -> A1 FAIL · a member
-- write grant -> migration rolls back · no series inherit on replace -> S2+ FAIL · audience counts Inactive -> H1 FAIL.
-- =====================================================================
DO $retest$
DECLARE
  rec record; v_err text; v_res jsonb; v_n int; v_hash text; v_ver int; v_st text; v_bout boolean; v_acur boolean;
  v_da text; v_off text; v_a text; v_b text; v_other_da text; v_a_id uuid; v_b_id uuid;
  v_doc uuid; v_doc2 uuid; v_series uuid;
  rpt text := chr(10); v_pass int := 0; v_fail int := 0; v_skip int := 0;
BEGIN
  FOR rec IN SELECT d.id AS dept_id, d.name AS dept FROM public.departments d ORDER BY d.name LOOP
    rpt := rpt || format('— %s%s', rec.dept, chr(10));
    v_da := NULL; v_off := NULL; v_a := NULL; v_b := NULL; v_other_da := NULL;
    SELECT lower(m.email) INTO v_da FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_off FROM public.members m WHERE m.department_id = rec.dept_id AND m.access && array['Officer']::text[]
       AND NOT m.access && array['Department Admin','Project Admin']::text[]
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_a, v_a_id FROM public.members m WHERE m.department_id = rec.dept_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IS DISTINCT FROM 'Inactive' AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email), m.id INTO v_b, v_b_id FROM public.members m WHERE m.department_id = rec.dept_id AND m.id IS DISTINCT FROM v_a_id
       AND NOT coalesce(m.access && array['Department Admin','Project Admin','Officer','Board Member']::text[], false)
       AND m.status IS DISTINCT FROM 'Inactive' AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    SELECT lower(m.email) INTO v_other_da FROM public.members m WHERE m.department_id <> rec.dept_id AND m.access && array['Department Admin']::text[]
       AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.id LIMIT 1;
    IF v_da IS NULL OR v_a IS NULL OR v_b IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || format('   SKIP  all — needs a DA and two plain members with unique emails (DA %s, A %s, B %s)%s',
        coalesce(v_da, 'none'), coalesce(v_a, 'none'), coalesce(v_b, 'none'), chr(10));
      CONTINUE;
    END IF;

    BEGIN
      -- fixture documents (owner inserts; the series trigger runs)
      INSERT INTO public.documents (department_id, name, type, storage_path, content_text)
      VALUES (rec.dept_id, 'RETEST fixture SOP', 'SOP', rec.dept_id || '/retest-' || gen_random_uuid() || '.pdf', 'Fixture text for the Read & Sign retest.')
      RETURNING id, series_id INTO v_doc, v_series;
      -- S1
      IF v_series = v_doc THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  S1 new upload starts its own series%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  S1 series %s for doc %s%s', v_series, v_doc, chr(10)); END IF;
      -- S2 replace (the real replace_document, as the DA)
      INSERT INTO public.documents (department_id, name, type, storage_path, content_text)
      VALUES (rec.dept_id, 'RETEST fixture SOP', 'SOP', rec.dept_id || '/retest-' || gen_random_uuid() || '.pdf', 'Fixture text, corrected.')
      RETURNING id INTO v_doc2;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      BEGIN PERFORM public.replace_document(v_doc, v_doc2); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      SELECT count(*) INTO v_n FROM public.documents WHERE id = v_doc2 AND series_id = v_series;
      IF v_err = 'OK' AND v_n = 1 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  S2 replace keeps the series%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  S2 replace -> "%s", new row in series: %s%s', v_err, v_n, chr(10)); END IF;
      -- from here on the live row of the series is v_doc2
      -- C1 member can't configure
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.set_document_ack_config(v_doc2, true, NULL, false); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'Only a Department Admin or Officer%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  C1 member can''t configure%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C1 -> "%s"%s', v_err, chr(10)); END IF;
      -- C2 another department's DA
      IF v_other_da IS NULL THEN v_skip := v_skip + 1; rpt := rpt || format('   SKIP  C2 — no other-department DA%s', chr(10));
      ELSE
        PERFORM set_config('request.jwt.claims', json_build_object('email', v_other_da, 'role', 'authenticated')::text, true);
        PERFORM set_config('role', 'authenticated', true);
        BEGIN PERFORM public.set_document_ack_config(v_doc2, true, NULL, false); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
        PERFORM set_config('role', 'postgres', true);
        IF v_err LIKE 'Only a Department Admin or Officer%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  C2 another department''s DA refused%s', chr(10));
        ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C2 -> "%s"%s', v_err, chr(10)); END IF;
      END IF;
      -- C3 DA turns it on -> v1
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN v_res := public.set_document_ack_config(v_doc2, true, NULL, false); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT content_hash INTO v_hash FROM public.document_versions WHERE series_id = v_series AND version = 1 AND document_id = v_doc2;
      IF v_err = 'OK' AND (v_res->>'current_version')::int = 1 AND v_hash ~ '^[0-9a-f]{64}$' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  C3 DA config -> v1 published, sha256 fingerprint%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  C3 -> "%s" %s hash %s%s', v_err, v_res, v_hash, chr(10)); END IF;
      -- Q1 queue
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT q.status INTO v_st FROM public.my_read_sign_queue() q WHERE q.series_id = v_series AND q.content_hash = v_hash AND q.version = 1;
      IF v_st = 'needs' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  Q1 member queue: needs v1%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  Q1 status %s%s', coalesce(v_st, 'missing'), chr(10)); END IF;
      -- A1 bad fingerprint / version
      BEGIN PERFORM public.acknowledge_document(v_doc2, 1, repeat('0', 64)); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      BEGIN PERFORM public.acknowledge_document(v_doc2, 2, v_hash); v_st := 'OK'; EXCEPTION WHEN OTHERS THEN v_st := SQLERRM; END;
      IF v_err LIKE 'The document changed%' AND v_st LIKE 'A newer version%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  A1 wrong fingerprint / version refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A1 hash -> "%s", version -> "%s"%s', v_err, v_st, chr(10)); END IF;
      -- A2 sign + idempotent
      BEGIN PERFORM public.acknowledge_document(v_doc2, 1, v_hash); PERFORM public.acknowledge_document(v_doc2, 1, v_hash); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT count(*) INTO v_n FROM public.document_acknowledgments WHERE member_id = v_a_id AND series_id = v_series AND version = 1 AND content_hash = v_hash
         AND ack_statement = 'I have read and understand RETEST fixture SOP (v1) and agree to comply.';
      IF v_err = 'OK' AND v_n = 1 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  A2 signed once (idempotent), wording snapshotted%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  A2 -> "%s", rows %s%s', v_err, v_n, chr(10)); END IF;
      -- R1 visibility
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_b, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.document_acknowledgments WHERE member_id = v_a_id;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      SELECT count(*) INTO v_ver FROM public.document_acknowledgments WHERE member_id = v_a_id AND series_id = v_series;
      IF v_n = 0 AND v_ver = 1 THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  R1 B can''t see A''s signature; A sees their own%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R1 B saw %s, A saw %s%s', v_n, v_ver, chr(10)); END IF;
      -- R2 direct writes refused
      BEGIN INSERT INTO public.document_acknowledgments (department_id, series_id, document_id, member_id, version, content_hash, title, ack_statement)
            VALUES (rec.dept_id, v_series, v_doc2, v_a_id, 9, 'x', 'x', 'x'); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      BEGIN UPDATE public.document_acknowledgments SET version = 9 WHERE member_id = v_a_id; v_st := 'OK'; EXCEPTION WHEN OTHERS THEN v_st := SQLERRM; END;
      BEGIN DELETE FROM public.document_acknowledgments WHERE member_id = v_a_id; v_res := '{"d":"OK"}'; EXCEPTION WHEN OTHERS THEN v_res := jsonb_build_object('d', SQLERRM); END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err ILIKE '%permission denied%' AND v_st ILIKE '%permission denied%' AND v_res->>'d' ILIKE '%permission denied%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R2 member INSERT/UPDATE/DELETE refused%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R2 insert "%s" update "%s" delete %s%s', v_err, v_st, v_res, chr(10)); END IF;
      -- R3 append-only, even for the owner
      BEGIN UPDATE public.document_acknowledgments SET method = 'x' WHERE member_id = v_a_id AND series_id = v_series; v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      BEGIN DELETE FROM public.document_acknowledgments WHERE member_id = v_a_id AND series_id = v_series; v_st := 'OK'; EXCEPTION WHEN OTHERS THEN v_st := SQLERRM; END;
      IF v_err LIKE 'Signatures are permanent%' AND v_st LIKE 'Signatures are permanent%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  R3 append-only even for the owner%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  R3 update "%s" delete "%s"%s', v_err, v_st, chr(10)); END IF;
      -- P1 member can't publish
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN PERFORM public.publish_document_version(v_doc2); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_err LIKE 'Only a Department Admin or Officer%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  P1 member can''t publish%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  P1 -> "%s"%s', v_err, chr(10)); END IF;
      -- P2 Officer (or the DA when there's no officer) publishes v2
      PERFORM set_config('request.jwt.claims', json_build_object('email', coalesce(v_off, v_da), 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      BEGIN v_res := public.publish_document_version(v_doc2); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      SELECT q.status, q.content_hash INTO v_st, v_hash FROM public.my_read_sign_queue() q WHERE q.series_id = v_series;
      BEGIN PERFORM public.acknowledge_document(v_doc2, 2, v_hash); EXCEPTION WHEN OTHERS THEN v_err := v_err || ' / resign: ' || SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      SELECT count(*) INTO v_n FROM public.document_acknowledgments WHERE member_id = v_a_id AND series_id = v_series;
      IF v_err = 'OK' AND (v_res->>'current_version')::int = 2 AND v_st = 'resign' AND v_n = 2 THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  P2 %s published v2 -> A resign; v1 kept; re-sign -> 2 rows%s', CASE WHEN v_off IS NULL THEN 'DA' ELSE 'Officer' END, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  P2 -> "%s" %s status %s rows %s%s', v_err, v_res, v_st, v_n, chr(10)); END IF;
      -- L1 compliance
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT c.current_count, (c.outstanding @> jsonb_build_array(jsonb_build_object('member_id', v_b_id))),
             NOT (c.outstanding @> jsonb_build_array(jsonb_build_object('member_id', v_a_id))), c.audience
        INTO v_n, v_bout, v_acur, v_ver
        FROM (SELECT * FROM public.dept_read_sign_compliance() WHERE series_id = v_series) c;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      BEGIN PERFORM * FROM public.dept_read_sign_compliance(); v_st := 'OK'; EXCEPTION WHEN OTHERS THEN v_st := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_n >= 1 AND v_bout AND v_acur AND v_ver >= 2 AND v_st LIKE 'Only department leadership%' THEN
        v_pass := v_pass + 1; rpt := rpt || format('   PASS  L1 compliance %s of %s current; B outstanding, A current; member refused%s', v_n, v_ver, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  L1 current %s B-out %s A-current %s audience %s member "%s"%s', v_n, v_bout, v_acur, v_ver, v_st, chr(10)); END IF;
      -- H1 honest denominator (counted independently, as the owner)
      SELECT count(*) INTO v_n FROM public.members m WHERE m.department_id = rec.dept_id AND m.status IS DISTINCT FROM 'Inactive'
         AND NOT coalesce(m.access && array['Project Admin']::text[], false)
         AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id);
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_da, 'role', 'authenticated')::text, true);
      SELECT c.audience, (SELECT count(*) FROM jsonb_array_elements(c.outstanding) o JOIN public.members m ON m.id = (o->>'member_id')::uuid
                            WHERE m.status = 'Inactive' OR m.access && array['Project Admin']::text[]
                               OR EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id))
        INTO v_ver, v_hash
        FROM public.dept_read_sign_compliance() c WHERE c.series_id = v_series;
      IF v_ver = v_n AND v_hash = '0' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  H1 honest denominator: audience %s = eligible members; no inactive/former/PA counted%s', v_ver, chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  H1 audience %s vs eligible %s, excluded-kinds outstanding %s%s', v_ver, v_n, v_hash, chr(10)); END IF;
      SELECT content_hash INTO v_hash FROM public.document_versions WHERE series_id = v_series AND version = 2;
      -- Y1 annual: B's 13-month-old v2 signature (owner insert = fixture) reads resign
      UPDATE public.document_series SET annual_resign = true WHERE series_id = v_series;
      INSERT INTO public.document_acknowledgments (department_id, series_id, document_id, member_id, version, content_hash, title, ack_statement, signed_at)
      VALUES (rec.dept_id, v_series, v_doc2, v_b_id, 2, v_hash, 'RETEST fixture SOP', 'fixture', now() - interval '13 months');
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_b, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT q.status INTO v_st FROM public.my_read_sign_queue() q WHERE q.series_id = v_series;
      PERFORM set_config('role', 'postgres', true);
      IF v_st = 'resign' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  Y1 annual: a 13-month-old signature reads resign%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  Y1 status %s%s', coalesce(v_st, 'missing'), chr(10)); END IF;
      -- N1 audience by role
      UPDATE public.document_series SET required_roles = array['Board Member'] WHERE series_id = v_series;
      PERFORM set_config('request.jwt.claims', json_build_object('email', v_a, 'role', 'authenticated')::text, true);
      PERFORM set_config('role', 'authenticated', true);
      SELECT count(*) INTO v_n FROM public.my_read_sign_queue() q WHERE q.series_id = v_series;
      BEGIN PERFORM public.acknowledge_document(v_doc2, 2, v_hash); v_err := 'OK'; EXCEPTION WHEN OTHERS THEN v_err := SQLERRM; END;
      PERFORM set_config('role', 'postgres', true);
      IF v_n = 0 AND v_err LIKE 'This document isn''t required for you%' THEN v_pass := v_pass + 1; rpt := rpt || format('   PASS  N1 role audience: A drops out and can''t sign%s', chr(10));
      ELSE v_fail := v_fail + 1; rpt := rpt || format('   FAIL  N1 queue rows %s, sign "%s"%s', v_n, v_err, chr(10)); END IF;
      RAISE EXCEPTION 'SENTINEL';
    EXCEPTION WHEN OTHERS THEN
      IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('   FAIL  run aborted: %s%s', SQLERRM, chr(10)); END IF;
    END;
  END LOOP;

  RAISE EXCEPTION E'%\n---- % passed, % failed, % skipped ----\n(this exception IS the rollback — nothing was changed)', rpt, v_pass, v_fail, v_skip;
END
$retest$;
