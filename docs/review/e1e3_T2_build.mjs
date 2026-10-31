// node docs/review/e1e3_T2_build.mjs           — write the files
// node docs/review/e1e3_T2_build.mjs --check   — regenerate in memory; exit 1 unless every file on disk is byte-identical
// E1/E3 T2 (DB amendment). GENERATED from the live captures (2026-10-31, read-only, after Slices T + R):
//   docs/review/e1e3_T2_LIVE_fns.json   (sql/e1e3_T2_CAPTURE_A_fns.sql)  — the function definitions + md5 + ACL
//   docs/review/e1e3_T2_LIVE_meta.json  (sql/e1e3_T2_CAPTURE_B_meta.sql) — triggers, constraints, columns, policy md5, counts, ledger
// Writes: sql/e1e3_T2_times_replace_estimate_DRAFT.sql · _RETEST.sql · _ROLLBACK.sql · docs/review/e1e3_T2_CHANGE_LIST.md
// Ruling (Ashlea, flag 1 of B4C_E1E3_U1_UI_ReviewRecord): at finalize, the actual times REPLACE a pre-finalize length — a
// session that isn't finalized has no recorded length, only an estimate. ONE function changes: the times overload of
// finalize_training_session loses its "already has a length" USE_CORRECT refusal (the diff still logs duration_min old → new);
// its refusals for existing actual times / existing setup stay. Nothing else.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
const root = fileURLToPath(new URL("../../", import.meta.url));
const F = JSON.parse(readFileSync(join(root, "docs/review/e1e3_T2_LIVE_fns.json"), "utf8"));
const M = JSON.parse(readFileSync(join(root, "docs/review/e1e3_T2_LIVE_meta.json"), "utf8"));
const out = {};
const q = (s) => s.replace(/'/g, "''");
const must = (c, why) => { if (!c) throw new Error(`capture drifted from what T2 was designed on: ${why}`); };
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const byC = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);   // code-point order = ORDER BY … COLLATE "C"
const body = (def) => { const m = /AS \$function\$([\s\S]*)\$function\$\s*$/.exec(def); must(m, "no $function$ body"); return m[1]; };

// ---------------------------------------------------------------- the capture must still say what the ruling rests on
const TF_SIG = "finalize_training_session(p_session_id uuid, p_actual_start time without time zone, p_actual_end time without time zone, p_setup_min integer)";
const LF_SIG = "finalize_training_session(p_session_id uuid, p_duration_min integer)";
const GRD_SIG = "tg_training_session_lock_guard()";
const COR_SIG = "correct_training_session(p_session_id uuid, p_changes jsonb, p_add uuid[], p_remove uuid[], p_reason text)";
const ATT_SIG = "attested_training(p_dept uuid, p_from timestamp with time zone, p_to timestamp with time zone)";
const ISO_SIG = "dept_iso_hours_for(p_dept uuid, p_from timestamp with time zone, p_to timestamp with time zone)";
const TF = F[TF_SIG];
must(TF && TF.md5 === "b702ad77a183903c06710e3edc33b637", "the times finalize is not Slice T's b702ad77");
must(F[LF_SIG]?.md5 === "3f31142bae70c8fd2001c4fb657f4efa", "the length-only finalize is not 3f31142b");
must(F[GRD_SIG]?.md5 === "c1af95df40d551b75998cde0a8f290f7" && F[COR_SIG]?.md5 === "8c00066509e9dca338dc3662f55e1211", "the guard / correct are not the post-T bodies");
must(F[ATT_SIG]?.md5 === "aff25333771cd38c1f473bcde5e1e96e" && F[ISO_SIG]?.md5 === "705c9a9b5532d28824f5e50e74d6059f", "the ledger functions moved");

