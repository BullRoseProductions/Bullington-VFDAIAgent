// node docs/review/ws4d_hours_build.mjs
// GENERATES sql/ws4d_hours_credit_DRAFT.sql (+ docs/review/ws4d_hours_FUNCTION_DIFF.txt) from the LIVE function bodies in
// docs/review/ws4d_hours_LIVEDEFS.json (read 2026-10-28). Every change is an EXACT, count-checked substitution on a live
// body — so the new functions are provably the live ones plus only the lines below, and the reviewer reads the diff.
// WS-4d rulings (B4C_WS4d_Directive.md): F3-a (A) · D2-a read time · D2-b the attested cap applies · V-a.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
const root = fileURLToPath(new URL("../../", import.meta.url));
const L = JSON.parse(readFileSync(join(root, "docs/review/ws4d_hours_LIVEDEFS.json"), "utf8")).defs;
const md5 = (s) => createHash("md5").update(s).digest("hex");

// The meeting test, one spelling everywhere: a row's session is a flagged business meeting.
const MEETING = (col) => `coalesce((select t.is_meeting from public.training_sessions t where t.id = ${col}), false)`;

const SIG = {
  verdict: "readiness_verdict(uuid,uuid)",
  isoFor: "dept_iso_hours_for(uuid,timestamp with time zone,timestamp with time zone)",
  byStation: "dept_iso_hours_by_station(timestamp with time zone,timestamp with time zone)",
  shifts: "dept_station_shifts(timestamp with time zone,timestamp with time zone)",
  myShifts: "my_station_shifts(timestamp with time zone,timestamp with time zone)",
  byMonth: "dept_iso_hours_by_month(timestamp with time zone[],timestamp with time zone[])",
};
const READ_PINS = [   // read, not replaced — pinned so a drift underneath the slice refuses it
  "attested_training(uuid,timestamp with time zone,timestamp with time zone)",
  "dept_iso_hours(timestamp with time zone,timestamp with time zone)",
  "dept_member_iso_hours_by_month(uuid,timestamp with time zone[],timestamp with time zone[])",
  "member_check_in(uuid,text,double precision,double precision,double precision)",
  "close_training_presence_on_done()",
  "is_leadership()",
  "my_department_id()",
];
const NOTE = {
  verdict: "-- WS-4d F-3 (2026-10-28): activity.station_hours = the member's CREDITED hours (dept_iso_hours_for, last 12 months) — was every closed shift.",
  isoFor: "-- WS-4d D-2 (2026-10-28): a business meeting's time (is_meeting) credits STANDBY, not training — decided at read time; totals unchanged.",
  byStation: "-- WS-4d D-2 (2026-10-28): a business meeting's time (is_meeting) credits STANDBY, not training — the same rule as dept_iso_hours_for.",
  shifts: "-- WS-4d D-2 (2026-10-28): a business meeting's row reads kind 'standby' (observed and attested) — the same rule as dept_iso_hours_for.",
  myShifts: "-- WS-4d D-2 (2026-10-28): a business meeting's row reads kind 'standby' — the same rule as dept_iso_hours_for.",
  byMonth: "-- WS-4d V-a (2026-10-28): a VOIDED shift (out = in) is listed but not counted as a shift; its hours were already 0.",
};
const SUBS = {
  verdict: [[
    `      'station_hours', coalesce((select round(sum(extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 1)
                                   from public.station_presence sp
                                  where sp.member_id = p_member and sp.department_id = p_dept and sp.checked_out_at is not null
                                    and not coalesce(sp.auto_closed, false) and sp.checked_in_at >= now() - interval '12 months'), 0),`,
    `      'station_hours', coalesce((select round(h.iso_total_hours, 1)
                                   from public.dept_iso_hours_for(p_dept, now() - interval '12 months', now()) h
                                  where h.member_id = p_member), 0),`]],
  isoFor: [
    [`select sp.member_id as mid, (sp.kind = 'training') as is_training,`,
     `select sp.member_id as mid, (sp.kind = 'training' and not ${MEETING("sp.session_id")}) as is_training,`],
    [`select att.member_id as mid, true as is_training,`,
     `select att.member_id as mid, not ${MEETING("att.session_id")} as is_training,`]],
  byStation: [
    [`      (sp.kind = 'training')                    as is_training,`,
     `      (sp.kind = 'training' and not ${MEETING("sp.session_id")}) as is_training,`],
    [`      true                                      as is_training,`,
     `      not ${MEETING("att.session_id")} as is_training,`]],
  shifts: [
    [`           sp.kind, sp.verified, sp.auto_closed,`,
     `           case when sp.kind = 'training' and ${MEETING("sp.session_id")} then 'standby'::text else sp.kind end as kind, sp.verified, sp.auto_closed,`],
    [`           'training'::text                             as kind,`,
     `           (case when ${MEETING("att.session_id")} then 'standby' else 'training' end)::text as kind,`]],
  myShifts: [
    [`           sp.kind, sp.verified,`,
     `           case when sp.kind = 'training' and ${MEETING("sp.session_id")} then 'standby'::text else sp.kind end as kind, sp.verified,`]],
  byMonth: [
    [`         (select count(*) from public.dept_station_shifts(p_starts[i], p_ends[i]))::integer`,
     `         (select count(*) filter (where s.checked_out_at > s.checked_in_at) from public.dept_station_shifts(p_starts[i], p_ends[i]) s)::integer`]],
};

