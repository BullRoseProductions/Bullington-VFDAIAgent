// Vercel serverless function — "Ask B4C", the member assistant (Phase 1: read-only + SOPs + navigation).
//
// THE SAFETY PROPERTY, and the reason for the shape. The model is offered a FIXED allowlist of read-only tools. When it
// calls one, THIS server runs it — with a Supabase client built from the CALLER'S OWN bearer token (anon key + their
// Authorization), so RLS and the SECURITY DEFINER self-scoping (my_member_id() / my_department_id()) bound every read to
// that member and their department. No service-role key anywhere on this path, no free-form SQL, no table the model can
// name. And NO TOOL TAKES A MEMBER OR DEPARTMENT ID: every one answers "me" by construction, so there is no argument the
// model could fill in to reach someone else. Each tool wraps the exact read the matching member screen already makes:
//   am_i_checked_in -> my_open_station_session()            (StationClockCard / StationHours)
//   my_hours        -> my_station_shifts(p_from, p_to)      (StationHours + myHoursTotals: credited = verified only)
//   my_certs        -> certs + cert_submissions, own rows   (PersonalView / CertProposals + certStatus)
//   my_schedule     -> training_sessions (+ the audience rule the member "Up next" list uses)
//   my_attendance   -> training_sessions + session_attendance (the Training member view's rolling-90-day rate)
//   search_sops     -> documents.content_text for my department (the Station Q&A grounding read)
//   open_screen     -> nothing read; returns a navigation instruction the client checks against its own nav
// Phase 1 WRITES NOTHING: no tool inserts, updates or deletes, and none calls a writing RPC. The one write on this path
// is the cost meter, record_assistant_turn(), before the model is called — the same fail-safe shape as /api/image.
import { cors } from "./_cors.js";
import { requireMember, chargeAiCall } from "./_auth.js";
import { validExpYM } from "../shared/expiry.js";

const MODEL = "claude-sonnet-4-6";
const MAX_TOOL_ROUNDS = 5;           // a question that needs more than this is answered with what it has
const MAX_HISTORY = 12;              // most recent turns sent back to the model
const MAX_TURN_CHARS = 4000;
const TZ = "America/Chicago";
const SOP_ALL_CAP = 60000;           // a small SOP library goes to the model whole; above this, the best-matching passages
const SOP_PASSAGE_CAP = 24000;

// Member-visible screens the assistant may offer to open. The CLIENT re-checks every key against the signed-in person's
// own nav before navigating, so a leadership-only key here can never open a screen the person couldn't tap to.
export const SCREENS = {
  dashboard: "Dashboard", stationhours: "Station Hours", training: "Training", roster: "Roster", duties: "Station Duties",
  myequipment: "My Equipment", library: "Training Library", qanda: "Station Q&A", documents: "Station Documents",
  study: "Study Session", apparatus: "Apparatus", resources: "Your Six", notifications: "Notifications",
  settings: "Settings & Support", reports: "Reports", minutes: "Meetings",
};
const LEADERSHIP_SCREENS = new Set(["reports", "minutes"]);   // NAV: LEADERSHIP only — never offered to a plain member

