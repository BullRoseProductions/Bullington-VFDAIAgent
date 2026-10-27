// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/fe_b_db_dryrun_harness.mjs
// DRY RUN for sql/fe_b_event_needs_DRAFT.sql + its RETEST — NOT the live DB. A mock of the live tables this touches
// (departments, members, recruitment_events, funding_events, action_items, fundraisers, ai_outputs, meetings,
// notifications, notification_prefs, member_active_department, station_presence) with the LIVE policy text and the LIVE
// function bodies from docs/review/fe_b_db_LIVEDEFS.json (gates, identity, action-item lifecycle + trigger, station
// sharing), Supabase-style default grants (anon + authenticated get everything on new tables — what the migration must
// revoke). my_department_rollup is a STUB here (it reads ~20 tables); its pin is re-pointed to the stub's md5 and the
// output says so.
// Runs: pins (mock vs live) -> migration -> state row -> re-run (must refuse) -> RETEST -> drift refusals -> mutations
// (each must turn a RETEST line red, or be refused by the migration's own post-conditions).
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const L = JSON.parse(readFileSync(join(root, "docs/review/fe_b_db_LIVEDEFS.json"), "utf8"));
const MIG0 = readFileSync(join(root, "sql/fe_b_event_needs_DRAFT.sql"), "utf8");
const RET0 = readFileSync(join(root, "sql/fe_b_event_needs_RETEST.sql"), "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
const def = (k) => { const x = L.defs[k]; if (!x) throw new Error("no live def " + k); return x.def + ";\n"; };
const LIVE_FNS = ["my_department_id()", "my_member_id()", "is_leader()", "is_canmanage()", "is_canmanage_ops()", "is_dept_admin()", "is_muted(uuid,text)",
  "complete_action_item(uuid)", "reopen_action_item(uuid)", "cancel_action_item(uuid,text)", "notify_action_item_assigned()",
  "set_fundraiser_step_visible(uuid,boolean)", "get_station_fundraisers()", "set_fundraiser_shared(uuid,boolean)"];
const pol = (t) => L.tables[t].policies.map((p) => {
  const [name, cmd, roles, qual, check] = p.split(" | ");
  return `CREATE POLICY "${name}" ON public.${t} FOR ${cmd} TO ${roles}${qual ? ` USING (${qual})` : ""}${check ? ` WITH CHECK (${check})` : ""};\n`;
}).join("");

const schema = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text NOT NULL);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id), name text NOT NULL, role text,
  access text[] NOT NULL DEFAULT ARRAY['Member'::text], status text DEFAULT 'Active'::text, phone text, joined text, participation integer,
  created_at timestamptz NOT NULL DEFAULT now(), email text, mentor_id uuid, reach_out_member_id uuid, password_set boolean NOT NULL DEFAULT false);
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE notification_prefs (member_id uuid NOT NULL, family text NOT NULL, enabled boolean NOT NULL DEFAULT true, PRIMARY KEY (member_id, family));
CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL, type text NOT NULL, title text NOT NULL,
  body text, subject_ref text, severity text NOT NULL DEFAULT 'info'::text, created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz, pushed_at timestamptz,
  UNIQUE (member_id, type, subject_ref));
CREATE TABLE meetings (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE ai_outputs (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE donation_campaigns (id uuid PRIMARY KEY DEFAULT gen_random_uuid());
CREATE TABLE fundraisers (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE, name text NOT NULL,
  description text, target_date date, goal_amount numeric, status text NOT NULL DEFAULT 'planning'::text, point_person_id uuid, campaign_id uuid, proceeds numeric,
  sort integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now(), created_by uuid, color text, shared_with_station boolean NOT NULL DEFAULT false,
  CONSTRAINT fundraisers_id_dept_key UNIQUE (id, department_id));
CREATE TABLE recruitment_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, title text NOT NULL, date date NOT NULL,
  color text NOT NULL DEFAULT '#1F4E79'::text, notes text, created_at timestamptz NOT NULL DEFAULT now(), start_time time, end_time time, location_label text);
CREATE TABLE funding_events (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, title text NOT NULL, date date NOT NULL,
  color text NOT NULL DEFAULT '#9A6B12'::text, notes text, created_at timestamptz NOT NULL DEFAULT now(), source_label text,
  fundraiser_id uuid REFERENCES fundraisers(id) ON DELETE SET NULL, start_time time, end_time time, location_label text);
CREATE INDEX funding_events_fundraiser_idx ON funding_events (fundraiser_id);
CREATE TABLE action_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  meeting_id uuid REFERENCES meetings(id) ON DELETE SET NULL, text text NOT NULL, owner text, status text DEFAULT 'open'::text,
  created_at timestamptz NOT NULL DEFAULT now(), assigned_to uuid, due_date date, completed_by uuid, completed_at timestamptz, source_label text,
  assignee_name text, cancelled_at timestamptz, cancelled_by uuid, cancel_reason text, source_output_id uuid REFERENCES ai_outputs(id) ON DELETE SET NULL,
  fundraiser_id uuid REFERENCES fundraisers(id) ON DELETE SET NULL, station_visible boolean NOT NULL DEFAULT false);