const NEW = {}, diff = [];
for (const [k, sig] of Object.entries(SIG)) {
  let body = L[sig].def;
  for (const [a, b] of SUBS[k]) {
    const c = body.split(a).length - 1;
    if (c !== 1) throw new Error(`${sig}: expected exactly 1 of: ${a.slice(0, 90)} — found ${c}`);
    body = body.replace(a, b);
  }
  const at = body.indexOf("AS $function$\n");
  if (at < 0) throw new Error(`${sig}: no AS $function$`);
  body = body.slice(0, at + 14) + NOTE[k] + "\n" + body.slice(at + 14);
  NEW[k] = body;
  diff.push(`==== public.${sig}\n---- live md5 ${L[sig].md5}\n` + SUBS[k].map(([a, b]) => `- ${a.trim()}\n+ ${b.trim()}`).join("\n") + `\n+ ${NOTE[k]}\n`);
}
writeFileSync(join(root, "docs/review/ws4d_hours_FUNCTION_DIFF.txt"),
  "WS-4d — every change to the six replaced functions, as exact substitutions on the live bodies (docs/review/ws4d_hours_build.mjs).\n" +
  "Nothing else in any body changes; signatures, return types, volatility, SECURITY DEFINER, search_path and grants are kept (CREATE OR REPLACE).\n\n" + diff.join("\n"));