/* ---------------- pure helpers (exported for tests) ---------------- */
// Today's calendar date in Central, as YYYY-MM-DD — drills are dated in local days.
export const todayCT = (now = new Date()) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
// Midnight Central of a YYYY-MM-DD, as an instant (handles CST/CDT by asking what offset Chicago has that day).
export function ctMidnight(ymd) {
  const guess = new Date(`${ymd}T12:00:00Z`);
  const off = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "shortOffset" }).formatToParts(guess).find((p) => p.type === "timeZoneName")?.value || "GMT-6";
  const m = /GMT([+-]\d+)(?::(\d+))?/.exec(off); const h = m ? Number(m[1]) : -6; const mm = m && m[2] ? Number(m[2]) : 0;
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - (h * 60 + Math.sign(h || 1) * mm) * 60000);
}
// The Station Hours range chips, in Central: month | last | quarter | year.
export function hoursRange(key, now = new Date()) {
  const [y, mo] = todayCT(now).split("-").map(Number);
  const ymd = (yy, mm) => `${yy}-${String(mm).padStart(2, "0")}-01`;
  if (key === "last") { const ly = mo === 1 ? y - 1 : y, lm = mo === 1 ? 12 : mo - 1; return { from: ctMidnight(ymd(ly, lm)), to: ctMidnight(ymd(y, mo)), label: "last month" }; }
  if (key === "quarter") { const qm = Math.floor((mo - 1) / 3) * 3 + 1; return { from: ctMidnight(ymd(y, qm)), to: now, label: "this quarter" }; }
  if (key === "year") return { from: ctMidnight(ymd(y, 1)), to: now, label: "this year" };
  return { from: ctMidnight(ymd(y, mo)), to: now, label: "this month" };
}
// myHoursTotals (App.jsx): credited = VERIFIED only; unverified is recorded but not credited.
export function hoursTotals(shifts) {
  const r1 = (n) => Math.round(n * 10) / 10;
  let standby = 0, training = 0, unverified = 0, vCount = 0;
  for (const s of shifts || []) {
    const h = Number(s.hours) || 0;
    if (s.verified) { vCount++; if (s.kind === "training") training += h; else standby += h; } else unverified += h;
  }
  return { credited: r1(standby + training), standby: r1(standby), training: r1(training), unverified: r1(unverified), verified_shifts: vCount, shifts: (shifts || []).length };
}
// certStatus (App.jsx): exp "YYYY-MM"; the expiry month itself is EXPIRING, before it EXPIRED, within 3 months EXPIRING.
export function certStatus(exp, now = new Date()) {
  if (!validExpYM(String(exp || ""))) return "no date";   // shape + month 01–12 + year >= 1900 — same rule as the app (shared/expiry.js)
  const [y, m] = String(exp).split("-").map(Number);
  const [ty, tm] = todayCT(now).split("-").map(Number);
  const diff = y * 12 + m - (ty * 12 + tm);
  return diff < 0 ? "expired" : diff <= 3 ? "expiring" : "current";
}
// Station Q&A grounding, made affordable for a tool: the whole library when small, else the best-matching passages.
const STOP = new Set("a an the and or of to in on for is are be do does what when how who which our my we i it at as by with from this that if can should".split(" "));
const words = (t) => String(t || "").toLowerCase().match(/[a-z0-9]+/g)?.filter((w) => w.length > 2 && !STOP.has(w)) || [];
export function pickSopPassages(docs, question) {
  const total = docs.reduce((n, d) => n + d.text.length, 0);
  if (total <= SOP_ALL_CAP) return { mode: "all", docs: docs.map((d) => ({ name: d.name, text: d.text })) };
  const q = new Set(words(question));
  const passages = [];
  for (const d of docs) {
    const paras = d.text.split(/\n\s*\n/);
    let buf = "";
    for (const p of paras) { if ((buf + p).length > 1800 && buf) { passages.push({ name: d.name, text: buf }); buf = ""; } buf += (buf ? "\n\n" : "") + p; }
    if (buf) passages.push({ name: d.name, text: buf });
  }
  const scored = passages.map((p) => {
    const w = words(p.text); let s = 0;
    for (const x of w) if (q.has(x)) s++;
    for (const x of words(p.name)) if (q.has(x)) s += 3;
    return { ...p, score: s / Math.sqrt(w.length + 20) };
  }).filter((p) => p.score > 0).sort((a, b) => b.score - a.score);
  const out = []; let n = 0;
  for (const p of scored) { if (n + p.text.length > SOP_PASSAGE_CAP) break; out.push({ name: p.name, text: p.text }); n += p.text.length; }
  return { mode: "passages", docs: out };
}

