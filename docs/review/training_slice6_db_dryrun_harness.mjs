// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/training_slice6_db_dryrun_harness.mjs
// DRY RUN for sql/training_slice6_corrections_DRAFT.sql + its RETEST — NOT the live DB. A 2-department PGlite mock whose
// identity/gate functions, membership-window triggers, close-on-done trigger, attested_training and the hours readers are
// the LIVE pg_get_functiondef bodies verbatim (docs/review/training_slice6_db_LIVEDEFS.json, read 2026-10-25), with the
// live policy text on training_sessions / session_attendance / training_plans and Supabase-style default grants.
// Runs: migration (fresh) -> state row -> re-run (must refuse) -> RETEST -> pin-drift refusals -> mutations (each must
// turn a RETEST line red, or be refused by the migration's own post-conditions).
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const L = JSON.parse(readFileSync(join(root, "docs/review/training_slice6_db_LIVEDEFS.json"), "utf8"));
let MIG = readFileSync(join(root, "sql/training_slice6_corrections_DRAFT.sql"), "utf8");
let RET = readFileSync(join(root, "sql/training_slice6_corrections_RETEST.sql"), "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
const def = (k) => { const x = L.defs[k]; if (!x) throw new Error("no live def " + k); return x.def + ";\n"; };

const schema = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id), name text NOT NULL,
  access text[] NOT NULL DEFAULT ARRAY['Member'::text], status text DEFAULT 'Active'::text, email text, joined text,
  password_set boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE member_private (member_id uuid PRIMARY KEY REFERENCES members(id), department_id uuid NOT NULL, birthday date, address text, joined_date date,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE member_separation (member_id uuid PRIMARY KEY REFERENCES members(id), department_id uuid NOT NULL, terminated_on date NOT NULL, set_by_member uuid,
  set_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE training_officer (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL, assigned_by uuid,
  assigned_by_name text, assigned_at timestamptz NOT NULL DEFAULT now(), removed_at timestamptz, removed_by uuid, removed_by_name text);
CREATE TABLE training_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  name text NOT NULL, cadence text NOT NULL DEFAULT 'Monthly'::text, last_iso date, created_at timestamptz NOT NULL DEFAULT now(),
  color text NOT NULL DEFAULT '#54506B'::text, starts_on date);
CREATE TABLE training_sessions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  plan_id uuid REFERENCES training_plans(id) ON DELETE SET NULL, title text NOT NULL, date date NOT NULL, done boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(), signin_token text, signin_open boolean NOT NULL DEFAULT false, series_id uuid,
  audience text NOT NULL DEFAULT 'everyone'::text, start_time time, counts_toward_attendance boolean NOT NULL DEFAULT true,
  location_lat double precision, location_lng double precision, location_radius_m integer, location_label text,
  is_offsite boolean NOT NULL DEFAULT false, duration_min smallint, is_meeting boolean NOT NULL DEFAULT false,
  CONSTRAINT training_sessions_audience_check CHECK (audience = ANY (ARRAY['everyone'::text, 'leadership'::text, 'board'::text])),
  CONSTRAINT training_sessions_location_pair CHECK ((location_lat IS NULL) = (location_lng IS NULL)),
  CONSTRAINT training_sessions_coords_require_offsite CHECK (is_offsite OR ((location_lat IS NULL) AND (location_lng IS NULL))),
  CONSTRAINT training_sessions_duration_range CHECK ((duration_min IS NULL) OR ((duration_min >= 1) AND (duration_min <= 1440))));
CREATE TABLE session_attendance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  session_id uuid NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE, member_id uuid NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  checked_in_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (session_id, member_id));
CREATE TABLE stations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, name text, is_default boolean DEFAULT false);
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL,
  checked_in_at timestamptz NOT NULL DEFAULT now(), checked_out_at timestamptz, verified boolean NOT NULL DEFAULT false,
  source text NOT NULL DEFAULT 'geo'::text, kind text NOT NULL DEFAULT 'standby'::text, session_id uuid, created_at timestamptz NOT NULL DEFAULT now(),
  auto_closed boolean NOT NULL DEFAULT false, offsite_label text, location_confirmed boolean, approved_at timestamptz, approved_by uuid,
  station_id uuid, fence_exit_at timestamptz,
  CONSTRAINT station_presence_kind_check CHECK (kind = ANY (ARRAY['training'::text, 'standby'::text, 'incident'::text, 'offsite'::text])),
  CONSTRAINT station_presence_source_check CHECK (source = ANY ('{geo,gps_geofence}'::text[])));
