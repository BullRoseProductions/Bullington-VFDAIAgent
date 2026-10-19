import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const R = "/Users/ashleabullington/projects/Bullington-VFDAIAgent/sql/";
const src = readFileSync(new URL("./prob.mjs", import.meta.url), "utf8");
const head = src.slice(0, src.indexOf("let d = await db0();")).replaceAll("new URL(\"./rs.mjs\", import.meta.url)", JSON.stringify(new URL("./rs.mjs", import.meta.url).pathname));
const { db0, show, brief } = new Function("PGlite", "readFileSync", head.replace(/^import .*$/gm, "") + "\nreturn { db0, show, brief };")(PGlite, readFileSync);
const prob = readFileSync(R + "probation_2026-10-18.sql", "utf8"), tog = readFileSync(R + "probation_toggle_2026-10-18.sql", "utf8");
const mig = readFileSync(R + "qualifications_2026-10-18.sql", "utf8"), ret = readFileSync(R + "qualifications_RETEST.sql", "utf8");
const probRet = readFileSync(R + "probation_RETEST.sql", "utf8"), togRet = readFileSync(R + "probation_toggle_RETEST.sql", "utf8");
const extra = `
ALTER TABLE departments ADD COLUMN week_start_day int DEFAULT 0;
INSERT INTO departments (id, name) VALUES ('00000000-0000-0000-0000-0000000000d2','Granbury Fire Station');
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read own department" ON departments FOR SELECT TO authenticated USING (id = my_department_id());
CREATE POLICY "dept admins update department" ON departments FOR UPDATE TO authenticated USING (is_dept_admin() AND id = my_department_id()) WITH CHECK (is_dept_admin() AND id = my_department_id());
ALTER TABLE apparatus ADD COLUMN deleted_at timestamptz;
INSERT INTO apparatus (department_id, name) SELECT id, n FROM departments, unnest(array['Engine 1','Tender 2']) n WHERE name <> 'Granbury Fire Station';
UPDATE apparatus SET deleted_at = now() WHERE name = 'Tender 2' AND department_id = '00000000-0000-0000-0000-00000000000b';
INSERT INTO members (department_id,email,name,access,status) VALUES ('00000000-0000-0000-0000-00000000000a','gone2@a','A Gone2','{Member}','Active');
INSERT INTO member_separation VALUES ((SELECT id FROM members WHERE email='gone2@a'), '00000000-0000-0000-0000-00000000000a', '2026-02-01');
`;
async function base() { const d = await db0(); await d.exec(extra); await d.exec(prob); await d.exec(tog); return d; }
const qual = readFileSync(R + "qualifications_2026-10-18.sql", "utf8"), expm = readFileSync(R + "expirations_2026-10-18.sql", "utf8");
const smig = readFileSync(R + "scorecard_DRAFT.sql", "utf8"), sret = readFileSync(R + "scorecard_RETEST.sql", "utf8");
const extra2 = `
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL, kind text, checked_in_at timestamptz NOT NULL, checked_out_at timestamptz, auto_closed boolean DEFAULT false);
CREATE TABLE IF NOT EXISTS cert_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL, name text NOT NULL, exp text, status text NOT NULL DEFAULT 'pending');
`;
async function sbase() { const d = await base(); await d.exec(qual); await d.exec("ALTER TABLE apparatus ADD PRIMARY KEY (id); ALTER TABLE apparatus ADD COLUMN IF NOT EXISTS type text, ADD COLUMN IF NOT EXISTS status text, ADD COLUMN IF NOT EXISTS in_service boolean DEFAULT true, ADD COLUMN IF NOT EXISTS note text;"); await d.exec(expm); await d.exec(extra2); return d; }
let d = await sbase();
console.log("state:", JSON.stringify((await d.exec(smig)).at(-1).rows));
try { await d.exec(smig); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
try { await d.exec(sret); } catch (e) { console.log(show(e)); }
const sub = (a, b) => { if (!smig.includes(a)) throw new Error("anchor missing: " + a.slice(0, 70)); return smig.replace(a, () => b); };
for (const [l, m] of [
  ["(a) a plain member through the config gate", sub("  if v_dept is null or not coalesce(public.is_dept_admin(), false) then\n    raise exception 'Only a Department Admin can set the readiness standard.';", "  if v_dept is null or (false and not coalesce(public.is_dept_admin(), false)) then\n    raise exception 'Only a Department Admin can set the readiness standard.';")],
  ["(b) a member reads another member's scorecard", sub("  if p_member_id is distinct from v_me and not coalesce(public.is_canmanage(), false) then", "  if false and p_member_id is distinct from v_me and not coalesce(public.is_canmanage(), false) then")],
  ["(c) a member opens the packet", sub("  if v_dept is null or not coalesce(public.is_canmanage(), false) then\n    raise exception 'Only department leadership can open the readiness packet.';", "  if v_dept is null then\n    raise exception 'Only department leadership can open the readiness packet.';").replace("     OR position('is_canmanage()' in pg_get_functiondef('public.dept_readiness_packet()'::regprocedure)) = 0\n", "")],
  ["(d) another department's qualification as a ref", sub("    if v_ref is null or not exists (select 1 from public.qualification_types where id = v_ref and department_id = v_dept) then", "    if v_ref is null or not exists (select 1 from public.qualification_types where id = v_ref) then")],
  ["(e) an unconfigured department scored ready", sub("    'state', case when (select count(*) from it) = 0 then 'not_set'", "    'state', case when (select count(*) from it) = 0 then 'ready'")],
  ["(f1) an expired / undated credential counted satisfied", sub("              else bc.w = 'current' end, false),", "              else bc.w is not null end, false),")],
  ["(f2) expiring-soon counted current (30-day window)", sub("         - (extract(year from (now() at time zone 'America/Chicago'))::int * 12 + extract(month from (now() at time zone 'America/Chicago'))::int) <= 3", "         - (extract(year from (now() at time zone 'America/Chicago'))::int * 12 + extract(month from (now() at time zone 'America/Chicago'))::int) <= 0")],
  ["(g) a cert kind allowed (table + RPC)", sub("    kind          text NOT NULL CHECK (kind IN ('credential_license', 'credential_med_card', 'credential_fit_test', 'qualification_type', 'document')),", "    kind          text NOT NULL CHECK (kind IN ('credential_license', 'credential_med_card', 'credential_fit_test', 'qualification_type', 'document', 'cert')),").replace("  if p_kind is null or p_kind not in ('credential_license', 'credential_med_card', 'credential_fit_test', 'qualification_type', 'document') then", "  if p_kind is null or p_kind not in ('credential_license', 'credential_med_card', 'credential_fit_test', 'qualification_type', 'document', 'cert') then").replace("  IF position('cert''' in", "  IF false AND position('cert''' in")],
  ["(h) satisfied left nullable (the bool_and hole)", sub("         coalesce(case when r.kind = 'qualification_type' then coalesce(qt.active, false) and q.status = 'qualified'", "         (case when r.kind = 'qualification_type' then qt.active and q.status = 'qualified'").replace("              else bc.w = 'current' end, false),", "              else bc.w = 'current' end),")],
  ["(i) packet counts separated members", sub("     and not exists (select 1 from public.member_separation s where s.member_id = m.id);\n  select coalesce(jsonb_agg(to_jsonb(r))", ";\n  select coalesce(jsonb_agg(to_jsonb(r))").replace("     OR position('member_separation' in pg_get_functiondef('public.dept_readiness_packet()'::regprocedure)) = 0 THEN", " THEN")],
  ["(j) an unsigned document counted satisfied", sub("                                            and (not public.rs_member_in_audience(p_member, ds.required_roles) or ack.ok)", "                                            and true")],
  ["(k) a cert moves the verdict", sub("    'state', case when (select count(*) from it) = 0 then 'not_set'\n                  when (select bool_and(it.satisfied) from it) then 'ready' else 'not_ready' end,", "    'state', case when (select count(*) from it) = 0 then 'not_set'\n                  when (select bool_and(it.satisfied) from it) and not exists (select 1 from public.expiration_rows(p_dept, p_member) e where e.source = 'cert' and e.bucket = 'expired') then 'ready' else 'not_ready' end,")],
  ["(l) internal verdict left callable", sub("    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, public', v_t);", "    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', v_t);")],
]) { const x = await sbase(); try { await x.exec(m); try { await x.exec(sret); } catch (e) { console.log(l, "->", brief(e)); } } catch (e) { console.log(l, "-> migration", e.message.split("\n")[0]); } }