// ---------------------------------------------------------------- the ONE change, from the LIVE text
const edit = (src, pairs) => pairs.reduce((s, [a, b]) => { must(s.split(a).length === 2, `anchor not found exactly once: ${a.slice(0, 70)}`); return s.replace(a, b); }, src);
const REMOVED = `      if s.duration_min is not null and s.duration_min <> v_span then
        raise exception 'USE_CORRECT: this drill already has a length — change it with Correct.';
      end if;
`;
// Once anyone is on the roll, the LIVE lock guard (c1af95df, untouched) lets duration_min change only from NULL — replacing the
// estimate is the one change it reserves for the transaction-local correction flag. Lift it for THIS update only, only when the
// length actually changes, and clear it right after — exactly as correct_training_session does around its own update.
const UPD = "      update public.training_sessions set done = true, duration_min = v_dur, actual_start = p_actual_start, actual_end = p_actual_end, setup_min = v_setup where id = s.id;\n";
const LIFT = `      -- T2: replacing a pre-finalize length is the change the lock guard keeps for the correction flag once anyone is on the roll —
      -- lift it for THIS update only, only when the length changes, and clear it right after (as correct_training_session does).
      v_lift := s.duration_min is not null and s.duration_min <> v_dur;
      if v_lift then perform set_config('b4c.session_correction', 'on', true); end if;
${UPD}      if v_lift then perform set_config('b4c.session_correction', '', true); end if;
`;
const TF_NEW = edit(TF.def, [
  ["    -- reopened, the roster change since that Reopen is logged here (D4).\n",
   "    -- reopened, the roster change since that Reopen is logged here (D4).\n    -- B4C:E1E3 T2 — the actual times REPLACE a length set before finalize (an estimate — e.g. pre-filled from a plan when the\n    -- drill was scheduled): no USE_CORRECT for it. The finalize diff logs duration_min old -> new, so nothing is silent.\n    -- Existing actual times / an existing setup time still refuse (deliberate entries — a different one is a Correct).\n"],
  [REMOVED, ""],
  ["      v_add   uuid[] := '{}'; v_rem uuid[] := '{}';\n", "      v_add   uuid[] := '{}'; v_rem uuid[] := '{}';\n      v_lift  boolean;\n"],
  [UPD, LIFT],
]);
const NEW_BODY = body(TF_NEW);
const NEW_MD5 = md5(TF_NEW);
must(!/already has a length/.test(TF_NEW) && /already has actual times/.test(TF_NEW) && /already has a setup time/.test(TF_NEW), "the edit did not do exactly the one thing");

// ---------------------------------------------------------------- shared SQL pieces
const PINS = Object.keys(F).sort();
const regp = (sig) => `'public.${sig.replace(/\(.*$/, "")}(${sig.replace(/^[^(]*\(|\)$/g, "").split(", ").filter(Boolean).map((a) => a.replace(/^\w+ /, "")).join(", ")})'::regprocedure`;
const fmd5 = (sig) => `md5(pg_get_functiondef(${regp(sig)}))`;
const facl = (sig) => `coalesce((SELECT proacl::text FROM pg_proc WHERE oid = ${regp(sig)}), '')`;
const TF_REG = "finalize_training_session(uuid,time without time zone,time without time zone,integer)";
const ALL_FN_MD5 = `(SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.oid::regprocedure::text <> '${TF_REG}')`;
const FN_N = `(SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f')`;
const POL_MD5 = `(SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'public')`;
const TBLS = "('public.training_sessions'::regclass, 'public.session_attendance'::regclass)";
const TRG_MD5 = `(SELECT md5(string_agg(c.relname || '.' || t.tgname || '|' || pg_get_triggerdef(t.oid), ',' ORDER BY (c.relname || '.' || t.tgname) COLLATE "C")) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgrelid IN ${TBLS} AND NOT t.tgisinternal)`;
const CON_MD5 = `(SELECT md5(string_agg(c.relname || '.' || k.conname || '|' || pg_get_constraintdef(k.oid), ',' ORDER BY (c.relname || '.' || k.conname) COLLATE "C")) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE k.conrelid IN ${TBLS} AND k.contype <> 'n')`;
const TRG_PIN = md5(Object.entries(M.triggers).sort(byC).map(([n, d]) => `${n}|${d}`).join(","));
const CON_PIN = md5(Object.entries(M.constraints).sort(byC).map(([n, d]) => `${n}|${d}`).join(","));
const COLS_SQL = (t) => `(SELECT string_agg(column_name || ':' || udt_name || ':' || is_nullable, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t}')`;
const COLS_PIN = (t) => M.columns[t].map((c) => `${c.name}:${c.type}:${c.null ? "YES" : "NO"}`).join(",");
const ROWS_MD5 = (t) => `(SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '')) FROM public.${t} x)`;
const OVERLOADS = `(SELECT string_agg(array_to_string(p.proargnames, ',') || '/' || p.pronargdefaults, ' | ' ORDER BY p.pronargs) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'finalize_training_session')`;
const OVERLOADS_PIN = "p_session_id,p_duration_min/0 | p_session_id,p_actual_start,p_actual_end,p_setup_min/0";
const LEDGER = (into) => `
    ${into} := '{}'::jsonb;
    FOR d IN SELECT id FROM public.departments ORDER BY id LOOP
      ${into} := ${into} || jsonb_build_object(d::text, jsonb_build_object(
        'attested', (SELECT md5(coalesce(string_agg(a.member_id || '|' || a.session_id || '|' || a.start_at || '|' || a.end_at || '|' || a.optional, ',' ORDER BY a.member_id, a.session_id), ''))
                       FROM public.attested_training(d, '1900-01-01'::timestamptz, '2200-01-01'::timestamptz) a),
        'iso', (SELECT md5(coalesce(string_agg(h.member_id || '|' || h.training_hours || '|' || h.standby_hours || '|' || h.iso_total_hours, ',' ORDER BY h.member_id), ''))
                  FROM public.dept_iso_hours_for(d, '1900-01-01'::timestamptz, '2200-01-01'::timestamptz) h)));
    END LOOP;`;
