# B4C — Training Plan "Quick Run Sheet" + toggle (build brief)

**For Claude Code, driven by Ashlea.** Adds a skimmable "Quick Run Sheet" to AI drill plans and a
Quick/Full toggle in the plan viewer. **No AI-prompt change, no database change** — the run sheet is
*derived from the structured plan the AI already returns*, so it can never drift from the full plan.
Two small front-end edits in `src/App.jsx`.

## Ground rules (unchanged)
- One step at a time; show the diff before applying; wait for the OK; never apply without showing.
- Branch → commit → merge --no-ff → push, git one command at a time.
- Verify anchors against the live file first (line numbers here are approximate; match on the code strings).

## Why this is safe
- The drill plan is generated as a structured object (`summary`, `durationMin`, `equipment`, `safetyNotes`, `steps:[{title,detail,minutes}]`, `talkingPoints`, `debriefQuestions`, `evaluationChecklist`). `serializeDrillPlan()` turns it into the saved `ai_text`. We only add a condensed section built from those same fields, and a viewer toggle. Both live in the one saved plan.
- Backward compatible: plans generated before this change have no "Quick Run Sheet" section, so the viewer just shows them in full with no toggle.

---

## STEP 1 — serializeDrillPlan: prepend a "Quick Run Sheet" section

