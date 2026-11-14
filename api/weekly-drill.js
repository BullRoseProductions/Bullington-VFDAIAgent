// Vercel Cron: the weekly AI drill draft (Weekly Training Content slice 7; docs/design/training_content_step0.md §5.2–§5.7).
//
// For each department whose Department Admin turned on "Weekly AI drill draft", write ONE seasonal drill plan per week into
// its Training Plans as a DRAFT, source ai_weekly, with no author. An officer must approve it before it can be used. That is
// a database law, not this file's promise: the human-approval trigger refuses any approval without a member caller, and a
// service-role session has none (slice 4, live RETEST 15/0/0).
//
// SCHEDULE (vercel.json): "0 0-5 * * 1", hourly 00:00–05:00 UTC Monday = Sunday 18:00–23:00 Central. Six chances a week,
// finished before the Monday 12:00 UTC digest, so its "waiting for an officer's review" line is true when it says so.
// Vercel crons don't retry; the slots are the retry.
//
// EACH SLOT, PER OPTED-IN DEPARTMENT:
//   1. Already has this week's draft (drill_plans.weekly_key)? → "exists", nothing spent. That is checked FIRST, so a
//      finished week costs one read per slot and no model call.
//   2. Seed: only data the department already has, and only what the DA's confirm lists (shared/weekly-drill.js).
//   3. inputProblem (imported from api/claude.js): the same 413-class caps as a member's call, before any spend.
//   4. record_dept_ai_call: the department's 1,500/day backstop, the same ceiling a member meets. Refused or erroring →
//      "cap", no model call (fail closed).
//   5. callAnthropic (api/_anthropic.js, the same provider call /api/claude makes), then parseDrillPlanReply (fail-closed,
//      shared with the client). A malformed reply writes nothing; the next slot retries.
//   6. put_weekly_drill_draft: re-checks the toggle at write time (off wins → "disabled"), always a draft, ON CONFLICT DO
//      NOTHING (a racing slot → "exists").
//
// AUTH: requireCron (api/_cron.js, imported, untouched): the cron secret's bearer header only; this file never reads it. The service-role key is used for the
// reads and the two service_role-only RPCs; it never leaves this function.
//
// HONESTY (shared/cron-outcome.js weeklyDrillOutcome): db → 503; gen:<n> / write / cap → 500; terse body, counts only.
// Logs carry ids and step names: "[weekly-drill] dept=<id> step=gen status=<code>". No prompts, model text or names.
// ?dry=1 reads and composes the prompts and returns them by department id; it spends nothing and writes nothing.
//
// ENV (by name): SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (sb_secret_), ANTHROPIC_API_KEY; the cron secret via requireCron.
import { createClient } from "@supabase/supabase-js";
import { requireCron } from "./_cron.js";
import { inputProblem } from "./claude.js";
import { callAnthropic } from "./_anthropic.js";
import { DRILL_PLAN_SYSTEM, parseDrillPlanReply } from "../shared/drill-prompt.js";
import { weeklyKeyFor, weeklySeed, composeWeeklyUser, weeklyDraftArgs, addDaysISO, SEED_WEEKS } from "../shared/weekly-drill.js";
import { weeklyDrillOutcome } from "../shared/cron-outcome.js";

export const MAX_PER_RUN = 12;     // departments generated per slot; the rest are "deferred" to the next slot
export const CONCURRENCY = 4;      // model calls in flight at once

const logStep = (deptId, step, status) => console.error(`[weekly-drill] dept=${deptId} step=${step} status=${status}`);

// One department, steps 3–6. → { outcome: "inserted" | "exists" | "disabled" | "gen" | "write" | "cap" }
export async function draftForDepartment(sb, anthropicKey, dept, seed, week) {
  const user = composeWeeklyUser(seed);
  if (inputProblem({ system: DRILL_PLAN_SYSTEM, user })) { logStep(dept.id, "gen", "input"); return { outcome: "gen" }; }
  const { data: cap, error: capErr } = await sb.rpc("record_dept_ai_call", { p_department_id: dept.id, p_route: "claude" });
  if (capErr || !cap || cap.allowed !== true) { logStep(dept.id, "cap", capErr ? "error" : "refused"); return { outcome: "cap" }; }
  let plan = null;
  try {
    const out = await callAnthropic({ key: anthropicKey, system: DRILL_PLAN_SYSTEM, user, logTag: "api/weekly-drill" });
    if (!out.ok) { logStep(dept.id, "gen", out.status); return { outcome: "gen" }; }
    plan = parseDrillPlanReply(out.text);
    if (!plan) { logStep(dept.id, "gen", "parse"); return { outcome: "gen" }; }
  } catch {
    logStep(dept.id, "gen", "network");
    return { outcome: "gen" };
  }
  const { data, error } = await sb.rpc("put_weekly_drill_draft", weeklyDraftArgs(plan, { deptId: dept.id, key: week.key, monday: week.monday, category: seed.chosen }));
  if (error || !data || !["inserted", "exists", "disabled"].includes(data.result)) { logStep(dept.id, "write", "error"); return { outcome: "write" }; }
  return { outcome: data.result };
}