const KEEP = [GRD_SIG, COR_SIG, LF_SIG, ATT_SIG, ISO_SIG];

// ================================================================ DRAFT
out["sql/e1e3_T2_times_replace_estimate_DRAFT.sql"] = `-- =====================================================================
-- E1/E3 T2 — at finalize, the ACTUAL TIMES replace a pre-finalize (estimated) length (DB amendment). DRAFT — NOT APPLIED.
-- GENERATED by docs/review/e1e3_T2_build.mjs from the live captures (${M.read_at.slice(0, 16)} UTC, after Slices T + R):
-- docs/review/e1e3_T2_LIVE_fns.json + docs/review/e1e3_T2_LIVE_meta.json.
-- Ruling (Ashlea, flag 1 of B4C_E1E3_U1_UI_ReviewRecord): "Schedule with this plan" pre-fills a session's duration_min with the
-- plan's ESTIMATE; Slice T's times finalize refused times that disagreed with it (USE_CORRECT). A session that isn't finalized
-- has no recorded length — only an estimate — so the times' span replaces it.
--
-- WHAT IT DOES — ONE function, CREATE OR REPLACE, same signature, ACL kept:
--   finalize_training_session(uuid, time, time, integer) (the times overload, live md5 ${TF.md5}): the refusal
--     "USE_CORRECT: this drill already has a length" is removed (3 lines) and a 3-line comment added. Nothing else in it changes:
--     the finalize diff still logs duration_min old → new (so the replacement is on the session's log); the refusals for
--     EXISTING actual times and an EXISTING setup time stay (a reopen → re-finalize with different times is still a Correct);
--     the CHECK holds (duration_min = the span, set in the same UPDATE). The LIVE lock guard (untouched) lets duration_min change
--     only from NULL once anyone is on the roll, so — only when it is replacing a DIFFERENT existing length — the function lifts
--     the transaction-local correction flag for its own UPDATE and clears it right after, exactly as correct_training_session does.
--   NOT touched: the length-only finalize (${F[LF_SIG].md5}), correct (${F[COR_SIG].md5}), the guard (${F[GRD_SIG].md5}),
--   attested_training (${F[ATT_SIG].md5}), dept_iso_hours_for (${F[ISO_SIG].md5}) — all byte-identical after; no policy,
--   trigger, constraint, column, grant or row.
--
-- PREFLIGHT (refuses, changes nothing): already applied (the times finalize = the T2 body, md5 ${NEW_MD5}); md5 pins on all
-- ${PINS.length} captured functions; training_sessions + session_attendance trigger + constraint definitions and columns; every public
-- policy (md5).
-- IN-TRANSACTION PROOF (any miss → RAISE → rollback): the per-department ledger (attested_training + dept_iso_hours_for, all
-- time) byte-identical; training_sessions + session_attendance rows byte-identical; the times finalize is EXACTLY the generated
-- body (md5 ${NEW_MD5}), SECURITY DEFINER, search_path=public, ACL unchanged; both overloads' named-argument sets still exactly
-- {p_session_id,p_duration_min} / {p_session_id,p_actual_start,p_actual_end,p_setup_min} with 0 defaults; every OTHER public
-- function (definition + ACL) byte-identical and the function count unchanged; policies, triggers, constraints unchanged;
-- verified presence unchanged.
-- Dry run: docs/review/e1e3_T2_DRYRUN.txt. RETEST (separately, after): sql/e1e3_T2_times_replace_estimate_RETEST.sql.
-- =====================================================================
DO $migrate$
DECLARE
  d uuid; r record; v_t text;
  v_led_before jsonb; v_led_after jsonb; v_ts_rows text; v_sa_rows text; v_others text; v_fn_n bigint; v_ver bigint; v_acl text;
BEGIN
  -- ---------------------------------------------------------------- 0. preflight
  IF ${fmd5(TF_SIG)} = '${NEW_MD5}' THEN RAISE EXCEPTION 'PREFLIGHT: the times finalize is already the T2 body — T2 looks applied. Refusing.'; END IF;
  FOR r IN SELECT * FROM (VALUES
${PINS.map((s) => `      ('${q(s)}', '${F[s].md5}')`).join(",\n")}) v(sig, md5) LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_t FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')') = r.sig;
    IF v_t IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'PREFLIGHT: % drifted from the capture (or is gone). Refusing.', r.sig; END IF;
  END LOOP;
  IF ${TRG_MD5} IS DISTINCT FROM '${TRG_PIN}' THEN RAISE EXCEPTION 'PREFLIGHT: a training_sessions / session_attendance trigger changed. Refusing.'; END IF;
  IF ${CON_MD5} IS DISTINCT FROM '${CON_PIN}' THEN RAISE EXCEPTION 'PREFLIGHT: a training_sessions / session_attendance constraint changed. Refusing.'; END IF;
  IF ${POL_MD5} IS DISTINCT FROM '${M.policies_md5}' THEN RAISE EXCEPTION 'PREFLIGHT: a public policy changed since the capture. Refusing.'; END IF;
  IF ${COLS_SQL("training_sessions")} IS DISTINCT FROM '${COLS_PIN("training_sessions")}'
     OR ${COLS_SQL("session_attendance")} IS DISTINCT FROM '${COLS_PIN("session_attendance")}' THEN
    RAISE EXCEPTION 'PREFLIGHT: the training_sessions / session_attendance columns changed since the capture. Refusing.';
  END IF;
  v_fn_n := ${FN_N};
  v_acl := ${facl(TF_SIG)};
  SELECT count(*) INTO v_ver FROM public.station_presence WHERE verified;
  v_ts_rows := ${ROWS_MD5("training_sessions")};
  v_sa_rows := ${ROWS_MD5("session_attendance")};
  v_others := ${ALL_FN_MD5};
${LEDGER("v_led_before")}

  -- ---------------------------------------------------------------- 1. the times finalize: the estimate no longer blocks the times
${TF_NEW};

  -- ---------------------------------------------------------------- 2. post-conditions (in-transaction)
${LEDGER("v_led_after")}
  IF v_led_after IS DISTINCT FROM v_led_before THEN
    SELECT string_agg(k, ', ') INTO v_t FROM jsonb_object_keys(v_led_before) k WHERE (v_led_before->k) IS DISTINCT FROM (v_led_after->k);
    RAISE EXCEPTION 'Post-condition failed: the credited-hours ledger moved for department(s) %. Rolling back.', v_t;
  END IF;
  IF ${ROWS_MD5("training_sessions")} IS DISTINCT FROM v_ts_rows OR ${ROWS_MD5("session_attendance")} IS DISTINCT FROM v_sa_rows THEN
    RAISE EXCEPTION 'Post-condition failed: a training_sessions / session_attendance row changed. Rolling back.';
  END IF;
  IF NOT coalesce((SELECT p.prosrc = '${q(NEW_BODY)}' AND p.prosecdef AND p.proconfig = ARRAY['search_path=public'] AND p.provolatile = 'v'
                     FROM pg_proc p WHERE p.oid = ${regp(TF_SIG)}), false)
     OR ${fmd5(TF_SIG)} IS DISTINCT FROM '${NEW_MD5}' OR ${facl(TF_SIG)} IS DISTINCT FROM v_acl
     OR has_function_privilege('anon', ${regp(TF_SIG)}, 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: the times finalize is not exactly the T2 body (md5 ${NEW_MD5}) / SECURITY DEFINER / its ACL changed. Rolling back.';
  END IF;
  IF ${OVERLOADS} IS DISTINCT FROM '${OVERLOADS_PIN}' THEN
    RAISE EXCEPTION 'Post-condition failed: the finalize overloads are not exactly {p_session_id,p_duration_min} and {p_session_id,p_actual_start,p_actual_end,p_setup_min} with no defaults. Rolling back.';
  END IF;
  IF ${KEEP.map((s) => `${fmd5(s)} IS DISTINCT FROM '${F[s].md5}'`).join("\n     OR ")} THEN
    RAISE EXCEPTION 'Post-condition failed: the guard / correct / the length-only finalize / attested_training / dept_iso_hours_for changed. Rolling back.';
  END IF;
  IF ${ALL_FN_MD5} IS DISTINCT FROM v_others THEN RAISE EXCEPTION 'Post-condition failed: another public function changed. Rolling back.'; END IF;
  IF ${FN_N} <> v_fn_n THEN RAISE EXCEPTION 'Post-condition failed: the function count changed. Rolling back.'; END IF;
  IF ${POL_MD5} IS DISTINCT FROM '${M.policies_md5}' OR ${TRG_MD5} IS DISTINCT FROM '${TRG_PIN}' OR ${CON_MD5} IS DISTINCT FROM '${CON_PIN}' THEN
    RAISE EXCEPTION 'Post-condition failed: a policy, trigger or constraint changed. Rolling back.';
  END IF;
  IF (SELECT count(*) FROM public.station_presence WHERE verified) <> v_ver THEN RAISE EXCEPTION 'Post-condition failed: verified presence changed. Rolling back.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------- state row
SELECT jsonb_build_object(
  'times_finalize_md5', ${fmd5(TF_SIG)},
  'times_finalize_acl', ${facl(TF_SIG)},
  'length_refusal_gone', NOT ((SELECT prosrc FROM pg_proc WHERE oid = ${regp(TF_SIG)}) ~ 'already has a length'),
  'times_and_setup_refusals_kept', (SELECT prosrc ~ 'already has actual times' AND prosrc ~ 'already has a setup time' FROM pg_proc WHERE oid = ${regp(TF_SIG)}),
  'finalize_named_args', (SELECT string_agg(array_to_string(p.proargnames, ',') || ' (defaults ' || p.pronargdefaults || ')', ' | ' ORDER BY p.pronargs) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'finalize_training_session'),
  'length_only_finalize_md5', ${fmd5(LF_SIG)}, 'guard_md5', ${fmd5(GRD_SIG)}, 'correct_md5', ${fmd5(COR_SIG)},
  'attested_md5', ${fmd5(ATT_SIG)}, 'iso_md5', ${fmd5(ISO_SIG)},
  'fn_count', ${FN_N},
  'total_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
`;

