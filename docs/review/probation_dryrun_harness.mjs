import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const R = "/Users/ashleabullington/projects/Bullington-VFDAIAgent/sql/";
const rsBase = ["read_sign_2026-10-17.sql", "read_sign_da_only_2026-10-17.sql", "read_sign_signature_2026-10-17.sql", "read_sign_records_2026-10-18.sql"].map((f) => readFileSync(R + f, "utf8")).join("\n");
const soi = readFileSync(R + "onboarding_selfsign_block.sql", "utf8");
const mig = readFileSync(R + "probation_2026-10-18.sql", "utf8"), ret = readFileSync(R + "probation_RETEST.sql", "utf8"), rsRet = readFileSync(R + "read_sign_RETEST.sql", "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b", C = "00000000-0000-0000-0000-00000000000c";
let mock = readFileSync(new URL("./rs.mjs", import.meta.url), "utf8").match(/const mock = `([\s\S]*?)`;/)[1].replaceAll("${A}", A).replaceAll("${B}", B);
mock = mock.replace("CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, email text, name text, access text[], status text DEFAULT 'Active');",
  "CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, email text, name text, access text[], status text DEFAULT 'Active', mentor_id uuid);");
const extra = `
CREATE ROLE service_role NOLOGIN;
INSERT INTO departments VALUES ('${C}','Indian Harbor Volunteer Fire Department');
INSERT INTO members (department_id,email,name,access,status) VALUES
 ('${A}','board@a','A Board','{Board Member}','Active'),('${B}','m2@b','B M2','{Member}','Active'),
 ('${C}','da@c','C DA','{Department Admin}','Active'),('${C}','off@c','C Off','{Officer}','Active'),('${C}','p1@c','C P1','{Member}','Probationary'),
 ('${C}','p2@c','C P2','{Member}','Probationary'),('${C}','m1@c','C M1','{Member}','Active');
CREATE FUNCTION is_leader() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select exists(select 1 from members where lower(email)=lower(auth.email()) and access && array['Board Member','Department Admin','Officer','Training Officer']) $$;
CREATE TABLE member_private (member_id uuid PRIMARY KEY, department_id uuid, birthday date, joined_date date);
INSERT INTO member_private (member_id, department_id, joined_date) SELECT id, department_id, date '2026-09-10' FROM members WHERE email = 'p1@c';
CREATE TABLE certs (id uuid NOT NULL DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL, name text, exp text, proof_path text, created_at timestamptz DEFAULT now());
CREATE TABLE apparatus (id uuid NOT NULL DEFAULT gen_random_uuid(), department_id uuid NOT NULL, name text NOT NULL);
CREATE TABLE training_sessions (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, department_id uuid NOT NULL, title text, date date NOT NULL);
CREATE TABLE session_attendance (id uuid NOT NULL DEFAULT gen_random_uuid(), department_id uuid NOT NULL, session_id uuid NOT NULL, member_id uuid NOT NULL, checked_in_at timestamptz);
CREATE TABLE onboarding_items (id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY, department_id uuid NOT NULL, category text NOT NULL, label text NOT NULL, is_mentor boolean NOT NULL DEFAULT false, sort_order integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE onboarding_progress (id uuid NOT NULL DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid, item_id uuid, done boolean NOT NULL DEFAULT false, checked_by uuid, checked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (member_id, item_id));
ALTER TABLE onboarding_items ENABLE ROW LEVEL SECURITY; ALTER TABLE onboarding_progress ENABLE ROW LEVEL SECURITY;
CREATE POLICY "members read dept onboarding_items" ON onboarding_items FOR SELECT TO authenticated USING (department_id = my_department_id());
CREATE POLICY "dept admins update onboarding_items" ON onboarding_items FOR UPDATE TO authenticated USING (is_dept_admin() AND department_id = my_department_id()) WITH CHECK (is_dept_admin() AND department_id = my_department_id());
CREATE POLICY "member reads own onboarding_progress" ON onboarding_progress FOR SELECT TO authenticated USING (member_id = my_member_id());
CREATE POLICY "leaders can read onboarding_progress" ON onboarding_progress FOR SELECT TO public USING (is_leader() AND department_id = my_department_id());
CREATE POLICY "dept admins insert onboarding_progress" ON onboarding_progress FOR INSERT TO authenticated WITH CHECK (is_dept_admin() AND department_id = my_department_id());
INSERT INTO onboarding_items (department_id, category, label, sort_order) VALUES ('${C}','Probationary Period','Ride 10 calls',1),('${C}','Probationary Period','Pass the probation exam',2),('${C}','Before the Call','Gear issued',3),('${A}','Gear','Gear issued',1);
INSERT INTO onboarding_items (department_id, category, label, is_mentor) VALUES ('${C}','People & access','Mentor assigned',true);
INSERT INTO onboarding_progress (department_id, member_id, item_id, done) SELECT '${C}', m.id, i.id, true FROM members m, onboarding_items i WHERE m.email='p1@c' AND i.label='Gear issued' AND i.department_id='${C}';
INSERT INTO member_separation VALUES ((SELECT id FROM members WHERE email='gone@a'), '${A}', '2026-01-01');
WITH t AS (INSERT INTO training_sessions (department_id, title, date) SELECT department_id, 'real night', date '2026-05-01' FROM members WHERE email IN ('m1@a','p1@c') RETURNING id, department_id)
INSERT INTO session_attendance (department_id, session_id, member_id) SELECT t.department_id, t.id, m.id FROM t JOIN members m ON m.department_id = t.department_id AND m.email IN ('m1@a','p1@c');
`;
const show = (e) => e.message.split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const brief = (e) => e.message.split("\n").filter((l) => /FAIL|passed/.test(l)).join(" | ");
async function db0() { const d = new PGlite(); await d.exec(mock); await d.exec(rsBase); await d.exec(extra); await d.exec(soi); return d; }
let d = await db0();
console.log("migration state:", JSON.stringify((await d.exec(mig)).at(-1).rows));
try { await d.exec(mig); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
try { await d.exec(ret); } catch (e) { console.log(show(e)); }
try { await d.exec(rsRet); } catch (e) { console.log("read_sign RETEST still:", brief(e)); }
const sp = (await d.query("select member_id, started_on, note from member_probation")).rows; console.log("backfill rows:", JSON.stringify(sp));
const sub = (a, b, src = mig) => { if (!src.includes(a)) throw new Error("mutation anchor missing: " + a.slice(0, 70)); return src.replace(a, b); };
for (const [l, m] of [
  ["MA milestone gate removed", sub("if v_dept is null or v_me is null or not coalesce(public.is_canmanage(), false) then\n    raise exception 'Only department leadership can sign a probation review.';", "if v_dept is null or v_me is null then\n    raise exception 'Only department leadership can sign a probation review.';")],
  ["MB milestone not-self removed (+ its post-condition)", sub("  if p_member_id = v_me then raise exception 'You can''t sign your own probation review — an officer does.'; end if;\n", "").replace("     OR position('p_member_id = v_me' in pg_get_functiondef('public.set_probation_milestone(uuid,text,text,text)'::regprocedure)) = 0\n", "")],
  ["MC log: member dept check removed", sub("  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then\n    raise exception 'That member is not in your department.';\n  end if;\n  if v_sup = p_member_id", "  if v_sup = p_member_id")],
  ["MD ack item always satisfied", sub("when i.kind = 'ack'    then ak.series_id is not null and ak.published and (not ak.in_audience or ak.signed_current)", "when i.kind = 'ack'    then true")],
  ["ME expired cert counts", sub("                                          and split_part(c.exp, '-', 1)::int * 12 + split_part(c.exp, '-', 2)::int\n                                              >= extract(year from td.d)::int * 12 + extract(month from td.d)::int) as current", ") as current")],
  ["MF empty gate reads cleared", sub("'cleared_to_run', g.req > 0 and g.ok = g.req,", "'cleared_to_run', g.ok = g.req,").replace("'ready_for_vote', m.status = 'Probationary' and g.req > 0 and", "'ready_for_vote', m.status = 'Probationary' and")],
  ["MG board counts former members", sub("             and not exists (select 1 from public.member_separation s where s.member_id = m.id)) x", ") x")],
  ["MH read policy without the department", sub("USING (department_id = public.my_department_id() AND (member_id = public.my_member_id() OR public.is_canmanage()))", "USING (member_id = public.my_member_id() OR public.is_canmanage())")],
  ["MI internal helper left callable", sub("    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, authenticated, public', v_t);", "    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', v_t); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_t);")],
  ["MJ transition-state grant revoked", sub("  -- backfill: Probationary", "  REVOKE INSERT, UPDATE ON public.onboarding_progress FROM authenticated;\n  -- backfill: Probationary")],
  ["MK ready without the final review", sub("                             and (select count(*) from ms where ms.status = 'done') = 4)", "                             and (select count(*) from ms where ms.status = 'done') >= 3)")],
  ["MM start gate back to is_dept_admin() (PA path)", sub("not exists (\n       select 1 from public.members x\n        where lower(x.email) = lower(auth.email()) and x.department_id = v_dept\n          and x.access && array['Department Admin']::text[] and x.status in ('Active', 'Probationary')) then", "not coalesce(public.is_dept_admin(), false) then")],
  ["MM2 start gate lets a Project Admin in (behaviour; post-condition kept quiet)", sub("          and x.access && array['Department Admin']::text[] and x.status in ('Active', 'Probationary')) then", "          and x.access && array['Department Admin','Project Admin']::text[] and x.status in ('Active', 'Probationary')) then")],
  ["MN log gate widened to is_canmanage() (Board)", sub("  if v_dept is null or v_me is null or not coalesce(public.is_canmanage_ops(), false) then\n    raise exception 'Only a Department Admin or Officer can log supervised time.';", "  if v_dept is null or v_me is null or not coalesce(public.is_canmanage(), false) then\n    raise exception 'Only a Department Admin or Officer can log supervised time.';")],
  ["MO voided sessions still count (body + post-condition)", sub("where ss.member_id = p_member and ss.department_id = p_dept and ss.voided_at is null\n                                    and", "where ss.member_id = p_member and ss.department_id = p_dept\n                                    and").replace("               where ss.member_id = p_member and ss.department_id = p_dept and ss.voided_at is null)", "               where ss.member_id = p_member and ss.department_id = p_dept)").replace("  IF position('voided_at is null' in pg_get_functiondef('public.probation_item_states(uuid,uuid)'::regprocedure)) = 0\n     OR position('voided_at is null' in pg_get_functiondef('public.probation_status(uuid,uuid)'::regprocedure)) = 0 THEN", "  IF false THEN")],
  ["MP void hard-deletes the row", sub("  update public.supervised_sessions set voided_at = now(), voided_by = v_me, void_reason = btrim(p_reason)\n   where id = p_id returning * into v_row;", "  delete from public.supervised_sessions where id = p_id returning * into v_row;")],
  ["MQ training nights count future sessions", sub("                                  where a.member_id = p_member and t.date <= td.d)", "                                  where a.member_id = p_member)")],
  ["MR void lets a member void their own session (body + post-condition)", sub("  if v_row.member_id = v_me then raise exception 'You can''t void your own supervised time — another officer does.'; end if;\n", "").replace("\n     OR position('v_row.member_id = v_me' in pg_get_functiondef('public.void_supervised_session(uuid,text)'::regprocedure)) = 0 THEN", " THEN")],
  ["ML future start allowed", sub("  if p_started_on is not null and (p_started_on < date '2000-01-01' or p_started_on > (now() at time zone 'America/Chicago')::date) then", "  if p_started_on is not null and p_started_on < date '2000-01-01' then")],
]) { const x = await db0(); try { await x.exec(m); try { await x.exec(ret); } catch (e) { console.log(l, "->", brief(e)); } } catch (e) { console.log(l, "-> migration", e.message.split("\n")[0]); } }