` + ["my_department_id()", "my_member_id()", "is_training_officer()", "is_training_manager()", "is_leadership()", "is_dept_admin()",
  "membership_window_allows(p_member uuid, p_date date)", "tg_session_attendance_membership_window()", "tg_training_session_date_membership_window()",
  "close_training_presence_on_done()", "close_training_presence_on_session_delete()",
  "attested_training(p_dept uuid, p_from timestamp with time zone, p_to timestamp with time zone)"].map(def).join("")
  + L.readers.dept_iso_hours_for + ";\n" + L.readers.dept_iso_hours + ";\n" + L.readers.dept_station_shifts + ";\n" + `
-- STUBS (not live bodies): only their md5 is pinned; the harness re-pins them to the stub's md5 and says so.
CREATE FUNCTION public.dept_iso_hours_by_station(p_from timestamptz, p_to timestamptz) RETURNS TABLE(x int) LANGUAGE sql STABLE AS $$ select 1 $$;
CREATE FUNCTION public.dept_member_iso_hours_by_month(p_member_id uuid, p_starts timestamptz[], p_ends timestamptz[]) RETURNS TABLE(x int) LANGUAGE sql STABLE AS $$ select 1 $$;
REVOKE EXECUTE ON FUNCTION public.attested_training(uuid, timestamptz, timestamptz) FROM PUBLIC, authenticated, anon;
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname <> 'attested_training' LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f); END LOOP; END $$;
CREATE TRIGGER session_attendance_membership_window BEFORE INSERT OR UPDATE OF session_id, member_id ON public.session_attendance FOR EACH ROW EXECUTE FUNCTION tg_session_attendance_membership_window();
CREATE TRIGGER training_session_date_membership_window BEFORE UPDATE OF date ON public.training_sessions FOR EACH ROW EXECUTE FUNCTION tg_training_session_date_membership_window();
CREATE TRIGGER trg_close_training_presence_on_delete BEFORE DELETE ON public.training_sessions FOR EACH ROW EXECUTE FUNCTION close_training_presence_on_session_delete();
CREATE TRIGGER trg_close_training_presence_on_done AFTER UPDATE ON public.training_sessions FOR EACH ROW WHEN (((old.done IS DISTINCT FROM new.done) AND (new.done = true))) EXECUTE FUNCTION close_training_presence_on_done();
ALTER TABLE training_sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "admins delete training_sessions" ON training_sessions FOR DELETE TO authenticated USING ((department_id = my_department_id()) AND is_dept_admin() AND (done IS NOT TRUE) AND (NOT (EXISTS ( SELECT 1 FROM session_attendance sa WHERE (sa.session_id = training_sessions.id)))));
CREATE POLICY "leaders write training_sessions" ON training_sessions FOR INSERT TO authenticated WITH CHECK ((department_id = my_department_id()) AND is_training_manager());
CREATE POLICY "authenticated can read training_sessions" ON training_sessions FOR SELECT TO public USING (department_id = my_department_id());
CREATE POLICY "leaders update training_sessions" ON training_sessions FOR UPDATE TO authenticated USING ((department_id = my_department_id()) AND is_training_manager()) WITH CHECK ((department_id = my_department_id()) AND is_training_manager());
ALTER TABLE session_attendance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "authenticated can read session_attendance" ON session_attendance FOR SELECT TO authenticated USING (department_id = my_department_id());
CREATE POLICY "leaders delete session_attendance" ON session_attendance FOR DELETE TO authenticated USING ((department_id = my_department_id()) AND is_training_manager() AND (EXISTS ( SELECT 1 FROM training_sessions ts WHERE ((ts.id = session_attendance.session_id) AND (ts.department_id = my_department_id()) AND (ts.done = false)))));
CREATE POLICY "leaders insert session_attendance" ON session_attendance FOR INSERT TO authenticated WITH CHECK ((department_id = my_department_id()) AND is_training_manager() AND (EXISTS ( SELECT 1 FROM training_sessions ts WHERE ((ts.id = session_attendance.session_id) AND (ts.department_id = my_department_id()) AND (ts.done = false)))));
ALTER TABLE training_plans ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read training_plans" ON training_plans FOR SELECT TO authenticated USING (department_id = my_department_id());
CREATE POLICY "leaders update training_plans" ON training_plans FOR UPDATE TO authenticated USING ((department_id = my_department_id()) AND is_training_manager()) WITH CHECK ((department_id = my_department_id()) AND is_training_manager());
ALTER TABLE station_presence ENABLE ROW LEVEL SECURITY;   -- live: RLS on, NO policies
ALTER TABLE members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read own row" ON members FOR SELECT TO authenticated USING (email = auth.email());
INSERT INTO departments (id, name) VALUES ('${A}', 'North Hood (mock)'), ('${B}', 'Indian Harbor (mock)');
INSERT INTO members (department_id, name, email, access) VALUES
  ('${A}', 'A DA', 'da@a.test', '{Department Admin}'), ('${A}', 'A TO', 'to@a.test', '{Member}'),
  ('${A}', 'A Officer', 'off@a.test', '{Officer}'), ('${A}', 'A FF', 'ff@a.test', '{Member}'),
  ('${B}', 'B DA', 'da@b.test', '{Department Admin}'), ('${B}', 'B FF', 'ff@b.test', '{Member}');
