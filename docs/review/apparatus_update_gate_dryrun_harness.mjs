import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const R = "/Users/ashleabullington/projects/Bullington-VFDAIAgent/sql/";
const mig = readFileSync(R + "apparatus_update_gate_DRAFT.sql", "utf8"), ret = readFileSync(R + "apparatus_update_gate_RETEST.sql", "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
const mock = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated;
CREATE TABLE departments (id uuid PRIMARY KEY, name text);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, email text, name text, access text[], status text DEFAULT 'Active');
CREATE FUNCTION my_department_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select department_id from members where lower(email) = lower(auth.email()) limit 1 $$;
CREATE FUNCTION my_member_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select id from members where lower(email) = lower(auth.email()) limit 1 $$;
CREATE FUNCTION is_canmanage_ops() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select exists(select 1 from members where lower(email)=lower(auth.email()) and status in ('Active','Probationary') and department_id = public.my_department_id() and access && array['Department Admin','Officer']) $$;
CREATE FUNCTION is_dept_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select exists(select 1 from members where lower(email)=lower(auth.email()) and status in ('Active','Probationary') and department_id = public.my_department_id() and access && array['Department Admin','Project Admin']) $$;
CREATE TABLE apparatus (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, name text NOT NULL, type text, status text, in_service boolean NOT NULL DEFAULT true,
  note text, last_check_at timestamptz, checked_by uuid, check_interval_days int, deleted_at timestamptz, station_id uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE apparatus_check_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, apparatus_id uuid NOT NULL, label text NOT NULL, sort_order int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true);
CREATE TABLE apparatus_checks (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, apparatus_id uuid NOT NULL, state text NOT NULL);
CREATE TABLE apparatus_check_results (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), check_id uuid, item_id uuid, result text);
CREATE TABLE apparatus_maintenance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, note text);
ALTER TABLE apparatus ENABLE ROW LEVEL SECURITY; ALTER TABLE apparatus_check_items ENABLE ROW LEVEL SECURITY; ALTER TABLE apparatus_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE apparatus_check_results ENABLE ROW LEVEL SECURITY; ALTER TABLE apparatus_maintenance ENABLE ROW LEVEL SECURITY;
CREATE POLICY "dept reads apparatus" ON apparatus FOR SELECT TO authenticated USING (department_id = my_department_id());
CREATE POLICY "leaders add apparatus" ON apparatus FOR INSERT TO authenticated WITH CHECK ((department_id = my_department_id()) AND is_canmanage_ops());
CREATE POLICY "leaders delete apparatus" ON apparatus FOR DELETE TO authenticated USING ((department_id = my_department_id()) AND is_dept_admin());
CREATE POLICY "members update apparatus" ON apparatus FOR UPDATE TO authenticated USING (department_id = my_department_id()) WITH CHECK (department_id = my_department_id());
CREATE POLICY "members update apparatus_maintenance" ON apparatus_maintenance FOR UPDATE TO authenticated USING (department_id = my_department_id());
CREATE FUNCTION apparatus_check_interval_guard() RETURNS trigger LANGUAGE plpgsql AS $$ begin
  if new.check_interval_days is distinct from old.check_interval_days and current_setting('b4c.interval_setter', true) is distinct from 'on' and current_user in ('anon','authenticated') then raise exception 'Use the setter.'; end if; return new; end $$;
CREATE TRIGGER apparatus_check_interval_guard BEFORE UPDATE ON apparatus FOR EACH ROW EXECUTE FUNCTION apparatus_check_interval_guard();
-- stand-ins with the live signatures + definer behaviour
CREATE FUNCTION start_or_resume_check(p_apparatus_id uuid) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare v uuid; begin
  if not exists (select 1 from apparatus where id = p_apparatus_id and department_id = my_department_id()) then raise exception 'Not authorized'; end if;
  insert into apparatus_checks (department_id, apparatus_id, state) values (my_department_id(), p_apparatus_id, 'in_progress') returning id into v; return v; end $$;
CREATE FUNCTION mark_check_item(p_check_id uuid, p_item_id uuid, p_result text, p_note text DEFAULT NULL) RETURNS apparatus_check_results LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare r apparatus_check_results; begin insert into apparatus_check_results (check_id, item_id, result) values (p_check_id, p_item_id, p_result) returning * into r; return r; end $$;
CREATE FUNCTION finalize_check(p_check_id uuid) RETURNS apparatus_checks LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
declare c apparatus_checks; begin
  update apparatus_checks set state = 'finalized' where id = p_check_id returning * into c;
  update public.apparatus set last_check_at = now(), status = 'Pass', checked_by = my_member_id() where id = c.apparatus_id; return c; end $$;
