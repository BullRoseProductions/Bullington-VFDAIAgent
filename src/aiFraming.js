/* AI FRAMING (Bret's list). Pure helpers, so each rule is one testable function instead of a few lines buried in a
   screen. Nothing here reads the database or calls the AI: every input is data the screen has already loaded. */

import { headcount } from "../shared/members.js";

/* ---- 1. What counts as an SOP ----
   THE CLASSIFIER IS documents.type, the "Document type" the uploader picks in Station Documents (DOC_TYPES: "SOP / SOG",
   Policy, Handbook, Forms, Agreement, Reference, Other). A document is an SOP/SOG when that type names SOP or SOG — the
   current "SOP / SOG" choice and the bare "SOP" / "SOG" older rows carry. Everything else (forms, checklists filed as
   Forms or Reference, handbooks, policies) is a station document, and is still read; it is just not counted as an SOP.
   The file NAME is never used: a guess from "checklist.pdf" would be a second, invisible classifier. */
export const isSopType = (type) => /\bSO[PG]S?\b/i.test(String(type || ""));

/* docs: [{ name, type }] — the documents the assistant is actually reading. → the header line's counts and words. */
export function groundingSummary(docs) {
  const list = Array.isArray(docs) ? docs : [];
  const sop = list.filter((d) => isSopType(d.type)).length;
  const other = list.length - sop;
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  let text;
  if (sop > 0 && other > 0) text = `${plural(sop, "SOP/SOG document", "SOP/SOG documents")} and ${plural(other, "other station document", "other station documents")}`;
  else if (sop > 0) text = plural(sop, "SOP/SOG document", "SOP/SOG documents");
  else text = plural(other, "station document", "station documents");
  return { total: list.length, sop, other, text };
}

/* ---- 2. The Station Q&A wait (~15–20 s, no streaming in /api/claude) ----
   Staged lines by elapsed time. They describe what is genuinely happening in order — the question and the documents go
   up together, the model reads them, then writes — and never claim a percentage or a finish time they can't know. */
export function qaStage(elapsedMs, docCount) {
  const s = Math.max(0, Number(elapsedMs) || 0) / 1000;
  if (s < 3) return "Sending your question…";
  if (s < 8) return docCount > 0 ? `Reading your ${docCount} station document${docCount === 1 ? "" : "s"}…` : "Working through your question…";
  if (s < 18) return "Writing the answer…";
  return "Still writing — longer answers can take up to half a minute.";
}

/* ---- 3. Drafter prefill ----
   From what App already holds: the department row, the roster, the loaded sessions. Nothing per keystroke, nothing new
   fetched. A value that isn't known comes back "" / null so the field keeps its own default. */
const sessionDate = (x) => (Number.isFinite(x?.y) && Number.isFinite(x?.m) && Number.isFinite(x?.d) ? new Date(x.y, x.m, x.d) : null);
const fmtDay = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
const fmtTime = (t) => {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(t || ""));
  if (!m) return "";
  const h = Number(m[1]); const mm = m[2];
  return ` at ${((h + 11) % 12) + 1}:${mm} ${h < 12 ? "AM" : "PM"}`;
};
/* The next live, everyone-audience session from today on (leadership-only sessions are never named in public copy;
   cancelled and done ones are skipped). kind: "meeting" | "training". */
export function nextSession(sessions, kind, today = new Date()) {
  const start = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const want = kind === "meeting";
  return (sessions || [])
    .filter((x) => x && !x.cancelled && !x.done && (x.audience || "everyone") === "everyone" && !!x.isMeeting === want)
    .map((x) => ({ x, d: sessionDate(x) }))
    .filter(({ d }) => d && d >= start)
    .sort((a, b) => a.d - b.d || String(a.x.startTime || "").localeCompare(String(b.x.startTime || "")))[0] || null;
}
export function draftPrefill({ dept, members, sessions, today = new Date() } = {}) {
  const counted = Array.isArray(members) && members.length ? headcount(members).counted : 0;
  const meet = nextSession(sessions, "meeting", today);
  const train = nextSession(sessions, "training", today);
  const dates = [
    meet ? `Our next meeting: ${fmtDay(meet.d)}${fmtTime(meet.x.startTime)}` : "",
    train ? `Our next training night: ${fmtDay(train.d)}${fmtTime(train.x.startTime)}${train.x.title ? ` (${train.x.title})` : ""}` : "",
  ].filter(Boolean).join("\n");
  return {
    town: String(dept?.city || "").trim(),
    size: counted > 0 ? String(counted) : "",
    localDates: dates,
    // The PR caption topic: the next public training night, which is the post a department most often wants.
    topic: train ? `Training night ${fmtDay(train.d)}${train.x.title ? ` — ${train.x.title}` : ""}` : "",
  };
}
