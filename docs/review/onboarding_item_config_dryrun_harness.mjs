import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const R = "/Users/ashleabullington/projects/Bullington-VFDAIAgent/sql/";
const J = process.env.CLAUDE_JOB_DIR + "/tmp/oic/";
const src = readFileSync(new URL("./prob.mjs", import.meta.url), "utf8");
const head = src.slice(0, src.indexOf("let d = await db0();")).replaceAll("new URL(\"./rs.mjs\", import.meta.url)", JSON.stringify(new URL("./rs.mjs", import.meta.url).pathname));
const { db0, show, brief } = new Function("PGlite", "readFileSync", head.replace(/^import .*$/gm, "") + "\nreturn { db0, show, brief };")(PGlite, readFileSync);
const prob = readFileSync(R + "probation_2026-10-18.sql", "utf8"), tog = readFileSync(R + "probation_toggle_2026-10-18.sql", "utf8");
const probRet = readFileSync(R + "probation_RETEST.sql", "utf8");
const mig = readFileSync(R + "onboarding_item_config_DRAFT.sql", "utf8"), ret = readFileSync(R + "onboarding_item_config_RETEST.sql", "utf8");
const liveSoi = readFileSync(J + "live_soi.sql", "utf8"), livePis = readFileSync(J + "live_pis.sql", "utf8");
// live shape the draft relies on: the live set_onboarding_item + probation_item_states TEXT (md5-pinned), notifications
// with its de-dupe index, is_muted (live families), action_items + its assignment trigger, storage.buckets, the
// onboarding_items DA insert / delete policies, a second Officer-less department and an "other department" member.
const extra = `
CREATE SCHEMA IF NOT EXISTS storage; CREATE TABLE storage.buckets (id text PRIMARY KEY, public boolean);
INSERT INTO storage.buckets VALUES ('station-documents', false);
CREATE TABLE notifications (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, member_id uuid NOT NULL, type text NOT NULL,
  title text NOT NULL, body text, severity text NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')), subject_ref text,
  read_at timestamptz, pushed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX notifications_dedupe_idx ON notifications (member_id, type, subject_ref) NULLS NOT DISTINCT;
CREATE TABLE notification_prefs (member_id uuid NOT NULL, family text NOT NULL, enabled boolean NOT NULL DEFAULT true, PRIMARY KEY (member_id, family));
CREATE FUNCTION public.is_muted(p_member uuid, p_family text) RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $f$
BEGIN
  IF p_family IS NULL OR p_family NOT IN ('certs','gear','maint','events','tasks','shifts') THEN RAISE EXCEPTION 'is_muted: unknown family %', p_family; END IF;
  RETURN EXISTS (SELECT 1 FROM public.notification_prefs WHERE member_id = p_member AND family = p_family AND enabled = false);
END $f$;
REVOKE EXECUTE ON FUNCTION public.is_muted(uuid, text) FROM public, anon, authenticated;
CREATE TABLE action_items (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, text text NOT NULL, assigned_to uuid, status text DEFAULT 'open', due_date date);
CREATE FUNCTION public.notify_action_item_assigned() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $f$ BEGIN RETURN NULL; END $f$;
CREATE TRIGGER trg_action_item_assigned AFTER INSERT OR UPDATE OF assigned_to ON action_items FOR EACH ROW WHEN (new.assigned_to IS NOT NULL) EXECUTE FUNCTION notify_action_item_assigned();
CREATE POLICY "dept admins insert onboarding_items" ON onboarding_items FOR INSERT TO authenticated WITH CHECK (is_dept_admin() AND department_id = my_department_id());
CREATE POLICY "dept admins delete onboarding_items" ON onboarding_items FOR DELETE TO authenticated USING (is_dept_admin() AND department_id = my_department_id());
CREATE POLICY "dept admins update onboarding_progress" ON onboarding_progress FOR UPDATE TO authenticated USING (is_dept_admin() AND department_id = my_department_id()) WITH CHECK (is_dept_admin() AND department_id = my_department_id());
INSERT INTO members (department_id,email,name,access,status) VALUES ('00000000-0000-0000-0000-00000000000c','med@c','C Medic','{Member}','Active');
`;
async function base() {
  const d = await db0(); await d.exec(prob); await d.exec(tog); await d.exec(extra);
  await d.exec(liveSoi); await d.exec(livePis);
  const m = (await d.query(`select md5(pg_get_functiondef('public.set_onboarding_item(uuid,uuid,boolean)'::regprocedure)) a, md5(pg_get_functiondef('public.probation_item_states(uuid,uuid)'::regprocedure)) b`)).rows[0];
  if (m.a !== "99e6c6944216fe3811c6bbc365958e75" || m.b !== "0e91cf1d69f03a7b1dcb9234b7284357") throw new Error("live text did not reproduce the Step 0 md5s: " + JSON.stringify(m));
  return d;
}
const mode = process.argv[2] || "all";
let d = await base();
console.log("live md5s reproduced in PGlite: set_onboarding_item 99e6c694… · probation_item_states 0e91cf1d…");
const pre = (await d.query("select count(*)::int n from pg_policies where schemaname='public'")).rows[0].n;
console.log("state:", JSON.stringify((await d.exec(mig)).at(-1).rows), "· policies before", pre);
try { await d.exec(mig); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
try { await d.exec(ret); } catch (e) { console.log(show(e)); }
try { await d.exec(probRet); } catch (e) { console.log("probation RETEST after this migration:", brief(e)); }
if (mode === "base") process.exit(0);
const sub = (a, b, s = mig) => { if (!s.includes(a)) throw new Error("mutation anchor missing: " + a.slice(0, 80)); return s.replace(a, () => b); };
for (const [l, m] of [
  ["(a) cadet signs their own item (self-sign block removed from sign-off)", sub("  if p_member_id = v_me then\n    raise exception 'You can''t sign off your own onboarding — a mentor or officer does.';\n  end if;\n  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then\n    raise exception 'That member is not in your department.';\n  end if;\n  select * into v_item",
     "  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then\n    raise exception 'That member is not in your department.';\n  end if;\n  select * into v_item")],
  ["(b) officer signs a person item they aren't assigned (person gate off)", sub("    select case when i.approver_kind = 'person' then i.approver_member_id = public.my_member_id()", "    select case when i.approver_kind = 'person' then coalesce(public.is_canmanage(), false)")],
  ["(c) document item signed with p_doc_checked = false", sub("  if v_item.requires_doc and not coalesce(p_doc_checked, false) then", "  if false and v_item.requires_doc and not coalesce(p_doc_checked, false) then")],
  ["(d) config by a non-DA", sub("  if v_dept is null or not coalesce(public.is_dept_admin(), false) then\n    raise exception 'Only a Department Admin can set who signs off an item.';", "  if v_dept is null then\n    raise exception 'Only a Department Admin can set who signs off an item.';").replace("     OR position('is_dept_admin()' in pg_get_functiondef('public.set_onboarding_item_config(uuid,boolean,text,text,uuid)'::regprocedure)) = 0\n", "")],
  ["(e) a person approver from another department", sub("         where id = p_approver_member_id and department_id = v_dept and status in ('Active', 'Probationary')) then", "         where id = p_approver_member_id and status in ('Active', 'Probationary')) then")],
  ["(f) person with a NULL member / tier with a member (shape CHECK dropped)", sub("    ADD CONSTRAINT onboarding_items_approver_shape_chk CHECK (\n      (approver_kind = 'person' AND approver_member_id IS NOT NULL AND approver_role IS NULL)\n      OR (approver_kind = 'tier' AND approver_member_id IS NULL)),", "    ADD CONSTRAINT onboarding_items_approver_shape_chk CHECK (true),")],
  ["(g) a stored file: a proof_path column added", sub("    ADD COLUMN doc_checked_by uuid REFERENCES public.members(id) ON DELETE SET NULL;", "    ADD COLUMN doc_checked_by uuid REFERENCES public.members(id) ON DELETE SET NULL,\n    ADD COLUMN proof_path text;")],
  ["(g2) a stored file: a bucket created", sub("  -- ---------------------------------------------------------------- functions\n", "  INSERT INTO storage.buckets VALUES ('onboarding-docs', false);\n  -- ---------------------------------------------------------------- functions\n")],
  ["(h) old path still ticks a configured item done (R1 guard removed)", sub("  if v_done and exists (select 1 from public.onboarding_items where id = p_item_id", "  if false and exists (select 1 from public.onboarding_items where id = p_item_id").replace("     OR position('requires_doc' in pg_get_functiondef('public.set_onboarding_item(uuid,uuid,boolean)'::regprocedure)) = 0\n", "")],
  ["(i) the old self-sign block reworded", sub("  if p_member_id = v_me then\n    raise exception 'You can''t sign off your own onboarding — a mentor or officer does.';\n  end if;\n  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then\n    raise exception 'That member is not in your department.';\n  end if;\n  if not exists (select 1 from public.onboarding_items where id = p_item_id and department_id = v_dept) then",
     "  if p_member_id = v_me then\n    raise exception 'You can''t sign off your own onboarding.';\n  end if;\n  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then\n    raise exception 'That member is not in your department.';\n  end if;\n  if not exists (select 1 from public.onboarding_items where id = p_item_id and department_id = v_dept) then")],
  ["(j) client keeps INSERT / UPDATE on progress (R2 revoke dropped)", sub("  REVOKE INSERT, UPDATE ON public.onboarding_progress FROM authenticated;\n", "")],
  ["(k) config columns left client-writable", sub("  REVOKE INSERT, UPDATE ON public.onboarding_items FROM authenticated;\n", "")],
  ["(l2) mark-ready overwrites an earlier mark (not idempotent)", sub("  if found and (v_row.done or v_row.ready_at is not null) then\n    return v_row;\n  end if;\n", "")],
  ["(l) mark-ready completes the item", sub("  values (v_dept, v_me, p_item_id, false, now(), v_me)", "  values (v_dept, v_me, p_item_id, true, now(), v_me)").replace("     set ready_at = excluded.ready_at, ready_by = excluded.ready_by\n", "     set ready_at = excluded.ready_at, ready_by = excluded.ready_by, done = true\n")],
  ["(m) mark-ready on any member (a member argument)", sub("CREATE OR REPLACE FUNCTION public.mark_onboarding_ready(p_item_id uuid)", "CREATE OR REPLACE FUNCTION public.mark_onboarding_ready(p_item_id uuid, p_member_id uuid DEFAULT NULL)").replaceAll("'public.mark_onboarding_ready(uuid)'", "'public.mark_onboarding_ready(uuid,uuid)'")],
  ["(n) an inactive person approver reads open (approver_not_set dropped)", sub("                                               when not coalesce(ap.resolvable, true) then 'approver_not_set'\n", "")],
  ["(o) tier gate ignores the tier (any canmanage)", sub("                when i.approver_role is not null then exists (select 1 from public.members m\n                       where m.id = public.my_member_id() and m.access && array[i.approver_role])", "                when i.approver_role is not null then coalesce(public.is_canmanage(), true)")],
  ["(p) ping ignores the mute", sub("  if public.is_muted(p_member, 'tasks') then return; end if;\n", "").replace("     OR position('is_muted(p_member, ''tasks'')' in pg_get_functiondef('public.onboarding_ping(uuid,uuid,text,text,text,text)'::regprocedure)) = 0\n", "")],
  ["(q) re-save re-pings (IS DISTINCT FROM guard dropped)", sub("  if v_kind = 'person' and v_item.approver_member_id is distinct from p_approver_member_id then", "  if v_kind = 'person' then").replace("'onb-approver:' || p_item_id::text);", "'onb-approver:' || p_item_id::text || ':' || clock_timestamp()::text);")],
  ["(r) queue shows a plain member every item", sub("     and (v_lead or public.onboarding_caller_can_sign(i.id))", "     and true")],
  ["(s) config accepts an hours item (non-manual)", sub("  if v_item.kind <> 'manual' or v_item.is_mentor then\n    raise exception 'Only a checklist item an officer checks off can have an approver or a document check.';\n  end if;\n", "").replace("    ADD CONSTRAINT onboarding_items_config_manual_chk CHECK (\n      (kind = 'manual' AND NOT is_mentor) OR (NOT requires_doc AND approver_kind = 'tier' AND approver_role IS NULL));", "    ADD CONSTRAINT onboarding_items_config_manual_chk CHECK (true);")],
  ["(t) the locked verification token added to a function", sub("-- B4C:onboarding_item_config — the item's approver signs", "-- B4C:onboarding_item_config — (" + "veri" + "fied" + " untouched) the item's approver signs")],
]) { const x = await base(); try { await x.exec(m); try { await x.exec(ret); console.log(l, "-> NOT CAUGHT"); } catch (e) { console.log(l, "->", brief(e) || e.message.split("\n")[0]); } } catch (e) { console.log(l, "-> migration", e.message.split("\n")[0]); } }
