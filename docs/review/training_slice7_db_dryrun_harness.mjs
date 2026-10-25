// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/training_slice7_db_dryrun_harness.mjs
// DRY RUN for sql/training_slice7_cancel_DRAFT.sql + its RETEST — NOT the live DB. The Slice 6 mock (identity/gate fns,
// membership-window triggers, close-on-done, attested_training + hours readers = LIVE bodies verbatim; live policy text;
// Supabase-style grants), then the APPLIED Slice 6 migration (sql/training_slice6_corrections_2026-10-25.sql), then the
// 8 readers + my_department_rollup + swap_week_dates/move_week as their LIVE bodies (docs/review/training_slice7_db_LIVEDEFS.json).
// Runs: pins (mock vs live) -> migration -> state row -> re-run (must refuse) -> RETEST -> the Slice 6 RETEST again
// (regression) -> pre-flight drift refusals -> mutations (each must turn a RETEST line red, or be refused).
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const L = JSON.parse(readFileSync(join(root, "docs/review/training_slice6_db_LIVEDEFS.json"), "utf8"));
let MIG = readFileSync(join(root, "sql/training_slice7_cancel_DRAFT.sql"), "utf8");
let RET = readFileSync(join(root, "sql/training_slice7_cancel_RETEST.sql"), "utf8");
const RET6 = readFileSync(join(root, "sql/training_slice6_corrections_RETEST.sql"), "utf8");
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


// ---------------------------------------------------------------- Slice 7 additions to the Slice 6 mock
const L7 = JSON.parse(readFileSync(join(root, "docs/review/training_slice7_db_LIVEDEFS.json"), "utf8"));
const def7 = (prefix) => { const k = Object.keys(L7.defs).filter((x) => x.startsWith(prefix + "(")); if (k.length !== 1) throw new Error("no live def " + prefix); return L7.defs[k[0]].def + ";\n"; };
let MIG6 = readFileSync(join(root, "sql/training_slice6_corrections_2026-10-25.sql"), "utf8");   // the APPLIED Slice 6 migration
const extra7 = `
ALTER TABLE departments ADD COLUMN station text, ADD COLUMN city text, ADD COLUMN tagline text, ADD COLUMN voice text,
  ADD COLUMN primary_color text DEFAULT '#B11E2A', ADD COLUMN accent_color text DEFAULT '#1F4E79',
  ADD COLUMN station_lat double precision, ADD COLUMN station_lng double precision, ADD COLUMN station_radius_m integer NOT NULL DEFAULT 150;
CREATE UNIQUE INDEX station_presence_training_once ON station_presence (member_id, session_id) WHERE kind = 'training' AND session_id IS NOT NULL;
CREATE TABLE session_registrations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), session_id uuid NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE,
  member_id uuid NOT NULL, department_id uuid NOT NULL, status text NOT NULL CHECK (status IN ('coming','maybe','not_coming')),
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE (session_id, member_id));
CREATE TABLE drill_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, title text NOT NULL, category text, duration_min integer,
  audience text, content jsonb NOT NULL, status text NOT NULL DEFAULT 'draft', source text NOT NULL DEFAULT 'ai', created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), approved_by uuid, approved_at timestamptz, updated_by uuid, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE session_plans (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, session_id uuid REFERENCES training_sessions(id) ON DELETE SET NULL,
  title text, source text, storage_path text, ai_text text, created_by text, created_at timestamptz NOT NULL DEFAULT now(), drill_plan_id uuid);
-- the rollup's other sources (stubs with the columns it reads)
CREATE TABLE duty_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, done_at timestamptz, done_by uuid);
CREATE TABLE action_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, created_at timestamptz DEFAULT now(), completed_by uuid, completed_at timestamptz, status text);
CREATE TABLE documents (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, created_at timestamptz DEFAULT now(), deleted_at timestamptz, archived_at timestamptz, content_text text);
CREATE TABLE announcements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, created_at timestamptz DEFAULT now());
CREATE TABLE apparatus (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid);
CREATE TABLE certs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, member_id uuid, exp text, no_expiry boolean DEFAULT false, cert_type_id uuid);
CREATE TABLE duties (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, done boolean DEFAULT false, due_date date, assigned_to uuid);
CREATE TABLE funding_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, date date, title text);
CREATE TABLE recruitment_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, date date, title text);
CREATE TABLE content_calendar (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, date date, caption text);
-- STUBS (not live bodies; never reached by these tests)
CREATE FUNCTION public.valid_exp_ym(text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ select false $$;
CREATE FUNCTION public.cert_never_expires(boolean, uuid, uuid) RETURNS boolean LANGUAGE sql STABLE AS $$ select false $$;
CREATE FUNCTION public.is_at_point(double precision, double precision, integer, double precision, double precision, double precision) RETURNS boolean LANGUAGE sql AS $$ select false $$;
CREATE FUNCTION public.is_at_station(uuid, double precision, double precision, double precision) RETURNS boolean LANGUAGE sql AS $$ select false $$;
-- pinned-unchanged readers that aren't otherwise in the mock (stubs; the harness re-pins them and says so)
CREATE FUNCTION public.pa_department_radar() RETURNS TABLE(x int) LANGUAGE sql STABLE AS $$ select 1 $$;
CREATE FUNCTION public.readiness_verdict(p_dept uuid, p_member uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ select '{}'::jsonb $$;
CREATE FUNCTION public.probation_item_states(p_member uuid, p_dept uuid) RETURNS jsonb LANGUAGE sql STABLE AS $$ select '{}'::jsonb $$;
-- LIVE bodies, verbatim
` + ["is_leader", "open_signin", "current_signin_token", "member_check_in", "set_session_location", "set_my_session_registration",
     "attach_drill_plan_to_session", "my_department_rollup", "swap_week_dates", "move_week"].map(def7).join("") + `
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace
             AND p.proname NOT IN ('swap_week_dates', 'move_week') LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f); END LOOP; END $$;   -- live: anon=false except swap/move (anon via PUBLIC, too)
INSERT INTO members (department_id, name, email, access) VALUES ('${B}', 'B TO', 'to@b.test', '{Member}');
INSERT INTO training_officer (department_id, member_id) SELECT '${B}', id FROM members WHERE email = 'to@b.test';
`;
async function base() {
  const db = await fresh();
  // the applied Slice 6 migration, with the two stub readers re-pinned exactly as its own dry run did
  for (const sig of ["public.dept_iso_hours_by_station(timestamptz,timestamptz)", "public.dept_member_iso_hours_by_month(uuid,timestamptz[],timestamptz[])"]) {
    const live = (MIG6.match(new RegExp(`'${sig.replace(/[()[\]]/g, "\\$&")}',\\s*'([0-9a-f]{32})'`)) || [])[1];
    const mock = (await db.query(`select md5(pg_get_functiondef(to_regprocedure($1))) m`, [sig])).rows[0].m;
    if (live) MIG6 = MIG6.replaceAll(live, mock);
  }
  await db.exec(MIG6);
  await db.exec(extra7);
  return db;
}