const byDept = (rows, id) => (rows || []).filter((r) => r.department_id === id);

export default async function handler(req, res) {
  if (!requireCron(req, res)) return;
  const supabaseUrl = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const missing = [!supabaseUrl && "SUPABASE_URL", !serviceKey && "SUPABASE_SERVICE_ROLE_KEY", !anthropicKey && "ANTHROPIC_API_KEY"].filter(Boolean);
  if (missing.length) return res.status(500).json({ error: `Missing ${missing.join(", ")}` });
  const isDry = ["1", "true", "yes", "on"].includes(String(req.query?.dry ?? "").toLowerCase());
  const week = weeklyKeyFor(new Date());
  const sb = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false } });

  // Reads: who opted in, who is already done this week, then the seed for the rest. Any failure → 503, nothing spent.
  let exists = 0, deferred = 0, thisRun = [], seeds = new Map();
  try {
    const d = await sb.from("departments").select("id, city").eq("weekly_drill_draft_enabled", true).order("id");
    if (d.error) throw new Error(`departments: ${d.error.message}`);
    const depts = d.data || [];
    if (depts.length) {
      const ids = depts.map((x) => x.id);
      const w = await sb.from("drill_plans").select("department_id").eq("weekly_key", week.key).in("department_id", ids);
      if (w.error) throw new Error(`weekly drafts: ${w.error.message}`);
      const done = new Set((w.data || []).map((r) => r.department_id));
      exists = depts.filter((x) => done.has(x.id)).length;
      const pending = depts.filter((x) => !done.has(x.id));
      thisRun = pending.slice(0, MAX_PER_RUN);
      deferred = pending.length - thisRun.length;
    }
    if (thisRun.length) {
      const runIds = thisRun.map((x) => x.id);
      const since = addDaysISO(week.today, -7 * SEED_WEEKS);
      const [plans, sessions, drills, members] = await Promise.all([
        sb.from("training_plans").select("department_id, name, cadence, last_iso").in("department_id", runIds).order("name"),
        sb.from("training_sessions").select("department_id, title, date").in("department_id", runIds).gte("date", since),
        sb.from("drill_plans").select("department_id, title, created_at").in("department_id", runIds).gte("created_at", `${since}T00:00:00Z`),
        sb.from("members").select("id, department_id, access, status").in("department_id", runIds),
      ]);
      for (const [name, r] of [["training_plans", plans], ["training_sessions", sessions], ["drill_plans", drills], ["members", members]])
        if (r.error) throw new Error(`${name}: ${r.error.message}`);
      for (const dept of thisRun)
        seeds.set(dept.id, weeklySeed({ dept, plans: byDept(plans.data, dept.id), sessions: byDept(sessions.data, dept.id), drills: byDept(drills.data, dept.id), members: byDept(members.data, dept.id) }, week));
    }
  } catch (e) {
    console.error(`[weekly-drill] step=db week=${week.key} ${String(e?.message || e)}`);
    const o = weeklyDrillOutcome({ dbError: true });
    return res.status(o.status).json({ ok: false, week: week.key, failed: o.failed });
  }

  if (isDry) {
    return res.status(200).json({ ok: true, dryRun: true, note: "No backstop count, no model call, no write.", week: week.key, exists, deferred,
      departments: thisRun.map((dept) => ({ id: dept.id, category: seeds.get(dept.id).chosen, user: composeWeeklyUser(seeds.get(dept.id)) })) });
  }

  const results = Array.from({ length: exists }, () => ({ outcome: "exists" }));
  for (let i = 0; i < thisRun.length; i += CONCURRENCY) {
    const chunk = thisRun.slice(i, i + CONCURRENCY);
    results.push(...await Promise.all(chunk.map(async (dept) => {
      try { return await draftForDepartment(sb, anthropicKey, dept, seeds.get(dept.id), week); }
      catch { logStep(dept.id, "write", "error"); return { outcome: "write" }; }   // an RPC client that threw: nothing confirmed written
    })));
  }
  const o = weeklyDrillOutcome({ results, deferred });
  const { status, failed, ...counts } = o;
  if (status !== 200) {
    console.error(`[weekly-drill] FAILED ${status} week=${week.key} steps=${failed.join(",")}`);
    return res.status(status).json({ ok: false, week: week.key, failed, ...counts });
  }
  return res.status(200).json({ ok: true, week: week.key, ...counts });
}