// ================================================================ RETEST
const AS = `PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true); EXECUTE 'SET LOCAL ROLE authenticated';`;
const BACK = `EXECUTE 'RESET ROLE';`;
const OK = (id, msg) => `v_pass := v_pass + 1; rpt := rpt || 'PASS  ${id} ${q(msg)}' || chr(10);`;
const NO = (id, fmt, ...args) => `v_fail := v_fail + 1; rpt := rpt || format('FAIL  ${id} ${q(fmt)}%s'${args.map((a) => ", " + a).join("")}, chr(10));`;
const TRY = (call) => `v_t := NULL; BEGIN ${AS} PERFORM ${call}; ${BACK} EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;`;
const NEWS = (title, extra = "") => `INSERT INTO public.training_sessions (department_id, title, "date", start_time${extra ? ", duration_min" : ""}) VALUES (v_dept, '${title}', v_today, '19:00'${extra ? `, ${extra}` : ""})`;
const ROLL = (sid) => `INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (v_dept, ${sid}, v_me, now());`;
out["sql/e1e3_T2_times_replace_estimate_RETEST.sql"] = `-- =====================================================================
-- RETEST for e1e3_T2_times_replace_estimate. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Everything runs inside ONE sub-block ending in RAISE 'SENTINEL' (rolled back): synthetic sessions + a synthetic roll (as the
-- owner), Finalize / Reopen as a REAL Department Admin (JWT email claim, role authenticated) — NOTHING STAYS. The final RAISE is
-- the report — the "ERROR" IS the report.
--   S0 T2 is in place: the times finalize is the T2 body (no "already has a length", the times / setup refusals kept), both
--      overloads exactly as before (0 defaults), the length-only finalize / guard / correct / ledger pair on their pins
--   U1 THE RULING: a plan-scheduled session (estimate 120) finalized 19:00–22:26 → duration_min 206 replaces 120; actual times
--      stored; the finalize audit row logs duration_min 120 → 206
--   U2 the ledger reads the replaced length: attested_training credits that session min(90, 206) = 90 min from date + start_time
--   U3 existing actual times still refuse: reopen it, re-finalize with 19:00–23:00 → USE_CORRECT (actual times); re-finalize with
--      the SAME times goes through
--   U4 an existing setup time still refuses: reopen a session finalized with setup 20, re-finalize with setup 30 → USE_CORRECT
--   U5 the length-only finalize behaves exactly as today: estimate 120 + {p_duration_min: 90} → USE_CORRECT (unchanged);
--      {p_duration_min: NULL} keeps 120; no length + 45 → 45
--   U6 the times finalize's other refusals are unchanged: end = start · a time missing · setup 700 → BAD_VALUE
--   U7 the correction flag the times finalize lifts (only to replace a different length) is CLEARED after its UPDATE: in the same
--      transaction, a raw change to that session → LOCKED_SESSION
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_email text; v_me uuid; v_dept uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid; s5 uuid; s6 uuid; v_t text; v_n bigint; v_row record; v_ch jsonb;
BEGIN
  BEGIN
    SELECT lower(m.email), m.id, m.department_id INTO v_email, v_me, v_dept FROM public.members m
     WHERE m.status = 'Active' AND m.access && array['Department Admin']::text[] AND m.email IS NOT NULL
       AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1
       AND public.membership_window_allows(m.id, v_today)
     ORDER BY m.department_id, m.id LIMIT 1;
    IF v_email IS NULL THEN RAISE EXCEPTION 'SKIPALL: no real Department Admin to act as'; END IF;

    -- S0
    IF ${fmd5(TF_SIG)} = '${NEW_MD5}' AND ${OVERLOADS} = '${OVERLOADS_PIN}'
       AND ${KEEP.map((s) => `${fmd5(s)} = '${F[s].md5}'`).join("\n       AND ")} THEN
      ${OK("S0", "the times finalize is the T2 body (md5 " + NEW_MD5.slice(0, 8) + "): no length refusal, the times + setup refusals kept; both overloads unchanged; the length-only finalize / guard / correct / ledger on their pins")}
    ELSE ${NO("S0", "T2 is not in place as intended")} END IF;

    -- synthetic sessions (owner) + the DA on each roll; the membership-window trigger still runs (eligible DA only)
    ${NEWS("T2 RETEST plan-scheduled", "120")} RETURNING id INTO s1;
    ${NEWS("T2 RETEST setup")} RETURNING id INTO s2;
    ${NEWS("T2 RETEST length-only est", "120")} RETURNING id INTO s3;
    ${NEWS("T2 RETEST length-only est null", "120")} RETURNING id INTO s4;
    ${NEWS("T2 RETEST no length")} RETURNING id INTO s5;
    ${NEWS("T2 RETEST refusals")} RETURNING id INTO s6;
    BEGIN
      ${ROLL("s1")} ${ROLL("s2")} ${ROLL("s3")} ${ROLL("s4")} ${ROLL("s5")} ${ROLL("s6")}
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SKIPALL: the synthetic roll was refused (%)', SQLERRM;
    END;

    -- U1 the ruling
    ${TRY("public.finalize_training_session(p_session_id => s1, p_actual_start => '19:00', p_actual_end => '22:26', p_setup_min => NULL)")}
    SELECT * INTO v_row FROM public.training_sessions WHERE id = s1;
    SELECT changes INTO v_ch FROM public.training_session_audit WHERE session_id = s1 AND action = 'finalize' ORDER BY seq DESC LIMIT 1;
    IF v_row.done AND v_row.duration_min = 206 AND v_row.actual_start = '19:00' AND v_row.actual_end = '22:26'
       AND (v_ch->'duration_min'->>'old')::int = 120 AND (v_ch->'duration_min'->>'new')::int = 206 THEN
      ${OK("U1", "plan-scheduled session (estimate 120) finalized 19:00–22:26 → duration_min 206 replaces 120; the finalize audit logs duration_min 120 → 206")}
    ELSE ${NO("U1", "%s — done %s, duration %s, audit %s", "coalesce(v_t, 'no refusal')", "v_row.done", "v_row.duration_min", "coalesce(v_ch::text, '(none)')")} END IF;

    -- U2 the ledger reads the replaced length
    SELECT count(*) INTO v_n FROM public.attested_training(v_dept, now() - interval '2 days', now() + interval '2 days') a
     WHERE a.session_id = s1 AND a.member_id = v_me AND a.end_at - a.start_at = interval '90 minutes'
       AND a.start_at = (v_today + time '19:00') AT TIME ZONE 'America/Chicago';
    IF v_n = 1 THEN ${OK("U2", "the ledger credits that session min(90, 206) = 90 min from date + start_time (the replaced length; the ledger itself unchanged)")}
    ELSE ${NO("U2", "%s ledger rows as expected", "v_n")} END IF;

    -- U7 the correction flag U1 lifted is CLEARED: in the same transaction, a raw change to that (finalized) session → LOCKED_SESSION
    v_t := NULL;
    BEGIN UPDATE public.training_sessions SET title = title || ' x' WHERE id = s1; EXCEPTION WHEN insufficient_privilege THEN v_t := SQLERRM; END;
    IF v_t LIKE 'LOCKED_SESSION%' AND coalesce(current_setting('b4c.session_correction', true), '') = '' THEN
      ${OK("U7", "the correction flag U1 lifted is cleared — in the same transaction a raw change to that session → LOCKED_SESSION (owner too)")}
    ELSE ${NO("U7", "the flag leaked: %s, flag = %s", "coalesce(v_t, 'raw update accepted')", "coalesce(current_setting('b4c.session_correction', true), '(unset)')")} END IF;

    -- U3 existing actual times still refuse (reopen → re-finalize with different times); the same times go through
    ${AS} PERFORM public.reopen_training_session(s1, 'RETEST: reopen to re-finalize'); ${BACK}
    ${TRY("public.finalize_training_session(p_session_id => s1, p_actual_start => '19:00', p_actual_end => '23:00', p_setup_min => NULL)")}
    IF v_t LIKE 'USE_CORRECT: this drill already has actual times%' THEN
      ${AS} PERFORM public.finalize_training_session(p_session_id => s1, p_actual_start => '19:00', p_actual_end => '22:26', p_setup_min => NULL); ${BACK}
      IF (SELECT done AND duration_min = 206 FROM public.training_sessions WHERE id = s1) THEN
        ${OK("U3", "reopened: re-finalize with different times → USE_CORRECT (existing actual times — still a Correct); the same times re-finalize")}
      ELSE ${NO("U3", "the same-times re-finalize did not land")} END IF;
    ELSE ${NO("U3", "different times after a reopen: %s", "coalesce(v_t, 'accepted')")} END IF;

    -- U4 an existing setup time still refuses
    ${AS} PERFORM public.finalize_training_session(p_session_id => s2, p_actual_start => '19:00', p_actual_end => '20:00', p_setup_min => 20); ${BACK}
    ${AS} PERFORM public.reopen_training_session(s2, 'RETEST: reopen to re-finalize'); ${BACK}
    ${TRY("public.finalize_training_session(p_session_id => s2, p_actual_start => '19:00', p_actual_end => '20:00', p_setup_min => 30)")}
    IF v_t LIKE 'USE_CORRECT: this drill already has a setup time%' THEN ${OK("U4", "reopened: re-finalize with setup 30 over 20 → USE_CORRECT (existing setup — still a Correct)")}
    ELSE ${NO("U4", "%s", "coalesce(v_t, 'accepted')")} END IF;

    -- U5 the length-only finalize, exactly as today
    ${TRY("public.finalize_training_session(p_session_id => s3, p_duration_min => 90)")}
    IF v_t LIKE 'USE_CORRECT: this drill already has a length%' THEN
      ${AS}
      PERFORM public.finalize_training_session(p_session_id => s4, p_duration_min => NULL);
      PERFORM public.finalize_training_session(p_session_id => s5, p_duration_min => 45);
      ${BACK}
      IF (SELECT done AND duration_min = 120 AND actual_start IS NULL FROM public.training_sessions WHERE id = s4)
         AND (SELECT done AND duration_min = 45 AND actual_start IS NULL FROM public.training_sessions WHERE id = s5) THEN
        ${OK("U5", "length-only finalize unchanged: estimate 120 + 90 → USE_CORRECT; NULL keeps 120; no length + 45 → 45 (no times)")}
      ELSE ${NO("U5", "the length-only finalize did not behave as today")} END IF;
    ELSE ${NO("U5", "estimate 120 + 90 via the length-only finalize: %s", "coalesce(v_t, 'accepted')")} END IF;

    -- U6 the times finalize's other refusals
    v_n := 0;
    ${TRY("public.finalize_training_session(p_session_id => s6, p_actual_start => '19:00', p_actual_end => '19:00', p_setup_min => NULL)")} IF v_t LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF;
    ${TRY("public.finalize_training_session(p_session_id => s6, p_actual_start => '19:00', p_actual_end => NULL, p_setup_min => NULL)")} IF v_t LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF;
    ${TRY("public.finalize_training_session(p_session_id => s6, p_actual_start => '19:00', p_actual_end => '20:00', p_setup_min => 700)")} IF v_t LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF;
    IF v_n = 3 AND NOT (SELECT done FROM public.training_sessions WHERE id = s6) THEN ${OK("U6", "the times finalize still refuses end = start · a time missing · setup 700 (BAD_VALUE)")}
    ELSE ${NO("U6", "%s of 3 refused", "v_n")} END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SKIPALL:%' THEN v_skip := v_skip + 1; rpt := rpt || 'SKIP  ' || SQLERRM || chr(10);
    ELSIF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('FAIL  the RETEST block aborted: %s%s', SQLERRM, chr(10)); END IF;
  END;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
`;