// ---- pins: which live md5s the mock reproduces verbatim; re-pin only the ones it can't (stubs) ----
const probe = await base();
const pairRe = /'(public\.[a-z_]+\([^']*\))'[^']{0,80}'([0-9a-f]{32})'/g;
const pins = [...new Map([...MIG.matchAll(pairRe), ...RET.matchAll(pairRe)].map((m) => [m[1] + "|" + m[2], [m[1], m[2]]])).values()];
console.log("== PINS (mock md5 vs live pin)");
for (const [sig, live] of pins) {
  const mock = (await probe.query(`select md5(pg_get_functiondef(to_regprocedure($1))) m`, [sig])).rows[0].m;
  const same = mock === live;
  console.log(`   ${same ? "VERBATIM " : "RE-PINNED"}  ${sig}${same ? "" : `  (live ${live} -> mock ${mock})`}`);
  if (!same) { MIG = MIG.replaceAll(live, mock); RET = RET.replaceAll(live, mock); }
}

// ---- 1. fresh apply + state row; 2. re-run refused; 3. RETEST ----
let db = await base();
try { const r = await db.exec(MIG); console.log("\n== MIGRATION (fresh): OK\n   state:", JSON.stringify(r.at(-1).rows[0])); }
catch (e) { console.log("\n== MIGRATION (fresh): ERROR ->", firstLine(e)); process.exit(1); }
try { await db.exec(MIG); console.log("== RE-RUN: applied again (WRONG)"); } catch (e) { console.log("== RE-RUN refused ->", firstLine(e)); }
try { await db.exec(RET); console.log("== RETEST: no report raised (WRONG)"); } catch (e) { console.log("== RETEST\n" + report(e)); }
let RET6p = RET6;
for (const [sig, live] of pins) { const mock = (await probe.query(`select md5(pg_get_functiondef(to_regprocedure($1))) m`, [sig])).rows[0].m; if (mock && mock !== live) RET6p = RET6p.replaceAll(live, mock); }
try { await db.exec(RET6p); console.log("== Slice 6 RETEST: no report (WRONG)"); } catch (e) { console.log("== Slice 6 RETEST after 7-DB (regression check)\n" + report(e).split("\n").filter((l) => /FAIL|passed/.test(l)).join("\n")); }

// ---- 4. pre-flight drift: each must refuse ----
console.log("\n== PRE-FLIGHT DRIFT (each must refuse)");
for (const [label, sql] of [
  ["open_signin body changed", def7("open_signin").replace("You are not allowed to open a sign-in", "You may not open a sign-in")],
  ["attested_training body changed", L.defs["attested_training(p_dept uuid, p_from timestamp with time zone, p_to timestamp with time zone)"].def.replace("interval '90 minutes'", "interval '120 minutes'") + ";"],
  ["audit action CHECK changed", `ALTER TABLE training_session_audit DROP CONSTRAINT training_session_audit_action_check; ALTER TABLE training_session_audit ADD CONSTRAINT training_session_audit_action_check CHECK (action IN ('correct','reopen','finalize','other'));`],
  ["a training_sessions policy changed", `DROP POLICY "leaders write training_sessions" ON training_sessions; CREATE POLICY "leaders write training_sessions" ON training_sessions FOR INSERT TO authenticated WITH CHECK (true);`],
  ["something now calls swap_week_dates", `CREATE FUNCTION public.uses_swap() RETURNS void LANGUAGE plpgsql AS $f$ begin perform public.swap_week_dates(null, null); end $f$;`],
  ["status column already there (double apply)", `ALTER TABLE training_sessions ADD COLUMN status text;`],
]) { const d = await base(); await d.exec(sql); try { await d.exec(MIG); console.log(`   APPLIED (WRONG)  ${label}`); } catch (e) { console.log(`   refused  ${label} -> ${firstLine(e)}`); } }

