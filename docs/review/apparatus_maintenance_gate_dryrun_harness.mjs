import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "fs";
const R = "/Users/ashleabullington/projects/Bullington-VFDAIAgent/sql/";
const src = readFileSync(new URL("./app.mjs", import.meta.url), "utf8");
const mock0 = src.match(/const mock = `([\s\S]*?)`;/)[1].replaceAll("${A}", "00000000-0000-0000-0000-00000000000a").replaceAll("${B}", "00000000-0000-0000-0000-00000000000b");
const appFix = readFileSync(R + "apparatus_update_gate_2026-10-18.sql", "utf8");
const mig = readFileSync(R + "apparatus_maintenance_gate_DRAFT.sql", "utf8"), ret = readFileSync(R + "apparatus_maintenance_gate_RETEST.sql", "utf8");
const appRet = readFileSync(R + "apparatus_update_gate_RETEST.sql", "utf8");
// the live maintenance shape: rig_id / task / cadence / last_done_at; INSERT + DELETE ops-gated; UPDATE member-wide (no WITH CHECK)
const mock = mock0.replace("CREATE TABLE apparatus_maintenance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, note text);",
  `CREATE TABLE apparatus_maintenance (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, rig_id uuid, task text NOT NULL, cadence text, last_done_at timestamptz);
   CREATE TABLE apparatus_maintenance_log (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL, maintenance_id uuid, apparatus_id uuid, task text, done_at timestamptz, done_by uuid, done_by_name text, notes text, cost numeric);
   ALTER TABLE apparatus_maintenance_log ENABLE ROW LEVEL SECURITY;
   CREATE POLICY aml_read ON apparatus_maintenance_log FOR SELECT TO authenticated USING (department_id = my_department_id());
   CREATE POLICY aml_insert ON apparatus_maintenance_log FOR INSERT TO authenticated WITH CHECK ((department_id = my_department_id()) AND is_canmanage_ops());
   CREATE POLICY "dept reads apparatus_maintenance" ON apparatus_maintenance FOR SELECT TO authenticated USING (department_id = my_department_id());
   CREATE POLICY "leaders add apparatus_maintenance" ON apparatus_maintenance FOR INSERT TO authenticated WITH CHECK ((department_id = my_department_id()) AND is_canmanage_ops());
   CREATE POLICY "leaders delete apparatus_maintenance" ON apparatus_maintenance FOR DELETE TO authenticated USING ((department_id = my_department_id()) AND is_canmanage_ops());`);
const show = (e) => e.message.split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const brief = (e) => e.message.split("\n").filter((l) => /FAIL|passed/.test(l)).join(" | ");
async function db0(withFix = true) { const d = new PGlite(); await d.exec(mock); await d.exec(appFix); return d; }
let d = await db0();
console.log("state:", JSON.stringify((await d.exec(mig)).at(-1).rows));
try { await d.exec(mig); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); }
try { await d.exec(ret); } catch (e) { console.log(show(e)); }
try { await d.exec(appRet); } catch (e) { console.log("apparatus RETEST still:", brief(e)); }
const d0 = await db0(); try { await d0.exec(ret); } catch (e) { console.log("BEFORE the fix ->", brief(e)); }
const sub = (a, b) => { if (!mig.includes(a)) throw new Error("anchor missing: " + a.slice(0, 60)); return mig.replace(a, () => b); };
for (const [l, m, pre] of [
  ["MA new policy dept-only (gate dropped)", sub("    USING (department_id = public.my_department_id() AND public.is_canmanage_ops())\n    WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage_ops());", "    USING (department_id = public.my_department_id())\n    WITH CHECK (department_id = public.my_department_id());").replace(/AND position\('is_canmanage_ops\(\)' in qual\) > 0\n\s+AND position\('my_department_id\(\)' in with_check\) > 0 AND position\('is_canmanage_ops\(\)' in with_check\) > 0/, "")],
  ["MB old policy left in place", sub('  DROP POLICY "members update apparatus_maintenance" ON public.apparatus_maintenance;\n', "")],
  ["MC another table's policy touched (the apparatus fix)", sub("  -- ---------------------------------------------------------------- post-conditions", "  DROP POLICY \"ops update apparatus\" ON public.apparatus;\n  -- ---------------------------------------------------------------- post-conditions")],
  ["MD an INVOKER maintenance writer present", mig, "CREATE FUNCTION bad_writer() RETURNS void LANGUAGE sql AS $$ update public.apparatus_maintenance set task = 'x' $$;"],
]) { const x = await db0(); if (pre) await x.exec(pre); try { await x.exec(m); try { await x.exec(ret); } catch (e) { console.log(l, "->", brief(e)); } } catch (e) { console.log(l, "-> migration", e.message.split("\n")[0]); } }
