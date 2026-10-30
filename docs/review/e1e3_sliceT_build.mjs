// node docs/review/e1e3_sliceT_build.mjs           — write the files
// node docs/review/e1e3_sliceT_build.mjs --check   — regenerate in memory; exit 1 unless every file on disk is byte-identical
// E1/E3 SLICE T (training time, DB). GENERATED from the live captures (2026-10-29, read-only):
//   docs/review/e1e3_sliceT_LIVE_fns.json   (sql/e1e3_sliceT_CAPTURE_A_fns.sql)  — the function definitions + md5 + ACL
//   docs/review/e1e3_sliceT_LIVE_meta.json  (sql/e1e3_sliceT_CAPTURE_B_meta.sql) — triggers, constraints, columns, policy md5, counts
// Writes:
//   sql/e1e3_sliceT_session_times_DRAFT.sql · _RETEST.sql · _ROLLBACK.sql · docs/review/e1e3_sliceT_CHANGE_LIST.md
// Rulings (Step 0 design/e1e3-step0 @ 813ed0e + review record; Ashlea): Option A — the actual times DERIVE duration_min (the
// one length the hours ledger reads), start/end OPTIONAL with the length-only fallback, setup_min record-only, never credited.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
const root = fileURLToPath(new URL("../../", import.meta.url));
const F = JSON.parse(readFileSync(join(root, "docs/review/e1e3_sliceT_LIVE_fns.json"), "utf8"));
const M = JSON.parse(readFileSync(join(root, "docs/review/e1e3_sliceT_LIVE_meta.json"), "utf8"));
const out = {};
const q = (s) => s.replace(/'/g, "''");
const must = (c, why) => { if (!c) throw new Error(`capture drifted from the Step 0: ${why}`); };
const fn = (name) => { const e = Object.entries(F).find(([k]) => k.startsWith(name + "(")); must(e, `${name} missing`); return { sig: e[0], ...e[1] }; };
const edit = (src, pairs, label) => pairs.reduce((s, [a, b]) => { must(s.split(a).length === 2, `${label}: anchor not found exactly once: ${a.slice(0, 70)}`); return s.replace(a, b); }, src);
const body = (def) => { const m = /AS \$function\$([\s\S]*)\$function\$\s*$/.exec(def); must(m, "no $function$ body"); return m[1]; };

// ---------------------------------------------------------------- the capture must still say what the Step 0 said
const FIN = fn("finalize_training_session"), COR = fn("correct_training_session"), GRD = fn("tg_training_session_lock_guard");
const ATT = fn("attested_training"), ISO = fn("dept_iso_hours_for");
must(FIN.sig === "finalize_training_session(p_session_id uuid, p_duration_min integer)", "finalize signature");
must(Object.keys(F).filter((k) => k.startsWith("finalize_training_session(")).length === 1, "finalize already has an overload");
const tsCols = M.columns.training_sessions.map((c) => c.name);
must(!["actual_start", "actual_end", "setup_min"].some((c) => tsCols.includes(c)), "a new column already exists");
must(tsCols.includes("duration_min") && tsCols.includes("start_time"), "duration_min / start_time missing");
must(M.constraints.training_sessions_duration_range === "CHECK (((duration_min IS NULL) OR ((duration_min >= 1) AND (duration_min <= 1440))))", "duration_range CHECK changed");
must(/least\(interval '90 minutes', make_interval\(mins => ts\.duration_min\)\)/.test(ATT.def) && !/setup_min|actual_start|actual_end/.test(ATT.def + ISO.def), "the ledger no longer reads exactly duration_min");
must(M.triggers.training_session_lock_guard === "CREATE TRIGGER training_session_lock_guard BEFORE INSERT OR UPDATE ON public.training_sessions FOR EACH ROW EXECUTE FUNCTION tg_training_session_lock_guard()", "lock guard trigger definition");

// the span, minutes: an end at or before the start ran past midnight (+24 h). Used by the CHECK and both RPCs — one formula.
const SPAN = (a, b) => `((extract(epoch from (${b} - ${a})) / 60)::integer + case when ${b} <= ${a} then 1440 else 0 end)`;
const NEW_CONSTRAINTS = {
  training_sessions_actual_pair: "CHECK (((actual_start IS NULL) = (actual_end IS NULL)))",
  training_sessions_actual_whole_minutes: "CHECK (((actual_start IS NULL) OR ((EXTRACT(second FROM actual_start) = (0)::numeric) AND (EXTRACT(second FROM actual_end) = (0)::numeric) AND (actual_end <> actual_start))))",
  training_sessions_actual_length: null,   // filled from the live deparse in the dry run; the migration checks the expression's behaviour, not its text
  training_sessions_setup_range: "CHECK (((setup_min IS NULL) OR ((setup_min >= 0) AND (setup_min <= 600))))",
};
const CHECK_SQL = {
  training_sessions_actual_pair: "(actual_start IS NULL) = (actual_end IS NULL)",
  training_sessions_actual_whole_minutes: "actual_start IS NULL OR (extract(second from actual_start) = 0 AND extract(second from actual_end) = 0 AND actual_end <> actual_start)",
  training_sessions_actual_length: `actual_start IS NULL OR duration_min IS NOT DISTINCT FROM ${SPAN("actual_start", "actual_end")}`,
  training_sessions_setup_range: "setup_min IS NULL OR setup_min BETWEEN 0 AND 600",
};

// ---------------------------------------------------------------- the three new bodies, from the LIVE text
const GRD_NEW = edit(GRD.def, [
  ["    -- Applies to EVERY writer, the table owner included — a hand fix in the SQL editor must set the flag on purpose.\n",
   "    -- Applies to EVERY writer, the table owner included — a hand fix in the SQL editor must set the flag on purpose.\n    -- B4C:E1E3 slice T — actual_start / actual_end / setup_min follow duration_min's rule: set once on a not-yet-finalized row\n    -- (Finalize), Correct-only after.\n"],
  [`         or (NEW.duration_min is distinct from OLD.duration_min
             and not (OLD.duration_min is null and OLD.done is not true)) then`,
   `         or (NEW.duration_min is distinct from OLD.duration_min
             and not (OLD.duration_min is null and OLD.done is not true))
         or (NEW.actual_start is distinct from OLD.actual_start
             and not (OLD.actual_start is null and OLD.done is not true))
         or (NEW.actual_end is distinct from OLD.actual_end
             and not (OLD.actual_end is null and OLD.done is not true))
         or (NEW.setup_min is distinct from OLD.setup_min
             and not (OLD.setup_min is null and OLD.done is not true)) then`],
], "lock guard");
const COR_NEW = edit(COR.def, [
  ["    -- transaction; the membership-window triggers still run, and a refusal there aborts the whole call (nothing written).\n",
   "    -- transaction; the membership-window triggers still run, and a refusal there aborts the whole call (nothing written).\n    -- B4C:E1E3 slice T — actual_start / actual_end / setup_min are correctable. With times present the length is DERIVED from\n    -- them (the CHECK enforces it); a duration_min that disagrees is refused. Clearing both times leaves a length-only session.\n"],
  ["                                        'counts_toward_attendance', 'is_meeting', 'is_offsite', 'location_label'];",
   "                                        'counts_toward_attendance', 'is_meeting', 'is_offsite', 'location_label',\n                                        'actual_start', 'actual_end', 'setup_min'];"],
  ["      n_counts boolean; n_meet boolean; n_off boolean; n_label text;\n",
   "      n_counts boolean; n_meet boolean; n_off boolean; n_label text;\n      n_astart time; n_aend time; n_setup integer; v_span integer;\n"],
  ["      n_label  := case when v_chg ? 'location_label' then nullif(btrim(v_chg->>'location_label'), '') else s.location_label end;\n",
   "      n_label  := case when v_chg ? 'location_label' then nullif(btrim(v_chg->>'location_label'), '') else s.location_label end;\n      n_astart := case when v_chg ? 'actual_start' then nullif(v_chg->>'actual_start', '')::time else s.actual_start end;\n      n_aend   := case when v_chg ? 'actual_end'   then nullif(v_chg->>'actual_end', '')::time else s.actual_end end;\n      n_setup  := case when v_chg ? 'setup_min'    then nullif(v_chg->>'setup_min', '')::integer else s.setup_min end;\n"],
  ["      if n_dur is not null and (n_dur < 1 or n_dur > 1440) then raise exception 'BAD_VALUE: a length is 1–1440 minutes.'; end if;\n",
   `      if n_dur is not null and (n_dur < 1 or n_dur > 1440) then raise exception 'BAD_VALUE: a length is 1–1440 minutes.'; end if;
      if (n_astart is null) <> (n_aend is null) then raise exception 'BAD_VALUE: the actual start and end go together — give both or clear both.'; end if;
      if n_astart is not null then
        if n_aend = n_astart then raise exception 'BAD_VALUE: the actual end must differ from the start.'; end if;
        if extract(second from n_astart) <> 0 or extract(second from n_aend) <> 0 then raise exception 'BAD_VALUE: actual times are whole minutes.'; end if;
        v_span := ${SPAN("n_astart", "n_aend")};   -- an end at or before the start ran past midnight
        if v_chg ? 'duration_min' and n_dur is distinct from v_span then
          raise exception 'BAD_VALUE: the length comes from the actual start and end (% minutes) — change the times instead.', v_span;
        end if;
        n_dur := v_span;
      end if;
      if n_setup is not null and (n_setup < 0 or n_setup > 600) then raise exception 'BAD_VALUE: setup is 0–600 minutes.'; end if;
`],
  ["      if n_dur    is distinct from s.duration_min then v_diff := v_diff || jsonb_build_object('duration_min', jsonb_build_object('old', s.duration_min, 'new', n_dur)); end if;\n",
   "      if n_dur    is distinct from s.duration_min then v_diff := v_diff || jsonb_build_object('duration_min', jsonb_build_object('old', s.duration_min, 'new', n_dur)); end if;\n      if n_astart is distinct from s.actual_start then v_diff := v_diff || jsonb_build_object('actual_start', jsonb_build_object('old', s.actual_start, 'new', n_astart)); end if;\n      if n_aend   is distinct from s.actual_end   then v_diff := v_diff || jsonb_build_object('actual_end',   jsonb_build_object('old', s.actual_end, 'new', n_aend)); end if;\n      if n_setup  is distinct from s.setup_min    then v_diff := v_diff || jsonb_build_object('setup_min',    jsonb_build_object('old', s.setup_min, 'new', n_setup)); end if;\n"],
  ["           set title = n_title, \"date\" = n_date, start_time = n_start, duration_min = n_dur, audience = n_aud, plan_id = n_plan,\n",
   "           set title = n_title, \"date\" = n_date, start_time = n_start, duration_min = n_dur, audience = n_aud, plan_id = n_plan,\n               actual_start = n_astart, actual_end = n_aend, setup_min = n_setup,\n"],
], "correct_training_session");
const FIN_SIG_NEW = "finalize_training_session(p_session_id uuid, p_actual_start time without time zone, p_actual_end time without time zone, p_setup_min integer)";
const FIN_NEW = edit(FIN.def, [
  ["CREATE OR REPLACE FUNCTION public.finalize_training_session(p_session_id uuid, p_duration_min integer)",
   "CREATE FUNCTION public.finalize_training_session(p_session_id uuid, p_actual_start time without time zone, p_actual_end time without time zone, p_setup_min integer)"],
  ["    -- B4C:slice6 C4 — what the client's finalize does today (done, plus a FIRST length), logged.",
   "    -- B4C:E1E3 slice T — FINALIZE WITH THE ACTUAL TIMES (the length-only finalize_training_session(uuid, integer) stays as the\n    -- fallback). The length is DERIVED from the actual start/end (an end at or before the start ran past midnight); setup_min\n    -- is recorded only, never credited. NO DEFAULTS, on purpose: PostgREST picks an overload by its set of argument names, so\n    -- this one answers ONLY {p_session_id, p_actual_start, p_actual_end, p_setup_min} and the length-only one ONLY\n    -- {p_session_id, p_duration_min} — no call shape can match both (the clients that send p_duration_min keep the old\n    -- function until they're updated). Otherwise exactly slice 6 C4: done, plus a FIRST length, logged."],
  ["      v_dur   integer;\n", "      v_dur   integer;\n      v_span  integer; v_setup integer;\n"],
  [`      if p_duration_min is not null then
        if p_duration_min < 1 or p_duration_min > 1440 then raise exception 'BAD_VALUE: a length is 1–1440 minutes.'; end if;
        if s.duration_min is not null and s.duration_min <> p_duration_min then
          raise exception 'USE_CORRECT: this drill already has a length — change it with Correct.';
        end if;
      end if;
      v_dur := coalesce(s.duration_min, p_duration_min);
      if v_dur is distinct from s.duration_min then
        v_diff := v_diff || jsonb_build_object('duration_min', jsonb_build_object('old', s.duration_min, 'new', v_dur));
      end if;
`,
   `      if p_actual_start is null or p_actual_end is null then
        raise exception 'BAD_VALUE: give both the actual start and end — or finalize with just a length.';
      end if;
      if p_actual_end = p_actual_start then raise exception 'BAD_VALUE: the actual end must differ from the start.'; end if;
      if extract(second from p_actual_start) <> 0 or extract(second from p_actual_end) <> 0 then raise exception 'BAD_VALUE: actual times are whole minutes.'; end if;
      if p_setup_min is not null and (p_setup_min < 0 or p_setup_min > 600) then raise exception 'BAD_VALUE: setup is 0–600 minutes.'; end if;
      v_span := ${SPAN("p_actual_start", "p_actual_end")};   -- an end at or before the start ran past midnight
      if s.duration_min is not null and s.duration_min <> v_span then
        raise exception 'USE_CORRECT: this drill already has a length — change it with Correct.';
      end if;
      if s.actual_start is not null and (s.actual_start, s.actual_end) is distinct from (p_actual_start, p_actual_end) then
        raise exception 'USE_CORRECT: this drill already has actual times — change them with Correct.';
      end if;
      if s.setup_min is not null and p_setup_min is not null and s.setup_min <> p_setup_min then
        raise exception 'USE_CORRECT: this drill already has a setup time — change it with Correct.';
      end if;
      v_dur := v_span;
      v_setup := coalesce(s.setup_min, p_setup_min);
      if v_dur is distinct from s.duration_min then
        v_diff := v_diff || jsonb_build_object('duration_min', jsonb_build_object('old', s.duration_min, 'new', v_dur));
      end if;
      if p_actual_start is distinct from s.actual_start then v_diff := v_diff || jsonb_build_object('actual_start', jsonb_build_object('old', s.actual_start, 'new', p_actual_start)); end if;
      if p_actual_end is distinct from s.actual_end then v_diff := v_diff || jsonb_build_object('actual_end', jsonb_build_object('old', s.actual_end, 'new', p_actual_end)); end if;
      if v_setup is distinct from s.setup_min then v_diff := v_diff || jsonb_build_object('setup_min', jsonb_build_object('old', s.setup_min, 'new', v_setup)); end if;
`],
  ["      update public.training_sessions set done = true, duration_min = v_dur where id = s.id;",
   "      update public.training_sessions set done = true, duration_min = v_dur, actual_start = p_actual_start, actual_end = p_actual_end, setup_min = v_setup where id = s.id;"],
  ["'duration_min', v_dur,", "'duration_min', v_dur, 'actual_start', p_actual_start, 'actual_end', p_actual_end, 'setup_min', v_setup,"],
], "finalize overload");
const NEWBODY = { cor: body(COR_NEW), grd: body(GRD_NEW), fin: body(FIN_NEW) };

// ---------------------------------------------------------------- shared SQL pieces
const PINS = ["finalize_training_session(p_session_id uuid, p_duration_min integer)", COR.sig, GRD.sig, ATT.sig, ISO.sig,
  fn("open_signin").sig, fn("drill_window_presence").sig, fn("reopen_training_session").sig, fn("my_department_id").sig, fn("my_member_id").sig,
  fn("is_training_manager").sig, fn("recompute_training_plan_last_iso").sig];
const regp = (sig) => `'public.${sig.replace(/\(.*$/, "")}(${sig.replace(/^[^(]*\(|\)$/g, "").split(", ").filter(Boolean).map((a) => a.replace(/^\w+ /, "")).join(", ")})'::regprocedure`;
const fmd5 = (sig) => `md5(pg_get_functiondef(${regp(sig)}))`;
const facl = (sig) => `coalesce((SELECT proacl::text FROM pg_proc WHERE oid = ${regp(sig)}), '')`;
const fsrc = (sig) => `(SELECT prosrc FROM pg_proc WHERE oid = ${regp(sig)})`;
const PRO_IN = (cond) => `(SELECT p.oid FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' ${cond})`;
const ALL_FN_MD5 = (exclude) => `(SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.oid::regprocedure::text NOT IN (${exclude.map((s) => `'${q(s)}'`).join(", ")}))`;
const EXCL = ["correct_training_session(uuid,jsonb,uuid[],uuid[],text)", "tg_training_session_lock_guard()", "finalize_training_session(uuid,time without time zone,time without time zone,integer)"];
const POL_MD5 = `(SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'public')`;
// ORDER BY … COLLATE "C" (code-point order) so the SQL md5s match the generator's JS sort of the captured names exactly.
// contype 'n' (NOT NULL recorded as a constraint — newer Postgres) is excluded: NOT NULL is pinned by the column list (is_nullable).
const TRG_MD5 = `(SELECT md5(string_agg(t.tgname || '|' || pg_get_triggerdef(t.oid), ',' ORDER BY t.tgname COLLATE "C")) FROM pg_trigger t WHERE t.tgrelid = 'public.training_sessions'::regclass AND NOT t.tgisinternal)`;
const OLD_CON_MD5 = `(SELECT md5(string_agg(conname || '|' || pg_get_constraintdef(oid), ',' ORDER BY conname COLLATE "C")) FROM pg_constraint WHERE conrelid = 'public.training_sessions'::regclass AND contype <> 'n' AND conname NOT LIKE 'training_sessions\\_actual\\_%' AND conname <> 'training_sessions_setup_range')`;
const ROWS_MD5 = `(SELECT md5(coalesce(string_agg((to_jsonb(ts) - 'actual_start' - 'actual_end' - 'setup_min')::text, ',' ORDER BY ts.id), '')) FROM public.training_sessions ts)`;
const LEDGER = (into) => `
    ${into} := '{}'::jsonb;
    FOR d IN SELECT id FROM public.departments ORDER BY id LOOP
      ${into} := ${into} || jsonb_build_object(d::text, jsonb_build_object(
        'attested', (SELECT md5(coalesce(string_agg(a.member_id || '|' || a.session_id || '|' || a.start_at || '|' || a.end_at || '|' || a.optional, ',' ORDER BY a.member_id, a.session_id), ''))
                       FROM public.attested_training(d, '1900-01-01'::timestamptz, '2200-01-01'::timestamptz) a),
        'iso', (SELECT md5(coalesce(string_agg(h.member_id || '|' || h.training_hours || '|' || h.standby_hours || '|' || h.iso_total_hours, ',' ORDER BY h.member_id), ''))
                  FROM public.dept_iso_hours_for(d, '1900-01-01'::timestamptz, '2200-01-01'::timestamptz) h)));
    END LOOP;`;
// Every public function whose source mentions a new column name. BEFORE the migration that set can only be text that happens to
// match (the columns don't exist yet); the proof is AFTER = BEFORE ∪ exactly the three — and the ledger functions are md5-pinned.
const NEW_REF = `(SELECT coalesce(array_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text), '{}') FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosrc ~ '(actual_start|actual_end|setup_min)')`;
const THREE = ["correct_training_session(uuid,jsonb,uuid[],uuid[],text)", "finalize_training_session(uuid,time without time zone,time without time zone,integer)", "tg_training_session_lock_guard()"];
const THREE_ARR = `ARRAY[${THREE.map((x) => `'${x}'`).join(", ")}]::text[]`;
const COLS_SQL = `(SELECT string_agg(column_name || ':' || udt_name || ':' || is_nullable, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions')`;
const COLS_BEFORE = M.columns.training_sessions.map((c) => `${c.name}:${c.type}:${c.null ? "YES" : "NO"}`).join(",");
const COLS_AFTER = COLS_BEFORE + ",actual_start:time:YES,actual_end:time:YES,setup_min:int2:YES";
const FN_ACL = "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}";
const NEW_FIN = "public.finalize_training_session(uuid, time without time zone, time without time zone, integer)";

// ================================================================ DRAFT
out["sql/e1e3_sliceT_session_times_DRAFT.sql"] = `-- =====================================================================
-- E1/E3 SLICE T — training session ACTUAL TIMES + setup time (DB). DRAFT for gate review — NOT APPLIED.
-- GENERATED by docs/review/e1e3_sliceT_build.mjs from the live captures (2026-10-29): docs/review/e1e3_sliceT_LIVE_fns.json +
-- docs/review/e1e3_sliceT_LIVE_meta.json. Step 0: claude/B4C_E1E3_TrainingTime_Reactions_Step0.md (design/e1e3-step0 @ 813ed0e).
-- Rulings (Ashlea): Option A — the actual times DERIVE duration_min, the one length the hours ledger reads; start/end OPTIONAL
-- (the length-only finalize stays); setup_min recorded only, never credited.
--
-- WHAT IT DOES:
--   1. training_sessions + actual_start time, actual_end time, setup_min smallint (nullable; existing rows untouched).
--   2. CHECKs: start/end together · whole minutes, end ≠ start · duration_min IS NOT DISTINCT FROM the span when times are
--      present (an end at or before the start ran past midnight: +24 h) · setup_min 0–600. Length-only rows (the 31 finalized
--      today, and every future fallback) have no times, so every CHECK passes them.
--   3. NEW finalize_training_session(p_session_id, p_actual_start, p_actual_end, p_setup_min) — the length is derived from the
--      times; the existing (p_session_id, p_duration_min) overload is NOT touched (the fallback). REVOKE anon/public.
--   4. correct_training_session (CREATE OR REPLACE, same signature, ACL kept): accepts actual_start / actual_end / setup_min,
--      recomputes the length from the times, refuses a duration_min that disagrees.
--   5. tg_training_session_lock_guard (CREATE OR REPLACE, ACL kept): the three new columns follow duration_min's rule — set once
--      on a not-yet-finalized row (Finalize), Correct-only after. Without this they would be raw-writable on a locked session.
--   Nothing else: no policy, no grant, no other function, no data. attested_training / dept_iso_hours_for are pinned, untouched.
--
-- PREFLIGHT (refuses, changes nothing): every touched/depended function by md5 (finalize, correct, the guard, attested_training,
-- dept_iso_hours_for, open_signin, drill_window_presence, reopen, my_department_id, my_member_id, is_training_manager,
-- recompute_training_plan_last_iso); the guard TRIGGER definition; every training_sessions constraint + all public policies by md5;
-- the training_sessions column list; refuses if any new column / constraint / the new overload already exists.
-- IN-TRANSACTION PROOF (any miss → RAISE → everything rolls back):
--   · THE LEDGER: for EVERY department, md5 of attested_training(dept, all time) AND md5 of dept_iso_hours_for(dept, all time),
--     BEFORE and AFTER — byte-identical.
--   · the session rows byte-identical (minus the three new, all-NULL columns); the columns exactly as intended
--   · setup_min / actual_* are read by EXACTLY three functions (finalize overload, correct, the guard) — nothing in the hours
--     pipeline; attested_training + dept_iso_hours_for still md5-identical to their pins
--   · the new bodies are exactly the generated text; the guard / correct ACLs unchanged; the new overload executable by
--     authenticated + service_role only (not anon); every OTHER public function, every policy, every training_sessions trigger
--     and every pre-existing constraint byte-identical; function count +1; verified unchanged
-- Dry run: docs/review/e1e3_sliceT_DRYRUN.txt. RETEST (separately, after): sql/e1e3_sliceT_session_times_RETEST.sql.
-- =====================================================================
DO $migrate$
DECLARE
  d uuid; r record; v_t text; v_n bigint;
  v_led_before jsonb; v_led_after jsonb; v_rows text; v_others text; v_fn_n bigint; v_ver bigint; v_readers text[];
BEGIN
  -- ---------------------------------------------------------------- 0. preflight
  IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name IN ('actual_start', 'actual_end', 'setup_min'))
     OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.training_sessions'::regclass AND conname IN (${Object.keys(CHECK_SQL).map((n) => `'${n}'`).join(", ")}))
     OR to_regprocedure('${NEW_FIN}') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: actual_start / actual_end / setup_min, a slice-T constraint, or the times finalize already exists — Slice T looks applied. Refusing.';
  END IF;
  FOR r IN SELECT * FROM (VALUES
${PINS.map((s) => `      ('${q(s)}', '${F[s].md5}')`).join(",\n")}) v(sig, md5) LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_t FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')') = r.sig;
    IF v_t IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'PREFLIGHT: % drifted from the capture (or is gone). Refusing.', r.sig; END IF;
  END LOOP;
  IF ${TRG_MD5} IS DISTINCT FROM '§TRG§' THEN
    RAISE EXCEPTION 'PREFLIGHT: a training_sessions trigger changed. Refusing.';
  END IF;
  IF ${OLD_CON_MD5} IS DISTINCT FROM '§CON§' THEN RAISE EXCEPTION 'PREFLIGHT: a training_sessions constraint changed. Refusing.'; END IF;
  IF ${POL_MD5} IS DISTINCT FROM '${M.policies_md5}' THEN RAISE EXCEPTION 'PREFLIGHT: a public policy changed since the capture. Refusing.'; END IF;
  IF ${COLS_SQL} IS DISTINCT FROM '${COLS_BEFORE}' THEN RAISE EXCEPTION 'PREFLIGHT: the training_sessions columns changed since the capture. Refusing.'; END IF;
  SELECT count(*) INTO v_fn_n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
  SELECT count(*) INTO v_ver FROM public.station_presence WHERE verified;
  v_rows := ${ROWS_MD5};
  v_others := ${ALL_FN_MD5(EXCL)};
  v_readers := ${NEW_REF};
${LEDGER("v_led_before")}

  -- ---------------------------------------------------------------- 1. columns + CHECKs
  ALTER TABLE public.training_sessions ADD COLUMN actual_start time, ADD COLUMN actual_end time, ADD COLUMN setup_min smallint;
${Object.entries(CHECK_SQL).map(([n, c]) => `  ALTER TABLE public.training_sessions ADD CONSTRAINT ${n} CHECK (${c});`).join("\n")}

  -- ---------------------------------------------------------------- 2. the lock guard (the three new columns: set once at Finalize, Correct-only after)
${GRD_NEW};

  -- ---------------------------------------------------------------- 3. correct_training_session (times correctable; length recomputed; disagreeing length refused)
${COR_NEW};

  -- ---------------------------------------------------------------- 4. the NEW times finalize (the length-only overload is untouched — the fallback)
${FIN_NEW};
  REVOKE ALL ON FUNCTION ${NEW_FIN} FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION ${NEW_FIN} TO authenticated, service_role;

  -- ---------------------------------------------------------------- 5. post-conditions (in-transaction)
${LEDGER("v_led_after")}
  IF v_led_after IS DISTINCT FROM v_led_before THEN
    SELECT string_agg(k, ', ') INTO v_t FROM jsonb_object_keys(v_led_before) k WHERE (v_led_before->k) IS DISTINCT FROM (v_led_after->k);
    RAISE EXCEPTION 'Post-condition failed: the credited-hours ledger moved for department(s) %. Rolling back.', v_t;
  END IF;
  IF ${ROWS_MD5} IS DISTINCT FROM v_rows THEN RAISE EXCEPTION 'Post-condition failed: a training_sessions row changed. Rolling back.'; END IF;
  IF EXISTS (SELECT 1 FROM public.training_sessions WHERE actual_start IS NOT NULL OR actual_end IS NOT NULL OR setup_min IS NOT NULL) THEN
    RAISE EXCEPTION 'Post-condition failed: a new column is not NULL on an existing row. Rolling back.';
  END IF;
  IF ${COLS_SQL} IS DISTINCT FROM '${COLS_AFTER}' THEN RAISE EXCEPTION 'Post-condition failed: the training_sessions columns are not as intended. Rolling back.'; END IF;
  IF (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.training_sessions'::regclass AND conname IN (${Object.keys(CHECK_SQL).map((n) => `'${n}'`).join(", ")}) AND convalidated) <> ${Object.keys(CHECK_SQL).length} THEN
    RAISE EXCEPTION 'Post-condition failed: the four slice-T CHECKs are not all present and validated. Rolling back.';
  END IF;
  IF ${OLD_CON_MD5} IS DISTINCT FROM '§CON§' THEN RAISE EXCEPTION 'Post-condition failed: a pre-existing constraint changed. Rolling back.'; END IF;
  -- the bodies are exactly the generated text; ACLs as intended
  IF ${fsrc(GRD.sig)} IS DISTINCT FROM '${q(NEWBODY.grd)}' OR ${facl(GRD.sig)} IS DISTINCT FROM '${GRD.acl}' THEN
    RAISE EXCEPTION 'Post-condition failed: the lock guard is not the generated body, or its ACL changed. Rolling back.';
  END IF;
  IF ${fsrc(COR.sig)} IS DISTINCT FROM '${q(NEWBODY.cor)}' OR ${facl(COR.sig)} IS DISTINCT FROM '${COR.acl}' THEN
    RAISE EXCEPTION 'Post-condition failed: correct_training_session is not the generated body, or its ACL changed. Rolling back.';
  END IF;
  IF (SELECT prosrc FROM pg_proc WHERE oid = '${NEW_FIN}'::regprocedure) IS DISTINCT FROM '${q(NEWBODY.fin)}'
     OR coalesce((SELECT proacl::text FROM pg_proc WHERE oid = '${NEW_FIN}'::regprocedure), '') IS DISTINCT FROM '${FN_ACL}'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = '${NEW_FIN}'::regprocedure)
     OR has_function_privilege('anon', '${NEW_FIN}', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: the times finalize is not the generated body, not SECURITY DEFINER, or its ACL is wrong (anon must not execute). Rolling back.';
  END IF;
  -- the two finalize overloads: exactly these named-argument sets, NO defaults — no call shape (named, as PostgREST sends, or
  -- positional) can resolve to both, and the existing {p_session_id, p_duration_min} call keeps resolving to the old function
  IF (SELECT string_agg(array_to_string(p.proargnames, ',') || '/' || p.pronargdefaults, ' | ' ORDER BY p.pronargs)
        FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'finalize_training_session')
     IS DISTINCT FROM 'p_session_id,p_duration_min/0 | p_session_id,p_actual_start,p_actual_end,p_setup_min/0' THEN
    RAISE EXCEPTION 'Post-condition failed: the finalize overloads are not exactly {p_session_id,p_duration_min} and {p_session_id,p_actual_start,p_actual_end,p_setup_min} with no defaults. Rolling back.';
  END IF;
  -- setup_min / actual_* are read by exactly the three functions — nothing in the hours pipeline
  IF (SELECT array_agg(x ORDER BY x) FROM (SELECT unnest(${NEW_REF}) EXCEPT SELECT unnest(v_readers)) z(x)) IS DISTINCT FROM (SELECT array_agg(x ORDER BY x) FROM unnest(${THREE_ARR}) x)
     OR NOT (v_readers <@ ${NEW_REF}) THEN
    RAISE EXCEPTION 'Post-condition failed: the functions reading the new columns are not exactly the three (finalize overload, correct, the guard). Rolling back.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm') AND pg_get_viewdef(c.oid) ~ '(actual_start|actual_end|setup_min)') THEN
    RAISE EXCEPTION 'Post-condition failed: a view reads a new column. Rolling back.';
  END IF;
  IF ${fmd5(ATT.sig)} IS DISTINCT FROM '${ATT.md5}' OR ${fmd5(ISO.sig)} IS DISTINCT FROM '${ISO.md5}'
     OR ${fmd5(FIN.sig)} IS DISTINCT FROM '${FIN.md5}' THEN
    RAISE EXCEPTION 'Post-condition failed: attested_training / dept_iso_hours_for / the length-only finalize changed. Rolling back.';
  END IF;
  IF ${ALL_FN_MD5(EXCL)} IS DISTINCT FROM v_others THEN RAISE EXCEPTION 'Post-condition failed: another public function changed. Rolling back.'; END IF;
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f') <> v_fn_n + 1 THEN
    RAISE EXCEPTION 'Post-condition failed: the function count is not +1. Rolling back.';
  END IF;
  IF ${POL_MD5} IS DISTINCT FROM '${M.policies_md5}' OR ${TRG_MD5} IS DISTINCT FROM '§TRG§' THEN
    RAISE EXCEPTION 'Post-condition failed: a policy or a training_sessions trigger changed. Rolling back.';
  END IF;
  IF (SELECT count(*) FROM public.station_presence WHERE verified) <> v_ver THEN RAISE EXCEPTION 'Post-condition failed: verified presence changed. Rolling back.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------- state row
SELECT jsonb_build_object(
  'columns', (SELECT string_agg(column_name || ' ' || udt_name, ', ' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name IN ('actual_start', 'actual_end', 'setup_min')),
  'checks', (SELECT jsonb_object_agg(conname, convalidated) FROM pg_constraint WHERE conrelid = 'public.training_sessions'::regclass AND conname IN (${Object.keys(CHECK_SQL).map((n) => `'${n}'`).join(", ")})),
  'finalize_overloads', (SELECT string_agg(p.oid::regprocedure::text, ' | ' ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'finalize_training_session'),
  'finalize_named_args', (SELECT string_agg(array_to_string(p.proargnames, ',') || ' (defaults ' || p.pronargdefaults || ')', ' | ' ORDER BY p.pronargs) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname = 'finalize_training_session'),
  'correct_md5', ${fmd5(COR.sig)}, 'guard_md5', ${fmd5(GRD.sig)}, 'times_finalize_md5', md5(pg_get_functiondef('${NEW_FIN}'::regprocedure)),
  'readers_of_new_columns', ${NEW_REF},
  'attested_md5', ${fmd5(ATT.sig)}, 'iso_md5', ${fmd5(ISO.sig)},
  'fn_count', (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'total_policies', (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
`;

// the trigger + constraint md5 pins: md5 of the captured pg_get_triggerdef / pg_get_constraintdef text, joined exactly as the SQL
// expressions (TRG_MD5 / OLD_CON_MD5) join them — the dry run proves the two agree.
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const TRG_PIN = md5(Object.entries(M.triggers).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, d]) => `${n}|${d}`).join(","));
const CON_PIN = md5(Object.entries(M.constraints).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([n, d]) => `${n}|${d}`).join(","));
for (const k of Object.keys(out)) out[k] = out[k].split("§TRG§").join(TRG_PIN).split("§CON§").join(CON_PIN);