INSERT INTO training_officer (department_id, member_id) SELECT '${A}', id FROM members WHERE email = 'to@a.test';
INSERT INTO training_sessions (department_id, title, date, start_time, duration_min, done) VALUES
  ('${A}', 'Real drill A', current_date - 5, '19:00', 90, true), ('${B}', 'Real drill B', current_date - 6, '19:00', 120, true);
INSERT INTO session_attendance (department_id, session_id, member_id) SELECT '${A}', ts.id, m.id FROM training_sessions ts, members m WHERE ts.title = 'Real drill A' AND m.email = 'ff@a.test';
INSERT INTO station_presence (department_id, member_id, kind, source, verified, checked_in_at, checked_out_at)
  SELECT department_id, id, 'standby', 'gps_geofence', true, now() - interval '3 days', now() - interval '3 days' + interval '2 hours' FROM members;
`;

const firstLine = (e) => String(e.message || e).split("\n")[0];
const report = (e) => String(e.message || e).split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—|acting as/.test(l)).join("\n");
async function fresh() { const db = new PGlite(); await db.exec(schema); return db; }

// ---- pins: which live md5s the mock reproduces verbatim; re-pin only the ones it can't (the two stubs) ----
const probe = await fresh();
const pinRe = /'(public\.[a-z_]+\([^']*\))',\s*'([0-9a-f]{32})'/g;
const pins = [...new Set([...MIG.matchAll(pinRe), ...RET.matchAll(pinRe)].map((m) => m[1] + "|" + m[2]))].map((s) => s.split("|"));
console.log("== PINS (mock md5 vs live pin)");
for (const [sig, live] of pins) {
  const r = await probe.query(`select md5(pg_get_functiondef(to_regprocedure($1))) m`, [sig]);
  const mock = r.rows[0].m;
  const same = mock === live;
  console.log(`   ${same ? "VERBATIM" : "RE-PINNED"}  ${sig}${same ? "" : `  (live ${live} -> mock ${mock})`}`);
  if (!same) { MIG = MIG.replaceAll(live, mock); RET = RET.replaceAll(live, mock); }
}
const pol = await probe.query(`select qual, with_check from pg_policies where tablename = 'training_sessions' and policyname = 'leaders update training_sessions'`);
console.log("   policy text as deparsed by the mock:", JSON.stringify(pol.rows[0]));

// ---- 1. fresh apply + state row; 2. re-run refused; 3. RETEST ----
let db = await fresh();
try { const r = await db.exec(MIG); console.log("\n== MIGRATION (fresh): OK\n   state:", JSON.stringify(r.at(-1).rows[0])); }
catch (e) { console.log("\n== MIGRATION (fresh): ERROR ->", firstLine(e)); process.exit(1); }
try { await db.exec(MIG); console.log("== RE-RUN: applied again (WRONG)"); } catch (e) { console.log("== RE-RUN refused ->", firstLine(e)); }
try { await db.exec(RET); console.log("== RETEST: no report raised (WRONG)"); } catch (e) { console.log("== RETEST\n" + report(e)); }

// ---- 4. pin drift: each must make the migration refuse ----
console.log("\n== PRE-FLIGHT DRIFT (each must refuse)");
for (const [label, sql] of [
  ["is_training_manager body changed", `CREATE OR REPLACE FUNCTION public.is_training_manager() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$ select true $f$;`],
  ["attested_training body changed", L.defs["attested_training(p_dept uuid, p_from timestamp with time zone, p_to timestamp with time zone)"].def.replace("interval '90 minutes'", "interval '120 minutes'") + ";"],
  ["UPDATE policy text changed", `DROP POLICY "leaders update training_sessions" ON training_sessions; CREATE POLICY "leaders update training_sessions" ON training_sessions FOR UPDATE TO authenticated USING (department_id = my_department_id()) WITH CHECK (department_id = my_department_id());`],
  ["a second UPDATE policy", `CREATE POLICY "extra update" ON training_sessions FOR UPDATE TO authenticated USING (true);`],
  ["station_presence gained a SELECT policy (R2 premise)", `CREATE POLICY "read presence" ON station_presence FOR SELECT TO authenticated USING (department_id = my_department_id());`],
  ["an extra trigger on training_sessions", `CREATE FUNCTION public.tg_x() RETURNS trigger LANGUAGE plpgsql AS $f$ begin return NEW; end $f$; CREATE TRIGGER zz BEFORE UPDATE ON training_sessions FOR EACH ROW EXECUTE FUNCTION tg_x();`],
]) { const d = await fresh(); await d.exec(sql); try { await d.exec(MIG); console.log(`   APPLIED (WRONG)  ${label}`); } catch (e) { console.log(`   refused  ${label} -> ${firstLine(e)}`); } }

// ---- 5. mutations: each must turn the RETEST red (or be refused by the migration's post-conditions) ----
console.log("\n== MUTATIONS (each must FAIL the named RETEST line(s), or be refused)");
const sub = (a, b, all = false) => { if (!MIG.includes(a)) throw new Error("anchor missing: " + a.slice(0, 80)); return all ? MIG.replaceAll(a, b) : MIG.replace(a, () => b); };
for (const [label, m] of [
  ["M1 correct: gate removed", sub("        raise exception 'Only a training officer or a Department Admin can correct a session.' using errcode = '42501';", "        null;")],
  ["M2 reason: 1 char is enough", sub("      if length(v_reason) < 10 then raise exception 'REASON_REQUIRED: say why (at least 10 characters).'; end if;\n      if jsonb_typeof", "      if length(v_reason) < 1 then raise exception 'REASON_REQUIRED: say why (at least 10 characters).'; end if;\n      if jsonb_typeof")],
  ["M3 C1 hybrid dropped (TO may correct any age)", sub("      if least(s.\"date\", n_date) < v_today - 14", "      if false and least(s.\"date\", n_date) < v_today - 14")],
  ["M4 guard ignores attendance (finalized only)", sub("      if not (OLD.done is true or exists (select 1 from public.session_attendance sa where sa.session_id = OLD.id)) then", "      if not (OLD.done is true) then")],
  ["M5 correction flag never reset", sub("      perform set_config('b4c.session_correction', '', true);\n      select count(*) into v_after", "      select count(*) into v_after")],
  ["M6 audit append-only trigger removed", sub("  EXECUTE $ddl$\n    CREATE TRIGGER training_session_audit_append_only", "  EXECUTE $ddl$\n    CREATE TRIGGER training_session_audit_append_only_off AFTER INSERT ON public.training_session_audit FOR EACH STATEMENT EXECUTE FUNCTION public.tg_training_session_audit_append_only() $ddl$; EXECUTE 'DROP TRIGGER training_session_audit_append_only_off ON public.training_session_audit'; EXECUTE $ddl$ SELECT 1 /* removed:").replace("FOR EACH ROW EXECUTE FUNCTION public.tg_training_session_audit_append_only()\n  $ddl$;", "*/\n  $ddl$;")],
  ["M7 finalize ignores the roll since a Reopen", sub("      if v_last = 'reopen' then", "      if false then")],
  ["M8 presence window read in UTC", sub("      v_start := (s.\"date\" + s.start_time) at time zone 'America/Chicago';", "      v_start := (s.\"date\" + s.start_time)::timestamptz;")],
  ["M9 finalize stamps today, not the drill's date", sub("set last_iso = greatest(coalesce(last_iso, s.\"date\"), s.\"date\")", "set last_iso = (now() at time zone 'America/Chicago')::date")],
  ["M10 correct writes no audit row", sub("      values (v_dept, s.id, 'correct', v_me,", "      select v_dept, s.id, 'correct', v_me,").replace("              v_reason, v_diff, v_add, v_rem, v_before, v_after)\n      returning id into v_audit;", "              v_reason, v_diff, v_add, v_rem, v_before, v_after where false\n      returning id into v_audit;")],
  ["M11 policy keeps no done term", sub("      USING ((department_id = my_department_id()) AND is_training_manager() AND (done IS NOT TRUE))", "      USING ((department_id = my_department_id()) AND is_training_manager())")],
  ["M12 audit INSERT granted to authenticated", sub("  EXECUTE 'GRANT SELECT ON TABLE public.training_session_audit TO authenticated';", "  EXECUTE 'GRANT SELECT, INSERT ON TABLE public.training_session_audit TO authenticated';")],
  ["M13 DA-only branch admits Project Admin (is_dept_admin)", sub("         and not exists (select 1 from public.members m where m.id = v_me and m.department_id = v_dept\n                           and m.status in ('Active', 'Probationary') and m.access && array['Department Admin']::text[]) then\n        raise exception 'DA_ONLY: correcting", "         and not public.is_dept_admin() and not exists (select 1 from public.members m where m.id = v_me and m.department_id = v_dept\n                           and m.status in ('Active', 'Probationary') and m.access && array['Department Admin']::text[]) then\n        raise exception 'DA_ONLY: correcting")],
]) {
  const d = await fresh();
  try { await d.exec(m); } catch (e) { console.log(`   ${label}: migration REFUSED -> ${firstLine(e)}`); continue; }
  try { await d.exec(RET); } catch (e) { const fails = report(e).split("\n").filter((l) => /FAIL|passed/.test(l)); console.log(`   ${label}:\n      ` + fails.join("\n      ")); }
}
process.exit(0);