// Which of the returned SOP documents the answer actually names. Station Q&A's rule (the answer must name the document),
// made tolerant of how a model writes a file name: case, the file extension, and _ / - vs spaces don't matter.
// (Live 2026-10-16: "Document_308_VFIS-PPERoutineInspectionChecklist" vs the stored "...Checklist_02021.pdf" -> missed.)
const normName = (t) => String(t || "").toLowerCase().replace(/\.(pdf|docx?|txt|md|rtf|pptx?|xlsx?)\b/g, " ").replace(/[_\-–—.]+/g, " ").replace(/\s+/g, " ").trim();
export function citedDocs(text, names) {
  const hay = normName(text);
  return [...new Set(names || [])].filter((n) => {
    if (!n) return false;
    const full = normName(n);
    if (full && hay.includes(full)) return true;
    // also accept the name with its trailing date/version token dropped (e.g. "..._02021"), if what remains is specific
    const trimmed = full.replace(/\s+\d{3,}$/, "");
    return trimmed.length >= 12 && trimmed !== full && hay.includes(trimmed);
  }).slice(0, 3);
}

/* ---------------- tools ---------------- */
const TOOLS = [
  { name: "am_i_checked_in", description: "Whether the member is clocked in at the station right now (standby, training or off-site), since when, and whether the check-in was confirmed on station.", input_schema: { type: "object", properties: {} } },
  { name: "my_hours", description: "The member's OWN station hours for a period: credited hours (only verified on-station time counts toward ISO/LOSAP), the standby/training split, and unverified (recorded, not credited) hours.", input_schema: { type: "object", properties: { range: { type: "string", enum: ["month", "last", "quarter", "year"], description: "month = this month (default), last = last month, quarter = this quarter, year = this year" } } } },
  { name: "my_certs", description: "The member's OWN certifications with expiry status (expired / expiring within 3 months / current / doesn't expire / no date) and the month each was earned when known, plus any cert submissions still pending review.", input_schema: { type: "object", properties: {} } },
  { name: "my_schedule", description: "Upcoming department trainings and meetings the member can attend (next 60 days), soonest first, with time, length, location and whether it is optional.", input_schema: { type: "object", properties: {} } },
  { name: "my_attendance", description: "The member's OWN drill attendance rate over the last 90 days, counting only drills that count toward attendance and that were held after they joined.", input_schema: { type: "object", properties: {} } },
  { name: "search_sops", description: "Search THIS department's own uploaded SOPs, policies and documents for a question. Returns document text with document names to cite. Use for any department policy/procedure question.", input_schema: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
  { name: "open_screen", description: "Take the member to a screen in the app. Only call this when the member asks to go to / open / pull up something.", input_schema: { type: "object", properties: { screen: { type: "string", enum: Object.keys(SCREENS) } }, required: ["screen"] } },
];
TOOLS[TOOLS.length - 1].cache_control = { type: "ephemeral" };   // cache the tool block with the system prompt

async function runTool(sb, name, input, ctx) {
  const ok = (v) => ({ result: v });
  const fail = (msg) => ({ result: { error: msg } });
  const one = (d) => (Array.isArray(d) ? d[0] || null : d || null);
  try {
    if (name === "am_i_checked_in") {
      const { data, error } = await sb.rpc("my_open_station_session");
      if (error) return fail("Couldn't read your station clock.");
      const s = one(data);
      if (!s) return ok({ clocked_in: false });
      return ok({ clocked_in: true, kind: s.kind, since: s.checked_in_at, confirmed_on_station: !!s.verified, offsite_label: s.offsite_label || null });
    }
    if (name === "my_hours") {
      const r = hoursRange(input?.range);
      const { data, error } = await sb.rpc("my_station_shifts", { p_from: r.from.toISOString(), p_to: r.to.toISOString() });
      if (error) return fail("Couldn't read your station hours.");
      return ok({ period: r.label, ...hoursTotals(Array.isArray(data) ? data : []), rule: "Only verified on-station time is credited toward ISO/LOSAP; unverified time is recorded but not credited. Hours are completed shifts only." });
    }
    if (name === "my_certs") {
      const [c, s] = await Promise.all([
        sb.from("certs").select("name, exp, no_expiry, achieved_on, department_id, cert_types(never_expires, department_id)").eq("member_id", ctx.memberId),
        sb.from("cert_submissions").select("name, exp, no_expiry, status, created_at").eq("member_id", ctx.memberId).eq("status", "pending"),
      ]);
      if (c.error) return fail("Couldn't read your certifications.");
      // never expires = the cert's own "doesn't expire" flag OR its catalog type (same department) — the app's enrichCerts rule
      const never = (x) => !!x.no_expiry || (!!x.cert_types?.never_expires && x.cert_types.department_id === x.department_id);
      const ORDER = ["expired", "expiring", "current", "doesn't expire", "no date"];
      const certs = (c.data || []).map((x) => ({ name: x.name, expires: never(x) ? null : x.exp || null, status: never(x) ? "doesn't expire" : certStatus(x.exp), earned: validExpYM(x.achieved_on || "") ? x.achieved_on : null }))
        .sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
      return ok({ certs, pending_submissions: s.error ? null : (s.data || []).map((x) => ({ name: x.name, expires: x.no_expiry ? "doesn't expire" : x.exp || null, submitted: x.created_at })) });
    }
    if (name === "my_schedule") {
      const today = todayCT();
      const until = todayCT(new Date(Date.now() + 60 * 86400000));
      const { data, error } = await sb.from("training_sessions")
        .select("title, date, start_time, duration_min, done, audience, counts_toward_attendance, is_offsite, location_label")
        .gte("date", today).lte("date", until).neq("status", "cancelled").order("date", { ascending: true }).limit(40);   // Slice 7: cancelled drills aren't on anyone's schedule
      if (error) return fail("Couldn't read the schedule.");
      const isBoard = ctx.access.includes("Board Member"), isLeader = ctx.isLeader;
      const visible = (data || []).filter((s) => !s.done && (s.audience === "board" ? isBoard : s.audience === "leadership" ? isLeader : true));
      visible.sort((a, b) => (a.date + (a.start_time || "")).localeCompare(b.date + (b.start_time || "")));
      return ok({ today, upcoming: visible.slice(0, 12).map((s) => ({ title: s.title, date: s.date, start_time: s.start_time || null, length_min: s.duration_min || null, optional: s.counts_toward_attendance === false, off_site: !!s.is_offsite, location: s.location_label || null, audience: s.audience || "everyone" })) });
    }
    if (name === "my_attendance") {
      const to = todayCT(), from = todayCT(new Date(Date.now() - 90 * 86400000));
      const { data: ses, error } = await sb.from("training_sessions").select("id, date, done, audience, counts_toward_attendance").gte("date", from).lte("date", to);
      if (error) return fail("Couldn't read the drills.");
      const counted = (ses || []).filter((s) => s.done && s.counts_toward_attendance !== false && s.audience !== "board" && s.audience !== "leadership" && (!ctx.joinCutoff || s.date >= ctx.joinCutoff));
      if (!counted.length) return ok({ period: "last 90 days", drills: 0, attended: 0, rate_pct: null, note: "No counted drills in the last 90 days." });
      const { data: att, error: e2 } = await sb.from("session_attendance").select("session_id, member_id").in("session_id", counted.map((s) => s.id));
      if (e2) return fail("Couldn't read attendance.");
      const held = new Set((att || []).map((a) => a.session_id));                  // a drill nobody was marked at isn't counted (as in the app)
      const mine = new Set((att || []).filter((a) => a.member_id === ctx.memberId).map((a) => a.session_id));
      const real = counted.filter((s) => held.has(s.id));
      const n = real.filter((s) => mine.has(s.id)).length;
      return ok({ period: "last 90 days", drills: real.length, attended: n, rate_pct: real.length ? Math.round((n / real.length) * 100) : null });
    }
    if (name === "search_sops") {
      const { data, error } = await sb.from("documents").select("name, content_text").eq("department_id", ctx.deptId)
        .is("deleted_at", null).is("archived_at", null).not("content_text", "is", null);
      if (error) return fail("Couldn't read the department's documents.");
      const docs = (data || []).filter((d) => d.content_text && d.content_text.trim()).map((d) => ({ name: d.name, text: d.content_text }));
      if (!docs.length) return ok({ found: false, note: "This department has no searchable documents uploaded. Answer as GENERAL fire-service guidance and say so." });
      const picked = pickSopPassages(docs, input?.question || "");
      ctx.sopNames.push(...picked.docs.map((d) => d.name));
      if (!picked.docs.length) return ok({ found: false, note: "Nothing in this department's documents matched. Answer as GENERAL guidance and say so." });
      return ok({ found: true, documents: picked.docs });
    }
    if (name === "open_screen") {
      const key = String(input?.screen || "");
      if (!SCREENS[key]) return fail("That isn't a screen I can open.");
      if (LEADERSHIP_SCREENS.has(key) && !ctx.isLeader) return fail(`${SCREENS[key]} is for department leadership — this member can't open it.`);
      ctx.navigate = key;
      return ok({ opening: SCREENS[key] });
    }
    return fail("Unknown tool.");
  } catch {
    return fail("That lookup failed.");
  }
}

const systemPrompt = ({ name, dept, today }) => `You are "Ask B4C", the assistant inside B4C — Before the Call — for a member of a VOLUNTEER fire/EMS department. You help a volunteer get READY: their hours, their certifications, their schedule, whether they're clocked in, and their department's SOPs. You can also take them to a screen.

The member is ${name || "a member"} of ${dept || "their department"}. Today is ${today} (Central time).

HARD RULES:
- Anything about THIS member — hours, certs, schedule, attendance, clocked in or not — comes ONLY from a tool result. Call the tool; never estimate, never fill a gap, never present a guessed number as fact. If a tool returns an error, say you couldn't read it right now.
- You can only see this member's own records. You cannot look up anyone else; if asked, say so and point them to their officer.
- You cannot change anything: no clocking in or out, no submissions, no edits. If asked, explain where in the app they can do it and offer to open that screen.
- Department policy / procedure questions: use search_sops. Answer from those documents and CITE them ("According to your {document name}…"). When the documents are silent, give general fire-service guidance and SAY that it is general. NEVER invent a department-specific protocol, number or threshold — a volunteer could act on a made-up procedure on a live call. Remind them to follow their department's actual SOPs and verify specifics against the standards that apply to them (NFPA / TCFP / NREMT / their AHJ and medical direction).
- Only call open_screen when they ask to go somewhere / open / pull something up.
- Be brief and plain: a short direct answer, then the key numbers or dates. Hours to one decimal. Dates like "Tue Oct 21, 7:00 PM".
- Write PLAIN TEXT: no markdown (no **bold**, no # headings, no > quotes) — the app shows your words exactly as written. Simple "- " lists are fine.
- Say only what the record says: a drill that counts toward attendance is "counts toward attendance", not "mandatory"; don't add details the tool didn't return.`;

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "Method not allowed" });
  const member = await requireMember(req, res);   // WS-2: a member of the caller's department — 401 / 403 (was a 503) / 503 already sent
  if (!member) return;
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: "Missing ANTHROPIC_API_KEY" });

  // Validate the conversation: text-only turns, user/assistant alternation ending on the user, capped.
  const raw = Array.isArray(req.body?.messages) ? req.body.messages : [];
  const history = raw.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_TURN_CHARS) })).slice(-MAX_HISTORY);
  while (history.length && history[0].role !== "user") history.shift();
  if (!history.length || history[history.length - 1].role !== "user") return res.status(400).json({ error: "Ask a question." });

  // Every read below runs AS THE CALLER — RLS + my_member_id()/my_department_id() do the scoping.
  const sb = member.sb;   // WS-2: requireMember's as-caller client (anon key + the caller's JWT)

  // WS-2: the per-member DAILY cap (60) first — 429 / 503 already sent, the model is not called. Then the department's
  // MONTHLY ceiling below, unchanged (its 200 { limited } reply stays exactly as it was).
  if (!await chargeAiCall(member, "assistant", res)) return;

  // THE CEILING, before a cent is spent. Anything other than a clear "allowed" fails safe: the model is not called.
  let usage;
  try {
    const { data, error } = await sb.rpc("record_assistant_turn");
    if (error || !data) return res.status(503).json({ error: "Ask B4C couldn't start just now — please try again." });
    usage = data;
  } catch { return res.status(503).json({ error: "Ask B4C couldn't start just now — please try again." }); }
  if (usage.allowed !== true) {
    return res.status(200).json({ limited: true, text: "Ask B4C has taken a breather for the month — your department has used this month's questions. Everything it reads is still in the app: your hours are on Station Hours, certs on your dashboard, and SOPs in Station Q&A.", used: usage.used, ceiling: usage.ceiling });
  }

  // Who is asking (own row only).
  const { memberId, deptId } = member;   // resolved (and gated) by requireMember
  const [{ data: me }, { data: dept }, { data: celeb }] = await Promise.all([
    sb.from("members").select("name, access, joined").eq("id", memberId).maybeSingle(),
    sb.from("departments").select("name").eq("id", deptId).maybeSingle(),
    sb.from("celebrations").select("joined_date").eq("member_id", memberId).maybeSingle(),
  ]);
  const access = Array.isArray(me?.access) ? me.access : [];
  const yr = /^\s*(\d{4})/.exec(String(me?.joined ?? ""));
  const ctx = {
    memberId, deptId, access,
    isLeader: access.some((a) => ["Project Admin", "Department Admin", "Board Member", "Officer"].includes(a)),
    joinCutoff: celeb?.joined_date ? String(celeb.joined_date).slice(0, 10) : yr ? `${yr[1]}-01-01` : null,   // == joinCutoff()
    sopNames: [], navigate: null, used: new Set(),
  };

  const system = [{ type: "text", text: systemPrompt({ name: me?.name, dept: dept?.name, today: todayCT() }), cache_control: { type: "ephemeral" } }];
  const messages = history.map((m) => ({ role: m.role, content: m.content }));
  try {
    let text = "";
    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model: MODEL, max_tokens: 1200, system, tools: TOOLS, messages, ...(round === MAX_TOOL_ROUNDS ? { tool_choice: { type: "none" } } : {}) }),
      });
      const data = await r.json();
      if (!r.ok) return res.status(502).json({ error: "Ask B4C couldn't answer just now — please try again." });
      const blocks = data.content || [];
      text = blocks.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      const calls = blocks.filter((b) => b.type === "tool_use");
      if (data.stop_reason !== "tool_use" || !calls.length) break;
      messages.push({ role: "assistant", content: blocks });
      const results = [];
      for (const c of calls) {
        ctx.used.add(c.name);
        const { result } = await runTool(sb, c.name, c.input || {}, ctx);
        results.push({ type: "tool_result", tool_use_id: c.id, content: JSON.stringify(result) });
      }
      messages.push({ role: "user", content: results });
    }
    // Grounding for the UI: which records were read, and which SOPs the answer actually names (Station Q&A's rule).
    const records = [...ctx.used].filter((t) => ["am_i_checked_in", "my_hours", "my_certs", "my_schedule", "my_attendance"].includes(t));
    const cited = citedDocs(text, ctx.sopNames);
    return res.status(200).json({
      text: text || "Sorry — I couldn't put an answer together. Try asking another way.",
      navigate: ctx.navigate, records, sops: ctx.used.has("search_sops") ? { cited } : null,
      used: usage.used, ceiling: usage.ceiling,
    });
  } catch {
    return res.status(500).json({ error: "Ask B4C couldn't answer just now — please try again." });
  }
}