// ---- 5. mutations: each must turn the RETEST red (or be refused by the migration's post-conditions) ----
console.log("\n== MUTATIONS (each must FAIL the named RETEST line(s), or be refused)");
const sub = (a, b) => { if (!MIG.includes(a)) throw new Error("anchor missing: " + a.slice(0, 90)); return MIG.replace(a, () => b); };
for (const [label, m] of [
  ["M1 self-approve allowed", sub("      if r.initiator_id = v_me then\n        raise exception 'SAME_PERSON:", "      if false then\n        raise exception 'SAME_PERSON:")],
  ["M2 request gate removed", sub("        raise exception 'Only a training officer or a Department Admin can ask to cancel or restore a session.' using errcode = '42501';", "        null;")],
  ["M3 guard ignores status", sub("      if NEW.status is distinct from OLD.status then\n        raise exception 'STATUS_LOCKED: a session is cancelled or restored", "      if false then\n        raise exception 'STATUS_LOCKED: a session is cancelled or restored")],
  ["M4 approve writes no audit row", sub("      insert into public.training_session_audit (department_id, session_id, action, actor_id, actor_name, reason, changes, roster_before, roster_after)\n      values (v_dept, s.id, r.kind,", "      insert into public.training_session_audit (department_id, session_id, action, actor_id, actor_name, reason, changes, roster_before, roster_after)\n      select v_dept, s.id, r.kind,").replace("              v_n, v_n)\n      returning id into v_audit;", "              v_n, v_n where false\n      returning id into v_audit;")],
  ["M5 a second pending allowed", sub("      if exists (select 1 from public.training_session_requests r where r.session_id = s.id and r.state = 'pending') then", "      if false then").replace("  EXECUTE 'CREATE UNIQUE INDEX training_session_requests_one_pending ON public.training_session_requests (session_id) WHERE state = ''pending''';\n", "")],
  ["M6 requests readable by leadership only (D2 reverted)", sub("      USING ((department_id = public.my_department_id()) AND (public.is_leadership() OR public.is_training_manager()))", "      USING ((department_id = public.my_department_id()) AND public.is_leadership())")],
  ["M7 expiry raised (rolls itself back)", sub("        update public.training_session_requests set state = 'expired', decided_at = now() where id = r.id;\n        return jsonb_build_object('request_id', r.id, 'state', 'expired');", "        update public.training_session_requests set state = 'expired', decided_at = now() where id = r.id;\n        raise exception 'EXPIRED';")],
  ["M8 initiator may reject", sub("      if r.initiator_id = v_me then raise exception 'USE_WITHDRAW: you asked — withdraw it instead.'; end if;", "")],
  ["M9 signatures column-selectable", sub("decision_reason, state, created_at, decided_at) ON TABLE public.training_session_requests TO authenticated", "decision_reason, state, created_at, decided_at, initiator_signature) ON TABLE public.training_session_requests TO authenticated")],
  ["M10 open_signin left unrepointed", sub("  EXECUTE $r1$", "  EXECUTE 'select 1'; PERFORM $r1$").replace(/\$r1\$;\n/, "$r1$::text;\n")],
  ["M11 approve skips the cancel's QR close (D5)", sub("             signin_open = case when v_new = 'cancelled' then false else signin_open end,      -- D5", "             signin_open = signin_open,")],
  ["M12 typed name accepted as a signature", sub("      if p_signature is null or p_signature not like 'data:image/png;base64,%' or length(p_signature) > 204800 then\n        raise exception 'BAD_SIGNATURE: draw your signature (a PNG, up to 200 KB).';\n      end if;\n      select * into s", "      if p_signature is null then\n        raise exception 'BAD_SIGNATURE: draw your signature (a PNG, up to 200 KB).';\n      end if;\n      select * into s")],
  ["M13 swap_week_dates kept", sub("  EXECUTE 'DROP FUNCTION public.swap_week_dates(uuid, uuid)';\n", "")],
]) {
  const d = await base();
  try { await d.exec(m); } catch (e) { console.log(`   ${label}: migration REFUSED -> ${firstLine(e)}`); continue; }
  try { await d.exec(RET); } catch (e) { const fails = report(e).split("\n").filter((l) => /FAIL|passed/.test(l)); console.log(`   ${label}:\n      ` + [...new Set(fails)].join("\n      ")); }
}
process.exit(0);
