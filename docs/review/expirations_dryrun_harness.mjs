import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const R = "/Users/ashleabullington/projects/Bullington-VFDAIAgent/sql/";
const src = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
const base0 = src.match(/const mock = `([\s\S]*?)`;/)[1].replaceAll("${A}", A).replaceAll("${B}", B);
const mig = readFileSync(R + "expirations_DRAFT.sql", "utf8"), ret = readFileSync(R + "expirations_RETEST.sql", "utf8");
const extra = `
CREATE FUNCTION is_canmanage() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select exists(select 1 from members where lower(email)=lower(auth.email()) and status in ('Active','Probationary') and department_id = public.my_department_id() and access && array['Board Member','Department Admin','Officer']) $$;
CREATE TABLE member_separation (member_id uuid PRIMARY KEY, department_id uuid, terminated_on date);
CREATE TABLE certs (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL, name text NOT NULL, exp text, proof_path text, created_at timestamptz DEFAULT now());
CREATE TABLE cert_submissions (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL, name text NOT NULL, exp text, status text NOT NULL DEFAULT 'pending', created_at timestamptz DEFAULT now());
ALTER TABLE certs ENABLE ROW LEVEL SECURITY; ALTER TABLE cert_submissions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dept reads certs" ON certs FOR SELECT TO authenticated USING (department_id = my_department_id());
INSERT INTO members (department_id,email,name,access,status) VALUES ('${A}','m2@a','A M2','{Member}','Active'),('${B}','off@b','B Off','{Officer}','Active'),('${B}','m2@b','B M2','{Member}','Active'),('${A}','gone@a','A Gone','{Member}','Active');
INSERT INTO member_separation VALUES ((SELECT id FROM members WHERE email='gone@a'), '${A}', '2026-01-01');
`;
const show = (e) => e.message.split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const brief = (e) => e.message.split("\n").filter((l) => /FAIL|passed/.test(l)).join(" | ");
async function db0() { const d = new PGlite(); await d.exec(base0); await d.exec(extra); return d; }
let d = await db0();
console.log("state:", JSON.stringify((await d.exec(mig)).at(-1).rows));
try { await d.exec(mig); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
try { await d.exec(ret); } catch (e) { console.log(show(e)); }
const sub = (a, b) => { if (!mig.includes(a)) throw new Error("anchor missing: " + a.slice(0, 70)); return mig.replace(a, () => b); };
for (const [l, m] of [
  ["(a) a member passes a write gate (set_gear_item)", sub("  if v_dept is null or v_me is null or not coalesce(public.is_canmanage_ops(), false) then\n    raise exception 'Only a Department Admin or Officer can record gear.';", "  if v_dept is null or v_me is null or (false and not coalesce(public.is_canmanage_ops(), false)) then\n    raise exception 'Only a Department Admin or Officer can record gear.';")],
  ["(b) credential for another department's member", sub("  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then\n    raise exception 'That member is not in your department.';\n  end if;\n  if p_kind is null", "  if p_kind is null")],
  ["(c1) test on a deleted rig accepted (write)", sub("  if not exists (select 1 from public.apparatus where id = p_apparatus_id and department_id = v_dept and deleted_at is null) then", "  if not exists (select 1 from public.apparatus where id = p_apparatus_id and department_id = v_dept) then")],
  ["(c2) deleted rig's test shown (read)", sub("join public.apparatus a on a.id = t.apparatus_id and a.department_id = p_dept and a.deleted_at is null", "join public.apparatus a on a.id = t.apparatus_id and a.department_id = p_dept")],
  ["(d) kind off the check set accepted", sub("  if p_kind is null or p_kind not in ('license', 'med_card', 'fit_test', 'other') then raise exception 'Unknown credential type.'; end if;\n", "").replace("    kind          text NOT NULL CHECK (kind IN ('license', 'med_card', 'fit_test', 'other')),", "    kind          text NOT NULL,")],
  ["(e1) cert_submissions unioned in (post-condition kept)", sub("    union all\n    select 'member', 'credential'", "    union all\n    select 'member', 'cert', cs.id, cs.member_id, null, p.name, 'cert', cs.name, null, null::date from public.cert_submissions cs join people p on p.id = cs.member_id where cs.department_id = p_dept\n    union all\n    select 'member', 'credential'")],
  ["(e2) cert_submissions unioned in (post-condition removed)", sub("    union all\n    select 'member', 'credential'", "    union all\n    select 'member', 'cert', cs.id, cs.member_id, null, p.name, 'cert', cs.name, null, null::date from public.cert_submissions cs join people p on p.id = cs.member_id where cs.department_id = p_dept\n    union all\n    select 'member', 'credential'").replace("  IF position('cert_submissions' in pg_get_functiondef('public.expiration_rows(uuid,uuid)'::regprocedure)) > 0 THEN", "  IF false THEN")],
  ["(f) a notes column on member_credentials", sub("    expires_on    date,\n    created_by    uuid, created_at", "    expires_on    date,\n    notes         text,\n    created_by    uuid, created_at")],
  ["(f2) a license_number column", sub("    expires_on    date,\n    created_by    uuid, created_at", "    expires_on    date,\n    license_number text,\n    created_by    uuid, created_at")],
  ["(g) number-in-class guard removed", sub("  if v_label ~ '\\d{5,}' or coalesce(v_cls, '') ~ '\\d{5,}' then\n    raise exception 'Record the class and dates only — never a license or card number.';\n  end if;\n", "").replace("cls           text CHECK (cls IS NULL OR (length(btrim(cls)) BETWEEN 1 AND 40 AND cls !~ '\\d{5,}')),", "cls           text,")],
  ["(h) Inactive members counted", sub("                 else m.status is distinct from 'Inactive'\n                      and not coalesce", "                 else true\n                      and not coalesce")],
  ["(i) YYYY-MM -> the FIRST of the month", sub("then (date_trunc('month', to_date(c.exp || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date end as expires_on", "then to_date(c.exp || '-01', 'YYYY-MM-DD') end as expires_on")],
  ["(j) undated reads current", sub("    case when r.expires_on is null then 'no_date'", "    case when r.expires_on is null then 'current'")],
  ["(k) the 10-year gear rule dropped", sub("coalesce((g.in_service_on + interval '10 years')::date, 'infinity'::date)", "'infinity'::date")],
  ["(l) a write RPC left as INVOKER", sub("CREATE OR REPLACE FUNCTION public.delete_apparatus_test(p_id uuid)\n RETURNS void\n LANGUAGE plpgsql\n SECURITY DEFINER", "CREATE OR REPLACE FUNCTION public.delete_apparatus_test(p_id uuid)\n RETURNS void\n LANGUAGE plpgsql\n SECURITY INVOKER")],
]) { const x = await db0(); try { await x.exec(m); try { await x.exec(ret); } catch (e) { console.log(l, "->", brief(e)); } } catch (e) { console.log(l, "-> migration", e.message.split("\n")[0]); } }