CREATE FUNCTION set_apparatus_check_interval(p_apparatus_id uuid, p_days integer) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin if not is_canmanage_ops() then raise exception 'no'; end if; perform set_config('b4c.interval_setter','on',true);
  update public.apparatus set check_interval_days = p_days where id = p_apparatus_id and department_id = my_department_id(); perform set_config('b4c.interval_setter','',true); end $$;
CREATE FUNCTION take_apparatus_out_of_service(p_apparatus_id uuid, p_reason text) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $$
begin if not is_canmanage_ops() then raise exception 'no'; end if; update public.apparatus set in_service = false where id = p_apparatus_id and department_id = my_department_id(); end $$;
INSERT INTO departments VALUES ('${A}','North Hood'),('${B}','Lipan'),('00000000-0000-0000-0000-0000000000d2','Granbury Fire Station');
INSERT INTO members (department_id,email,name,access,status) VALUES
 ('${A}','da@a','A DA','{Department Admin}','Active'),('${A}','off@a','A Off','{Officer}','Active'),('${A}','board@a','A Board','{Board Member}','Active'),('${A}','m1@a','A M1','{Member}','Active'),
 ('${B}','da@b','B DA','{Department Admin}','Active'),('${B}','m1@b','B M1','{Member}','Probationary');
`;
const show = (e) => e.message.split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const brief = (e) => e.message.split("\n").filter((l) => /FAIL|passed/.test(l)).join(" | ");
async function db0() { const d = new PGlite(); await d.exec(mock); return d; }
let d = await db0();
console.log("state:", JSON.stringify((await d.exec(mig)).at(-1).rows));
try { await d.exec(mig); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
try { await d.exec(ret); } catch (e) { console.log(show(e)); }
// BEFORE the fix the RETEST must fail U1 / U4 (the hole is real)
const d0 = await db0(); try { await d0.exec(ret); } catch (e) { console.log("BEFORE the fix ->", brief(e)); }
const sub = (a, b) => { if (!mig.includes(a)) throw new Error("anchor missing: " + a.slice(0, 60)); return mig.replace(a, () => b); };
for (const [l, m, pre] of [
  ["MA new policy dept-only (gate dropped, + post)", sub("    USING (department_id = public.my_department_id() AND public.is_canmanage_ops())\n    WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage_ops());", "    USING (department_id = public.my_department_id())\n    WITH CHECK (department_id = public.my_department_id());").replace(/AND position\('is_canmanage_ops\(\)' in qual\) > 0\n\s+AND position\('my_department_id\(\)' in with_check\) > 0 AND position\('is_canmanage_ops\(\)' in with_check\) > 0/, "")],
  ["MB gate without the department (+ post)", sub("    USING (department_id = public.my_department_id() AND public.is_canmanage_ops())\n    WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage_ops());", "    USING (public.is_canmanage_ops())\n    WITH CHECK (public.is_canmanage_ops());").replace(/AND position\('my_department_id\(\)' in qual\) > 0 AND position\('is_canmanage_ops\(\)' in qual\) > 0\n\s+AND position\('my_department_id\(\)' in with_check\) > 0 AND/, "AND")],
  ["MC old policy left in place", sub('  DROP POLICY "members update apparatus" ON public.apparatus;\n', "")],
  ["MD another table's policy touched", sub("  -- ---------------------------------------------------------------- post-conditions", "  DROP POLICY \"members update apparatus_maintenance\" ON public.apparatus_maintenance;\n  -- ---------------------------------------------------------------- post-conditions")],
  ["ME an INVOKER apparatus writer present", mig, "CREATE FUNCTION bad_writer() RETURNS void LANGUAGE sql AS $$ update public.apparatus set note = 'x' $$;"],
  ["MF the check RPC drifts", sub("  -- ---------------------------------------------------------------- post-conditions", "  EXECUTE $mx$CREATE OR REPLACE FUNCTION public.finalize_check(p_check_id uuid) RETURNS apparatus_checks LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$ declare c apparatus_checks; begin return c; end $f$$mx$;\n  -- ---------------------------------------------------------------- post-conditions")],
]) { const x = await db0(); if (pre) await x.exec(pre); try { await x.exec(m); try { await x.exec(ret); } catch (e) { console.log(l, "->", brief(e)); } } catch (e) { console.log(l, "-> migration", e.message.split("\n")[0]); } }
