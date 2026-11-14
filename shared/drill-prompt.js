// shared/drill-prompt.js — THE drill-plan generator: its system prompt, the reply parser, and the mapping of the model's plan
// object onto drill_plans.content. Weekly Training Content slice 5 (docs/design/training_content_step0.md §5.3): one
// definition, imported by the client's "Draft with AI" (src/App.jsx) and, from slice 7, by the weekly cron — the WS-4b
// "imported, not copied" rule. DRILL_PLAN_SYSTEM, strList, oneLine, stepToRun and drillPlanToContent are MOVED here from
// src/App.jsx verbatim (docs/review/weekly_ui_test.mjs pins them byte-identical to the base). No imports: plain ESM that
// runs in the browser bundle and in a Vercel function alike.

export const DRILL_PLAN_SYSTEM = "You are an experienced volunteer fire/EMS training officer drafting a SAFE, practical drill plan. You are NOT a substitute for certified instruction, medical direction, or the AHJ. Defer to local protocols, state requirements, and medical direction. For any high-risk evolution (live fire, hazmat, technical rescue, invasive medical skills), note in safetyNotes that it requires a qualified instructor and assigned safety officer plus authorization. Respond with ONLY one valid JSON object, no markdown, no code fences. Schema: {\"summary\":string,\"objectives\":string[],\"durationMin\":number,\"equipment\":string[],\"safetyNotes\":string[],\"steps\":[{\"title\":string,\"minutes\":number,\"actions\":string[]}],\"talkingPoints\":string[],\"debriefQuestions\":string[],\"evaluationChecklist\":string[]}. Keep arrays to 3-6 concise items. Each step's \"actions\" are short, concrete, imperative bullet points a crew member can follow at a glance — NOT prose sentences. 3-6 actions per step. Realistic for the stated staffing and apparatus.";
export const strList = (a) => (Array.isArray(a) ? a.filter((x) => x != null && String(x).trim() !== "").map((x) => String(x)) : []);
export const oneLine = (x) => String(x ?? "").replace(/\s+/g, " ").trim();
/* A drafted step { title, minutes, actions[] } → the stored run_of_show entry { t: "Title — N min", d: "a; b; c" }. Shared by
   drillPlanToContent and the per-step rewrite so the two cannot drift. Single-line and pipe-free so it ROUND-TRIPS: the
   editor writes "t | d" and splits back at the first "|" (runToText / runFromText), and libRowToPacket reads "— N min" as
   an integer. For a normal step this is byte-for-byte what drillPlanToContent always produced. */
export function stepToRun(st) {
  const title = oneLine(st.title || "Step").replace(/\|/g, "/") || "Step";
  const mins = Number(st.minutes) > 0 ? Math.round(Number(st.minutes)) : 0;
  return { t: title + (mins ? ` — ${mins} min` : ""), d: strList(st.actions).map(oneLine).filter(Boolean).join("; ") || (typeof st.detail === "string" ? oneLine(st.detail) : "") };
}
export function drillPlanToContent(plan) {
  const p = plan || {};
  return {
    summary: typeof p.summary === "string" ? p.summary : "",
    objectives: strList(p.objectives),
    run_of_show: (Array.isArray(p.steps) ? p.steps : []).filter((s) => s && typeof s === "object").map(stepToRun),
    materials: strList(p.equipment),
    safety: strList(p.safetyNotes),
  };
}

/* The model's reply → the plan object, or null. FAIL-CLOSED, the client's draft() parse made reusable: strip code fences;
   JSON.parse the whole reply, else the first {...} span; anything that is not a plain object (null, an array, a string,
   unparseable) → null, and the caller writes nothing. */
export function parseDrillPlanReply(text) {
  const t = String(text ?? "").replace(/```json|```/g, "").trim();
  let plan = null;
  try { plan = JSON.parse(t); } catch { const m = t.match(/\{[\s\S]*\}/); try { plan = m ? JSON.parse(m[0]) : null; } catch { plan = null; } }
  return plan && typeof plan === "object" && !Array.isArray(plan) ? plan : null;
}
