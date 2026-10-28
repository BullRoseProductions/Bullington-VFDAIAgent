// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/ws4d_hours_dryrun_harness.mjs
// DRY RUN for sql/ws4d_hours_credit_DRAFT.sql + its RETEST — NOT the live DB. Mock: the tables the hours rule reads, the
// LIVE bodies of all 13 pinned functions (docs/review/ws4d_hours_LIVEDEFS.json — no stubs for anything the slice replaces
// or reads), and three LABELLED STUBS for readiness_verdict's unrelated helpers (readiness_items, expiration_rows,
// readiness_window — the verdict/certs parts, untouched by WS-4d). Seed: two departments of realistic history — standby
// across 12 months (incl. 8 months back), unverified, auto-closed, voided and sub-minute shifts, a drill with attested +
// observed attendance.
// Runs: pins -> migration (+ its in-transaction proof) -> state row -> re-run refused -> RETEST -> the same with a FLAGGED
// MEETING already in the data (totals still byte-identical; the split moves) -> drift refusals -> mutations -> post-apply drift.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const L = JSON.parse(readFileSync(join(root, "docs/review/ws4d_hours_LIVEDEFS.json"), "utf8")).defs;
const MIG = readFileSync(join(root, "sql/ws4d_hours_credit_DRAFT.sql"), "utf8");
let RET = readFileSync(join(root, "sql/ws4d_hours_credit_RETEST.sql"), "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
const LIVE_FNS = ["my_department_id()", "my_member_id()", "is_leadership()", "attested_training(uuid,timestamp with time zone,timestamp with time zone)",
  "dept_iso_hours_for(uuid,timestamp with time zone,timestamp with time zone)", "dept_iso_hours(timestamp with time zone,timestamp with time zone)",
  "dept_iso_hours_by_station(timestamp with time zone,timestamp with time zone)", "dept_station_shifts(timestamp with time zone,timestamp with time zone)",
  "my_station_shifts(timestamp with time zone,timestamp with time zone)", "dept_iso_hours_by_month(timestamp with time zone[],timestamp with time zone[])",
  "dept_member_iso_hours_by_month(uuid,timestamp with time zone[],timestamp with time zone[])", "member_check_in(uuid,text,double precision,double precision,double precision)",
  "close_training_presence_on_done()"];

const schema = (meeting = false) => `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id), name text NOT NULL,
  access text[] NOT NULL DEFAULT ARRAY['Member'::text], status text DEFAULT 'Active'::text, email text, joined text, mentor_id uuid);
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid NOT NULL);
CREATE TABLE member_separation (member_id uuid PRIMARY KEY, department_id uuid, terminated_on date NOT NULL);
CREATE TABLE stations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, name text, is_default boolean DEFAULT false);
CREATE TABLE training_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, title text NOT NULL, date date NOT NULL,
  start_time time, duration_min smallint, done boolean NOT NULL DEFAULT false, audience text NOT NULL DEFAULT 'everyone', counts_toward_attendance boolean DEFAULT true,
  is_meeting boolean NOT NULL DEFAULT false, is_offsite boolean NOT NULL DEFAULT false, status text NOT NULL DEFAULT 'scheduled', signin_token text, signin_open boolean DEFAULT false);
CREATE TABLE session_attendance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, session_id uuid NOT NULL REFERENCES training_sessions(id),
  member_id uuid NOT NULL REFERENCES members(id), checked_in_at timestamptz, UNIQUE (session_id, member_id));
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, member_id uuid, verified boolean NOT NULL DEFAULT false,
  source text, kind text NOT NULL DEFAULT 'standby', session_id uuid, checked_in_at timestamptz NOT NULL DEFAULT now(), checked_out_at timestamptz,
  auto_closed boolean NOT NULL DEFAULT false, station_id uuid);
CREATE TABLE supervised_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), member_id uuid, department_id uuid, kind text, voided_at timestamptz, occurred_on date, hours numeric);
-- LABELLED STUBS: readiness_verdict's verdict/cert helpers (untouched by WS-4d; only activity.station_hours changes)
CREATE FUNCTION public.readiness_items(p_dept uuid, p_member uuid) RETURNS TABLE(label text, status text, satisfied boolean, expires_on date) LANGUAGE sql STABLE AS $$ select null::text, null::text, null::boolean, null::date where false $$;
CREATE FUNCTION public.expiration_rows(p_dept uuid, p_member uuid) RETURNS TABLE(source text, label text, expires_on date, bucket text) LANGUAGE sql STABLE AS $$ select null::text, null::text, null::date, null::text where false $$;
CREATE FUNCTION public.readiness_window(p_bucket text, p_exp date) RETURNS text LANGUAGE sql STABLE AS $$ select 'current' $$;
` + LIVE_FNS.map((k) => L[k].def + ";\n").join("") + L["readiness_verdict(uuid,uuid)"].def + `;
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated, service_role', f); END LOOP; END $$;
INSERT INTO departments VALUES ('${A}', 'Alpha (mock)'), ('${B}', 'Bravo (mock)');
INSERT INTO stations (department_id, name, is_default) VALUES ('${A}', 'Station 1', true), ('${B}', 'Station 1', true);
INSERT INTO members (id, department_id, name, email, access) VALUES
  ('a0000000-0000-0000-0000-000000000001', '${A}', 'A DA', 'da@a.test', '{Department Admin}'),
  ('a0000000-0000-0000-0000-000000000002', '${A}', 'A One', 'one@a.test', '{Member}'),
  ('a0000000-0000-0000-0000-000000000003', '${A}', 'A Two', 'two@a.test', '{Member}'),
  ('b0000000-0000-0000-0000-000000000001', '${B}', 'B DA', 'da@b.test', '{Department Admin}'),
  ('b0000000-0000-0000-0000-000000000002', '${B}', 'B One', 'one@b.test', '{Member}');
-- history: standby across the year (8 months back, 2 months, 10 days), unverified, auto-closed, voided, sub-minute
INSERT INTO station_presence (department_id, member_id, verified, kind, checked_in_at, checked_out_at, auto_closed) VALUES
  ('${A}', 'a0000000-0000-0000-0000-000000000002', true,  'standby', now() - interval '240 days', now() - interval '240 days' + interval '5 hours', false),
  ('${A}', 'a0000000-0000-0000-0000-000000000002', true,  'standby', now() - interval '60 days',  now() - interval '60 days' + interval '3 hours', false),
  ('${A}', 'a0000000-0000-0000-0000-000000000002', true,  'standby', now() - interval '10 days',  now() - interval '10 days' + interval '2 hours', false),
  ('${A}', 'a0000000-0000-0000-0000-000000000003', false, 'standby', now() - interval '20 days',  now() - interval '20 days' + interval '4 hours', false),
  ('${A}', 'a0000000-0000-0000-0000-000000000003', true,  'standby', now() - interval '15 days',  now() - interval '15 days' + interval '12 hours', true),
  ('${A}', 'a0000000-0000-0000-0000-000000000003', true,  'standby', now() - interval '5 days',   now() - interval '5 days', false),
  ('${A}', 'a0000000-0000-0000-0000-000000000003', true,  'standby', now() - interval '4 days',   now() - interval '4 days' + interval '20 seconds', false),
  ('${B}', 'b0000000-0000-0000-0000-000000000002', true,  'standby', now() - interval '30 days',  now() - interval '30 days' + interval '6 hours', false);
-- a drill 14 days back: One attended (attested), Two checked in (observed); ${meeting ? "flagged as a MEETING in this world" : "not a meeting"}
INSERT INTO training_sessions (id, department_id, title, date, start_time, duration_min, done, is_meeting) VALUES
  ('a5000000-0000-0000-0000-000000000001', '${A}', 'Drill', ((now() - interval '14 days') at time zone 'America/Chicago')::date, '19:00', 120, true, ${meeting});
INSERT INTO session_attendance (department_id, session_id, member_id) VALUES
  ('${A}', 'a5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000002'),
  ('${A}', 'a5000000-0000-0000-0000-000000000001', 'a0000000-0000-0000-0000-000000000003');
INSERT INTO station_presence (department_id, member_id, verified, kind, session_id, checked_in_at, checked_out_at) VALUES
  ('${A}', 'a0000000-0000-0000-0000-000000000003', true, 'training', 'a5000000-0000-0000-0000-000000000001',
   ((((now() - interval '14 days') at time zone 'America/Chicago')::date + time '19:00') at time zone 'America/Chicago'),
   ((((now() - interval '14 days') at time zone 'America/Chicago')::date + time '20:30') at time zone 'America/Chicago'));
`;
const firstLine = (e) => String(e.message || e).split("\n")[0];
const report = (e) => String(e.message || e).split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—|leader =/.test(l)).join("\n");
async function fresh(meeting = false) { const db = new PGlite(); await db.exec(schema(meeting)); return db; }
const log = (s) => console.log(s);
const redOf = (e) => { const r = report(e); return { fails: r.split("\n").filter((l) => /FAIL/.test(l)), tail: r.split("\n").pop() }; };
const credited = async (db) => (await db.query(`select d.id dept, h.member_id, h.iso_total_hours::text tot, h.training_hours::text tr, h.standby_hours::text sb
  from departments d cross join lateral dept_iso_hours_for(d.id, now() - interval '12 months', now()) h order by 1, 2`)).rows;