// ================================================================ ROLLBACK
out["sql/e1e3_T2_times_replace_estimate_ROLLBACK.sql"] = `-- =====================================================================
-- ROLLBACK for e1e3_T2_times_replace_estimate — insurance, GENERATED from the same capture.
-- Refuses unless T2 is applied (the times finalize = the T2 body). Restores the times finalize from its exact CAPTURED pre-T2
-- definition (CREATE OR REPLACE — ACL kept) and proves it is back on ${TF.md5} with everything else untouched. No data
-- consequence: sessions finalized under T2 have duration_min = their span, which Slice T's CHECK + body accept as they are.
-- =====================================================================
DO $rollback$
DECLARE v_others text; v_acl text; v_n bigint;
BEGIN
  IF ${fmd5(TF_SIG)} IS DISTINCT FROM '${NEW_MD5}' THEN RAISE EXCEPTION 'ROLLBACK: T2 is not applied (the times finalize is not the T2 body). Refusing.'; END IF;
  v_others := ${ALL_FN_MD5}; v_acl := ${facl(TF_SIG)}; v_n := ${FN_N};
${TF.def};
  IF ${fmd5(TF_SIG)} IS DISTINCT FROM '${TF.md5}' OR ${facl(TF_SIG)} IS DISTINCT FROM v_acl OR ${ALL_FN_MD5} IS DISTINCT FROM v_others OR ${FN_N} <> v_n
     OR ${OVERLOADS} IS DISTINCT FROM '${OVERLOADS_PIN}' THEN
    RAISE EXCEPTION 'ROLLBACK post-condition: not back to the captured pre-T2 state. Rolling back.';
  END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
`;