// ================================================================ RETEST
const DA = `SELECT lower(m.email), m.id, m.department_id FROM public.members m WHERE m.status = 'Active' AND m.access && array['Department Admin']::text[]
          AND m.email IS NOT NULL AND (SELECT count(*) FROM public.members x WHERE lower(x.email) = lower(m.email)) = 1 ORDER BY m.department_id, m.id LIMIT 1`;
out["sql/e1e3_sliceT_session_times_RETEST.sql"] = `-- =====================================================================
-- RETEST for e1e3_sliceT_session_times. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Everything runs inside ONE sub-block ending in RAISE 'SENTINEL' (rolled back): synthetic sessions, a synthetic roll, Finalize,
-- Correct — NOTHING STAYS. The final RAISE is the report — the "ERROR" IS the report. As a REAL Department Admin (JWT email claim,
-- role authenticated) where a call goes through the API; as the table owner where the point is that the guard / CHECK stop
-- EVERY writer.
--   S0 the slice is in place: the columns, the four CHECKs validated, both finalize overloads, the bodies' md5s = the state row
--   T1 Finalize with times 19:00–22:26 + setup 20 → duration_min 206, the times + setup stored, one 'finalize' audit row whose
--      diff carries done / duration_min / actual_start / actual_end / setup_min
--   T2 past midnight: 22:00–01:30 → 210
--   T3 the guard: a raw UPDATE of actual_start / actual_end / setup_min on a finalized session → LOCKED_SESSION (owner too)
--   T4 the CHECK: a duration_min that disagrees with the times, written under the correction flag (guard bypassed) → refused
--   T5 Correct: actual_end 23:00 → duration_min recomputed 240, the diff logs actual_end + duration_min
--   T6 Correct: only duration_min (100) while times exist → BAD_VALUE (change the times)
--   T7 Correct: clearing both times → a length-only session, the length kept
--   T8 the fallback: the length-only finalize (45) still works, no times
--   T9 refusals: start = end · one time missing · setup 700 · a session that already has a different length → USE_CORRECT
--   T10 the ledger: attested_training credits the T1 session min(90, duration_min) = 90 minutes from date + start_time, and
--       setup_min never appears in it
--   T11 reopen, then a raw UPDATE of the stored times → LOCKED_SESSION (set once, then Correct-only)
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0;
  v_email text; v_me uuid; v_dept uuid; s1 uuid; s2 uuid; s3 uuid; s4 uuid; v_ok boolean; v_t text; v_n bigint; v_r jsonb; v_row record;
BEGIN
  BEGIN
    ${DA} INTO v_email, v_me, v_dept;
    IF v_email IS NULL THEN RAISE EXCEPTION 'SKIPALL: no real Department Admin to act as'; END IF;
    -- S0
    IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name IN ('actual_start', 'actual_end', 'setup_min')) = 3
       AND (SELECT count(*) FROM pg_constraint WHERE conrelid = 'public.training_sessions'::regclass AND conname IN (${Object.keys(CHECK_SQL).map((n) => `'${n}'`).join(", ")}) AND convalidated) = 4
       AND to_regprocedure('${NEW_FIN}') IS NOT NULL AND to_regprocedure('public.finalize_training_session(uuid, integer)') IS NOT NULL
       AND ${THREE_ARR} <@ ${NEW_REF} AND NOT ('attested_training(uuid,timestamp with time zone,timestamp with time zone)'::text = ANY (${NEW_REF}::text[]))
       AND NOT ('dept_iso_hours_for(uuid,timestamp with time zone,timestamp with time zone)'::text = ANY (${NEW_REF}::text[])) THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  S0 columns + 4 validated CHECKs + both finalize overloads; finalize/correct/the guard read the new columns, the ledger does not' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  S0 the slice is not in place as intended' || chr(10); END IF;

    -- synthetic sessions (owner) + the DA on each roll (attendance: membership-window triggers still run — a refusal SKIPs T10)
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-T RETEST 1', current_date, '19:00') RETURNING id INTO s1;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-T RETEST 2', current_date, '22:00') RETURNING id INTO s2;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-T RETEST 3', current_date, '18:00') RETURNING id INTO s3;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time, duration_min) VALUES (v_dept, 'SLICE-T RETEST 4', current_date, '18:00', 60) RETURNING id INTO s4;
    v_ok := true;
    BEGIN INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES (v_dept, s1, v_me, now()); EXCEPTION WHEN OTHERS THEN v_ok := false; END;
    PERFORM set_config('request.jwt.claims', json_build_object('email', v_email)::text, true);
    EXECUTE 'SET LOCAL ROLE authenticated';

    -- T1
    v_r := public.finalize_training_session(p_session_id => s1, p_actual_start => '19:00', p_actual_end => '22:26', p_setup_min => 20);
    EXECUTE 'RESET ROLE';
    SELECT * INTO v_row FROM public.training_sessions WHERE id = s1;
    SELECT changes::text INTO v_t FROM public.training_session_audit WHERE session_id = s1 AND action = 'finalize' ORDER BY seq DESC LIMIT 1;
    IF v_row.done AND v_row.duration_min = 206 AND v_row.actual_start = '19:00' AND v_row.actual_end = '22:26' AND v_row.setup_min = 20 AND (v_r->>'duration_min')::int = 206
       AND v_t LIKE '%"done"%' AND v_t LIKE '%"duration_min"%' AND v_t LIKE '%"actual_start"%' AND v_t LIKE '%"actual_end"%' AND v_t LIKE '%"setup_min"%' THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  T1 Finalize 19:00–22:26 + setup 20 → 206 min, times + setup stored, the audit diff carries all five' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T1 finalize with times: duration %s, audit %s%s', v_row.duration_min, left(coalesce(v_t, '(none)'), 120), chr(10)); END IF;

    -- T2
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.finalize_training_session(p_session_id => s2, p_actual_start => '22:00', p_actual_end => '01:30', p_setup_min => NULL);
    EXECUTE 'RESET ROLE';
    IF (SELECT duration_min FROM public.training_sessions WHERE id = s2) = 210 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T2 past midnight 22:00–01:30 → 210 min' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T2 past-midnight span' || chr(10); END IF;

    -- T3 the guard stops every writer (table owner here)
    v_n := 0;
    BEGIN UPDATE public.training_sessions SET actual_start = '18:30' WHERE id = s1; EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.training_sessions SET actual_end = '23:00' WHERE id = s1; EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; WHEN check_violation THEN NULL; END;
    BEGIN UPDATE public.training_sessions SET setup_min = 5 WHERE id = s1; EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; END;
    IF v_n = 3 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T3 raw UPDATE of actual_start / actual_end / setup_min on a finalized session → LOCKED_SESSION (owner too)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T3 the guard stopped %s of 3%s', v_n, chr(10)); END IF;

    -- T4 the CHECK (guard bypassed under the correction flag)
    v_ok := false;
    PERFORM set_config('b4c.session_correction', 'on', true);
    BEGIN UPDATE public.training_sessions SET duration_min = 100 WHERE id = s1; EXCEPTION WHEN check_violation THEN v_ok := true; END;
    PERFORM set_config('b4c.session_correction', '', true);
    IF v_ok THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T4 a duration_min that disagrees with the times is refused by the CHECK (even under the correction flag)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T4 the CHECK let a disagreeing length through' || chr(10); END IF;

    -- T5 / T6 / T7 Correct
    EXECUTE 'SET LOCAL ROLE authenticated';
    v_r := public.correct_training_session(s1, '{"actual_end": "23:00"}'::jsonb, '{}', '{}', 'RETEST: the drill ran long');
    EXECUTE 'RESET ROLE';
    IF (SELECT duration_min FROM public.training_sessions WHERE id = s1) = 240 AND v_r->'changes' ? 'actual_end' AND v_r->'changes' ? 'duration_min' THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  T5 Correct actual_end 23:00 → length recomputed 240, diff logs actual_end + duration_min' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T5 correct times: %s%s', v_r, chr(10)); END IF;
    v_t := NULL;
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN PERFORM public.correct_training_session(s1, '{"duration_min": 100}'::jsonb, '{}', '{}', 'RETEST: try a raw length'); EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    EXECUTE 'RESET ROLE';
    IF v_t LIKE 'BAD_VALUE: the length comes from the actual start and end%' THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T6 Correct: a length alone while times exist → BAD_VALUE (change the times)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T6 %s%s', coalesce(v_t, 'accepted'), chr(10)); END IF;
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.correct_training_session(s1, '{"actual_start": "", "actual_end": ""}'::jsonb, '{}', '{}', 'RETEST: times were a guess');
    EXECUTE 'RESET ROLE';
    SELECT * INTO v_row FROM public.training_sessions WHERE id = s1;
    IF v_row.actual_start IS NULL AND v_row.actual_end IS NULL AND v_row.duration_min = 240 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T7 Correct: clearing both times → length-only, 240 kept' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T7 clearing the times' || chr(10); END IF;

    -- T8 the length-only fallback — called NAMED, exactly as the shipped web/native clients call it today ({p_session_id,
    -- p_duration_min}); it must still resolve to the old function
    EXECUTE 'SET LOCAL ROLE authenticated';
    PERFORM public.finalize_training_session(p_session_id => s3, p_duration_min => 45);
    EXECUTE 'RESET ROLE';
    SELECT * INTO v_row FROM public.training_sessions WHERE id = s3;
    IF v_row.done AND v_row.duration_min = 45 AND v_row.actual_start IS NULL AND v_row.setup_min IS NULL THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T8 the shipped clients'' call {p_session_id, p_duration_min} still resolves to the length-only finalize (45, no times)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T8 the fallback' || chr(10); END IF;

    -- T9 refusals
    v_n := 0;
    EXECUTE 'SET LOCAL ROLE authenticated';
    BEGIN PERFORM public.finalize_training_session(p_session_id => s4, p_actual_start => '19:00', p_actual_end => '19:00', p_setup_min => NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF; END;
    BEGIN PERFORM public.finalize_training_session(p_session_id => s4, p_actual_start => '19:00', p_actual_end => NULL, p_setup_min => NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF; END;
    BEGIN PERFORM public.finalize_training_session(p_session_id => s4, p_actual_start => '18:00', p_actual_end => '19:00', p_setup_min => 700); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'BAD_VALUE%' THEN v_n := v_n + 1; END IF; END;
    BEGIN PERFORM public.finalize_training_session(p_session_id => s4, p_actual_start => '18:00', p_actual_end => '19:30', p_setup_min => NULL); EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE 'USE_CORRECT%' THEN v_n := v_n + 1; END IF; END;
    EXECUTE 'RESET ROLE';
    IF v_n = 4 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T9 refused: start = end · one time missing · setup 700 · an existing different length (USE_CORRECT)' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || format('FAIL  T9 %s of 4 refused%s', v_n, chr(10)); END IF;

    -- T10 the ledger (needs the synthetic roll on s1 — finalized first, so re-set its times via Correct for a clean read)
    IF EXISTS (SELECT 1 FROM public.session_attendance WHERE session_id = s1) THEN
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.correct_training_session(s1, '{"actual_start": "19:00", "actual_end": "22:26", "setup_min": 300}'::jsonb, '{}', '{}', 'RETEST: put the times back');
      EXECUTE 'RESET ROLE';
      SELECT count(*) INTO v_n FROM public.attested_training(v_dept, now() - interval '2 days', now() + interval '2 days') a
       WHERE a.session_id = s1 AND a.member_id = v_me AND a.end_at - a.start_at = interval '90 minutes'
         AND a.start_at = (current_date + time '19:00') AT TIME ZONE 'America/Chicago';
      IF v_n = 1 THEN v_pass := v_pass + 1; rpt := rpt || 'PASS  T10 the ledger credits min(90, 206) = 90 min from date + start_time; setup_min (300) has no effect' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T10 the ledger row for the finalized session is not as expected' || chr(10); END IF;
    ELSE v_skip := v_skip + 1; rpt := rpt || 'SKIP  T10 the synthetic roll entry was refused (membership window) — the PGlite dry run carries this case' || chr(10); END IF;

    -- T11 reopen → the stored times are still Correct-only (s1 has a roll entry; a reopened session with NO attendance is unlocked
    -- for every column by the existing guard — unchanged semantics)
    IF EXISTS (SELECT 1 FROM public.session_attendance WHERE session_id = s1) THEN
      EXECUTE 'SET LOCAL ROLE authenticated';
      PERFORM public.reopen_training_session(s1, 'RETEST: reopen to check the lock');
      EXECUTE 'RESET ROLE';
      v_ok := false;
      BEGIN UPDATE public.training_sessions SET actual_end = '23:30' WHERE id = s1; EXCEPTION WHEN insufficient_privilege THEN v_ok := true; END;
      IF v_ok AND NOT (SELECT done FROM public.training_sessions WHERE id = s1) THEN
        v_pass := v_pass + 1; rpt := rpt || 'PASS  T11 reopened (with its roll): a raw UPDATE of the stored times → LOCKED_SESSION (set once, Correct-only after)' || chr(10);
      ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  T11 a reopened session''s times were raw-writable' || chr(10); END IF;
    ELSE v_skip := v_skip + 1; rpt := rpt || 'SKIP  T11 needs the synthetic roll entry (refused) — the PGlite dry run carries this case' || chr(10); END IF;

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
out["sql/e1e3_sliceT_session_times_ROLLBACK.sql"] = `-- =====================================================================
-- ROLLBACK for e1e3_sliceT_session_times — insurance, GENERATED from the same capture.
-- Refuses unless Slice T is applied, and REFUSES while any session holds actual times or a setup time (dropping the columns
-- would destroy them — clear them with Correct first, or keep the slice). Then: drop the times finalize, restore
-- correct_training_session + the lock guard from their exact captured definitions (CREATE OR REPLACE — ACLs kept), drop the four
-- CHECKs and the three columns, and prove every pin is back.
-- =====================================================================
DO $rollback$
DECLARE v_n bigint;
BEGIN
  IF to_regprocedure('${NEW_FIN}') IS NULL OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_sessions' AND column_name = 'actual_start') THEN
    RAISE EXCEPTION 'ROLLBACK: Slice T is not applied. Refusing.';
  END IF;
  SELECT count(*) INTO v_n FROM public.training_sessions WHERE actual_start IS NOT NULL OR actual_end IS NOT NULL OR setup_min IS NOT NULL;
  IF v_n > 0 THEN RAISE EXCEPTION 'ROLLBACK: % session(s) hold actual times or a setup time — dropping the columns would lose them. Refusing.', v_n; END IF;
  DROP FUNCTION ${NEW_FIN};