CREATE INDEX action_items_dept_idx ON action_items (department_id); CREATE INDEX action_items_fundraiser_idx ON action_items (fundraiser_id);
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL,
  checked_in_at timestamptz NOT NULL DEFAULT now(), checked_out_at timestamptz, verified boolean NOT NULL DEFAULT false);
` + LIVE_FNS.map(def).join("") + `
-- STUB (not the live body): only its md5 is pinned; the harness re-pins it to the stub's md5 and says so.
CREATE FUNCTION public.my_department_rollup() RETURNS jsonb LANGUAGE sql STABLE AS $$ select '{}'::jsonb $$;
CREATE TRIGGER trg_action_item_assigned AFTER INSERT OR UPDATE OF assigned_to ON public.action_items FOR EACH ROW WHEN ((new.assigned_to IS NOT NULL)) EXECUTE FUNCTION notify_action_item_assigned();
REVOKE EXECUTE ON FUNCTION public.notify_action_item_assigned() FROM PUBLIC, anon, authenticated;
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon', f); END LOOP; END $$;
ALTER TABLE recruitment_events ENABLE ROW LEVEL SECURITY; ALTER TABLE funding_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE action_items ENABLE ROW LEVEL SECURITY; ALTER TABLE fundraisers ENABLE ROW LEVEL SECURITY; ALTER TABLE station_presence ENABLE ROW LEVEL SECURITY;
` + pol("recruitment_events") + pol("funding_events") + pol("action_items") + pol("fundraisers") + `
INSERT INTO departments (id, name) VALUES ('${A}', 'North Hood (mock)'), ('${B}', 'Indian Harbor (mock)');
INSERT INTO members (department_id, name, email, access) VALUES
  ('${A}', 'A DA', 'da@a.test', '{Department Admin}'), ('${A}', 'A FF', 'ff@a.test', '{Member}'), ('${B}', 'B FF', 'ff@b.test', '{Member}');
