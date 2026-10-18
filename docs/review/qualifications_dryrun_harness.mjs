import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const R = "/Users/ashleabullington/projects/Bullington-VFDAIAgent/sql/";
const src = readFileSync(new URL("./prob.mjs", import.meta.url), "utf8");
const head = src.slice(0, src.indexOf("let d = await db0();")).replaceAll("new URL(\"./rs.mjs\", import.meta.url)", JSON.stringify(new URL("./rs.mjs", import.meta.url).pathname));
const { db0, show, brief } = new Function("PGlite", "readFileSync", head.replace(/^import .*$/gm, "") + "\nreturn { db0, show, brief };")(PGlite, readFileSync);
const prob = readFileSync(R + "probation_2026-10-18.sql", "utf8"), tog = readFileSync(R + "probation_toggle_2026-10-18.sql", "utf8");
const mig = readFileSync(R + "qualifications_DRAFT.sql", "utf8"), ret = readFileSync(R + "qualifications_RETEST.sql", "utf8");
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
let d = await base();
console.log("migration state:", JSON.stringify((await d.exec(mig)).at(-1).rows));
try { await d.exec(mig); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
try { await d.exec(ret); } catch (e) { console.log(show(e)); }
try { await d.exec(probRet); } catch (e) { console.log("probation RETEST still:", brief(e)); }
try { await d.exec(togRet); } catch (e) { console.log("toggle RETEST still:", brief(e)); }
const sub = (a, b) => { if (!mig.includes(a)) throw new Error("anchor missing: " + a.slice(0, 70)); return mig.replace(a, b); };
for (const [l, m] of [
  ["MA sign gate removed", sub("    raise exception 'Only a Department Admin or Officer can sign off a qualification.';", "    null;")],
  ["MB sign not-self removed (+post)", sub("  if p_member_id = v_me then raise exception 'You can''t sign off your own qualification — another officer does.'; end if;\n", "").replace("  IF position('p_member_id = v_me' in pg_get_functiondef('public.sign_qualification(uuid,uuid,text)'::regprocedure)) = 0\n     OR", "  IF")],
  ["MC log: supervisor may be the member (+post)", sub("  if v_sup = p_member_id then raise exception 'A member can''t supervise themself.'; end if;\n  if not exists (select 1 from public.members where id = v_sup and department_id = v_dept) then\n    raise exception 'The supervisor must be a member of your department.';\n  end if;\n  select * into v_type", "  select * into v_type").replace("\n     OR position('v_sup = p_member_id' in pg_get_functiondef('public.log_qualification_drive(uuid,uuid,numeric,date,uuid,text)'::regprocedure)) = 0 THEN", " THEN")],
  ["MD voided drives count (+post)", sub("          where ss.department_id = p_dept and ss.voided_at is null and ss.kind = 'drive'", "          where ss.department_id = p_dept and ss.kind = 'drive'").replace("  IF position('voided_at is null' in pg_get_functiondef('public.qualification_cells(uuid,uuid)'::regprocedure)) = 0 THEN", "  IF false THEN")],
  ["ME revoked still counts as qualified", sub("    case when q.id is not null and q.revoked_at is null then 'qualified'", "    case when q.id is not null then 'qualified'")],
  ["MF matrix counts former members", sub("                            and not exists (select 1 from public.member_separation s where s.member_id = m.id)), '[]'::jsonb),", "                            ), '[]'::jsonb),")],
  ["MG config gate open to Officers", sub("  if v_dept is null or not coalesce(public.is_dept_admin(), false) then\n    raise exception 'Only a Department Admin can set up qualifications.';", "  if v_dept is null or not coalesce(public.is_canmanage(), false) then\n    raise exception 'Only a Department Admin can set up qualifications.';").replace("     OR position('is_dept_admin()' in pg_get_functiondef('public.set_qualification_type(uuid,text,text,uuid,integer,integer,boolean)'::regprocedure)) = 0\n", "")],
  ["MH used type's apparatus can change", sub("  if v_used and (p_kind is distinct from v_row.kind or p_apparatus_id is distinct from v_row.apparatus_id) then", "  if false then")],
  ["MI other-department apparatus accepted", sub("    if not exists (select 1 from public.apparatus a where a.id = p_apparatus_id and a.department_id = v_dept\n", "    if not exists (select 1 from public.apparatus a where a.id = p_apparatus_id\n")],
  ["MJ sign-off read open to all members (policy)", sub("    USING (department_id = public.my_department_id() AND (member_id = public.my_member_id() OR public.is_canmanage()));", "    USING (department_id = public.my_department_id());")],
  ["MK drive counts toward every type (counts_toward ignored)", sub("    left join dr on dr.member_id = mem.id and dr.counts_toward = ty.id::text", "    left join (select member_id, sum(n)::int as n from dr group by member_id) dr on dr.member_id = mem.id")],
  ["ML internal helper left callable", sub("  REVOKE EXECUTE ON FUNCTION public.qualification_cells(uuid, uuid) FROM anon, authenticated, public;", "  REVOKE EXECUTE ON FUNCTION public.qualification_cells(uuid, uuid) FROM anon, public;")],
  ["MM inactive type still signable", sub("  if not exists (select 1 from public.qualification_types where id = p_qualification_type_id and department_id = v_dept and active) then\n    raise exception 'That qualification is not set up in your department.';\n  end if;\n  if p_note", "  if not exists (select 1 from public.qualification_types where id = p_qualification_type_id and department_id = v_dept) then\n    raise exception 'That qualification is not set up in your department.';\n  end if;\n  if p_note")],
]) { const x = await base(); try { await x.exec(m); try { await x.exec(ret); } catch (e) { console.log(l, "->", brief(e)); } } catch (e) { console.log(l, "-> migration", e.message.split("\n")[0]); } }