**Anchor:** the whole existing function:
```jsx
function serializeDrillPlan(plan, topic) {
  const L = [`## ${topic || "Drill"} — Drill Plan`];
  if (plan.summary) L.push("", plan.summary);
  if (plan.durationMin) L.push("", `Duration: ${plan.durationMin} minutes`);
  const sec = (title, items) => { if (Array.isArray(items) && items.length) L.push("", `## ${title}`, ...items.map((i) => `- ${i}`)); };
  sec("Safety notes", plan.safetyNotes);
  sec("Equipment", plan.equipment);
  if (Array.isArray(plan.steps) && plan.steps.length) { L.push("", "## Drill steps"); plan.steps.forEach((s, i) => L.push(`${i + 1}. **${s.title}**${s.minutes ? ` (${s.minutes} min)` : ""}${s.detail ? ` — ${s.detail}` : ""}`)); }
  sec("Instructor talking points", plan.talkingPoints);
  sec("Debrief questions", plan.debriefQuestions);
  sec("Evaluation checklist", plan.evaluationChecklist);
  return L.join("\n");
}
```
**Replace it with** (adds a run-sheet block, prepended so it's at the top; the rest is byte-for-byte the same):
```jsx
function serializeDrillPlan(plan, topic) {
  // Quick Run Sheet — the skimmable "just run it" version, built from the same structured plan.
  // NOTE: use ONLY bold sub-labels (**...**) inside this block, never `## ` — the viewer splits the
  // saved text on `## ` headings to separate the run sheet from the full plan.
  const R = ["## Quick Run Sheet"];
  if (plan.summary) R.push("", plan.summary);
  if (Array.isArray(plan.steps) && plan.steps.length) {
    R.push("", `**Run it${plan.durationMin ? ` (${plan.durationMin} min total)` : ""}:**`);
    plan.steps.forEach((s, i) => R.push(`${i + 1}. ${s.title}${s.minutes ? ` — ${s.minutes} min` : ""}`));
  }
  if (Array.isArray(plan.safetyNotes) && plan.safetyNotes.length) {
    R.push("", "**Safety first:**", ...plan.safetyNotes.map((i) => `- ${i}`));
  }
  if (Array.isArray(plan.evaluationChecklist) && plan.evaluationChecklist.length) {
    R.push("", "**You're done when:**", ...plan.evaluationChecklist.map((i) => `- ${i}`));
  }

  const L = [...R, "", `## ${topic || "Drill"} — Drill Plan`];
  if (plan.summary) L.push("", plan.summary);
  if (plan.durationMin) L.push("", `Duration: ${plan.durationMin} minutes`);
  const sec = (title, items) => { if (Array.isArray(items) && items.length) L.push("", `## ${title}`, ...items.map((i) => `- ${i}`)); };
  sec("Safety notes", plan.safetyNotes);
  sec("Equipment", plan.equipment);
  if (Array.isArray(plan.steps) && plan.steps.length) { L.push("", "## Drill steps"); plan.steps.forEach((s, i) => L.push(`${i + 1}. **${s.title}**${s.minutes ? ` (${s.minutes} min)` : ""}${s.detail ? ` — ${s.detail}` : ""}`)); }
  sec("Instructor talking points", plan.talkingPoints);
  sec("Debrief questions", plan.debriefQuestions);
  sec("Evaluation checklist", plan.evaluationChecklist);
  return L.join("\n");
}
```

**Step 1 verify:** `npm run build` clean. Commit. (Nothing renders differently yet — this only changes newly generated plans' saved text.)

---

## STEP 2 — AiPlanViewer: Quick/Full toggle, default Quick

**Anchor:** the existing viewer:
```jsx
function AiPlanViewer({ S, plan, onClose }) {
  if (!plan) return null;
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...FS.card, maxWidth: 720, width: "100%", padding: "20px 22px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10 }}>
          <div style={{ ...FS.kicker, marginBottom: 0 }}>{plan.title || "AI-drafted plan"}</div>
          <button style={{ ...FS.btn, padding: "6px 10px", flexShrink: 0 }} onClick={onClose}><X size={14} color={FIRE.btnIcon} /> Close</button>
        </div>
        <Disclaimer S={S} compact dark />
        <RichOutput S={S} text={plan.ai_text || ""} dark />
      </div>
    </div>
  );
}
```
**Replace with:**
```jsx
function AiPlanViewer({ S, plan, onClose }) {
  const [view, setView] = useState("quick");   // 'quick' | 'full' — hook BEFORE the early return
  if (!plan) return null;
  // Split the saved text on `## ` headings; isolate the "Quick Run Sheet" block from the rest.
  const full = plan.ai_text || "";
  const blocks = full.split(/\n(?=#{1,6}\s+)/);
  const isRun = (b) => /^#{1,6}\s+Quick Run Sheet\b/i.test(b.trim());
  const runSheet = blocks.filter(isRun).join("\n").trim();
  const rest = blocks.filter((b) => !isRun(b)).join("\n").trim();
  const hasRun = !!runSheet;
  const shown = !hasRun ? full : (view === "quick" ? runSheet : rest);
  const tab = (key, label) => (
    <button onClick={() => setView(key)} style={{ ...FS.btn, ...(view === key ? { borderColor: FIRE.red, color: FIRE.textPrimary } : {}) }}>{label}</button>
  );
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...FS.card, maxWidth: 720, width: "100%", padding: "20px 22px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10 }}>
          <div style={{ ...FS.kicker, marginBottom: 0 }}>{plan.title || "AI-drafted plan"}</div>
          <button style={{ ...FS.btn, padding: "6px 10px", flexShrink: 0 }} onClick={onClose}><X size={14} color={FIRE.btnIcon} /> Close</button>
        </div>
        {hasRun && <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>{tab("quick", "Quick run sheet")}{tab("full", "Full plan")}</div>}
        <Disclaimer S={S} compact dark />
        <RichOutput S={S} text={shown} dark />
      </div>
    </div>
  );
}
```

**Step 2 verify:** `npm run build` clean. Commit, merge --no-ff, push.

---

## Testing (live deploy — generation is serverless, so a NEW plan is needed to see the run sheet)
1. On the live deploy, open the AI drill planner and **generate a new plan**, attach it to a training date.
2. Open that plan (as the admin, and/or as a member on the training date). Expect: it opens on **Quick run sheet** — goal, numbered steps with times, safety bullets, "you're done when" — with a **Full plan** toggle that shows the complete plan (talking points, debrief, step details).
3. Open an **older** plan (made before this change): it should render in full with **no toggle** — backward compatible, nothing broken.
4. Confirm the run sheet and full plan describe the *same* drill (they're derived from one source, so they can't disagree).

## Notes / optional follow-ups
- The admin's **creation preview** (inside the AI drill planner, before attaching) isn't changed here — the toggle lives in the saved-plan viewer. If you want the same toggle on the creation preview later, it's a small add; say so and I'll spec it.
- If "tight" ever feels *too* tight (e.g., you want one line of the step detail back), it's a one-line tweak in Step 1.