// ---- pins
{ const db = await fresh();
  const pins = Object.fromEntries([...MIG.matchAll(/'public\.([^|']+)\|([0-9a-f]{32})'/g)].map((m) => [m[1], m[2]]));
  let ok = 0; const bad = [];
  for (const [sig, md5] of Object.entries(pins)) { const r = await db.query(`select md5(pg_get_functiondef(to_regprocedure($1))) m`, [`public.${sig}`]); if (r.rows[0].m === md5) ok++; else bad.push(sig); }
  log(`pins: ${ok}/${Object.keys(pins).length} mock bodies md5-equal to the live pins (all live bodies) ${bad.length ? JSON.stringify(bad) : ""}`);
  if (bad.length) process.exitCode = 1;
  await db.close(); }

// ---- apply (no meeting), its proof, the RETEST
let NEWMD5 = null, META = null;
{ const db = await fresh();
  const before = await credited(db);
  const sc0 = (await db.query(`select (readiness_verdict('${A}', 'a0000000-0000-0000-0000-000000000003')->'activity'->>'station_hours') s`)).rows[0].s;
  await db.exec(MIG);
  const st = (await db.query(MIG.slice(MIG.indexOf("SELECT jsonb_build_object(")))).rows[0].state;
  NEWMD5 = st.new_md5;
  log("migration: applied (its in-transaction proof passed). state row: " + JSON.stringify(st));
  const after = await credited(db);
  log(`proof, re-checked from outside: ${before.length} member credited rows (12 months); totals byte-identical: ${JSON.stringify(before.map((r) => r.tot)) === JSON.stringify(after.map((r) => r.tot))}; split identical (no meeting): ${JSON.stringify(before) === JSON.stringify(after)}`);
  const sc1 = (await db.query(`select (readiness_verdict('${A}', 'a0000000-0000-0000-0000-000000000003')->'activity'->>'station_hours') s`)).rows[0].s;
  log(`F-3 on a member with unverified + auto-closed + voided + sub-minute shifts and an observed drill: scorecard ${sc0} h (every closed shift) → ${sc1} h (credited)`);
  try { await db.exec(MIG); log("FAIL re-run NOT refused"); process.exitCode = 1; } catch (e) { log("re-run: refused -> " + firstLine(e)); }
  META = Object.fromEntries((await db.query(`select k, coalesce(p.proacl::text, '') || '|' || p.prosecdef || '|' || coalesce(p.proconfig::text, '') m
    from (values ('verdict', 'public.readiness_verdict(uuid,uuid)'), ('isoFor', 'public.dept_iso_hours_for(uuid,timestamp with time zone,timestamp with time zone)'),
      ('byStation', 'public.dept_iso_hours_by_station(timestamp with time zone,timestamp with time zone)'), ('shifts', 'public.dept_station_shifts(timestamp with time zone,timestamp with time zone)'),
      ('myShifts', 'public.my_station_shifts(timestamp with time zone,timestamp with time zone)'), ('byMonth', 'public.dept_iso_hours_by_month(timestamp with time zone[],timestamp with time zone[])')) v(k, s)
    join pg_proc p on p.oid = v.s::regprocedure`)).rows.map((r) => [r.k, r.m]));
  await db.close(); }
// The RETEST's constants: the post-apply md5s (from this dry run — they equal live because the bodies are the live text +
// the listed lines) and the LIVE grants/definer/config (from the live read, not the mock's).
const LIVE_META = { verdict: "readiness_verdict(uuid,uuid)", isoFor: "dept_iso_hours_for(uuid,timestamp with time zone,timestamp with time zone)",
  byStation: "dept_iso_hours_by_station(timestamp with time zone,timestamp with time zone)", shifts: "dept_station_shifts(timestamp with time zone,timestamp with time zone)",
  myShifts: "my_station_shifts(timestamp with time zone,timestamp with time zone)", byMonth: "dept_iso_hours_by_month(timestamp with time zone[],timestamp with time zone[])" };
const liveMeta = Object.fromEntries(Object.entries(LIVE_META).map(([k, s]) => [k, `${L[s].acl || ""}|${L[s].definer}|${L[s].config || ""}`]));
log("RETEST constants — post-apply md5: " + JSON.stringify(NEWMD5));
log("RETEST constants — live grants|definer|config: " + JSON.stringify(liveMeta));
const fill = (sql, meta) => Object.entries(NEWMD5).reduce((s, [k, v]) => s.replace(`__MD5_${k}__`, v), sql).replace("'__META__'", `'${JSON.stringify(meta)}'`);
const RET_MOCK = fill(RET, META);      // the mock's own grants (PGlite has no PG17 MAINTAIN / Supabase ACL) — for the dry run
const RET_LIVE = fill(RET, liveMeta);  // the file that runs live
if (RET.includes("__MD5_")) { (await import("fs")).writeFileSync(join(root, "sql/ws4d_hours_credit_RETEST.sql"), RET_LIVE); log("RETEST: constants written into sql/ws4d_hours_credit_RETEST.sql"); }

{ const db = await fresh(); await db.exec(MIG);
  try { await db.exec(RET_MOCK); log("FAIL RETEST did not end in its report"); } catch (e) { log("RETEST:\n" + report(e)); if (/[1-9]\d* failed/.test(report(e))) process.exitCode = 1; }
  await db.close(); }

// ---- the same, with a FLAGGED MEETING already in the data: totals byte-identical, the split moves
{ const db = await fresh(true);
  const before = await credited(db);
  try { await db.exec(MIG); } catch (e) { log("FAIL with a meeting in the data the migration refused: " + firstLine(e)); process.exitCode = 1; }
  const after = await credited(db);
  const tot = JSON.stringify(before.map((r) => [r.member_id, r.tot])) === JSON.stringify(after.map((r) => [r.member_id, r.tot]));
  const moved = before.filter((r, i) => r.tr !== after[i].tr).map((r, i) => `${r.member_id.slice(-1)}: training ${r.tr}→${after.find((x) => x.member_id === r.member_id).tr}, standby ${r.sb}→${after.find((x) => x.member_id === r.member_id).sb}`);
  log(`with a flagged meeting: applied; totals byte-identical ${tot}; split moved for ${moved.length} member(s): ${moved.join(" · ")}`);
  if (!tot || !moved.length) process.exitCode = 1;
  await db.close(); }

// ---- drift refusals
for (const [label, sql] of [
  ["attested_training drifted", `CREATE OR REPLACE FUNCTION public.attested_training(p_dept uuid, p_from timestamptz, p_to timestamptz) RETURNS TABLE(member_id uuid, session_id uuid, start_at timestamptz, end_at timestamptz, optional boolean) LANGUAGE sql STABLE SET search_path TO 'public' AS $$ select null::uuid, null::uuid, null::timestamptz, null::timestamptz, false where false $$;`],
  ["dept_station_shifts drifted", L["dept_station_shifts(timestamp with time zone,timestamp with time zone)"].def.replace("order by 3 desc;", "order by 3 asc;") + ";"],
  ["is_meeting column missing", `ALTER TABLE training_sessions DROP COLUMN is_meeting;`],
]) { const db = await fresh(); try { await db.exec(sql); } catch (e) { log(`   (drift setup "${label}" failed: ${firstLine(e)})`); }
  try { await db.exec(MIG); log(`FAIL drift "${label}" NOT refused`); process.exitCode = 1; } catch (e) { log(`drift "${label}": refused -> ${firstLine(e)}`); }
  await db.close(); }

// ---- mutations of the migration: refused by its own proof, or caught by the RETEST
const MUT = [
  ["M1 by_station still counts meetings as training", (s) => s.replace(`      (sp.kind = 'training' and not coalesce((select t.is_meeting from public.training_sessions t where t.id = sp.session_id), false)) as is_training,`, `      (sp.kind = 'training')                    as is_training,`), false],
  ["M2 the credited rule DROPS meeting time (a total change)", (s) => s.replace("and not sp.auto_closed and sp.kind in ('standby','training')", "and not sp.auto_closed and sp.kind in ('standby','training') and not coalesce((select t.is_meeting from public.training_sessions t where t.id = sp.session_id), false)"), true],
  ["M3 the month still counts voided shifts", (s) => s.replace("(select count(*) filter (where s.checked_out_at > s.checked_in_at) from public.dept_station_shifts(p_starts[i], p_ends[i]) s)::integer", "(select count(*) from public.dept_station_shifts(p_starts[i], p_ends[i]) s)::integer"), false],
  ["M4 the scorecard reads 6 months, not 12", (s) => s.replace("from public.dept_iso_hours_for(p_dept, now() - interval '12 months', now()) h", "from public.dept_iso_hours_for(p_dept, now() - interval '6 months', now()) h"), false],
  ["M5 a grant changes on the way through", (s) => s.replace("  -- ---------------------------------------------------------------- 2. post-conditions (in-transaction)", "  REVOKE EXECUTE ON FUNCTION public.dept_station_shifts(timestamp with time zone, timestamp with time zone) FROM authenticated;\n  -- ---------------------------------------------------------------- 2. post-conditions (in-transaction)"), false],
  ["M6 attested_training touched", (s) => s.replace("  -- ---------------------------------------------------------------- 2. post-conditions (in-transaction)", "  EXECUTE $x$ CREATE OR REPLACE FUNCTION public.attested_training(p_dept uuid, p_from timestamptz, p_to timestamptz) RETURNS TABLE(member_id uuid, session_id uuid, start_at timestamptz, end_at timestamptz, optional boolean) LANGUAGE sql STABLE SET search_path TO 'public' AS $b$ select null::uuid, null::uuid, null::timestamptz, null::timestamptz, false where false $b$ $x$;\n  -- ---------------------------------------------------------------- 2. post-conditions (in-transaction)"), false],
  ["M7 my_station_shifts keeps 'training' for meetings", (s) => s.replace("           case when sp.kind = 'training' and coalesce((select t.is_meeting from public.training_sessions t where t.id = sp.session_id), false) then 'standby'::text else sp.kind end as kind, sp.verified,\n", "           sp.kind, sp.verified,\n"), false],
];
log("mutations:");
for (const [label, fn, withMeeting] of MUT) {
  const m = fn(MIG); if (m === MIG) { log(`   ${label}: MUTATION DID NOT APPLY (harness bug)`); process.exitCode = 1; continue; }
  const db = await fresh(withMeeting);
  try { await db.exec(m); } catch (e) { log(`   ${label}: migration REFUSED -> ${firstLine(e)}`); await db.close(); continue; }
  try { await db.exec(RET_MOCK); } catch (e) { const { fails, tail } = redOf(e); log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 2).map((l) => "      " + l.trim()).join("\n")}\n      ${tail}`); if (!fails.length) process.exitCode = 1; }
  await db.close();
}

const DRIFT = [
  ["D1 by_station reverted to the live body later", L["dept_iso_hours_by_station(timestamp with time zone,timestamp with time zone)"].def + ";"],
  ["D2 attested_training changed later", `CREATE OR REPLACE FUNCTION public.attested_training(p_dept uuid, p_from timestamptz, p_to timestamptz) RETURNS TABLE(member_id uuid, session_id uuid, start_at timestamptz, end_at timestamptz, optional boolean) LANGUAGE sql STABLE SET search_path TO 'public' AS $$ select null::uuid, null::uuid, null::timestamptz, null::timestamptz, false where false $$;`],
];
log("post-apply drift (RETEST alone must catch):");
for (const [label, sql] of DRIFT) {
  const db = await fresh(); await db.exec(MIG); await db.exec(sql);
  try { await db.exec(RET_MOCK); } catch (e) { const { fails, tail } = redOf(e); log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 2).map((l) => "      " + l.trim()).join("\n")}\n      ${tail}`); if (!fails.length) process.exitCode = 1; }
  await db.close();
}
