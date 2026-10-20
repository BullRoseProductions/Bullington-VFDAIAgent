import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const R = "/Users/ashleabullington/projects/Bullington-VFDAIAgent/sql/";
const mig = readFileSync(R + "rls_admin_gate_fix_DRAFT.sql", "utf8"), ret = readFileSync(R + "rls_admin_gate_fix_RETEST.sql", "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b", C = "00000000-0000-0000-0000-00000000000c";
// The live shape (Step 0 / 0c / A): my_department_id / is_dept_admin / is_department_admin / is_leader bodies as read on
// live; the four target policies with their exact Step 0c expressions; a few unrelated policies (the snapshot).
const mock = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
CREATE TABLE departments (id uuid PRIMARY KEY, name text);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, email text, name text, access text[], status text DEFAULT 'Active');
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid, updated_at timestamptz DEFAULT now());
CREATE TABLE announcements (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, author_id uuid, title text, body text NOT NULL, audience text NOT NULL DEFAULT 'everyone', created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE duty_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, duty_name text, created_at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION public.my_department_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select coalesce(
    ( select mad.department_id from public.member_active_department mad where mad.email = lower(auth.email())
        and exists ( select 1 from public.members m where lower(m.email) = lower(auth.email()) and m.status in ('Active','Probationary') and m.department_id = mad.department_id ) ),
    ( select m.department_id from public.members m where lower(m.email) = lower(auth.email()) and m.status in ('Active','Probationary') order by m.department_id limit 1 ) );
$$;
CREATE FUNCTION public.my_member_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select id from public.members where lower(email) = lower(auth.email()) and status in ('Active','Probationary') and department_id = public.my_department_id() limit 1;
$$;
CREATE FUNCTION public.is_dept_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (
    select 1 from public.members
    where lower(members.email) = lower(auth.email())
      and members.status in ('Active','Probationary')
      and members.department_id = public.my_department_id()
      and members.access && array['Project Admin','Department Admin']::text[]
  );
$$;
CREATE FUNCTION public.is_department_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists ( select 1 from members where lower(members.email) = lower(auth.email()) and members.status in ('Active','Probationary') and members.access && array['Department Admin','Project Admin']::text[] );
$$;
CREATE FUNCTION public.is_leader() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists ( select 1 from members where lower(members.email) = lower(auth.email()) and members.status in ('Active','Probationary') and members.department_id = public.my_department_id() and members.access && array['Project Admin','Department Admin','Board Member','Officer']::text[] );
$$;
CREATE FUNCTION public.is_announcer() RETURNS boolean LANGUAGE sql STABLE AS $$ select true $$;
ALTER TABLE departments ENABLE ROW LEVEL SECURITY; ALTER TABLE announcements ENABLE ROW LEVEL SECURITY; ALTER TABLE duty_log ENABLE ROW LEVEL SECURITY; ALTER TABLE members ENABLE ROW LEVEL SECURITY;
CREATE POLICY "read members" ON members FOR SELECT TO authenticated USING (department_id = my_department_id());
CREATE POLICY "members read own department" ON departments FOR SELECT TO authenticated USING (id = my_department_id());
CREATE POLICY "DA can update own department" ON departments FOR UPDATE TO authenticated USING ((id = my_department_id()) AND is_department_admin()) WITH CHECK ((id = my_department_id()) AND is_department_admin());
CREATE POLICY "read announcements" ON announcements FOR SELECT TO authenticated USING (department_id = my_department_id());
CREATE POLICY "announcers post" ON announcements FOR INSERT TO authenticated WITH CHECK ((department_id = my_department_id()) AND (author_id = my_member_id()) AND is_announcer());
CREATE POLICY "author or dept admin update announcements" ON announcements FOR UPDATE TO authenticated
  USING ((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin()))
  WITH CHECK ((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin()));
CREATE POLICY "author or dept admin delete announcements" ON announcements FOR DELETE TO authenticated
  USING ((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin()));
CREATE POLICY "read duty_log" ON duty_log FOR SELECT TO authenticated USING (department_id = my_department_id());
CREATE POLICY "dept admins edit duty_log" ON duty_log FOR UPDATE TO authenticated
  USING (is_department_admin() AND (department_id = my_department_id())) WITH CHECK (is_department_admin() AND (department_id = my_department_id()));
INSERT INTO departments VALUES ('${A}','Alpha'),('${B}','Bravo'),('${C}','Charlie (empty)');
INSERT INTO members (department_id,email,name,access,status) VALUES
 ('${A}','ada@a','Ada DA-of-A','{Department Admin}','Active'),('${A}','off@a','A Officer','{Officer}','Active'),('${A}','m1@a','A Member','{Member}','Active'),
 ('${B}','bob@b','Bob DA-of-B','{Department Admin}','Active'),('${B}','cal@b','Cal member','{Member}','Active'),('${B}','pa@x','Pat PA','{Project Admin}','Active'),
 ('${A}','pa@x','Pat PA','{Project Admin}','Active');
`;
const show = (e) => e.message.split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const brief = (e) => e.message.split("\n").filter((l) => /FAIL|passed/.test(l)).join(" | ");
const LIVE_GATES = "CREATE OR REPLACE FUNCTION public.is_dept_admin()\n RETURNS boolean\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO \'public\'\nAS $function$\n  select exists (\n    select 1 from public.members\n    where lower(members.email) = lower(auth.email())\n      and members.status in (\'Active\',\'Probationary\')\n      and members.department_id = public.my_department_id()\n      and members.access && array[\'Project Admin\',\'Department Admin\']::text[]\n  );\n$function$\n;\nCREATE OR REPLACE FUNCTION public.is_department_admin()\n RETURNS boolean\n LANGUAGE sql\n STABLE SECURITY DEFINER\n SET search_path TO \'public\'\nAS $function$\n  select exists (\n    select 1 from members\n    where lower(members.email) = lower(auth.email())\n      and members.status in (\'Active\',\'Probationary\')\n      and members.access && array[\'Department Admin\',\'Project Admin\']::text[]\n  );\n$function$\n;\n";
async function base(extra = "") { const d = new PGlite(); await d.exec(mock); await d.exec(LIVE_GATES); if (extra) await d.exec(extra); return d; }
// 0. the REGRESSION-CATCH: the RETEST on the PRE-FIX policies — the multi-dept admin gets through
{ const d = await base(); try { await d.exec(ret); } catch (e) { console.log("PRE-FIX (live policies as they are today):\n" + show(e)); } }
// 1. the fix
const d = await base();
const pre = (await d.query("select count(*)::int n from pg_policies where schemaname='public'")).rows[0].n;
console.log("\nstate:", JSON.stringify((await d.exec(mig)).at(-1).rows), "· policies before", pre);
try { await d.exec(mig); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
try { await d.exec(ret); } catch (e) { console.log("AFTER THE FIX:\n" + show(e)); }
// 2. mutations
const sub = (a, b, s = mig) => { if (!s.includes(a)) throw new Error("anchor missing: " + a.slice(0, 80)); return s.replace(a, () => b); };
console.log("\nmutations:");
for (const [l, m, extra] of [
  ["(a) is_dept_admin() made global (the stale schema.sql body) — the swap would not close the gap", mig, "CREATE OR REPLACE FUNCTION public.is_dept_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select exists (select 1 from public.members where lower(members.email) = lower(auth.email()) and members.access && array['Project Admin','Department Admin']::text[]) $$;"],
  ["(a2) same, with both pins removed — the RETEST must still catch it", sub("  IF btrim(regexp_replace(substring(pg_get_functiondef('public.is_dept_admin()'::regprocedure)", "  IF false AND btrim(regexp_replace(substring(pg_get_functiondef('public.is_dept_admin()'::regprocedure)").replace("  IF md5(pg_get_functiondef('public.is_dept_admin()'::regprocedure)) <> 'c692e44f62923d2bf4c1a39a21a87bf7' THEN", "  IF false THEN"), "CREATE OR REPLACE FUNCTION public.is_dept_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select exists (select 1 from public.members where lower(members.email) = lower(auth.email()) and members.access && array['Project Admin','Department Admin']::text[]) $$;"],
  ["(b) the department predicate dropped on departments", sub("  ALTER POLICY \"DA can update own department\" ON public.departments\n    USING ((id = public.my_department_id()) AND public.is_dept_admin())\n    WITH CHECK ((id = public.my_department_id()) AND public.is_dept_admin());", "  ALTER POLICY \"DA can update own department\" ON public.departments\n    USING (public.is_department_admin())\n    WITH CHECK (public.is_department_admin());")],
  ["(b2) same, post-condition aligned — the RETEST must still catch it", sub("  ALTER POLICY \"DA can update own department\" ON public.departments\n    USING ((id = public.my_department_id()) AND public.is_dept_admin())\n    WITH CHECK ((id = public.my_department_id()) AND public.is_dept_admin());", "  ALTER POLICY \"DA can update own department\" ON public.departments\n    USING (public.is_department_admin())\n    WITH CHECK (public.is_department_admin());").replaceAll("'((id = my_department_id()) AND is_dept_admin())'", "'is_department_admin()'").replace("    IF position('is_department_admin' in coalesce(v_q, '') || coalesce(v_c, '')) > 0 THEN", "    IF false THEN")],
  ["(c) another policy changed in the same block", sub("  -- ---------------------------------------------------------------- post-conditions\n", "  ALTER POLICY \"read duty_log\" ON public.duty_log USING (true);\n  -- ---------------------------------------------------------------- post-conditions\n")],
  ["(d) duty_log left on the role-anywhere gate (one swap missed)", sub("  ALTER POLICY \"dept admins edit duty_log\" ON public.duty_log\n    USING (public.is_dept_admin() AND (department_id = public.my_department_id()))\n    WITH CHECK (public.is_dept_admin() AND (department_id = public.my_department_id()));\n", "")],
  ["(e) a Project Admin with a plain-member row (the PA-branch case)", mig, "INSERT INTO members (department_id,email,name,access,status) VALUES ('" + C + "','pa@x','Pat PA','{Member}','Active');"],
  ["(f) the author branch dropped from announcements UPDATE", sub("  ALTER POLICY \"author or dept admin update announcements\" ON public.announcements\n    USING ((department_id = public.my_department_id()) AND ((author_id = public.my_member_id()) OR public.is_dept_admin()))\n    WITH CHECK ((department_id = public.my_department_id()) AND ((author_id = public.my_member_id()) OR public.is_dept_admin()));",
     "  ALTER POLICY \"author or dept admin update announcements\" ON public.announcements\n    USING ((department_id = public.my_department_id()) AND public.is_dept_admin())\n    WITH CHECK ((department_id = public.my_department_id()) AND public.is_dept_admin());").replaceAll("'((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_dept_admin()))',\n          '((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_dept_admin()))'],", "'((department_id = my_department_id()) AND is_dept_admin())',\n          '((department_id = my_department_id()) AND is_dept_admin())'],")],
]) {
  const x = await base(extra);
  try { await x.exec(m); try { await x.exec(ret); console.log(l, "-> NOT CAUGHT"); } catch (e) { console.log(l, "->", brief(e) || e.message.split("\n")[0]); } }
  catch (e) { console.log(l, "-> migration", e.message.split("\n")[0]); }
}