${COR.def};
${GRD.def};
${Object.keys(CHECK_SQL).map((n) => `  ALTER TABLE public.training_sessions DROP CONSTRAINT ${n};`).join("\n")}
  ALTER TABLE public.training_sessions DROP COLUMN actual_start, DROP COLUMN actual_end, DROP COLUMN setup_min;
  IF ${fmd5(COR.sig)} IS DISTINCT FROM '${COR.md5}' OR ${fmd5(GRD.sig)} IS DISTINCT FROM '${GRD.md5}' OR ${fmd5(FIN.sig)} IS DISTINCT FROM '${FIN.md5}'
     OR ${facl(COR.sig)} IS DISTINCT FROM '${COR.acl}' OR ${facl(GRD.sig)} IS DISTINCT FROM '${GRD.acl}'
     OR ${COLS_SQL} IS DISTINCT FROM '${COLS_BEFORE}' OR ${OLD_CON_MD5} IS DISTINCT FROM '${CON_PIN}' THEN
    RAISE EXCEPTION 'ROLLBACK post-condition: not back to the captured state. Rolling back.';
  END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
`;

// ================================================================ change list
out["docs/review/e1e3_sliceT_CHANGE_LIST.md"] = `# E1/E3 Slice T — change list (GENERATED by docs/review/e1e3_sliceT_build.mjs from the 2026-10-29 live captures)