INSERT INTO recruitment_events (department_id, title, date) VALUES ('${A}', 'Open house', current_date + 10), ('${B}', 'Booth', current_date + 4);
INSERT INTO funding_events (department_id, title, date) VALUES ('${A}', 'Pancake breakfast', current_date + 20);
INSERT INTO action_items (department_id, text) VALUES ('${A}', 'Existing job');
INSERT INTO station_presence (department_id, member_id, verified) SELECT department_id, id, true FROM members;
`;

const firstLine = (e) => String(e.message || e).split("\n")[0];
const report = (e) => String(e.message || e).split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—|leader =/.test(l)).join("\n");
async function fresh() { const db = new PGlite(); await db.exec(schema); return db; }
const out = [];
const log = (s) => { out.push(s); console.log(s); };

// ---- 1. pins: the mock carries the live bodies verbatim (md5 equal), except the rollup stub
let MIG = MIG0, RET = RET0;
{
  const db = await fresh();
  const pinned = Object.fromEntries([...MIG0.matchAll(/'(public\.[a-z_]+\([^']*\))',\s+'([0-9a-f]{32})'/g)].map((m) => [m[1], m[2]]));
  let same = 0, diff = [];
  for (const [sig, md5] of Object.entries(pinned)) {
    const r = await db.query(`select md5(pg_get_functiondef(to_regprocedure($1))) m`, [sig]);
    if (r.rows[0].m === md5) same++; else diff.push(sig);
  }
  log(`pins: ${same}/${Object.keys(pinned).length} mock bodies md5-equal to the live pins; differing: ${JSON.stringify(diff)}`);
  if (diff.length !== 1 || diff[0] !== "public.my_department_rollup()") throw new Error("unexpected pin drift in the mock: " + diff);
  const stub = (await db.query(`select md5(pg_get_functiondef('public.my_department_rollup()'::regprocedure)) m`)).rows[0].m;
  MIG = MIG0.replaceAll(pinned["public.my_department_rollup()"], stub); RET = RET0.replaceAll(pinned["public.my_department_rollup()"], stub);
  log(`   (my_department_rollup is a stub in the mock: its pin re-pointed ${pinned["public.my_department_rollup()"].slice(0, 8)}… -> ${stub.slice(0, 8)}… for this run only)`);
  await db.close();
}

// ---- 2. migration, state row, re-run, RETEST
{
  const db = await fresh();
  await db.exec(MIG);
  const st = await db.query(MIG.slice(MIG.indexOf("SELECT jsonb_build_object(")));
  log("migration: applied. state row: " + JSON.stringify(st.rows[0].state));
  try { await db.exec(MIG); log("FAIL re-run was NOT refused"); } catch (e) { log("re-run: refused -> " + firstLine(e)); }
  try { await db.exec(RET); log("FAIL RETEST did not end in its report RAISE"); } catch (e) { log("RETEST:\n" + report(e)); }
  await db.close();
}

// ---- 3. pre-flight drift refusals
for (const [label, sql] of [
  ["a gate drifted (is_canmanage_ops adds Board)", `CREATE OR REPLACE FUNCTION public.is_canmanage_ops() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select true $$;`],
  ["an event policy drifted", `DROP POLICY "leaders write recruitment_events" ON public.recruitment_events; CREATE POLICY "leaders write recruitment_events" ON public.recruitment_events FOR INSERT TO authenticated WITH CHECK (true);`],
  ["event_needs already exists", `CREATE TABLE public.event_needs (id uuid);`],
]) {
  const db = await fresh(); await db.exec(sql);
  try { await db.exec(MIG); log(`FAIL drift "${label}" was NOT refused`); } catch (e) { log(`drift "${label}": refused -> ${firstLine(e)}`); }
  await db.close();
}

// ---- 4. mutations: each must be refused by the migration or turn a RETEST line red
const MUT = [
  ["M1 claims get an INSERT grant", (s) => s.replace("GRANT SELECT ON TABLE public.event_need_claims TO authenticated", "GRANT SELECT, INSERT ON TABLE public.event_need_claims TO authenticated")],
  ["M2 anon keeps its default grants on event_needs", (s) => s.replace("REVOKE ALL ON TABLE public.event_needs FROM PUBLIC, anon, authenticated", "REVOKE ALL ON TABLE public.event_needs FROM PUBLIC, authenticated")],
  ["M3 needs write gate widened to is_canmanage() (Board)", (s) => s.replace("WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage_ops() AND created_by", "WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage() AND created_by")],
  ["M4 claim without FOR UPDATE", (s) => s.replace("WHERE id = p_need_id AND department_id = v_dept FOR UPDATE;\n      IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: that need is not in your department.' USING errcode = 'P0002'; END IF;\n      v_date := coalesce((SELECT e.date FROM public.recruitment_events e WHERE e.id = n.recruitment_event_id),\n                         (SELECT e.date FROM public.funding_events e WHERE e.id = n.funding_event_id));\n      IF v_date IS NULL OR v_date < (now() AT TIME ZONE 'America/Chicago')::date THEN\n        RAISE EXCEPTION 'CLOSED: this event has passed — sign-ups are closed.';\n      END IF;\n      IF EXISTS (SELECT 1 FROM public.event_need_claims c WHERE c.need_id = n.id AND c.member_id = v_me)", "WHERE id = p_need_id AND department_id = v_dept;\n      IF NOT FOUND THEN RAISE EXCEPTION 'NOT_FOUND: that need is not in your department.' USING errcode = 'P0002'; END IF;\n      v_date := coalesce((SELECT e.date FROM public.recruitment_events e WHERE e.id = n.recruitment_event_id),\n                         (SELECT e.date FROM public.funding_events e WHERE e.id = n.funding_event_id));\n      IF v_date IS NULL OR v_date < (now() AT TIME ZONE 'America/Chicago')::date THEN\n        RAISE EXCEPTION 'CLOSED: this event has passed — sign-ups are closed.';\n      END IF;\n      IF EXISTS (SELECT 1 FROM public.event_need_claims c WHERE c.need_id = n.id AND c.member_id = v_me)")],
  ["M5 claim lets the last slot overfill (> not >=)", (s) => s.replace("IF v_taken >= n.slots_needed THEN RAISE EXCEPTION 'FULL: every slot for this is taken.'; END IF;\n      INSERT INTO public.event_need_claims (department_id, need_id, member_id, claimed_by) VALUES (v_dept, n.id, v_me, v_me)", "IF v_taken > n.slots_needed THEN RAISE EXCEPTION 'FULL: every slot for this is taken.'; END IF;\n      INSERT INTO public.event_need_claims (department_id, need_id, member_id, claimed_by) VALUES (v_dept, n.id, v_me, v_me)")],
  ["M6 no date window on claim", (s) => s.replace("RAISE EXCEPTION 'CLOSED: this event has passed — sign-ups are closed.';\n      END IF;\n      IF EXISTS (SELECT 1 FROM public.event_need_claims c WHERE c.need_id = n.id AND c.member_id = v_me)", "NULL;\n      END IF;\n      IF EXISTS (SELECT 1 FROM public.event_need_claims c WHERE c.need_id = n.id AND c.member_id = v_me)")],
  ["M7 assign accepts any member (no dept check)", (s) => s.replace("WHERE m.id = p_member_id AND m.department_id = v_dept AND m.status IN ('Active', 'Probationary')", "WHERE m.id = p_member_id")],
  ["M8 assign open to every member (no gate)", (s) => s.replace("IF NOT public.is_canmanage_ops() THEN RAISE EXCEPTION 'NOT_ALLOWED: only a Department Admin or an Officer can assign people.'; END IF;", "")],
  ["M9 plain FK on action_items (no department)", (s) => s.replace("FOREIGN KEY (recruitment_event_id, department_id)\n                    REFERENCES public.recruitment_events (id, department_id) ON DELETE SET NULL (recruitment_event_id)", "FOREIGN KEY (recruitment_event_id)\n                    REFERENCES public.recruitment_events (id) ON DELETE SET NULL")],
  ["M10 one-parent CHECK dropped", (s) => s.replace("CONSTRAINT event_needs_one_parent CHECK (num_nonnulls(recruitment_event_id, funding_event_id) = 1),", "")],
  ["M11 claims readable by leaders only (FE5.2 reverted)", (s) => s.replace(`"dept reads event_need_claims" ON public.event_need_claims FOR SELECT TO authenticated
                USING (department_id = public.my_department_id())`, `"dept reads event_need_claims" ON public.event_need_claims FOR SELECT TO authenticated
                USING (department_id = public.my_department_id() AND public.is_leader())`)],
  ["M12 guard lets slots drop below sign-ups", (s) => s.replace("IF NEW.slots_needed < v_taken THEN", "IF false THEN")],
  ["M13 a pre-existing function is touched", (s) => s.replace("NOTIFY pgrst", "NOTIFY pgrst").replace("  -- =================================================================\n  -- 7. POST-CONDITIONS", "  EXECUTE $x$ CREATE OR REPLACE FUNCTION public.is_canmanage() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $b$ select true $b$ $x$;\n  -- =================================================================\n  -- 7. POST-CONDITIONS")],
  ["M14 remove open to every member", (s) => s.replace("IF NOT public.is_canmanage_ops() THEN RAISE EXCEPTION 'NOT_ALLOWED: only a Department Admin or an Officer can remove someone.'; END IF;", "")],
];
log("mutations:");
for (const [label, fn] of MUT) {
  const m = fn(MIG);
  if (m === MIG) { log(`   ${label}: MUTATION DID NOT APPLY (harness bug)`); process.exitCode = 1; continue; }
  const db = await fresh();
  try { await db.exec(m); } catch (e) { log(`   ${label}: migration REFUSED -> ${firstLine(e)}`); await db.close(); continue; }
  try { await db.exec(RET); } catch (e) {
    const r = report(e); const fails = r.split("\n").filter((l) => /FAIL/.test(l));
    const tail = r.split("\n").filter((l) => /passed, \d+ failed/.test(l)).pop();
    log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 4).map((l) => "      " + l.trim()).join("\n")}\n      ${tail}`);
    if (!fails.length) process.exitCode = 1;
  }
  await db.close();
}