// ================================================================ change list
out["docs/review/e1e3_T2_CHANGE_LIST.md"] = `# E1/E3 T2 — change list (GENERATED by docs/review/e1e3_T2_build.mjs from the ${M.read_at.slice(0, 10)} live captures)

| object | before (live) | after |
|---|---|---|
| \`finalize_training_session(uuid, time, time, integer)\` | md5 \`${TF.md5}\` — refuses times whose span ≠ an existing \`duration_min\` (USE_CORRECT) | md5 \`${NEW_MD5}\` — the span **replaces** a pre-finalize length (logged old → new in the finalize diff), lifting the correction flag for its own UPDATE only when the length changes (the guard reserves that change for it); the existing-times / existing-setup USE_CORRECT refusals **kept**; ACL kept |
| \`finalize_training_session(uuid, integer)\` (length-only) | \`${F[LF_SIG].md5}\` | **unchanged** |
| \`correct_training_session\` / \`tg_training_session_lock_guard\` | \`${F[COR_SIG].md5}\` / \`${F[GRD_SIG].md5}\` | **unchanged** |
| \`attested_training\` / \`dept_iso_hours_for\` | \`${F[ATT_SIG].md5}\` / \`${F[ISO_SIG].md5}\` | **unchanged**; per-department output proven byte-identical |
| everything else | ${M.counts.fns} functions · ${M.counts.policies} policies | unchanged (function count unchanged) |

The removed lines (exactly) — plus \`v_lift\` and the flag lift around the one UPDATE (see the DRAFT):
\`\`\`sql
${REMOVED.trimEnd()}
\`\`\`
`;

// ---------------------------------------------------------------- write or check
const check = process.argv.includes("--check");
let bad = 0;
for (const [p, s] of Object.entries(out)) {
  if (check) { let cur = null; try { cur = readFileSync(join(root, p), "utf8"); } catch { /* missing */ } if (cur !== s) { console.log(`DIFFERS ${p}`); bad++; } else console.log(`same    ${p}`); }
  else { writeFileSync(join(root, p), s); console.log(`wrote   ${p} (${s.length} bytes)`); }
}
if (check && bad) process.exit(1);