| object | before (live) | after |
|---|---|---|
| \`training_sessions\` columns | ${M.columns.training_sessions.length} columns (\`duration_min smallint\` = the length the ledger reads) | + \`actual_start time\`, \`actual_end time\`, \`setup_min smallint\` (nullable) |
| CHECKs | ${Object.keys(M.constraints).length} constraints (incl. \`training_sessions_duration_range\` 1–1440) | + ${Object.keys(CHECK_SQL).map((n) => `\`${n}\``).join(", ")} |
| \`finalize_training_session(uuid, integer)\` | md5 \`${FIN.md5}\` | **unchanged** (the length-only fallback) |
| \`finalize_training_session(uuid, time, time, integer)\` | — | **new**: SECURITY DEFINER, \`search_path=public\`, EXECUTE authenticated + service_role only |
| \`correct_training_session(…)\` | md5 \`${COR.md5}\` | + keys \`actual_start\`, \`actual_end\`, \`setup_min\`; length recomputed from the times; a disagreeing length refused (ACL kept) |
| \`tg_training_session_lock_guard()\` | md5 \`${GRD.md5}\` | + the three columns: set once at Finalize, Correct-only after (ACL kept) |
| \`attested_training\` / \`dept_iso_hours_for\` | \`${ATT.md5}\` / \`${ISO.md5}\` | **unchanged** — pinned; per-department output proven byte-identical |

The span formula, used by the CHECK and both RPCs: \`${SPAN("start", "end")}\`. An end at or before the start ran past midnight.
`;

// ---------------------------------------------------------------- write or check
const check = process.argv.includes("--check");
let bad = 0;
for (const [p, s] of Object.entries(out)) {
  if (check) { let cur = null; try { cur = readFileSync(join(root, p), "utf8"); } catch { /* missing */ } if (cur !== s) { console.log(`DIFFERS ${p}`); bad++; } else console.log(`same    ${p}`); }
  else { writeFileSync(join(root, p), s); console.log(`wrote   ${p} (${s.length} bytes)`); }
}
if (check && bad) process.exit(1);
