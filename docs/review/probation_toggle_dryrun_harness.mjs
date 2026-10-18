import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const R = "/Users/ashleabullington/projects/Bullington-VFDAIAgent/sql/";
const src = readFileSync(new URL("./prob.mjs", import.meta.url), "utf8");
// reuse prob.mjs's mock + base (everything up to db0)
const head = src.slice(0, src.indexOf("let d = await db0();")).replaceAll("new URL(\"./rs.mjs\", import.meta.url)", JSON.stringify(new URL("./rs.mjs", import.meta.url).pathname));
const prob = readFileSync(R + "probation_2026-10-18.sql", "utf8"), probRet = readFileSync(R + "probation_RETEST.sql", "utf8");
const mig = readFileSync(R + "probation_toggle_DRAFT.sql", "utf8"), ret = readFileSync(R + "probation_toggle_RETEST.sql", "utf8");
const deptExtra = `
ALTER TABLE departments ADD COLUMN week_start_day int DEFAULT 0;
INSERT INTO departments (id, name) VALUES ('00000000-0000-0000-0000-0000000000d1','B4C Demo Department'),('00000000-0000-0000-0000-0000000000d2','Granbury Fire Station');
INSERT INTO members (department_id,email,name,access,status) VALUES ('00000000-0000-0000-0000-0000000000d2','da@g','G DA','{Department Admin}','Active');
ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read own department" ON departments FOR SELECT TO authenticated USING (id = my_department_id());
CREATE POLICY "dept admins update department" ON departments FOR UPDATE TO authenticated USING (is_dept_admin() AND id = my_department_id()) WITH CHECK (is_dept_admin() AND id = my_department_id());
`;
const mod = new Function("PGlite", "readFileSync", head.replace(/^import .*$/gm, "") + "\nreturn { db0, show, brief };");
const { db0, show, brief } = mod(PGlite, readFileSync);
async function base() { const d = await db0(); await d.exec(deptExtra); await d.exec(prob); return d; }
let d = await base();
console.log("migration state:", JSON.stringify((await d.exec(mig)).at(-1).rows));
try { await d.exec(mig); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
try { await d.exec(ret); } catch (e) { console.log(show(e)); }
try { await d.exec(probRet); } catch (e) { console.log("probation RETEST still:", brief(e)); }
const sub = (a, b) => { if (!mig.includes(a)) throw new Error("anchor missing: " + a.slice(0, 70)); return mig.replace(a, b); };
for (const [l, m] of [
  ["MA gate back to is_dept_admin()", sub("  if v_dept is null or not exists (\n       select 1 from public.members x\n        where lower(x.email) = lower(auth.email()) and x.department_id = v_dept\n          and x.access && array['Department Admin']::text[] and x.status in ('Active', 'Probationary')) then\n    raise exception 'Only a Department Admin can turn", "  if v_dept is null or not coalesce(public.is_dept_admin(), false) then\n    raise exception 'Only a Department Admin can turn")],
  ["MB gate lets a Project Admin in", sub("          and x.access && array['Department Admin']::text[] and x.status in ('Active', 'Probationary')) then\n    raise exception 'Only a Department Admin can turn", "          and x.access && array['Department Admin','Project Admin']::text[] and x.status in ('Active', 'Probationary')) then\n    raise exception 'Only a Department Admin can turn")],
  ["MC RPC writes every department", sub("update public.departments set probation_enabled = p_enabled where id = v_dept returning", "update public.departments set probation_enabled = p_enabled where id = v_dept or true returning")],
  ["MD guard trigger never fires", sub("  if new.probation_enabled is distinct from old.probation_enabled and current_user in ('anon', 'authenticated') then", "  if false then")],
  ["ME board ignores the flag", sub("  if not coalesce((select d.probation_enabled from public.departments d where d.id = v_dept), false) then\n    return;\n  end if;\n", "  -- probation_enabled ignored\n")],
  ["MF backfill hits Granbury instead of Lipan", sub("   WHERE name ILIKE 'Indian Harbor%' OR name ILIKE 'Lipan%' OR name ILIKE 'North Hood%';", "   WHERE name ILIKE 'Indian Harbor%' OR name ILIKE 'Granbury%' OR name ILIKE 'North Hood%';")],
  ["MG trigger left out", sub("  CREATE TRIGGER departments_probation_enabled_guard BEFORE UPDATE OF probation_enabled ON public.departments\n    FOR EACH ROW EXECUTE FUNCTION public.tg_departments_probation_enabled_guard();\n", "")],
  ["MH anon left executable", sub("  REVOKE EXECUTE ON FUNCTION public.set_probation_enabled(boolean) FROM anon, public;\n", "")],
]) { const x = await base(); try { await x.exec(m); try { await x.exec(ret); } catch (e) { console.log(l, "->", brief(e)); } } catch (e) { console.log(l, "-> migration", e.message.split("\n")[0]); } }