const pinLines = (sigs) => sigs.map((s) => `      'public.${s}|${L[s].md5}'`).join(",\n");
const REPLACED = Object.values(SIG);
const sql = `-- =====================================================================
-- WS-4d — the hours-credit slice (ONE transaction, three parts). DRAFT for gate review — NOT APPLIED.
-- GENERATED by docs/review/ws4d_hours_build.mjs from the live bodies (docs/review/ws4d_hours_LIVEDEFS.json, 2026-10-28);
-- the exact changes, function by function: docs/review/ws4d_hours_FUNCTION_DIFF.txt. Rulings: B4C_WS4d_Directive.md.
--
--   F-3 (F3-a = A)  readiness_verdict: activity.station_hours = the member's CREDITED hours — dept_iso_hours_for(dept,
--                   now() − 12 months, now()) — instead of every closed shift (unverified included, no de-overlap, no
--                   attested drills). EXPLAIN ANALYZE (read-only, Indian Harbor, 37 counted members): 6.2 ms per call,
--                   232 ms for the whole packet → path (A); no refactor of the credited rule.
--   D-2 (D2-a READ TIME, D2-b cap applies)  a business meeting (training_sessions.is_meeting) credits STANDBY, not training.
--                   The four readers classify a row as training only if kind = 'training' AND NOT is_meeting(session):
--                   dept_iso_hours_for · dept_iso_hours_by_station (the split) · dept_station_shifts · my_station_shifts
--                   (the returned kind). attested_training is UNTOUCHED (the 90-minute cap applies to meetings as to
--                   drills); no station_presence row is rewritten; ticking/unticking the flag re-files at read time.
--   V-a             dept_iso_hours_by_month: a VOIDED shift (out = in) is not counted as a shift; it stays listed
--                   (WS-4a "Voided"), its hours were already 0, and a sub-minute shift (out > in) still counts.
--
-- CREATE OR REPLACE, SAME SIGNATURES — no DROP, so grants are never reset (memory: anon-execute-revoke-pattern).
-- PREFLIGHT refuses on drift: all six replaced functions and the seven they lean on, by md5; the columns the new
-- expressions read. IN-TRANSACTION PROOF (rolls everything back on any miss):
--   · every member's iso_total_hours from dept_iso_hours_for BYTE-IDENTICAL before/after — every department, windows
--     12 months / 3 months / 30 days; the training/standby SPLIT identical too while no session is flagged a meeting
--     (0 live today — so today nothing moves at all)
--   · every counted member's scorecard station_hours == round(their credited 12-month hours, 1)
--   · proacl / prosecdef / proconfig / provolatile / result type of all six unchanged; the seven read pins unchanged
--   · policies + function count unchanged; verified untouched
-- Dry run: docs/review/ws4d_hours_DRYRUN.txt. RETEST (separately, after): sql/ws4d_hours_credit_RETEST.sql.
-- =====================================================================
DO $migrate$
DECLARE
  v_t text; v_n bigint; v_meet bigint;
  v_meta_before text; v_meta_after text; v_pol_before bigint; v_pol_after bigint; v_fn_before bigint; v_fn_after bigint;
  v_ver_before bigint; v_ver_after bigint;
  meta_sql constant text := $q$
    SELECT string_agg(p.oid::regprocedure::text || '|' || coalesce(p.proacl::text, '') || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '')
                      || '|' || p.provolatile::text || '|' || pg_get_function_result(p.oid), E'\\n' ORDER BY 1)
      FROM pg_proc p
     WHERE p.oid = ANY (ARRAY[${REPLACED.map((s) => `'public.${s}'::regprocedure`).join(", ")}]::oid[])$q$;
BEGIN
  -- ---------------------------------------------------------------- 0. preflight
  IF position('WS-4d' in pg_get_functiondef('public.${SIG.verdict}'::regprocedure)) > 0 THEN
    RAISE EXCEPTION 'PREFLIGHT: readiness_verdict already carries the WS-4d change — the slice looks applied. Refusing.';
  END IF;
  FOR v_t IN SELECT unnest(ARRAY[
${pinLines([...REPLACED, ...READ_PINS])}]) LOOP
    IF to_regprocedure(split_part(v_t, '|', 1)) IS NULL
       OR md5(pg_get_functiondef(to_regprocedure(split_part(v_t, '|', 1)))) IS DISTINCT FROM split_part(v_t, '|', 2) THEN
      RAISE EXCEPTION 'PREFLIGHT: % drifted from its pinned body. Re-read it before applying. Refusing.', split_part(v_t, '|', 1);
    END IF;
  END LOOP;
  FOR v_t IN SELECT unnest(ARRAY['training_sessions.is_meeting:boolean', 'station_presence.session_id:uuid', 'station_presence.kind:text',
                                 'station_presence.checked_in_at:timestamp with time zone', 'station_presence.checked_out_at:timestamp with time zone']) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public'
                     AND table_name = split_part(split_part(v_t, ':', 1), '.', 1) AND column_name = split_part(split_part(v_t, ':', 1), '.', 2)
                     AND data_type = split_part(v_t, ':', 2)) THEN
      RAISE EXCEPTION 'PREFLIGHT: % not found with that type. Refusing.', v_t;
    END IF;
  END LOOP;
  EXECUTE meta_sql INTO v_meta_before;
  SELECT count(*) INTO v_pol_before FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_fn_before FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
  SELECT count(*) INTO v_ver_before FROM public.station_presence WHERE verified;
  SELECT count(*) INTO v_meet FROM public.training_sessions WHERE is_meeting;

  -- the BEFORE snapshot: every department, three windows, the credited rule as it is now
  CREATE TEMP TABLE _ws4d_before ON COMMIT DROP AS
    SELECT d.id AS dept, w.k, h.member_id, h.iso_total_hours, h.training_hours, h.standby_hours
      FROM public.departments d
      CROSS JOIN (VALUES ('12mo', now() - interval '12 months'), ('3mo', now() - interval '3 months'), ('30d', now() - interval '30 days')) w(k, f)
      CROSS JOIN LATERAL public.dept_iso_hours_for(d.id, w.f, now()) h;

  -- ---------------------------------------------------------------- 1. the six functions (live body + the listed changes)
${Object.entries(NEW).map(([k, b], i) => `  EXECUTE $ws4d_${i}$\n${b}\n$ws4d_${i}$;`).join("\n")}

  -- ---------------------------------------------------------------- 2. post-conditions (in-transaction)
  EXECUTE meta_sql INTO v_meta_after;
  IF v_meta_after IS DISTINCT FROM v_meta_before THEN
    RAISE EXCEPTION 'Post-condition failed: a replaced function''s grants / definer / search_path / volatility / result type changed. Rolling back.';
  END IF;
  FOR v_t IN SELECT unnest(ARRAY[
${pinLines(READ_PINS)}]) LOOP
    IF md5(pg_get_functiondef(to_regprocedure(split_part(v_t, '|', 1)))) IS DISTINCT FROM split_part(v_t, '|', 2) THEN
      RAISE EXCEPTION 'Post-condition failed: % changed (it must not be touched). Rolling back.', split_part(v_t, '|', 1);
    END IF;
  END LOOP;
  CREATE TEMP TABLE _ws4d_after ON COMMIT DROP AS
    SELECT d.id AS dept, w.k, h.member_id, h.iso_total_hours, h.training_hours, h.standby_hours
      FROM public.departments d
      CROSS JOIN (VALUES ('12mo', now() - interval '12 months'), ('3mo', now() - interval '3 months'), ('30d', now() - interval '30 days')) w(k, f)
      CROSS JOIN LATERAL public.dept_iso_hours_for(d.id, w.f, now()) h;
  -- THE TOTAL PROOF: every member's credited total byte-identical, every department, every window
  SELECT count(*) INTO v_n FROM _ws4d_before b FULL JOIN _ws4d_after a USING (dept, k, member_id)
   WHERE b.iso_total_hours IS DISTINCT FROM a.iso_total_hours;
  IF v_n <> 0 THEN RAISE EXCEPTION 'Post-condition failed: % member/window credited totals changed. Rolling back.', v_n; END IF;
  -- THE SPLIT: identical too while no session is a meeting (D-2 can only move the split, and only for meetings)
  IF v_meet = 0 THEN
    SELECT count(*) INTO v_n FROM _ws4d_before b JOIN _ws4d_after a USING (dept, k, member_id)
     WHERE b.training_hours IS DISTINCT FROM a.training_hours OR b.standby_hours IS DISTINCT FROM a.standby_hours;
    IF v_n <> 0 THEN RAISE EXCEPTION 'Post-condition failed: % training/standby splits moved with no meeting flagged. Rolling back.', v_n; END IF;
  END IF;
  -- F-3: every counted member's scorecard station_hours == their credited 12-month hours (rounded to 0.1)
  SELECT count(*) INTO v_n
    FROM public.members m
   WHERE m.status IN ('Active', 'Probationary') AND NOT coalesce(m.access && array['Project Admin']::text[], false)
     AND NOT EXISTS (SELECT 1 FROM public.member_separation s WHERE s.member_id = m.id)
     AND (public.readiness_verdict(m.department_id, m.id)->'activity'->>'station_hours')::numeric
         IS DISTINCT FROM coalesce((SELECT round(a.iso_total_hours, 1) FROM _ws4d_after a WHERE a.dept = m.department_id AND a.k = '12mo' AND a.member_id = m.id), 0);
  IF v_n <> 0 THEN RAISE EXCEPTION 'Post-condition failed: % scorecards disagree with the credited hours. Rolling back.', v_n; END IF;
  SELECT count(*) INTO v_pol_after FROM pg_policies WHERE schemaname = 'public';
  SELECT count(*) INTO v_fn_after FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f';
  IF v_pol_after <> v_pol_before OR v_fn_after <> v_fn_before THEN
    RAISE EXCEPTION 'Post-condition failed: policies %->% / functions %->% changed. Rolling back.', v_pol_before, v_pol_after, v_fn_before, v_fn_after;
  END IF;
  SELECT count(*) INTO v_ver_after FROM public.station_presence WHERE verified;
  IF v_ver_after <> v_ver_before THEN RAISE EXCEPTION 'Post-condition failed: verified presence changed (% -> %). Rolling back.', v_ver_before, v_ver_after; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------- state row
SELECT jsonb_build_object(
  'new_md5', jsonb_build_object(
${Object.entries(SIG).map(([k, s]) => `    '${k}', md5(pg_get_functiondef('public.${s}'::regprocedure))`).join(",\n")}),
  'ws4d_marked',        (SELECT count(*) FROM pg_proc p WHERE p.oid = ANY (ARRAY[${REPLACED.map((s) => `'public.${s}'::regprocedure`).join(", ")}]::oid[])
                            AND position('WS-4d' in pg_get_functiondef(p.oid)) > 0),
  'attested_training_md5', md5(pg_get_functiondef('public.${READ_PINS[0]}'::regprocedure)),
  'meetings_flagged',   (SELECT count(*) FROM public.training_sessions WHERE is_meeting),
  'voided_rows',        (SELECT count(*) FROM public.station_presence WHERE checked_out_at IS NOT NULL AND checked_out_at = checked_in_at AND kind IN ('standby', 'training')),
  'total_policies',     (SELECT count(*) FROM pg_policies WHERE schemaname = 'public'),
  'fn_count',           (SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f'),
  'verified_presence',  (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
`;
writeFileSync(join(root, "sql/ws4d_hours_credit_DRAFT.sql"), sql);
console.log(`wrote sql/ws4d_hours_credit_DRAFT.sql (${sql.length} chars, md5 ${md5(sql)}) + docs/review/ws4d_hours_FUNCTION_DIFF.txt`);
