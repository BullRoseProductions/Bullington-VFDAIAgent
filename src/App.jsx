import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  Flame, HeartPulse, Search, ShieldAlert, Users, FileText, Download, Plus,
  ChevronRight, Sparkles, ClipboardList, GraduationCap, Megaphone, Landmark,
  Briefcase, AlertTriangle, LogOut, LayoutDashboard, Send, CheckCircle2, Clock,
  Wrench, X, Menu, ArrowLeft, Loader2, Building2, TrendingUp, Calendar, DollarSign,
  ThumbsUp, ThumbsDown, Pencil, MessageSquare, ChevronUp, ChevronDown,
  FolderOpen, Upload, FilePlus, PartyPopper,
  Truck, Award, CalendarCheck, BarChart3, UserPlus, Phone, Mail, ClipboardCheck,
  Palette, Image as ImageIcon, Wand2, QrCode, RefreshCw, Trash2, BookOpen,
  Maximize2, RotateCcw,
} from "lucide-react";
import { downloadDepartmentReport } from "./report.js";
import { QRCodeCanvas } from "qrcode.react";
import { supabase, APP_URL } from "./supabaseClient";
// PDF text-extraction worker URL. Vite `?url` resolves to just a string (the worker asset is emitted separately and
// only fetched when the worker starts) — so this does NOT pull the ~400KB pdfjs parser into the initial bundle;
// that parser is lazy-imported in extractPdfText() on first upload.
import PDF_WORKER_URL from "pdfjs-dist/build/pdf.worker.min.mjs?url";

/* ------------------------------------------------------------------ */
/*  Working title: THE DAYROOM  (name not final — easy to swap)        */
/*  Volunteer Fire & EMS — Training, Recruitment & Operations          */
/* ------------------------------------------------------------------ */
const APP = "Before the Call";

/* ---------------- FIRE-LUXURY palette (shared; rest of app adopts later) ---------------- */
const FIRE = {
  pageBg: "radial-gradient(130% 100% at 100% 0%, #1A1217 0%, #0E1014 42%, #0A0B0E 100%)",
  sidebar: "#0A0C0F",
  card: "#13161B",
  hairline: "rgba(255,255,255,.05)",
  cardShadow: "0 10px 30px rgba(0,0,0,.4)",
  cardRadius: 16,
  textPrimary: "#F7F8FA",
  textSecondary: "#B6BDC8",
  textMuted: "#7E8794",
  textMuted2: "#9AA1AC",
  red: "#C8323A",          // active-nav hairline, today marker, kicker labels
  redBright: "#E5484D",    // tiny icon accents only
  green: "#3FB860",
  greenText: "#76C98D",
  amberText: "#D6A95E",
  redText: "#E58A90",
  track: "rgba(255,255,255,.06)",
  // --- Phase 0 additive tokens (values previously hardcoded in the Training reskins) ---
  name: "#F0F2F5",                       // near-white for NAMES (kept distinct from textPrimary #F7F8FA)
  btnBg: "rgba(255,255,255,.04)",        // dark control fill
  btnBorder: "rgba(255,255,255,.1)",     // dark control border
  inputBorder: "rgba(255,255,255,.12)",
  btnText: "#E7EAEF",
  btnIcon: "#9AA1AC",                    // == textMuted2
  navLabel: "#C7CDD6",
  neverLogged: "#D08A8F",
  deleteRed: "#C8606A",
  white: "#fff",
};

/* ---------------- Fire-luxury shared style recipes (reference FIRE tokens; reused across reskinned pages) ---------------- */
const FS = {
  kicker: { fontSize: 10, textTransform: "uppercase", letterSpacing: ".18em", color: FIRE.red, fontWeight: 700, margin: 0 },
  card: { background: FIRE.card, border: `0.5px solid ${FIRE.hairline}`, borderRadius: FIRE.cardRadius, boxShadow: FIRE.cardShadow },
  num: { fontFeatureSettings: '"tnum"', letterSpacing: "-0.01em" },
  btn: { display: "inline-flex", alignItems: "center", gap: 6, marginTop: 0, padding: "7px 11px", fontSize: 12.5, fontWeight: 600, background: FIRE.btnBg, border: `0.5px solid ${FIRE.btnBorder}`, borderRadius: 9, color: FIRE.btnText, cursor: "pointer", fontFamily: "inherit" },
  btnPrimary: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, background: FIRE.red, color: FIRE.white, border: "none", borderRadius: 9, padding: "10px 16px", fontSize: 13.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" },
  input: { border: `0.5px solid ${FIRE.inputBorder}`, borderRadius: 8, padding: "10px 12px", fontSize: 14.5, fontFamily: "inherit", background: FIRE.card, color: FIRE.textPrimary, colorScheme: "dark", width: "100%" },
  row: { display: "flex", alignItems: "center", gap: 11, flexWrap: "wrap", padding: "11px 4px", borderBottom: `0.5px solid ${FIRE.hairline}` },
};

const ROLES = ["Project Admin", "Department Admin", "Board Member", "Officer", "Member"];
const LEADERSHIP = ["Project Admin", "Department Admin", "Board Member", "Officer"];
const DEPT_ADMIN_ROLES = ["Department Admin", "Project Admin"];
const CANMANAGE_ROLES  = ["Board Member", "Department Admin", "Officer"];   // NO Project Admin
const CANMANAGE_OPS_ROLES = ["Department Admin", "Officer"];   // ops writes — Board EXCLUDED (governance-only) + no PA; client half of the live is_canmanage_ops() DB gate
const SIGNIN_ROLES     = ["Project Admin", "Department Admin", "Officer"];  // PA/DA/TO — QR sign-in + AI planner
const ANNOUNCE_ROLES   = ["Project Admin", "Department Admin", "Officer"];  // who can POST announcements — Project Admin / Department Admin / Officer (NOT Board); matches is_announcer() at the DB
const GRANTABLE_ROLES  = ["Member", "Officer", "Board Member", "Department Admin"];   // roster editor checkboxes — Project Admin NOT grantable
const hasAny           = (rs, set) => Array.isArray(rs) && rs.some((r) => set.includes(r));
const isLeader         = (rs) => hasAny(rs, LEADERSHIP);
const isDeptAdmin      = (rs) => hasAny(rs, DEPT_ADMIN_ROLES);
const isBoard          = (rs) => hasAny(rs, ['Board Member']);
const canManage        = (rs) => hasAny(rs, CANMANAGE_ROLES);
const isTrainingLeader = (rs) => hasAny(rs, SIGNIN_ROLES);

const TRACKS = {
  Fire:        { label: "Fire",        accent: "#B11E2A", Icon: Flame },
  EMS:         { label: "EMS",         accent: "#1F4E79", Icon: HeartPulse },
  Leadership:  { label: "Leadership",  accent: "#3A4750", Icon: GraduationCap },
  Operations:  { label: "Operations",  accent: "#54506B", Icon: Briefcase },
};

const DISCLAIMER =
  "For training, discussion, and planning only. Your department is responsible for compliance with local protocols, medical direction, state requirements, agency policy, and applicable law. This platform does not provide medical direction, legal advice, or certification.";

/* ---- training roadmap (department memory / gap detection) ---------- */
function statusOf(m, t) {
  if (m >= t * 2) return { label: "OVERDUE", color: "#B11E2A" };
  if (m >= t) return { label: "DUE NOW", color: "#E0A100" };
  return { label: "CURRENT", color: "#2E7D52" };
}

/* ---- library ------------------------------------------------------- */
const SEED = [
  { id: "fire-203", code: "FIRE-203", track: "Fire", title: "Primary Search & Rescue", level: "Intermediate", time: "90 min", updated: "May 2026",
    objective: "Crews conduct a coordinated primary search with crew integrity, accountability, and a charged-line tie-in where required.",
    equipment: ["Full PPE / SCBA", "Search rope / TIC if available", "Accountability board"],
    instructorGuide: "Live fire is NOT part of this drill. Run cold or in a smoke-free prop. A qualified safety officer must be assigned for any heat evolution.",
    steps: [{ t: "Briefing & accountability", d: "Set crew assignments and the accountability system.", m: 15 }, { t: "Search patterns", d: "Right/left-hand search, maintaining crew contact.", m: 20 }, { t: "Evolution", d: "Two-in/two-out, oriented search of the prop.", m: 35 }, { t: "Debrief", d: "Communication, air management, accountability gaps.", m: 20 }],
    scenario: "Reported occupant in a single-story residence, moderate (simulated) smoke. Conduct primary search.",
    discussion: ["Where did crew integrity break down?", "How was air management communicated?"],
    safety: ["Assign a safety officer", "No live fire in this drill", "Confirm SCBA checks before entry", "RIT/two-out in place"],
    evaluation: ["Maintains crew contact throughout", "Communicates air status", "Follows accountability system"],
    debrief: ["Did everyone know who was where?", "What would you change on a real fireground?"] },
  { id: "fire-118", code: "FIRE-118", track: "Fire", title: "Mayday Operations & Self-Survival", level: "Intermediate", time: "75 min", updated: "Mar 2026",
    objective: "Members declare a Mayday correctly, perform self-survival actions, and practice the LUNAR sequence.",
    equipment: ["Full PPE / SCBA", "Radios", "Reduced-profile prop"],
    instructorGuide: "Keep it low-stress and repeatable. The goal is muscle memory, not a gauntlet. No fire.",
    steps: [{ t: "Why Mayday early", d: "Discuss hesitation and the cost of delay.", m: 15 }, { t: "Declaration drill", d: "Radio Mayday with LUNAR information.", m: 20 }, { t: "Self-survival", d: "Reduced profile, SCBA emergency procedures.", m: 25 }, { t: "Debrief", d: "What made declaring hard?", m: 15 }],
    scenario: "Firefighter disoriented and low on air during search. Declare and self-rescue.",
    discussion: ["Why do firefighters delay calling Mayday?", "What does command need to hear first?"],
    safety: ["Assign a safety officer", "No live fire", "Medical standby for strenuous evolutions"],
    evaluation: ["Declares Mayday without prompting", "Transmits LUNAR clearly", "Performs self-survival steps"],
    debrief: ["Did you hesitate? Why?", "Was your transmission clear under stress?"] },
  { id: "ems-114", code: "EMS-114", track: "EMS", title: "Stroke Recognition (BE-FAST)", level: "All levels", time: "60 min", updated: "May 2026",
    objective: "Members identify stroke signs using BE-FAST, document last-known-well time, and select the correct destination per regional protocol.",
    equipment: ["Stroke scale cards", "Simulated patient", "Run report forms"],
    instructorGuide: "Open with why time-to-treatment drives outcomes. Run two short scenarios, then debrief documentation.",
    steps: [{ t: "Briefing", d: "Field-level stroke pathophysiology and why last-known-well matters.", m: 10 }, { t: "BE-FAST walkthrough", d: "Demonstrate each element; practice on a volunteer.", m: 15 }, { t: "Scenario A", d: "Posterior stroke presenting as dizziness.", m: 12 }, { t: "Scenario B", d: "Facial droop with uncertain onset.", m: 12 }, { t: "Debrief", d: "Documentation and destination decisions.", m: 11 }],
    scenario: "Family reports a 71-year-old 'not acting right' since waking. Establish last-known-well and assess.",
    discussion: ["What complicates establishing last-known-well?", "When does your region bypass to a stroke center?"],
    safety: ["Confirm scene safety", "Standard BSI precautions"],
    evaluation: ["Completes BE-FAST in order", "Documents last-known-well", "States correct destination"],
    debrief: ["What slowed your assessment?", "Was destination selection clear?"] },
  { id: "ems-203", code: "EMS-203", track: "EMS", title: "Pediatric Emergencies — Assessment Triangle", level: "All levels", time: "75 min", updated: "Apr 2026",
    objective: "Members apply the Pediatric Assessment Triangle, size equipment correctly, and adjust communication for caregivers.",
    equipment: ["Length-based tape", "Pediatric BVM", "Sim doll if available"],
    instructorGuide: "Emphasize the from-the-doorway impression before touching the child. Practice sizing under time pressure.",
    steps: [{ t: "PAT overview", d: "Appearance, work of breathing, circulation to skin.", m: 15 }, { t: "Equipment sizing", d: "Length-based tape drills, repeat for speed.", m: 20 }, { t: "Scenario", d: "Febrile seizure with anxious caregiver.", m: 20 }, { t: "Debrief", d: "Caregiver communication and transport.", m: 20 }],
    scenario: "2-year-old post-seizure, now postictal. Caregiver is panicking.",
    discussion: ["How does caregiver anxiety affect your assessment?", "When is rapid transport warranted?"],
    safety: ["Scene safety", "BSI precautions", "Keep caregiver involved to reduce child distress"],
    evaluation: ["Forms doorway impression first", "Sizes equipment correctly", "Communicates clearly"],
    debrief: ["What was hardest under time pressure?", "Did you size gear right the first try?"] },
  { id: "lead-140", code: "LEAD-140", track: "Leadership", title: "Volunteer Retention — Stay Conversations", level: "Officers", time: "60 min", updated: "Apr 2026",
    objective: "Officers run a structured 'stay interview' and identify the top three drivers pushing members out.",
    equipment: ["Stay-interview question sheet", "Whiteboard"],
    instructorGuide: "Frame retention as cheaper than recruitment. Role-play the conversation; it's harder than it looks.",
    steps: [{ t: "The cost of turnover", d: "What it takes to replace a trained member.", m: 10 }, { t: "Stay-interview structure", d: "Five questions that surface real friction.", m: 15 }, { t: "Role-play", d: "Pairs practice both sides.", m: 20 }, { t: "Action planning", d: "Each officer commits to two conversations.", m: 15 }],
    scenario: "A reliable five-year member has quietly stopped showing up. Re-engage without guilt-tripping.",
    discussion: ["What pushes good members out?", "Do you lose people in year one or year five?"],
    safety: ["Keep conversations confidential and judgment-free"],
    evaluation: ["Asks open questions", "Listens more than talks", "Leaves with a follow-up"],
    debrief: ["What surprised you?", "Which driver shows up most here?"] },
  { id: "ops-120", code: "OPS-120", track: "Operations", title: "Run It Like a Business — Annual Operating Plan", level: "Chiefs & Admin", time: "75 min", updated: "Jun 2026",
    objective: "Leadership builds a one-page operating plan: budget, funding sources, staffing targets, and key metrics — mission-first, run with business discipline.",
    equipment: ["Operating-plan template", "Prior-year budget", "Call volume data"],
    instructorGuide: "Not about going corporate — about clarity: where money comes from, where people come from, and how you know it's working.",
    steps: [{ t: "Money in, money out", d: "Map funding sources against costs.", m: 20 }, { t: "People plan", d: "Set staffing and a recruitment/retention number.", m: 20 }, { t: "Pick 3 metrics", d: "Three numbers leadership reviews monthly.", m: 15 }, { t: "Reporting cadence", d: "What the board / municipality sees, and when.", m: 20 }],
    scenario: "The municipality asks for a one-page plan justifying next year's funding. Build it.",
    discussion: ["What single number best shows your department is healthy?", "Where is funding most fragile?"],
    safety: ["Keep financial and personnel records per agency policy and law"],
    evaluation: ["Identifies all funding sources", "Sets staffing targets", "Names three review metrics"],
    debrief: ["Where's your biggest financial risk?", "Who owns this plan after today?"] },
];


/* ---------------- Settings & Support hub (card → sub-screen, mirrors Reports) ---------------- */
const SUPPORT_EMAIL = "ashlea@bullroseproductions.com";
// DA-gated department-identity editor (name/station/city). Mirrors saveBrand's RPC-id + .select() 0-row-guard + sync pattern.
function DeptSettings({ S, dept, setDept, setBrand }) {
  const [form, setForm] = useState({ name: dept?.name || "", station: dept?.station || "", city: dept?.city || "" });
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState("");   // "" | "ok" | "err"
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function save() {
    setSaving(true); setSaveState("");
    const { data: id } = await supabase.rpc("my_department_id");   // same dept-id source as brand save
    if (!id) { setSaving(false); setSaveState("err"); return; }
    const { data, error } = await supabase.from("departments").update({ name: form.name, station: form.station, city: form.city }).eq("id", id).select();   // .select() so a silent 0-row RLS block is detectable
    setSaving(false);
    if (error || !data || data.length === 0) { setSaveState("err"); return; }   // 0 rows = RLS blocked (non-DA) → error, never a false "Saved"
    setDept?.((d) => ({ ...(d || {}), name: form.name, station: form.station, city: form.city }));   // sync sidebar crest + this form's source
    setBrand?.((b) => ({ ...b, name: form.name, station: form.station }));       // keep Brand Kit's name/station consistent
    setSaveState("ok"); setTimeout(() => setSaveState(""), 2500);
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>DEPARTMENT SETTINGS</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 28, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Department details</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Your department's name, station number, and city — shown on the crest and in reports.</div>
      </div>
      <div style={{ ...FS.card, padding: 18, display: "flex", flexDirection: "column", gap: 12, maxWidth: 460 }}>
        <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Department name</span><input style={FS.input} value={form.name} onChange={(e) => set("name", e.target.value)} /></label>
        <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Station number</span><input style={FS.input} value={form.station} placeholder="e.g. Station 20" onChange={(e) => set("station", e.target.value)} /></label>
        <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>City</span><input style={FS.input} value={form.city} onChange={(e) => set("city", e.target.value)} /></label>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4, flexWrap: "wrap" }}>
          <button style={{ ...FS.btnPrimary, opacity: saving ? 0.7 : 1 }} onClick={save} disabled={saving}>{saving ? <><Loader2 size={16} className="spin" /> Saving…</> : <><CheckCircle2 size={16} /> Save changes</>}</button>
          {saveState === "ok" && <span style={{ fontSize: 13, color: FIRE.greenText, fontWeight: 600 }}>Saved ✓</span>}
          {saveState === "err" && <span style={{ fontSize: 13, color: FIRE.redText }}>Couldn't save — check your permissions.</span>}
        </div>
      </div>
    </div>
  );
}
function SettingsHub({ S, role, brand, setBrand, setDept, dept, requests, setRequests }) {
  const [view, setView] = useState(null);   // null = hub cards; else a sub-screen key
  const isDA = isDeptAdmin(role);
  const back = () => setView(null);
  const backBtn = <button style={{ ...FS.btn, marginBottom: 12 }} onClick={back}><ArrowLeft size={15} /> Settings &amp; Support</button>;
  const shell = (node) => <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>{node}</div>;
  const doc = (title, body) => shell(<>{backBtn}<h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 28, fontWeight: 700, color: FIRE.textPrimary, margin: "0 0 12px", letterSpacing: "-0.01em" }}>{title}</h1><div style={{ ...FS.card, padding: 18, fontSize: 13.5, color: FIRE.textSecondary, lineHeight: 1.6 }}>{body}</div></>);
  // sub-screens (BrandKit/RequestForm bring their own page shell → just prepend a back button)
  if (view === "brand") return <div style={{ padding: "4px 2px 0" }}>{backBtn}<BrandKit S={S} role={role} brand={brand} setBrand={setBrand} setDept={setDept} /></div>;
  if (view === "support") return <div style={{ padding: "4px 2px 0" }}>{backBtn}<RequestForm S={S} requests={requests} setRequests={setRequests} /><div style={{ ...FS.card, padding: 18, marginTop: 12 }}><div style={FS.kicker}>CONTACT SUPPORT</div><p style={{ fontSize: 13.5, color: FIRE.textSecondary, lineHeight: 1.5, marginTop: 6 }}>Questions, a bug, or feedback? Email us and we'll get back to you.</p><a href={`mailto:${SUPPORT_EMAIL}`} style={{ ...FS.btnPrimary, textDecoration: "none", display: "inline-flex", marginTop: 4 }}><Mail size={16} /> Email {SUPPORT_EMAIL}</a></div></div>;
  if (view === "dept") return <div style={{ padding: "4px 2px 0" }}>{backBtn}<DeptSettings S={S} dept={dept} setDept={setDept} setBrand={setBrand} /></div>;
  if (view === "privacy") return doc("Privacy Policy", "Full text to be added before pilot.");
  if (view === "terms") return doc("Terms of Agreement", "Full text to be added before pilot.");
  if (view === "about") return doc("About", <>Before the Call<br />© 2026 Ashlea Bullington. All rights reserved.</>);
  const card = (key, Icon, title, desc) => (
    <div style={{ ...S.opCard, ...FS.card, cursor: "pointer" }} onClick={() => setView(key)}>
      <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
        <Icon size={18} color={FIRE.red} style={{ flexShrink: 0, marginTop: 1 }} />
        <div style={{ flex: 1, minWidth: 0 }}><div style={{ ...S.personName, color: FIRE.textPrimary }}>{title}</div></div>
      </div>
      <div style={{ fontSize: 13, color: FIRE.textSecondary, marginTop: 7 }}>{desc}</div>
      <div style={{ display: "flex", alignItems: "center", marginTop: 11 }}>
        <button style={{ ...FS.btn, marginLeft: "auto", padding: "7px 12px", fontSize: 12.5 }}>Open <ChevronRight size={14} /></button>
      </div>
    </div>
  );
  return shell(<>
    <div style={{ marginBottom: 16 }}>
      <div style={FS.kicker}>SETTINGS &amp; SUPPORT</div>
      <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Settings &amp; Support</h1>
      <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Your department settings, brand, and help — all in one place.</div>
    </div>
    <div style={S.opGrid}>
      {isDA && card("dept", Building2, "Department Settings", "Your department's name, station number, and details.")}
      {card("brand", Palette, "Brand Kit", isDA ? "Colors, logo, font, voice — used across the app's tools." : "Your department's colors, logo, and voice (view-only).")}
      {card("support", Mail, "Support & Contact", "Get help, send feedback, or request custom training.")}
      {card("privacy", ShieldAlert, "Privacy Policy", "How your department's data is handled.")}
      {card("terms", FileText, "Terms of Agreement", "The terms of using Before the Call.")}
      {card("about", Award, "About", "App info and copyright.")}
    </div>
  </>);
}
const NAV = [
  { key: "dashboard", label: "Dashboard", Icon: LayoutDashboard, roles: ROLES },
  { key: "library", label: "Training Library", Icon: FileText, roles: ROLES },
  { key: "training", label: "Training", Icon: GraduationCap, roles: ROLES },
  { key: "roster", label: "Roster", Icon: Users, roles: ROLES },
  { key: "onboarding", label: "New-Member Onboarding", Icon: UserPlus, roles: ["Project Admin", "Department Admin"] },
  { key: "apparatus", label: "Apparatus", Icon: Truck, roles: ROLES },
  { key: "duties", label: "Station Duties", Icon: ClipboardCheck, roles: ROLES },
  { key: "recruit", label: "Recruitment", Icon: Megaphone, roles: LEADERSHIP },
  { key: "funding", label: "Funding", Icon: DollarSign, roles: LEADERSHIP },
  { key: "visibility", label: "Public Relations", Icon: Calendar, roles: LEADERSHIP },
  { key: "minutes", label: "Meetings", Icon: ClipboardList, roles: LEADERSHIP },
  { key: "reports", label: "Reports", Icon: BarChart3, roles: LEADERSHIP },
  { key: "study", label: "Study Session", Icon: BookOpen, roles: ROLES },
  { key: "qanda", label: "Station Q&A", Icon: MessageSquare, roles: ROLES },
  { key: "documents", label: "Station Documents", Icon: FolderOpen, roles: ROLES },
  { key: "settings", label: "Settings & Support", Icon: Wrench, roles: ROLES },
  { key: "admin", label: "Content Admin", Icon: ShieldAlert, roles: ["Project Admin"] },
  { key: "adddept", label: "Add Department", Icon: Landmark, roles: ["Project Admin"] },
];

// A Project-Admin-ONLY user gets a trimmed oversight+support nav (no department-operation screens,
// which are RLS-scoped to their own department anyway). Keys must exist in NAV above.
const PA_NAV = ["dashboard", "settings", "admin", "adddept"];

/* ================================================================== */
function Notification({ S, kind, title, text, details, onClose }) {
  const [showDetails, setShowDetails] = useState(false);
  const isErr = kind === "error";
  const accent = isErr ? "#B11E2A" : "#2E7D52";                 // ENGINE red / success green — app palette
  const Icon = isErr ? AlertTriangle : CheckCircle2;
  return (
    <div style={{ position: "fixed", top: 18, right: 18, zIndex: 60, width: "min(380px, calc(100vw - 36px))", background: "#fff", border: `1px solid ${accent}44`, borderLeft: `4px solid ${accent}`, borderRadius: 10, boxShadow: "0 8px 26px rgba(20,16,24,.16)", padding: "13px 14px", display: "flex", gap: 10, alignItems: "flex-start", fontFamily: "'Public Sans', system-ui, sans-serif" }}>
      <Icon size={18} color={accent} style={{ flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {isErr ? (<>
          <div style={{ fontWeight: 700, fontSize: 14, color: "#191C20" }}>{title}</div>
          {text && <div style={{ fontSize: 13, color: "#3A4750", marginTop: 2 }}>{text}</div>}
          {details && (<>
            <button onClick={() => setShowDetails((v) => !v)} style={{ marginTop: 8, border: "none", background: "transparent", color: accent, fontSize: 12, fontWeight: 600, cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
              {showDetails ? "Hide details" : "Show details"}
            </button>
            {showDetails && (
              <div style={{ marginTop: 6, padding: "8px 9px", background: "#F7F6FA", border: "1px solid #E7E5EE", borderRadius: 6, fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 11.5, color: "#3A4750", whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{details}</div>
            )}
          </>)}
        </>) : (
          <div style={{ fontWeight: 600, fontSize: 13.5, color: "#191C20" }}>{text || title}</div>
        )}
      </div>
      <button onClick={onClose} title="Dismiss" aria-label="Dismiss" style={{ border: "none", background: "transparent", color: "#6A7178", cursor: "pointer", padding: 0, flexShrink: 0, display: "inline-flex" }}>
        <X size={16} />
      </button>
    </div>
  );
}
export default function App() {
  const [role, setRole] = useState(["Member"]);
  const [realRole, setRealRole] = useState(["Member"]);
  const [authEmail, setAuthEmail] = useState(null);
  const [myMemberId, setMyMemberId] = useState(null);
  const [identityChecked, setIdentityChecked] = useState(false);
  const [screen, setScreen] = useState("dashboard");
  useEffect(() => { if (screen === "ai") setScreen("training"); }, [screen]);   // retired AI Training page → redirect any stale deep-link
  const [packetId, setPacketId] = useState(null);
  const [navArg, setNavArg] = useState(null);   // optional deep-link arg carried by go() (e.g. Roster initial tab)
  const [drawer, setDrawer] = useState(false);
  const [library, setLibrary] = useState(SEED);
  const [requests, setRequests] = useState([]);
  const [feedback, setFeedback] = useState([]);
  const [members, setMembers] = useState(MEMBERS);
  const [toast, setToast] = useState(null);
  useEffect(() => {
    Promise.all([
      supabase.from("members_view").select("*"),
      supabase.from("certs").select("id, member_id, name, exp"),
    ]).then(([membersRes, certsRes]) => {
      // Group certs by member_id into a lookup of { id, name, exp } arrays.
      const certsByMember = new Map();
      if (!certsRes.error && certsRes.data) {
        for (const c of certsRes.data) {
          if (!certsByMember.has(c.member_id)) certsByMember.set(c.member_id, []);
          certsByMember.get(c.member_id).push({ id: c.id, name: c.name, exp: c.exp });
        }
      }
      const { data, error } = membersRes;
      if (!error && data && data.length) {
        setMembers(
          data.map((m) => ({
            id: m.id,
            department_id: m.department_id,
            name: m.name,
            role: m.role,
            access: m.access,
            status: m.status,
            phone: m.phone,
            email: m.email,
            joined: m.joined,
            participation: m.participation,
            mentorId: m.mentor_id,
            certs: certsByMember.get(m.id) || [],
            notes: [],
          }))
        );
      }
    });
  }, []);
  // Self-contained auth tracking (main.jsx still gates the session; this only reads it).
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setAuthEmail(data.session?.user?.email ?? null);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_event, session) => {
      setAuthEmail(session?.user?.email ?? null);
    });
    return () => sub.subscription.unsubscribe();
  }, []);
  // Load the real member id + permission tier from the signed-in user's row (authoritative base table).
  useEffect(() => {
    if (!authEmail) { setRealRole(["Member"]); setRole(["Member"]); setMyMemberId(null); setIdentityChecked(false); return; }
    let cancelled = false;
    setIdentityChecked(false);
    supabase
      .from("members")
      .select("id, access")
      .ilike("email", authEmail)   // case-insensitive to match the DB's lower(email)=lower(auth.email())
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        const ok = !error && !!data;
        const roles = (ok && Array.isArray(data.access) ? data.access : []).filter((r) => ROLES.includes(r));
        const safeRoles = roles.length ? roles : ["Member"];
        setRealRole(safeRoles);
        setRole(safeRoles);
        setMyMemberId(ok ? data.id : null);
        setIdentityChecked(true);
      });
    return () => { cancelled = true; };
  }, [authEmail]);
  const [dept, setDept] = useState(null);   // real department identity (name + logo_url) — header crest + sidebar
  useEffect(() => {
    if (!authEmail) { setDept(null); return; }
    supabase.rpc("my_department_id").then(({ data: id }) => {
      if (!id) return;
      supabase.from("departments").select("name, station, city, primary_color, accent_color, font, tagline, voice, logo_url").eq("id", id).single().then(({ data }) => {
        if (!data) return;
        setDept(data);                                   // dept keeps name + logo_url (crest); extra cols are harmless
        setBrand({                                        // populate the real department brand (null cols fall back to DEFAULT_BRAND)
          name: data.name ?? DEFAULT_BRAND.name,
          station: data.station ?? DEFAULT_BRAND.station,
          primary: data.primary_color ?? DEFAULT_BRAND.primary,
          accent: data.accent_color ?? DEFAULT_BRAND.accent,
          font: data.font ?? DEFAULT_BRAND.font,
          tagline: data.tagline ?? DEFAULT_BRAND.tagline,
          voice: data.voice ?? DEFAULT_BRAND.voice,
          logo: data.logo_url ?? DEFAULT_BRAND.logo,
          guidelines: [],                                 // no departments column yet → stays local (Stage 2 decision)
        });
      });
    });
  }, [authEmail]);
  const [brand, setBrand] = useState(DEFAULT_BRAND);
  const [trainingPlan, setTrainingPlan] = useState([]);
  const loadPlans = () => {
    supabase.from("training_plans")
      .select("id, name, cadence, last_iso, color")
      .then(({ data, error }) => {
        if (error || !data) { setTrainingPlan([]); return; }
        setTrainingPlan(data.map((r) => ({ id: r.id, name: r.name, cadence: r.cadence, lastISO: r.last_iso, color: r.color })));
      });
  };
  useEffect(() => { loadPlans(); }, []);
  const [trainingSessions, setTrainingSessions] = useState([]);
  const loadSessions = async () => {
    const [{ data: srows, error: sErr }, { data: arows }, { data: prows }] = await Promise.all([
      supabase.from("training_sessions").select("id, plan_id, title, date, done, signin_open, series_id, audience"),
      supabase.from("session_attendance").select("session_id, member_id, checked_in_at"),
      supabase.from("session_plans").select("id, title, storage_path, ai_text, source, session_id").order("created_at", { ascending: false }),
    ]);
    if (sErr || !srows) { setTrainingSessions([]); return; }   // sessions are source of truth; attendance/plan reads are non-fatal
    const byS = {};
    (arows || []).forEach((a) => {
      const e = byS[a.session_id] || (byS[a.session_id] = { attendance: [], times: {} });
      e.attendance.push(a.member_id);
      if (a.checked_in_at) e.times[a.member_id] = new Date(a.checked_in_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    });
    const plansByS = {};   // ALL plans per session (query ordered desc → newest first); supports multiple files per session
    (prows || []).forEach((p) => {
      if (!p.session_id) return;
      (plansByS[p.session_id] || (plansByS[p.session_id] = [])).push({
        id: p.id, title: p.title, storage_path: p.storage_path, ai_text: p.ai_text, source: p.source, session_id: p.session_id,
        kind: p.storage_path ? "file" : "ai",   // uploaded file vs AI-text plan (distinguished for the slice-4 viewer)
      });
    });
    setTrainingSessions(
      srows.filter((r) => r.date).map((r) => {
        const [yy, mm, dd] = r.date.split("-").map(Number);
        const ae = byS[r.id] || { attendance: [], times: {} };
        const plans = plansByS[r.id] || [];
        return { id: r.id, planId: r.plan_id, seriesId: r.series_id, title: r.title, y: yy, m: (mm || 1) - 1, d: dd, done: !!r.done, signinOpen: !!r.signin_open, audience: r.audience || "everyone", attendance: ae.attendance, times: ae.times, plans, plan: plans[0] || null };   // audience: 'everyone' | 'leadership' (default everyone); plans[] = all; plan = newest (backward-compat alias)
      })
    );
  };
  useEffect(() => { loadSessions(); }, []);
  const [checkinResult, setCheckinResult] = useState(null);
  const [pendingCheckin, setPendingCheckin] = useState(null);
  // Self-serve check-in: the DB RPC enforces identity (my_member_id), department, not-done, and token match.
  async function doCheckIn(sessionId, token) {
    const title = trainingSessions.find((x) => String(x.id) === String(sessionId))?.title;
    const { data, error } = await supabase.rpc("member_check_in", { p_session_id: sessionId, p_token: token });
    if (error) return { ok: false, reason: error.message || "We couldn't record your sign-in — please see your training officer.", title };
    loadSessions();   // refresh attendance counts / roster
    if (data === "already") return { ok: true, already: true, title };
    const now = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    return { ok: true, at: now, title };
  }
  // Capture a QR/deep-link check-in on mount; don't act until we know who's signed in.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const cid = p.get("checkin");
    if (cid) {
      setPendingCheckin({ cid, token: p.get("t") });
      setCheckinResult({ pending: true });
      setScreen("checkin");
      window.history.replaceState({}, "", window.location.pathname);
    }
  }, []);
  // Perform the check-in for the REAL signed-in member — never a fallback person.
  useEffect(() => {
    if (!pendingCheckin) return;
    if (!identityChecked) return; // wait until the authoritative lookup has resolved
    if (myMemberId == null) {
      setCheckinResult({ ok: false, reason: "We couldn't match your sign-in to a member record, so no attendance was recorded. Please see your training officer." });
    } else {
      doCheckIn(pendingCheckin.cid, pendingCheckin.token, myMemberId).then(setCheckinResult);
    }
    setPendingCheckin(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingCheckin, identityChecked, myMemberId]);
  const addFeedback = (f) => setFeedback((p) => [{ ...f, when: "Just now" }, ...p]);
  const notify = (n) => setToast(n);
  const S = baseStyles();

  function go(k, arg) { setScreen(k); setPacketId(null); setDrawer(false); setNavArg(arg ?? null); }
  function openPacket(id) { setPacketId(id); setScreen("packet"); setDrawer(false); }
  // Trim to the oversight+support surface ONLY when the ACTIVE role is exactly Project Admin
  // (nothing else). Every other role — and a PA who is viewing-as/also-holding another role —
  // falls through to the unchanged hasAny filter.
  const isProjectAdminOnly = Array.isArray(role) && hasAny(role, ["Project Admin"]) && role.every((r) => r === "Project Admin");
  const visibleNav = isProjectAdminOnly
    ? NAV.filter((n) => PA_NAV.includes(n.key))
    : NAV.filter((n) => hasAny(role, n.roles));
  const packet = library.find((p) => p.id === packetId);

  return (
    <div style={S.app}>
      <Fonts />
      {toast && <Notification S={S} kind={toast.kind} title={toast.title} text={toast.text} details={toast.details} onClose={() => setToast(null)} />}
      {drawer && <div style={S.scrim} onClick={() => setDrawer(false)} />}
      <aside className={`dr-side${drawer ? " open" : ""}`} style={S.sidebar}>
        <div style={S.brandRow}>
          <Logo />
        </div>
        <nav style={S.nav}>
          {visibleNav.map((n) => {
            const active = screen === n.key || (screen === "packet" && n.key === "library");
            return (
              <button key={n.key} onClick={() => go(n.key)} style={{ ...S.navItem, ...(active ? S.navItemActive : {}) }}>
                <n.Icon size={18} /><span style={{ flex: 1, textAlign: "left" }}>{n.label}</span>
                {n.premium && <span style={S.premiumTag}>AI</span>}
              </button>
            );
          })}
        </nav>
        <button onClick={() => supabase.auth.signOut()} aria-label="Sign out" style={{ ...S.navItem, borderTop: "1px solid #2A2F35", marginTop: 6, paddingTop: 13 }}>
          <LogOut size={18} /><span style={{ flex: 1, textAlign: "left" }}>Sign out</span>
        </button>
        <div style={S.deptCard}>
          <div style={S.deptLabel}>DEPARTMENT</div>
          <div style={S.deptName}>{dept?.name || "…"}</div>
          {dept?.station && <div style={S.deptMeta}>{dept.station}</div>}
        </div>
      </aside>

      <div style={S.main}>
        <header style={S.topbar}>
          <button className="dr-menu" style={S.menuBtn} onClick={() => setDrawer(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div style={{ flex: 1 }} />
          <div style={S.viewAs}>
            {isLeader(realRole) && realRole.length > 1 && (
              <>
                <span style={S.viewAsLabel}>View as</span>
                <select value={role.length === realRole.length ? "__all__" : (role[0] || "")} onChange={(e) => { setRole(e.target.value === "__all__" ? [...realRole] : [e.target.value]); setScreen("dashboard"); }} style={S.select}>
                  <option value="__all__">All my roles</option>
                  {realRole.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </>
            )}
          </div>
        </header>

        <main style={S.content}>
          {screen === "dashboard" && <Dashboard S={S} role={role} members={members} library={library} openPacket={openPacket} go={go} meId={myMemberId} sessions={trainingSessions} notify={notify} dept={dept} />}
          {screen === "library" && <Library S={S} library={library} openPacket={openPacket} />}
          {screen === "training" && <Training S={S} role={role} plan={trainingPlan} setPlan={setTrainingPlan} loadPlans={loadPlans} sessions={trainingSessions} setSessions={setTrainingSessions} loadSessions={loadSessions} members={members} meId={myMemberId} notify={notify} dept={dept} addFeedback={addFeedback} />}
          {screen === "study" && <StudySession S={S} />}
          {screen === "qanda" && <StationQA S={S} />}
          {screen === "checkin" && <CheckinConfirm S={S} result={checkinResult} members={members} meId={myMemberId} go={go} />}
          {screen === "packet" && packet && <Packet S={S} packet={packet} back={() => setScreen("library")} />}
          {screen === "documents" && <Documents S={S} role={role} notify={notify} members={members} uploaderName={members.find((m) => m.id === myMemberId)?.name || authEmail || "Unknown"} />}
          {screen === "roster" && <Roster S={S} role={role} members={members} setMembers={setMembers} sessions={trainingSessions} plan={trainingPlan} notify={notify} meId={myMemberId} initialTab={navArg} />}
          {screen === "onboarding" && <Onboarding S={S} members={members} setMembers={setMembers} notify={notify} role={role} />}
          {screen === "apparatus" && <Apparatus S={S} role={role} members={members} meId={myMemberId} notify={notify} />}
          {screen === "recruit" && <Recruitment S={S} brand={brand} role={role} notify={notify} dept={dept} meId={myMemberId} members={members} />}
          {screen === "visibility" && <Visibility S={S} brand={brand} role={role} notify={notify} />}
          {screen === "duties" && <StationDuties S={S} role={role} members={members} meId={myMemberId} notify={notify} />}
          {screen === "funding" && <Funding S={S} role={role} notify={notify} dept={dept} meId={myMemberId} members={members} />}
          {screen === "minutes" && <Minutes S={S} role={role} notify={notify} dept={dept} meId={myMemberId} members={members} sessions={trainingSessions} initialMode={navArg} />}
          {screen === "reports" && <Reports S={S} role={role} members={members} sessions={trainingSessions} dept={dept} meId={myMemberId} notify={notify} />}
          {screen === "settings" && <SettingsHub S={S} role={role} brand={brand} setBrand={setBrand} setDept={setDept} dept={dept} requests={requests} setRequests={setRequests} />}
          {screen === "admin" && <Admin S={S} library={library} setLibrary={setLibrary} feedback={feedback} />}
          {screen === "adddept" && <AddDepartment S={S} role={role} notify={notify} />}
        </main>
      </div>
    </div>
  );
}

/* One shared greeting for both dashboards: time-of-day + first name, clean fallback. */
const dashboardGreeting = (me) => {
  const h = new Date().getHours();
  const time = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
  const first = me && me.name ? me.name.trim().split(" ")[0] : "";
  return `${time}${first ? `, ${first}` : ""}.`;
};

/* ---------------- Dashboard ---------------- */
// Shared dept attendance calc — per-member eligible/attended/pct (audience-aware) + department average, for one year.
// Single source for RosterReports (Chief's Report), AttendanceReport (Yearly report), and the Dept Admin dashboard — no drift.
/* Accounts excluded from ALL department stats/counts (owner + test) — NOT from identity:
   they still log in and resolve via members.find(meId), so keep them in the full members array. */
const STATS_EXCLUDED_IDS = new Set([
  "0ad3dc98-5af3-4ae5-8c04-f7902e0cf7c4",  // Ashlea (owner)
  "02c4a728-9d58-4e58-89b4-4f277aad2272",  // test account
]);
const countsInStats = (m) => !STATS_EXCLUDED_IDS.has(m.id) && !hasAny(m.access, ['Project Admin']);   // owner/test by id + any Project Admin by role (robust across depts/ids)
// Same two accounts must never be a selectable assignee (mentor/duty/action-item/owner pickers).
// Distinct predicate from countsInStats (assignable vs. counted) though it shares the id set today.
const isAssignable = (m) => !STATS_EXCLUDED_IDS.has(m.id) && !hasAny(m.access, ['Project Admin']);   // never a selectable assignee (owner/test by id + any Project Admin by role)
const assignableMembers = (ms) => (ms || []).filter(isAssignable);
function deptAttendance(members, sessions, year, range) {
  // scope by date range {from,to} (ISO) when given (empty bound = unbounded); else the original year filter — backward-compatible for dashboards
  const inScope = range
    ? (s) => { const iso = toISODate(sessDate(s)); return (!range.from || iso >= range.from) && (!range.to || iso <= range.to); }
    : (s) => s.y === year;
  const doneThisYear = (sessions || []).filter((s) => s.done && inScope(s) && (s.attendance || []).length > 0);   // done + roll-taken, in scope
  const rows = (members || []).filter(countsInStats).map((m) => {   // exclude owner/test from denominators + the attendance table
    const memberLeader = isLeader(m.access);
    const eligible = doneThisYear.filter((s) => memberLeader || s.audience !== "leadership");
    const attended = eligible.filter((s) => (s.attendance || []).includes(m.id)).length;
    const pct = eligible.length ? Math.round((attended / eligible.length) * 100) : null;
    return { id: m.id, name: m.name, role: m.role, status: m.status, attended, eligible: eligible.length, pct, leader: memberLeader };
  });
  const rated = rows.filter((r) => r.pct != null);
  const avg = rated.length ? Math.round(rated.reduce((s, r) => s + r.pct, 0) / rated.length) : 0;
  return { rows, avg, doneThisYear };
}
// Rolling 90-day window for live participation (roster + member file) — feeds the SAME
// deptAttendance calc as Reports, so a finalized drill moves these numbers immediately.
const rolling90 = () => { const to = new Date(); const from = new Date(); from.setDate(from.getDate() - 90); return { from: toISODate(from), to: toISODate(to) }; };
// Shared personal cards (My Certifications / Assigned Duties / Upcoming Training) — self-contained (owns its personal-duties load + plan viewer).
// Rendered in the Dept Admin dashboard; MemberDashboard keeps its own inline copy for now (switch is a later dedicated change).
function PersonalView({ S, me, meId, sessions, notify }) {
  const { openSessionPlans, mounts } = usePlanViewer(S, notify);
  const certsAll = me ? me.certs.map((c) => ({ ...c, st: certStatus(c.exp) })).sort((a, b) => a.st.rank - b.st.rank) : [];
  const certsCurrent = certsAll.filter((c) => c.st.rank === 2).length, certsTotal = certsAll.length;
  const expiringSoon = certsAll.filter((c) => c.st.rank === 1).length, expired = certsAll.filter((c) => c.st.rank === 0).length;
  const certAlert = expired > 0 ? { color: FIRE.redText, text: `${expired} expired` } : expiringSoon > 0 ? { color: FIRE.amberText, text: `${expiringSoon} expiring soon` } : { color: FIRE.greenText, text: "All current" };
  const [mine, setMine] = useState([]);
  function loadMine() { if (!meId) return; supabase.from("duties").select("id, duty, due_date, done, done_at, assigned_to").eq("assigned_to", meId).then(({ data }) => setMine(data || [])); }
  useEffect(() => { loadMine(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [meId]);
  const mineOpen = mine.filter((d) => !d.done), mineDone = mine.filter((d) => d.done);
  async function markMineDone(id) {
    const { error } = await supabase.rpc("complete_duty", { p_duty_id: id, p_helper_ids: [] });
    if (error) { notify({ kind: "error", title: "Couldn't mark it done", text: "Something went wrong updating that. Please try again.", details: error.message }); return; }
    loadMine();
  }
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  const upcoming = (sessions || []).filter((s) => !s.done && sessDate(s) >= t0).sort((a, b) => sessDate(a) - sessDate(b)).slice(0, 4);   // next 4 only (display cap)
  return (
    <>
      <div style={{ ...FS.kicker, marginBottom: 8, marginTop: 18 }}>YOUR PERSONAL VIEW</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 14 }}>
        <div style={{ ...FS.card, padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={FS.kicker}>MY CERTIFICATIONS</div>
            <span style={{ fontSize: 11, fontWeight: 700, color: certAlert.color, ...FS.num }}>{certsCurrent}/{certsTotal} · {certAlert.text}</span>
          </div>
          <div style={{ marginTop: 10 }}>
            {certsAll.length === 0 ? (<div style={{ fontSize: 13, color: FIRE.textMuted }}>No certifications on file yet.</div>) : certsAll.map((c, i) => (
              <div key={c.id ?? i} style={{ ...FS.row, padding: "9px 0" }}>
                <Award size={15} color={CERT_FIRE[c.st.label]} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.name }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num }}>{expPhrase(c.exp)}</div>
                </div>
                <Pill S={S} color={CERT_FIRE[c.st.label]}>{c.st.label}</Pill>
              </div>
            ))}
          </div>
        </div>
        <div style={{ ...FS.card, padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={FS.kicker}>ASSIGNED DUTIES</div>
            {(mineOpen.length + mineDone.length) > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: FIRE.textMuted2, ...FS.num }}>{mineDone.length} of {mineOpen.length + mineDone.length} done</span>}
          </div>
          <div style={{ marginTop: 10 }}>
            {(mineOpen.length + mineDone.length) === 0 ? (<div style={{ fontSize: 13, color: FIRE.textMuted }}>No duties assigned to you.</div>) : (<>
              {mineOpen.map((d) => {
                let badge = null;
                if (d.due_date) {
                  const dd = new Date(d.due_date + "T00:00:00"); const tn = new Date(); tn.setHours(0, 0, 0, 0);
                  const days = Math.round((dd - tn) / 86400000);
                  const tone = days < 0 ? FIRE.redText : days <= 7 ? FIRE.amberText : FIRE.textMuted2;
                  const dl = dd.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                  badge = <span style={{ fontSize: 11.5, fontWeight: 700, color: tone, ...FS.num }}>{days < 0 ? `Overdue ${dl}` : `Due ${dl}`}</span>;
                }
                return (
                  <div key={d.id} style={{ ...FS.row, padding: "9px 0" }}>
                    <ClipboardCheck size={15} color={FIRE.btnIcon} style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.name }}>{d.duty}</div>
                      {badge && <div style={{ marginTop: 2 }}>{badge}</div>}
                    </div>
                    <button onClick={() => markMineDone(d.id)} style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }}><CheckCircle2 size={13} color={FIRE.btnIcon} /> Mark done</button>
                  </div>
                );
              })}
              {mineDone.length > 0 && (
                <div style={{ marginTop: mineOpen.length ? 8 : 0, paddingTop: mineOpen.length ? 8 : 0, borderTop: mineOpen.length ? `0.5px solid ${FIRE.hairline}` : "none" }}>
                  {mineDone.map((d) => {
                    const dl = d.done_at ? new Date(d.done_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
                    return (
                      <div key={d.id} style={{ ...FS.row, padding: "9px 0" }}>
                        <CheckCircle2 size={15} color={FIRE.green} style={{ flexShrink: 0 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textMuted2, textDecoration: "line-through" }}>{d.duty}</div>
                          {dl && <div style={{ fontSize: 11.5, color: FIRE.textMuted, marginTop: 2, ...FS.num }}>Done {dl}</div>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </>)}
          </div>
        </div>
        <div style={{ ...FS.card, padding: 18 }}>
          <div style={FS.kicker}>UPCOMING TRAINING</div>
          <div style={{ marginTop: 10 }}>
            {upcoming.length === 0 ? (<div style={{ fontSize: 13, color: FIRE.textMuted }}>Nothing scheduled yet.</div>) : upcoming.map((s) => (
              <div key={s.id} style={{ ...FS.row, padding: "9px 0" }}>
                <CalendarCheck size={15} color={FIRE.btnIcon} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.name }}>{s.title}</div>
                  <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num }}>{fmtSess(s)}</div>
                </div>
                {s.plan && <button onClick={() => openSessionPlans(s)} style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }}>Open plan</button>}
              </div>
            ))}
          </div>
        </div>
      </div>
      {mounts}
    </>
  );
}
/* ---------------- Announcements (shared feed + compose) ---------------- */
// Feed shows dept announcements, RLS-filtered by audience: members see 'everyone',
// leaders (is_leader) also see 'leadership'. Compose is gated to ANNOUNCE_ROLES
// (DA/PA/TO) — the DB (is_announcer + author pin) is the real wall. Delete = author
// or Dept Admin. Dropped into all three dashboards; announcements are the featured
// top of the "Feed" card, with room reserved below for birthdays/anniversaries.
function Announcements({ role, members, meId, notify, style }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [composing, setComposing] = useState(false);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [audience, setAudience] = useState("everyone");
  const [busy, setBusy] = useState(false);
  const [celebrations, setCelebrations] = useState([]);   // celebrations view: member_id, birthday, joined_date (dept-scoped, all-members-readable)
  const canPost = hasAny(role, ANNOUNCE_ROLES);
  const nameById = new Map((members || []).map((m) => [m.id, m.name]));
  const canDelete = (it) => it.author_id === meId || isDeptAdmin(role);
  const fmtWhen = (iso) => { const d = new Date(iso); return isNaN(d.getTime()) ? "" : d.toLocaleDateString("en-US", { month: "short", day: "numeric" }); };

  function load() {
    supabase.from("announcements")
      .select("id, author_id, title, body, audience, created_at")
      .order("created_at", { ascending: false })   // newest first; dept + audience filtered by RLS
      .then(({ data }) => { setItems(data || []); setLoading(false); });
  }
  useEffect(() => { load(); }, []);
  useEffect(() => { supabase.from("celebrations").select("*").then(({ data }) => setCelebrations(data || [])); }, []);   // read-tolerant: view missing/empty → []

  async function post() {
    const b = body.trim();
    if (!b) { notify({ kind: "error", title: "Nothing to post", text: "Write an announcement first." }); return; }
    setBusy(true);
    const [{ data: deptId }, { data: memberId }] = await Promise.all([
      supabase.rpc("my_department_id"), supabase.rpc("my_member_id"),
    ]);
    if (!deptId || !memberId) { setBusy(false); notify({ kind: "error", title: "Couldn't find your account", text: "Please try again." }); return; }
    const { data, error } = await supabase.from("announcements")
      .insert({ department_id: deptId, author_id: memberId, title: title.trim() || null, body: b, audience })
      .select("id, author_id, title, body, audience, created_at").single();
    setBusy(false);
    if (error || !data) { notify({ kind: "error", title: "Couldn't post the announcement", text: "Something went wrong. Please try again.", details: error?.message }); return; }
    setItems((xs) => [data, ...xs]);                 // optimistic prepend (row already committed)
    setTitle(""); setBody(""); setAudience("everyone"); setComposing(false);
    notify({ kind: "success", text: "Announcement posted." });
  }

  async function remove(id) {
    if (!window.confirm("Delete this announcement?")) return;
    const prev = items;
    setItems((xs) => xs.filter((x) => x.id !== id));   // optimistic
    const { error } = await supabase.from("announcements").delete().eq("id", id);   // RLS: author or Dept Admin
    if (error) { setItems(prev); notify({ kind: "error", title: "Couldn't delete", text: "Please try again.", details: error.message }); }
  }

  // --- Upcoming celebrations (this month) — from the dept-scoped celebrations view ---
  const now = new Date();
  const curMonth = now.getMonth() + 1, curYear = now.getFullYear();
  const parseMD = (iso) => { if (!iso) return null; const [y, m, d] = String(iso).split("-").map(Number); return (m >= 1 && m <= 12 && d >= 1) ? { y, m, d } : null; };   // parse YYYY-MM-DD without timezone drift; null-safe
  const monthDay = (m, d) => new Date(2000, m - 1, d).toLocaleDateString("en-US", { month: "long", day: "numeric" });   // local construction → "January 30"
  const byId = new Map((members || []).map((m) => [m.id, m]));
  const celebs = (celebrations || []).map((c) => ({ ...c, member: byId.get(c.member_id) })).filter((c) => c.member && countsInStats(c.member));   // known dept member; owner/test excluded
  const birthdays = celebs.map((c) => ({ id: c.member_id, name: c.member.name, md: parseMD(c.birthday) })).filter((x) => x.md && x.md.m === curMonth).sort((a, b) => a.md.d - b.md.d);   // this month, by day
  const anniversaries = celebs.map((c) => { const md = parseMD(c.joined_date); return md ? { id: c.member_id, name: c.member.name, md, years: curYear - md.y } : null; }).filter((x) => x && x.md.m === curMonth && x.years >= 1).sort((a, b) => a.md.d - b.md.d);   // this month, real anniversaries (>=1 yr)
  return (
    <div style={{ ...FS.card, padding: 18, ...style }}>
      <div style={FS.kicker}>FEED</div>

      {/* Announcements — featured at the top of the feed; bounded so a long feed scrolls internally (~6 rows) instead of growing the page */}
      <div style={{ marginTop: 10, maxHeight: 372, overflowY: "auto" }}>
        {loading ? (
          <div style={{ fontSize: 13, color: FIRE.textMuted }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ fontSize: 13, color: FIRE.textMuted }}>No announcements yet.</div>
        ) : items.map((it) => (
          <div key={it.id} style={{ padding: "10px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              {it.title && <span style={{ fontWeight: 700, fontSize: 14, color: FIRE.textPrimary }}>{it.title}</span>}
              {it.audience === "leadership" && <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", color: FIRE.amberText, border: `0.5px solid ${FIRE.amberText}55`, borderRadius: 5, padding: "1px 5px" }}>Leadership</span>}
              {canDelete(it) && <button onClick={() => remove(it.id)} title="Delete" style={{ marginLeft: "auto", background: "none", border: "none", cursor: "pointer", padding: 0, display: "inline-flex", color: FIRE.textMuted }}><X size={13} /></button>}
            </div>
            <div style={{ fontSize: 13, color: FIRE.textSecondary, lineHeight: 1.5, marginTop: it.title ? 3 : 0 }}>{it.body}</div>
            <div style={{ fontSize: 11, color: FIRE.textMuted, marginTop: 3 }}>{nameById.get(it.author_id) || "Unknown"} · {fmtWhen(it.created_at)}</div>
          </div>
        ))}
      </div>

      {/* Compose — posters only (ANNOUNCE_ROLES = DA/PA/TO); the DB enforces the real gate */}
      {canPost && (composing ? (
        <div style={{ marginTop: 12, borderTop: `0.5px solid ${FIRE.hairline}`, paddingTop: 12 }}>
          <input style={{ ...FS.input, marginBottom: 8 }} placeholder="Title (optional)" value={title} onChange={(e) => setTitle(e.target.value)} />
          <textarea style={{ ...FS.input, minHeight: 60, resize: "vertical", marginBottom: 8 }} placeholder="Write an announcement…" value={body} onChange={(e) => setBody(e.target.value)} />
          <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
            {[["everyone", "Everyone"], ["leadership", "Leadership"]].map(([v, l]) => (
              <button key={v} onClick={() => setAudience(v)} style={{ ...FS.btn, flex: 1, justifyContent: "center", ...(audience === v ? { borderColor: FIRE.red, color: FIRE.textPrimary } : {}) }}>{l}</button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button style={{ ...FS.btnPrimary, opacity: busy ? 0.7 : 1 }} disabled={busy} onClick={post}>{busy ? "Posting…" : "Post"}</button>
            <button style={FS.btn} disabled={busy} onClick={() => { setComposing(false); setTitle(""); setBody(""); setAudience("everyone"); }}>Cancel</button>
          </div>
          <div style={{ fontSize: 11, color: FIRE.textMuted, marginTop: 8 }}>{audience === "leadership" ? "Only leaders will see this." : "Everyone in the department will see this."}</div>
        </div>
      ) : (
        <button style={{ ...FS.btn, marginTop: 12 }} onClick={() => setComposing(true)}><Plus size={14} color={FIRE.btnIcon} /> New announcement</button>
      ))}

      {/* Birthdays & anniversaries THIS MONTH — from the dept-scoped celebrations view (all members can see) */}
      <div style={{ marginTop: 14, borderTop: `0.5px solid ${FIRE.hairline}`, paddingTop: 10 }}>
        <div style={{ ...FS.kicker, marginBottom: 8 }}>🎂 Birthdays &amp; anniversaries</div>
        {birthdays.length === 0 && anniversaries.length === 0 ? (
          <div style={{ fontSize: 12.5, color: FIRE.textMuted, fontStyle: "italic" }}>No birthdays or anniversaries this month.</div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {birthdays.map((b) => (
              <div key={`bd-${b.id}`} style={{ fontSize: 13, color: FIRE.textSecondary, lineHeight: 1.4 }}>🎂 <b style={{ color: FIRE.textPrimary }}>{b.name}</b>&rsquo;s birthday is {monthDay(b.md.m, b.md.d)}</div>
            ))}
            {anniversaries.map((a) => {
              const milestone = a.years % 5 === 0;
              return (
                <div key={`an-${a.id}`} style={{ fontSize: 13, color: FIRE.textSecondary, lineHeight: 1.4 }}>🎖 <b style={{ color: FIRE.textPrimary }}>{a.name}</b> &mdash; {a.years} {a.years === 1 ? "year" : "years"} of service{milestone && <span style={{ color: FIRE.amberText, fontWeight: 700 }}> &middot; {a.years}-year milestone</span>}</div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
// Board oversight dashboard — governance/health view (Board is oversight, not ops).
// Derivations MIRROR DeptAdminDashboard exactly (deptAttendance, cert compliance, readiness 40/40/20).
// SCAFFOLD: header + raw derived numbers for verification; cards/styling + governance queries land next.
function BoardDashboard({ S, role, members, go, meId, sessions, notify, dept }) {
  const DISPLAY = "'Oswald', system-ui, sans-serif";
  const RING_R = 34, RING_C = 2 * Math.PI * RING_R;   // same ring geometry as DeptAdminDashboard
  const me = members.find((m) => m.id === meId) || null;
  const yr = new Date().getFullYear();
  const { avg: avgPart, doneThisYear } = deptAttendance(members, sessions, yr);   // dept attendance % + drills
  const cm = members.filter(countsInStats);   // counted members (owner/test excluded) — counts only, NOT identity/display
  const total = cm.length;
  const ranks = []; cm.forEach((m) => (m.certs || []).forEach((c) => ranks.push(certStatus(c.exp).rank)));
  const curC = ranks.filter((r) => r === 2).length, expgC = ranks.filter((r) => r === 1).length, expdC = ranks.filter((r) => r === 0).length;
  const certPct = (curC + expgC + expdC) ? Math.round((curC / (curC + expgC + expdC)) * 100) : 0;
  const drillsHeld = doneThisYear.length;
  const [duties, setDuties] = useState([]);
  const [ringOn, setRingOn] = useState(false);   // ring fill animation on mount
  useEffect(() => {
    supabase.from("duties").select("id, duty, due_date, done, assigned_to").then(({ data }) => setDuties(data || []));   // dept-scoped by RLS
    const t = setTimeout(() => setRingOn(true), 80); return () => clearTimeout(t);
  }, []);
  // Governance data (read-only; ai_outputs + action_items are leader-readable, Board included) — reuses the Minutes/Agenda/DeptAdmin patterns.
  const [agendaRow, setAgendaRow] = useState(null);
  const [minutesRow, setMinutesRow] = useState(null);
  const [openItems, setOpenItems] = useState([]);
  useEffect(() => {
    const cols = "id, title, ai_text, current_text, created_at, edited_at, created_by, edited_by";
    const newest = (rows) => (rows || []).slice().sort((a, b) => (b.edited_at || b.created_at).localeCompare(a.edited_at || a.created_at))[0] || null;   // coalesce(edited_at, created_at) desc
    supabase.from("ai_outputs").select(cols).eq("feature", "agenda").is("deleted_at", null).then(({ data }) => setAgendaRow(newest(data)));
    supabase.from("ai_outputs").select(cols).eq("feature", "minutes").is("deleted_at", null).then(({ data }) => setMinutesRow(newest(data)));
    supabase.from("action_items").select("*").eq("status", "open")   // full rows (text + due_date) — dept-scoped by RLS
      .then(({ data }) => setOpenItems((data || []).slice().sort((a, b) => (a.due_date || "9999-99-99").localeCompare(b.due_date || "9999-99-99"))));   // soonest due first
  }, []);
  const govDate = (r) => r ? new Date(r.edited_at || r.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "";
  const minutesAuthor = minutesRow ? (members.find((m) => m.id === minutesRow.created_by)?.name || "Unknown") : null;
  const dutyDone = duties.filter((d) => d.done).length;
  const dutyCompletion = duties.length ? Math.round((dutyDone / duties.length) * 100) : 100;   // no duties = nothing outstanding = 100
  const readiness = Math.round(certPct * 0.40 + avgPart * 0.40 + dutyCompletion * 0.20);        // 40% certs · 40% attendance · 20% duty completion
  const ringColor = readiness >= 75 ? FIRE.green : readiness >= 50 ? FIRE.amberText : FIRE.redText;
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      {/* HEADER */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={FS.kicker}>{dept?.name ? `BOARD · ${dept.name}` : "BOARD"}</div>
          <h1 style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "4px 0 0", letterSpacing: "-0.01em" }}>{dashboardGreeting(me)}</h1>
          <div style={{ fontSize: 14, color: FIRE.textSecondary, marginTop: 6, lineHeight: 1.5 }}>Department oversight at a glance.</div>
        </div>
      </div>

      {/* MEETINGS & GOVERNANCE — governance leads for Board (read-only; ai_outputs/action_items are leader-readable) */}
      <div style={{ ...FS.kicker, marginBottom: 8 }}>MEETINGS &amp; GOVERNANCE</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 18 }}>
        {/* Next meeting — newest agenda draft */}
        <div style={{ ...FS.card, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ ...FS.kicker, display: "flex", alignItems: "center", gap: 6 }}><Calendar size={13} color={FIRE.red} /> NEXT MEETING</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {agendaRow ? (<>
              <div style={{ fontSize: 14, fontWeight: 700, color: FIRE.textPrimary, lineHeight: 1.3 }}>{agendaRow.title || "Untitled agenda"}</div>
              <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 3 }}>{govDate(agendaRow)}</div>
            </>) : <div style={{ fontSize: 13, color: FIRE.textMuted }}>No agenda yet.</div>}
          </div>
          <button style={{ ...FS.btn, alignSelf: "flex-start", padding: "6px 11px", fontSize: 12 }} onClick={() => go("minutes", "agenda")}>View agenda <ChevronRight size={13} color={FIRE.btnIcon} /></button>
        </div>
        {/* Recent minutes — newest minutes draft */}
        <div style={{ ...FS.card, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ ...FS.kicker, display: "flex", alignItems: "center", gap: 6 }}><FileText size={13} color={FIRE.red} /> RECENT MINUTES</div>
          <div style={{ flex: 1, minWidth: 0 }}>
            {minutesRow ? (<>
              <div style={{ fontSize: 14, fontWeight: 700, color: FIRE.textPrimary, lineHeight: 1.3 }}>{minutesRow.title || "Untitled minutes"}</div>
              <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 3 }}>{govDate(minutesRow)}{minutesAuthor ? ` · by ${minutesAuthor}` : ""}</div>
            </>) : <div style={{ fontSize: 13, color: FIRE.textMuted }}>No minutes yet.</div>}
          </div>
          <button style={{ ...FS.btn, alignSelf: "flex-start", padding: "6px 11px", fontSize: 12 }} onClick={() => go("minutes", "minutes")}>Read minutes <ChevronRight size={13} color={FIRE.btnIcon} /></button>
        </div>
        {/* Action items — MY open items only: assigned-to-me or unassigned (assigned-to-others hidden). meId is members.id (same space as assigned_to) */}
        <div style={{ ...FS.card, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          {(() => {
            const mine = openItems.filter((it) => it.assigned_to == null || it.assigned_to === meId);   // unassigned or mine (cf. StationDuties canCompleteThis)
            const fmtDue = (iso) => iso ? new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
            return (<>
              <div style={{ ...FS.kicker, display: "flex", alignItems: "center", gap: 6 }}><ClipboardCheck size={13} color={FIRE.red} /> OPEN ACTION ITEMS{mine.length ? ` · ${mine.length}` : ""}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                {mine.length === 0 ? (
                  <div style={{ fontSize: 13, color: FIRE.textMuted }}>No action items for you.</div>
                ) : mine.slice(0, 3).map((it) => {
                  const yours = it.assigned_to === meId;
                  const due = fmtDue(it.due_date);
                  return (
                    <div key={it.id} style={{ padding: "4px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                        <div style={{ flex: 1, minWidth: 0, fontSize: 13, color: FIRE.textPrimary, lineHeight: 1.35 }}>{it.text}</div>
                        <span style={{ flexShrink: 0, fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", padding: "1px 5px", borderRadius: 5, color: yours ? FIRE.greenText : FIRE.textMuted2, border: `0.5px solid ${yours ? FIRE.greenText + "55" : FIRE.hairline}` }}>{yours ? "Yours" : "Unassigned"}</span>
                      </div>
                      <div style={{ fontSize: 11, color: FIRE.textMuted, marginTop: 1 }}>{due ? `due ${due}` : "no due date"}</div>
                    </div>
                  );
                })}
                {mine.length > 3 && <div style={{ fontSize: 11.5, color: FIRE.textMuted2, marginTop: 6 }}>+{mine.length - 3} more</div>}
              </div>
              <button style={{ ...FS.btn, alignSelf: "flex-start", padding: "6px 11px", fontSize: 12 }} onClick={() => go("minutes", "action-items")}>View items <ChevronRight size={13} color={FIRE.btnIcon} /></button>
            </>);
          })()}
        </div>
      </div>

      {/* DEPARTMENT HEALTH strip — readiness ring (reused from DeptAdminDashboard) + oversight stats */}
      <div style={{ ...FS.kicker, marginBottom: 8 }}>DEPARTMENT HEALTH · OVERSIGHT</div>
      <div style={{ ...FS.card, padding: "18px 20px", display: "flex", alignItems: "center", gap: 24, flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 84, height: 84, flexShrink: 0 }}>
          <svg width="84" height="84" viewBox="0 0 84 84">
            <circle cx="42" cy="42" r={RING_R} fill="none" stroke={FIRE.track} strokeWidth="7" />
            <circle cx="42" cy="42" r={RING_R} fill="none" stroke={ringColor} strokeWidth="7" strokeLinecap="round" strokeDasharray={RING_C} strokeDashoffset={ringOn ? RING_C * (1 - readiness / 100) : RING_C} transform="rotate(-90 42 42)" style={{ transition: "stroke-dashoffset .9s cubic-bezier(.4,0,.2,1)" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <div style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 700, color: FIRE.textPrimary, ...FS.num }}>{readiness}%</div>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: ".1em", color: FIRE.textMuted2, textTransform: "uppercase", marginTop: 1 }}>Ready</div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 220, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(110px, 1fr))", gap: "14px 20px" }}>
          {[
            ["Cert compliance", `${certPct}%`],
            ["Attendance", `${avgPart}%`],
            ["Active roster", String(total)],
            ["Drills held", String(drillsHeld)],
          ].map(([label, val]) => (
            <div key={label}>
              <div style={{ fontFamily: DISPLAY, fontSize: 26, fontWeight: 700, color: FIRE.textPrimary, lineHeight: 1, ...FS.num }}>{val}</div>
              <div style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: FIRE.textMuted2, marginTop: 5 }}>{label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* CHIEF'S REPORT — board-facing summary; opens the Reports hub (Chief's Report card lives there) */}
      <div style={{ ...FS.card, borderLeft: `3px solid ${FIRE.red}`, padding: "14px 16px", marginTop: 12, display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <BarChart3 size={20} color={FIRE.red} style={{ flexShrink: 0 }} />
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: FIRE.textPrimary }}>Chief's Report</div>
          <div style={{ fontSize: 13, color: FIRE.textSecondary, marginTop: 3, lineHeight: 1.5 }}>The board-facing summary — readiness, certs, training, finances.</div>
        </div>
        <button style={{ ...FS.btn, flexShrink: 0 }} onClick={() => go("reports")}>Open report <ChevronRight size={14} color={FIRE.btnIcon} /></button>
      </div>

      {/* FEED + CALENDAR — read-only feed (Board not in ANNOUNCE_ROLES) beside the shared station calendar; mirrors DeptAdminDashboard */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 18, marginBottom: 6 }}>
        <Announcements role={role} members={members} meId={meId} notify={notify} style={{ flex: "1 1 240px" }} />
        <div style={{ flex: "2 1 340px", minWidth: 0 }}>
          <DashboardCalendar S={S} notify={notify} withImportanceMode />
        </div>
      </div>
    </div>
  );
}
function DeptAdminDashboard({ S, role, members, go, meId, sessions, notify, dept }) {
  const me = members.find((m) => m.id === meId) || null;
  const DISPLAY = "'Oswald', system-ui, sans-serif";
  const RING_R = 34, RING_C = 2 * Math.PI * RING_R;   // same geometry as the member attendance ring
  const yr = new Date().getFullYear();
  const { avg: avgPart, doneThisYear } = deptAttendance(members, sessions, yr);
  const cm = members.filter(countsInStats);   // counted members (owner/test excluded) — counts only, NOT identity/display
  const total = cm.length;
  const ranks = []; cm.forEach((m) => (m.certs || []).forEach((c) => ranks.push(certStatus(c.exp).rank)));
  const curC = ranks.filter((r) => r === 2).length, expgC = ranks.filter((r) => r === 1).length, expdC = ranks.filter((r) => r === 0).length;
  const certPct = (curC + expgC + expdC) ? Math.round((curC / (curC + expgC + expdC)) * 100) : 0;
  const drillsHeld = doneThisYear.length;
  const todayISO = toISODate(new Date());
  const nextEvent = (sessions || []).filter((s) => !s.done && toISODate(sessDate(s)) >= todayISO).sort((a, b) => sessDate(a) - sessDate(b))[0] || null;
  const nameById = new Map((members || []).map((m) => [m.id, m.name]));
  const [duties, setDuties] = useState([]);
  const [pendingCerts, setPendingCerts] = useState([]);
  const [openActions, setOpenActions] = useState(0);
  const [openItems, setOpenItems] = useState([]);   // full open action_items rows → computeInsights
  const [attnOpen, setAttnOpen] = useState(true);   // NEEDS YOUR ATTENTION collapsible; default expanded
  const [ringOn, setRingOn] = useState(false);   // ring fill animation on mount
  useEffect(() => {
    supabase.from("duties").select("id, duty, due_date, done, assigned_to").then(({ data }) => setDuties(data || []));                 // dept-scoped by RLS
    supabase.from("cert_submissions").select("id, name, member_id").eq("status", "pending").then(({ data }) => setPendingCerts(data || []));   // dept-scoped by RLS
    supabase.from("action_items").select("*").eq("status", "open").then(({ data }) => { setOpenItems(data || []); setOpenActions((data || []).length); });   // full rows: count for the stat + rows for insights; dept-scoped by RLS
    const t = setTimeout(() => setRingOn(true), 80); return () => clearTimeout(t);
  }, []);
  const openDuties = duties.filter((d) => !d.done);
  const overdueDuties = openDuties.filter((d) => d.due_date && d.due_date < todayISO).sort((a, b) => (a.due_date || "").localeCompare(b.due_date || ""));   // most overdue first
  const flagged = [];
  cm.forEach((m) => (m.certs || []).forEach((c) => { const st = certStatus(c.exp); if (st.rank < 2) flagged.push({ member: m.name, cert: c.name, phrase: expPhrase(c.exp), rank: st.rank }); }));
  flagged.sort((a, b) => a.rank - b.rank);   // expired (0) before expiring (1)
  const expd = flagged.filter((f) => f.rank === 0).length, expg = flagged.filter((f) => f.rank === 1).length;
  const dutyDone = duties.filter((d) => d.done).length;
  const dutyCompletion = duties.length ? Math.round((dutyDone / duties.length) * 100) : 100;   // done/total; no duties = nothing outstanding = 100
  const readiness = Math.round(certPct * 0.40 + avgPart * 0.40 + dutyCompletion * 0.20);        // 40% certs · 40% attendance · 20% duty completion
  const ringColor = readiness >= 75 ? FIRE.green : readiness >= 50 ? FIRE.amberText : FIRE.redText;
  const insights = computeInsights({ sessions, members, openItems, todayISO });
  const hasInsights = insights.attendanceGaps.length > 0 || insights.overdueItems.length > 0;
  const attnN = (openDuties.length ? 1 : 0) + (flagged.length ? 1 : 0) + (pendingCerts.length ? 1 : 0) + insights.attendanceGaps.length + insights.overdueItems.length;   // 3 count-card categories (non-zero) + per-person insight cards
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ width: 52, height: 52, borderRadius: 12, background: FIRE.card, border: `0.5px solid ${FIRE.hairline}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
          {dept?.logo_url ? <img src={dept.logo_url} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, letterSpacing: ".02em", color: FIRE.redBright }}>{deptMonogram(dept?.name)}</span>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={FS.kicker}>{dept?.name ? `COMMAND · ${dept.name}` : "COMMAND"}</div>
          <h1 style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "4px 0 0", letterSpacing: "-0.01em" }}>{dashboardGreeting(me)}</h1>
        </div>
        <div style={{ textAlign: "right", minWidth: 130 }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".14em", color: FIRE.textMuted2, fontWeight: 700 }}>NEXT DEPT EVENT</div>
          {nextEvent ? (<><div style={{ fontSize: 18, fontWeight: 700, color: FIRE.textPrimary, marginTop: 3, ...FS.num }}>{sessDate(nextEvent).toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div><div style={{ fontSize: 12, color: FIRE.textMuted }}>{nextEvent.title}</div></>) : <div style={{ fontSize: 12.5, color: FIRE.textMuted, marginTop: 4 }}>Nothing scheduled</div>}
        </div>
      </div>
      <div style={{ ...FS.card, padding: "18px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 84, height: 84, flexShrink: 0 }}>
          <svg width="84" height="84" viewBox="0 0 84 84">
            <circle cx="42" cy="42" r={RING_R} fill="none" stroke={FIRE.track} strokeWidth="7" />
            <circle cx="42" cy="42" r={RING_R} fill="none" stroke={ringColor} strokeWidth="7" strokeLinecap="round" strokeDasharray={RING_C} strokeDashoffset={ringOn ? RING_C * (1 - readiness / 100) : RING_C} transform="rotate(-90 42 42)" style={{ transition: "stroke-dashoffset .9s cubic-bezier(.4,0,.2,1)" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <div style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 700, color: FIRE.textPrimary, ...FS.num }}>{readiness}%</div>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: ".1em", color: FIRE.textMuted2, textTransform: "uppercase", marginTop: 1 }}>Ready</div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={FS.kicker}>DEPARTMENT READINESS</div>
          <div style={{ fontSize: 13, color: FIRE.textSecondary, marginTop: 6, lineHeight: 1.5 }}>40% certifications · 40% attendance · 20% duty completion</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <Stat S={S} dark n={String(total)} label="Members" />
        <Stat S={S} dark n={`${certPct}%`} label="Cert compliance" warn={expdC > 0} />
        <Stat S={S} dark n={`${avgPart}%`} label="Attendance" />
        <div title="Duty completion is the current-week checklist snapshot — resets when checkmarks are cleared" style={{ display: "grid" }}><Stat S={S} dark n={`${dutyCompletion}%`} label="Duty completion" /></div>
        <Stat S={S} dark n={String(drillsHeld)} label="Drills held" />
        <Stat S={S} dark n={String(openActions)} label="Open action items" />
      </div>
      <button onClick={() => setAttnOpen((v) => !v)} style={{ ...FS.kicker, marginTop: 18, marginBottom: attnOpen ? 8 : 0, display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
        <AlertTriangle size={13} style={{ verticalAlign: "-2px" }} />NEEDS YOUR ATTENTION ({attnN})
        <span style={{ marginLeft: "auto", display: "inline-flex" }}>{attnOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>
      {attnOpen && (<>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", gap: 12 }}>
        <div style={{ ...FS.card, borderLeft: `3px solid ${FIRE.red}`, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
              <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 28, lineHeight: 1, color: FIRE.textPrimary }}>{openDuties.length}</span>
              {overdueDuties.length > 0 && <span style={{ fontSize: 13, fontWeight: 700, color: FIRE.redText }}>· {overdueDuties.length} overdue</span>}
            </div>
            <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: FIRE.textSecondary, marginTop: 4 }}>Open duties</div>
            {overdueDuties[0] && <div style={{ fontSize: 13, color: FIRE.textSecondary, marginTop: 6 }}>⚠ {overdueDuties[0].duty}{overdueDuties[0].assigned_to ? ` · ${nameById.get(overdueDuties[0].assigned_to) || "Unassigned"}` : ""}{overdueDuties[0].due_date ? ` · due ${overdueDuties[0].due_date}` : ""}</div>}
          </div>
          <button style={{ ...FS.btn, padding: "6px 11px", fontSize: 12, alignSelf: "flex-start" }} onClick={() => go("duties")}>View duties</button>
        </div>
        <div style={{ ...FS.card, borderLeft: `3px solid ${FIRE.amberText}`, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 7, flexWrap: "wrap" }}>
              <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 28, lineHeight: 1, color: FIRE.textPrimary }}>{expg}</span>
              {expd > 0 && <span style={{ fontSize: 13, fontWeight: 700, color: FIRE.redText }}>· {expd} expired</span>}
            </div>
            <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: FIRE.textSecondary, marginTop: 4 }}>Expiring certs</div>
            {flagged.length > 0 && <div style={{ fontSize: 13, color: FIRE.textSecondary, marginTop: 6 }}>{flagged.slice(0, 3).map((f) => `${f.member} · ${f.cert} (${f.phrase})`).join("  ·  ")}{flagged.length > 3 ? `  · +${flagged.length - 3} more` : ""}</div>}
          </div>
          <button style={{ ...FS.btn, padding: "6px 11px", fontSize: 12, alignSelf: "flex-start" }} onClick={() => go("roster")}>View certs</button>
        </div>
        <div style={{ ...FS.card, borderLeft: `3px solid #378ADD`, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 7 }}>
              <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 28, lineHeight: 1, color: FIRE.textPrimary }}>{pendingCerts.length}</span>
            </div>
            <div style={{ fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: FIRE.textSecondary, marginTop: 4 }}>Pending approvals</div>
          </div>
          <button style={{ ...FS.btn, padding: "6px 11px", fontSize: 12, alignSelf: "flex-start" }} onClick={() => go("roster", "pending")}>Review approvals</button>
        </div>
      </div>
      {hasInsights && <div style={{ ...FS.kicker, marginTop: 14, marginBottom: 8, opacity: 0.7 }}>PEOPLE TO REACH OUT TO</div>}
      <InsightCards insights={insights} go={go} bare />
      </>)}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 18, marginBottom: 6 }}>
        <Announcements role={role} members={members} meId={meId} notify={notify} style={{ flex: "1 1 240px" }} />
        <div style={{ flex: "2 1 340px", minWidth: 0 }}>
          <DashboardCalendar S={S} notify={notify} withImportanceMode />
        </div>
      </div>
      <PersonalView S={S} me={me} meId={meId} sessions={sessions} notify={notify} />
      <div style={{ ...FS.kicker, marginBottom: 8, marginTop: 18 }}>QUICK ACTIONS</div>
      <div style={S.quickGrid}>
        {["reports", "roster", "duties", "minutes", "documents"].map((k) => {
          const n = NAV.find((x) => x.key === k); if (!n) return null;
          const q = QUICK[n.key] || {};
          return (
            <button key={k} style={{ ...S.quickCard, ...FS.card }} onClick={() => go(k)}>
              <span style={{ ...S.quickIcon, background: q.accent }}><n.Icon size={18} color="#fff" /></span>
              <div style={{ flex: 1 }}>
                <div style={{ ...S.quickTitle, color: FIRE.textPrimary }}>{n.label}</div>
                <div style={{ ...S.quickBlurb, color: FIRE.textMuted }}>{q.blurb}</div>
              </div>
              <ChevronRight size={16} color={FIRE.btnIcon} style={{ flexShrink: 0, alignSelf: "center" }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
/* ---- Shared 'Needs your attention' insights (Officer + DeptAdmin) ---- */
const CHECKIN_SYS = "You're a volunteer fire department officer writing a brief, WARM, non-punitive check-in text to a member who hasn't been to training in a while. Caring, not scolding — you're glad they're part of the crew and hoping they can make it back. 2-3 sentences, friendly, texting tone. Return ONLY the message.";
const REMINDER_SYS = "You're a volunteer fire department officer writing a brief, friendly reminder text about a task that's past due. A gentle nudge, not a demand — offer help. 2-3 sentences, texting tone. Return ONLY the message.";
// Pure compute — attendanceGaps (guardrailed) + overdueItems. Needs sessions, members, openItems (open action_items rows), todayISO.
function computeInsights({ sessions, members, openItems, todayISO }) {
  const nameById = new Map((members || []).map((m) => [m.id, m.name]));
  const dayDiff = (isoA, isoB) => Math.round((Date.parse(isoA) - Date.parse(isoB)) / 86400000);   // whole days A − B (both YYYY-MM-DD)
  const eligibleFor = (m, s) => isLeader(m.access) || s.audience !== "leadership";   // same audience rule as deptAttendance / RECENT EVENTS
  const pastDone = (sessions || []).filter((s) => s.done && (s.attendance || []).length > 0 && toISODate(sessDate(s)) <= todayISO);   // past, done, roll-taken
  const isPureBoard = (m) => isBoard(m.access) && !hasAny(m.access, ["Member", "Officer", "Department Admin", "Project Admin"]);   // governance-only → not expected at drills (overdue-items still flags them)
  const attendanceGaps = pastDone.length === 0 ? [] : (members || []).filter((m) => countsInStats(m) && m.status === "Active" && !isPureBoard(m)).map((m) => {   // exclude owner/test
    // Only flag members who have attended at least one B4C session; measure the gap from their LAST actual attendance.
    // Never-attended members are skipped entirely — no station-tenure/first-drill fallback (B4C has no history for them yet).
    const attendedISO = pastDone.filter((s) => eligibleFor(m, s) && (s.attendance || []).includes(m.id)).map((s) => toISODate(sessDate(s))).sort();
    if (attendedISO.length === 0) return null;   // never attended a B4C session → not flagged
    const refISO = attendedISO[attendedISO.length - 1];   // days since their last B4C attendance
    return { type: "attendance", memberId: m.id, memberName: m.name, days: dayDiff(todayISO, refISO) };
  }).filter((x) => x && x.days > 30).sort((a, b) => b.days - a.days);   // lapsed active members > 30 days, biggest first
  const overdueItems = (openItems || []).filter((r) => r.due_date && r.due_date < todayISO).sort((a, b) => (a.due_date || "").localeCompare(b.due_date || "")).map((r) => ({ type: "overdue", itemId: r.id, task: r.text, assigneeName: r.assigned_to ? (nameById.get(r.assigned_to) || "Unassigned") : "Unassigned", daysOverdue: dayDiff(todayISO, r.due_date), sourceLabel: r.source_label || null }));
  return { attendanceGaps, overdueItems };
}
// Draft state + AI actions (approve-before-send); one draft open at a time. Owned by InsightCards.
function useInsightDrafts() {
  const [draftFor, setDraftFor] = useState(null);
  const [draftText, setDraftText] = useState("");
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftErr, setDraftErr] = useState("");
  const [copied, setCopied] = useState(false);
  async function runDraft(key, sys, ctx) {
    setDraftFor(key); setDraftText(""); setDraftErr(""); setCopied(false); setDraftLoading(true);
    try { const t = await callClaude(sys, ctx); setDraftText(t); }
    catch { setDraftErr("Couldn't draft that just now — try again."); }
    finally { setDraftLoading(false); }
  }
  function closeDraft() { setDraftFor(null); setDraftText(""); setDraftErr(""); setCopied(false); }
  async function copyDraft() { try { await navigator.clipboard.writeText(draftText); setCopied(true); setTimeout(() => setCopied(false), 1800); } catch { setDraftErr("Couldn't copy — select the text and copy manually."); } }
  const draftBox = (key, sys, ctx) => (
    <div style={{ marginTop: 6, borderTop: `0.5px solid ${FIRE.hairline}`, paddingTop: 8 }}>
      {draftLoading ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: FIRE.textMuted }}><Loader2 size={14} className="spin" /> Drafting…</div>
      ) : draftErr ? (
        <div style={{ fontSize: 12.5, color: FIRE.redText, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}><span>{draftErr}</span><button style={{ ...FS.btn, padding: "4px 9px", fontSize: 11.5 }} onClick={() => runDraft(key, sys, ctx)}>Retry</button></div>
      ) : (<>
        <textarea style={{ ...FS.input, minHeight: 74, resize: "vertical", fontSize: 13, width: "100%" }} value={draftText} onChange={(e) => setDraftText(e.target.value)} />
        <div style={{ display: "flex", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          <button style={FS.btnPrimary} onClick={copyDraft}>{copied ? <><CheckCircle2 size={15} /> Copied!</> : <><ClipboardCheck size={15} /> Copy</>}</button>
          <button style={FS.btn} onClick={closeDraft}>Close</button>
        </div>
      </>)}
    </div>
  );
  return { draftFor, runDraft, draftBox };
}
// Shared 'NEEDS YOUR ATTENTION' card grid (overdue + attendance) with AI-draft actions.
function InsightCards({ insights, go, bare }) {
  const { attendanceGaps, overdueItems } = insights;
  const { draftFor, runDraft, draftBox } = useInsightDrafts();
  const [open, setOpen] = useState(true);   // NEEDS YOUR ATTENTION collapsible (non-bare mode); default expanded
  const isEmpty = attendanceGaps.length === 0 && overdueItems.length === 0;
  if (bare && isEmpty) return null;   // bare (DA): no kicker, no empty-state — render nothing when there's nothing
  return (
    <>
      {!bare && (
        <button onClick={() => setOpen((v) => !v)} style={{ ...FS.kicker, marginTop: 18, marginBottom: open ? 8 : 0, display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
          <AlertTriangle size={13} style={{ verticalAlign: "-2px" }} />NEEDS YOUR ATTENTION ({attendanceGaps.length + overdueItems.length})
          <span style={{ marginLeft: "auto", display: "inline-flex" }}>{open ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
        </button>
      )}
      {(bare || open) && (isEmpty ? (
        <div style={{ ...FS.card, padding: "14px 16px", fontSize: 13, color: FIRE.textMuted, display: "flex", alignItems: "center", gap: 8 }}><CheckCircle2 size={15} color={FIRE.green} /> All caught up — no attendance gaps or overdue assignments.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12 }}>
          {overdueItems.map((ins) => {
            const key = `o-${ins.itemId}`;
            const ctx = `Assignee: ${ins.assigneeName}. Task: ${ins.task}. Overdue by ${ins.daysOverdue} day${ins.daysOverdue === 1 ? "" : "s"}.${ins.sourceLabel ? ` Context: ${ins.sourceLabel}.` : ""}`;
            return (
            <div key={key} style={{ ...FS.card, borderLeft: `3px solid ${FIRE.redText}`, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: FIRE.textPrimary, lineHeight: 1.4 }}><b>{ins.assigneeName}</b>'s “{ins.task}” was due {ins.daysOverdue} day{ins.daysOverdue === 1 ? "" : "s"} ago</div>
                {ins.sourceLabel && <div style={{ fontSize: 11.5, color: FIRE.textMuted, marginTop: 3 }}>{ins.sourceLabel}</div>}
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={{ ...FS.btn, padding: "6px 11px", fontSize: 12 }} onClick={() => go("minutes", "action-items")}>View task</button>
                <button style={{ ...FS.btn, padding: "6px 11px", fontSize: 12 }} onClick={() => runDraft(key, REMINDER_SYS, ctx)}>Draft reminder</button>
              </div>
              {draftFor === key && draftBox(key, REMINDER_SYS, ctx)}
            </div>
            );
          })}
          {attendanceGaps.map((ins) => {
            const key = `a-${ins.memberId}`;
            const ctx = `Member: ${ins.memberName}. Hasn't been to training in ${ins.days} days.`;
            return (
            <div key={key} style={{ ...FS.card, borderLeft: `3px solid ${FIRE.amberText}`, padding: "12px 16px", display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, color: FIRE.textPrimary, lineHeight: 1.4 }}><b>{ins.memberName}</b> hasn't been to training in {ins.days} days</div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button style={{ ...FS.btn, padding: "6px 11px", fontSize: 12 }} onClick={() => runDraft(key, CHECKIN_SYS, ctx)}>Draft check-in</button>
              </div>
              {draftFor === key && draftBox(key, CHECKIN_SYS, ctx)}
            </div>
            );
          })}
        </div>
      ))}
    </>
  );
}
function OfficerDashboard({ S, role, members, go, meId, sessions, notify, dept }) {
  const me = members.find((m) => m.id === meId) || null;
  const DISPLAY = "'Oswald', system-ui, sans-serif";
  const RING_R = 34, RING_C = 2 * Math.PI * RING_R;   // same ring geometry as DA/Board
  const yr = new Date().getFullYear();
  const { avg: avgPart, doneThisYear } = deptAttendance(members, sessions, yr);
  const cm = members.filter(countsInStats);   // counted members (owner/test excluded) — counts only, NOT identity/display
  const activeCount = cm.filter((m) => m.status === "Active").length;
  const ranks = []; cm.forEach((m) => (m.certs || []).forEach((c) => ranks.push(certStatus(c.exp).rank)));
  const curC = ranks.filter((r) => r === 2).length, expgC = ranks.filter((r) => r === 1).length, expdC = ranks.filter((r) => r === 0).length;
  const certPct = (curC + expgC + expdC) ? Math.round((curC / (curC + expgC + expdC)) * 100) : 0;
  const drillsHeld = doneThisYear.length;
  const todayISO = toISODate(new Date());
  const nextSession = (sessions || []).filter((s) => !s.done && toISODate(sessDate(s)) >= todayISO).sort((a, b) => sessDate(a) - sessDate(b))[0] || null;
  const [duties, setDuties] = useState([]);
  const [recruitNext, setRecruitNext] = useState(null);
  const [prNext, setPrNext] = useState(null);
  const [fundNext, setFundNext] = useState(null);
  const [raised, setRaised] = useState(0);
  const [openItems, setOpenItems] = useState([]);   // open action_items → overdue insight (fed to computeInsights)
  const [ringOn, setRingOn] = useState(false);
  useEffect(() => {
    const firstUpcoming = (rows, key) => (rows || []).filter((r) => r[key] && r[key] >= todayISO).sort((a, b) => a[key].localeCompare(b[key]))[0] || null;
    Promise.all([
      supabase.from("duties").select("id, done"),
      supabase.from("recruitment_events").select("id, date, title"),
      supabase.from("content_calendar").select("id, date, caption"),
      supabase.from("funding_events").select("id, date, title"),
      supabase.from("fundraiser_log").select("amount"),
      supabase.from("action_items").select("*").eq("status", "open"),   // for the overdue-assignment insight
    ]).then(([du, rc, cc, fe, fl, ai]) => {
      setDuties(du.data || []);
      setRecruitNext(firstUpcoming(rc.data, "date"));
      setPrNext(firstUpcoming(cc.data, "date"));
      setFundNext(firstUpcoming(fe.data, "date"));
      setRaised((fl.data || []).reduce((s, r) => s + (Number(r.amount) || 0), 0));
      setOpenItems(ai.data || []);
    });
    const t = setTimeout(() => setRingOn(true), 80); return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const dutyDone = duties.filter((d) => d.done).length;
  const dutyCompletion = duties.length ? Math.round((dutyDone / duties.length) * 100) : 100;
  const readiness = Math.round(certPct * 0.40 + avgPart * 0.40 + dutyCompletion * 0.20);   // same formula as DA/Board
  const ringColor = readiness >= 75 ? FIRE.green : readiness >= 50 ? FIRE.amberText : FIRE.redText;
  const fmtISO = (iso) => { const [y, m, d] = iso.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };
  // --- Layer 2 insights (computation only; AI actions are Stage 2 stubs) ---
  const insights = computeInsights({ sessions, members, openItems, todayISO });
  const cards = [
    { key: "training",  title: "Training",         Icon: GraduationCap, accent: "#1F4E79", snap: nextSession ? `${sessDate(nextSession).toLocaleDateString("en-US", { month: "short", day: "numeric" })} · ${nextSession.title}` : null, nav: "training" },
    { key: "recruit",   title: "Recruitment",      Icon: Megaphone,     accent: "#0E6B62", snap: recruitNext ? `${fmtISO(recruitNext.date)} · ${recruitNext.title}` : null, nav: "recruit" },
    { key: "pr",        title: "Public Relations", Icon: Calendar,      accent: "#54506B", snap: prNext ? `${fmtISO(prNext.date)} · ${prNext.caption}` : null, nav: "visibility" },
    { key: "funding",   title: "Fundraising",      Icon: DollarSign,    accent: "#9A6B12", snap: fundNext ? `${fmtISO(fundNext.date)} · ${fundNext.title}` : null, extra: raised > 0 ? `$${raised.toLocaleString()} raised` : null, nav: "funding" },
  ];
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ width: 52, height: 52, borderRadius: 12, background: FIRE.card, border: `0.5px solid ${FIRE.hairline}`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, overflow: "hidden" }}>
          {dept?.logo_url ? <img src={dept.logo_url} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, letterSpacing: ".02em", color: FIRE.redBright }}>{deptMonogram(dept?.name)}</span>}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={FS.kicker}>{dept?.name ? `OFFICER · ${dept.name}` : "OFFICER"}</div>
          <h1 style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "4px 0 0", letterSpacing: "-0.01em" }}>{dashboardGreeting(me)}</h1>
        </div>
      </div>
      <div style={{ ...FS.card, padding: "18px 20px", marginBottom: 12, display: "flex", alignItems: "center", gap: 20, flexWrap: "wrap" }}>
        <div style={{ position: "relative", width: 84, height: 84, flexShrink: 0 }}>
          <svg width="84" height="84" viewBox="0 0 84 84">
            <circle cx="42" cy="42" r={RING_R} fill="none" stroke={FIRE.track} strokeWidth="7" />
            <circle cx="42" cy="42" r={RING_R} fill="none" stroke={ringColor} strokeWidth="7" strokeLinecap="round" strokeDasharray={RING_C} strokeDashoffset={ringOn ? RING_C * (1 - readiness / 100) : RING_C} transform="rotate(-90 42 42)" style={{ transition: "stroke-dashoffset .9s cubic-bezier(.4,0,.2,1)" }} />
          </svg>
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
            <div style={{ fontFamily: DISPLAY, fontSize: 24, fontWeight: 700, color: FIRE.textPrimary, ...FS.num }}>{readiness}%</div>
            <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: ".1em", color: FIRE.textMuted2, textTransform: "uppercase", marginTop: 1 }}>Ready</div>
          </div>
        </div>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={FS.kicker}>DEPARTMENT HEALTH</div>
          <div style={{ fontSize: 13, color: FIRE.textSecondary, marginTop: 6, lineHeight: 1.5 }}>40% certifications · 40% attendance · 20% duty completion</div>
        </div>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12 }}>
        <Stat S={S} dark n={`${certPct}%`} label="Certs current" warn={expdC > 0} />
        <Stat S={S} dark n={`${avgPart}%`} label="Attendance" />
        <Stat S={S} dark n={String(activeCount)} label="Active members" />
        <Stat S={S} dark n={String(drillsHeld)} label="Drills run" />
      </div>
      <div style={{ ...FS.kicker, marginBottom: 8, marginTop: 18 }}>YOUR OPERATIONS</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: 12 }}>
        {cards.map((c) => (
          <div key={c.key} style={{ ...FS.card, padding: "14px 16px", borderTop: `3px solid ${c.accent}`, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}><c.Icon size={16} color={c.accent} /><span style={{ fontWeight: 700, color: FIRE.textPrimary }}>{c.title}</span></div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {c.snap ? <div style={{ fontSize: 13, color: FIRE.textSecondary, lineHeight: 1.4 }}>{c.snap}</div> : <div style={{ fontSize: 13, color: FIRE.textMuted }}>Nothing scheduled</div>}
              {c.extra && <div style={{ fontSize: 12.5, fontWeight: 700, color: FIRE.greenText, marginTop: 4 }}>{c.extra}</div>}
            </div>
            <button style={{ ...FS.btn, marginTop: 10, alignSelf: "flex-start", padding: "6px 11px", fontSize: 12.5 }} onClick={() => go(c.nav)}>Open <ChevronRight size={14} /></button>
          </div>
        ))}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1.7fr", gap: 12, marginTop: 18, marginBottom: 6 }}>
        <Announcements role={role} members={members} meId={meId} notify={notify} />
        <div style={{ minWidth: 0 }}>
          <DashboardCalendar S={S} notify={notify} withImportanceMode />
        </div>
      </div>
      <InsightCards insights={insights} go={go} />
    </div>
  );
}
function Dashboard({ S, role, members, library, openPacket, go, meId, sessions, notify, dept }) {
  if (hasAny(role, ["Project Admin"])) return <ProgramOverview S={S} role={role} notify={notify} />;   // PA home = Program Overview (must be FIRST — PA also passes isDeptAdmin)
  if (!isLeader(role)) return <MemberDashboard S={S} role={role} members={members} go={go} meId={meId} sessions={sessions} notify={notify} dept={dept} />;
  if (isDeptAdmin(role)) return <DeptAdminDashboard S={S} role={role} members={members} go={go} meId={meId} sessions={sessions} notify={notify} dept={dept} />;
  if (isBoard(role) && !hasAny(role, ['Officer'])) return <BoardDashboard S={S} role={role} members={members} go={go} meId={meId} sessions={sessions} notify={notify} dept={dept} />;
  return <OfficerDashboard S={S} role={role} members={members} go={go} meId={meId} sessions={sessions} notify={notify} dept={dept} />;
}

/* ---------------- Quick access (home page doorways) ---------------- */
const QUICK = {
  library: { accent: "#1F4E79", blurb: "Ready-to-run packets for Fire, EMS, Leadership & Operations." },
  training: { accent: "#1F4E79", blurb: "A recurring training plan + calendar that flags what's coming and overdue." },
  ai:      { accent: "#54506B", blurb: "Describe your crew — get a full drill plan in seconds." },
  documents: { accent: "#1F4E79", blurb: "Upload your SOPs and guidelines, or draft new ones with AI." },
  roster: { accent: "#1F4E79", blurb: "Members, certifications, attendance, and the chief's reports." },
  onboarding: { accent: "#0E6B62", blurb: "Guided checklist + AI welcome plan for every new volunteer." },
  apparatus: { accent: "#B11E2A", blurb: "Log apparatus and equipment checks — know your rigs are ready." },
  recruit: { accent: "#0E6B62", blurb: "Build a recruitment plan and find members on and off social." },
  visibility: { accent: "#54506B", blurb: "A content calendar and ideas to keep your department seen." },
  brand: { accent: "#54506B", blurb: "Colors, logo, font, guidelines — then build on-brand graphics." },
  duties: { accent: "#1F4E79", blurb: "Who does what around the station, and a log of who did it." },
  funding: { accent: "#9A6B12", blurb: "Plan fundraisers, draft appeals, and line up sponsors." },
  minutes: { accent: "#3A4750", blurb: "Turn rough notes into clean minutes and track every action item." },
  request: { accent: "#3A4750", blurb: "Tell us what your crew needs; we build it into the next drop." },
  admin:   { accent: "#B11E2A", blurb: "Publish new monthly materials to the library." },
};
function QuickAccess({ S, role, go }) {
  const items = NAV.filter((n) => n.key !== "dashboard" && hasAny(role, n.roles));
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ ...FS.kicker, marginBottom: 8 }}>EXPLORE THE PLATFORM</div>
      <div style={S.quickGrid}>
        {items.map((n) => {
          const q = QUICK[n.key] || {};
          return (
            <button key={n.key} style={{ ...S.quickCard, ...FS.card }} onClick={() => go(n.key)}>
              <span style={{ ...S.quickIcon, background: q.accent }}><n.Icon size={18} color="#fff" /></span>
              <div style={{ flex: 1 }}>
                <div style={{ ...S.quickTitle, color: FIRE.textPrimary }}>{n.label}{n.premium && <span style={S.quickAi}>AI</span>}</div>
                <div style={{ ...S.quickBlurb, color: FIRE.textMuted }}>{q.blurb}</div>
              </div>
              <ChevronRight size={16} color={FIRE.btnIcon} style={{ flexShrink: 0, alignSelf: "center" }} />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ---------------- Member dashboard (personal view) ---------------- */
// Monogram from a department name — initials of the significant words (skips of/the/volunteer/fire/department/…), max 3 letters.
const DEPT_STOPWORDS = new Set(["of", "the", "and", "volunteer", "fire", "department", "dept", "company", "co", "vfd", "vfrd", "ems", "rescue", "station", "district"]);
function deptMonogram(name) {
  if (!name) return "";
  const words = name.split(/\s+/).map((w) => w.replace(/[^A-Za-z]/g, "")).filter((w) => w && !DEPT_STOPWORDS.has(w.toLowerCase()));
  const initials = words.map((w) => w[0]).join("").toUpperCase();
  return (initials || name.replace(/[^A-Za-z]/g, "").toUpperCase()).slice(0, 3);
}
// Member self-propose a cert with mandatory proof + a status view (pending/approved/rejected). Member-facing.
function CertProposals({ S, notify }) {
  const [ids, setIds] = useState(null);   // { memberId, deptId } from my_member_id()/my_department_id() — match the RLS guards
  const [subs, setSubs] = useState([]);
  const [name, setName] = useState(""); const [exp, setExp] = useState(""); const [note, setNote] = useState("");
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(false);   // collapsed by default — the form expands on toggle
  useEffect(() => {
    Promise.all([supabase.rpc("my_member_id"), supabase.rpc("my_department_id")])
      .then(([m, d]) => setIds({ memberId: m.data || null, deptId: d.data || null }));
  }, []);
  async function loadSubs(mid) {
    const { data } = await supabase.from("cert_submissions").select("id, name, exp, status, note, proof_path, created_at").eq("member_id", mid).order("created_at", { ascending: false });
    setSubs(data || []);
  }
  useEffect(() => { if (ids?.memberId) loadSubs(ids.memberId); }, [ids]);
  async function submit() {
    if (!name.trim()) { notify({ kind: "error", title: "Certification needs a name", text: "Enter the certification name." }); return; }
    const e = exp.trim();
    if (e && !/^\d{4}-\d{2}$/.test(e)) { notify({ kind: "error", title: "Check the expiration format", text: "Expiration must be YYYY-MM (e.g. 2027-06)." }); return; }
    if (!file) { notify({ kind: "error", title: "Proof required", text: "Attach a PDF or photo of the certification." }); return; }
    if (!ids?.memberId || !ids?.deptId) { notify({ kind: "error", title: "No member profile", text: "We couldn't find your member profile." }); return; }
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { notify({ kind: "error", title: "You're not signed in", text: "Please sign in again." }); return; }
    setBusy(true);
    // 1) upload proof — path scoped to {dept}/cert-proofs/{member}/ (matches the storage policy)
    const path = `${ids.deptId}/cert-proofs/${ids.memberId}/${Date.now()}-${file.name}`;
    const { error: upErr } = await supabase.storage.from("station-documents").upload(path, file);
    if (upErr) { setBusy(false); notify({ kind: "error", title: "Couldn't upload the proof", text: "Something went wrong uploading that. Please try again.", details: upErr.message }); return; }
    // 2) insert the submission — fields match the INSERT policy guards exactly
    const { error: insErr } = await supabase.from("cert_submissions").insert({ department_id: ids.deptId, member_id: ids.memberId, name: name.trim(), exp: e || null, status: "pending", source: "self", note: note.trim() || null, proposed_by: user.id, proof_path: path });
    setBusy(false);
    if (insErr) { notify({ kind: "error", title: "Couldn't submit", text: "The proof uploaded but the request couldn't be saved. Please try again.", details: insErr.message }); return; }
    setName(""); setExp(""); setNote(""); setFile(null); setOpen(false);   // auto-collapse after a successful propose
    notify({ kind: "success", text: "Submitted for review." });
    loadSubs(ids.memberId);
  }
  const pendingCount = subs.filter((s) => s.status === "pending").length;
  if (ids && !ids.memberId) return null;   // no member profile → no self-propose (e.g. a non-member admin)
  return (
    <div style={{ ...FS.card, padding: 18, marginBottom: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <div style={FS.kicker}>PROPOSE A CERTIFICATION</div>
        {open
          ? <button style={{ ...FS.btn, padding: "5px 10px", fontSize: 12 }} onClick={() => setOpen(false)}><X size={13} color={FIRE.btnIcon} /> Cancel</button>
          : <button style={{ ...FS.btn, padding: "5px 12px", fontSize: 12.5 }} onClick={() => setOpen(true)}><Plus size={14} color={FIRE.btnIcon} /> Propose a certification</button>}
      </div>
      {open && (<>
        <div style={{ fontSize: 12.5, color: FIRE.textSecondary, lineHeight: 1.5, margin: "8px 0 12px" }}>Add a cert to your record — attach a PDF or photo as proof. A leader reviews and approves it.</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...S.field, flex: 1, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Certification</span><input style={FS.input} value={name} onChange={(e2) => setName(e2.target.value)} placeholder="e.g. EMT-B" /></label>
          <label style={{ ...S.field, minWidth: 120 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Expires (YYYY-MM)</span><input style={FS.input} value={exp} onChange={(e2) => setExp(e2.target.value)} placeholder="2027-06" /></label>
          <label style={{ ...S.field, flex: 1, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Note (optional)</span><input style={FS.input} value={note} onChange={(e2) => setNote(e2.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Proof (required)</span><input type="file" accept=".pdf,image/*" onChange={(e2) => setFile(e2.target.files?.[0] || null)} style={{ ...FS.input, padding: "6px 8px", fontSize: 12 }} /></label>
          <button style={{ ...FS.btnPrimary, opacity: (busy || !file || !name.trim()) ? 0.55 : 1 }} onClick={submit} disabled={busy || !file || !name.trim()}>{busy ? "Submitting…" : "Submit for review"}</button>
        </div>
        {!file && <div style={{ fontSize: 11.5, color: FIRE.amberText, marginTop: 8 }}>Proof required — attach a PDF or photo to submit.</div>}
      </>)}
      {pendingCount > 0 && <div style={{ fontSize: 12, color: FIRE.amberText, marginTop: 12, ...FS.num }}>{pendingCount} certification{pendingCount === 1 ? "" : "s"} pending review.</div>}
    </div>
  );
}
function MemberDashboard({ S, role, members, go, meId, sessions, notify, dept }) {
  const DISPLAY = "'Oswald', system-ui, sans-serif";
  const me = members.find((m) => m.id === meId) || null;
  const sess = sessions || [];
  // ---- derived (lifted from the member Training branch; no new query/RLS) ----
  const today = new Date();
  const t0 = new Date(today); t0.setHours(0, 0, 0, 0);
  // per-CALENDAR-MONTH attendance rate for this member (null when a month has no recorded drills)
  const monthRate = (Y, M) => {
    const meLeader = isLeader(me?.access);   // score off the member's ACTUAL roles (not "View as")
    const rec = sess.filter((s) => s.done && (s.attendance || []).length > 0 && s.y === Y && s.m === M && (meLeader || s.audience !== "leadership"));
    if (!rec.length) return null;
    const att = me ? rec.filter((s) => (s.attendance || []).includes(me.id)).length : 0;
    return { total: rec.length, attended: att, pct: Math.round((att / rec.length) * 100) };
  };
  const thisMonth = monthRate(today.getFullYear(), today.getMonth());
  const pM = today.getMonth() === 0 ? 11 : today.getMonth() - 1;
  const pY = today.getMonth() === 0 ? today.getFullYear() - 1 : today.getFullYear();
  const lastMonth = monthRate(pY, pM);
  const ringPct = thisMonth ? thisMonth.pct : 0;                                    // 0–100; only drawn as fill when hasThisMonth
  const hasThisMonth = !!thisMonth;                                                 // this month has ≥1 recorded drill
  const trend = (thisMonth && lastMonth) ? thisMonth.pct - lastMonth.pct : null;    // only when BOTH months have data
  const RING_R = 34, RING_C = 2 * Math.PI * RING_R;                                 // ring geometry (circumference for stroke-dash)
  const trainingsThisMonth = sess.filter((s) => s.y === today.getFullYear() && s.m === today.getMonth()).length;
  const upcoming = sess.filter((s) => !s.done && sessDate(s) >= t0).sort((a, b) => sessDate(a) - sessDate(b)).slice(0, 4);   // next 4 only (display cap)
  const certsAll = me ? me.certs.map((c) => ({ ...c, st: certStatus(c.exp) })).sort((a, b) => a.st.rank - b.st.rank) : [];
  const certsCurrent = certsAll.filter((c) => c.st.rank === 2).length;
  const certsTotal = certsAll.length;
  const expiringSoon = certsAll.filter((c) => c.st.rank === 1).length;
  const expired = certsAll.filter((c) => c.st.rank === 0).length;
  const certAlert = expired > 0 ? { color: FIRE.redText, text: `${expired} expired` } : expiringSoon > 0 ? { color: FIRE.amberText, text: `${expiringSoon} expiring soon` } : { color: FIRE.greenText, text: "All current" };
  // ---- "Assigned to me" duties (self-contained; no App threading; existing read RLS) ----
  const [mine, setMine] = useState([]);
  function loadMine() {
    if (!meId) return;
    supabase.from("duties").select("id, duty, due_date, done, done_at, assigned_to").eq("assigned_to", meId)
      .then(({ data }) => setMine(data || []));   // open + completed (done filter dropped); partitioned below
  }
  useEffect(() => { loadMine(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [meId]);
  const mineOpen = mine.filter((d) => !d.done);
  const mineDone = mine.filter((d) => d.done);
  async function markMineDone(id) {
    const { error } = await supabase.rpc("complete_duty", { p_duty_id: id, p_helper_ids: [] });   // assignee allowed by the RPC rule
    if (error) { notify({ kind: "error", title: "Couldn't mark it done", text: "Something went wrong updating that. Please try again.", details: error.message }); return; }
    loadMine();   // refetch — the duty moves from mineOpen → mineDone (loader now returns both)
  }
  // ---- Next event: soonest upcoming across the SAME 4 live calendar tables DashboardCalendar reads (NOT the unused `events` table) ----
  const [upcomingAll, setUpcomingAll] = useState([]);   // all sorted upcoming across the 4 calendar sources; nextEvent derived at render (audience-aware)
  const [prepOpen, setPrepOpen] = useState(false);   // Get-prepared file-list toggle (multiple/AI)
  const { openSessionPlans, openPlan, setViewPlan, mounts } = usePlanViewer(S, notify);
  const [ringOn, setRingOn] = useState(false);       // attendance-ring fill animation
  useEffect(() => {
    const todayIso = toISO(today);
    Promise.all([
      supabase.from("training_sessions").select("id, title, date, audience"),
      supabase.from("funding_events").select("title, date"),
      supabase.from("recruitment_events").select("title, date"),
      supabase.from("content_calendar").select("caption, date"),
    ]).then(([tr, fu, rc, so]) => {
      const rows = [
        ...(tr.data || []).map((r) => ({ id: r.id, title: r.title, date: r.date, type: "Training", audience: r.audience || "everyone" })),
        ...(fu.data || []).map((r) => ({ title: r.title, date: r.date, type: "Fundraiser" })),
        ...(rc.data || []).map((r) => ({ title: r.title, date: r.date, type: "Recruitment" })),
        ...(so.data || []).map((r) => ({ title: r.caption, date: r.date, type: "Social" })),
      ].filter((r) => r.date && r.date >= todayIso);                    // upcoming = date >= today (ISO string compare)
      rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));   // YYYY-MM-DD sorts chronologically
      setUpcomingAll(rows);                                             // store all upcoming; select at render (leadership-aware)
    });
    /* eslint-disable-next-line react-hooks/exhaustive-deps */
  }, []);
  useEffect(() => { const id = setTimeout(() => setRingOn(true), 50); return () => clearTimeout(id); }, [ringPct]);   // animate ring fill on load / when the rate changes
  // Get prepared: a Training next-event's attachments come from the already-loaded sessions prop (s.plans[] from slice 1) — no extra query.
  // NEXT EVENT: a non-leader's next event skips leadership training (still shown on the calendar). Leader sees it. Scored off actual roles (me.access), not "View as".
  const nextEvent = upcomingAll.find((e) => isLeader(me?.access) || !(e.type === "Training" && e.audience === "leadership")) || null;
  const nextSession = nextEvent?.type === "Training" ? sess.find((x) => String(x.id) === String(nextEvent.id)) : null;
  const nextPlans = nextSession?.plans || [];
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      {/* 1 — greeting + dept crest (real logo_url when set; monogram fallback until logo persistence exists) */}
      <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 18 }}>
        <div style={{ width: 52, height: 52, borderRadius: 12, flexShrink: 0, display: "grid", placeItems: "center", background: FIRE.card, border: `1.5px solid ${FIRE.red}`, boxShadow: "0 0 14px rgba(200,50,58,.30)", overflow: "hidden" }}>
          {dept?.logo_url
            ? <img src={dept.logo_url} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
            : <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 18, letterSpacing: ".02em", color: FIRE.redBright }}>{deptMonogram(dept?.name)}</span>}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={FS.kicker}>{dept?.name ? `MY STATION · ${dept.name}` : "MY STATION"}</div>
          <h1 style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>{dashboardGreeting(me)}</h1>
          <div style={{ fontSize: 14, color: FIRE.textMuted2, lineHeight: 1.5 }}>Here's exactly where you stand — and what's coming up for you.</div>
        </div>
      </div>
      {/* 2 — stat row: 2 boxes (attendance+training merged | next event) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 12, marginBottom: 14 }}>
        {/* attendance ring (per-CALENDAR-MONTH rate) + supporting stats; muted "No drills yet" state, not a red 0% */}
        <div style={{ ...FS.card, padding: "14px 16px" }}>
          <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".14em", color: FIRE.textMuted2, fontWeight: 700 }}>ATTENDANCE</div>
          <div style={{ display: "flex", gap: 16, marginTop: 10, alignItems: "center" }}>
            <div style={{ position: "relative", width: 84, height: 84, flexShrink: 0 }}>
              <svg width="84" height="84" viewBox="0 0 84 84">
                <circle cx="42" cy="42" r={RING_R} fill="none" stroke={FIRE.track} strokeWidth="7" />
                {hasThisMonth && (
                  <circle cx="42" cy="42" r={RING_R} fill="none" stroke={FIRE.redBright} strokeWidth="7" strokeLinecap="round"
                    strokeDasharray={RING_C} strokeDashoffset={ringOn ? RING_C * (1 - ringPct / 100) : RING_C}
                    transform="rotate(-90 42 42)" style={{ transition: "stroke-dashoffset .9s cubic-bezier(.4,0,.2,1)" }} />
                )}
              </svg>
              <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center" }}>
                {hasThisMonth ? (
                  <>
                    <div style={{ fontSize: 21, fontWeight: 700, color: FIRE.textPrimary, ...FS.num }}>{ringPct}%</div>
                    <div style={{ fontSize: 8, fontWeight: 700, letterSpacing: ".1em", color: FIRE.textMuted2, textTransform: "uppercase", marginTop: 1 }}>this month</div>
                  </>
                ) : (
                  <div style={{ fontSize: 10.5, fontWeight: 600, color: FIRE.textMuted, textAlign: "center", lineHeight: 1.2, padding: "0 8px" }}>No drills yet</div>
                )}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {hasThisMonth
                ? <div style={{ fontSize: 14, fontWeight: 600, color: FIRE.textPrimary }}>{thisMonth.attended} of {thisMonth.total} drills</div>
                : <div style={{ fontSize: 13.5, color: FIRE.textMuted }}>No drills recorded this month</div>}
              <div style={{ fontSize: 11.5, color: FIRE.textMuted, marginTop: 2 }}>{trainingsThisMonth} scheduled · {TRAIN_MONTHS[today.getMonth()]}</div>
              {trend != null && (() => {
                const up = trend > 0, down = trend < 0;
                const color = up ? FIRE.greenText : down ? FIRE.redText : FIRE.textMuted2;
                const label = up ? `↑ up from ${lastMonth.pct}% last month` : down ? `↓ down from ${lastMonth.pct}% last month` : `→ level with last month (${lastMonth.pct}%)`;
                return <div style={{ fontSize: 11.5, fontWeight: 700, marginTop: 7, color }}>{label}</div>;
              })()}
            </div>
          </div>
        </div>
        {/* next event: soonest across all 4 calendar sources; "Get prepared" surfaces a Training's attachments (members read-only) */}
        <div style={{ ...FS.card, padding: "14px 16px" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 10 }}>
            <div style={{ minWidth: 0 }}>
              <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".14em", color: FIRE.textMuted2, fontWeight: 700 }}>NEXT EVENT</div>
              {nextEvent ? (
                <>
                  <div style={{ fontSize: 26, fontWeight: 700, color: FIRE.textPrimary, marginTop: 6, ...FS.num }}>{new Date(nextEvent.date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" })}</div>
                  <div style={{ fontSize: 12.5, color: FIRE.textMuted, marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{nextEvent.title || "—"}</div>
                  <div style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".1em", marginTop: 5, color: ({ Training: FIRE.redBright, Fundraiser: FIRE.amberText, Recruitment: FIRE.greenText, Social: FIRE.textSecondary }[nextEvent.type] || FIRE.textSecondary) }}>{nextEvent.type}<LeadershipTag audience={nextEvent.audience} /></div>
                </>
              ) : (
                <div style={{ fontSize: 13, color: FIRE.textMuted, marginTop: 10 }}>Nothing scheduled</div>
              )}
            </div>
            {nextPlans.length > 0 && (
              <button
                onClick={() => { if (nextPlans.length === 1 && nextPlans[0].kind === "file") openPlan(nextPlans[0]); else setPrepOpen((v) => !v); }}
                style={{ ...FS.btn, padding: "6px 10px", fontSize: 12, flexShrink: 0, whiteSpace: "nowrap" }}
              >
                <FileText size={13} color={FIRE.btnIcon} /> Get prepared{nextPlans.length > 1 ? ` (${nextPlans.length})` : ""}
              </button>
            )}
          </div>
          {prepOpen && nextPlans.length > 0 && (
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: `0.5px solid ${FIRE.hairline}` }}>
              {nextPlans.map((p) => (
                <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0" }}>
                  <FileText size={13} color={p.kind === "ai" ? FIRE.amberText : FIRE.btnIcon} style={{ flexShrink: 0 }} />
                  <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: FIRE.name, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || (p.kind === "ai" ? "AI-drafted plan" : "Untitled")}</span>
                  {p.kind === "file"
                    ? <button onClick={() => openPlan(p)} style={{ ...FS.btn, padding: "4px 8px", fontSize: 11.5, flexShrink: 0 }}>Open</button>
                    : <button onClick={() => setViewPlan(p)} style={{ ...FS.btn, padding: "4px 8px", fontSize: 11.5, flexShrink: 0 }}>View</button>}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {mounts}
      {/* 3 — cards (3-up): My Certifications | Assigned Duties | Upcoming Training */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 14 }}>
        {/* My Certifications — count/status header (merged from old Certs-current stat) + list */}
        <div style={{ ...FS.card, padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={FS.kicker}>MY CERTIFICATIONS</div>
            <span style={{ fontSize: 11, fontWeight: 700, color: certAlert.color, ...FS.num }}>{certsCurrent}/{certsTotal} · {certAlert.text}</span>
          </div>
          <div style={{ marginTop: 10 }}>
            {certsAll.length === 0 ? (
              <div style={{ fontSize: 13, color: FIRE.textMuted }}>No certifications on file yet.</div>
            ) : certsAll.map((c, i) => (
              <div key={c.id ?? i} style={{ ...FS.row, padding: "9px 0" }}>
                <Award size={15} color={CERT_FIRE[c.st.label]} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.name }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num }}>{expPhrase(c.exp)}</div>
                </div>
                <Pill S={S} color={CERT_FIRE[c.st.label]}>{c.st.label}</Pill>
              </div>
            ))}
          </div>
        </div>
        {/* Assigned Duties — open (interactive) + completed (struck-through via done_at); always shown */}
        <div style={{ ...FS.card, padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={FS.kicker}>ASSIGNED DUTIES</div>
            {(mineOpen.length + mineDone.length) > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: FIRE.textMuted2, ...FS.num }}>{mineDone.length} of {mineOpen.length + mineDone.length} done</span>}
          </div>
          <div style={{ marginTop: 10 }}>
            {(mineOpen.length + mineDone.length) === 0 ? (
              <div style={{ fontSize: 13, color: FIRE.textMuted }}>No duties assigned to you.</div>
            ) : (
              <>
                {mineOpen.map((d) => {
                  let badge = null;
                  if (d.due_date) {
                    const dd = new Date(d.due_date + "T00:00:00");
                    const tn = new Date(); tn.setHours(0, 0, 0, 0);
                    const days = Math.round((dd - tn) / 86400000);
                    const tone = days < 0 ? FIRE.redText : days <= 7 ? FIRE.amberText : FIRE.textMuted2;
                    const dl = dd.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                    badge = <span style={{ fontSize: 11.5, fontWeight: 700, color: tone, ...FS.num }}>{days < 0 ? `Overdue ${dl}` : `Due ${dl}`}</span>;
                  }
                  return (
                    <div key={d.id} style={{ ...FS.row, padding: "9px 0" }}>
                      <ClipboardCheck size={15} color={FIRE.btnIcon} style={{ flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.name }}>{d.duty}</div>
                        {badge && <div style={{ marginTop: 2 }}>{badge}</div>}
                      </div>
                      <button onClick={() => markMineDone(d.id)} style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }}><CheckCircle2 size={13} color={FIRE.btnIcon} /> Mark done</button>
                    </div>
                  );
                })}
                {mineDone.length > 0 && (
                  <div style={{ marginTop: mineOpen.length ? 8 : 0, paddingTop: mineOpen.length ? 8 : 0, borderTop: mineOpen.length ? `0.5px solid ${FIRE.hairline}` : "none" }}>
                    {mineDone.map((d) => {
                      const dl = d.done_at ? new Date(d.done_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : null;
                      return (
                        <div key={d.id} style={{ ...FS.row, padding: "9px 0" }}>
                          <CheckCircle2 size={15} color={FIRE.green} style={{ flexShrink: 0 }} />
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textMuted2, textDecoration: "line-through" }}>{d.duty}</div>
                            {dl && <div style={{ fontSize: 11.5, color: FIRE.textMuted, marginTop: 2, ...FS.num }}>Done {dl}</div>}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        </div>
        {/* Upcoming Training — unchanged */}
        <div style={{ ...FS.card, padding: 18 }}>
          <div style={FS.kicker}>UPCOMING TRAINING</div>
          <div style={{ marginTop: 10 }}>
            {upcoming.length === 0 ? (
              <div style={{ fontSize: 13, color: FIRE.textMuted }}>Nothing scheduled yet.</div>
            ) : upcoming.map((s) => (
              <div key={s.id} style={{ ...FS.row, padding: "9px 0" }}>
                <CalendarCheck size={15} color={FIRE.btnIcon} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.name }}>{s.title}</div>
                  <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num }}>{fmtSess(s)}</div>
                </div>
                {s.plan && <button onClick={() => openSessionPlans(s)} style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }}>Open plan</button>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 4b — member self-propose a cert + proof + status */}
      <CertProposals S={S} notify={notify} />
      {/* 5 — announcements feed + station calendar, two-column (matches DeptAdmin: feed narrower & bounded/internal-scroll, calendar wider; wraps on narrow) */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 14 }}>
        <Announcements role={role} members={members} meId={meId} notify={notify} style={{ flex: "1 1 240px" }} />
        <div style={{ flex: "2 1 340px", minWidth: 0 }}>
          <div style={{ ...FS.card, padding: 16 }}>
            <DashboardCalendar S={S} notify={notify} />
          </div>
        </div>
      </div>

      {/* 6 — quick actions (member-filtered NAV; new FS styling, shared QuickAccess untouched) */}
      <div style={{ ...FS.card, padding: 18 }}>
        <div style={FS.kicker}>QUICK ACTIONS</div>
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          {NAV.filter((n) => n.key !== "dashboard" && hasAny(role, n.roles)).map((n) => (
            <button key={n.key} onClick={() => go(n.key)} style={{ ...FS.row, padding: "10px 12px", background: FIRE.btnBg, border: `0.5px solid ${FIRE.btnBorder}`, borderRadius: 10, cursor: "pointer", textAlign: "left" }}>
              <n.Icon size={16} color={FIRE.btnIcon} style={{ flexShrink: 0 }} />
              <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: FIRE.btnText }}>{n.label}</span>
              <ChevronRight size={15} color={FIRE.textMuted} style={{ flexShrink: 0 }} />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Library ---------------- */
function Library({ S, library, openPacket }) {
  const [q, setQ] = useState(""); const [track, setTrack] = useState("All");
  const results = useMemo(() => library.filter((p) => {
    const okT = track === "All" || p.track === track;
    const okQ = !q || (p.title + p.code + p.objective).toLowerCase().includes(q.toLowerCase());
    return okT && okQ;
  }), [library, q, track]);
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>TRAINING LIBRARY</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Find a packet</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Search by topic or filter by track. Every packet is ready to run tonight.</div>
      </div>
      <div style={{ ...S.searchBox, ...FS.card, marginBottom: 14 }}>
        <Search size={18} color={FIRE.btnIcon} />
        <input style={{ ...S.searchInput, color: FIRE.textPrimary }} placeholder="Search packets (e.g. stroke, mayday, budget)…" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <button style={{ ...S.clearBtn, color: FIRE.textMuted }} onClick={() => setQ("")}><X size={15} /></button>}
      </div>
      <div style={S.chipRow}>
        {[["All", "All", null], ...Object.keys(TRACKS).map((k) => [k, TRACKS[k].label, TRACKS[k].accent])].map(([k, label, accent]) => {
          const on = track === k;
          return <button key={k} onClick={() => setTrack(k)} style={{ cursor: "pointer", borderRadius: 999, padding: "5px 13px", fontSize: 13, fontWeight: 700, fontFamily: "inherit", background: on ? FIRE.btnBg : "transparent", color: on ? FIRE.textPrimary : FIRE.navLabel, border: `0.5px solid ${on ? (accent || FIRE.red) : FIRE.btnBorder}` }}>{label}</button>;
        })}
      </div>
      {results.length === 0 ? (
        <div style={{ ...FS.card, padding: 36, textAlign: "center", color: FIRE.textMuted }}>No packets match that yet. Try a broader term, or request a custom packet from the menu.</div>
      ) : (
        <div style={S.cardGrid}>{results.map((p) => <RunCard key={p.id} S={S} p={p} onClick={() => openPacket(p.id)} />)}</div>
      )}
    </div>
  );
}
function RunCard({ S, p, onClick }) {
  const T = TRACKS[p.track];
  return (
    <button style={{ ...S.runCard, ...FS.card, cursor: "pointer", textAlign: "left", borderLeft: `4px solid ${T.accent}` }} onClick={onClick}>
      <div style={S.runTop}><span style={{ ...S.runCode, color: T.accent }}>{p.code}</span><T.Icon size={16} color={T.accent} /></div>
      <h3 style={{ ...S.runTitle, color: FIRE.textPrimary }}>{p.title}</h3>
      <p style={{ ...S.runObj, color: FIRE.textMuted }}>{p.objective}</p>
      <div style={{ ...S.runFoot, color: FIRE.textMuted }}><span><Clock size={13} /> {p.time}</span><span style={S.runUpdated}>Updated {p.updated}</span></div>
    </button>
  );
}

/* ---------------- Packet ---------------- */
function Packet({ S, packet, back }) {
  const T = TRACKS[packet.track];
  return (
    <div>
      <button style={S.backBtn} onClick={back}><ArrowLeft size={16} /> Back to library</button>
      <div style={S.packetHead}>
        <div style={{ ...S.packetStripe, background: T.accent }} />
        <div style={S.packetHeadInner}>
          <div style={S.metaRow}><span style={{ ...S.runCode, color: T.accent }}>{packet.code}</span><TrackPill S={S} track={packet.track} /></div>
          <h1 style={S.packetTitle}>{packet.title}</h1>
          <div style={S.metaRow}><Meta Icon={Clock} text={packet.time} /><Meta Icon={Users} text={packet.level} /></div>
          <button style={S.primaryBtn}><Download size={16} /> Download packet (PDF)</button>
        </div>
      </div>
      <Disclaimer S={S} />
      <Section S={S} Icon={ClipboardList} title="Objective"><p style={S.body}>{packet.objective}</p></Section>
      <Section S={S} Icon={Wrench} title="Required equipment"><ul style={S.list}>{packet.equipment.map((e, i) => <li key={i}>{e}</li>)}</ul></Section>
      <Section S={S} Icon={GraduationCap} title="Instructor guide"><p style={S.body}>{packet.instructorGuide}</p></Section>
      <Section S={S} Icon={FileText} title="Step-by-step lesson plan">
        <div style={S.steps}>{packet.steps.map((s, i) => (
          <div key={i} style={S.step}><span style={S.stepNum}>{String(i + 1).padStart(2, "0")}</span>
            <div style={{ flex: 1 }}><div style={S.stepTitle}>{s.t} <span style={S.stepMin}>{s.m} min</span></div><div style={S.stepDetail}>{s.d}</div></div></div>
        ))}</div>
      </Section>
      <Section S={S} Icon={Flame} title="Scenario / drill setup"><p style={S.body}>{packet.scenario}</p></Section>
      <div style={S.safetyBox}><div style={S.safetyHead}><ShieldAlert size={18} /> Safety considerations</div><ul style={S.list}>{packet.safety.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
      <Section S={S} Icon={Users} title="Discussion questions"><ul style={S.list}>{packet.discussion.map((d, i) => <li key={i}>{d}</li>)}</ul></Section>
      <Section S={S} Icon={CheckCircle2} title="Evaluation checklist">
        <div style={S.checklist}>{packet.evaluation.map((e, i) => <label key={i} style={S.check}><input type="checkbox" /> <span>{e}</span></label>)}</div>
      </Section>
      <Section S={S} Icon={ClipboardList} title="Debrief questions"><ul style={S.list}>{packet.debrief.map((d, i) => <li key={i}>{d}</li>)}</ul></Section>
    </div>
  );
}

/* ---------------- shared Claude call (via /api/claude) ---------------- */
async function callClaude(system, user) {
  const res = await fetch("/api/claude", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, user }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "AI request failed");
  return data.text || "";
}
// Multi-turn variant — posts a full conversation array. messages = [{ role: 'user'|'assistant', content }, …].
// Backward-compatible with callClaude: same endpoint, same return; the proxy branches on `messages`.
async function callClaudeChat(system, messages) {
  const res = await fetch("/api/claude", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ system, messages }),
  });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || "AI request failed");
  return data.text || "";
}

/* ---------------- Study Session (member-facing, interactive multi-turn AI tutor) ---------------- */
const CERT_TRACKS = {
  "Basic Fire Certifications": ["Firefighter I", "Firefighter II", "Basic Firefighter", "Exterior Firefighter", "Structural Firefighter", "Wildland Firefighter", "Airport Firefighter (ARFF)", "Industrial Firefighter"],
  "Rescue": ["Vehicle Extrication", "Rope Rescue", "Confined Space Rescue", "Structural Collapse Rescue", "Trench Rescue", "Water Rescue", "Swiftwater Rescue", "Dive Rescue", "Ice Rescue", "Wilderness Rescue", "Large Animal Rescue", "Technical Rescue Technician"],
  "EMS": ["Medical First Responder (MFR)", "Emergency Medical Responder (EMR)", "Emergency Medical Technician (EMT)", "Advanced EMT (AEMT)", "Paramedic", "CPR", "Basic Life Support (BLS)", "Advanced Cardiac Life Support (ACLS)", "Pediatric Advanced Life Support (PALS)", "Prehospital Trauma Life Support (PHTLS)", "ITLS", "Stop the Bleed Instructor"],
  "Hazardous Materials": ["HazMat Awareness", "HazMat Operations", "HazMat Technician", "HazMat Incident Commander", "HazMat Specialist", "Radiological Response", "CBRNE Awareness"],
  "Incident Command": ["ICS-100", "ICS-200", "ICS-300", "ICS-400", "IS-700", "IS-800", "NIMS Compliance", "Unified Command", "Incident Safety Officer"],
  "Officer Development": ["Fire Officer I", "Fire Officer II", "Fire Officer III", "Fire Officer IV", "Company Officer", "Chief Officer", "Executive Fire Officer", "Leadership Development"],
  "Instructor Development": ["Fire Instructor", "Instructor I", "Instructor II", "Instructor III", "Live Fire Instructor", "Evaluator", "Training Coordinator", "Training Officer"],
  "Fire Inspector": ["Inspector I", "Inspector II", "Plans Examiner", "Fire Marshal", "Code Enforcement", "Fire Investigator", "Juvenile Fire Setter Intervention"],
  "Apparatus & Driver": ["Emergency Vehicle Operator (EVOC)", "Driver Operator", "Driver Operator Pumper", "Driver Operator Aerial", "Driver Operator Mobile Water Supply", "Tanker Shuttle Operations", "Brush Truck Operations", "Trailer Operations", "UTV Operations"],
  "Communications": ["Radio Communications", "Dispatch Procedures", "Mayday Operations", "RIT Operations", "Accountability Officer", "Communications Unit Leader"],
  "Safety": ["Firefighter Survival", "Rapid Intervention Team (RIT)", "Fire Ground Safety", "Safety Officer", "Behavioral Health", "Peer Support", "Cancer Prevention", "Rehabilitation Officer", "Thermal Imaging"],
  "Specialized": ["Chainsaw Operations", "Ventilation", "High Rise Operations", "Grain Bin Rescue", "Elevator Rescue", "Farm Rescue", "Pipeline Emergency Response", "Railroad Incident Response", "Lithium Battery Fires", "Electric Vehicle Response", "Solar Energy Fires", "Propane Emergencies", "Natural Gas Emergencies", "Marine Firefighting", "Mass Casualty Incident (MCI)", "Active Threat Response", "School Safety Response", "Weather Spotter", "Drone Pilot (FAA Part 107)", "Fire Photography", "PIO Training", "Grant Writing", "Recruitment & Retention", "Public Education", "Fire Prevention Educator", "Community Risk Reduction"],
  "Administrative": ["Grant Management", "Nonprofit Board Governance", "Records Management", "OSHA Compliance", "Volunteer Coordinator", "Emergency Management", "Public Information Officer (PIO)", "Finance Officer", "Secretary Training", "Treasurer Training"],
  "Department Qualifications (Non-Certification)": ["Interior Qualified", "Exterior Qualified", "Pump Operator Qualified", "Ladder Qualified", "Driver Cleared", "Brush Truck Qualified", "Rescue Qualified", "Engine Company Qualified", "Tender Qualified", "Tanker Shuttle Qualified", "Rescue Boat Qualified", "Duty Officer Qualified", "Accountability Officer", "Rehab Officer", "RIT Qualified", "Live Fire Instructor Approved", "Fit Tested", "SCBA Qualified", "Chainsaw Qualified", "Station Safety Officer", "New Member Mentor", "Probationary Member Complete"],
};
const DEPT_QUAL_GROUP = "Department Qualifications (Non-Certification)";
const isDeptQual = (c) => (CERT_TRACKS[DEPT_QUAL_GROUP] || []).includes(c);   // skill sign-off / demonstration, not a written-exam cert
function StudySession({ S }) {
  const [cert, setCert] = useState(Object.values(CERT_TRACKS)[0][0]);   // first cert of the first group
  const [mode, setMode] = useState("quiz");        // 'quiz' | 'explain'
  const [turns, setTurns] = useState([]);           // [{ role: 'user'|'assistant', content, hidden? }]
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [quizLen, setQuizLen] = useState(5);        // structured-quiz length (5/10/20)
  const [quizN, setQuizN] = useState(0);            // active structured quiz target (0 = none)
  const [results, setResults] = useState([]);        // [{ q, verdict: 'CORRECT'|'INCORRECT'|'PARTIAL'|'UNSCORED' }]
  const [pendingQ, setPendingQ] = useState(null);    // the question currently awaiting an answer
  const [quizDone, setQuizDone] = useState(false);
  const reset = () => { setTurns([]); setInput(""); setErr(""); setQuizN(0); setResults([]); setPendingQ(null); setQuizDone(false); };
  const sysFor = (c, m) => {
    const qual = isDeptQual(c);
    const base = qual
      ? `You are a training coach for a volunteer firefighter working toward the "${c}" DEPARTMENT QUALIFICATION — a hands-on skill sign-off / demonstration, not a written-exam certification.`
      : `You are a cert-aware study tutor for a volunteer firefighter preparing for their ${c} certification. Stay within the scope of ${c}.`;
    const quiz = qual
      ? `SKILL-CHECK MODE: Walk the member through what this qualification requires them to DEMONSTRATE — the practical steps, equipment, and sign-off criteria — one focus area at a time. Ask them to describe how they'd perform it and give feedback. This is a skill check, not a written test.`
      : `QUIZ MODE (one question at a time): If my message asks you to pose a question (for example "ask me question 3 of 10"), ASK exactly that — one exam-style ${c} question, no marker, no evaluation, and do not reveal the answer. Otherwise treat my message as my ANSWER to the question you just asked: your reply MUST begin with a single marker as its very first characters — exactly [CORRECT], [INCORRECT], or [PARTIAL] — then a brief, encouraging explanation of WHY (the correct answer + the reasoning). Do NOT ask a new question inside an evaluation.`;
    const explain = qual
      ? `EXPLAIN MODE: The member asks how to perform or prepare for this qualification's demonstration. Teach the practical skill clearly and answer follow-up questions in context.`
      : `EXPLAIN MODE: The member asks concept questions. Teach clearly and practically at the right level for ${c}, and answer follow-up questions in context.`;
    const caveat = qual
      ? `IMPORTANT — this is coaching, not the authority. Ground guidance in general firefighting practice; do NOT invent a specific department requirement or sign-off criterion — if unsure, say so. Always tell the member to confirm the exact demonstration criteria with their department's SOPs and training officer.`
      : `IMPORTANT — this is study help, not the authority. Ground answers in general firefighting/EMS knowledge; do NOT invent a specific protocol, number, or standard you are unsure of — if unsure, say so. Always remind the member to confirm specifics against their department's SOPs and the current TCFP / NREMT standards for ${c}.`;
    return `${base} ${m === "quiz" ? quiz : explain} Keep replies focused and reasonably short. ${caveat}`;
  };
  async function send(text, hidden) {
    const userTurn = { role: "user", content: text, ...(hidden ? { hidden: true } : {}) };
    const next = [...turns, userTurn];
    setTurns(next); setInput(""); setLoading(true); setErr("");
    try {
      const reply = await callClaudeChat(sysFor(cert, mode), next.map(({ role: r, content }) => ({ role: r, content })));   // strip `hidden` before sending
      setTurns((t) => [...t, { role: "assistant", content: reply }]);
    } catch {
      setErr("Couldn't reach the tutor just now — try again.");
      setTurns(turns);                       // roll back the optimistic user turn so the thread stays alternating
      if (!hidden) setInput(text);           // give them their answer back
    } finally { setLoading(false); }
  }
  const startQuiz = () => send(
    isDeptQual(cert)
      ? `Walk me through the first skill I need to demonstrate for the "${cert}" qualification. One focus area — don't give it all at once.`
      : `Ask me the first exam-style question for the ${cert} certification. One question only — don't reveal the answer yet.`,
    true
  );
  const submit = () => { const t = input.trim(); if (!t || loading) return; send(t, false); };
  // --- Structured quiz (regular certs in Quiz mode only; Explain + dept-qual Skill-check use send()/startQuiz above, unchanged) ---
  const structuredQuiz = mode === "quiz" && !isDeptQual(cert);
  const VERDICT_RE = /^\s*\[(CORRECT|INCORRECT|PARTIAL)\]/i;
  const score = results.filter((r) => r.verdict === "CORRECT").length;
  const missed = results.filter((r) => r.verdict === "INCORRECT" || r.verdict === "PARTIAL");
  const unscored = results.filter((r) => r.verdict === "UNSCORED");
  async function askFresh(base, isFirst) {   // build from an explicit base (avoids stale-turns races on start)
    setTurns(base); setLoading(true); setErr("");
    try {
      const q = await callClaudeChat(sysFor(cert, mode), base.map(({ role, content }) => ({ role, content })));
      setTurns([...base, { role: "assistant", content: q }]);
      setPendingQ(q);
    } catch { setErr("Couldn't load the question — try again."); if (isFirst) { setTurns([]); setQuizN(0); } else setTurns(base.slice(0, -1)); }
    finally { setLoading(false); }
  }
  function startStructuredQuiz(len) {
    setInput(""); setResults([]); setQuizDone(false); setPendingQ(null); setQuizN(len);
    askFresh([{ role: "user", content: `Start the quiz. Ask me question 1 of ${len} for the ${cert} certification — one exam-style question only. No marker, no evaluation, and do not reveal the answer.`, hidden: true }], true);
  }
  function nextQuestion() {
    const n = results.length + 1;
    askFresh([...turns, { role: "user", content: `Ask me question ${n} of ${quizN} for the ${cert} certification — one exam-style question only. No marker, no evaluation, and do not reveal the answer.`, hidden: true }], false);
  }
  async function submitAnswer() {
    const answer = input.trim();
    if (!answer || loading || !pendingQ) return;
    const q = pendingQ, prev = turns, nextTurns = [...turns, { role: "user", content: answer }];
    setTurns(nextTurns); setInput(""); setPendingQ(null); setLoading(true); setErr("");
    try {
      const raw = await callClaudeChat(sysFor(cert, mode), nextTurns.map(({ role, content }) => ({ role, content })));
      const mk = raw.match(VERDICT_RE);
      const verdict = mk ? mk[1].toUpperCase() : "UNSCORED";      // missing/garbled marker → unscored (never crash)
      const display = raw.replace(VERDICT_RE, "").trim();          // strip the marker from what the member sees
      const done = results.length + 1 >= quizN;
      setTurns((t) => [...t, { role: "assistant", content: raw, display }]);
      setResults((r) => [...r, { q, verdict }]);
      if (done) setQuizDone(true);
    } catch {
      setErr("Couldn't reach the tutor just now — try again.");
      setTurns(prev); setInput(answer); setPendingQ(q);            // roll back → thread stays alternating, answer restored
    } finally { setLoading(false); }
  }
  const visible = turns.filter((t) => !t.hidden);
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>STUDY SESSION</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Study for your certification</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Pick a track, then quiz yourself or ask a question. An AI study partner — always verify against official standards.</div>
      </div>
      <div style={{ ...FS.card, padding: 16, marginBottom: 12, display: "flex", gap: 16, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Certification</span>
          <select style={{ ...FS.input, maxWidth: 320 }} value={cert} onChange={(e) => { setCert(e.target.value); reset(); }}>
            {Object.entries(CERT_TRACKS).map(([cat, certs]) => (
              <optgroup key={cat} label={cat}>
                {certs.map((c) => <option key={c} value={c}>{c}</option>)}
              </optgroup>
            ))}
          </select></label>
        <div style={S.segRow}>
          {[["quiz", isDeptQual(cert) ? "Skill check" : "Quiz me"], ["explain", "Explain"]].map(([k, l]) => (
            <button key={k} onClick={() => { setMode(k); reset(); }} style={{ ...S.segBtn, background: mode === k ? FIRE.btnBg : "transparent", borderColor: mode === k ? FIRE.red : FIRE.btnBorder, color: mode === k ? FIRE.textPrimary : FIRE.navLabel }}>{l}</button>
          ))}
        </div>
      </div>
      <Disclaimer S={S} compact dark />
      {structuredQuiz && quizN > 0 && !quizDone && (
        <div style={{ ...FS.kicker, marginTop: 12, color: FIRE.textSecondary }}>Question {Math.min(results.length + (pendingQ ? 1 : 0), quizN)} of {quizN} · Score {score}/{results.length}</div>
      )}
      <div style={{ marginTop: 12 }}>
        {visible.map((t, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            {t.role === "user" ? (
              <div style={{ ...FS.card, padding: "10px 14px", fontSize: 13.5, color: FIRE.textPrimary }}><span style={{ color: FIRE.textMuted, fontWeight: 700 }}>You: </span>{t.display ?? t.content}</div>
            ) : (
              <div style={{ ...FS.card, padding: "12px 16px" }}><RichOutput S={S} text={t.display ?? t.content} dark /></div>
            )}
          </div>
        ))}
        {loading && <div style={{ fontSize: 13, color: FIRE.textMuted, display: "flex", alignItems: "center", gap: 6, padding: "4px 2px" }}><Loader2 size={14} className="spin" /> Tutor is thinking…</div>}
        {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText, marginTop: 8 }}>{err}</div>}
      </div>
      <div style={{ marginTop: 12 }}>
        {structuredQuiz ? (
          quizN === 0 ? (
            <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
              <span style={{ fontSize: 13, color: FIRE.textSecondary }}>Quiz length:</span>
              <div style={S.segRow}>
                {[5, 10, 20].map((n) => (
                  <button key={n} onClick={() => setQuizLen(n)} style={{ ...S.segBtn, background: quizLen === n ? FIRE.btnBg : "transparent", borderColor: quizLen === n ? FIRE.red : FIRE.btnBorder, color: quizLen === n ? FIRE.textPrimary : FIRE.navLabel }}>{n}</button>
                ))}
              </div>
              <button style={{ ...FS.btnPrimary, opacity: loading ? 0.7 : 1 }} onClick={() => startStructuredQuiz(quizLen)} disabled={loading}>{loading ? <><Loader2 size={16} className="spin" /> Starting…</> : <><BookOpen size={16} /> Start quiz</>}</button>
            </div>
          ) : quizDone ? (
            <div style={{ ...FS.card, padding: "16px 18px" }}>
              <div style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 22, fontWeight: 700, color: FIRE.textPrimary }}>You got {score} of {quizN}</div>
              {unscored.length > 0 && <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 2 }}>{unscored.length} question{unscored.length === 1 ? "" : "s"} couldn't be auto-scored.</div>}
              {missed.length > 0 ? (<>
                <div style={{ ...FS.kicker, marginTop: 12, marginBottom: 6 }}>Review these</div>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {missed.map((m, i) => <li key={i} style={{ fontSize: 13, color: FIRE.textSecondary, marginBottom: 4, lineHeight: 1.4 }}>{m.q}</li>)}
                </ul>
              </>) : <div style={{ fontSize: 13, color: FIRE.greenText, marginTop: 8 }}>Perfect run — nothing to review. 🎉</div>}
              <button style={{ ...FS.btnPrimary, marginTop: 14 }} onClick={reset}><BookOpen size={16} /> Start another quiz</button>
            </div>
          ) : pendingQ ? (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <input style={{ ...FS.input, flex: 1, minWidth: 200 }} value={input} placeholder="Type your answer…" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitAnswer()} disabled={loading} />
              <button style={{ ...FS.btnPrimary, opacity: loading || !input.trim() ? 0.6 : 1 }} onClick={submitAnswer} disabled={loading || !input.trim()}>Submit answer</button>
            </div>
          ) : (
            <button style={{ ...FS.btnPrimary, opacity: loading ? 0.7 : 1 }} onClick={nextQuestion} disabled={loading}>{loading ? <><Loader2 size={16} className="spin" /> Loading…</> : "Next question →"}</button>
          )
        ) : (
          <>
            {mode === "quiz" && visible.length === 0 ? (
              <button style={{ ...FS.btnPrimary, opacity: loading ? 0.7 : 1 }} onClick={startQuiz} disabled={loading}>{loading ? <><Loader2 size={16} className="spin" /> Starting…</> : <><BookOpen size={16} /> Start quiz</>}</button>
            ) : (
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <input style={{ ...FS.input, flex: 1, minWidth: 200 }} value={input} placeholder={mode === "quiz" ? (isDeptQual(cert) ? "Describe how you'd do it…" : "Type your answer…") : `Ask a ${cert} question…`} onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} disabled={loading} />
                <button style={{ ...FS.btnPrimary, opacity: loading || !input.trim() ? 0.6 : 1 }} onClick={submit} disabled={loading || !input.trim()}>{mode === "quiz" ? "Submit answer" : "Ask"}</button>
              </div>
            )}
            {visible.length > 0 && <button style={{ ...FS.btn, marginTop: 10 }} onClick={reset}>Start over</button>}
          </>
        )}
      </div>
    </div>
  );
}

/* ---------------- Station Q&A (member-facing, general fire/EMS chat assistant) ---------------- */
const QANDA_SYS = "You are a knowledgeable, practical, safety-conscious fire/EMS assistant for a VOLUNTEER fire department. Answer operational, procedural, training, and standards questions at the level a volunteer firefighter or EMS responder needs. Keep replies focused and clear, and answer follow-up questions in context.\n\nCRITICAL — you do NOT have access to THIS department's specific SOPs, protocols, medical direction, or local standards; you are giving GENERAL fire-service guidance only, and you should say so when it matters. Do NOT invent specific protocols, numbers, thresholds, or standards — if you are unsure, say so plainly rather than guessing. Always tell the member to follow their DEPARTMENT'S actual SOPs and to confirm specifics against the current official standards that apply to them (NFPA / TCFP / NREMT / their AHJ and medical direction). The harm this prevents is real: a volunteer could act on a made-up procedure on a live call.";
// Grounded system prompt: injects the dept's SOP text. Keeps the SAME safety framing + truth guardrail as QANDA_SYS,
// and ADDS: cite the document, fall back + say so when SOPs are silent, never invent protocols not in the SOPs.
const groundedQandaSys = (context) => "You are a knowledgeable, practical, safety-conscious fire/EMS assistant for a VOLUNTEER fire department. Answer operational, procedural, training, and standards questions at the level a volunteer firefighter or EMS responder needs. Keep replies focused and clear, and answer follow-up questions in context.\n\nHere are THIS department's actual SOPs/documents:\n\n" + context + "\n\nAnswer from these when they're relevant, and CITE the document (\"According to your {document name}…\"). When the SOPs are SILENT on a question, fall back to general fire-service guidance and SAY SO clearly. NEVER invent a department-specific protocol, number, or threshold that is not in the SOPs above — the harm is real: a volunteer could act on a made-up procedure on a live call. Always remind them to follow their DEPARTMENT'S actual SOPs and to verify specifics against the current official standards that apply to them (NFPA / TCFP / NREMT / their AHJ and medical direction).";
function StationQA({ S }) {
  const [turns, setTurns] = useState([]);           // [{ role: 'user'|'assistant', content }]
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [ground, setGround] = useState({ text: "", has: false, note: "" });   // grounding context, hasGrounding, size-limit note
  useEffect(() => {
    let alive = true;
    (async () => {
      const { data: deptId } = await supabase.rpc("my_department_id");
      if (!deptId || !alive) return;
      const { data, error } = await supabase.from("documents")
        .select("name, content_text")
        .eq("department_id", deptId)
        .is("deleted_at", null)                 // current versions only —
        .is("archived_at", null)                // composes with the Failsafe
        .not("content_text", "is", null);
      if (!alive || error || !data || data.length === 0) return;
      const CAP = 80000;                          // ~80k-char context budget (safety valve; real RAG would retrieve instead)
      let text = ""; let included = 0;
      for (const d of data) {
        const block = `=== ${d.name} ===\n${d.content_text}`;
        if (text.length + block.length + 2 > CAP) break;   // stop once the next doc would exceed the budget
        text += (text ? "\n\n" : "") + block;
        included++;
      }
      setGround({ text, has: included > 0, note: included < data.length ? `${included} of ${data.length} documents included (size limit)` : "" });
    })();
    return () => { alive = false; };
  }, []);
  const reset = () => { setTurns([]); setInput(""); setErr(""); };
  async function send(text) {
    const next = [...turns, { role: "user", content: text }];
    setTurns(next); setInput(""); setLoading(true); setErr("");
    try {
      const sys = ground.has ? groundedQandaSys(ground.text) : QANDA_SYS;   // grounded if SOPs loaded; else clean ungrounded fallback
      const reply = await callClaudeChat(sys, next);
      setTurns((t) => [...t, { role: "assistant", content: reply }]);
    } catch {
      setErr("Couldn't reach the assistant just now — try again.");
      setTurns(turns);                       // roll back the optimistic user turn so the thread stays alternating
      setInput(text);                        // give their question back
    } finally { setLoading(false); }
  }
  const submit = () => { const t = input.trim(); if (!t || loading) return; send(t); };
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>STATION Q&amp;A</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Ask the station assistant</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>{ground.has ? "Grounded in your uploaded SOPs — always verify locally." : "General fire & EMS questions — tactics, terminology, procedures, training. It doesn't know your department's specific SOPs, so always verify locally."}</div>
        {ground.has && <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 4 }}>This assistant reads your department's uploaded SOP text to answer.{ground.note ? ` (${ground.note})` : ""}</div>}
      </div>
      <Disclaimer S={S} compact dark />
      <div style={{ marginTop: 12 }}>
        {turns.map((t, i) => (
          <div key={i} style={{ marginBottom: 10 }}>
            {t.role === "user" ? (
              <div style={{ ...FS.card, padding: "10px 14px", fontSize: 13.5, color: FIRE.textPrimary }}><span style={{ color: FIRE.textMuted, fontWeight: 700 }}>You: </span>{t.content}</div>
            ) : (
              <div style={{ ...FS.card, padding: "12px 16px" }}><RichOutput S={S} text={t.content} dark /></div>
            )}
          </div>
        ))}
        {turns.length === 0 && !loading && <div style={{ fontSize: 13, color: FIRE.textMuted, fontStyle: "italic" }}>Ask anything — e.g. &ldquo;What's the difference between an offensive and defensive attack?&rdquo;, &ldquo;How does a RIT work?&rdquo;, &ldquo;What goes into a primary search?&rdquo;</div>}
        {loading && <div style={{ fontSize: 13, color: FIRE.textMuted, display: "flex", alignItems: "center", gap: 6, padding: "4px 2px" }}><Loader2 size={14} className="spin" /> Thinking…</div>}
        {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText, marginTop: 8 }}>{err}</div>}
      </div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
        <input style={{ ...FS.input, flex: 1, minWidth: 200 }} value={input} placeholder="Ask a question…" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} disabled={loading} />
        <button style={{ ...FS.btnPrimary, opacity: loading || !input.trim() ? 0.6 : 1 }} onClick={submit} disabled={loading || !input.trim()}>Ask</button>
      </div>
      {turns.length > 0 && <button style={{ ...FS.btn, marginTop: 10 }} onClick={reset}>Clear</button>}
    </div>
  );
}

/* ---------------- Plan feedback loop ---------------- */
const CRITIQUE_TAGS = ["Too advanced", "Too basic", "Unsafe for our crew", "Wrong equipment", "Didn't fit the time", "Not realistic"];
function PlanFeedback({ S, plan, topic, addFeedback }) {
  const [rating, setRating] = useState(null);
  const [tags, setTags] = useState([]);
  const [notes, setNotes] = useState("");
  const [editing, setEditing] = useState(false);
  const [editedSummary, setEditedSummary] = useState(plan.summary || "");
  const [sent, setSent] = useState(false);
  const toggleTag = (t) => setTags((p) => (p.includes(t) ? p.filter((x) => x !== t) : [...p, t]));
  const changed = editing && editedSummary.trim() !== (plan.summary || "").trim();
  function send() {
    addFeedback({ topic, rating, tags, edited: changed, notes: notes.trim() });
    setSent(true);
  }
  if (sent) return (
    <div style={{ ...S.fbDone, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, borderLeft: `3px solid ${FIRE.green}`, color: FIRE.textSecondary }}>
      <CheckCircle2 size={18} color={FIRE.green} style={{ flexShrink: 0, marginTop: 1 }} />
      <div><strong>Logged — thank you.</strong> Critiques like this are exactly what sharpen the next plan. Your team reviews them and tunes the system from them.</div>
    </div>
  );
  return (
    <div style={{ ...S.fbCard, ...FS.card }}>
      <div style={{ ...S.fbHead, color: FIRE.textPrimary }}><MessageSquare size={15} color={FIRE.btnIcon} /> Help it get better</div>
      <div style={S.fbRow}>
        <span style={{ ...S.fbLabel, color: FIRE.textSecondary }}>Was this useful?</span>
        <button style={{ ...S.fbThumb, background: FIRE.btnBg, border: `0.5px solid ${FIRE.btnBorder}`, color: FIRE.btnText, ...(rating === "up" ? { border: `0.5px solid ${FIRE.green}`, color: FIRE.greenText } : {}) }} onClick={() => setRating("up")}><ThumbsUp size={15} /> Yes</button>
        <button style={{ ...S.fbThumb, background: FIRE.btnBg, border: `0.5px solid ${FIRE.btnBorder}`, color: FIRE.btnText, ...(rating === "down" ? { border: `0.5px solid ${FIRE.redBright}`, color: FIRE.redText } : {}) }} onClick={() => setRating("down")}><ThumbsDown size={15} /> Not quite</button>
      </div>
      <div style={{ ...S.fbLabel2, color: FIRE.textMuted }}>What was off? (tap any)</div>
      <div style={S.chipRow}>
        {CRITIQUE_TAGS.map((t) => (
          <button key={t} onClick={() => toggleTag(t)} style={{ ...S.fbTag, background: FIRE.btnBg, border: `0.5px solid ${FIRE.btnBorder}`, color: FIRE.navLabel, ...(tags.includes(t) ? { border: `0.5px solid ${FIRE.red}`, color: FIRE.textPrimary } : {}) }}>{t}</button>
        ))}
      </div>
      {!editing ? (
        <button style={{ ...S.fbEditBtn, ...FS.btn, marginTop: 13 }} onClick={() => setEditing(true)}><Pencil size={14} /> Edit the plan & save your version</button>
      ) : (
        <div style={{ marginTop: 12 }}>
          <div style={{ ...S.fbLabel2, color: FIRE.textMuted }}>Your corrected summary</div>
          <textarea style={{ ...FS.input, minHeight: 72, resize: "vertical" }} value={editedSummary} onChange={(e) => setEditedSummary(e.target.value)} />
        </div>
      )}
      <div style={{ ...S.fbLabel2, color: FIRE.textMuted, marginTop: 12 }}>Anything else you'd change?</div>
      <textarea style={{ ...FS.input, minHeight: 48, resize: "vertical" }} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="e.g. swap the prop, add an accountability check…" />
      <button style={{ ...FS.btnPrimary, marginTop: 12, opacity: (rating || tags.length || notes.trim() || changed) ? 1 : 0.55 }}
        onClick={send} disabled={!(rating || tags.length || notes.trim() || changed)}>Send feedback</button>
    </div>
  );
}

/* ---------------- AI Training Assistant ---------------- */
// structured drill plan → RichOutput-friendly text (## headings, - bullets, 1. ordered) — full plan, nothing dropped
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
function AIDrillPlanner({ S, addFeedback, sessions, loadSessions, notify, dept, me, role, categories }) {
  const [form, setForm] = useState({ size: "12", apparatus: "1 engine, 1 brush truck", topic: "Search and rescue", level: "Intermediate", time: "90", history: "Have not trained on search & rescue in 6 months." });
  const [loading, setLoading] = useState(false); const [err, setErr] = useState(""); const [plan, setPlan] = useState(null); const [genId, setGenId] = useState(0);
  const [saveSession, setSaveSession] = useState(""); const [saving, setSaving] = useState(false);
  const canManage = hasAny(role, CANMANAGE_OPS_ROLES);   // training_sessions write — ops only (DA/Officer, excludes Board + PA)
  const [newDate, setNewDate] = useState(""); const [newTitle, setNewTitle] = useState(""); const [newCat, setNewCat] = useState("");
  const [newAudience, setNewAudience] = useState("everyone");   // audience for AI schedule-on-a-date
  const up = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function generate() {
    setLoading(true); setErr(""); setPlan(null);
    const sys = "You are an experienced volunteer fire/EMS training officer drafting a SAFE, practical drill plan. You are NOT a substitute for certified instruction, medical direction, or the AHJ. Defer to local protocols, state requirements, and medical direction. For any high-risk evolution (live fire, hazmat, technical rescue, invasive medical skills), note in safetyNotes that it requires a qualified instructor and assigned safety officer plus authorization. Respond with ONLY one valid JSON object, no markdown, no code fences. Schema: {\"summary\":string,\"durationMin\":number,\"equipment\":string[],\"safetyNotes\":string[],\"steps\":[{\"title\":string,\"detail\":string,\"minutes\":number}],\"talkingPoints\":string[],\"debriefQuestions\":string[],\"evaluationChecklist\":string[]}. Keep arrays to 3-6 concise items. Realistic for the stated staffing and apparatus.";
    const user = `${dept?.name ? `Department: ${dept.name}\n` : ""}Department size: ${form.size} members\nApparatus/equipment: ${form.apparatus}\nTopic: ${form.topic}\nSkill level: ${form.level}\nTime: ${form.time} minutes\nRecent history: ${form.history}`;
    try {
      let t = (await callClaude(sys, user)).replace(/```json|```/g, "").trim();
      let parsed; try { parsed = JSON.parse(t); } catch { const m = t.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
      if (!parsed) throw new Error("parse"); setPlan(parsed); setGenId((g) => g + 1);
    } catch { setErr("Couldn't generate a plan just now. Check the connection and try again."); } finally { setLoading(false); }
  }
  async function saveToSession() {
    const target = (sessions || []).find((s) => String(s.id) === String(saveSession));
    if (!target) { notify({ kind: "error", title: "Pick a session", text: "Choose which session to attach this plan to." }); return; }
    if (!plan) return;
    setSaving(true);
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { setSaving(false); notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
    const { error } = await supabase.from("session_plans").insert({ department_id: deptId, session_id: target.id, title: `${form.topic} — AI drill plan`, source: "ai", ai_text: serializeDrillPlan(plan, form.topic), created_by: me?.name || "Unknown" });
    setSaving(false);
    if (error) { notify({ kind: "error", title: "Couldn't save the plan", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    notify({ kind: "success", title: "Plan saved", text: `Drill plan attached to ${target.title}.` });
    setSaveSession(""); loadSessions && loadSessions();
  }
  async function scheduleOnDate() {
    if (!newDate) { notify({ kind: "error", title: "Pick a date", text: "Choose a date to schedule this training." }); return; }
    if (!plan) return;
    setSaving(true);
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { setSaving(false); notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
    const title = newTitle.trim() || `${form.topic} — AI drill plan`;
    // a) create the session on the picked date (reuses addSession's insert shape; the type=date value is already YYYY-MM-DD)
    const { data: sess, error: e1 } = await supabase.from("training_sessions").insert({ department_id: deptId, plan_id: newCat || null, title, date: newDate, done: false, audience: newAudience }).select().single();
    if (e1 || !sess) { setSaving(false); notify({ kind: "error", title: "Couldn't schedule the session", text: "Something went wrong creating that session. Please try again.", details: e1?.message }); return; }
    // b) attach the plan to the new session (reuses saveToSession's attach). Non-atomic — recoverable if this fails.
    const { error: e2 } = await supabase.from("session_plans").insert({ department_id: deptId, session_id: sess.id, title, source: "ai", ai_text: serializeDrillPlan(plan, form.topic), created_by: me?.name || "Unknown" });
    setSaving(false);
    if (e2) { notify({ kind: "error", title: "Session created — plan didn't attach", text: "The session was scheduled, but attaching the plan failed. You can attach it from the planner's session picker.", details: e2.message }); loadSessions && loadSessions(); return; }
    notify({ kind: "success", title: "Scheduled", text: `Training scheduled on ${newDate} with its plan.` });
    setNewDate(""); setNewTitle(""); setNewCat(""); setNewAudience("everyone");
    loadSessions && loadSessions();
  }
  return (
    <div style={{ ...FS.card, padding: 16, marginBottom: 16 }}>
      <div style={{ ...FS.kicker, display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}><Sparkles size={13} color={FIRE.btnIcon} /> AI DRILL PLANNER</div>
      <div style={{ fontSize: 13, color: FIRE.textSecondary, lineHeight: 1.5, marginBottom: 12 }}>Describe your crew and constraints — you'll get a structured drill plan to adapt, then save it to a session.</div>
      <div style={S.aiGrid}>
        <div style={{ ...S.aiForm, ...FS.card }}>
          <AIField S={S} dark label="Department size (members)" value={form.size} onChange={(v) => up("size", v)} />
          <AIField S={S} dark label="Available apparatus / equipment" value={form.apparatus} onChange={(v) => up("apparatus", v)} />
          <AIField S={S} dark label="Training topic" value={form.topic} onChange={(v) => up("topic", v)} />
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Skill level</span>
            <select style={FS.input} value={form.level} onChange={(e) => up("level", e.target.value)}><option>New / probationary</option><option>Intermediate</option><option>Experienced</option><option>Mixed</option></select></label>
          <AIField S={S} dark label="Time available (minutes)" value={form.time} onChange={(v) => up("time", v)} />
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Recent training history</span>
            <textarea style={{ ...FS.input, minHeight: 66, resize: "vertical" }} value={form.history} onChange={(e) => up("history", e.target.value)} /></label>
          <button style={{ ...FS.btnPrimary, width: "100%", justifyContent: "center", opacity: loading ? 0.7 : 1 }} onClick={generate} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><Sparkles size={16} /> Generate drill plan</>}
          </button>
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
        </div>
        <div style={{ ...S.aiResult, ...FS.card }}>
          {!plan && !loading && <div style={{ ...S.aiPlaceholder, color: FIRE.textMuted }}><Sparkles size={28} color={FIRE.textMuted2} /><p>Your drafted plan appears here. It's a starting point — a real training officer should review and adapt it before use.</p></div>}
          {loading && <div style={{ ...S.aiPlaceholder, color: FIRE.textMuted }}><Loader2 size={28} className="spin" color={FIRE.textMuted2} /><p>Drafting a plan for {form.size} members, {form.time} minutes…</p></div>}
          {plan && (
            <div>
              <Disclaimer S={S} compact dark />
              <h3 style={{ ...S.featTitle, color: FIRE.textPrimary }}>{form.topic}</h3>
              <p style={{ ...S.body, color: FIRE.textSecondary }}>{plan.summary}</p>
              {plan.durationMin ? <div style={S.metaRow}><Meta Icon={Clock} dark text={`${plan.durationMin} min`} /></div> : null}
              <AIList S={S} dark Icon={ShieldAlert} title="Safety notes" items={plan.safetyNotes} warn />
              <AIList S={S} dark Icon={Wrench} title="Equipment" items={plan.equipment} />
              {Array.isArray(plan.steps) && (
                <div style={{ marginTop: 16 }}><div style={{ ...S.aiListHead, color: FIRE.textPrimary }}><FileText size={16} /> Drill steps</div>
                  <div style={S.steps}>{plan.steps.map((s, i) => (
                    <div key={i} style={S.step}><span style={{ ...S.stepNum, color: FIRE.red, background: FIRE.btnBg, border: `0.5px solid ${FIRE.btnBorder}` }}>{String(i + 1).padStart(2, "0")}</span>
                      <div style={{ flex: 1 }}><div style={{ ...S.stepTitle, color: FIRE.textPrimary }}>{s.title} {s.minutes ? <span style={{ ...S.stepMin, color: FIRE.textMuted }}>{s.minutes} min</span> : null}</div><div style={{ ...S.stepDetail, color: FIRE.textSecondary }}>{s.detail}</div></div></div>
                  ))}</div></div>
              )}
              <AIList S={S} dark Icon={Megaphone} title="Instructor talking points" items={plan.talkingPoints} />
              <AIList S={S} dark Icon={ClipboardList} title="Debrief questions" items={plan.debriefQuestions} />
              <AIList S={S} dark Icon={CheckCircle2} title="Evaluation checklist" items={plan.evaluationChecklist} />
              <PlanFeedback key={genId} S={S} plan={plan} topic={form.topic} addFeedback={addFeedback} />
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 14, paddingTop: 14, borderTop: `0.5px solid ${FIRE.hairline}` }}>
                <label style={{ ...S.field, minWidth: 220, flex: 1 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Save to session</span>
                  <select style={FS.input} value={saveSession} onChange={(e) => setSaveSession(e.target.value)}>
                    <option value="">Choose a session…</option>
                    {(sessions || []).filter((s) => !s.done).sort((a, b) => sessDate(a) - sessDate(b)).map((s) => <option key={s.id} value={s.id}>{s.title} · {fmtSess(s)}</option>)}
                  </select></label>
                <button style={{ ...FS.btnPrimary, opacity: saving ? 0.7 : 1 }} onClick={saveToSession} disabled={!saveSession || saving}>{saving ? <><Loader2 size={16} className="spin" /> Saving…</> : <><FileText size={16} /> Save plan to session</>}</button>
              </div>
              {canManage && (
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end", marginTop: 10 }}>
                  <div style={{ width: "100%", fontSize: 11, color: FIRE.textMuted2, textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700 }}>— or schedule on a new date —</div>
                  <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Date</span><input type="date" style={FS.input} value={newDate} onChange={(e) => setNewDate(e.target.value)} /></label>
                  <label style={{ ...S.field, minWidth: 150, flex: 1 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Title</span><input style={FS.input} value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={form.topic} /></label>
                  <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Category</span><select style={FS.input} value={newCat} onChange={(e) => setNewCat(e.target.value)}><option value="">One-off (no category)</option>{(categories || []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
                  <label style={{ ...S.field, minWidth: 200 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Audience</span>
                    <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1px solid ${FIRE.btnBorder}` }}>
                      {[["everyone", "Everyone"], ["leadership", "Leadership only"]].map(([val, lbl], i) => {
                        const on = newAudience === val;
                        return <button key={val} type="button" onClick={() => setNewAudience(val)} style={{ flex: 1, padding: "8px 10px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", border: "none", borderLeft: i ? `1px solid ${FIRE.btnBorder}` : "none", background: on ? "rgba(255,255,255,.10)" : "transparent", color: on ? (val === "leadership" ? FIRE.amberText : "#F0F2F5") : "#9AA1AC" }}>{lbl}</button>;
                      })}
                    </div></label>
                  <button style={{ ...FS.btnPrimary, opacity: saving ? 0.7 : 1 }} onClick={scheduleOnDate} disabled={!newDate || saving}>{saving ? <><Loader2 size={16} className="spin" /> Scheduling…</> : <><Plus size={16} /> Schedule on date</>}</button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
function AIField({ S, label, value, onChange, dark }) {
  return <label style={S.field}><span style={dark ? { ...S.fieldLabel, color: FIRE.textSecondary } : S.fieldLabel}>{label}</span><input style={dark ? FS.input : S.input} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function AIList({ S, Icon, title, items, warn, dark }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ ...S.aiListHead, color: warn ? (dark ? FIRE.redText : "#8A1620") : (dark ? FIRE.textPrimary : "#191C20") }}><Icon size={16} /> {title}</div>
      <ul style={dark ? { ...S.list, color: FIRE.textSecondary } : S.list}>{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
    </div>
  );
}

/* ---------------- shared: resource library + idea grid ---------------- */
function ResourceLibrary({ S, items, verb, onOpen, onDelete, dark }) {
  return (
    <div style={S.resGrid}>
      {items.map((r) => (
        <div key={r.id ?? r.name} style={dark ? { ...S.resCard, ...FS.card } : S.resCard}>
          <FileText size={16} color={dark ? FIRE.btnIcon : "#54506B"} style={{ flexShrink: 0, marginTop: 1 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={dark ? { ...S.resName, color: FIRE.textPrimary } : S.resName}>{r.name}</div>
            <div style={dark ? { ...S.resType, color: FIRE.textMuted } : S.resType}>{r.type}</div>
          </div>
          {onOpen ? (
            <button onClick={() => onOpen(r)} style={{ ...S.resDl, ...(dark ? { color: FIRE.btnText } : {}), border: "none", background: "transparent", padding: 0, cursor: "pointer", fontFamily: "inherit" }}><Download size={13} /> {verb || "Download"}</button>
          ) : (
            <span style={dark ? { ...S.resDl, color: FIRE.btnText } : S.resDl}><Download size={13} /> {verb || "Download"}</span>
          )}
          {onDelete && (
            <button onClick={() => onDelete(r)} title="Delete" style={{ border: "none", background: "transparent", padding: 0, cursor: "pointer", color: dark ? FIRE.deleteRed : "#B11E2A", display: "inline-flex", alignItems: "center", flexShrink: 0, alignSelf: "center", marginLeft: 8 }}><X size={14} /></button>
          )}
        </div>
      ))}
    </div>
  );
}
function IdeaGrid({ S, items, dark }) {
  return (
    <div style={S.ideaGrid}>
      {items.map((i) => (
        <div key={i.h} style={dark ? { ...S.ideaCard, ...FS.card } : S.ideaCard}><div style={dark ? { ...S.ideaH, color: FIRE.textPrimary } : S.ideaH}>{i.h}</div><div style={dark ? { ...S.ideaP, color: FIRE.textSecondary } : S.ideaP}>{i.p}</div></div>
      ))}
    </div>
  );
}

/* ---------------- rich output formatter (markdown-lite → cards) ---------------- */
function RichText({ text }) {
  const parts = String(text).split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    /^\*\*[^*]+\*\*$/.test(p) ? <strong key={i}>{p.slice(2, -2)}</strong> : <React.Fragment key={i}>{p}</React.Fragment>
  );
}
function parseSections(text) {
  const lines = String(text).replace(/\r/g, "").split("\n");
  const sections = []; let cur = { title: null, blocks: [] }; let list = null;
  const flushList = () => { if (list) { cur.blocks.push(list); list = null; } };
  const pushCur = () => { flushList(); if (cur.title || cur.blocks.length) sections.push(cur); cur = { title: null, blocks: [] }; };
  const header = (t) => {
    if (/^#{1,6}\s+/.test(t)) return t.replace(/^#{1,6}\s+/, "").replace(/\*\*/g, "").trim();
    const m = t.match(/^\*\*(.+?)\*\*:?$/); return m ? m[1].trim() : null;
  };
  for (const raw of lines) {
    const t = raw.trim();
    if (t === "") { flushList(); continue; }
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) { flushList(); continue; }
    const h = header(t); if (h) { pushCur(); cur.title = h; continue; }
    const b = t.match(/^[-*•]\s+(.*)$/);
    if (b) { if (!list || list.ordered) { flushList(); list = { ordered: false, items: [] }; } list.items.push(b[1]); continue; }
    const o = t.match(/^\d+[.)]\s+(.*)$/);
    if (o) { if (!list || !list.ordered) { flushList(); list = { ordered: true, items: [] }; } list.items.push(o[1]); continue; }
    flushList(); cur.blocks.push({ para: t });
  }
  pushCur(); return sections;
}
function RichOutput({ S, text, dark }) {
  const sections = parseSections(text);
  // additive: default (dark falsy) uses the exact same S.rich* objects → byte-identical light path. Parse/RichText untouched.
  const wrap  = S.richWrap;   // layout-only (flex/gap/marginTop) — same for both themes
  const card  = dark ? { ...FS.card, padding: "15px 17px" } : S.richCard;
  const title = dark ? { ...S.richTitle, color: FIRE.textPrimary, borderBottom: `1px solid ${FIRE.hairline}` } : S.richTitle;
  const para  = dark ? { ...S.richP, color: FIRE.textSecondary } : S.richP;
  const list  = dark ? { ...S.richList, color: FIRE.textSecondary } : S.richList;
  return (
    <div style={wrap}>
      {sections.map((sec, i) => (
        <div key={i} style={card}>
          {sec.title && <div style={title}>{sec.title}</div>}
          {sec.blocks.map((b, j) => {
            if (b.para != null) return <p key={j} style={para}><RichText text={b.para} /></p>;
            const Tag = b.ordered ? "ol" : "ul";
            return <Tag key={j} style={list}>{b.items.map((it, k) => <li key={k}><RichText text={it} /></li>)}</Tag>;
          })}
        </div>
      ))}
    </div>
  );
}

/* ---------------- Recruitment ---------------- */
// Date math lives in the APP, not the model — models are unreliable at date arithmetic.
// The app computes every day's real date; the model only places dates it's given.
const pad2 = (n) => String(n).padStart(2, "0");
const toISODate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
function nextMondayISO() {
  const d = new Date();
  d.setDate(d.getDate() + (((8 - d.getDay()) % 7) || 7));   // Sun→+1 … Mon→+7 (always a future Monday)
  return toISODate(d);
}
function weekCalendar(startISO, weeks = 9) {
  const start = new Date(startISO + "T00:00:00");   // local parse — no TZ shift
  const fmt = (d) => d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });   // "Mon, Jul 7"
  const lines = [];
  for (let w = 0; w < weeks; w++) {
    const days = [];
    for (let i = 0; i < 7; i++) { const dt = new Date(start); dt.setDate(start.getDate() + w * 7 + i); days.push(fmt(dt)); }
    lines.push(`Week ${w + 1}: ${days.join("; ")}`);
  }
  return lines.join("\n");
}
function Recruitment({ S, brand, role, notify, dept, meId, members }) {
  const [town, setTown] = useState("");
  const [size, setSize] = useState("14");
  const [need, setNeed] = useState("A few younger volunteers and people who can run daytime calls.");
  const [localDates, setLocalDates] = useState("");   // optional — real local events + dates the leader supplies; drives post scheduling
  const [startDate, setStartDate] = useState(() => nextMondayISO());   // Week 1 begins here; app computes all post dates from this
  const [loading, setLoading] = useState(false); const [plan, setPlan] = useState(""); const [err, setErr] = useState("");
  const [plannerOpen, setPlannerOpen] = useState(true);   // AI Recruitment Planner — expanded by default
  const [waysOpen, setWaysOpen] = useState(false);         // Ways to Recruit — collapsed by default
  const canManage = hasAny(role, CANMANAGE_OPS_ROLES);   // ai_outputs write — ops only (DA/Officer, excludes Board + PA; Board can still VIEW Recruitment)
  const [saving, setSaving] = useState(false); const [saveTitle, setSaveTitle] = useState("");
  const [drafts, setDrafts] = useState([]); const [openDraft, setOpenDraft] = useState(null);
  const [editing, setEditing] = useState(false); const [editBuf, setEditBuf] = useState(""); const [savingEdit, setSavingEdit] = useState(false);
  async function draft() {
    setLoading(true); setErr(""); setPlan("");
    const sys = "You are a recruitment advisor for a volunteer fire/EMS department. Produce a structured 60-DAY recruitment plan (about 8-9 weeks) the department can follow week by week to recruit new volunteers. The backbone is a week-by-week social media schedule; weave in-person outreach milestones through it.\n\nFORMAT — organize the plan as WEEK 1 through about WEEK 9 (roughly 60 days). For each week:\n- Keep a steady posting cadence of 2-3 social posts that week.\n- For EVERY scheduled post, write the ACTUAL post copy the department can publish — the real words, not just a topic or a description. Each post gets a clear message, one concrete ask or next step, and a tie to a real need. Vary the angle across the plan (the mission, a day-in-the-life, a specific need, myth-busting 'no experience needed — we train you', a member-spotlight prompt, an open-house invite, a thank-you to the community).\n- Label EVERY post with its real calendar date taken from the WEEK CALENDAR in the input, formatted like 'Mon, Jul 7 — Post 1'. See the DATES rule below.\n- After each post's copy, add one short CONTENT IDEA line, prefixed with an emoji, suggesting the photo or video to pair with THAT post. The idea must fit that specific post's message and visibly connect to what the post actually says — never a generic suggestion stapled on. Match the medium to the message: a 'we train you from scratch' post pairs with a short video of a newer member learning a skill; a 'meet the crew' post with faces or a quick team clip; a 'what a real call looks like' post with real footage; a 'thank you, community' post with a warm photo or group shot. Lean toward SHORT VIDEO whenever the message is about action, people, training, or a day-in-the-life (that covers most recruitment posts); use a photo or simple graphic only when a still genuinely serves that message better. Format like '🎥 Content idea: a 15-second clip of a newer member throwing a ladder for the first time' or '📸 Content idea: the whole crew in front of the engine'. Keep these to general, department-appropriate ideas from your own knowledge. Do NOT reference current online trends, trending audio, viral challenges, or specific platform formats — you do not have live web data and must not invent trends.\n\nDATES — CRITICAL: The input includes a WEEK CALENDAR listing the real calendar date of every day in each of the ~9 weeks. Use ONLY those dates. You MAY choose which days to post on and the cadence, but every date you write must be copied EXACTLY from the WEEK CALENDAR — NEVER compute, count forward, guess, or invent a date yourself. Every post must carry a real date from that calendar.\n\nSCHEDULE AROUND THE LEADER'S DATES — The leader may provide 'Key local dates' (real local events and when they happen). Treat ONLY those as real events. For each date the leader gave, place it in the matching week of the WEEK CALENDAR and schedule a cluster of posts around it: build-up posts in the days before, a day-of push, and a follow-up post after. If the leader provided no dates, say so plainly and lean on placeholders instead.\n\nPLACEHOLDERS FOR ANYTHING NOT GIVEN — Where a real local event would strengthen the plan but the leader did NOT provide one, DO NOT invent it. Insert a clearly-marked placeholder written exactly like this: '[add your local event + date here]', and write the surrounding posts so the leader can drop their own event in. Do the same for any venue or business name you were not given — a placeholder or a category, never a made-up name.\n\nOUTREACH MILESTONES — Weave these into sensible weeks across the 60 days, not all at once: (a) an OPEN HOUSE — pick a target week, with build-up posts and a follow-up push; (b) BUSINESS OUTREACH — asking local businesses to help spread the word, described by TYPE/CATEGORY only (for example: hardware stores, feed and farm-supply stores, family diners, auto shops, grocery or convenience stores, banks or credit unions), plus a one-line script the department can hand a business; (c) a REFERRAL PUSH asking current members to tap their own networks.\n\nALSO INCLUDE — At the very top: a suggested CAMPAIGN HASHTAG (short, memorable, tied to the department or the need), and one short line reminding the leader that real event names and business names are theirs to fill into the placeholders.\n\nCRITICAL — READ CAREFULLY: You do NOT have real, current information about this town's actual events or businesses, and you must not pretend to. Post dates come ONLY from the WEEK CALENDAR (the app computed them for you — place them, never calculate them). Real-world EVENTS, EVENT NAMES, and the dates they fall on must come ONLY from the leader's 'Key local dates' input — NEVER invent an event, an event name, or a specific business name. If it was not given, it stays a marked placeholder. The harm this prevents is real: a department could show up to an event that is not happening, or promote a business that does not exist. Businesses stay TYPES/CATEGORIES only, never invented names.\n\nWarm, honest, never desperate, written in the department's voice. Plain-text headers and bullets (label the weeks WEEK 1, WEEK 2, and so on). Under 1300 words.";
    try {
      const startLabel = new Date(startDate + "T00:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
      const cal = weekCalendar(startDate);
      const t = await callClaude(sys, `Department: ${dept?.name || ""}\nTown: ${town}\nDepartment size: ${size} members\nWhat they need: ${need}\nKey local dates: ${localDates.trim() || "(none provided)"}\nPlan start date (Week 1 begins): ${startLabel}\n\nWEEK CALENDAR — the real calendar date of every day; use ONLY these, never compute your own:\n${cal}\n\nDepartment voice: ${brand?.voice || ""}\nTagline: ${brand?.tagline || ""}`);
      setPlan(t); setSaveTitle(need.trim().slice(0, 60) || `Recruitment plan · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`);
    }
    catch { setErr("Couldn't draft a plan just now. Try again in a moment."); } finally { setLoading(false); }
  }
  async function saveDraft() {
    if (!plan || !saveTitle.trim()) return;
    setSaving(true);
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { setSaving(false); notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
    const { error } = await supabase.from("ai_outputs").insert({ department_id: deptId, feature: "recruitment", title: saveTitle.trim(), ai_text: plan, created_by: meId });
    setSaving(false);
    if (error) { notify({ kind: "error", title: "Couldn't save the draft", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: "Draft saved." });
    loadDrafts();
  }
  async function loadDrafts() {
    const { data } = await supabase.from("ai_outputs").select("*").eq("feature", "recruitment").is("deleted_at", null);   // dept-scoped by RLS; hide soft-deleted
    setDrafts((data || []).sort((a, b) => (b.edited_at || b.created_at).localeCompare(a.edited_at || a.created_at)));   // coalesce(edited_at, created_at) desc
  }
  useEffect(() => { loadDrafts(); }, []);
  function closeDraft() { setOpenDraft(null); setEditing(false); setEditBuf(""); }       // backdrop / X
  function reopen(d) { setEditing(false); setEditBuf(""); setOpenDraft(d); }             // list Open — clear stale edit first
  function startEdit() { setEditBuf(openDraft.current_text ?? openDraft.ai_text ?? ""); setEditing(true); }
  async function saveEdit() {
    if (!editBuf.trim()) return;
    setSavingEdit(true);
    const { data, error } = await supabase.from("ai_outputs")
      .update({ current_text: editBuf, edited_by: meId, edited_at: new Date().toISOString() })   // ai_text left pristine
      .eq("id", openDraft.id).select().single();
    setSavingEdit(false);
    if (error) { notify({ kind: "error", title: "Couldn't save your edit", text: "Something went wrong saving your changes. Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: "Changes saved." });
    setOpenDraft(data); setEditing(false); setEditBuf(""); loadDrafts();                 // modal live-updates + list marker lights up
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>RECRUITMENT</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Build a recruitment plan — not just a post</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>A 90-day framework, an AI that drafts your whole plan, and ideas well beyond social media.</div>
      </div>
      <div style={S.phaseRow}>
        <Phase S={S} n="01" weeks="Weeks 1–4" title="Foundation" items={["Assign a recruitment lead", "Define who you're looking for", "Stand up a simple interest form", "Set a 90-day target"]} accent="#B11E2A" />
        <Phase S={S} n="02" weeks="Weeks 5–8" title="Outreach" items={["Member referral drive", "Employer + school outreach", "Show up at a community event", "Pick an open-house date"]} accent="#1F4E79" />
        <Phase S={S} n="03" weeks="Weeks 9–12" title="Convert" items={["Host the open house", "Follow up within 48 hours", "Move them through onboarding", "Assign a buddy / mentor"]} accent="#0E6B62" />
      </div>

      <div style={{ ...S.aiBanner, ...FS.card, borderLeft: `3px solid ${FIRE.red}` }}>
        <div style={{ flex: 1 }}>
          <button onClick={() => setPlannerOpen((v) => !v)} style={{ ...FS.kicker, marginBottom: plannerOpen ? 8 : 0, display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}><Sparkles size={13} style={{ verticalAlign: "-2px" }} />AI RECRUITMENT PLANNER<span style={{ marginLeft: "auto", display: "inline-flex" }}>{plannerOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span></button>
          {plannerOpen && (<>
          <h3 style={{ ...S.featTitle, color: FIRE.textPrimary }}>Draft a recruitment plan for your department</h3>
          <div style={S.twoColForm}>
            <AIField S={S} dark label="Your town" value={town} onChange={setTown} />
            <AIField S={S} dark label="Department size" value={size} onChange={setSize} />
          </div>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Plan start date <span style={{ color: FIRE.textMuted, fontWeight: 400 }}>— Week 1 begins here; every post gets a real date</span></span>
            <input type="date" style={FS.input} value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>What you need</span>
            <textarea style={{ ...FS.input, minHeight: 48, resize: "vertical" }} value={need} onChange={(e) => setNeed(e.target.value)} /></label>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Key local dates <span style={{ color: FIRE.textMuted, fontWeight: 400 }}>— optional, the plan schedules posts around these</span></span>
            <textarea style={{ ...FS.input, minHeight: 48, resize: "vertical" }} value={localDates} onChange={(e) => setLocalDates(e.target.value)} placeholder="e.g. Heritage Days Oct 12, farmers market every Saturday, HS football Fridays in fall" /></label>
          <button style={{ ...FS.btnPrimary, marginTop: 12, opacity: loading ? 0.7 : 1 }} onClick={draft} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><Sparkles size={16} /> Draft a plan</>}
          </button>
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
          {plan && <RichOutput S={S} text={plan} dark />}
          {plan && canManage && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
              <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Save as</span><input style={FS.input} value={saveTitle} onChange={(e) => setSaveTitle(e.target.value)} placeholder="Draft title" /></label>
              <button style={{ ...FS.btn, opacity: (saving || !saveTitle.trim()) ? 0.6 : 1 }} onClick={saveDraft} disabled={saving || !saveTitle.trim()}>{saving ? <><Loader2 size={16} className="spin" /> Saving…</> : <><FileText size={16} /> Save draft</>}</button>
            </div>
          )}
          </>)}
        </div>
      </div>

      <button onClick={() => setWaysOpen((v) => !v)} style={{ ...FS.kicker, marginBottom: waysOpen ? 8 : 16, display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>WAYS TO RECRUIT BEYOND SOCIAL MEDIA<span style={{ marginLeft: "auto", display: "inline-flex" }}>{waysOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span></button>
      {waysOpen && <IdeaGrid S={S} dark items={[
        { h: "Current-member referrals", p: "Your people's networks convert best. Give them a one-line script to forward." },
        { h: "Local employers", p: "Release-time or support partnerships — many owners want the community goodwill." },
        { h: "Schools & trade programs", p: "High schools, EMT classes, and fire-science programs build your pipeline." },
        { h: "Community events", p: "Festivals, markets, ballgames — bring an apparatus and a sign-up sheet." },
        { h: "Former members", p: "A warm 'we'd love to have you back' reopens more doors than you'd think." },
        { h: "Open house", p: "Your highest-converting event — tour, demo, food, and fast follow-up." },
      ]} />}

      <div style={{ ...FS.kicker, marginBottom: 8 }}><Calendar size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />RECRUITMENT CALENDAR</div>
      <RecruitmentCalendar S={S} role={role} notify={notify} />

      <GraphicStudio S={S} brand={brand} />

      <div style={{ ...FS.kicker, marginBottom: 8, marginTop: 22 }}><FileText size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />SAVED DRAFTS</div>
      <div style={{ ...FS.card, padding: "4px 16px", marginBottom: 22 }}>
        {drafts.length === 0 ? <div style={{ fontSize: 13, color: FIRE.textMuted, padding: "10px 0" }}>No saved drafts yet.</div> : drafts.map((d) => {
          const cName = members.find((m) => m.id === d.created_by)?.name || "Unknown";
          const eName = d.edited_by ? (members.find((m) => m.id === d.edited_by)?.name || "Unknown") : null;
          const when = new Date(d.edited_at || d.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary }}>{d.title || "Untitled draft"}</div>
                <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num }}>{cName} · {when}{eName ? ` · edited by ${eName}` : ""}</div>
              </div>
              <button style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }} onClick={() => reopen(d)}>Open</button>
            </div>
          );
        })}
      </div>
      {openDraft && (
        <div onClick={closeDraft} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...FS.card, maxWidth: 720, width: "100%", padding: "18px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ ...FS.kicker, marginBottom: 0 }}>{openDraft.title || "Draft"}</div>
              <div style={{ display: "flex", gap: 8 }}>
                {canManage && !editing && <button style={{ ...FS.btn, padding: "6px 10px" }} onClick={startEdit}><Pencil size={14} color={FIRE.btnIcon} /> Edit</button>}
                <button style={{ ...FS.btn, padding: "6px 10px" }} onClick={closeDraft}><X size={14} color={FIRE.btnIcon} /></button>
              </div>
            </div>
            {editing ? (
              <>
                <textarea style={{ ...FS.input, minHeight: 260, resize: "vertical", width: "100%", fontFamily: "inherit" }} value={editBuf} onChange={(e) => setEditBuf(e.target.value)} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                  <button style={FS.btn} onClick={() => { setEditing(false); setEditBuf(""); }} disabled={savingEdit}>Cancel</button>
                  <button style={{ ...FS.btnPrimary, opacity: (savingEdit || !editBuf.trim()) ? 0.6 : 1 }} onClick={saveEdit} disabled={savingEdit || !editBuf.trim()}>{savingEdit ? <><Loader2 size={16} className="spin" /> Saving…</> : <><FileText size={16} /> Save changes</>}</button>
                </div>
              </>
            ) : (
              <RichOutput S={S} text={openDraft.current_text ?? openDraft.ai_text} dark />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
function Phase({ S, n, weeks, title, items, accent }) {
  return (
    <div style={{ ...S.phaseCard, ...FS.card, borderTop: `3px solid ${accent}` }}>
      <div style={S.phaseTop}><span style={{ ...S.phaseNum, color: accent }}>{n}</span><span style={{ ...S.phaseWeeks, color: FIRE.textMuted }}>{weeks}</span></div>
      <div style={{ ...S.phaseTitle, color: FIRE.textPrimary }}>{title}</div>
      <ul style={{ ...S.phaseList, color: FIRE.textSecondary }}>{items.map((i) => <li key={i}>{i}</li>)}</ul>
    </div>
  );
}

/* ---------------- Station Documents (upload + create) ---------------- */
// SOP text extraction for AI grounding. pdfjs-dist is LAZY-imported — the parser only loads on first upload, never at page load.
let _pdfjs = null;
async function loadPdfjs() {
  if (_pdfjs) return _pdfjs;
  const lib = await import("pdfjs-dist");
  lib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;   // worker wired up ONCE — the #1 Vite gotcha
  _pdfjs = lib;
  return lib;
}
// Extract all page text from a PDF File. Throws if the bytes aren't a readable PDF (caller treats a throw as "no text").
async function extractPdfText(file) {
  const buf = await file.arrayBuffer();
  const pdfjsLib = await loadPdfjs();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  let text = "";
  for (let p = 1; p <= pdf.numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    text += tc.items.map((it) => it.str).join(" ") + "\n";   // items[].str = the selectable text spans on the page
  }
  return text;
}
const DOC_TYPES = ["SOP / SOG", "Policy", "Handbook", "Forms", "Agreement", "Reference", "Other"];
function Documents({ S, role, notify, uploaderName, members }) {
  const leader = isLeader(role);
  const canManageDocs = hasAny(role, CANMANAGE_OPS_ROLES);
  const isDA = isDeptAdmin(role);                       // DA/PA — matches the soft_delete_document / restore_document DB gate
  const isPA = hasAny(role, ["Project Admin"]);         // PA-only — permanent hard delete
  const nameById = new Map((members || []).map((m) => [m.id, m.name]));   // deleted_by (uuid) → member name
  const [docs, setDocs] = useState([]);
  const [showTrash, setShowTrash] = useState(false);
  const [trashed, setTrashed] = useState([]);
  const [trashLoading, setTrashLoading] = useState(false);
  const [historyFor, setHistoryFor] = useState(null);   // doc id whose version history is expanded
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [draftOpen, setDraftOpen] = useState(true);   // Draft a New Document — expanded by default
  const [docsLoading, setDocsLoading] = useState(true);
  const [uploadType, setUploadType] = useState("SOP / SOG");
  function loadDocs() {
    return supabase
      .from("documents")
      .select("id, name, type, storage_path, supersedes")
      .is("deleted_at", null)                            // hide trashed SOPs from the live list
      .is("archived_at", null)                           // hide superseded (older) versions — only current versions show
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error || !data) { setDocsLoading(false); return; }   // leave existing docs in place on a flaky read
        setDocs(data.map((r) => ({ id: r.id, name: r.name, type: r.type, storage_path: r.storage_path, supersedes: r.supersedes })));
        setDocsLoading(false);
      });
  }
  useEffect(() => { loadDocs(); }, []);
  function loadTrashed() {
    setTrashLoading(true);
    return supabase.from("documents").select("id, name, type, storage_path, deleted_at, deleted_by").not("deleted_at", "is", null).order("deleted_at", { ascending: false })
      .then(({ data, error }) => {
        if (error || !data) { setTrashLoading(false); return; }
        setTrashed(data.map((r) => ({ id: r.id, name: r.name, type: r.type, storage_path: r.storage_path, deletedBy: r.deleted_by,
          deletedWhen: r.deleted_at ? new Date(r.deleted_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—" })));
        setTrashLoading(false);
      });
  }
  const [kind, setKind] = useState("SOP / SOG");
  const [desc, setDesc] = useState("A standard operating guideline for responding to a structure fire with a single engine plus mutual aid.");
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  async function uploadFiles(files) {
    if (!files.length) return;

    // resolve department id ONCE, before the loop (same RPC pattern as addCat)
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) {
      notify({ kind: "error", title: "Couldn't find your department", text: "We couldn't determine your department — please try again." });
      return;
    }

    let okCount = 0;
    const failed = [];
    let lastErr = "";
    const added = [];
    const noText = [];   // saved OK but yielded no extractable text (scan / non-PDF) — advisory, NOT a failure
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // collision-proof path: {deptId}/{timestamp}-{index}-{filename}
      const path = `${deptId}/${Date.now()}-${i}-${file.name}`;
      // 1) upload the file bytes to the private bucket
      const { error: upErr } = await supabase.storage.from("station-documents").upload(path, file);
      if (upErr) { failed.push(file.name); lastErr = upErr.message; continue; }
      // 2) extract text for AI grounding — best-effort; NEVER blocks the upload (row still saves with content_text null).
      let content_text = null;
      const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
      if (!isPdf) {
        noText.push(file.name);                                          // gate 1: not a PDF (DOCX, image, etc.)
      } else {
        try {
          const text = await extractPdfText(file);
          if (text.replace(/\s/g, "").length >= 25) content_text = text.trim();   // gate 3: has a real text layer
          else noText.push(file.name);                                  // empty/near-empty → likely a scanned image PDF
        } catch {
          noText.push(file.name);                                       // gate 2: getDocument threw — unreadable / not a real PDF
        }
      }
      // 3) write the metadata row (content_text = extracted text, or null on any extraction failure)
      const row = { department_id: deptId, name: file.name, type: uploadType, storage_path: path, uploaded_by: uploaderName, content_text };
      const { data: docData, error: docErr } = await supabase.from("documents").insert(row).select().single();
      if (docErr || !docData) { failed.push(file.name); lastErr = docErr?.message ?? "unknown error"; continue; }
      // confirmed-committed row — map to loadDocs's exact shape for an optimistic prepend
      added.push({ id: docData.id, name: docData.name, type: docData.type, storage_path: docData.storage_path });
      okCount++;
    }

    // 3) show the just-inserted rows instantly (already committed), then reconcile with DB truth
    if (added.length) setDocs((d) => [...added, ...d]);
    await loadDocs();   // non-destructive: a flaky read leaves the optimistic rows in place
    // advisory (not an error): files that saved but couldn't be read for AI grounding — appended to the summary
    const aiNote = noText.length ? ` Couldn't read text from ${noText.join(", ")} — they may be scans or unsupported formats; they won't be included in the AI assistant until re-uploaded as text PDFs.` : "";
    if (failed.length === 0) {
      notify({ kind: "success", title: "Documents uploaded", text: `${okCount} document${okCount === 1 ? "" : "s"} uploaded.${aiNote}` });
    } else if (okCount > 0) {
      notify({ kind: "error", title: "Some uploads failed", text: `${okCount} uploaded, ${failed.length} couldn't be added: ${failed.join(", ")}.${aiNote}` });
    } else {
      notify({ kind: "error", title: "Couldn't upload", text: "None of your documents could be uploaded.", details: lastErr });
    }
  }
  async function onFiles(e) {
    const input = e.target;
    await uploadFiles(Array.from(input.files || []));
    input.value = "";   // reset unconditionally so re-selecting the same file(s) refires onChange
  }
  async function openDoc(item) {
    if (!item?.storage_path) return;
    const { data, error } = await supabase.storage
      .from("station-documents")
      .createSignedUrl(item.storage_path, 3600);
    if (error || !data?.signedUrl) {
      notify({ kind: "error", title: "Couldn't open file", text: "The document couldn't be opened — please try again.", details: error?.message ?? "no signed URL" });
      return;
    }
    const a = document.createElement("a");
    a.href = data.signedUrl;
    a.target = "_blank";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    a.remove();
  }
  // Soft-delete: move to trash (DA/PA, server-stamped). File STAYS in Storage so it can be restored.
  async function deleteDoc(item) {
    if (!item?.id) return;
    if (!window.confirm(`Move "${item.name}" to the trash? An admin can restore it.`)) return;
    const { error } = await supabase.rpc("soft_delete_document", { p_id: item.id });
    if (error) { notify({ kind: "error", title: "Couldn't move to trash", text: "Please try again.", details: error.message }); return; }
    notify({ kind: "success", title: "Moved to trash", text: `"${item.name}" was moved to the trash.` });
    loadDocs(); if (showTrash) loadTrashed();
  }
  // Restore from trash (DA/PA, server-stamped).
  async function restoreDoc(item) {
    if (!item?.id) return;
    const { error } = await supabase.rpc("restore_document", { p_id: item.id });
    if (error) { notify({ kind: "error", title: "Couldn't restore", text: "Please try again.", details: error.message }); return; }
    notify({ kind: "success", title: "Restored", text: `"${item.name}" is back in the library.` });
    loadTrashed(); loadDocs();
  }
  // Permanent hard delete (PA ONLY): erase the file + row. Cannot be undone.
  async function hardDeleteDoc(item) {
    if (!item?.id) return;
    if (!window.confirm(`Permanently delete "${item.name}"? This CANNOT be undone — the file and its record are erased.`)) return;
    if (item.storage_path) {
      const { error: rmErr } = await supabase.storage.from("station-documents").remove([item.storage_path]);
      if (rmErr) { notify({ kind: "error", title: "Couldn't delete file", text: "Please try again.", details: rmErr.message }); return; }
    }
    const { error: rowErr } = await supabase.from("documents").delete().eq("id", item.id);
    if (rowErr) { notify({ kind: "error", title: "File removed, record not", text: "The file was erased but its record couldn't be removed.", details: rowErr.message }); loadTrashed(); return; }
    notify({ kind: "success", title: "Permanently deleted", text: `"${item.name}" was erased.` });
    loadTrashed();
  }
  // Replace with a new version: upload new file → insert new row (SAME name/type) → replace_document RPC (links new→old + archives old).
  async function doReplace(oldRow, file) {
    if (!oldRow?.id || !file) return;
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
    const path = `${deptId}/${Date.now()}-${file.name}`;                                   // new unique storage path (same pattern as uploadFiles)
    const { error: upErr } = await supabase.storage.from("station-documents").upload(path, file);
    if (upErr) { notify({ kind: "error", title: "Couldn't upload the new version", text: "Please try again.", details: upErr.message }); return; }
    const row = { department_id: deptId, name: oldRow.name, type: oldRow.type, storage_path: path, uploaded_by: uploaderName };   // inherit name/type from the original
    const { data: newRow, error: insErr } = await supabase.from("documents").insert(row).select().single();
    if (insErr || !newRow) { notify({ kind: "error", title: "Couldn't save the new version", text: "Please try again.", details: insErr?.message }); return; }
    const { error: repErr } = await supabase.rpc("replace_document", { p_old_id: oldRow.id, p_new_id: newRow.id });   // link new→old + archive old
    if (repErr) { notify({ kind: "error", title: "Uploaded, but couldn't archive the old version", text: "The new version saved but the previous one wasn't archived — please try again.", details: repErr.message }); loadDocs(); return; }
    notify({ kind: "success", title: "New version saved", text: `"${oldRow.name}" was updated — the previous version is kept in history.` });
    setHistoryFor(null);   // the chain changed; collapse any open history
    loadDocs();
  }
  // Version history: walk the supersedes chain backward — current.supersedes → prior → prior.supersedes → … → null.
  // Each fetched row is one older version; because we start at the most-recent prior and follow the pointer, chain is newest-first.
  async function loadHistory(doc) {
    setHistoryFor(doc.id); setHistory([]); setHistoryLoading(true);
    const chain = [];
    let cursor = doc.supersedes;   // id of the immediately-previous version (null if this is the original)
    let guard = 0;                 // runaway / cycle guard
    while (cursor && guard < 50) {
      const { data, error } = await supabase.from("documents")
        .select("id, name, type, storage_path, created_at, uploaded_by, supersedes")
        .eq("id", cursor).maybeSingle();
      if (error || !data) break;
      chain.push(data);
      cursor = data.supersedes;
      guard++;
    }
    setHistory(chain); setHistoryLoading(false);
  }
  function toggleHistory(doc) {
    if (historyFor === doc.id) { setHistoryFor(null); setHistory([]); }
    else loadHistory(doc);
  }
  async function draft() {
    setLoading(true); setErr(""); setOut("");
    const sys = "You help a volunteer fire/EMS department draft an internal document (SOP/SOG, guideline, policy, or checklist). Write a clear, well-structured DRAFT in plain text with a title, a short note that it must be reviewed and adapted to the department's AHJ, local protocols, medical direction, and applicable law, then numbered sections. Practical and realistic for a small volunteer department. Under 450 words.";
    try { const t = await callClaude(sys, `Document type: ${kind}\nWhat it should cover: ${desc}`); setOut(t); }
    catch { setErr("Couldn't draft that just now. Try again in a moment."); } finally { setLoading(false); }
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>STATION DOCUMENTS</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Your SOPs and guidelines, in one place</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>{leader ? "Upload what you've got — and draft what you don't. Everything stays yours." : "Your station's current SOPs, guidelines, and handbook — always available to you."}</div>
      </div>

      {canManageDocs && (<>
        <div style={{ ...FS.kicker, marginBottom: 8 }}><Upload size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />UPLOAD YOUR DOCUMENTS</div>
        <label style={{ ...S.field, maxWidth: 240, marginBottom: 12 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Type for these uploads</span>
          <select style={{ ...FS.input, maxWidth: 240 }} value={uploadType} onChange={(e) => setUploadType(e.target.value)}>
            {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select></label>
        <label style={{ ...S.docDrop, background: FIRE.btnBg, border: `2px dashed ${FIRE.btnBorder}` }}
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => { e.preventDefault(); uploadFiles(Array.from(e.dataTransfer.files || [])); }}>
          <Upload size={22} color={FIRE.btnIcon} />
          <div style={{ ...S.docDropText, color: FIRE.textSecondary }}>Drop files here or <span style={{ color: FIRE.redBright, fontWeight: 600 }}>browse</span></div>
          <div style={{ ...S.docDropSub, color: FIRE.textMuted }}>SOPs, SOGs, guidelines, agreements — PDF, Word, or images</div>
          <input type="file" multiple style={{ display: "none" }} onChange={onFiles} />
        </label>

        <button onClick={() => setDraftOpen((v) => !v)} style={{ ...FS.kicker, marginTop: 24, marginBottom: draftOpen ? 8 : 0, display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}><FilePlus size={13} style={{ verticalAlign: "-2px" }} />DRAFT A NEW DOCUMENT<span style={{ marginLeft: "auto", display: "inline-flex" }}>{draftOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span></button>
        {draftOpen && (<>
        <div style={{ ...S.aiBanner, ...FS.card, borderLeft: `3px solid ${FIRE.red}` }}>
          <div style={{ flex: 1 }}>
            <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Document type</span>
              <select style={{ ...FS.input, maxWidth: 240 }} value={kind} onChange={(e) => setKind(e.target.value)}>
                {DOC_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select></label>
            <label style={{ ...S.field, marginTop: 12 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>What should it cover?</span>
              <textarea style={{ ...FS.input, minHeight: 60, resize: "vertical" }} value={desc} onChange={(e) => setDesc(e.target.value)} /></label>
            <button style={{ ...FS.btnPrimary, marginTop: 12, opacity: loading ? 0.7 : 1 }} onClick={draft} disabled={loading}>
              {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><FilePlus size={16} /> Draft document</>}
            </button>
            {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
            {out && <div style={{ marginTop: 14 }}><Disclaimer S={S} compact dark /><RichOutput S={S} text={out} dark /></div>}
          </div>
        </div>
        </>)}
      </>)}

      <div style={{ ...FS.kicker, marginTop: 24, marginBottom: 8 }}><FolderOpen size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />YOUR DOCUMENT LIBRARY</div>
      {!docsLoading && docs.length === 0 ? (
        <div style={{ ...S.empty, ...FS.card, color: FIRE.textMuted }}>
          {canManageDocs
            ? "No documents yet — upload your first above."
            : "No documents have been added yet."}
        </div>
      ) : (
        <div>
          {docs.map((d) => (
            <div key={d.id}>
              <div style={{ ...S.certRow, flexWrap: "wrap", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
                <FileText size={15} color={FIRE.btnIcon} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}><span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{d.name}</span> <span style={{ color: FIRE.textMuted, fontSize: 13 }}>· {d.type}</span></div>
                <button style={{ ...FS.btn, padding: "7px 12px", fontSize: 12.5 }} onClick={() => openDoc(d)}><Download size={14} /> Open</button>
                <button style={{ ...FS.btn, padding: "7px 10px", fontSize: 12.5 }} onClick={() => toggleHistory(d)}><Clock size={14} /> History <span style={{ display: "inline-flex" }}>{historyFor === d.id ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span></button>
                {isDA && <label style={{ ...FS.btn, padding: "6px 8px", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }} title="Replace with a new version"><Upload size={14} /> Replace<input type="file" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; if (f) doReplace(d, f); }} /></label>}
                {isDA && <button title="Move to trash" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => deleteDoc(d)}><X size={14} color={FIRE.deleteRed} /></button>}
              </div>
              {historyFor === d.id && (
                <div style={{ ...FS.card, padding: 12, marginTop: 6, marginBottom: 8 }}>
                  <div style={{ ...FS.kicker, marginBottom: 6 }}>VERSION HISTORY</div>
                  {historyLoading ? <div style={{ fontSize: 13, color: FIRE.textMuted, padding: "6px 0" }}>Loading…</div>
                   : history.length === 0 ? <div style={{ fontSize: 13, color: FIRE.textMuted, padding: "6px 0" }}>No previous versions — this is the original.</div>
                   : history.map((v) => (
                     <div key={v.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
                       <FileText size={14} color={FIRE.textMuted} style={{ flexShrink: 0 }} />
                       <div style={{ flex: 1, minWidth: 0, fontSize: 12.5, color: FIRE.textSecondary }}>Uploaded {v.created_at ? new Date(v.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—"}{v.uploaded_by ? ` · ${v.uploaded_by}` : ""}</div>
                       <button style={{ ...FS.btn, padding: "6px 10px", fontSize: 12 }} onClick={() => openDoc(v)}><Download size={13} /> View</button>
                     </div>
                   ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {isDA && (
        <div style={{ marginTop: 24 }}>
          <button onClick={() => { const n = !showTrash; setShowTrash(n); if (n) loadTrashed(); }} style={{ ...FS.kicker, marginBottom: showTrash ? 8 : 0, display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}><Trash2 size={13} style={{ verticalAlign: "-2px" }} />TRASH<span style={{ marginLeft: "auto", display: "inline-flex" }}>{showTrash ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span></button>
          {showTrash && (
            trashLoading ? <div style={{ ...S.empty, ...FS.card, color: FIRE.textMuted }}>Loading…</div>
            : trashed.length === 0 ? <div style={{ ...S.empty, ...FS.card, color: FIRE.textMuted }}>Trash is empty.</div>
            : trashed.map((d) => (
              <div key={d.id} style={{ ...S.certRow, flexWrap: "wrap", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
                <Trash2 size={15} color={FIRE.textMuted} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{d.name}</span> <span style={{ color: FIRE.textMuted, fontSize: 13 }}>· {d.type}</span>
                  <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 1 }}>Trashed {d.deletedWhen}{d.deletedBy ? ` · ${nameById.get(d.deletedBy) || "An admin"}` : ""}</div>
                </div>
                <button style={{ ...FS.btn, padding: "7px 12px", fontSize: 12.5 }} onClick={() => restoreDoc(d)}><RefreshCw size={14} /> Restore</button>
                {isPA && <button title="Permanently delete" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => hardDeleteDoc(d)}><Trash2 size={14} color={FIRE.deleteRed} /></button>}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Visibility ---------------- */
const POST_THEMES = [
  { tag: "PEOPLE", c: "#B11E2A", t: "Member spotlight — why they serve" },
  { tag: "COMMUNITY", c: "#0E6B62", t: "Seasonal safety tip" },
  { tag: "BEHIND SCENES", c: "#1F4E79", t: "Training night photo or clip" },
  { tag: "THE ASK", c: "#9A6B12", t: "Thank a supporter / recap the month" },
  { tag: "SAFETY", c: "#54506B", t: "Quick home-safety reminder" },
];
const CAL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const CATEGORY_COLORS = ["#B11E2A", "#1F4E79", "#0E6B62", "#9A6B12", "#54506B", "#2E7D52", "#C15512", "#3A4A5A"];
const TIER_STYLES = {
  bar:  { fontSize: 10.5, fontWeight: 700, padding: "3px 6px", borderRadius: 5 },
  pill: { fontSize: 9.5,  fontWeight: 600, padding: "2px 5px", borderRadius: 999 },
  dot:  { fontSize: 9, fontWeight: 600, padding: "1px 5px 1px 4px", borderRadius: 999, display: "inline-flex", alignItems: "center", gap: 4 },
};
function MonthCalendar({ cur, setCur, items, renderChip, todayColor, headerExtra, monthLabel, overflowIndicator, dark }) {
  const today = new Date();
  const dim = new Date(cur.y, cur.m + 1, 0).getDate();
  const firstDow = new Date(cur.y, cur.m, 1).getDay();
  const isToday = (d) => cur.y === today.getFullYear() && cur.m === today.getMonth() && d === today.getDate();
  function shift(n) { let m = cur.m + n, y = cur.y; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } setCur({ y, m }); }

  const cells = [];
  for (let i = 0; i < firstDow; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(d);

  const st = {
    wrap: dark ? { ...FS.card, overflow: "hidden", marginBottom: 10 } : { border: "1px solid #E7E5EE", borderRadius: 12, overflow: "hidden", background: "#fff", marginBottom: 10 },
    bar: { display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderBottom: `1px solid ${dark ? FIRE.hairline : "#EFEEF3"}` },
    mlabel: { fontWeight: 700, fontSize: 15, color: dark ? FIRE.textPrimary : "#211C2B" },
    nav: { border: `${dark ? "0.5px" : "1px"} solid ${dark ? FIRE.btnBorder : "#E0DEE8"}`, background: dark ? FIRE.btnBg : "#fff", borderRadius: 8, padding: "5px 8px", cursor: "pointer", color: dark ? FIRE.btnIcon : "#54506B", display: "inline-flex", alignItems: "center" },
    dow: { display: "grid", gridTemplateColumns: "repeat(7, minmax(0,1fr))", background: dark ? FIRE.btnBg : "#F7F6FA" },
    dowc: { padding: "7px 0", textAlign: "center", fontSize: 10.5, fontWeight: 700, color: dark ? FIRE.textMuted : "#8A8696", letterSpacing: 0.4 },
    grid: { display: "grid", gridTemplateColumns: "repeat(7, minmax(0,1fr))" },
    cell: { minHeight: 74, minWidth: 0, borderTop: `1px solid ${dark ? FIRE.hairline : "#EFEEF3"}`, borderLeft: `1px solid ${dark ? FIRE.hairline : "#EFEEF3"}`, padding: 5, display: "flex", flexDirection: "column", gap: 3 },
    dnum: { fontSize: 11, color: dark ? FIRE.textMuted : "#9A96A6", fontWeight: 600, alignSelf: "flex-start" },
    dtoday: { background: todayColor, color: "#fff", borderRadius: 999, width: 18, height: 18, display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10.5 },
    chip: { fontSize: 9.5, color: "#fff", borderRadius: 5, padding: "2px 5px", lineHeight: 1.25, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  };

  return (
    <div style={st.wrap}>
      <div style={st.bar}>
        <button style={st.nav} onClick={() => shift(-1)} title="Previous month"><ArrowLeft size={15} /></button>
        <div style={st.mlabel}>{monthLabel}</div>
        <button style={st.nav} onClick={() => shift(1)} title="Next month"><ChevronRight size={15} /></button>
        {headerExtra}
      </div>
      <div style={st.dow}>{["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => <div key={d} style={st.dowc}>{d.toUpperCase()}</div>)}</div>
      <div style={st.grid}>
        {cells.map((d, i) => {
          const dayItems = d == null ? [] : items.filter((it) => it.d === d);
          return (
            <div key={i} style={{ ...st.cell, ...(i % 7 === 0 ? { borderLeft: "none" } : {}), background: d == null ? (dark ? FIRE.btnBg : "#FBFAFC") : (dark ? "transparent" : "#fff") }}>
              {d != null && (<>
                <span style={isToday(d) ? st.dtoday : st.dnum}>{d}</span>
                {dayItems.slice(0, 3).map((it) => {
                  const c = renderChip(it);
                  const isDot = c.tier === "dot";
                  return (
                    <div key={it.id} style={{ ...st.chip, background: isDot ? "transparent" : c.color, ...(isDot ? { color: dark ? FIRE.textSecondary : "#3A4750" } : null), ...(c.tier ? TIER_STYLES[c.tier] : null), ...(c.onClick ? { cursor: "pointer" } : {}) }} title={c.title} onClick={c.onClick}>
                      {isDot && <span style={{ width: 6, height: 6, borderRadius: 999, background: c.color, flexShrink: 0, display: "inline-block" }} />}
                      {c.label}
                    </div>
                  );
                })}
                {overflowIndicator && dayItems.length > 3 && (
                  <div style={{ fontSize: 9, color: dark ? FIRE.textMuted : "#8A8696", fontWeight: 600, paddingLeft: 2 }}>+{dayItems.length - 3} more</div>
                )}
              </>)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
function ContentCalendar({ S, role, notify }) {
  const today = new Date();
  const [cur, setCur] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [posts, setPosts] = useState([]);
  const loadPosts = () => {
    supabase.from("content_calendar")
      .select("id, date, theme, caption, color")
      .then(({ data, error }) => {
        if (error || !data) { setPosts([]); return; }
        setPosts(
          data.filter((r) => r.date).map((r) => {
            const [yy, mm, dd] = r.date.split("-").map(Number);
            return { id: r.id, y: yy, m: (mm || 1) - 1, d: dd, tag: r.theme, c: r.color, t: r.caption || "" };
          })
        );
      });
  };
  useEffect(() => { loadPosts(); }, []);
  const [categories, setCategories] = useState(
    POST_THEMES.map((th, i) => ({ id: `seed-${i}`, tag: th.tag, c: th.c, t: th.t, isDefault: true, sortOrder: i }))
  );
  function loadCategories(isInitial) {
    supabase.from("post_categories")
      .select("id, label, color, default_text, sort_order, is_default")
      .order("sort_order", { ascending: true })
      .then(({ data, error }) => {
        if (error || !data || data.length === 0) return;   // keep fallback if empty/error
        setCategories(data.map((r) => ({ id: r.id, tag: r.label, c: r.color, t: r.default_text || "", isDefault: r.is_default, sortOrder: r.sort_order })));
        if (isInitial) {                       // only the mount load seeds the form selection;
          const first = data[0];               // refetches after add/delete must NOT clobber an open form
          setFi(first.id);
          setFt(first.default_text || "");
        }
      });
  }
  useEffect(() => { loadCategories(true); }, []);
  const [show, setShow] = useState(false);
  const [fd, setFd] = useState(today.getDate());
  const [fi, setFi] = useState(categories[0]?.id ?? null);   // fi is now a category ID, not an array index
  const [ft, setFt] = useState("");
  const [showCat, setShowCat] = useState(false);
  const [catLabel, setCatLabel] = useState("");
  const [catColor, setCatColor] = useState(CATEGORY_COLORS[0]);
  const [catText, setCatText] = useState("");

  const dim = new Date(cur.y, cur.m + 1, 0).getDate();
  const monthPosts = posts.filter((p) => p.y === cur.y && p.m === cur.m);
  const canEditCategories = hasAny(role, CANMANAGE_OPS_ROLES);
  function quickAdd(catId) {
    const cat = categories.find((c) => c.id === catId);
    setFi(catId); setFt(cat ? cat.t : ""); setFd(Math.min(fd, dim)); setShow(true);
  }
  async function add() {
    const cat = categories.find((c) => c.id === fi);
    if (!cat) return;   // guard: empty/unmatched categories
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "We couldn't determine your department — please try again." }); return; }
    const row = {
      department_id: deptId,
      date: toISO(new Date(cur.y, cur.m, Number(fd))),
      theme: cat.tag,
      caption: ft.trim() || cat.t,
      color: cat.c,
    };
    const { error } = await supabase.from("content_calendar").insert(row);
    if (error) { notify({ kind: "error", title: "Couldn't add the post", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setShow(false); setFt(""); loadPosts();
  }
  async function remove(id, t) {
    if (!window.confirm(`Remove “${t}” from the calendar?`)) return;
    const { error } = await supabase.from("content_calendar").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove the post", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadPosts();
  }
  async function addCat() {
    const label = catLabel.trim();
    if (!label) { notify({ kind: "error", title: "Category needs a label", text: "Give the category a label before saving it." }); return; }
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "We couldn't determine your department — please try again." }); return; }
    const sortOrder = categories.reduce((mx, c) => Math.max(mx, c.sortOrder ?? 0), 0) + 1;
    const row = { department_id: deptId, label, color: catColor, default_text: catText.trim() || null, is_default: false, sort_order: sortOrder };
    const { data, error } = await supabase.from("post_categories").insert(row).select().single();
    if (error || !data) { notify({ kind: "error", title: "Couldn't add the category", text: "Something went wrong saving that. Please try again.", details: error?.message ?? "unknown error" }); return; }   // keep form open on error
    setShowCat(false); setCatLabel(""); setCatColor(CATEGORY_COLORS[0]); setCatText("");
    loadCategories(false);                                   // refresh chips; do NOT reset the form selection
  }
  async function deleteCat(cat) {
    if (!window.confirm(`Delete the “${cat.tag}” category? Posts already on the calendar keep their color and won't change.`)) return;
    const { error } = await supabase.from("post_categories").delete().eq("id", cat.id);
    if (error) { notify({ kind: "error", title: "Couldn't delete the category", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadCategories(false);                                   // NOTE: posts state is intentionally untouched here
  }

  return (
    <div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 10 }}>
        {categories.map((cat) => (
          <span key={cat.id} style={{ position: "relative", display: "inline-flex" }}>
            <button onClick={() => quickAdd(cat.id)}
              style={{ border: `1.5px solid ${cat.c}`, color: cat.c, background: FIRE.btnBg, borderRadius: 999, padding: "5px 11px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
              <Plus size={13} /> {cat.tag}
            </button>
            {canEditCategories && !cat.isDefault && (
              <button title={`Delete ${cat.tag}`} onClick={(e) => { e.stopPropagation(); deleteCat(cat); }}
                style={{ position: "absolute", top: -6, right: -6, width: 16, height: 16, borderRadius: 999, border: `1px solid ${cat.c}`, background: FIRE.card, color: cat.c, cursor: "pointer", padding: 0, display: "inline-flex", alignItems: "center", justifyContent: "center", lineHeight: 1 }}>
                <X size={10} />
              </button>
            )}
          </span>
        ))}
        {canEditCategories && (
          <button onClick={() => setShowCat((v) => !v)}
            style={{ border: `1.5px dashed ${FIRE.btnBorder}`, color: FIRE.navLabel, background: FIRE.btnBg, borderRadius: 999, padding: "5px 11px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
            <Plus size={13} /> New
          </button>
        )}
      </div>

      {showCat && (
        <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Label</span>
            <input style={FS.input} value={catLabel} onChange={(e) => setCatLabel(e.target.value)} placeholder="e.g. EVENTS" /></label>
          <div style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Color</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 2 }}>
              {CATEGORY_COLORS.map((col) => (
                <button key={col} title={col} onClick={() => setCatColor(col)}
                  style={{ width: 24, height: 24, borderRadius: 999, background: col, cursor: "pointer", border: catColor === col ? `3px solid ${FIRE.textPrimary}` : `2px solid ${FIRE.card}`, boxShadow: `0 0 0 1px ${FIRE.btnBorder}` }} />
              ))}
            </div>
          </div>
          <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Post idea (optional)</span>
            <input style={FS.input} value={catText} onChange={(e) => setCatText(e.target.value)} placeholder="Default text for this category" /></label>
          <button style={FS.btnPrimary} onClick={addCat}><Plus size={15} /> Save category</button>
          <button style={FS.btn} onClick={() => { setShowCat(false); setCatLabel(""); setCatColor(CATEGORY_COLORS[0]); setCatText(""); }}>Cancel</button>
        </div>
      )}

      {show && (
        <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...S.field, minWidth: 90 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Day</span>
            <select style={FS.input} value={fd} onChange={(e) => setFd(e.target.value)}>{Array.from({ length: dim }, (_, i) => i + 1).map((d) => <option key={d}>{d}</option>)}</select></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Category</span>
            <select style={FS.input} value={fi || ""} onChange={(e) => { const cat = categories.find((c) => c.id === e.target.value); setFi(e.target.value); setFt(cat ? cat.t : ""); }}>{categories.map((cat) => <option key={cat.id} value={cat.id}>{cat.tag}</option>)}</select></label>
          <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Post idea</span>
            <input style={FS.input} value={ft} onChange={(e) => setFt(e.target.value)} placeholder="What's the post?" /></label>
          <button style={FS.btnPrimary} onClick={add}><Plus size={15} /> Add to {CAL_MONTHS[cur.m]}</button>
          <button style={FS.btn} onClick={() => setShow(false)}>Cancel</button>
        </div>
      )}

      <MonthCalendar
        cur={cur} setCur={setCur} dark
        items={monthPosts}
        renderChip={(p) => ({ color: p.c, label: p.t, title: `${p.tag} — ${p.t} (tap to remove)`, onClick: () => remove(p.id, p.t) })}
        todayColor="#B11E2A"
        monthLabel={`${CAL_MONTHS[cur.m]} ${cur.y}`}
        headerExtra={
          <button style={{ border: `0.5px solid ${FIRE.btnBorder}`, background: FIRE.btnBg, borderRadius: 8, padding: "5px 8px", cursor: "pointer", color: FIRE.btnText, display: "inline-flex", alignItems: "center", marginLeft: "auto", fontSize: 12.5, fontWeight: 600, gap: 5 }} onClick={() => { setFd(Math.min(today.getDate(), dim)); const cat = categories[0]; setFi(cat ? cat.id : null); setFt(cat ? cat.t : ""); setShow(true); }}><Plus size={14} /> Add a post</button>
        }
      />
      <div style={{ fontSize: 12.5, color: FIRE.textMuted, marginBottom: 18 }}>
        {monthPosts.length} post{monthPosts.length === 1 ? "" : "s"} scheduled in {CAL_MONTHS[cur.m]} · tap a colored post to remove it, or use a category chip to add one.
      </div>
    </div>
  );
}
function RecruitmentCalendar({ S, role, notify }) {
  const today = new Date();
  const [cur, setCur] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [items, setItems] = useState([]);
  const loadItems = () => {
    supabase.from("recruitment_events")
      .select("id, date, title, color, notes")
      .then(({ data, error }) => {
        if (error || !data) { setItems([]); return; }
        setItems(
          data.filter((r) => r.date).map((r) => {
            const [yy, mm, dd] = r.date.split("-").map(Number);
            return { id: r.id, y: yy, m: (mm || 1) - 1, d: dd, title: r.title, c: r.color, notes: r.notes || "" };
          })
        );
      });
  };
  useEffect(() => { loadItems(); }, []);
  const [show, setShow] = useState(false);
  const [fd, setFd] = useState(today.getDate());
  const [evTitle, setEvTitle] = useState("");
  const [color, setColor] = useState(CATEGORY_COLORS[0]);

  const dim = new Date(cur.y, cur.m + 1, 0).getDate();
  const monthItems = items.filter((it) => it.y === cur.y && it.m === cur.m);
  const canEdit = hasAny(role, CANMANAGE_OPS_ROLES);

  async function addEvent() {
    const t = evTitle.trim();
    if (!t) { notify({ kind: "error", title: "Event needs a title", text: "Give the event a title before saving it." }); return; }
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "We couldn't determine your department — please try again." }); return; }
    const { error } = await supabase.from("recruitment_events").insert({
      department_id: deptId,
      title: t,
      date: toISO(new Date(cur.y, cur.m, Number(fd))),
      color,
    });
    if (error) { notify({ kind: "error", title: "Couldn't add the event", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }   // keep form open on error
    setShow(false); setEvTitle(""); setColor(CATEGORY_COLORS[0]); loadItems();
  }
  async function removeEvent(id, title) {
    if (!window.confirm(`Remove “${title}” from the recruitment calendar?`)) return;
    const { error } = await supabase.from("recruitment_events").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove the event", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadItems();
  }

  return (
    <div>
      {show && canEdit && (
        <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Title</span>
            <input style={FS.input} value={evTitle} onChange={(e) => setEvTitle(e.target.value)} placeholder="e.g. Open house at Station 20" /></label>
          <label style={{ ...S.field, minWidth: 90 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Day</span>
            <select style={FS.input} value={fd} onChange={(e) => setFd(e.target.value)}>{Array.from({ length: dim }, (_, i) => i + 1).map((d) => <option key={d}>{d}</option>)}</select></label>
          <div style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Color</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 2 }}>
              {CATEGORY_COLORS.map((col) => (
                <button key={col} title={col} onClick={() => setColor(col)}
                  style={{ width: 24, height: 24, borderRadius: 999, background: col, cursor: "pointer", border: color === col ? `3px solid ${FIRE.textPrimary}` : `2px solid ${FIRE.card}`, boxShadow: `0 0 0 1px ${FIRE.btnBorder}` }} />
              ))}
            </div>
          </div>
          <button style={FS.btnPrimary} onClick={addEvent}><Plus size={15} /> Add to {CAL_MONTHS[cur.m]}</button>
          <button style={FS.btn} onClick={() => setShow(false)}>Cancel</button>
        </div>
      )}

      <MonthCalendar
        cur={cur} setCur={setCur} dark
        items={monthItems}
        renderChip={(it) => ({ color: it.c, label: it.title, title: canEdit ? `${it.title} (tap to remove)` : it.title, onClick: canEdit ? () => removeEvent(it.id, it.title) : undefined })}
        todayColor="#0E6B62"
        monthLabel={`${CAL_MONTHS[cur.m]} ${cur.y}`}
        headerExtra={canEdit ? (
          <button style={{ border: `0.5px solid ${FIRE.btnBorder}`, background: FIRE.btnBg, borderRadius: 8, padding: "5px 8px", cursor: "pointer", color: FIRE.btnText, display: "inline-flex", alignItems: "center", marginLeft: "auto", fontSize: 12.5, fontWeight: 600, gap: 5 }} onClick={() => { setFd(Math.min(today.getDate(), dim)); setEvTitle(""); setColor(CATEGORY_COLORS[0]); setShow(true); }}><Plus size={14} /> Add an event</button>
        ) : null}
      />
      <div style={{ fontSize: 12.5, color: FIRE.textMuted, marginBottom: 18 }}>
        {monthItems.length} event{monthItems.length === 1 ? "" : "s"} in {CAL_MONTHS[cur.m]}{canEdit ? " · tap an event to remove it" : ""}.
      </div>
    </div>
  );
}
function FundingCalendar({ S, role, notify }) {
  const today = new Date();
  const [cur, setCur] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [items, setItems] = useState([]);
  const loadItems = () => {
    supabase.from("funding_events")
      .select("id, date, title, color, notes")
      .then(({ data, error }) => {
        if (error || !data) { setItems([]); return; }
        setItems(
          data.filter((r) => r.date).map((r) => {
            const [yy, mm, dd] = r.date.split("-").map(Number);
            return { id: r.id, y: yy, m: (mm || 1) - 1, d: dd, title: r.title, c: r.color, notes: r.notes || "" };
          })
        );
      });
  };
  useEffect(() => { loadItems(); }, []);
  const [show, setShow] = useState(false);
  const [fd, setFd] = useState(today.getDate());
  const [evTitle, setEvTitle] = useState("");
  const [color, setColor] = useState(CATEGORY_COLORS[0]);

  const dim = new Date(cur.y, cur.m + 1, 0).getDate();
  const monthItems = items.filter((it) => it.y === cur.y && it.m === cur.m);
  const canEdit = hasAny(role, CANMANAGE_OPS_ROLES);

  async function addEvent() {
    const t = evTitle.trim();
    if (!t) { notify({ kind: "error", title: "Event needs a title", text: "Give the event a title before saving it." }); return; }
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "We couldn't determine your department — please try again." }); return; }
    const { error } = await supabase.from("funding_events").insert({
      department_id: deptId,
      title: t,
      date: toISO(new Date(cur.y, cur.m, Number(fd))),
      color,
    });
    if (error) { notify({ kind: "error", title: "Couldn't add the event", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }   // keep form open on error
    setShow(false); setEvTitle(""); setColor(CATEGORY_COLORS[0]); loadItems();
  }
  async function removeEvent(id, title) {
    if (!window.confirm(`Remove “${title}” from the funding calendar?`)) return;
    const { error } = await supabase.from("funding_events").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove the event", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadItems();
  }

  return (
    <div>
      {show && canEdit && (
        <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Title</span>
            <input style={FS.input} value={evTitle} onChange={(e) => setEvTitle(e.target.value)} placeholder="e.g. Pancake breakfast at Station 20" /></label>
          <label style={{ ...S.field, minWidth: 90 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Day</span>
            <select style={FS.input} value={fd} onChange={(e) => setFd(e.target.value)}>{Array.from({ length: dim }, (_, i) => i + 1).map((d) => <option key={d}>{d}</option>)}</select></label>
          <div style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Color</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 2 }}>
              {CATEGORY_COLORS.map((col) => (
                <button key={col} title={col} onClick={() => setColor(col)}
                  style={{ width: 24, height: 24, borderRadius: 999, background: col, cursor: "pointer", border: color === col ? `3px solid ${FIRE.textPrimary}` : `2px solid ${FIRE.card}`, boxShadow: `0 0 0 1px ${FIRE.btnBorder}` }} />
              ))}
            </div>
          </div>
          <button style={FS.btnPrimary} onClick={addEvent}><Plus size={15} /> Add to {CAL_MONTHS[cur.m]}</button>
          <button style={FS.btn} onClick={() => setShow(false)}>Cancel</button>
        </div>
      )}

      <MonthCalendar
        cur={cur} setCur={setCur} dark
        items={monthItems}
        renderChip={(it) => ({ color: it.c, label: it.title, title: canEdit ? `${it.title} (tap to remove)` : it.title, onClick: canEdit ? () => removeEvent(it.id, it.title) : undefined })}
        todayColor="#9A6B12"
        monthLabel={`${CAL_MONTHS[cur.m]} ${cur.y}`}
        headerExtra={canEdit ? (
          <button style={{ border: `0.5px solid ${FIRE.btnBorder}`, background: FIRE.btnBg, borderRadius: 8, padding: "5px 8px", cursor: "pointer", color: FIRE.btnText, display: "inline-flex", alignItems: "center", marginLeft: "auto", fontSize: 12.5, fontWeight: 600, gap: 5 }} onClick={() => { setFd(Math.min(today.getDate(), dim)); setEvTitle(""); setColor(CATEGORY_COLORS[0]); setShow(true); }}><Plus size={14} /> Add an event</button>
        ) : null}
      />
      <div style={{ fontSize: 12.5, color: FIRE.textMuted, marginBottom: 18 }}>
        {monthItems.length} event{monthItems.length === 1 ? "" : "s"} in {CAL_MONTHS[cur.m]}{canEdit ? " · tap an event to remove it" : ""}.
      </div>
    </div>
  );
}
const SOURCE_COLORS = { social: "#B11E2A", training: "#1F4E79", recruit: "#0E6B62", funding: "#9A6B12", actionitem: "#6E56CF" };
const SOURCE_RANK = { training: 0, actionitem: 1, funding: 2, recruit: 3, social: 4 };   // action items rank just below Training
const SOURCE_TIER = { training: "bar", actionitem: "bar", funding: "pill", recruit: "pill", social: "dot" };
function DashboardCalendar({ S, notify, withImportanceMode }) {
  const today = new Date();
  const [cur, setCur] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("all");
  const [view, setView] = useState("grid");   // "grid" | "importance" (only surfaced when withImportanceMode)
  const { openSessionPlans, mounts } = usePlanViewer(S, notify);
  const loadAll = () => {
    Promise.all([
      supabase.from("content_calendar").select("id, date, caption"),
      supabase.from("training_sessions").select("id, date, title, audience, session_plans(id, title, storage_path, ai_text, source, created_at)"),
      supabase.from("recruitment_events").select("id, date, title"),
      supabase.from("funding_events").select("id, date, title"),
      supabase.from("action_items").select("id, text, due_date, status"),                      // 5th source (RLS: leaders only → members get [])
    ]).then(([social, training, recruit, funding, actions]) => {
      const mapRows = (res, source, labelOf, extraOf) =>
        (res.data || []).filter((r) => r.date).map((r) => {        // null data (source error) → []
          const [yy, mm, dd] = r.date.split("-").map(Number);
          return { source, id: `${source}-${r.id}`, y: yy, m: (mm || 1) - 1, d: dd, label: labelOf(r), color: SOURCE_COLORS[source], tier: SOURCE_TIER[source], ...(extraOf ? extraOf(r) : {}) };
        });
      const actionRows = (actions.data || [])
        .filter((r) => r.due_date && r.status === "open")                                        // only OPEN items WITH a due date
        .map((r) => { const [yy, mm, dd] = r.due_date.split("-").map(Number); return { source: "actionitem", id: `actionitem-${r.id}`, y: yy, m: (mm || 1) - 1, d: dd, label: r.text, color: SOURCE_COLORS.actionitem, tier: SOURCE_TIER.actionitem }; });
      setItems([
        ...mapRows(social, "social", (r) => r.caption || ""),
        ...mapRows(training, "training", (r) => r.title, (r) => ({
          title: r.title,   // SessionPlanChooser header reads session.title (chip items only have `label`)
          audience: r.audience || "everyone",
          plans: (r.session_plans || [])
            .slice().sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""))   // newest-first, matching Training's loadSessions
            .map((p) => ({ id: p.id, title: p.title, storage_path: p.storage_path, ai_text: p.ai_text, source: p.source, session_id: r.id, kind: p.storage_path ? "file" : "ai" })),
        })),
        ...mapRows(recruit, "recruit", (r) => r.title),
        ...mapRows(funding, "funding", (r) => r.title),
        ...actionRows,
      ]);
    });
  };
  useEffect(() => { loadAll(); }, []);
  const monthItems = items
    .filter((it) => it.y === cur.y && it.m === cur.m && (filter === "all" || it.source === filter))
    .sort((a, b) => SOURCE_RANK[a.source] - SOURCE_RANK[b.source]);   // training→funding→recruit→social; stable within source
  const FILTERS = [
    { label: "All", key: "all", color: "#54506B" },                       // neutral — NOT a source color
    { label: "Training", key: "training", color: SOURCE_COLORS.training }, // blue
    { label: "Action items", key: "actionitem", color: SOURCE_COLORS.actionitem }, // violet
    { label: "Recruitment", key: "recruit", color: SOURCE_COLORS.recruit }, // teal — key is "recruit"
    { label: "Funding", key: "funding", color: SOURCE_COLORS.funding },   // amber
    { label: "Social", key: "social", color: SOURCE_COLORS.social },      // red
  ];

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ ...FS.kicker, marginBottom: 0 }}><Calendar size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />STATION CALENDAR</div>
        {withImportanceMode && (
          <div style={{ marginLeft: "auto", display: "inline-flex", border: `1px solid ${FIRE.btnBorder}`, borderRadius: 8, overflow: "hidden" }}>
            {[["grid", "Grid"], ["importance", "By importance"]].map(([k, l], i) => (
              <button key={k} onClick={() => setView(k)} style={{ border: "none", borderLeft: i ? `1px solid ${FIRE.btnBorder}` : "none", background: view === k ? FIRE.red : FIRE.btnBg, color: view === k ? "#fff" : FIRE.navLabel, padding: "5px 12px", fontSize: 11.5, fontWeight: 700, cursor: "pointer" }}>{l}</button>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 10, alignItems: "center", paddingTop: 9, borderTop: `0.5px solid ${FIRE.hairline}` }}>
        <span style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".1em", color: FIRE.textMuted2, fontWeight: 700, marginRight: 4 }}>Filter</span>
        {FILTERS.map((f) => {
          const active = filter === f.key;
          return (
            <button key={f.key} onClick={() => setFilter(f.key)}
              style={{ border: `1.5px solid ${f.color}`, background: active ? f.color : FIRE.btnBg, color: active ? "#fff" : f.color, borderRadius: 999, padding: "5px 11px", fontSize: 11.5, fontWeight: 700, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5 }}>
              {f.label}
            </button>
          );
        })}
      </div>
      {withImportanceMode && view === "importance" ? (
        <div style={{ ...FS.card, padding: "8px 14px" }}>
          <div style={{ fontSize: 13.5, fontWeight: 700, color: FIRE.textPrimary, marginBottom: 6 }}>{CAL_MONTHS[cur.m]} {cur.y}</div>
          {monthItems.length === 0 ? <div style={{ fontSize: 13, color: FIRE.textMuted, padding: "8px 0" }}>No events this month.</div> :
            [["training", "Training"], ["actionitem", "Action items"], ["funding", "Funding"], ["recruit", "Recruitment"], ["social", "Social"]].map(([src, lbl]) => {   // priority order = SOURCE_RANK
              const group = monthItems.filter((it) => it.source === src).slice().sort((a, b) => a.d - b.d);   // date order within a tier
              if (!group.length) return null;
              return (
                <div key={src} style={{ padding: "6px 0", borderTop: `0.5px solid ${FIRE.hairline}` }}>
                  <div style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: SOURCE_COLORS[src], marginBottom: 3 }}>{lbl}</div>
                  {group.map((it) => (
                    <div key={it.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "3px 0" }}>
                      <span style={{ width: 7, height: 7, borderRadius: 999, background: it.color, flexShrink: 0 }} />
                      <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: FIRE.textPrimary, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{it.label}</span>
                      <span style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num, flexShrink: 0 }}>{CAL_MONTHS[it.m].slice(0, 3)} {it.d}</span>
                    </div>
                  ))}
                </div>
              );
            })}
        </div>
      ) : (
        <MonthCalendar
          cur={cur} setCur={setCur} dark
          items={monthItems}
          renderChip={(it) => { const ldr = it.source === "training" && it.audience === "leadership"; return { color: ldr ? FIRE.amberText : it.color, label: it.label, title: `${ldr ? "Leadership only · " : ""}${(it.source === "training" && (it.plans || []).length) ? `${it.label} · click to view plan` : it.label}`, ...(filter === "all" ? { tier: it.tier } : {}), ...(it.source === "training" && (it.plans || []).length ? { onClick: () => openSessionPlans(it) } : {}) }; }}
          todayColor={FIRE.red}
          monthLabel={`${CAL_MONTHS[cur.m]} ${cur.y}`}
          overflowIndicator
        />
      )}
      {mounts}
    </div>
  );
}
function Visibility({ S, brand, role, notify }) {
  const [topic, setTopic] = useState("A Tuesday-night ladder drill");
  const [ideasOpen, setIdeasOpen] = useState(false);   // Ideas for Things to Make — collapsed by default
  const [loading, setLoading] = useState(false); const [post, setPost] = useState(""); const [err, setErr] = useState("");
  async function draft() {
    setLoading(true); setErr(""); setPost("");
    const sys = "You write short, warm social media captions for a volunteer fire/EMS department to build community visibility and trust — not recruitment. Match the department's voice. Plain, genuine, under 60 words, with a tasteful hashtag or two. Never graphic content or patient information. Return only the caption.";
    try { const t = await callClaude(sys, `Post about: ${topic}\nDepartment voice: ${brand?.voice || ""}`); setPost(t); }
    catch { setErr("Couldn't draft that just now. Try again."); } finally { setLoading(false); }
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>PUBLIC RELATIONS</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Stay seen between calls</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>A simple monthly content calendar, ideas for what to make, and a hand writing the captions — 20 minutes a week.</div>
      </div>
      <div style={{ ...FS.kicker, marginBottom: 8 }}><Calendar size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />MONTHLY CONTENT CALENDAR</div>
      <ContentCalendar S={S} role={role} notify={notify} />

      <button onClick={() => setIdeasOpen((v) => !v)} style={{ ...FS.kicker, marginBottom: ideasOpen ? 8 : 16, display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>IDEAS FOR THINGS TO MAKE<span style={{ marginLeft: "auto", display: "inline-flex" }}>{ideasOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span></button>
      {ideasOpen && <IdeaGrid S={S} dark items={[
        { h: "60-second station tour", p: "Walk the bay on a phone camera. People love seeing inside." },
        { h: "Member spotlight", p: "One photo + why they serve. Faces build trust the fastest." },
        { h: "Safety tip card", p: "Smoke alarms, seasonal hazards — useful posts get shared." },
        { h: "Training night clip", p: "A short drill video shows the work most people never see." },
        { h: "Apparatus feature", p: "\u201CMeet Engine 1 — here's what it carries.\u201D" },
        { h: "Thank-you post", p: "Recognize a donor, a volunteer, or the whole community." },
      ]} />}

      <div style={{ ...S.aiBanner, ...FS.card, borderLeft: `3px solid ${FIRE.red}` }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}><Sparkles size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />AI CAPTION HELPER</div>
          <h3 style={{ ...S.featTitle, color: FIRE.textPrimary }}>Write a post for your station</h3>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>What's the post about?</span>
            <input style={FS.input} value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
          <button style={{ ...FS.btnPrimary, marginTop: 12, opacity: loading ? 0.7 : 1 }} onClick={draft} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Writing…</> : <><Sparkles size={16} /> Draft a caption</>}
          </button>
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
          {post && <RichOutput S={S} text={post} dark />}
        </div>
      </div>

      <GraphicStudio S={S} brand={brand} />

    </div>
  );
}

/* ---------------- Funding ---------------- */
const FUNDRAISER_IDEAS = [
  { title: "Pancake / community breakfast", key: "pancake", p: "Low cost, high turnout — great around a holiday." },
  { title: "Fill-the-boot drive", key: "boot", p: "Members collect at a busy corner or event. Quick and visible." },
  { title: "BBQ or chili cook-off", key: "bbq", p: "Sell plates; a local meat sponsor cuts your costs." },
  { title: "Open house / touch-a-truck", key: "open house", p: "Family day that doubles as recruitment and visibility." },
  { title: "Golf scramble", key: "golf", p: "More effort, but strong sponsor tie-ins and bigger checks." },
  { title: "Spaghetti or fish-fry dinner", key: "spaghetti", p: "Cheap to run and a reliable repeat earner." },
  { title: "Department calendar / merch", key: "calendar", p: "Member photos plus paid sponsor ad space." },
  { title: "5K or fun run", key: "5k", p: "Community-friendly; sponsors can buy per-bib or per-mile." },
  { title: "Bingo or game night", key: "bingo", p: "Recurring revenue if you can host it monthly." },
  { title: "Prize raffle", key: "raffle", p: "Strong earner — but check your state's raffle/gaming rules first." },
];
// Curated creative-fundraiser bank — Stage 3's brainstorm prompt samples from this as the AI's creative "taste."
const FUNDRAISER_IDEA_BANK = {
  "Smash & Demolition": ["Pumpkin Smash Festival","Christmas Tree Toss Competition","Plate Breaking Night","Junk Car Smash Day","TV & Electronics Smash Zone","Watermelon Catapult Challenge","Paint Balloon Demolition","Old Furniture Smash Arena","Christmas Ornament Smash","Appliance Destruction Day"],
  "Construction Challenges": ["Build-a-Birdhouse Competition","Adult Pinewood Derby","Cardboard Boat Race","Tiny House Build-Off","Firewood Stacking Championship","Pallet Furniture Contest","LEGO Masters Community Competition","Chainsaw Carving Weekend","Birdhouse Auction Festival","Community Bench Build"],
  "Night Events": ["Glow Dodgeball Tournament","Flashlight Scavenger Hunt","Moonlight Obstacle Course","Firefly Festival","Night Cornhole Championship","Campfire Storytelling Night","Outdoor Movie Under the Stars","Midnight Pancake Run","Lantern Walk","Glow Volleyball"],
  "Community Challenges": ["Amazing Race Across Town","Escape Room Weekend","Town Trivia Hunt","Mystery Dinner Investigation","Hometown Olympics","Survivor Challenge","Amazing Race for Businesses","Neighborhood Bingo Challenge","Passport Around Town Event","Time Capsule Festival"],
  "Vehicle Events": ["Antique Tractor Show","Jeep Poker Run","Side-by-Side Trail Ride","Lawnmower Grand Prix","Mini Bike Rally","Classic Truck Cruise","ATV Obstacle Challenge","Decorated Golf Cart Parade","Remote-Control Car Grand Prix","Slow Bicycle Race"],
  "Family Events": ["Teddy Bear Clinic","Build-a-Kite Festival","Backyard Campout Night","Family Olympics","Bubble Festival","Giant Board Game Day","Giant Slip-and-Slide Day","Kids Construction Zone","Stuffed Animal Sleepover","Community Talent Show"],
  "Seasonal Events": ["Snowball Festival (artificial if needed)","Ice Cream Crawl","Sunflower Festival","Fall Hay Maze","Pumpkin Catapult","Easter Egg Glow Hunt","Christmas Window Decorating Contest","Holiday Porch Tour","Community Snowman Contest","Scarecrow Building Weekend"],
  "Competition Events": ["Corn Shucking Championship","Water Balloon Catapult Competition","Tug-of-War Tournament","Beard Competition","Chili Pepper Eating Contest","Ultimate Relay Race","Backyard BBQ Championship","Hot Wing Challenge","Paper Airplane Championship","Puzzle Competition"],
  "Creative Events": ["Community Art Battle","Sidewalk Chalk Festival","Outdoor Painting Competition","Photography Scavenger Hunt","Chalk Mural Weekend","Community Quilt Project","Scrap Metal Art Competition","Ice Sculpture Weekend","Community Mural Painting","Flower Arrangement Showdown"],
  "Totally Different": ["Rent-a-Firefighter Day (non-emergency community service)","Community Tool Lending Membership","Mystery Box Auction","Reverse Raffle Adventure Night","Sponsor a Firefighter Calendar","Adopt-a-Hydrant Program","Hidden Golden Ticket Weekend","Community Bucket List Challenge","Local Business Passport Challenge","Hero for a Day Experience (ride-along/station experience where compliant with local policy)"]
};
// Sample 2-3 ideas from each bank category (random per call) to seed the brainstorm's creative "taste."
function sampleIdeaBank() {
  const out = [];
  for (const cat of Object.keys(FUNDRAISER_IDEA_BANK)) {
    const pool = [...FUNDRAISER_IDEA_BANK[cat]].sort(() => Math.random() - 0.5);
    out.push(...pool.slice(0, 2 + Math.floor(Math.random() * 2)));   // 2 or 3 per category
  }
  return out;
}
// Parse the brainstorm response into [{name, pitch}] — strips ``` fences / stray prose; null on failure.
function parseIdeas(raw) {
  if (!raw) return null;
  let s = String(raw).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const arr = s.match(/\[[\s\S]*\]/);   // grab the first [...] if the model added prose around it
  if (arr) s = arr[0];
  try {
    const parsed = JSON.parse(s);
    if (Array.isArray(parsed) && parsed.length && parsed.every((x) => x && typeof x.name === "string" && x.name.trim() && typeof x.pitch === "string" && x.pitch.trim())) return parsed;
  } catch { /* fall through to null */ }
  return null;
}
// Parse the operationalize response into { action_items:[{task,suggested_owner,suggested_due_date}], calendar_events:[{title,date}] }.
// Same robust fence-strip → JSON.parse (with {…} fallback) → per-item sanitize → never-throw as parseActionItems; null ONLY on parse failure.
function parsePlanWork(raw) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const t = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
  let parsed = null;
  try { parsed = JSON.parse(t); }
  catch {
    const m = t.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }
  }
  if (!parsed || typeof parsed !== "object") return null;
  const str = (v) => (typeof v === "string" && v.trim()) ? v.trim() : null;
  const validDate = (v) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) ? v.trim() : null;
  const action_items = [];
  for (const it of (Array.isArray(parsed.action_items) ? parsed.action_items : [])) {
    if (!it || typeof it !== "object") continue;
    const task = typeof it.task === "string" ? it.task.trim() : "";
    if (!task) continue;                                              // action items need a non-empty task
    action_items.push({ task, suggested_owner: str(it.suggested_owner), suggested_due_date: str(it.suggested_due_date) });
  }
  const calendar_events = [];
  for (const ev of (Array.isArray(parsed.calendar_events) ? parsed.calendar_events : [])) {
    if (!ev || typeof ev !== "object") continue;
    const title = typeof ev.title === "string" ? ev.title.trim() : "";
    const date = validDate(ev.date);
    if (!title || !date) continue;                                    // calendar events need a non-empty title AND a valid YYYY-MM-DD
    calendar_events.push({ title, date });
  }
  return { action_items, calendar_events };                            // both [] is valid; null only on parse failure
}
// The full "Plan a fundraiser" system prompt — reused by generate() (CTA/letter path keeps its own) and buildPlan() (step 2 of the two-step flow).
const PLAN_SYS = "You help a volunteer fire/EMS department plan a fundraiser. Given their event idea, return a practical, plain-text plan a small volunteer crew can actually run: a one-line goal, a simple timeline/checklist, the roles/volunteers needed, a few promotion steps, and a realistic money target for a small town. CRITICAL — the timeline/checklist MUST start from today's date (given in the details) and fit inside the actual window between today and the target date: do NOT schedule any task in the past or before today, and compress the schedule to the real time available — if only a few weeks or months remain until the event, plan for that window, not a full year.\n\nThen the most important part — an in-depth 'Sponsorship Packages' section tailored to THIS specific event:\n1) Three or four headline tiers (such as Title/Presenting, Gold, Silver, Bronze), each with a suggested dollar amount and exactly what that sponsor gets (logo placement, banner, event shirt, program, PA shout-outs, social posts, top billing).\n2) An 'A la carte sponsorships' list of individual items that fit THIS event, each with a suggested price and what the sponsor gets. Pick the ones that make sense for the event from options like: event title, booth/vendor space, printed banner, PA/radio announcements, beverage/drink station, food/meal, dessert, coffee & water station, event t-shirt, swag bag, photo booth, kids' zone/bounce house, trophy/award, hole sponsor (for golf), raffle prize, parking, tent/shade, fire apparatus display, social media shout-out, live stream, yard signs, program ad, and in-kind goods/services. Aim for 8-12 relevant items.\n3) One short, ready-to-send outreach line the department can text or email to a local business.\n\nKeep dollar amounts realistic for a small community. Use clear short headings and simple dash bullet lines (no markdown symbols like # or *). Aim for 450-650 words.";
function Funding({ S, role, notify, dept, meId, members }) {
  const [mode, setMode] = useState("Plan a fundraiser");
  const [ideasOpen, setIdeasOpen] = useState(false);   // Event Ideas collapsed by default
  const [plannerOpen, setPlannerOpen] = useState(true);   // Fundraiser Planner — expanded by default
  const [detail, setDetail] = useState("A pancake breakfast to raise money for new turnout gear.");
  const [goalAmt, setGoalAmt] = useState(""); const [communityType, setCommunityType] = useState("Small town"); const [effortLevel, setEffortLevel] = useState("Medium"); const [targetDate, setTargetDate] = useState("");   // Plan-a-fundraiser inputs
  const [phase, setPhase] = useState("input"); const [ideas, setIdeas] = useState([]); const [chosenIdea, setChosenIdea] = useState(null); const [loadingLabel, setLoadingLabel] = useState("Working…"); const [rawIdeas, setRawIdeas] = useState("");   // two-step brainstorm→plan flow (Plan mode only)
  const [planReview, setPlanReview] = useState(null); const [operationalizing, setOperationalizing] = useState(false);   // Build 2: { sourceLabel, actionItems[], calendarEvents[] } — operationalize the plan into tracked work
  const [addingToApp, setAddingToApp] = useState(false); const [fundingReloadKey, setFundingReloadKey] = useState(0);   // Stage 3: dual-insert loading + a key that remounts FundingCalendar so newly-inserted events show
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const canManage = hasAny(role, CANMANAGE_OPS_ROLES);   // ai_outputs write — ops only (DA/Officer, excludes Board + PA; Board can still VIEW Funding)
  const [saving, setSaving] = useState(false); const [saveTitle, setSaveTitle] = useState("");
  const [drafts, setDrafts] = useState([]); const [openDraft, setOpenDraft] = useState(null);
  const [editing, setEditing] = useState(false); const [editBuf, setEditBuf] = useState(""); const [savingEdit, setSavingEdit] = useState(false);
  const [log, setLog] = useState([]);
  const [addingLog, setAddingLog] = useState(false);
  const [ln, setLn] = useState(""); const [ld, setLd] = useState(""); const [la, setLa] = useState("");
  const totalRaised = log.reduce((s, e) => s + (e.amount || 0), 0);
  const recentFor = (idea) => log.find((e) => e.name.toLowerCase().includes(idea.key) || idea.title.toLowerCase().includes(e.name.toLowerCase().split(" ")[0]));
  function planThis(idea) { setMode("Plan a fundraiser"); setDetail(`A ${idea.title.toLowerCase()} to raise money for the department.`); setOut(""); if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" }); }
  const loadFundraiserLog = () => {
    supabase.from("fundraiser_log")
      .select("id, name, event_when, amount, created_by")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error || !data) return;
        setLog(data.map((e) => ({ id: e.id, name: e.name, date: e.event_when, amount: Number(e.amount) })));
      });
  };
  useEffect(() => { loadFundraiserLog(); }, []);
  async function addLog() {
    if (!ln.trim()) return;
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "Please try again.", details: deptErr?.message }); return; }
    const { error } = await supabase.from("fundraiser_log").insert({ name: ln.trim(), event_when: ld.trim() || "Recent", amount: Number(String(la).replace(/[^0-9.]/g, "")) || 0, department_id: deptId, created_by: meId });
    if (error) { notify({ kind: "error", title: "Couldn't log that fundraiser", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setLn(""); setLd(""); setLa(""); setAddingLog(false); loadFundraiserLog();
  }
  async function removeLog(id) {
    const { error } = await supabase.from("fundraiser_log").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove that", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadFundraiserLog();   // refetch — UI matches true DB state (covers the silent zero-rows case)
  }
  async function brainstorm() {
    setLoading(true); setLoadingLabel("Brainstorming ideas…"); setErr(""); setRawIdeas(""); setIdeas([]); setOut("");
    const sampled = sampleIdeaBank().join(", ");
    const recent = log.slice(0, 12).map((e) => `${e.name}${e.date ? ` (${e.date})` : ""}`).join("; ") || "none yet";
    const brainstormSys = `You help volunteer fire departments brainstorm fundraisers. Given their goal, community type, effort level, and cause, propose EXACTLY 6 ideas spanning a range: ~2 proven/reliable, ~2 fresh, ~2 bold/creative. Reach for memorable, community-scale, VFD-appropriate ideas. Use these examples ONLY as creative inspiration and ADAPT them to this department's specific goal, community type, and effort level — don't just repeat them verbatim: ${sampled}. AVOID anything they ran recently: ${recent}. Return ONLY a valid JSON array of 6 objects: {"name": string, "pitch": one punchy sentence}. No text outside the JSON.`;
    const userContent = `Goal amount: ${goalAmt || "not specified"}\nCommunity type: ${communityType}\nEffort level: ${effortLevel}\nTarget date: ${targetDate || "flexible"}\nWhat they're raising for: ${detail || "general department needs"}`;
    try {
      const raw = await callClaude(brainstormSys, userContent);
      const parsed = parseIdeas(raw);
      if (!parsed) { setRawIdeas(raw); setErr("The idea list came back in an unexpected format — showing the raw response below. Tap “Get ideas” to try again."); setLoading(false); return; }
      setIdeas(parsed); setPhase("ideas");
    } catch { setErr("Couldn't brainstorm ideas just now. Try again."); }
    finally { setLoading(false); }
  }
  async function chooseIdea(idea) {
    setChosenIdea(idea); setErr(""); setPhase("plan");
    await buildPlan(idea);
  }
  async function buildPlan(idea) {
    setLoading(true); setLoadingLabel("Building the plan…"); setErr(""); setOut("");
    const planUser = `Department: ${dept?.name || "our department"}. Chosen fundraiser: ${idea.name} — ${idea.pitch}. Goal: ${goalAmt || "not specified"}. Community: ${communityType}. Effort: ${effortLevel}. Today's date: ${new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' })}. Target date: ${targetDate || "flexible"}. Raising for: ${detail || "general department needs"}.`;
    try {
      const t = await callClaude(PLAN_SYS, planUser);   // step 2: stateless call carries the chosen idea + all context forward
      setOut(t); setSaveTitle(idea.name.slice(0, 60));
    } catch { setErr("Couldn't build the plan just now. Try again."); }
    finally { setLoading(false); }
  }
  function backToIdeas() { setPhase("ideas"); setOut(""); setErr(""); }
  function startOver() {
    setPhase("input"); setIdeas([]); setChosenIdea(null); setRawIdeas(""); setOut(""); setErr(""); setPlanReview(null);
  }
  // cloned from Minutes: a suggested owner NAME → member id (exact match, then single-token), else "" (unassigned).
  function matchOwnerId(name) {
    const n = (name || "").trim().toLowerCase();
    if (!n) return "";
    const exact = members.filter((m) => isAssignable(m) && (m.name || "").toLowerCase() === n);
    if (exact.length === 1) return exact[0].id;
    const tok = members.filter((m) => isAssignable(m) && (m.name || "").toLowerCase().split(/\s+/).includes(n));
    if (tok.length === 1) return tok[0].id;
    return "";
  }
  const normalizeDate = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim())) ? s.trim() : "";   // only a clean YYYY-MM-DD pre-fills a date picker
  async function extractPlanWork() {
    if (!out.trim()) return;
    setOperationalizing(true); setErr("");
    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const sys = "You convert a volunteer fire department's fundraiser plan into trackable work: a list of action items and a list of calendar events. Respond with ONLY one valid JSON object, no markdown, no code fences, no commentary before or after. Schema: {\"action_items\":[{\"task\":string,\"suggested_owner\":string|null,\"suggested_due_date\":\"YYYY-MM-DD\"|null}],\"calendar_events\":[{\"title\":string,\"date\":\"YYYY-MM-DD\"}]}.\n\nDATES: You are given today's date and the event's target date. Resolve EVERY relative timing in the plan (for example '~3 weeks before the event', 'the week of', 'two months out', 'day of') into a real YYYY-MM-DD that falls on or between today and the target date. Never output a date before today or after the target date. RULE: sponsor outreach and sponsor confirmation must land 3-4 weeks BEFORE the target date. The fundraiser event itself is a calendar_event on the target date; also add calendar_events for the major milestones (kickoff, sponsor deadline, setup/day-before) with real dates. calendar_events must be ONLY the 3-5 most important dates (the event itself plus key milestones), NOT one per task — the detailed to-dos belong in action_items, not on the calendar.\n\n- action_items.task: the concrete task, stated concisely.\n- suggested_owner: a person's name ONLY if the plan explicitly names who is responsible; otherwise null. Do NOT guess or infer an owner.\n- suggested_due_date: a real YYYY-MM-DD (resolved as above) for when the task should be done; use null only if it genuinely cannot be placed.\n\nCRITICAL — TRUTH GUARDRAIL: These become REAL assigned work and REAL calendar entries. NEVER invent an owner the plan did not name — leave suggested_owner null for a human to fill in. Do not fabricate tasks or events that are not in the plan. It is always better to leave an owner or date null than to guess. Return ONLY the JSON object.";
    const user = `Today's date: ${today}. Target date: ${targetDate || "flexible"}.\n\nFundraiser plan:\n${out}`;
    try {
      const raw = await callClaude(sys, user);
      const parsed = parsePlanWork(raw);
      if (!parsed) {   // fallback: land in the review with empty lists so they can add manually (mirrors minutes)
        setPlanReview({ sourceLabel: `Fundraiser: ${chosenIdea?.name || "plan"}`, actionItems: [], calendarEvents: [] });
        setErr("Auto-extraction didn't work — add the tasks and events manually below.");
        setPhase("operationalize"); setOperationalizing(false); return;
      }
      setPlanReview({
        sourceLabel: `Fundraiser: ${chosenIdea?.name || "plan"}`,   // stored on both tables as source_label in Stage 3
        actionItems: parsed.action_items.map((it, i) => ({ id: Date.now() + i, task: it.task, ownerId: matchOwnerId(it.suggested_owner), due: normalizeDate(it.suggested_due_date), keep: true })),
        calendarEvents: parsed.calendar_events.map((ev, i) => ({ id: Date.now() + 5000 + i, title: ev.title, date: normalizeDate(ev.date), keep: true })),
      });
      setPhase("operationalize");
    } catch { setErr("Couldn't turn the plan into tracked work just now. Try again."); }
    finally { setOperationalizing(false); }
  }
  async function addToApp() {
    if (!planReview) return;
    const src = planReview.sourceLabel;
    const validDate = (d) => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d);
    const items = planReview.actionItems.filter((r) => r.keep && r.task.trim());
    const events = planReview.calendarEvents.filter((r) => r.keep && r.title.trim() && validDate(r.date));
    if (!items.length && !events.length) { notify({ kind: "error", title: "Nothing to add", text: "Keep at least one action item or calendar event first." }); return; }
    setAddingToApp(true); setErr("");
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { setAddingToApp(false); notify({ kind: "error", title: "Couldn't find your department", text: "Please try again.", details: deptErr?.message }); return; }
    let itemsErr = null, eventsErr = null;
    if (items.length) {
      const rows = items.map((r) => ({ department_id: deptId, text: r.task.trim(), assigned_to: r.ownerId || null, due_date: r.due || null, source_label: src }));
      const { error } = await supabase.from("action_items").insert(rows);
      itemsErr = error || null;
    }
    if (events.length) {
      const rows = events.map((r) => ({ department_id: deptId, title: r.title.trim(), date: r.date, color: CATEGORY_COLORS[3], source_label: src }));   // CATEGORY_COLORS[3] = funding gold (#9A6B12)
      const { error } = await supabase.from("funding_events").insert(rows);
      eventsErr = error || null;
    }
    if (events.length && !eventsErr) setFundingReloadKey((k) => k + 1);   // remount FundingCalendar so the new events show
    setAddingToApp(false);
    if (!itemsErr && !eventsErr) {
      notify({ kind: "success", text: `Added ${items.length} task${items.length === 1 ? "" : "s"} and ${events.length} event${events.length === 1 ? "" : "s"}.` });
      setPlanReview(null); setErr(""); setPhase("plan");
      return;
    }
    // Partial/total failure — never silently half-succeed. Clear whatever DID save so a retry can't duplicate it.
    if (!itemsErr && eventsErr) { notify({ kind: "error", title: "Tasks added — calendar events didn't", text: `${items.length} action item(s) created, but the ${events.length} calendar event(s) failed. Fix and retry the events.`, details: eventsErr.message }); setPlanReview((p) => ({ ...p, actionItems: [] })); }
    else if (itemsErr && !eventsErr) { notify({ kind: "error", title: "Events added — tasks didn't", text: `${events.length} calendar event(s) created, but the ${items.length} action item(s) failed. Fix and retry the tasks.`, details: itemsErr.message }); setPlanReview((p) => ({ ...p, calendarEvents: [] })); }
    else { notify({ kind: "error", title: "Couldn't add to the app", text: "Neither the tasks nor the calendar events could be saved. Please try again.", details: (itemsErr || eventsErr)?.message }); }
  }
  async function generate() {
    setLoading(true); setErr(""); setOut("");
    let sys;
    if (mode === "Plan a fundraiser") sys = PLAN_SYS;
    else if (mode === "Community call-to-action") sys = "You write a short, warm community call-to-action for a volunteer fire/EMS department's fundraiser — for social or a flyer. Lead with purpose, make the ask clear, tie dollars to a concrete outcome. Under 90 words. Return only the text.";
    else sys = "You format a clear, warm donation-request letter for a volunteer fire/EMS department to send to a local business or community member. Proper letter structure, a specific ask, dollars tied to outcomes, gracious close. Use [BRACKETED] placeholders for names and amounts. Under 250 words.";
    try { const t = await callClaude(sys, `Department: ${dept?.name || "our department"}\nDetails: ${detail}`); setOut(t); setSaveTitle(detail.trim().slice(0, 60) || `${mode} · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`); }
    catch { setErr("Couldn't generate that just now. Try again."); } finally { setLoading(false); }
  }
  async function saveDraft() {
    if (!out || !saveTitle.trim()) return;
    setSaving(true);
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { setSaving(false); notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
    const { error } = await supabase.from("ai_outputs").insert({ department_id: deptId, feature: "fundraiser", title: saveTitle.trim(), ai_text: out, created_by: meId });
    setSaving(false);
    if (error) { notify({ kind: "error", title: "Couldn't save the draft", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: "Draft saved." });
    loadDrafts();
  }
  async function loadDrafts() {
    const { data } = await supabase.from("ai_outputs").select("*").eq("feature", "fundraiser").is("deleted_at", null);   // dept-scoped by RLS; hide soft-deleted
    setDrafts((data || []).sort((a, b) => (b.edited_at || b.created_at).localeCompare(a.edited_at || a.created_at)));   // coalesce(edited_at, created_at) desc
  }
  useEffect(() => { loadDrafts(); }, []);
  function closeDraft() { setOpenDraft(null); setEditing(false); setEditBuf(""); }       // backdrop / X
  function reopen(d) { setEditing(false); setEditBuf(""); setOpenDraft(d); }             // list Open — clear stale edit first
  function startEdit() { setEditBuf(openDraft.current_text ?? openDraft.ai_text ?? ""); setEditing(true); }
  async function saveEdit() {
    if (!editBuf.trim()) return;
    setSavingEdit(true);
    const { data, error } = await supabase.from("ai_outputs")
      .update({ current_text: editBuf, edited_by: meId, edited_at: new Date().toISOString() })   // ai_text left pristine
      .eq("id", openDraft.id).select().single();
    setSavingEdit(false);
    if (error) { notify({ kind: "error", title: "Couldn't save your edit", text: "Something went wrong saving your changes. Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: "Changes saved." });
    setOpenDraft(data); setEditing(false); setEditBuf(""); loadDrafts();                 // modal live-updates + list marker lights up
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>FUNDING</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Plan fundraisers, write the appeals, line up sponsors</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Ideas to run, a hand to plan and write the asks, sponsor packages — and a log of what you've run recently so you're not repeating yourself by accident.</div>
      </div>

      <div style={{ ...S.aiBanner, ...FS.card, borderLeft: `3px solid ${FIRE.red}` }}>
        <div style={{ flex: 1 }}>
          <button onClick={() => setPlannerOpen((v) => !v)} style={{ ...FS.kicker, marginBottom: plannerOpen ? 8 : 0, display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}><PartyPopper size={13} style={{ verticalAlign: "-2px" }} />FUNDRAISER PLANNER<span style={{ marginLeft: "auto", display: "inline-flex" }}>{plannerOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span></button>
          {plannerOpen && (<>
          <div style={S.segRow}>
            {["Plan a fundraiser", "Community call-to-action", "Format a letter"].map((m) => (
              <button key={m} onClick={() => { setMode(m); setOut(""); setPhase("input"); setIdeas([]); setChosenIdea(null); setRawIdeas(""); setErr(""); }} style={{ ...S.segBtn, background: mode === m ? FIRE.btnBg : "transparent", borderColor: mode === m ? FIRE.red : FIRE.btnBorder, color: mode === m ? FIRE.textPrimary : FIRE.navLabel }}>{m}</button>
            ))}
          </div>
          {phase === "input" && (<>
            <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Tell us about it</span>
              <textarea style={{ ...FS.input, minHeight: 60, resize: "vertical" }} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
            {mode === "Plan a fundraiser" && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginTop: 10 }}>
                <label style={{ ...S.field, minWidth: 120 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Goal amount</span><input style={FS.input} value={goalAmt} onChange={(e) => setGoalAmt(e.target.value)} placeholder="$5,000" /></label>
                <label style={{ ...S.field, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Community type</span><select style={FS.input} value={communityType} onChange={(e) => setCommunityType(e.target.value)}><option>Rural</option><option>Small town</option><option>Suburban</option></select></label>
                <label style={{ ...S.field, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Effort level</span><select style={FS.input} value={effortLevel} onChange={(e) => setEffortLevel(e.target.value)}><option>Quick &amp; easy</option><option>Medium</option><option>Big event</option></select></label>
                <label style={{ ...S.field, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Target date <span style={{ color: FIRE.textMuted, fontWeight: 400 }}>(roughly when?)</span></span><input type="date" style={FS.input} value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></label>
              </div>
            )}
            <button style={{ ...FS.btnPrimary, marginTop: 12, opacity: loading ? 0.7 : 1 }} onClick={mode === "Plan a fundraiser" ? brainstorm : generate} disabled={loading}>
              {loading ? <><Loader2 size={16} className="spin" /> {loadingLabel}</> : <><Sparkles size={16} /> {mode === "Plan a fundraiser" ? "Get ideas" : "Generate"}</>}
            </button>
            {rawIdeas && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.textSecondary, whiteSpace: "pre-wrap", fontFamily: "'IBM Plex Mono', ui-monospace, monospace", fontSize: 11.5, maxHeight: 180, overflowY: "auto" }}>{rawIdeas}</div>}
          </>)}
          {mode === "Plan a fundraiser" && phase === "ideas" && (<>
            <p style={{ ...S.helpP, color: FIRE.textMuted }}>Six ideas across proven, fresh, and bold. Pick one to build a full plan — or start over to change your inputs.</p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 8 }}>
              {ideas.map((idea, i) => (
                <div key={i} style={{ ...FS.card, padding: "10px 12px", display: "flex", flexDirection: "column" }}>
                  <div style={{ fontSize: 13, fontWeight: 600, color: FIRE.textPrimary, lineHeight: 1.25 }}>{idea.name}</div>
                  <div style={{ fontSize: 11.5, color: FIRE.textSecondary, marginTop: 4, flex: 1, lineHeight: 1.35 }}>{idea.pitch}</div>
                  <button style={{ ...FS.btn, marginTop: 8, padding: "5px 9px", fontSize: 11.5, width: "100%", justifyContent: "center" }} onClick={() => chooseIdea(idea)}><Sparkles size={13} /> Build the plan</button>
                </div>
              ))}
            </div>
            <button style={{ ...FS.btn, marginTop: 10 }} onClick={startOver}><ArrowLeft size={14} /> Start over</button>
          </>)}
          {mode === "Plan a fundraiser" && phase === "plan" && (
            <div style={{ fontSize: 13, color: FIRE.textSecondary, marginBottom: 8 }}>
              Building: <b style={{ color: FIRE.textPrimary }}>{chosenIdea?.name}</b>
              {loading && <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 10, color: FIRE.textMuted }}><Loader2 size={14} className="spin" /> {loadingLabel}</span>}
            </div>
          )}
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
          {out && <RichOutput S={S} text={out} dark />}
          {out && canManage && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
              <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Save as</span><input style={FS.input} value={saveTitle} onChange={(e) => setSaveTitle(e.target.value)} placeholder="Draft title" /></label>
              <button style={{ ...FS.btn, opacity: (saving || !saveTitle.trim()) ? 0.6 : 1 }} onClick={saveDraft} disabled={saving || !saveTitle.trim()}>{saving ? <><Loader2 size={16} className="spin" /> Saving…</> : <><FileText size={16} /> Save draft</>}</button>
            </div>
          )}
          {mode === "Plan a fundraiser" && phase === "plan" && (
            <div style={{ display: "flex", gap: 8, marginTop: 12, flexWrap: "wrap" }}>
              {out && canManage && <button style={{ ...FS.btnPrimary, opacity: operationalizing ? 0.7 : 1 }} onClick={extractPlanWork} disabled={operationalizing}>{operationalizing ? <><Loader2 size={16} className="spin" /> Turning the plan into tracked work…</> : <><ClipboardList size={16} /> Turn this plan into tasks &amp; calendar</>}</button>}
              {!loading && err && <button style={FS.btn} onClick={() => buildPlan(chosenIdea)}><Sparkles size={15} /> Rebuild plan</button>}
              <button style={FS.btn} onClick={backToIdeas}><ArrowLeft size={14} /> Back to ideas</button>
              <button style={FS.btn} onClick={startOver}>Start over</button>
            </div>
          )}
          {mode === "Plan a fundraiser" && phase === "operationalize" && planReview && (
            <div style={{ ...FS.card, padding: "12px 16px", marginTop: 12, borderLeft: `3px solid ${FIRE.amberText}` }}>
              <div style={{ ...FS.kicker, marginBottom: 3 }}>REVIEW &amp; CONFIRM — turn the plan into tracked work</div>
              <div style={{ fontSize: 12.5, color: FIRE.textMuted, marginBottom: 12 }}>From: <b style={{ color: FIRE.textSecondary }}>{planReview.sourceLabel}</b></div>

              <div style={{ ...FS.kicker, fontSize: 11, marginBottom: 4 }}>ACTION ITEMS</div>
              {planReview.actionItems.map((r, i) => (
                <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", padding: "8px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
                  <input type="checkbox" checked={r.keep} onChange={(e) => setPlanReview((p) => ({ ...p, actionItems: p.actionItems.map((x, j) => j === i ? { ...x, keep: e.target.checked } : x) }))} title="Include this item" style={{ marginBottom: 10 }} />
                  <label style={{ ...S.field, flex: 1, minWidth: 200 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Task</span><input style={FS.input} value={r.task} onChange={(e) => setPlanReview((p) => ({ ...p, actionItems: p.actionItems.map((x, j) => j === i ? { ...x, task: e.target.value } : x) }))} /></label>
                  <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Owner</span>
                    <select style={FS.input} value={r.ownerId} onChange={(e) => setPlanReview((p) => ({ ...p, actionItems: p.actionItems.map((x, j) => j === i ? { ...x, ownerId: e.target.value } : x) }))}>
                      <option value="">Unassigned</option>
                      {members.filter(isAssignable).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select></label>
                  <label style={{ ...S.field, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Due</span><input type="date" style={FS.input} value={r.due} onChange={(e) => setPlanReview((p) => ({ ...p, actionItems: p.actionItems.map((x, j) => j === i ? { ...x, due: e.target.value } : x) }))} /></label>
                </div>
              ))}
              <button style={{ ...FS.btn, marginTop: 8 }} onClick={() => setPlanReview((p) => ({ ...p, actionItems: [...p.actionItems, { id: Date.now(), task: "", ownerId: "", due: "", keep: true }] }))}><Plus size={14} /> Add action item</button>

              <div style={{ ...FS.kicker, fontSize: 11, margin: "16px 0 4px" }}>CALENDAR EVENTS</div>
              {planReview.calendarEvents.map((r, i) => (
                <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", padding: "8px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
                  <input type="checkbox" checked={r.keep} onChange={(e) => setPlanReview((p) => ({ ...p, calendarEvents: p.calendarEvents.map((x, j) => j === i ? { ...x, keep: e.target.checked } : x) }))} title="Include this event" style={{ marginBottom: 10 }} />
                  <label style={{ ...S.field, flex: 1, minWidth: 200 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Event</span><input style={FS.input} value={r.title} onChange={(e) => setPlanReview((p) => ({ ...p, calendarEvents: p.calendarEvents.map((x, j) => j === i ? { ...x, title: e.target.value } : x) }))} /></label>
                  <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Date</span><input type="date" style={FS.input} value={r.date} onChange={(e) => setPlanReview((p) => ({ ...p, calendarEvents: p.calendarEvents.map((x, j) => j === i ? { ...x, date: e.target.value } : x) }))} /></label>
                </div>
              ))}
              <button style={{ ...FS.btn, marginTop: 8 }} onClick={() => setPlanReview((p) => ({ ...p, calendarEvents: [...p.calendarEvents, { id: Date.now(), title: "", date: "", keep: true }] }))}><Plus size={14} /> Add event</button>

              <div style={{ display: "flex", gap: 8, marginTop: 16, flexWrap: "wrap" }}>
                <button style={{ ...FS.btnPrimary, opacity: addingToApp ? 0.7 : 1 }} onClick={addToApp} disabled={addingToApp}>{addingToApp ? <><Loader2 size={16} className="spin" /> Adding…</> : <><ClipboardList size={16} /> Add to the app</>}</button>
                <button style={FS.btn} onClick={() => setPhase("plan")}><ArrowLeft size={14} /> Back to plan</button>
                <button style={FS.btn} onClick={() => { setPlanReview(null); setPhase("plan"); }}>Discard</button>
              </div>
            </div>
          )}
        </>)}
        </div>
      </div>

      <button onClick={() => setIdeasOpen((v) => !v)} style={{ ...FS.kicker, marginBottom: ideasOpen ? 8 : 16, display: "flex", alignItems: "center", gap: 6, width: "100%", background: "none", border: "none", padding: 0, cursor: "pointer", textAlign: "left" }}>
        <PartyPopper size={13} style={{ verticalAlign: "-2px" }} />EVENT IDEAS ({FUNDRAISER_IDEAS.length})
        <span style={{ marginLeft: "auto", display: "inline-flex" }}>{ideasOpen ? <ChevronUp size={14} /> : <ChevronDown size={14} />}</span>
      </button>
      {ideasOpen && (<>
        <p style={{ ...S.helpP, color: FIRE.textMuted }}>Tap “Plan this” to load an idea into the planner above. Anything you’ve run lately is flagged so you can mix it up — or repeat it on purpose.</p>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8, marginBottom: 22 }}>
          {FUNDRAISER_IDEAS.map((idea) => {
            const recent = recentFor(idea);
            return (
              <div key={idea.title} style={{ ...FS.card, padding: "10px 12px" }}>
                <div style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                  <div style={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 600, color: FIRE.textPrimary, lineHeight: 1.25 }}>{idea.title}</div>
                  {recent && <Pill S={S} color={FIRE.amberText}>DONE {recent.date}</Pill>}
                </div>
                <div style={{ fontSize: 11.5, color: FIRE.textSecondary, marginTop: 4, lineHeight: 1.3 }}>{idea.p}</div>
                <button style={{ ...FS.btn, marginTop: 8, padding: "5px 9px", fontSize: 11.5, width: "100%", justifyContent: "center" }} onClick={() => planThis(idea)}><Sparkles size={13} /> Plan this</button>
              </div>
            );
          })}
        </div>
      </>)}

      <div style={{ ...FS.kicker, marginBottom: 8 }}><Calendar size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />FUNDING CALENDAR</div>
      <FundingCalendar key={fundingReloadKey} S={S} role={role} notify={notify} />

      <div style={{ ...FS.kicker, marginBottom: 8, display: "flex", alignItems: "center" }}>
        <DollarSign size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />RECENT FUNDRAISERS
        {totalRaised > 0 && <span style={{ marginLeft: "auto", fontWeight: 700, color: FIRE.greenText, fontSize: 12 }}>${totalRaised.toLocaleString()} raised</span>}
      </div>
      <p style={{ ...S.helpP, color: FIRE.textMuted }}>What you’ve run lately and what it brought in. Log each event so the ideas above know what to flag.</p>
      {addingLog ? (
        <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...S.field, flex: 1, minWidth: 160 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Event</span><input style={FS.input} value={ln} placeholder="e.g. Chili Cook-Off" onChange={(e) => setLn(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 120 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>When</span><input style={FS.input} value={ld} placeholder="e.g. Jun 2026" onChange={(e) => setLd(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 120 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Raised ($)</span><input style={FS.input} value={la} placeholder="e.g. 1500" onChange={(e) => setLa(e.target.value)} /></label>
          <button style={FS.btnPrimary} onClick={addLog}><Plus size={15} /> Log it</button>
          <button style={FS.btn} onClick={() => setAddingLog(false)}>Cancel</button>
        </div>
      ) : <button style={{ ...FS.btn, marginBottom: 12 }} onClick={() => setAddingLog(true)}><Plus size={15} /> Log a fundraiser</button>}
      <div style={{ marginBottom: 6 }}>
        {log.length === 0 ? <div style={{ ...S.opCard, ...FS.card, fontSize: 13, color: FIRE.textMuted }}>Nothing logged yet. Add a fundraiser to start tracking.</div> :
          log.map((e) => (
            <div key={e.id} style={{ ...S.certRow, borderBottom: `0.5px solid ${FIRE.hairline}` }}>
              <PartyPopper size={15} color={FIRE.amberText} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{e.name}</span>
                <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 1 }}>{e.date}</div>
              </div>
              {e.amount > 0 && <span style={{ fontWeight: 700, color: FIRE.greenText, fontSize: 13.5 }}>${e.amount.toLocaleString()}</span>}
              <button title="Remove" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => removeLog(e.id)}><X size={14} color={FIRE.deleteRed} /></button>
            </div>
          ))}
      </div>

      <div style={{ ...FS.kicker, marginBottom: 8, marginTop: 22 }}><FileText size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />SAVED DRAFTS</div>
      <div style={{ ...FS.card, padding: "4px 16px", marginBottom: 22 }}>
        {drafts.length === 0 ? <div style={{ fontSize: 13, color: FIRE.textMuted, padding: "10px 0" }}>No saved drafts yet.</div> : drafts.map((d) => {
          const cName = members.find((m) => m.id === d.created_by)?.name || "Unknown";
          const eName = d.edited_by ? (members.find((m) => m.id === d.edited_by)?.name || "Unknown") : null;
          const when = new Date(d.edited_at || d.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary }}>{d.title || "Untitled draft"}</div>
                <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num }}>{cName} · {when}{eName ? ` · edited by ${eName}` : ""}</div>
              </div>
              <button style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }} onClick={() => reopen(d)}>Open</button>
            </div>
          );
        })}
      </div>
      {openDraft && (
        <div onClick={closeDraft} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...FS.card, maxWidth: 720, width: "100%", padding: "18px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ ...FS.kicker, marginBottom: 0 }}>{openDraft.title || "Draft"}</div>
              <div style={{ display: "flex", gap: 8 }}>
                {canManage && !editing && <button style={{ ...FS.btn, padding: "6px 10px" }} onClick={startEdit}><Pencil size={14} color={FIRE.btnIcon} /> Edit</button>}
                <button style={{ ...FS.btn, padding: "6px 10px" }} onClick={closeDraft}><X size={14} color={FIRE.btnIcon} /></button>
              </div>
            </div>
            {editing ? (
              <>
                <textarea style={{ ...FS.input, minHeight: 260, resize: "vertical", width: "100%", fontFamily: "inherit" }} value={editBuf} onChange={(e) => setEditBuf(e.target.value)} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                  <button style={FS.btn} onClick={() => { setEditing(false); setEditBuf(""); }} disabled={savingEdit}>Cancel</button>
                  <button style={{ ...FS.btnPrimary, opacity: (savingEdit || !editBuf.trim()) ? 0.6 : 1 }} onClick={saveEdit} disabled={savingEdit || !editBuf.trim()}>{savingEdit ? <><Loader2 size={16} className="spin" /> Saving…</> : <><FileText size={16} /> Save changes</>}</button>
                </div>
              </>
            ) : (
              <RichOutput S={S} text={openDraft.current_text ?? openDraft.ai_text} dark />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Roster & Operations ---------------- */
const MEMBERS = [
  { id: 1, name: "Maria Reyes", role: "Chief", access: ["Department Admin"], status: "Active", phone: "(817) 555-0142", joined: "2014", participation: 96, certs: [{ name: "Firefighter II", exp: "2027-03" }, { name: "EMT-B", exp: "2026-08" }, { name: "Hazmat Ops", exp: "2027-01" }], notes: [{ text: "Completed officer development course. Strong candidate for deputy chief.", by: "Department Admin", when: "May 2026" }] },
  { id: 2, name: "Tom Daniels", role: "Officer", access: ["Officer"], status: "Active", phone: "(817) 555-0188", joined: "2017", participation: 91, certs: [{ name: "Firefighter II", exp: "2026-09" }, { name: "EMT-B", exp: "2026-05" }, { name: "Fire Instructor I", exp: "2027-06" }], notes: [] },
  { id: 3, name: "Janelle Okafor", role: "Asst. Chief", access: ["Board Member"], status: "Active", phone: "(817) 555-0119", joined: "2015", participation: 88, certs: [{ name: "Firefighter II", exp: "2027-02" }, { name: "Paramedic", exp: "2026-07" }], notes: [] },
  { id: 4, name: "Cody Pearson", role: "Firefighter", access: ["Member"], status: "Active", phone: "(817) 555-0173", joined: "2021", participation: 76, certs: [{ name: "Firefighter I", exp: "2026-12" }, { name: "EMT-B", exp: "2026-04" }], notes: [{ text: "EMT-B lapsed — reminded to register for the July refresher.", by: "Officer", when: "Jun 2026" }] },
  { id: 5, name: "Sam Whitfield", role: "Firefighter", access: ["Member"], status: "Probationary", phone: "(817) 555-0166", joined: "2026", participation: 62, certs: [{ name: "Firefighter I", exp: "2027-05" }], notes: [{ text: "Probationary. Eager, good attitude — pair with a mentor.", by: "Officer", when: "Jun 2026" }] },
  { id: 6, name: "Dana Cole", role: "Firefighter / EMT", access: ["Member"], status: "Active", phone: "(817) 555-0150", joined: "2019", participation: 84, certs: [{ name: "Firefighter II", exp: "2026-08" }, { name: "EMT-B", exp: "2027-04" }], notes: [] },
];
// current year-month index (1-indexed month, matches "YYYY-MM" cert expiry) — real "today"; replaces the old hardcoded June-2026 baseline
function nowYM() { const d = new Date(); return d.getFullYear() * 12 + (d.getMonth() + 1); }
function certStatus(exp) {
  // Cert-status rule is ALSO replicated in SQL dept_cert_readiness() — keep in lockstep (≤3mo = EXPIRING).
  if (typeof exp !== "string" || !/^\d{4}-\d{2}$/.test(exp)) return { label: "NO DATE", color: "#6A7178", rank: 3 };
  const [y, m] = exp.split("-").map(Number);
  const diff = (y * 12 + m) - nowYM();
  if (diff < 0) return { label: "EXPIRED", color: "#B11E2A", rank: 0 };
  if (diff <= 3) return { label: "EXPIRING", color: "#9A6B12", rank: 1 };
  return { label: "CURRENT", color: "#2E7D52", rank: 2 };
}
// FIRE cert-status colors for crisp dark badges — additive sibling to certStatus's light `color`; does NOT mutate it.
const CERT_FIRE = { EXPIRED: FIRE.redText, EXPIRING: FIRE.amberText, CURRENT: FIRE.green, "NO DATE": FIRE.textMuted };
const CLASSES = [
  { name: "EMT-B Refresher", date: "Jul 12", covers: ["EMT-B", "Paramedic"] },
  { name: "CPR / BLS Recert", date: "Jun 28", covers: ["EMT-B", "Paramedic"] },
  { name: "Firefighter II Academy", date: "Aug 2", covers: ["Firefighter I", "Firefighter II"] },
  { name: "Hazmat Ops", date: "Sep 9", covers: ["Hazmat Ops"] },
  { name: "Fire Instructor I", date: "Oct 4", covers: ["Fire Instructor I"] },
];
function expPhrase(exp) {
  if (typeof exp !== "string" || !/^\d{4}-\d{2}$/.test(exp)) return "No expiration date";
  const [y, m] = exp.split("-").map(Number);
  const d = (y * 12 + m) - nowYM();
  const mon = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  if (d < 0) return `expired ${mon} ${y}`;
  if (d === 0) return `expires this month`;
  if (d <= 3) return `expires ${mon} ${y} — in ~${d} month${d > 1 ? "s" : ""}`;
  return `expires ${mon} ${y}`;
}
function Pill({ S, color, children }) {
  return <span style={{ ...S.opChip, color, borderColor: `${color}55`, background: `${color}14` }}>{children}</span>;
}
function Initials({ S, name, dark }) {
  const i = name.split(" ").map((w) => w[0]).slice(0, 2).join("");
  return <span style={dark ? { ...S.avatar, border: `0.5px solid ${FIRE.btnBorder}` } : S.avatar}>{i}</span>;
}

function Roster({ S, role, members, setMembers, sessions, plan, notify, meId, initialTab }) {
  const leader = isLeader(role);
  const tabs = leader
    ? [["members", "Members"], ["certs", "Certifications"], ["attendance", "Attendance"], ...(hasAny(role, DEPT_ADMIN_ROLES) ? [["pending", "Pending Items"]] : [])]
    : [["members", "Members"]];
  const [tab, setTab] = useState(() => tabs.some(([k]) => k === initialTab) ? initialTab : "members");   // role-guarded deep-link seed
  const [sel, setSel] = useState(null);
  const selected = members.find((m) => m.id === sel);
  const update = (m) => setMembers((ms) => ms.map((x) => (x.id === m.id ? m : x)));
  if (selected && leader) return <MemberDetail S={S} member={selected} role={role} back={() => setSel(null)} onUpdate={update} sessions={sessions} notify={notify} members={members} meId={meId} />;
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>ROSTER</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Your people, all in one place</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>{leader ? "Members, certifications, and who's showing up. Tap a member to see their full file." : "Your station directory and contacts."}</div>
      </div>
      <div style={S.segRow}>
        {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} style={{ ...S.segBtn, background: tab === k ? FIRE.btnBg : "transparent", borderColor: tab === k ? FIRE.red : FIRE.btnBorder, color: tab === k ? FIRE.textPrimary : FIRE.navLabel }}>{l}</button>)}
      </div>
      {tab === "members" && <RosterMembers S={S} role={role} members={members} setMembers={setMembers} onOpen={leader ? setSel : null} notify={notify} />}
      {tab === "certs" && leader && <RosterCerts S={S} members={members} />}
      {tab === "attendance" && leader && <RosterAttendance S={S} members={members} sessions={sessions} plan={plan} />}
      {tab === "pending" && hasAny(role, DEPT_ADMIN_ROLES) && <RosterPending S={S} members={members} notify={notify} />}
    </div>
  );
}
function RosterMembers({ S, role, members, setMembers, onOpen, notify }) {
  const canAdd = hasAny(role, DEPT_ADMIN_ROLES);
  const [adding, setAdding] = useState(false); const [nm, setNm] = useState(""); const [rl, setRl] = useState("Firefighter"); const [ph, setPh] = useState(""); const [em, setEm] = useState(""); const [st, setSt] = useState("Active"); const [ax, setAx] = useState(["Member"]); const [mt, setMt] = useState(""); const [bday, setBday] = useState(""); const [sdate, setSdate] = useState(""); const [addr, setAddr] = useState(""); const [showInactive, setShowInactive] = useState(false); const [query, setQuery] = useState(""); const [sendLink, setSendLink] = useState(true);
  const sColor = (s) => s === "Active" ? FIRE.green : (s === "Probationary" ? FIRE.amberText : FIRE.textMuted);
  // Live text filter — composes (AND) with countsInStats + the inactive toggle. An active query also reveals inactive matches.
  const q = query.trim().toLowerCase();
  const matches = (m) => !q || [m.name, m.email, m.role, (Array.isArray(m.access) ? m.access.join(" ") : "")].some((f) => (f || "").toLowerCase().includes(q));
  const rosterTotal = members.filter(countsInStats).length;   // full roster (owner/test/PA excluded) — the "of Y"
  const filtered = members.filter((m) => countsInStats(m) && (showInactive || !q || m.status !== "Inactive") && matches(m));
  async function add() {
    const email = em.trim().toLowerCase();
    if (!nm.trim() || !email || !/^\S+@\S+\.\S+$/.test(email)) { notify({ kind: "error", title: "Email required", text: "A valid email is needed so this member can sign in." }); return; }
    const { data: myDept } = await supabase.rpc("my_department_id");   // authoritative dept id — NOT `departments limit 1` (that grabs an arbitrary dept once >1 exists)
    if (!myDept) { notify({ kind: "error", title: "Couldn't resolve your department", text: "We couldn't determine your department to add this member. Please try again." }); return; }
    const newRow = { department_id: myDept, name: nm.trim(), role: rl.trim() || null, access: ax.length ? ax : ["Member"], status: st, phone: ph.trim() || "—", email, mentor_id: mt || null, joined: sdate ? sdate.slice(0, 4) : null, participation: 0 };   // joined (year) derived from the start date
    const { data, error } = await supabase.from("members").insert(newRow).select().single();
    if (error || !data) { notify({ kind: "error", title: "Couldn't add the member", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");   // authoritative dept id (matches the member_private with_check); convention across all dept-scoped writes
    if (deptErr || !deptId) {
      notify({ kind: "error", title: "Member saved, personal details didn't", text: "The main record saved; we couldn't resolve your department to save birthday/address/start date. Add them via the member's file.", details: deptErr?.message });
    } else {
      const { error: e2 } = await supabase.from("member_private").upsert({ member_id: data.id, department_id: deptId, birthday: bday || null, address: addr.trim() || null, joined_date: sdate || null }, { onConflict: "member_id" });   // DA/PA-only personal details (same table as the edit form)
      if (e2) { notify({ kind: "error", title: "Member saved, personal details didn't", text: "The main record saved; birthday/address/start date didn't — add them via the member's file.", details: e2.message }); }
    }
    setMembers((m) => [...m, { id: data.id, name: data.name, role: data.role, access: data.access, status: data.status, phone: data.phone, email: data.email, joined: data.joined, participation: data.participation, mentorId: data.mentor_id ?? null, certs: [], notes: [] }]);
    if (sendLink) {
      const { error: otpErr } = await supabase.auth.signInWithOtp({
        email,                                                  // the new member's email, already trimmed+lowercased
        options: { emailRedirectTo: APP_URL },
      });
      if (otpErr) {
        notify({ kind: "error", title: "Member added — login link didn't send",
          text: `${data.name} is on the roster, but we couldn't email their login link. They can request one at sign-in, or you can try again from their file.`,
          details: otpErr.message });
      } else {
        notify({ kind: "success", title: "Member added & invited",
          text: `We emailed a login link to ${email}.` });
      }
    }
    setNm(""); setPh(""); setEm(""); setSt("Active"); setAx(["Member"]); setMt(""); setBday(""); setSdate(""); setAddr(""); setSendLink(true); setAdding(false);
  }
  async function remove(id, name) {
    if (!window.confirm(`Remove ${name} from the department roster? This takes them off the active list.`)) return;
    setMembers((m) => m.filter((x) => x.id !== id));
    const { error } = await supabase.from("members").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove the member", text: "Something went wrong removing that. Please try again.", details: error.message }); }
  }
  return (
    <div>
      {canAdd && (adding ? (
        <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...S.field, flex: 1, minWidth: 160 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Name</span><input style={FS.input} value={nm} onChange={(e) => setNm(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Rank</span><input style={FS.input} value={rl} onChange={(e) => setRl(e.target.value)} placeholder="Firefighter" /></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Phone</span><input style={FS.input} value={ph} onChange={(e) => setPh(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Email <span style={{ color: FIRE.deleteRed }}>*</span></span><input type="email" style={FS.input} value={em} onChange={(e) => setEm(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Status</span><select style={FS.input} value={st} onChange={(e) => setSt(e.target.value)}><option>Active</option><option>Probationary</option><option>Inactive</option></select></label>
          <div style={{ ...S.field, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Access (roles)</span>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 5 }}>
              {GRANTABLE_ROLES.map((r) => (
                <label key={r} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: FIRE.textPrimary, cursor: "pointer" }}>
                  <input type="checkbox" checked={ax.includes(r)} onChange={(e) => setAx((a) => e.target.checked ? [...a, r] : a.filter((x) => x !== r))} />
                  {r}
                </label>
              ))}
            </div>
          </div>
          <label style={{ ...S.field, minWidth: 160 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Mentor</span>
            <select style={FS.input} value={mt} onChange={(e) => setMt(e.target.value)}>
              <option value="">— None —</option>
              {(members || []).filter((m) => isAssignable(m) && m.status === "Active").map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Start date</span><input type="date" style={FS.input} value={sdate} onChange={(e) => setSdate(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Birthday</span><input type="date" style={FS.input} value={bday} onChange={(e) => setBday(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Address</span><input style={FS.input} value={addr} onChange={(e) => setAddr(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 180, display: "inline-flex", flexDirection: "row", alignItems: "center", gap: 7, cursor: "pointer" }}>
            <input type="checkbox" checked={sendLink} onChange={(e) => setSendLink(e.target.checked)} />
            <span style={{ fontSize: 13, color: FIRE.textPrimary }}>Email them a login link now</span>
          </label>
          <button style={{ ...FS.btnPrimary, flex: "0 0 auto" }} onClick={add}><UserPlus size={15} /> Add member</button>
        </div>
      ) : <button style={{ ...FS.btn, marginBottom: 12 }} onClick={() => setAdding(true)}><UserPlus size={15} /> Add member</button>)}
      <div style={{ ...S.searchBox, ...FS.card, marginBottom: 10 }}>
        <Search size={16} color={FIRE.textMuted} />
        <input style={{ ...S.searchInput, color: FIRE.textPrimary }} placeholder="Search members by name, email, or role…" value={query} onChange={(e) => setQuery(e.target.value)} />
        {query && <button style={S.clearBtn} onClick={() => setQuery("")} aria-label="Clear search"><X size={15} /></button>}
      </div>
      <div style={{ fontSize: 12.5, color: FIRE.textMuted, marginBottom: 10 }}>Showing {filtered.length} of {rosterTotal}</div>
      {members.some((m) => m.status === "Inactive") && (
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <button onClick={() => setShowInactive((v) => !v)} style={{ ...S.segBtn, background: showInactive ? FIRE.btnBg : "transparent", borderColor: showInactive ? FIRE.red : FIRE.btnBorder, color: showInactive ? FIRE.textPrimary : FIRE.navLabel }}>{showInactive ? "Hide inactive" : `Show inactive (${members.filter((m) => m.status === "Inactive" && countsInStats(m)).length})`}</button>
        </div>
      )}
      {filtered.length === 0 && <div style={{ ...S.opCard, ...FS.card, textAlign: "center", color: FIRE.textMuted }}>{query ? `No members match "${query}".` : "No members to show."}</div>}
      <div style={S.opGrid}>
        {/* Owner + test + Project Admin hidden via countsInStats; search + inactive toggle compose (AND) */}
        {filtered.map((m) => (
          <div key={m.id} style={{ ...S.opCard, ...FS.card, ...(onOpen ? { cursor: "pointer" } : {}) }} onClick={onOpen ? () => onOpen(m.id) : undefined}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Initials S={S} dark name={m.name} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...S.personName, color: FIRE.textPrimary }}>{m.name}</div>
                <div style={{ ...S.personMeta, color: FIRE.textMuted }}>{m.role || "Member"} · since {m.joined}</div>
              </div>
              {m.status ? <Pill S={S} color={sColor(m.status)}>{m.status.toUpperCase()}</Pill> : null}
              {canAdd && <button title="Remove from roster" style={{ ...FS.btn, padding: "6px 8px", marginLeft: 4 }} onClick={(e) => { e.stopPropagation(); remove(m.id, m.name); }}><X size={14} color={FIRE.deleteRed} /></button>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 11, fontSize: 13, color: FIRE.textMuted }}>
              <Phone size={13} /> {m.phone}
              {onOpen ? <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 3, color: FIRE.btnText, fontWeight: 600, fontSize: 12.5 }}>View file <ChevronRight size={14} /></span>
                : <span style={{ marginLeft: "auto", fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}>{m.certs.length} certs</span>}
            </div>
            {m.email && (
              <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 6, fontSize: 13, color: FIRE.textMuted }}>
                <Mail size={13} /> <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.email}</span>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
// "YYYY-MM-DD" -> "Mar 14, 2021" (parsed from parts — no Date()/timezone drift)
function fmtLongDate(iso) {
  if (typeof iso !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const [y, m, d] = iso.split("-").map(Number);
  return `${["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1]} ${d}, ${y}`;
}
function MemberDetail({ S, member, role, back, onUpdate, sessions, notify, members, meId }) {
  const assign = hasAny(role, DEPT_ADMIN_ROLES);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [editingCertId, setEditingCertId] = useState(null);
  const [draft, setDraft] = useState({ name: "", exp: "" });
  const [priv, setPriv] = useState(null);        // member_private (birthday/address/joined_date) — DA/PA only
  const [notes, setNotes] = useState([]);        // member_notes rows — DA/PA only (RLS-gated)
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [saving, setSaving] = useState(false);
  const certs = (member.certs || []).map((c) => ({ ...c, st: certStatus(c.exp) })).sort((a, b) => a.st.rank - b.st.rank);
  // Live 90-day participation — same deptAttendance calc as the roster + Reports; NOT the stale stored field.
  const part90 = deptAttendance(members, sessions, null, rolling90()).rows.find((r) => r.id === member.id)?.pct ?? null;
  useEffect(() => {                              // load DA/PA-only data; Board/TO skip (RLS would return nothing anyway)
    if (!assign) return;
    let alive = true;
    supabase.from("member_private").select("birthday, address, joined_date").eq("member_id", member.id).maybeSingle()
      .then(({ data }) => { if (alive) setPriv(data || {}); });
    supabase.from("member_notes").select("text, by, created_at").eq("member_id", member.id).order("created_at", { ascending: false })
      .then(({ data }) => { if (alive) setNotes(data || []); });
    return () => { alive = false; };
  }, [member.id, assign]);
  function startEditForm() {
    setForm({ name: member.name || "", phone: member.phone === "—" ? "" : (member.phone || ""), status: member.status || "Active", access: (Array.isArray(member.access) ? member.access : ["Member"]).filter((r) => GRANTABLE_ROLES.includes(r)), role: member.role || "", email: member.email || "", birthday: priv?.birthday || "", address: priv?.address || "", joined_date: priv?.joined_date || "", mentor_id: member.mentorId || "" });
    setEditing(true);
  }
  async function toggleActive() {
    const goInactive = member.status !== "Inactive";
    if (goInactive && member.id === meId) { notify({ kind: "error", title: "Can't deactivate yourself", text: "Have another leader deactivate your account." }); return; }   // self-lockout, matches saveMember's intent
    const next = goInactive ? "Inactive" : "Active";
    if (goInactive && !window.confirm(`Deactivate ${member.name}? They'll drop off the active roster; you can reactivate anytime.`)) return;
    if (!goInactive && !window.confirm(`Reactivate ${member.name}? They'll return to the active roster.`)) return;
    const { error } = await supabase.from("members").update({ status: next }).eq("id", member.id);
    if (error) { notify({ kind: "error", title: goInactive ? "Couldn't deactivate the member" : "Couldn't reactivate the member", text: "Something went wrong. Please try again.", details: error.message }); return; }
    onUpdate({ ...member, status: next });
    notify({ kind: "success", text: `${member.name} ${goInactive ? "deactivated" : "reactivated"}.` });
  }
  async function saveMember() {
    const checkedRoles = form.access;   // grantable roles the checkboxes hold
    const finalAccess = [...checkedRoles, ...(Array.isArray(member.access) && member.access.includes("Project Admin") ? ["Project Admin"] : [])];   // merge PA back (not a checkbox)
    const access = finalAccess.length ? finalAccess : ["Member"];   // never save an empty array
    if (member.id === meId && !isDeptAdmin(access)) {   // self-lockout guard — runs on the merged array, only when editing yourself
      notify({ kind: "error", title: "Can't remove your own admin access", text: "That change would leave you without Department/Project Admin. Have another admin make it." });
      return;
    }
    const email = (form.email || "").trim().toLowerCase();
    if (!email || !/^\S+@\S+\.\S+$/.test(email)) { notify({ kind: "error", title: "Email required", text: "A valid email is needed so this member can sign in." }); return; }
    setSaving(true);
    const jd = form.joined_date || null;
    const joinedYear = jd ? jd.slice(0, 4) : member.joined;   // keep member-visible "since [year]" in sync
    const { error: e1 } = await supabase.from("members").update({ name: form.name.trim(), phone: form.phone.trim() || null, status: form.status, access, role: form.role.trim() || null, joined: joinedYear, mentor_id: form.mentor_id || null, email }).eq("id", member.id);
    if (e1) { setSaving(false); notify({ kind: "error", title: "Couldn't save the member", text: "Something went wrong saving those changes. Please try again.", details: e1.message }); return; }
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");   // authoritative dept id (the member_private with_check compares to my_department_id())
    if (deptErr || !deptId) { setSaving(false); notify({ kind: "error", title: "Couldn't find your department", text: "Please try again.", details: deptErr?.message }); return; }
    const { error: e2 } = await supabase.from("member_private").upsert({ member_id: member.id, department_id: deptId, birthday: form.birthday || null, address: form.address.trim() || null, joined_date: jd }, { onConflict: "member_id" });
    if (e2) { setSaving(false); notify({ kind: "error", title: "Profile saved, personal details didn't", text: "The main fields saved, but birthday/address/join date failed. Please try again.", details: e2.message }); return; }
    setSaving(false);
    onUpdate({ ...member, name: form.name.trim(), phone: form.phone.trim() || "—", status: form.status, access, role: form.role.trim() || null, joined: joinedYear, mentorId: form.mentor_id || null, email });
    setPriv({ birthday: form.birthday || null, address: form.address.trim() || null, joined_date: jd });
    setEditing(false);
    notify({ kind: "success", text: "Member updated." });
  }
  async function addNote() {
    const t = note.trim(); if (!t) return;
    const { data, error } = await supabase.from("member_notes").insert({ member_id: member.id, department_id: member.department_id, text: t, by: role }).select("text, by, created_at").single();
    if (error || !data) { notify({ kind: "error", title: "Couldn't add the note", text: "Something went wrong. Please try again.", details: error?.message }); return; }
    setNotes((ns) => [data, ...ns]); setNote("");
  }
  async function removeCert(c) {
    if (!window.confirm("Remove this certification? This cannot be undone.")) return;
    setBusyId(c.id);
    const { error } = await supabase.rpc("delete_cert", { cert_id: c.id });
    setBusyId(null);
    if (error) { notify({ kind: "error", title: "Couldn't remove the certification", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    onUpdate({ ...member, certs: member.certs.filter((x) => x.id !== c.id) });
  }
  function startEdit(c) {
    setEditingCertId(c.id);
    setDraft({ name: c.name, exp: c.exp || "" });
  }
  function cancelEdit() {
    setEditingCertId(null);
    setDraft({ name: "", exp: "" });
  }
  async function saveCert(c) {
    const name = draft.name.trim();
    if (!name) { notify({ kind: "error", title: "Name can't be empty", text: "Enter a name for the certification." }); return; }
    const expTrim = draft.exp.trim();
    if (expTrim && !/^\d{4}-\d{2}$/.test(expTrim)) { notify({ kind: "error", title: "Check the expiration format", text: "Expiration must be YYYY-MM (e.g. 2027-06)." }); return; }
    setBusyId(c.id);
    const { error } = await supabase.rpc("update_cert", { cert_id: c.id, new_name: name, new_exp: expTrim || null });
    setBusyId(null);
    if (error) { notify({ kind: "error", title: "Couldn't update the certification", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    onUpdate({ ...member, certs: member.certs.map((x) => (x.id === c.id ? { ...x, name, exp: expTrim || null } : x)) });
    setEditingCertId(null);
    setDraft({ name: "", exp: "" });
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <button style={{ ...S.backBtn, color: FIRE.textSecondary }} onClick={back}><ArrowLeft size={16} /> Back to roster</button>
      <div style={{ ...S.opCard, ...FS.card, marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center" }}>
          <Initials S={S} dark name={member.name} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ ...S.personName, fontSize: 19, color: FIRE.textPrimary }}>{member.name}</div>
            <div style={{ ...S.personMeta, color: FIRE.textMuted }}>{member.role} · since {member.joined} · {member.phone}</div>
          </div>
          <Pill S={S} color={member.status === "Active" ? FIRE.green : member.status === "Probationary" ? FIRE.amberText : FIRE.textMuted}>{member.status.toUpperCase()}</Pill>
        </div>
        <div style={{ marginTop: 14 }}>
          <div style={{ fontSize: 12.5, color: FIRE.textSecondary, display: "flex", justifyContent: "space-between" }}><span>Participation (90 days)</span><span>{part90 == null ? "—" : `${part90}%`}</span></div>
          {part90 != null && <Bar S={S} pct={part90} track={FIRE.track} color={part90 >= 75 ? FIRE.green : part90 >= 50 ? FIRE.amberText : FIRE.redText} />}
        </div>
        {assign && !editing && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `0.5px solid ${FIRE.hairline}` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div style={FS.kicker}>PROFILE · LEADERSHIP ONLY</div>
              <div style={{ display: "flex", gap: 8 }}>
                {!(member.id === meId && member.status !== "Inactive") && <button style={{ ...FS.btn, padding: "6px 12px", fontSize: 12.5, color: member.status === "Inactive" ? FIRE.greenText : FIRE.redText }} onClick={toggleActive}>{member.status === "Inactive" ? "Reactivate" : "Deactivate"}</button>}
                <button style={{ ...FS.btn, padding: "6px 12px", fontSize: 12.5 }} onClick={startEditForm}>Edit member</button>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: "10px 18px" }}>
              {[
                ["Access", member.access?.length ? member.access.join(", ") : "—"],
                ["Mentor", (members || []).find((m) => m.id === member.mentorId)?.name || "—"],
                ["Email", member.email || "—"],
                ["Joined", fmtLongDate(priv?.joined_date) || (member.joined ? `${member.joined} (year on file)` : "—")],
                ["Birthday", fmtLongDate(priv?.birthday) || "—"],
                ["Address", priv?.address || "—"],
              ].map(([l, v]) => (
                <div key={l}>
                  <div style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".1em", color: FIRE.textMuted2, fontWeight: 700 }}>{l}</div>
                  <div style={{ fontSize: 13, color: FIRE.textSecondary, wordBreak: "break-word" }}>{v}</div>
                </div>
              ))}
            </div>
          </div>
        )}
        {assign && editing && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `0.5px solid ${FIRE.hairline}` }}>
            <div style={{ ...FS.kicker, marginBottom: 10 }}>EDIT MEMBER</div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 10 }}>
              <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Name</span><input style={FS.input} value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} /></label>
              <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Email <span style={{ color: FIRE.deleteRed }}>*</span></span><input type="email" style={FS.input} value={form.email || ""} onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))} /></label>
              <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Phone</span><input style={FS.input} value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))} /></label>
              <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Station role</span><input style={FS.input} value={form.role} onChange={(e) => setForm((f) => ({ ...f, role: e.target.value }))} placeholder="Firefighter" /></label>
              <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Status</span><select style={FS.input} value={form.status} onChange={(e) => setForm((f) => ({ ...f, status: e.target.value }))}><option>Active</option><option>Probationary</option><option>Inactive</option></select></label>
              <div style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Access (roles)</span>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 5 }}>
                  {GRANTABLE_ROLES.map((r) => (
                    <label key={r} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: FIRE.textPrimary, cursor: "pointer" }}>
                      <input type="checkbox" checked={form.access.includes(r)} onChange={(e) => setForm((f) => ({ ...f, access: e.target.checked ? [...f.access, r] : f.access.filter((x) => x !== r) }))} />
                      {r}
                    </label>
                  ))}
                </div>
                {Array.isArray(member.access) && member.access.includes("Project Admin") && <div style={{ fontSize: 11.5, color: FIRE.textMuted, marginTop: 5 }}>Also holds Project Admin — preserved on save (not editable here).</div>}
              </div>
              <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Mentor</span>
                <select style={FS.input} value={form.mentor_id || ""} onChange={(e) => setForm((f) => ({ ...f, mentor_id: e.target.value }))}>
                  <option value="">— None —</option>
                  {(members || []).filter((m) => m.id !== member.id && m.status === "Active" && isAssignable(m)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select></label>
              <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Joined (date)</span><input type="date" style={FS.input} value={form.joined_date || ""} onChange={(e) => setForm((f) => ({ ...f, joined_date: e.target.value }))} /></label>
              <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Birthday</span><input type="date" style={FS.input} value={form.birthday || ""} onChange={(e) => setForm((f) => ({ ...f, birthday: e.target.value }))} /></label>
              <label style={{ ...S.field, gridColumn: "1 / -1" }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Address</span><input style={FS.input} value={form.address} onChange={(e) => setForm((f) => ({ ...f, address: e.target.value }))} /></label>
            </div>
            <div style={{ fontSize: 12, color: FIRE.textMuted, margin: "8px 0 12px" }}>Email is the member's login identity (stored lowercase). Changing it re-links their sign-in — for someone who already logs in, only change it alongside their auth email. Access changes take effect on their next sign-in.</div>
            <div style={{ display: "flex", gap: 8 }}>
              <button style={FS.btnPrimary} disabled={saving} onClick={saveMember}>{saving ? "Saving…" : "Save changes"}</button>
              <button style={FS.btn} disabled={saving} onClick={() => setEditing(false)}>Cancel</button>
            </div>
          </div>
        )}
      </div>

      <div style={{ ...FS.kicker, marginBottom: 8 }}><Award size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />CERTIFICATIONS</div>
      <div style={{ ...S.opCard, ...FS.card, marginBottom: 16 }}>
        {certs.length === 0 ? <div style={{ fontSize: 13.5, color: FIRE.textMuted }}>No certifications on file yet.</div> :
          certs.map((c, i) => (
            <div key={c.id} style={{ ...S.certRow, borderBottom: i === certs.length - 1 ? "none" : `0.5px solid ${FIRE.hairline}`, ...(assign && editingCertId === c.id ? { flexWrap: "wrap" } : {}) }}>
              <Award size={15} color={CERT_FIRE[c.st.label]} style={{ flexShrink: 0 }} />
              {assign && editingCertId === c.id ? (<>
                <label style={{ ...S.field, flex: 1, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Certification</span><input style={FS.input} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} /></label>
                <label style={{ ...S.field, minWidth: 120 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Expires (YYYY-MM)</span><input style={FS.input} value={draft.exp} onChange={(e) => setDraft((d) => ({ ...d, exp: e.target.value }))} placeholder="2027-06" /></label>
                <button style={{ ...FS.btnPrimary, flex: "0 0 auto" }} disabled={busyId === c.id} onClick={() => saveCert(c)}>{busyId === c.id ? "Saving…" : "Save"}</button>
                <button style={{ ...FS.btn, padding: "6px 10px", fontSize: 12.5 }} disabled={busyId === c.id} onClick={cancelEdit}>Cancel</button>
              </>) : (<>
                <div style={{ flex: 1, minWidth: 0 }}><span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{c.name}</span> <span style={{ color: FIRE.textMuted, fontSize: 13 }}>· {expPhrase(c.exp)}</span></div>
                <Pill S={S} color={CERT_FIRE[c.st.label]}>{c.st.label}</Pill>
                {assign && (<>
                  <button style={{ ...FS.btn, padding: "6px 10px", fontSize: 12.5 }} disabled={busyId === c.id} onClick={() => startEdit(c)}>Edit</button>
                  <button style={{ ...FS.btn, padding: "6px 10px", fontSize: 12.5, color: FIRE.deleteRed }} disabled={busyId === c.id} onClick={() => removeCert(c)}>Remove</button>
                </>)}
              </>)}
            </div>
          ))}
      </div>

      <ProposeCert S={S} role={role} member={member} notify={notify} />

      {(() => {
        const memberLeader = isLeader(member.access);   // score + list off the VIEWED member's actual roles
        const done = (sessions || []).filter((s) => s.done && (memberLeader || s.audience !== "leadership")).sort((a, b) => sessDate(b) - sessDate(a));
        const went = done.filter((s) => (s.attendance || []).includes(member.id)).length;
        return (
          <>
            <div style={{ ...FS.kicker, marginBottom: 8 }}><CalendarCheck size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />TRAINING HISTORY</div>
            <div style={{ ...S.opCard, ...FS.card, marginBottom: 16 }}>
              {done.length === 0 ? <div style={{ fontSize: 13.5, color: FIRE.textMuted }}>No training sessions recorded yet.</div> : (<>
                <div style={{ fontSize: 13, color: FIRE.textSecondary, marginBottom: 8 }}>Attended <b>{went}</b> of <b>{done.length}</b> recorded sessions.</div>
                {done.map((s, i) => {
                  const present = (s.attendance || []).includes(member.id);
                  return (
                    <div key={s.id} style={{ ...S.certRow, borderBottom: i === done.length - 1 ? "none" : `0.5px solid ${FIRE.hairline}` }}>
                      <CalendarCheck size={15} color={present ? FIRE.green : FIRE.redBright} style={{ flexShrink: 0 }} />
                      <div style={{ flex: 1, minWidth: 0 }}><span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{s.title}</span><LeadershipTag audience={s.audience} /> <span style={{ color: FIRE.textMuted, fontSize: 13 }}>· {fmtSess(s)}</span></div>
                      <Pill S={S} color={present ? FIRE.green : FIRE.redBright}>{present ? "PRESENT" : "ABSENT"}</Pill>
                    </div>
                  );
                })}
              </>)}
            </div>
          </>
        );
      })()}

      {assign && (<>
      <div style={{ ...FS.kicker, marginBottom: 8 }}><MessageSquare size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />MEMBER LOG — DEPT ADMINS ONLY</div>
      <div style={{ ...S.opCard, ...FS.card }}>
        <div style={{ display: "flex", gap: 8, marginBottom: notes.length ? 14 : 0 }}>
          <input style={{ ...FS.input, flex: 1 }} placeholder="Add a note — training, performance, kudos, follow-ups…" value={note} onChange={(e) => setNote(e.target.value)} />
          <button style={FS.btnPrimary} onClick={addNote}>Add</button>
        </div>
        {notes.map((n, i) => (
          <div key={i} style={{ ...S.certRow, borderBottom: i === notes.length - 1 ? "none" : `0.5px solid ${FIRE.hairline}`, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 13.5, color: FIRE.textSecondary, lineHeight: 1.5 }}>{n.text}</div><div style={{ fontSize: 11.5, color: FIRE.textMuted, marginTop: 3 }}>{n.by} · {fmtLongDate((n.created_at || "").slice(0, 10)) || "recent"}</div></div>
          </div>
        ))}
        {notes.length === 0 && <div style={{ fontSize: 13, color: FIRE.textMuted }}>No notes yet. Notes here are visible to department admins only — never to the member.</div>}
      </div>
      </>)}
    </div>
  );
}
function ProposeCert({ S, role, member, notify }) {
  const canPropose = isLeader(role);
  const [open, setOpen] = useState(false);
  const [cName, setCName] = useState("");
  const [cExp, setCExp] = useState("");        // "YYYY-MM" string, matches certs.exp
  const [cNote, setCNote] = useState("");
  const [cFile, setCFile] = useState(null);
  const [busy, setBusy] = useState(false);

  async function propose() {
    if (!cName.trim()) { notify({ kind: "error", title: "Certification needs a name", text: "Enter the certification name before submitting." }); return; }
    const exp = cExp.trim();
    if (exp && !/^\d{4}-\d{2}$/.test(exp)) { notify({ kind: "error", title: "Check the expiration format", text: "Expiration must be YYYY-MM (e.g. 2027-06)." }); return; }
    if (!cFile) { notify({ kind: "error", title: "Proof required", text: "Attach a PDF or photo of the certification." }); return; }
    setBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { notify({ kind: "error", title: "You're not signed in", text: "Please sign in again to continue." }); setBusy(false); return; }
    // upload proof for the TARGET member (leader writes under their dept via the leadership storage policy)
    const path = `${member.department_id}/cert-proofs/${member.id}/${Date.now()}-${cFile.name}`;
    const { error: upErr } = await supabase.storage.from("station-documents").upload(path, cFile);
    if (upErr) { setBusy(false); notify({ kind: "error", title: "Couldn't upload the proof", text: "Something went wrong uploading that. Please try again.", details: upErr.message }); return; }
    const row = {
      department_id: member.department_id,
      member_id: member.id,
      name: cName.trim(),
      exp: exp || null,
      source: "manual",
      note: cNote.trim() || null,
      proposed_by: user.id,
      proof_path: path,
      // status omitted → defaults to 'pending'
    };
    const { data, error } = await supabase.from("cert_submissions").insert(row).select().single();
    setBusy(false);
    if (error || !data) { notify({ kind: "error", title: "Couldn't submit", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setCName(""); setCExp(""); setCNote(""); setCFile(null); setOpen(false);
    notify({ kind: "success", text: "Submitted for review." });
  }

  if (!canPropose || !member) return null;
  return open ? (
    <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
      <label style={{ ...S.field, flex: 1, minWidth: 160 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Certification</span><input style={FS.input} value={cName} onChange={(e) => setCName(e.target.value)} /></label>
      <label style={{ ...S.field, minWidth: 130 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Expires (YYYY-MM)</span><input style={FS.input} value={cExp} onChange={(e) => setCExp(e.target.value)} placeholder="2027-06" /></label>
      <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Note (optional)</span><input style={FS.input} value={cNote} onChange={(e) => setCNote(e.target.value)} /></label>
      <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Proof (required)</span><input type="file" accept=".pdf,image/*" onChange={(e) => setCFile(e.target.files?.[0] || null)} style={{ ...FS.input, padding: "6px 8px", fontSize: 12 }} /></label>
      <button style={{ ...FS.btnPrimary, flex: "0 0 auto", opacity: (busy || !cFile || !cName.trim()) ? 0.55 : 1 }} disabled={busy || !cFile || !cName.trim()} onClick={propose}>{busy ? "Submitting…" : "Submit for review"}</button>
      {!cFile && <div style={{ width: "100%", fontSize: 11.5, color: FIRE.amberText }}>Proof required — attach a PDF or photo to submit.</div>}
    </div>
  ) : (
    <button style={{ ...FS.btn, marginBottom: 12 }} onClick={() => setOpen(true)}>+ Propose certification</button>
  );
}

function RosterCerts({ S, members }) {
  const rows = [];
  members.forEach((m) => m.certs.forEach((c) => rows.push({ member: m.name, cert: c.name, exp: c.exp, st: certStatus(c.exp) })));
  rows.sort((a, b) => a.st.rank - b.st.rank);
  const n = (r) => rows.filter((x) => x.st.rank === r).length;
  const nextClassFor = (cert) => CLASSES.find((cl) => cl.covers.includes(cert));
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  async function draftReminders() {
    const flagged = rows.filter((r) => r.st.rank < 2);
    if (!flagged.length) { setOut(""); setErr("Nothing expiring — no reminders needed right now."); return; }
    setLoading(true); setErr(""); setOut("");
    const lines = flagged.map((r) => {
      const cl = nextClassFor(r.cert);
      return `- ${r.member}: ${r.cert} (${expPhrase(r.exp)})${cl ? ` — next class: ${cl.name} on ${cl.date}` : ""}`;
    }).join("\n");
    const sys = "You draft short, friendly certification-renewal reminder messages for a volunteer fire/EMS department to send to members. One brief message per member (2-3 sentences), warm and practical, naming the cert, when it lapses, and the suggested class/date if given. Never scold. These are DRAFTS for a human officer to review and send. Use the member's name as a short header.";
    try { const t = await callClaude(sys, `Draft renewal reminders for:\n${lines}`); setOut(t); }
    catch { setErr("Couldn't draft reminders just now. Try again."); } finally { setLoading(false); }
  }
  return (
    <div>
      <div style={S.statRow}>
        <Stat S={S} dark n={String(n(2))} label="Certs current" />
        <Stat S={S} dark n={String(n(1))} label="Expiring within 90 days" warn={n(1) > 0} />
        <Stat S={S} dark n={String(n(0))} label="Expired — action needed" warn={n(0) > 0} />
      </div>
      <div style={{ ...S.aiBanner, ...FS.card, borderLeft: `3px solid ${FIRE.red}` }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}><CalendarCheck size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />EXPIRATION ENGINE</div>
          <h3 style={{ ...S.featTitle, color: FIRE.textPrimary }}>Stay ahead of every renewal</h3>
          <p style={{ ...S.helpP, color: FIRE.textMuted, marginBottom: 10 }}>Every expiring or lapsed cert is matched to the next class that clears it. Draft the reminders here — you review and send.</p>
          <button style={{ ...FS.btnPrimary, opacity: loading ? 0.7 : 1 }} onClick={draftReminders} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><Sparkles size={16} /> Draft renewal reminders</>}
          </button>
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
          {out && <RichOutput S={S} text={out} dark />}
        </div>
      </div>
      <div style={{ marginTop: 4 }}>
        {rows.map((r, i) => {
          const cl = r.st.rank < 2 ? nextClassFor(r.cert) : null;
          return (
            <div key={i} style={{ ...S.certRow, flexWrap: "wrap", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
              <Award size={15} color={CERT_FIRE[r.st.label]} style={{ flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{r.cert}</span> <span style={{ color: FIRE.textMuted, fontSize: 13 }}>· {r.member}</span>
                <div style={{ fontSize: 12, color: CERT_FIRE[r.st.label], marginTop: 1 }}>{expPhrase(r.exp)}</div>
                {cl && <div style={{ fontSize: 12, color: FIRE.greenText, marginTop: 1, display: "inline-flex", alignItems: "center", gap: 4 }}><CalendarCheck size={12} /> Next: {cl.name} · {cl.date}</div>}
              </div>
              <Pill S={S} color={CERT_FIRE[r.st.label]}>{r.st.label}</Pill>
            </div>
          );
        })}
      </div>
    </div>
  );
}
function RosterPending({ S, members, notify }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const nameFor = (id) => { const m = members.find((x) => x.id === id); return m ? m.name : "Unknown member"; };

  async function loadPending() {
    setLoading(true);
    const { data, error } = await supabase.from("cert_submissions").select("*").eq("status", "pending");
    setLoading(false);
    if (error) { notify({ kind: "error", title: "Couldn't load pending items", text: "Something went wrong loading those. Please try again.", details: error.message }); return; }
    setRows(data || []);
  }
  useEffect(() => { loadPending(); }, []);

  async function approve(row) {
    setBusyId(row.id);
    const { error } = await supabase.rpc("approve_cert_submission", { submission_id: row.id });
    setBusyId(null);
    if (error) { notify({ kind: "error", title: "Couldn't approve", text: "Something went wrong approving that. Please try again.", details: error.message }); return; }
    loadPending();
  }
  async function reject(row) {
    const reason = window.prompt("Reason for rejecting (optional):", "");
    if (reason === null) return; // user cancelled the prompt
    setBusyId(row.id);
    const { error } = await supabase.rpc("reject_cert_submission", { submission_id: row.id, reason: reason.trim() || null });
    setBusyId(null);
    if (error) { notify({ kind: "error", title: "Couldn't reject", text: "Something went wrong rejecting that. Please try again.", details: error.message }); return; }
    loadPending();
  }
  async function viewProof(row) {
    if (!row.proof_path) return;
    const { data, error } = await supabase.storage.from("station-documents").createSignedUrl(row.proof_path, 3600);
    if (error || !data?.signedUrl) { notify({ kind: "error", title: "Couldn't open the proof", text: "Please try again.", details: error?.message }); return; }
    const a = document.createElement("a"); a.href = data.signedUrl; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
  }

  if (loading && rows.length === 0) return <div style={{ fontSize: 13.5, color: FIRE.textMuted, marginTop: 4 }}>Loading…</div>;
  if (rows.length === 0) return <div style={{ fontSize: 13.5, color: FIRE.textMuted, marginTop: 4 }}>No pending items.</div>;
  return (
    <div style={{ marginTop: 4 }}>
      {rows.map((r) => (
        <div key={r.id} style={{ ...S.certRow, flexWrap: "wrap", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
          <Award size={15} color={FIRE.amberText} style={{ flexShrink: 0 }} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{r.name}</span> <span style={{ color: FIRE.textMuted, fontSize: 13 }}>· {nameFor(r.member_id)}</span>
            <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 1 }}>{r.exp ? expPhrase(r.exp) : "No expiration"} · {r.source}{r.note ? ` · ${r.note}` : ""}</div>
          </div>
          {r.proof_path
            ? <button style={{ ...FS.btn, padding: "6px 10px", fontSize: 12.5 }} disabled={busyId === r.id} onClick={() => viewProof(r)}>View proof</button>
            : <span style={{ fontSize: 11.5, color: FIRE.textMuted, alignSelf: "center" }}>no proof</span>}
          <button style={{ ...FS.btn, padding: "6px 10px", fontSize: 12.5, color: FIRE.green }} disabled={busyId === r.id} onClick={() => approve(r)}>Approve</button>
          <button style={{ ...FS.btn, padding: "6px 10px", fontSize: 12.5, color: FIRE.deleteRed }} disabled={busyId === r.id} onClick={() => reject(r)}>Reject</button>
        </div>
      ))}
    </div>
  );
}
function Bar({ S, pct, color, track }) {
  return <div style={track ? { ...S.bar, background: track } : S.bar}><div style={{ ...S.barFill, width: `${pct}%`, background: color || "#1F4E79" }} /></div>;
}
function RosterAttendance({ S, members, sessions, plan }) {
  // Live 90-day participation — same deptAttendance calc as Reports (consistent numbers), rolling window.
  // Replaces the stale stored m.participation field for DISPLAY only (column + writes retired-in-place, drop later).
  const pctById = new Map(deptAttendance(members, sessions, null, rolling90()).rows.map((r) => [r.id, r.pct]));
  const people = [...members].sort((a, b) => (pctById.get(b.id) ?? -1) - (pctById.get(a.id) ?? -1));
  const activeMembers = (members || []).filter((m) => countsInStats(m) && m.status === "Active");
  const activeLeaders = activeMembers.filter((m) => isLeader(m.access));
  const recentEvents = (sessions || [])
    .filter((s) => s.done && (s.attendance || []).length > 0)   // real, roll-taken sessions
    .sort((a, b) => new Date(b.y, b.m, b.d) - new Date(a.y, a.m, a.d))   // newest first
    .slice(0, 6)
    .map((s) => ({
      id: s.id,
      name: s.title,
      date: new Date(s.y, s.m, s.d).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      category: (plan || []).find((p) => String(p.id) === String(s.planId))?.name || null,   // plan_id → training_plans.name
      present: (s.attendance || []).length,
      total: (s.audience === "leadership" ? activeLeaders : activeMembers).length,   // eligible = Active members under the audience rule
    }));
  return (
    <div>
      <div style={{ ...FS.kicker, marginBottom: 8 }}><CalendarCheck size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />RECENT EVENTS</div>
      <div style={{ ...FS.card, padding: "4px 16px", marginBottom: 22 }}>
        {recentEvents.length === 0 ? <div style={{ padding: "12px 2px", fontSize: 13, color: FIRE.textMuted }}>No recent events yet.</div> :
          recentEvents.map((e) => {
          const pct = e.total ? Math.min(100, Math.round((e.present / e.total) * 100)) : 0;   // cap display + bar at 100%; raw present/total shown as-is
          return (
            <div key={e.id} style={{ ...S.eventRow, borderBottom: `0.5px solid ${FIRE.hairline}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...S.personName, color: FIRE.textPrimary }}>{e.name}</div>
                <div style={{ ...S.personMeta, color: FIRE.textMuted, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                  <span>{e.date}</span>
                  {e.category && <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.3, color: FIRE.navLabel, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, borderRadius: 999, padding: "2px 7px" }}>{e.category}</span>}
                </div>
              </div>
              <div style={{ width: 130 }}><div style={{ fontSize: 12.5, color: FIRE.textSecondary, textAlign: "right" }}>{e.present}/{e.total} ({pct}%)</div><Bar S={S} pct={pct} track={FIRE.track} color={pct >= 75 ? FIRE.green : FIRE.amberText} /></div>
            </div>
          );
        })}
      </div>
      <div style={{ ...FS.kicker, marginBottom: 8 }}>MEMBER PARTICIPATION (LAST 90 DAYS)</div>
      <div style={{ ...FS.card, padding: "4px 16px" }}>
        {people.map((m) => {
          const p = pctById.get(m.id) ?? null;   // live 90-day pct (null = no eligible drills in window → "—")
          return (
          <div key={m.id} style={{ ...S.eventRow, borderBottom: `0.5px solid ${FIRE.hairline}` }}>
            <Initials S={S} dark name={m.name} />
            <div style={{ flex: 1, minWidth: 0, marginLeft: 11 }}><div style={{ ...S.personName, color: FIRE.textPrimary }}>{m.name}</div><div style={{ ...S.personMeta, color: FIRE.textMuted }}>{m.role}</div></div>
            <div style={{ width: 130 }}><div style={{ fontSize: 12.5, color: FIRE.textSecondary, textAlign: "right" }}>{p == null ? "—" : `${p}%`}</div>{p != null && <Bar S={S} pct={p} track={FIRE.track} color={p >= 75 ? FIRE.green : (p >= 50 ? FIRE.amberText : FIRE.redText)} />}</div>
          </div>
          );
        })}
      </div>
    </div>
  );
}
function RosterReports({ S, role, members, sessions, dept, back, meId, notify }) {
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const [presetKey, setPresetKey] = useState("year"); const [range, setRange] = useState(() => presetRange("year"));   // report period; default This Year (prior behavior)
  const cm = members.filter(countsInStats);   // counted members (owner/test excluded) — counts only; members stays full for names/identity
  const active = cm.filter((m) => m.status === "Active").length;
  const prob = cm.filter((m) => m.status === "Probationary").length;
  const certs = []; cm.forEach((m) => m.certs.forEach((c) => certs.push(certStatus(c.exp).rank)));
  const cur = certs.filter((r) => r === 2).length, expg = certs.filter((r) => r === 1).length, expd = certs.filter((r) => r === 0).length;
  const certPct = (cur + expg + expd) ? Math.round((cur / (cur + expg + expd)) * 100) : 0;   // cert currency — a SNAPSHOT (as of today), never range-scoped
  // Real attendance — shared deptAttendance calc, now RANGE-scoped (a period fact). Dashboards still call the year form.
  const { rows: attRows, avg: avgPart, doneThisYear: drills } = deptAttendance(members, sessions, null, range);
  const drillsHeld = drills.length;   // training sessions held (with attendance) during the period
  const attById = new Map(attRows.map((r) => [r.id, r.pct]));
  // Recent training — real recent DONE sessions with recorded attendance (drills only; no meetings/calls exist in the data).
  const sessMs = (s) => new Date(s.y, s.m, s.d).getTime();
  const recentTraining = (sessions || [])
    .filter((s) => s.done && (s.attendance || []).length > 0)
    .sort((a, b) => sessMs(b) - sessMs(a))
    .slice(0, 6)
    .map((s) => ({
      name: s.title,
      date: new Date(s.y, s.m, s.d).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      type: s.audience === "leadership" ? "Leadership training" : "Training",
      present: (s.attendance || []).length,
      total: s.audience === "leadership" ? cm.filter((m) => isLeader(m.access)).length : cm.length,
    }));
  const nameById = new Map((members || []).map((m) => [m.id, m.name]));
  // Flagged certs by member name — hoisted out of buildReportData so the screen, PDF, and narrative share ONE source (no drift).
  const flaggedCerts = [];
  cm.forEach((m) => m.certs.forEach((c) => {
    const st = certStatus(c.exp);
    if (st.rank < 2) flaggedCerts.push({ member: m.name, cert: c.name, exp: expPhrase(c.exp), status: st.rank === 0 ? "Lapsed" : "Expiring" });
  }));
  // Live dept context — the same real sources the agenda builder gathers (dept-scoped by RLS).
  const [duties, setDuties] = useState([]);
  const [pendingCerts, setPendingCerts] = useState([]);
  useEffect(() => {
    supabase.from("duties").select("id, duty, due_date, done, assigned_to").then(({ data }) => setDuties(data || []));
    supabase.from("cert_submissions").select("id, name, member_id").eq("status", "pending").then(({ data }) => setPendingCerts(data || []));
  }, []);
  // Period facts from the append-only / server-stamped LOCKED records (duty_log, action_items) — fetched once, counted by range.
  const [dutyLog, setDutyLog] = useState([]);
  const [resolvedActions, setResolvedActions] = useState([]);
  useEffect(() => {
    supabase.from("duty_log").select("done_at").then(({ data }) => setDutyLog(data || []));
    supabase.from("action_items").select("completed_at, cancelled_at, status").in("status", ["done", "cancelled"]).then(({ data }) => setResolvedActions(data || []));
  }, []);
  const inRange = (ts) => { if (!ts) return false; const iso = toISODate(new Date(ts)); return (!range.from || iso >= range.from) && (!range.to || iso <= range.to); };
  const dutiesDone = dutyLog.filter((d) => inRange(d.done_at)).length;                                                     // period
  const actionsResolved = resolvedActions.filter((a) => inRange(a.completed_at) || inRange(a.cancelled_at)).length;        // period
  const fmtRD = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
  const periodLabel = `${fmtRD(range.from)} – ${fmtRD(range.to)}`;
  const todayLabel = new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  const todayISO = toISODate(new Date());
  const openDuties = duties.filter((d) => !d.done);
  const overdueDuties = openDuties.filter((d) => d.due_date && d.due_date < todayISO);                                                 // due_date YYYY-MM-DD → string compare
  const upcoming = (sessions || []).filter((s) => !s.done && toISODate(sessDate(s)) >= todayISO).sort((a, b) => sessDate(a) - sessDate(b)).slice(0, 5);
  const Line = ({ children }) => <div style={{ fontSize: 12.5, color: FIRE.textSecondary, padding: "3px 0" }}>{children}</div>;
  const None = () => <div style={{ fontSize: 12.5, color: FIRE.textMuted, padding: "3px 0" }}>None.</div>;
  const SubHead = ({ children }) => <div style={{ fontSize: 11, fontWeight: 700, color: FIRE.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginTop: 10 }}>{children}</div>;
  function buildReportData() {
    return {
      deptName: dept?.name || "Department",
      station: "",
      kpis: { active, total: cm.length, certPct, certWarn: expd > 0, avgPart },
      counts: { active, prob, total: cm.length, cur, expg, expd, avgPart },
      period: { label: periodLabel, generated: todayLabel, drillsHeld, avgPart, dutiesDone, actionsResolved },   // PERIOD facts (during the range); counts above are the AS-OF-TODAY snapshot
      members: members.map((m) => ({ name: m.name, role: m.role, participation: attById.get(m.id), status: m.status })),
      flaggedCerts,
      activity: recentTraining,
      duties: [...openDuties].sort((a, b) => {
        const ao = a.due_date && a.due_date < todayISO, bo = b.due_date && b.due_date < todayISO;
        if (ao !== bo) return ao ? -1 : 1;                                  // overdue first
        return (a.due_date || "9999-99-99").localeCompare(b.due_date || "9999-99-99");   // then soonest due, no-due last
      }).map((d) => ({ duty: d.duty, due: d.due_date || "", who: nameById.get(d.assigned_to) || (d.assigned_to ? "Unassigned" : "Station-wide"), overdue: !!(d.due_date && d.due_date < todayISO) })),
      upcoming: upcoming.map((s) => ({ title: s.title, date: fmtSess(s), leadership: s.audience === "leadership" })),
      pendingCerts: pendingCerts.map((p) => ({ member: nameById.get(p.member_id) || "A member", cert: p.name })),
    };
  }
  async function draft() {
    setLoading(true); setErr(""); setOut("");
    const topN = (arr, fmt, n = 3) => {
      if (!arr.length) return "none";
      const shown = arr.slice(0, n).map(fmt).join("; ");
      const extra = arr.length - n;
      return extra > 0 ? `${shown}; …and ${extra} more` : shown;
    };
    const certUrgent = [...flaggedCerts].sort((a, b) => (a.status === "Lapsed" ? 0 : 1) - (b.status === "Lapsed" ? 0 : 1));   // expired/lapsed first
    const lines = [
      `${dept?.name || "Department"} — readiness & activity report. Use ONLY these facts; add nothing not listed.`,
      `Report period: ${periodLabel}. Today's date: ${todayLabel}.`,
      ``,
      `=== DURING THE REPORT PERIOD (${periodLabel}) — what happened in this window ===`,
      `Training sessions held (attendance recorded): ${drillsHeld}`,
      `Average training attendance during the period: ${avgPart}%`,
      `Duties completed: ${dutiesDone}`,
      `Action items resolved (completed or cancelled): ${actionsResolved}`,
      ``,
      `=== AS OF TODAY (${todayLabel}) — current status, NOT specific to the period above ===`,
      `Members: ${active} active, ${prob} probationary (${cm.length} total)`,
      `Certification currency: ${cur} current, ${expg} expiring within 90 days, ${expd} expired (${certPct}% current)`,
      `Flagged certifications (most urgent first): ${topN(certUrgent, (f) => `${f.member}'s ${f.cert} (${f.status.toLowerCase()}, ${f.exp})`)}`,
      `Overdue duties (most overdue first): ${topN(overdueDuties, (d) => `${d.duty} — ${nameById.get(d.assigned_to) || (d.assigned_to ? "unassigned" : "station-wide")}${d.due_date ? `, due ${d.due_date}` : ""}`)}`,
      `Upcoming training: ${topN(upcoming, (s) => `${s.title} on ${fmtSess(s)}`)}`,
      `Pending certification approvals: ${topN(pendingCerts, (p) => `${nameById.get(p.member_id) || "a member"}'s ${p.name}`)}`,
    ];
    const summary = lines.join("\n");
    const sys = "You write a concise, professional readiness and activity report for a volunteer fire department chief to share with the city council or board, drafted from the department's real records for a specific REPORT PERIOD. Structure it with clear bold section titles and short bullets: an Overview, Certifications, Duties, Training (recent and upcoming), and Recommended Next Steps.\n\nPERIOD vs. CURRENT — the data below is split into two labeled blocks. 'DURING THE REPORT PERIOD' facts describe what happened in the report window: narrate them as the period's activity and STATE THE REPORT PERIOD near the top. 'AS OF TODAY' facts are the department's CURRENT status (certification currency, roster) and are NOT specific to the period: narrate them as today's standing, and NEVER imply the current numbers describe the period — do not say attendance, certification, or roster levels were a certain value 'during the period' unless it is a DURING-THE-PERIOD fact. Keep the two clearly distinct so a reader always knows whether a number covers the period or today.\n\nMake it specific to THIS department: when the data names specific items — which certifications are expiring or expired and whose, which duties are overdue and who owns them, the dates of upcoming training, whose certifications are awaiting approval — name them. Specifics are what make it read like this department's report and not a generic template.\n\nCRITICAL — TRUTH GUARDRAIL: Use ONLY the facts provided in the data below. NEVER invent or infer a duty, certification, member name, date, count, or event that is not explicitly listed. Do not round, embellish, or add plausible-sounding detail. If a category says 'none', state plainly that there are none (for example, 'No duties are currently overdue') — do NOT manufacture items to fill a section. Where the data shows '…and N more', you may refer to that remaining count without naming them. The harm this prevents is real: a chief reads this to a city council, and a fabricated duty, certification, member name, or date is a false statement on the public record.\n\nKeep the certification window exactly as stated ('within 90 days') — do not change it. Confident, factual, plain tone. Under 400 words.";
    try { const t = await callClaude(sys, summary); setOut(t); } catch { setErr("Couldn't draft the report just now. Try again."); } finally { setLoading(false); }
  }
  const [saving, setSaving] = useState(false);
  async function saveReport() {
    if (!out) return;
    setSaving(true);
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { setSaving(false); notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
    const title = `Chief's Report — ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}`;
    const { error } = await supabase.from("ai_outputs").insert({ department_id: deptId, feature: "report", title, ai_text: out, created_by: meId });   // feature MUST be "report" → DA/PA-only INSERT branch
    setSaving(false);
    if (error) { notify({ kind: "error", title: "Couldn't save the report", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: "Report saved." });
    loadReports();   // refresh the saved-reports list
  }
  // --- Saved reports (persisted feature="report"; soft-deletable, inherits the Phase 1 failsafe) ---
  const [reports, setReports] = useState([]);
  const [openReport, setOpenReport] = useState(null);
  const [deletingId, setDeletingId] = useState(null);   // per-row soft-delete busy
  async function loadReports() {
    const { data } = await supabase.from("ai_outputs").select("*").eq("feature", "report").is("deleted_at", null);   // dept-scoped by RLS; hide soft-deleted
    setReports((data || []).sort((a, b) => (b.edited_at || b.created_at).localeCompare(a.edited_at || a.created_at)));   // newest first
  }
  useEffect(() => { loadReports(); }, []);
  async function softDelete(d) {
    if (!window.confirm("Delete this record? It moves to the trash and can be restored by an admin.")) return;
    setDeletingId(d.id);
    const { error } = await supabase.rpc("soft_delete_ai_output", { p_id: d.id });   // DB stamps deleted_at + identity (is_dept_admin gate)
    setDeletingId(null);
    if (error) { notify({ kind: "error", title: "Couldn't delete", text: "Something went wrong deleting that. Please try again.", details: error.message }); return; }
    loadReports();   // deleted row falls out via the .is("deleted_at", null) filter
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <button style={{ ...FS.btn, marginBottom: 14 }} onClick={back}><ArrowLeft size={15} /> Back to Reports</button>
      <div style={FS.kicker}>REPORTS · CHIEF'S REPORT</div>
      <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Chief's Report</h1>
      <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5, marginBottom: 14 }}>The board &amp; city readiness report — the chief's narrative over your locked, period-filtered facts.</div>
      <div style={{ marginBottom: 14 }}>
        <DateRangePicker S={S} range={range} setRange={setRange} presetKey={presetKey} setPresetKey={setPresetKey} />
        <div style={{ fontSize: 12.5, color: FIRE.textMuted, marginTop: 8 }}>Report period: <strong style={{ color: FIRE.textSecondary }}>{periodLabel}</strong> · Generated {todayLabel}</div>
      </div>
      <div style={{ ...FS.card, padding: "10px 16px", marginBottom: 14 }}>
        <div style={{ ...FS.kicker, marginBottom: 8 }}>DURING THIS PERIOD · {periodLabel}</div>
        <div style={{ display: "flex", gap: 20, flexWrap: "wrap" }}>
          <Stat S={S} dark n={String(drillsHeld)} label="Training sessions" />
          <Stat S={S} dark n={`${avgPart}%`} label="Avg attendance" />
          <Stat S={S} dark n={String(dutiesDone)} label="Duties completed" />
          <Stat S={S} dark n={String(actionsResolved)} label="Action items resolved" />
        </div>
      </div>
      <div style={S.statRow}>
        <Stat S={S} dark n={`${active}/${cm.length}`} label="Active members" />
        <Stat S={S} dark n={`${certPct}%`} label="Cert compliance" warn={expd > 0} />
      </div>
      <div style={{ ...FS.card, padding: "10px 16px", marginBottom: 14 }}>
        <div style={{ ...FS.kicker, marginBottom: 2 }}>AS OF TODAY · CURRENT STATUS</div>
        <SubHead>Duties — {openDuties.length} open · {overdueDuties.length} overdue</SubHead>
        {overdueDuties.length === 0 ? <None /> : overdueDuties.slice(0, 6).map((d) => <Line key={d.id}>⚠ {d.duty}{d.due_date ? ` · due ${d.due_date}` : ""}{d.assigned_to ? ` · ${nameById.get(d.assigned_to) || "Unassigned"}` : ""}</Line>)}
        <SubHead>Flagged certifications — {expd} expired · {expg} expiring</SubHead>
        {flaggedCerts.length === 0 ? <None /> : flaggedCerts.slice(0, 8).map((f, i) => <Line key={i}>{f.member} · {f.cert} · {f.exp} ({f.status})</Line>)}
        <SubHead>Upcoming training — {upcoming.length}</SubHead>
        {upcoming.length === 0 ? <None /> : upcoming.map((s) => <Line key={s.id}>{s.title} · {fmtSess(s)}{s.audience === "leadership" ? " · leadership" : ""}</Line>)}
        <SubHead>Pending cert proposals — {pendingCerts.length}</SubHead>
        {pendingCerts.length === 0 ? <None /> : pendingCerts.slice(0, 6).map((p) => <Line key={p.id}>{nameById.get(p.member_id) || "A member"} · {p.name}</Line>)}
      </div>
      <div style={{ ...S.aiBanner, ...FS.card, borderLeft: `3px solid ${FIRE.red}` }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}><BarChart3 size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />BOARD &amp; CITY REPORT</div>
          <h3 style={{ ...S.featTitle, color: FIRE.textPrimary }}>Turn your numbers into a report — in one tap</h3>
          <p style={{ ...S.helpP, color: FIRE.textMuted, marginBottom: 10 }}>The summary the chief usually hand-builds for the city, drafted from your current roster, certs, and participation.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={{ ...FS.btnPrimary, opacity: loading ? 0.7 : 1 }} onClick={draft} disabled={loading}>
              {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><BarChart3 size={16} /> Draft the report</>}
            </button>
            <button
              style={FS.btn}
              onClick={() => downloadDepartmentReport(buildReportData())}>
              <Download size={16} /> Download PDF
            </button>
            {isDeptAdmin(role) && out && (
              <button style={{ ...FS.btn, opacity: saving ? 0.7 : 1 }} onClick={saveReport} disabled={saving}>
                {saving ? <><Loader2 size={16} className="spin" /> Saving…</> : <><FileText size={16} /> Save report</>}
              </button>
            )}
          </div>
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
          {out && (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10, marginBottom: 6 }}>
                <div style={{ ...FS.kicker, marginBottom: 0 }}>DRAFT PREVIEW</div>
                <button title="Clear" style={{ ...FS.btn, padding: "5px 8px" }} onClick={() => { setOut(""); setErr(""); }}><X size={14} color={FIRE.deleteRed} /></button>
              </div>
              <RichOutput S={S} text={out} dark />
            </div>
          )}
        </div>
      </div>

      {/* SAVED REPORTS — persisted Chief's Reports (feature="report"); Open to view, DA/PA soft-delete. Mirrors the Minutes saved-drafts list. */}
      <div style={{ ...FS.kicker, marginBottom: 8, marginTop: 22 }}><FileText size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />SAVED REPORTS</div>
      <div style={{ ...FS.card, padding: "4px 16px", marginBottom: 8 }}>
        {reports.length === 0 ? <div style={{ fontSize: 13, color: FIRE.textMuted, padding: "10px 0" }}>No saved reports yet.</div> : reports.map((d) => {
          const cName = members.find((m) => m.id === d.created_by)?.name || "Unknown";
          const when = new Date(d.edited_at || d.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary }}>{d.title || "Chief's Report"}</div>
                <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num }}>{cName} · {when}</div>
              </div>
              <button style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }} onClick={() => setOpenReport(d)}>Open</button>
              {isDeptAdmin(role) && <button title="Delete" disabled={deletingId === d.id} style={{ ...FS.btn, padding: "5px 8px", fontSize: 11.5 }} onClick={() => softDelete(d)}><X size={14} color={FIRE.deleteRed} /></button>}
            </div>
          );
        })}
      </div>

      {openReport && (
        <div onClick={() => setOpenReport(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...FS.card, maxWidth: 720, width: "100%", padding: "18px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ ...FS.kicker, marginBottom: 0 }}>{openReport.title || "Chief's Report"}</div>
              <button style={{ ...FS.btn, padding: "6px 10px" }} onClick={() => setOpenReport(null)}><X size={14} color={FIRE.btnIcon} /></button>
            </div>
            <RichOutput S={S} text={openReport.current_text ?? openReport.ai_text} dark />
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Reports (leadership reporting hub) ---------------- */
// Container that holds many report "cards". Stage 1: Yearly Attendance (live) + Chief's Report (Stage 2 placeholder).
function Reports({ S, role, members, sessions, dept, meId, notify }) {
  const [view, setView] = useState(null);   // null = hub cards; "attendance" | "chief"
  if (view === "attendance") return <AttendanceReport S={S} members={members} sessions={sessions} dept={dept} back={() => setView(null)} />;
  if (view === "chief") return <RosterReports S={S} role={role} members={members} sessions={sessions} dept={dept} meId={meId} notify={notify} back={() => setView(null)} />;
  if (view === "actions") return <ActionItemsReport S={S} members={members} back={() => setView(null)} />;
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>REPORTS</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Reporting hub</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>The records your department gets audited on — attendance, readiness, and board reports — in one place.</div>
      </div>
      <div style={S.opGrid}>
        <div style={{ ...S.opCard, ...FS.card, cursor: "pointer" }} onClick={() => setView("attendance")}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <CalendarCheck size={18} color={FIRE.red} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ ...S.personName, color: FIRE.textPrimary }}>Yearly Attendance Report</div></div>
          </div>
          <div style={{ fontSize: 13, color: FIRE.textSecondary, marginTop: 7 }}>Full-year training attendance per member — the durable record for audits, not the rolling calendar view.</div>
          <div style={{ display: "flex", alignItems: "center", marginTop: 11 }}>
            <button style={{ ...FS.btn, marginLeft: "auto", padding: "7px 12px", fontSize: 12.5 }}>Open <ChevronRight size={14} /></button>
          </div>
        </div>
        <div style={{ ...S.opCard, ...FS.card, cursor: "pointer" }} onClick={() => setView("chief")}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <BarChart3 size={18} color={FIRE.red} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ ...S.personName, color: FIRE.textPrimary }}>Chief's Report</div></div>
          </div>
          <div style={{ fontSize: 13, color: FIRE.textSecondary, marginTop: 7 }}>The board &amp; city readiness report — drafted from your live roster, certifications, and attendance.</div>
          <div style={{ display: "flex", alignItems: "center", marginTop: 11 }}>
            <button style={{ ...FS.btn, marginLeft: "auto", padding: "7px 12px", fontSize: 12.5 }}>Open <ChevronRight size={14} /></button>
          </div>
        </div>
        <div style={{ ...S.opCard, ...FS.card, cursor: "pointer" }} onClick={() => setView("actions")}>
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <ClipboardCheck size={18} color={FIRE.red} style={{ flexShrink: 0, marginTop: 1 }} />
            <div style={{ flex: 1, minWidth: 0 }}><div style={{ ...S.personName, color: FIRE.textPrimary }}>Action Items</div></div>
          </div>
          <div style={{ fontSize: 13, color: FIRE.textSecondary, marginTop: 7 }}>The actual items behind the Chief's Report count — completed and cancelled for a date range, plus everything still open today.</div>
          <div style={{ display: "flex", alignItems: "center", marginTop: 11 }}>
            <button style={{ ...FS.btn, marginLeft: "auto", padding: "7px 12px", fontSize: 12.5 }}>Open <ChevronRight size={14} /></button>
          </div>
        </div>
      </div>
    </div>
  );
}
// Yearly attendance — per-member aggregation from sessions + session_attendance.
// Source pool excludes done drills with NO recorded attendance (roll never taken → missing data, not absence).
// eligible denominator is PER MEMBER (audience-aware): leadership-only events count only for leaders.
// ---- Shared date-range picker: presets + custom from/to → { from, to } (ISO) ----
function presetRange(key) {
  const now = new Date();
  const y = now.getFullYear();
  const p2 = (n) => String(n).padStart(2, "0");
  const iso = (yy, mm, dd) => `${yy}-${p2(mm)}-${p2(dd)}`;              // mm is 1-indexed
  const lastDay = (yy, mm) => new Date(yy, mm, 0).getDate();           // last day of month mm (1-indexed)
  if (key === "month")   { const m = now.getMonth() + 1; return { from: iso(y, m, 1), to: iso(y, m, lastDay(y, m)) }; }
  if (key === "quarter") { const q = Math.floor(now.getMonth() / 3), m1 = q * 3 + 1, m3 = q * 3 + 3; return { from: iso(y, m1, 1), to: iso(y, m3, lastDay(y, m3)) }; }
  if (key === "lastyear") return { from: iso(y - 1, 1, 1), to: iso(y - 1, 12, 31) };
  return { from: iso(y, 1, 1), to: iso(y, 12, 31) };                    // "year" (default)
}
const RANGE_PRESETS = [["month", "This Month"], ["quarter", "This Quarter"], ["year", "This Year"], ["lastyear", "Last Year"]];
function DateRangePicker({ S, range, setRange, presetKey, setPresetKey }) {
  const pick = (k) => { setPresetKey(k); setRange(presetRange(k)); };
  return (
    <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {RANGE_PRESETS.map(([k, label]) => {
          const on = presetKey === k;
          return <button key={k} onClick={() => pick(k)} style={{ ...FS.btn, padding: "7px 12px", fontSize: 12.5, ...(on ? { background: FIRE.btnBg, borderColor: FIRE.red, color: FIRE.textPrimary } : {}) }}>{label}</button>;
        })}
      </div>
      <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>From</span><input type="date" style={FS.input} value={range.from} onChange={(e) => { setPresetKey("custom"); setRange((r) => ({ ...r, from: e.target.value })); }} /></label>
      <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>To</span><input type="date" style={FS.input} value={range.to} onChange={(e) => { setPresetKey("custom"); setRange((r) => ({ ...r, to: e.target.value })); }} /></label>
    </div>
  );
}
function AttendanceReport({ S, members, sessions, dept, back }) {
  const [presetKey, setPresetKey] = useState("year");                  // default This Year (matches prior on-load behavior)
  const [range, setRange] = useState(() => presetRange("year"));
  const { rows: attRows, avg: avgPct, doneThisYear } = deptAttendance(members, sessions, null, range);   // range-filtered (dashboards still call the year form)
  const fmtD = (d) => d ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
  const rangeText = `${fmtD(range.from)} – ${fmtD(range.to)}`;
  const rows = [...attRows].sort((a, b) => (b.pct ?? -1) - (a.pct ?? -1));   // best rate first, unrated last (matches RosterAttendance)
  const pctColor = (p) => p == null ? FIRE.textMuted : p >= 75 ? FIRE.green : p >= 50 ? FIRE.amberText : FIRE.redText;
  const [detail, setDetail] = useState(false);      // false = summary view, true = by-session grid
  const [fullYear, setFullYear] = useState(false);  // grid scope: false = recent 10, true = all sessions in year
  const chron = [...doneThisYear].sort((a, b) => sessDate(a) - sessDate(b));   // chronological columns
  const gridCols = fullYear ? chron : chron.slice(-10);                        // screen default = recent 10 (CSV always exports full)
  // Audience-aware cell state — SAME predicate as the summary's eligible denominator, applied per session:
  const cellState = (r, s) => (r.leader || s.audience !== "leadership")
    ? ((s.attendance || []).includes(r.id) ? "present" : "absent")            // eligible → attended / eligible-but-absent
    : "na";                                                                    // not eligible → not expected (leadership session, non-leader)
  const CELL = { present: { ch: "✓", c: FIRE.green }, absent: { ch: "✗", c: FIRE.redText }, na: { ch: "—", c: FIRE.textMuted } };
  const colLabel = (s) => sessDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const csvField = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  function exportCsv() {
    // Section 1 — summary (unchanged)
    const sumHeader = ["Member", "Role", "Status", "Attended", "Eligible", "Attendance rate"];
    const sumBody = rows.map((r) => [r.name, r.role, r.status, r.attended, r.eligible, r.pct == null ? "—" : `${r.pct}%`]);
    // Section 2 — session-by-session grid; ALWAYS full year (chron), independent of the screen's recent/full toggle
    const cols = chron;
    const gridHeader = ["Member", ...cols.map((s) => colLabel(s) + (s.audience === "leadership" ? " (L)" : "")), "Total"];
    const gridBody = rows.map((r) => [r.name, ...cols.map((s) => ({ present: "P", absent: "A", na: "" }[cellState(r, s)])), `${r.attended}/${r.eligible}`]);
    const allRows = [
      sumHeader, ...sumBody,
      [],                                                        // blank line between the two sections
      [`Session-by-session — ${rangeText}`],
      gridHeader, ...gridBody,
      [],
      ["Legend: P = present, A = absent, blank = not expected (leadership session, non-leader), (L) = leadership session"],
    ];
    const csv = allRows.map((r) => r.map(csvField).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `attendance-${range.from}_to_${range.to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <button style={{ ...FS.btn, marginBottom: 14 }} onClick={back}><ArrowLeft size={15} /> Back to Reports</button>
      <div style={FS.kicker}>REPORTS · ATTENDANCE</div>
      <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Attendance Report</h1>
      <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5, marginBottom: 16 }}>Training attendance per member for {rangeText}. Each member's eligible total reflects the events they were expected at — leadership-only events count only for leaders.</div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 14, flexWrap: "wrap" }}>
        <DateRangePicker S={S} range={range} setRange={setRange} presetKey={presetKey} setPresetKey={setPresetKey} />
        <button style={{ ...FS.btn, marginLeft: "auto" }} onClick={exportCsv} disabled={doneThisYear.length === 0}><Download size={15} /> Download CSV</button>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
        <div style={S.segRow}>
          {[["summary", "Summary"], ["detail", "By session"]].map(([k, l]) => {
            const on = detail === (k === "detail");
            return <button key={k} onClick={() => setDetail(k === "detail")} style={{ ...S.segBtn, background: on ? FIRE.btnBg : "transparent", borderColor: on ? FIRE.red : FIRE.btnBorder, color: on ? FIRE.textPrimary : FIRE.navLabel }}>{l}</button>;
          })}
        </div>
        {detail && chron.length > 10 && (
          <button style={{ ...FS.btn, marginLeft: "auto", fontSize: 12 }} onClick={() => setFullYear((v) => !v)}>
            {fullYear ? `All ${chron.length} sessions · show recent 10` : `Recent 10 · expand to full range (${chron.length})`}
          </button>
        )}
      </div>

      <div style={S.statRow}>
        <Stat S={S} dark n={String(doneThisYear.length)} label="Drills held" />
        <Stat S={S} dark n={`${avgPct}%`} label="Avg attendance" />
        <Stat S={S} dark n={String(rows.length)} label="Members" />
      </div>

      {detail ? (
        <div style={{ ...FS.card, padding: "8px 0", marginTop: 14, overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12.5 }}>
            <thead>
              <tr>
                <th style={{ position: "sticky", left: 0, background: FIRE.card, textAlign: "left", padding: "6px 14px", color: FIRE.textMuted, fontWeight: 700, fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", zIndex: 1 }}>Member</th>
                {gridCols.map((s) => (
                  <th key={s.id} title={s.title} style={{ padding: "6px 9px", color: FIRE.textMuted, fontWeight: 700, fontSize: 11, whiteSpace: "nowrap" }}>
                    {colLabel(s)}{s.audience === "leadership" && <span style={{ color: FIRE.amberText }}> ·L</span>}
                  </th>
                ))}
                <th style={{ padding: "6px 12px", color: FIRE.textMuted, fontWeight: 700, fontSize: 11, whiteSpace: "nowrap" }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: `0.5px solid ${FIRE.hairline}` }}>
                  <td style={{ position: "sticky", left: 0, background: FIRE.card, padding: "7px 14px", fontWeight: 600, color: FIRE.textPrimary, whiteSpace: "nowrap", zIndex: 1 }}>{r.name}</td>
                  {gridCols.map((s) => { const c = CELL[cellState(r, s)]; return <td key={s.id} style={{ textAlign: "center", padding: "7px 9px", color: c.c, fontWeight: 700 }}>{c.ch}</td>; })}
                  <td style={{ textAlign: "center", padding: "7px 12px", ...FS.num, color: FIRE.textSecondary, whiteSpace: "nowrap" }}>{r.attended}/{r.eligible}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ fontSize: 11.5, color: FIRE.textMuted, padding: "8px 14px 2px" }}><span style={{ color: FIRE.green, fontWeight: 700 }}>✓</span> attended · <span style={{ color: FIRE.redText, fontWeight: 700 }}>✗</span> absent · <span style={{ fontWeight: 700 }}>—</span> not expected · <span style={{ color: FIRE.amberText }}>·L</span> leadership session</div>
        </div>
      ) : (
      <div style={{ ...FS.card, padding: "4px 16px", marginTop: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `0.5px solid ${FIRE.hairline}`, fontSize: 11, textTransform: "uppercase", letterSpacing: ".08em", color: FIRE.textMuted, fontWeight: 700 }}>
          <div style={{ flex: 1, minWidth: 0 }}>Member</div>
          <div style={{ width: 90, textAlign: "right" }}>Attended</div>
          <div style={{ width: 60, textAlign: "right" }}>Rate</div>
        </div>
        {rows.length === 0 ? <div style={{ fontSize: 13, color: FIRE.textMuted, padding: "12px 0" }}>No members to report.</div> : rows.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary }}>{r.name}</div>
              <div style={{ fontSize: 11.5, color: FIRE.textMuted }}>{r.role}</div>
            </div>
            <div style={{ width: 90, textAlign: "right", ...FS.num, fontSize: 13, color: FIRE.textSecondary }}>{r.attended} / {r.eligible}</div>
            <div style={{ width: 60, textAlign: "right", ...FS.num, fontSize: 13.5, fontWeight: 700, color: pctColor(r.pct) }}>{r.pct == null ? "—" : `${r.pct}%`}</div>
          </div>
        ))}
      </div>
      )}
      {doneThisYear.length === 0 && <div style={{ fontSize: 12.5, color: FIRE.textMuted, marginTop: 10 }}>No completed drills with recorded attendance for {rangeText} yet.</div>}
    </div>
  );
}

// Action Items report — the LIST behind the Chief's Report count.
// Completed/Cancelled are PERIOD FACTS (resolved in range); Still-open is a CURRENT SNAPSHOT
// (all currently-open items as of today, NOT range-filtered) — mirrors the Chief's period-vs-snapshot split.
function ActionItemsReport({ S, members, back }) {
  const DISPLAY = "'Oswald', system-ui, sans-serif";
  const [presetKey, setPresetKey] = useState("year");
  const [range, setRange] = useState(() => presetRange("year"));
  const [items, setItems] = useState(null);   // null = loading
  useEffect(() => {
    supabase.from("action_items").select("*").then(({ data }) => setItems(data || []));   // dept-scoped by RLS
  }, []);

  const nameById = new Map((members || []).map((m) => [m.id, m.name]));
  const todayISO = toISODate(new Date());
  const inRange = (ts) => { if (!ts) return false; const iso = toISODate(new Date(ts)); return (!range.from || iso >= range.from) && (!range.to || iso <= range.to); };
  const all = items || [];
  // Period facts: resolved IN range
  const completed = all.filter((it) => it.status === "done"      && inRange(it.completed_at)).sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""));
  const cancelled = all.filter((it) => it.status === "cancelled" && inRange(it.cancelled_at)).sort((a, b) => (b.cancelled_at || "").localeCompare(a.cancelled_at || ""));
  // Current snapshot: ALL currently-open, regardless of range
  const open      = all.filter((it) => it.status === "open").sort((a, b) => (a.due_date || "9999-99-99").localeCompare(b.due_date || "9999-99-99"));
  const nothing = !completed.length && !cancelled.length && !open.length;

  const fmtD  = (d)  => d  ? new Date(d + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
  const fmtTs = (ts) => ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
  const rangeText = `${fmtD(range.from)} – ${fmtD(range.to)}`;
  const assignee = (it) => it.assignee_name || (it.assigned_to ? (nameById.get(it.assigned_to) || "Unknown") : "Unassigned");   // snapshot → live → fallback (matches resolvedRow)

  const row = (it, kind) => {
    const overdue = kind === "open" && it.due_date && it.due_date < todayISO;
    const meta = kind === "done"      ? `Completed ${fmtTs(it.completed_at)} · ${assignee(it)}`
              : kind === "cancelled"  ? `Cancelled ${fmtTs(it.cancelled_at)} · ${assignee(it)} — ${it.cancel_reason || "no reason given"}`
              :                         `${assignee(it)}${it.due_date ? ` · due ${fmtD(it.due_date)}` : ""}${overdue ? " · OVERDUE" : ""}`;
    const icon = kind === "done"     ? <CheckCircle2 size={16} color={FIRE.green} style={{ flexShrink: 0 }} />
              : kind === "cancelled" ? <X size={16} color={FIRE.textMuted} style={{ flexShrink: 0 }} />
              :                        <Clock size={16} color={overdue ? FIRE.redText : FIRE.amberText} style={{ flexShrink: 0 }} />;
    return (
      <div key={it.id} style={{ ...S.certRow, borderBottom: `0.5px solid ${FIRE.hairline}` }}>
        {icon}
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: kind === "open" ? FIRE.textPrimary : FIRE.textMuted2, textDecoration: kind === "open" ? "none" : "line-through" }}>{it.text}</span>
          <div style={{ fontSize: 12, color: overdue ? FIRE.redText : FIRE.textMuted, marginTop: 1 }}>{meta}</div>
        </div>
      </div>
    );
  };

  const section = (title, count, note, rows, emptyText) => (
    <div style={{ ...FS.card, padding: "14px 16px", marginBottom: 12 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 15, color: FIRE.textPrimary }}>{title}</span>
        <span style={{ fontSize: 12, color: FIRE.textMuted }}>({count})</span>
        {note && <span style={{ marginLeft: "auto", fontSize: 11, color: FIRE.textMuted, fontStyle: "italic" }}>{note}</span>}
      </div>
      {rows.length ? rows : <div style={{ fontSize: 13, color: FIRE.textMuted }}>{emptyText}</div>}
    </div>
  );

  const csvField = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  function exportCsv() {
    const header = ["Status", "Action item", "Assignee", "Due date", "Created", "Resolved", "Reason"];
    const toRow = (it) => {
      const st = it.status === "done" ? "Completed" : it.status === "cancelled" ? "Cancelled" : "Open";
      const resolved = it.status === "done" ? fmtTs(it.completed_at) : it.status === "cancelled" ? fmtTs(it.cancelled_at) : "";
      const reason = it.status === "cancelled" ? (it.cancel_reason || "") : "";
      return [st, it.text, assignee(it), it.due_date ? fmtD(it.due_date) : "", fmtTs(it.created_at), resolved, reason];
    };
    const allRows = [
      [`Action items — ${rangeText}`],
      [`Completed & Cancelled = resolved in this range. Open = ALL currently-open items as of ${fmtD(todayISO)} (current snapshot, not range-filtered).`],
      [],
      header,
      ...completed.map(toRow),
      ...cancelled.map(toRow),
      ...open.map(toRow),   // included for the full board picture; Status column marks them Open
    ];
    const csv = allRows.map((r) => r.map(csvField).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = `action-items-${range.from}_to_${range.to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <button style={{ ...FS.btn, marginBottom: 14 }} onClick={back}><ArrowLeft size={15} /> Back to Reports</button>
      <div style={FS.kicker}>REPORTS · ACTION ITEMS</div>
      <h1 style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Action Items</h1>
      <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5, marginBottom: 16 }}>What got done, what was dropped, and what's still open. Completed &amp; cancelled are the items resolved during {rangeText}; still-open is a live snapshot as of today.</div>

      <div style={{ display: "flex", alignItems: "flex-end", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <DateRangePicker S={S} range={range} setRange={setRange} presetKey={presetKey} setPresetKey={setPresetKey} />
        <button style={{ ...FS.btn, marginLeft: "auto" }} onClick={exportCsv} disabled={nothing}><Download size={15} /> Download CSV</button>
      </div>

      {items === null ? (
        <div style={{ ...FS.card, padding: 24, color: FIRE.textMuted, display: "flex", alignItems: "center", gap: 10 }}><Loader2 size={16} className="spin" /> Loading action items…</div>
      ) : nothing ? (
        <div style={{ ...FS.card, padding: 24, color: FIRE.textMuted }}>No action items resolved in this period, and none currently open.</div>
      ) : (<>
        {section("✓ Completed (in range)", completed.length, null, completed.map((it) => row(it, "done")), "None completed in this period.")}
        {section("✕ Cancelled (in range)", cancelled.length, null, cancelled.map((it) => row(it, "cancelled")), "None cancelled in this period.")}
        {section("○ Still open", open.length, `current snapshot — as of ${fmtD(todayISO)}`, open.map((it) => row(it, "open")), "Nothing currently open.")}
      </>)}
    </div>
  );
}

/* ---------------- Apparatus ---------------- */
const APPARATUS_TYPES = ["Pumper", "Tender / Tanker", "Brush truck", "Rescue", "Ladder / Aerial", "Squad", "Command", "Ambulance", "Other"];
function Apparatus({ S, role, members, meId, notify }) {
  const [rigs, setRigs] = useState([]);
  const canManage = hasAny(role, CANMANAGE_OPS_ROLES);   // DA/Officer — matches the is_canmanage_ops DB RLS on apparatus INSERT/DELETE
  const [adding, setAdding] = useState(false);
  const [nm, setNm] = useState(""); const [tp, setTp] = useState("Pumper"); const [rd, setRd] = useState("Ready");
  const [editingRigId, setEditingRigId] = useState(null);   // which rig is in inline edit (separate from maintenance)
  const [rigBuf, setRigBuf] = useState({ name: "", type: "Pumper" });
  const nameById = new Map((members || []).map((m) => [m.id, m.name]));
  const loadRigs = () => {
    supabase.from("apparatus")
      .select("id, name, type, status, note, last_check_at, checked_by")
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (error || !data) return;
        setRigs(data.map((r) => ({
          id: r.id, name: r.name, type: r.type, status: r.status, note: r.note || "",
          lastCheck: r.last_check_at ? new Date(r.last_check_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—",
          by: r.checked_by ? (nameById.get(r.checked_by) || "A member") : "—",
        })));
      });
  };
  useEffect(() => { loadRigs(); }, [members]);   // reload once members resolves so checked_by → name populates
  const ready = rigs.filter((r) => r.status === "Pass").length;
  const flagged = rigs.length - ready;
  async function logCheck(id, status, note) {
    const { data, error } = await supabase.from("apparatus").update({ status, note, last_check_at: new Date().toISOString(), checked_by: meId }).eq("id", id).select();
    if (error || !data || data.length === 0) { notify({ kind: "error", title: "Couldn't log the check", text: "Something went wrong updating that — please try again.", details: error?.message }); return; }   // .select() + 0-row guard: a silent RLS block fails loudly, not as false success
    loadRigs();   // refetch — UI matches true DB state
  }
  function startEditRig(r) { setEditingRigId(r.id); setRigBuf({ name: r.name || "", type: r.type || "Pumper" }); }
  async function saveEditRig(id) {
    if (!rigBuf.name.trim()) return;
    const { data, error } = await supabase.from("apparatus").update({ name: rigBuf.name.trim(), type: rigBuf.type }).eq("id", id).select();
    if (error || !data || data.length === 0) { notify({ kind: "error", title: "Couldn't save the apparatus", text: "Something went wrong updating that — please try again.", details: error?.message }); return; }   // .select() + 0-row guard: silent RLS block fails loudly
    setEditingRigId(null); loadRigs();
  }
  async function addRig() {
    if (!nm.trim()) return;
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "Please try again.", details: deptErr?.message }); return; }
    const { error } = await supabase.from("apparatus").insert({ department_id: deptId, name: nm.trim(), type: tp, status: rd === "Ready" ? "Pass" : "Needs attention", note: rd === "Ready" ? "" : "Newly added — needs a check", last_check_at: null, checked_by: null });
    if (error) { notify({ kind: "error", title: "Couldn't add the apparatus", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setNm(""); setTp("Pumper"); setRd("Ready"); setAdding(false); loadRigs();
  }
  async function removeRig(id, name) {
    if (!window.confirm(`Take "${name}" out of the station? This removes it from the apparatus list.`)) return;
    const { error } = await supabase.from("apparatus").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove the apparatus", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadRigs();   // refetch — UI matches true DB state
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>APPARATUS & EQUIPMENT</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Know your rigs are ready</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>{canManage ? "Add the apparatus in your station, pull what's no longer here, and log checks so the whole crew can see what's good to roll." : "Log your apparatus and equipment checks so the whole crew can see what's good to roll."}</div>
      </div>
      <div style={S.statRow}>
        <Stat S={S} dark n={String(ready)} label="Ready to roll" />
        <Stat S={S} dark n={String(flagged)} label="Needs attention" warn={flagged > 0} />
        <Stat S={S} dark n={String(rigs.length)} label="Apparatus in station" />
      </div>
      {canManage && (adding ? (
        <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...S.field, flex: 1, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Name / unit</span><input style={FS.input} value={nm} placeholder="e.g. Engine 2" onChange={(e) => setNm(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Type</span><select style={FS.input} value={tp} onChange={(e) => setTp(e.target.value)}>{APPARATUS_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
          <label style={{ ...S.field, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Status</span><select style={FS.input} value={rd} onChange={(e) => setRd(e.target.value)}><option>Ready</option><option>Needs attention</option></select></label>
          <button style={FS.btnPrimary} onClick={addRig}><Plus size={15} /> Add to station</button>
          <button style={FS.btn} onClick={() => { setAdding(false); setNm(""); }}>Cancel</button>
        </div>
      ) : <button style={{ ...FS.btn, marginBottom: 12 }} onClick={() => setAdding(true)}><Plus size={15} /> Add apparatus</button>)}
      {rigs.length === 0 ? (
        <div style={{ ...S.opCard, ...FS.card, textAlign: "center", color: FIRE.textMuted, fontSize: 14 }}>
          <Truck size={22} color={FIRE.textMuted2} style={{ marginBottom: 6 }} />
          <div>No apparatus in the station yet.{canManage ? " Use “Add apparatus” to build your list." : ""}</div>
        </div>
      ) : (
      <div style={S.opGrid}>
        {rigs.map((r) => {
          const ok = r.status === "Pass"; const color = ok ? FIRE.green : FIRE.redBright;
          return (
            <div key={r.id} style={{ ...S.opCard, ...FS.card }}>
              <div style={{ display: "flex", gap: 11, alignItems: "center" }}>
                <Truck size={20} color={FIRE.btnIcon} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ ...S.personName, color: FIRE.textPrimary }}>{r.name}</div><div style={{ ...S.personMeta, color: FIRE.textMuted }}>{r.type}</div></div>
                <Pill S={S} color={color}>{ok ? "READY" : "FLAG"}</Pill>
                {canManage && <button title="Edit" style={{ ...FS.btn, padding: "6px 8px", marginLeft: 4 }} onClick={() => startEditRig(r)}><Pencil size={14} color={FIRE.textSecondary} /></button>}
                {canManage && <button title="Take out of station" style={{ ...FS.btn, padding: "6px 8px", marginLeft: 4 }} onClick={() => removeRig(r.id, r.name)}><X size={14} color={FIRE.deleteRed} /></button>}
              </div>
              {r.note && <div style={{ fontSize: 13, color: ok ? FIRE.textSecondary : FIRE.redText, marginTop: 10 }}>{r.note}</div>}
              <div style={{ display: "flex", alignItems: "center", marginTop: 11, fontSize: 12, color: FIRE.textMuted }}>
                <span>Last check: {r.lastCheck} · {r.by}</span>
                <div style={{ display: "flex", gap: 8, marginLeft: "auto" }}>
                  <button style={{ ...FS.btn, padding: "7px 12px", fontSize: 12.5 }} onClick={() => logCheck(r.id, "Pass", "Checked — all good")}><ClipboardCheck size={14} /> Pass</button>
                  <button style={{ ...FS.btn, padding: "7px 12px", fontSize: 12.5 }} onClick={() => { const n = window.prompt("What needs attention on this rig? (short note)"); if (n === null) return; logCheck(r.id, "Needs attention", n.trim() || "Flagged — needs attention"); }}><AlertTriangle size={14} color={FIRE.redText} /> Needs attention</button>
                </div>
              </div>
              {editingRigId === r.id && (
                <div style={{ ...FS.card, padding: 14, marginTop: 6, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                  <label style={{ ...S.field, flex: 1, minWidth: 170 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Name</span><input style={FS.input} value={rigBuf.name} onChange={(e) => setRigBuf((b) => ({ ...b, name: e.target.value }))} /></label>
                  <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Type</span><select style={FS.input} value={rigBuf.type} onChange={(e) => setRigBuf((b) => ({ ...b, type: e.target.value }))}>{APPARATUS_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
                  <button style={FS.btnPrimary} onClick={() => saveEditRig(r.id)}><CheckCircle2 size={15} /> Save</button>
                  <button style={FS.btn} onClick={() => setEditingRigId(null)}>Cancel</button>
                </div>
              )}
            </div>
          );
        })}
      </div>
      )}
      <MaintenancePanel S={S} role={role} rigs={rigs} notify={notify} />
    </div>
  );
}

/* ---------------- Maintenance reminders + checklists ---------------- */
const MAINT_CADENCE_DAYS = { Weekly: 7, Monthly: 30, Quarterly: 90, Annual: 365 };
// Compute a maintenance item's status from cadence + when it was last done (status is NOT stored).
function maintStatus(cadence, lastDoneAt) {
  const interval = MAINT_CADENCE_DAYS[cadence] || 30;
  if (!lastDoneAt) return "Due soon";                 // never done → needs doing, but not "Overdue" on a fresh add
  const days = (Date.now() - new Date(lastDoneAt).getTime()) / 86400000;
  if (days > interval) return "Overdue";              // past the full interval
  if (days >= interval * 0.8) return "Due soon";      // within the last 20% before it's due
  return "Current";
}
const MAINT_COLOR = { Overdue: "#B11E2A", "Due soon": "#9A6B12", Current: "#2E7D52" };
const MAINT_FIRE = { Overdue: FIRE.redText, "Due soon": FIRE.amberText, Current: FIRE.greenText };
function MaintenancePanel({ S, role, rigs, notify }) {
  const canManage = hasAny(role, CANMANAGE_OPS_ROLES);   // DA/Officer — matches is_canmanage_ops INSERT/DELETE RLS on apparatus_maintenance
  const [items, setItems] = useState([]);
  const [adding, setAdding] = useState(false);
  const [u, setU] = useState(rigs[0]?.name || "All units"); const [t, setT] = useState(""); const [cad, setCad] = useState("Monthly");
  const [editingMaintId, setEditingMaintId] = useState(null);   // which maintenance item is in inline edit (separate from rigs)
  const [maintBuf, setMaintBuf] = useState({ task: "", cadence: "Monthly" });
  const rigNameById = new Map((rigs || []).map((r) => [r.id, r.name]));
  const loadMaint = () => {
    supabase.from("apparatus_maintenance")
      .select("id, rig_id, task, cadence, last_done_at")
      .order("created_at", { ascending: true })
      .then(({ data, error }) => {
        if (error || !data) return;
        setItems(data.map((r) => ({
          id: r.id, rigId: r.rig_id,
          unit: r.rig_id ? (rigNameById.get(r.rig_id) || "Unknown unit") : "All units",
          task: r.task, cadence: r.cadence,
          last: r.last_done_at ? new Date(r.last_done_at).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "—",
          status: maintStatus(r.cadence, r.last_done_at),
        })));
      });
  };
  useEffect(() => { loadMaint(); }, [rigs]);   // reload when rigs load/change so rig_id → unit name resolves
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const order = { Overdue: 0, "Due soon": 1, Current: 2 };
  const sorted = [...items].sort((a, b) => order[a.status] - order[b.status]);
  const due = items.filter((i) => i.status !== "Current").length;
  async function markDone(id) {
    const { data, error } = await supabase.from("apparatus_maintenance").update({ last_done_at: new Date().toISOString() }).eq("id", id).select();
    if (error || !data || data.length === 0) { notify({ kind: "error", title: "Couldn't mark it done", text: "Something went wrong updating that — please try again.", details: error?.message }); return; }   // .select() + 0-row guard: silent RLS block fails loudly
    loadMaint();
  }
  function startEditMaint(i) { setEditingMaintId(i.id); setMaintBuf({ task: i.task || "", cadence: i.cadence || "Monthly" }); }
  async function saveEditMaint(id) {
    if (!maintBuf.task.trim()) return;
    const { data, error } = await supabase.from("apparatus_maintenance").update({ task: maintBuf.task.trim(), cadence: maintBuf.cadence }).eq("id", id).select();
    if (error || !data || data.length === 0) { notify({ kind: "error", title: "Couldn't save the item", text: "Something went wrong updating that — please try again.", details: error?.message }); return; }   // .select() + 0-row guard: silent RLS block fails loudly
    setEditingMaintId(null); loadMaint();
  }
  async function addItem() {
    if (!t.trim()) return;
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "Please try again.", details: deptErr?.message }); return; }
    const rigId = u === "All units" ? null : (rigs.find((r) => r.name === u)?.id || null);   // "All units" → null; else selected rig's id
    const { error } = await supabase.from("apparatus_maintenance").insert({ department_id: deptId, rig_id: rigId, task: t.trim(), cadence: cad, last_done_at: null });
    if (error) { notify({ kind: "error", title: "Couldn't add the item", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setT(""); setAdding(false); loadMaint();
  }
  async function removeItem(id) {
    const { error } = await supabase.from("apparatus_maintenance").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove that", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadMaint();
  }
  async function draftChecklist() {
    setLoading(true); setErr(""); setOut("");
    const fleet = rigs.map((r) => `${r.name} (${r.type})`).join(", ") || "the department's apparatus";
    const sys = "You draft a practical preventive-maintenance checklist for a small volunteer fire department's apparatus, grouped by cadence (Weekly, Monthly, Annual). Keep it realistic for a volunteer crew and note that a qualified person should perform and sign off each item, and that manufacturer and NFPA intervals govern. This is a DRAFT to review and adapt. Under 320 words, plain headers and bullets.";
    try { const x = await callClaude(sys, `Apparatus: ${fleet}. Draft a maintenance checklist.`); setOut(x); }
    catch { setErr("Couldn't draft the checklist just now. Try again."); } finally { setLoading(false); }
  }
  return (
    <div style={{ marginTop: 22 }}>
      <div style={{ ...FS.kicker, marginBottom: 8 }}><Wrench size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />MAINTENANCE & REMINDERS</div>
      <div style={{ fontSize: 13, color: due > 0 ? FIRE.red : FIRE.greenText, margin: "2px 0 12px", fontWeight: 600 }}>
        {due > 0 ? `${due} maintenance item${due === 1 ? "" : "s"} need attention` : "All maintenance up to date"}
      </div>
      {canManage && (adding ? (
        <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...S.field, minWidth: 130 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Unit</span><select style={FS.input} value={u} onChange={(e) => setU(e.target.value)}>{[...rigs.map((r) => r.name), "All units"].map((nm) => <option key={nm}>{nm}</option>)}</select></label>
          <label style={{ ...S.field, flex: 1, minWidth: 160 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Task</span><input style={FS.input} value={t} placeholder="e.g. Hose pressure test" onChange={(e) => setT(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 120 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Cadence</span><select style={FS.input} value={cad} onChange={(e) => setCad(e.target.value)}><option>Weekly</option><option>Monthly</option><option>Quarterly</option><option>Annual</option></select></label>
          <button style={FS.btnPrimary} onClick={addItem}><Plus size={15} /> Add</button>
          <button style={FS.btn} onClick={() => setAdding(false)}>Cancel</button>
        </div>
      ) : <button style={{ ...FS.btn, marginBottom: 12 }} onClick={() => setAdding(true)}><Plus size={15} /> Add maintenance item</button>)}
      <div>
        {sorted.map((i) => (
          <div key={i.id} style={{ ...S.certRow, flexWrap: "wrap", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
            <Wrench size={15} color={MAINT_FIRE[i.status]} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{i.task}</span> <span style={{ color: FIRE.textMuted, fontSize: 13 }}>· {i.unit}</span>
              <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 1 }}>{i.cadence} · last done {i.last}</div>
            </div>
            <Pill S={S} color={MAINT_FIRE[i.status]}>{i.status.toUpperCase()}</Pill>
            <button style={{ ...FS.btn, padding: "7px 12px", fontSize: 12.5 }} onClick={() => markDone(i.id)}><ClipboardCheck size={14} /> Mark done</button>
            {canManage && <button title="Edit" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => startEditMaint(i)}><Pencil size={14} color={FIRE.textSecondary} /></button>}
            {canManage && <button title="Remove" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => removeItem(i.id)}><X size={14} color={FIRE.deleteRed} /></button>}
            {editingMaintId === i.id && (
              <div style={{ ...FS.card, padding: 14, marginTop: 8, width: "100%", display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label style={{ ...S.field, flex: 1, minWidth: 170 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Task</span><input style={FS.input} value={maintBuf.task} onChange={(e) => setMaintBuf((b) => ({ ...b, task: e.target.value }))} /></label>
                <label style={{ ...S.field, minWidth: 120 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Cadence</span><select style={FS.input} value={maintBuf.cadence} onChange={(e) => setMaintBuf((b) => ({ ...b, cadence: e.target.value }))}><option>Weekly</option><option>Monthly</option><option>Quarterly</option><option>Annual</option></select></label>
                <button style={FS.btnPrimary} onClick={() => saveEditMaint(i.id)}><CheckCircle2 size={15} /> Save</button>
                <button style={FS.btn} onClick={() => setEditingMaintId(null)}>Cancel</button>
              </div>
            )}
          </div>
        ))}
      </div>
      {canManage && (
        <div style={{ ...S.aiBanner, ...FS.card, borderLeft: `3px solid ${FIRE.red}`, marginTop: 16 }}>
          <div style={{ flex: 1 }}>
            <div style={{ ...FS.kicker, marginBottom: 8 }}><Sparkles size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />AI MAINTENANCE CHECKLIST</div>
            <h3 style={{ ...S.featTitle, color: FIRE.textPrimary }}>Draft a preventive-maintenance checklist</h3>
            <p style={{ ...S.helpP, color: FIRE.textMuted, marginBottom: 10 }}>A starting checklist for your rigs, grouped by cadence. A qualified person still performs and signs off each item.</p>
            <button style={{ ...FS.btnPrimary, opacity: loading ? 0.7 : 1 }} onClick={draftChecklist} disabled={loading}>
              {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><Wrench size={16} /> Draft a checklist</>}
            </button>
            {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
            {out && <RichOutput S={S} text={out} dark />}
          </div>
        </div>
      )}
    </div>
  );
}
/* ---------------- Meeting Minutes + Action Items ---------------- */
function Minutes({ S, role, notify, dept, meId, members, sessions, initialMode }) {
  const [mode, setMode] = useState(() => (initialMode === "agenda" || initialMode === "minutes" || initialMode === "action-items") ? (initialMode === "action-items" ? "minutes" : initialMode) : "agenda");   // role-guarded deep-link seed (via go("minutes", mode)); "action-items" opens the Minutes tab
  const scrollToActions = initialMode === "action-items";
  const actionItemsRef = useRef(null);
  useEffect(() => {
    if (scrollToActions && mode === "minutes") {
      const t = setTimeout(() => actionItemsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 60);   // let the Minutes branch paint first
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Cert compliance computed HERE in the host from members — SAME certStatus math as the Chief's Report & Roster, so the agenda's numbers match (no drift).
  const certRows = [];
  (members || []).forEach((m) => (m.certs || []).forEach((c) => { const st = certStatus(c.exp); certRows.push({ member: m.name, cert: c.name, phrase: expPhrase(c.exp), rank: st.rank }); }));
  const certContext = { expired: certRows.filter((r) => r.rank === 0), expiring: certRows.filter((r) => r.rank === 1) };
  const [title, setTitle] = useState("Monthly Business Meeting");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const [extracting, setExtracting] = useState(false);
  const [saving, setSaving] = useState(false); const [saveTitle, setSaveTitle] = useState("");
  const [drafts, setDrafts] = useState([]); const [openDraft, setOpenDraft] = useState(null);
  const [editing, setEditing] = useState(false); const [editBuf, setEditBuf] = useState(""); const [savingEdit, setSavingEdit] = useState(false);
  const [review, setReview] = useState([]); const [creating, setCreating] = useState(false);
  const [showDone, setShowDone] = useState(false);   // Completed section — collapsed by default
  const canManage = hasAny(role, CANMANAGE_ROLES);   // create action_items is a write → CANMANAGE (matches is_canmanage())
  // Map an AI-suggested owner name to a member id — CONSERVATIVE: exact, else a single unambiguous first/last-name token, else blank.
  function matchOwnerId(name) {
    const n = (name || "").trim().toLowerCase();
    if (!n) return "";
    const exact = members.filter((m) => isAssignable(m) && (m.name || "").toLowerCase() === n);
    if (exact.length === 1) return exact[0].id;
    const tok = members.filter((m) => isAssignable(m) && (m.name || "").toLowerCase().split(/\s+/).includes(n));
    if (tok.length === 1) return tok[0].id;
    return "";
  }
  const normalizeDate = (s) => (typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s.trim())) ? s.trim() : "";   // only a clean YYYY-MM-DD pre-fills the picker
  const [items, setItems] = useState([]);
  const nameById = new Map((members || []).map((m) => [m.id, m.name]));
  const openItems = items.filter((i) => i.status === "open");                                   // only open — done AND cancelled are excluded from the active list
  const doneItems = items.filter((i) => i.status === "done");                                   // completed only — for the CSV export
  const resolvedItems = items.filter((i) => i.status === "done" || i.status === "cancelled");   // completed OR cancelled → the history split
  const GRACE_MS = 14 * 24 * 60 * 60 * 1000;   // 14-day reopen grace — mirrors the reopen_action_item DB lock
  const resolvedAt = (i) => i.completed_at || i.cancelled_at;                                    // whichever outcome stamp is set (an item is one or the other)
  const isArchived = (i) => resolvedAt(i) && (Date.now() - new Date(resolvedAt(i)).getTime()) >= GRACE_MS;
  const recentResolved = resolvedItems.filter((i) => !isArchived(i));   // within grace — reopenable
  const archivedResolved = resolvedItems.filter(isArchived);            // past grace — read-only, permanent
  const open = openItems.length;
  async function draft() {
    if (!notes.trim()) { setErr("Add a few rough notes first and I'll shape them into minutes."); return; }
    setLoading(true); setErr(""); setOut("");
    const sys = "You turn a volunteer fire department's rough meeting notes into clean, structured DRAFT minutes for the secretary and board to review and approve. Use plain headers: Attendees, Old Business, New Business, Decisions, and Action Items (each action with an owner and a due date if implied). Keep it factual to the notes — never invent attendance, votes, or decisions that aren't there. Under 350 words.";
    try { const t = await callClaude(sys, `Meeting: ${title}${date ? ` on ${date}` : ""}\nRough notes:\n${notes}`); setOut(t); setSaveTitle(title.trim().slice(0, 60) || `Minutes · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`); }
    catch { setErr("Couldn't draft the minutes just now. Try again."); } finally { setLoading(false); }
  }
  async function saveDraft() {
    if (!out || !saveTitle.trim()) return;
    setSaving(true);
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { setSaving(false); notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
    const { error } = await supabase.from("ai_outputs").insert({ department_id: deptId, feature: "minutes", title: saveTitle.trim(), ai_text: out, created_by: meId });
    setSaving(false);
    if (error) { notify({ kind: "error", title: "Couldn't save the minutes", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: "Minutes saved." });
    loadDrafts();
  }
  async function loadDrafts() {
    const { data } = await supabase.from("ai_outputs").select("*").eq("feature", "minutes").is("deleted_at", null);   // dept-scoped by RLS; hide soft-deleted
    setDrafts((data || []).sort((a, b) => (b.edited_at || b.created_at).localeCompare(a.edited_at || a.created_at)));   // coalesce(edited_at, created_at) desc
  }
  const [deletingId, setDeletingId] = useState(null);   // per-row soft-delete busy
  async function softDelete(d) {
    if (!window.confirm("Delete this record? It moves to the trash and can be restored by an admin.")) return;
    setDeletingId(d.id);
    const { error } = await supabase.rpc("soft_delete_ai_output", { p_id: d.id });   // DB stamps deleted_at + identity (is_dept_admin gate)
    setDeletingId(null);
    if (error) { notify({ kind: "error", title: "Couldn't delete", text: "Something went wrong deleting that. Please try again.", details: error.message }); return; }
    loadDrafts();   // deleted row falls out via the .is("deleted_at", null) filter
  }
  useEffect(() => { loadDrafts(); }, []);
  function closeDraft() { setOpenDraft(null); setEditing(false); setEditBuf(""); }
  function reopen(d) { setEditing(false); setEditBuf(""); setOpenDraft(d); }
  function startEdit() { setEditBuf(openDraft.current_text ?? openDraft.ai_text ?? ""); setEditing(true); }
  async function saveEdit() {
    if (!editBuf.trim()) return;
    setSavingEdit(true);
    const { data, error } = await supabase.from("ai_outputs")
      .update({ current_text: editBuf, edited_by: meId, edited_at: new Date().toISOString() })   // ai_text left pristine — original minutes are the liability record
      .eq("id", openDraft.id).select().single();
    setSavingEdit(false);
    if (error) { notify({ kind: "error", title: "Couldn't save your edit", text: "Something went wrong saving your changes. Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: "Changes saved." });
    setOpenDraft(data); setEditing(false); setEditBuf(""); loadDrafts();
  }
  // Crash-safe parse of the AI's extraction response. Returns an array (possibly empty for a valid "no items"),
  // or null on total failure so extractActions() shows the friendly "add manually" message. NEVER throws.
  function parseActionItems(raw) {
    if (typeof raw !== "string" || !raw.trim()) return null;
    // 1) strip code fences (```json … ``` or ``` … ```)
    const t = raw.replace(/```json/gi, "").replace(/```/g, "").trim();
    // 2) parse whole string; on failure, fall back to the outermost { … } block (tolerates preamble/postamble text)
    let parsed = null;
    try { parsed = JSON.parse(t); }
    catch {
      const m = t.match(/\{[\s\S]*\}/);
      if (m) { try { parsed = JSON.parse(m[0]); } catch { parsed = null; } }
    }
    // 3) accept {items:[…]} OR a bare […]; anything else → total failure → null
    const arr = Array.isArray(parsed) ? parsed : (Array.isArray(parsed?.items) ? parsed.items : null);
    if (!arr) return null;
    // 4) per-item sanitize: task must be a non-empty string; owner/date coerced to trimmed-string-or-null; drop malformed items (never throw)
    const str = (v) => (typeof v === "string" && v.trim()) ? v.trim() : null;
    const clean = [];
    for (const it of arr) {
      if (!it || typeof it !== "object") continue;                 // drop non-objects
      const task = typeof it.task === "string" ? it.task.trim() : "";
      if (!task) continue;                                          // no task → drop, don't crash
      clean.push({ task, suggested_owner: str(it.suggested_owner), suggested_due_date: str(it.suggested_due_date) });
    }
    return clean;                                                   // [] is valid (empty extraction) — distinct from null (parse failure)
  }
  async function extractActions() {
    if (!out.trim()) return;
    setExtracting(true); setErr("");
    const sys = "You extract the ACTION ITEMS from a volunteer fire department's approved meeting minutes, so they can be tracked. Return ONLY the concrete action items that were actually decided or assigned in the minutes — tasks someone agreed to do.\n\nRespond with ONLY one valid JSON object, no markdown, no code fences, no commentary before or after. Schema: {\"items\":[{\"task\":string,\"suggested_owner\":string|null,\"suggested_due_date\":string|null}]}.\n- task: the action, stated concisely (for example, 'Get a vendor quote for the Engine 2 pump repair').\n- suggested_owner: the person's name ONLY if the minutes name who is responsible; otherwise null. Do NOT guess or infer an owner — if the minutes say 'someone should follow up', suggested_owner is null.\n- suggested_due_date: a date ONLY if the minutes state one (YYYY-MM-DD if you can determine it, otherwise the date text as written); if no date is stated, null. Do NOT invent a deadline.\n\nCRITICAL — TRUTH GUARDRAIL: Extract ONLY action items actually present in the minutes. NEVER invent a task, an owner, or a date that is not there. These become real assigned work — a fabricated item, or a guessed owner, assigns someone a job they never agreed to. Suggest an owner or date ONLY when the minutes state it; leave it null otherwise for a human to fill in. If the minutes contain no action items, return {\"items\":[]}. Do not include discussion, decisions, or announcements that are not action items.";
    try {
      const raw = await callClaude(sys, out);
      const items = parseActionItems(raw);
      if (items === null) { setErr("Couldn't read the extracted items — please add them manually below."); return; }
      setReview(items.map((it, i) => ({ id: Date.now() + i, task: it.task, ownerId: matchOwnerId(it.suggested_owner), due: normalizeDate(it.suggested_due_date), keep: true })));
    } catch { setErr("Couldn't extract action items just now. Try again, or add them manually."); }
    finally { setExtracting(false); }
  }
  async function createActionItems() {
    const kept = review.filter((r) => r.keep && r.task.trim());
    if (!kept.length) return;
    setCreating(true);
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { setCreating(false); notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
    const rows = kept.map((r) => ({ department_id: deptId, text: r.task.trim(), assigned_to: r.ownerId || null, due_date: r.due || null }));   // status defaults 'open'
    const { error } = await supabase.from("action_items").insert(rows);
    setCreating(false);
    if (error) { notify({ kind: "error", title: "Couldn't save the action items", text: "Something went wrong. Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: `${kept.length} action item${kept.length === 1 ? "" : "s"} created.` });
    setReview([]); loadActionItems();
  }
  function addReviewRow() { setReview((rv) => [...rv, { id: Date.now(), task: "", ownerId: "", due: "", keep: true }]); }   // human backstop — blank editable row, same shape as extracted rows
  async function loadActionItems() {
    const { data } = await supabase.from("action_items").select("*");                       // dept-scoped by RLS
    setItems((data || []).sort((a, b) => (a.due_date || "9999-99-99").localeCompare(b.due_date || "9999-99-99")));   // soonest due first
  }
  useEffect(() => { loadActionItems(); }, []);
  async function completeItem(it) {
    if (!canManage) return;
    const { error } = await supabase.rpc("complete_action_item", { p_id: it.id });   // server-stamps completed_at/completed_by + snapshots assignee_name
    if (error) { notify({ kind: "error", title: "Couldn't update that", text: "Something went wrong. Please try again.", details: error.message }); return; }
    loadActionItems();
  }
  async function reopenItem(it) {
    if (!canManage) return;
    const { error } = await supabase.rpc("reopen_action_item", { p_id: it.id });   // RPC rejects if completed 14+ days ago (archived)
    if (error) {
      const locked = /14 days|archived/i.test(error.message || "");
      notify({ kind: "error", title: locked ? "Item is archived" : "Couldn't reopen that", text: locked ? "This item was completed or cancelled over 14 days ago and is now archived — it can't be reopened." : "Something went wrong. Please try again.", details: locked ? undefined : error.message });
      return;
    }
    loadActionItems();
  }
  async function cancelItem(it) {
    if (!canManage) return;
    const reason = window.prompt(`Why is "${it.text}" no longer needed? (a reason is required)`);
    if (reason === null) return;                                   // dismissed the prompt
    if (!reason.trim()) { notify({ kind: "error", title: "Reason required", text: "Please give a reason for cancelling this item." }); return; }
    const { error } = await supabase.rpc("cancel_action_item", { p_id: it.id, p_reason: reason.trim() });   // server-stamps cancelled_at/by + snapshots assignee_name
    if (error) { notify({ kind: "error", title: "Couldn't cancel that", text: "Something went wrong. Please try again.", details: error.message }); return; }
    notify({ kind: "success", title: "Marked no longer needed", text: `"${it.text}" was cancelled.` });
    loadActionItems();
  }
  // one history row for a RESOLVED item (completed OR cancelled); reopenable → shows the Reopen button (within the 14-day grace)
  const resolvedRow = (it, reopenable) => {
    const done = it.status === "done";
    const ts = done ? it.completed_at : it.cancelled_at;
    const when = ts ? new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "—";
    const actor = done ? it.completed_by : it.cancelled_by;
    const who = (actor && nameById.get(actor)) || it.assignee_name || (it.assigned_to ? "Unknown" : "Unassigned");   // live actor → snapshot name → fallback
    return (
      <div key={it.id} style={{ ...S.certRow, borderBottom: `0.5px solid ${FIRE.hairline}` }}>
        {done
          ? <CheckCircle2 size={16} color={reopenable ? FIRE.green : FIRE.textMuted} style={{ flexShrink: 0 }} />
          : <X size={16} color={reopenable ? FIRE.redText : FIRE.textMuted} style={{ flexShrink: 0 }} />}
        <div style={{ flex: 1, minWidth: 0 }}>
          <span style={{ fontWeight: 600, color: FIRE.textMuted2, textDecoration: "line-through" }}>{it.text}</span>
          <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 1 }}>{done ? `Completed ${when} · ${who}` : `Cancelled ${when} · ${who} — ${it.cancel_reason || "no reason given"}`}</div>
        </div>
        {reopenable && <button style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }} onClick={() => reopenItem(it)}>Reopen</button>}
      </div>
    );
  };
  const csvField = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  function exportCompletedCsv() {
    const header = ["Action item", "Completed by", "Completed"];
    const rows = [...doneItems]
      .sort((a, b) => (b.completed_at || "").localeCompare(a.completed_at || ""))
      .map((it) => {
        const who = it.completed_by ? (nameById.get(it.completed_by) || "Unknown") : "";
        const when = it.completed_at ? new Date(it.completed_at).toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
        return [it.text, who, when];
      });
    const csv = [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "action-items-completed.csv";
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>MEETINGS</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Agendas &amp; minutes</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Draft the agenda before the meeting from your real department data, then turn rough notes into clean minutes after.</div>
      </div>
      <div style={S.segRow}>
        {[["agenda", "Agenda"], ["minutes", "Minutes"]].map(([k, l]) => (
          <button key={k} onClick={() => setMode(k)} style={{ ...S.segBtn, background: mode === k ? FIRE.btnBg : "transparent", borderColor: mode === k ? FIRE.red : FIRE.btnBorder, color: mode === k ? FIRE.textPrimary : FIRE.navLabel }}>{l}</button>
        ))}
      </div>
      {mode === "agenda" ? (
        <MeetingAgenda S={S} role={role} notify={notify} dept={dept} meId={meId} members={members} sessions={sessions} certContext={certContext} />
      ) : (
      <>
      <div style={{ ...S.aiBanner, ...FS.card, borderLeft: `3px solid ${FIRE.red}` }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}><Sparkles size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />AI MINUTES DRAFTER</div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Meeting</span><input style={FS.input} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <label style={{ ...S.field, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Date</span><input style={FS.input} value={date} placeholder="e.g. Jul 8, 2026" onChange={(e) => setDate(e.target.value)} /></label>
          </div>
          <label style={{ ...S.field, marginTop: 10 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Rough notes</span>
            <textarea style={{ ...FS.input, minHeight: 110, resize: "vertical", lineHeight: 1.5 }} value={notes} placeholder={"Who was there, what came up, what was decided, what people agreed to do…"} onChange={(e) => setNotes(e.target.value)} /></label>
          <button style={{ ...FS.btnPrimary, marginTop: 12, opacity: loading ? 0.7 : 1 }} onClick={draft} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><ClipboardList size={16} /> Draft the minutes</>}
          </button>
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
          {out && <RichOutput S={S} text={out} dark />}
          {out && canManage && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
              <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Save as</span><input style={FS.input} value={saveTitle} onChange={(e) => setSaveTitle(e.target.value)} placeholder="Minutes title" /></label>
              <button style={{ ...FS.btn, opacity: (saving || !saveTitle.trim()) ? 0.6 : 1 }} onClick={saveDraft} disabled={saving || !saveTitle.trim()}>{saving ? <><Loader2 size={16} className="spin" /> Saving…</> : <><FileText size={16} /> Save minutes</>}</button>
            </div>
          )}
        </div>
      </div>

      {review.length > 0 && (
        <div style={{ ...FS.card, padding: "12px 16px", marginBottom: 14, borderLeft: `3px solid ${FIRE.amberText}` }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}>REVIEW EXTRACTED ITEMS — confirm owner &amp; due, then create</div>
          {review.map((r, i) => (
            <div key={r.id} style={{ display: "flex", gap: 8, alignItems: "flex-end", flexWrap: "wrap", padding: "8px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
              <input type="checkbox" checked={r.keep} onChange={(e) => setReview((rv) => rv.map((x, j) => j === i ? { ...x, keep: e.target.checked } : x))} title="Include this item" style={{ marginBottom: 10 }} />
              <label style={{ ...S.field, flex: 1, minWidth: 200 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Task</span><input style={FS.input} value={r.task} onChange={(e) => setReview((rv) => rv.map((x, j) => j === i ? { ...x, task: e.target.value } : x))} /></label>
              <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Owner</span>
                <select style={FS.input} value={r.ownerId} onChange={(e) => setReview((rv) => rv.map((x, j) => j === i ? { ...x, ownerId: e.target.value } : x))}>
                  <option value="">Unassigned</option>
                  {members.filter(isAssignable).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                </select></label>
              <label style={{ ...S.field, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Due</span><input type="date" style={FS.input} value={r.due} onChange={(e) => setReview((rv) => rv.map((x, j) => j === i ? { ...x, due: e.target.value } : x))} /></label>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
            {canManage && <button style={{ ...FS.btnPrimary, opacity: creating ? 0.7 : 1 }} onClick={createActionItems} disabled={creating}>{creating ? <><Loader2 size={16} className="spin" /> Creating…</> : <><Plus size={16} /> Create {review.filter((r) => r.keep && r.task.trim()).length} action item(s)</>}</button>}
            <button style={FS.btn} onClick={addReviewRow}><Plus size={14} /> Add action item</button>
            <button style={FS.btn} onClick={() => setReview([])} disabled={creating}>Discard</button>
          </div>
        </div>
      )}

      <div ref={actionItemsRef} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap" }}>
        <div style={{ ...FS.kicker, marginBottom: 0 }}>ACTION ITEMS{open > 0 ? ` · ${open} OPEN` : ""}</div>
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {out && <button style={{ ...FS.btn, opacity: extracting ? 0.7 : 1 }} onClick={extractActions} disabled={extracting}>{extracting ? <><Loader2 size={16} className="spin" /> Reading minutes…</> : <><Sparkles size={16} /> Extract from minutes</>}</button>}
          {canManage && <button style={FS.btn} onClick={addReviewRow}><Plus size={14} /> Add action item</button>}
        </div>
      </div>
      <div>
        {openItems.length === 0 ? <div style={{ ...S.opCard, ...FS.card, fontSize: 13, color: FIRE.textMuted }}>No open action items. Extract them from minutes above.</div> :
          openItems.map((it) => {
            const who = it.assigned_to ? (nameById.get(it.assigned_to) || "Unknown") : "Unassigned";
            const due = it.due_date ? new Date(it.due_date + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "no due date";
            return (
              <div key={it.id} style={{ ...S.certRow, borderBottom: `0.5px solid ${FIRE.hairline}` }}>
                <button onClick={() => completeItem(it)} disabled={!canManage} title={canManage ? "Mark done" : "Leaders only"} style={{ background: "none", border: "none", cursor: canManage ? "pointer" : "default", padding: 0, display: "inline-flex", flexShrink: 0 }}>
                  <span style={{ width: 16, height: 16, borderRadius: 999, border: `2px solid ${FIRE.textMuted}`, display: "inline-block" }} />
                </button>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{it.text}</span>
                  <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 1 }}>{who} · due {due}</div>
                </div>
                {canManage && <button style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }} onClick={() => cancelItem(it)} title="No longer needed">Cancel</button>}
              </div>
            );
          })}
      </div>
      {canManage && resolvedItems.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button onClick={() => setShowDone((v) => !v)} style={{ ...FS.btn, width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span>Completed &amp; cancelled ({resolvedItems.length})</span>
            {showDone ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
          </button>
          {showDone && (
            <div style={{ marginTop: 8 }}>
              <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 4 }}>
                <button style={{ ...FS.btn, padding: "6px 10px", fontSize: 12.5 }} onClick={exportCompletedCsv}><Download size={14} color={FIRE.btnIcon} /> Download CSV</button>
              </div>
              {recentResolved.length > 0 && (<>
                <div style={{ ...FS.kicker, fontSize: 10.5, marginTop: 2, marginBottom: 4 }}>RECENTLY RESOLVED · REOPENABLE FOR 14 DAYS</div>
                {[...recentResolved].sort((a, b) => (resolvedAt(b) || "").localeCompare(resolvedAt(a) || "")).map((it) => resolvedRow(it, true))}
              </>)}
              {archivedResolved.length > 0 && (<>
                <div style={{ ...FS.kicker, fontSize: 10.5, marginTop: recentResolved.length ? 12 : 2, marginBottom: 4 }}>ARCHIVE · READ-ONLY</div>
                {[...archivedResolved].sort((a, b) => (resolvedAt(b) || "").localeCompare(resolvedAt(a) || "")).map((it) => resolvedRow(it, false))}
              </>)}
            </div>
          )}
        </div>
      )}

      <div style={{ ...FS.kicker, marginBottom: 8, marginTop: 22 }}><FileText size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />SAVED MINUTES</div>
      <div style={{ ...FS.card, padding: "4px 16px", marginBottom: 22 }}>
        {drafts.length === 0 ? <div style={{ fontSize: 13, color: FIRE.textMuted, padding: "10px 0" }}>No saved minutes yet.</div> : drafts.map((d) => {
          const cName = members.find((m) => m.id === d.created_by)?.name || "Unknown";
          const eName = d.edited_by ? (members.find((m) => m.id === d.edited_by)?.name || "Unknown") : null;
          const when = new Date(d.edited_at || d.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary }}>{d.title || "Untitled minutes"}</div>
                <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num }}>{cName} · {when}{eName ? ` · edited by ${eName}` : ""}</div>
              </div>
              <button style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }} onClick={() => reopen(d)}>Open</button>
              {isDeptAdmin(role) && <button title="Delete" disabled={deletingId === d.id} style={{ ...FS.btn, padding: "5px 8px", fontSize: 11.5 }} onClick={() => softDelete(d)}><X size={14} color={FIRE.deleteRed} /></button>}
            </div>
          );
        })}
      </div>
      {openDraft && (
        <div onClick={closeDraft} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...FS.card, maxWidth: 720, width: "100%", padding: "18px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ ...FS.kicker, marginBottom: 0 }}>{openDraft.title || "Minutes"}</div>
              <div style={{ display: "flex", gap: 8 }}>
                {canManage && !editing && <button style={{ ...FS.btn, padding: "6px 10px" }} onClick={startEdit}><Pencil size={14} color={FIRE.btnIcon} /> Edit</button>}
                <button style={{ ...FS.btn, padding: "6px 10px" }} onClick={closeDraft}><X size={14} color={FIRE.btnIcon} /></button>
              </div>
            </div>
            {editing ? (
              <>
                <textarea style={{ ...FS.input, minHeight: 260, resize: "vertical", width: "100%", fontFamily: "inherit" }} value={editBuf} onChange={(e) => setEditBuf(e.target.value)} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                  <button style={FS.btn} onClick={() => { setEditing(false); setEditBuf(""); }} disabled={savingEdit}>Cancel</button>
                  <button style={{ ...FS.btnPrimary, opacity: (savingEdit || !editBuf.trim()) ? 0.6 : 1 }} onClick={saveEdit} disabled={savingEdit || !editBuf.trim()}>{savingEdit ? <><Loader2 size={16} className="spin" /> Saving…</> : <><FileText size={16} /> Save changes</>}</button>
                </div>
              </>
            ) : (
              <RichOutput S={S} text={openDraft.current_text ?? openDraft.ai_text} dark />
            )}
          </div>
        </div>
      )}
      </>
      )}
    </div>
  );
}

/* ---------------- Meeting Agenda (dept-aware) ---------------- */
// Gathers REAL context (open/overdue duties, upcoming training, expiring certs, pending cert proposals); AI drafts from ONLY that data,
// human reviews/edits, saves to ai_outputs (feature:'agenda'). Chunk 1: context-gathering + preview. Generate=Ch2, save=Ch3, edit=Ch4.
function MeetingAgenda({ S, role, notify, dept, meId, members, sessions, certContext }) {
  const canManage = hasAny(role, CANMANAGE_ROLES);
  const nameById = new Map((members || []).map((m) => [m.id, m.name]));
  const [duties, setDuties] = useState([]);
  const [pendingCerts, setPendingCerts] = useState([]);
  useEffect(() => {
    supabase.from("duties").select("id, duty, due_date, done, assigned_to").then(({ data }) => setDuties(data || []));                 // dept-scoped by RLS
    supabase.from("cert_submissions").select("id, name, member_id").eq("status", "pending").then(({ data }) => setPendingCerts(data || []));   // dept-scoped by RLS
  }, []);
  const todayISO = toISODate(new Date());
  const openDuties = duties.filter((d) => !d.done);
  const overdueDuties = openDuties.filter((d) => d.due_date && d.due_date < todayISO);                                                 // due_date is YYYY-MM-DD → string compare
  const upcoming = (sessions || []).filter((s) => !s.done && toISODate(sessDate(s)) >= todayISO).sort((a, b) => sessDate(a) - sessDate(b)).slice(0, 5);
  const expired = certContext?.expired || [];
  const expiring = certContext?.expiring || [];
  const [title, setTitle] = useState("Monthly Business Meeting");
  const [mtgDate, setMtgDate] = useState("");
  const [topics, setTopics] = useState("");   // leader's own meeting items — real intent, woven into the agenda
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const [saving, setSaving] = useState(false); const [saveTitle, setSaveTitle] = useState("");
  const [drafts, setDrafts] = useState([]); const [openDraft, setOpenDraft] = useState(null);
  const [editing, setEditing] = useState(false); const [editBuf, setEditBuf] = useState(""); const [savingEdit, setSavingEdit] = useState(false);
  async function generate() {
    setLoading(true); setErr(""); setOut("");
    const topN = (arr, fmt, n = 4) => {
      if (!arr.length) return "none";
      const shown = arr.slice(0, n).map(fmt).join("; ");
      const extra = arr.length - n;
      return extra > 0 ? `${shown}; …and ${extra} more` : shown;
    };
    const otherOpen = openDuties.filter((d) => !(d.due_date && d.due_date < todayISO));   // open but not overdue
    const lines = [
      `${dept?.name || "Department"} — real context for the agenda. Use ONLY these facts for department-specific items; add nothing not listed.`,
      `Meeting: ${title.trim() || "Business Meeting"}${mtgDate.trim() ? ` on ${mtgDate.trim()}` : ""}`,
      `Leader-provided topics to include: ${topics.trim() || "(none)"}`,
      `Overdue duties (most overdue first): ${topN(overdueDuties, (d) => `${d.duty} — ${nameById.get(d.assigned_to) || (d.assigned_to ? "unassigned" : "station-wide")}${d.due_date ? `, due ${d.due_date}` : ""}`)}`,
      `Other open duties: ${topN(otherOpen, (d) => `${d.duty}${d.assigned_to ? ` — ${nameById.get(d.assigned_to) || "unassigned"}` : ""}`)}`,
      `Certifications expired: ${topN(expired, (r) => `${r.member}'s ${r.cert} (${r.phrase})`)}`,
      `Certifications expiring within 90 days: ${topN(expiring, (r) => `${r.member}'s ${r.cert} (${r.phrase})`)}`,
      `Upcoming training: ${topN(upcoming, (s) => `${s.title} on ${fmtSess(s)}${s.audience === "leadership" ? " (leadership)" : ""}`)}`,
      `Pending certification approvals: ${topN(pendingCerts, (p) => `${nameById.get(p.member_id) || "a member"}'s ${p.name}`)}`,
    ];
    const user = lines.join("\n");
    const sys = "You draft a clear, professional meeting agenda for a volunteer fire department's business meeting, for the chief or secretary to run the meeting from. Produce a standard agenda structure with the usual sections — Call to Order, Roll Call, Approval of Previous Minutes, Officer & Committee Reports, Old Business, New Business, Training, Announcements, and Adjournment (with the next meeting) — in a clean, numbered or bulleted format.\n\nYou may write the STANDARD AGENDA STRUCTURE and its section headings freely — those are normal parts of any meeting agenda, not department facts. But every DEPARTMENT-SPECIFIC item that fills those sections — a specific overdue duty and who owns it, a member whose certification is expired or expiring, an upcoming training date, a pending certification approval — must come ONLY from the real context provided below. Slot each into a sensible section: overdue and open duties under Old or New Business as items to address; expired/expiring certifications under New Business or a training/readiness item; upcoming training under Training; pending certification approvals under New Business or Officer Reports. Name the specifics — the duty, the member, the date — so the agenda reads like this department's real meeting, not a template.\n\nThe context below may also include 'Leader-provided topics to include' — items the meeting leader typed themselves. These are real meeting intent, not system data, so you may use them freely: add each as an agenda item under the most sensible section (New Business, Old Business, or Announcements), and you may lightly reword or group them to read cleanly. BUT do NOT invent any DETAIL the leader did not provide about a topic. For example, if the leader writes 'tanker purchase', list it as a discussion item like 'Tanker purchase — discussion'; do NOT invent a price, a vendor, a dollar amount, or a decision. If they write 'Johnson recognition', list 'Recognition — Johnson'; do not invent what it is for. Add each topic as stated, placed in the right section, and nothing more.\n\nCRITICAL — TRUTH GUARDRAIL: Use ONLY the facts in the real context below for department-specific items. NEVER invent or infer a duty, a certification, a member name, a date, a count, or an event that is not listed. Do not add plausible-sounding agenda items to fill space. If a category says 'none', do not create items for it — either omit that line or note there is nothing to report (for example, 'No overdue duties this period'). Where the context shows '…and N more', you may refer to that remaining count without naming them. Keep dates and windows exactly as written in the context. The harm this prevents is real: a chief runs a live meeting from this agenda, and a fabricated duty, certification, member, or date wastes the crew's time or misinforms the department.\n\nWarm but businesslike. Keep it to a runnable one-page agenda. Under 450 words.";
    try { const t = await callClaude(sys, user); setOut(t); setSaveTitle(title.trim().slice(0, 60) || `Agenda · ${new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}`); }
    catch { setErr("Couldn't draft the agenda just now. Try again."); } finally { setLoading(false); }
  }
  async function saveDraft() {
    if (!out || !saveTitle.trim()) return;
    setSaving(true);
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { setSaving(false); notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
    const { error } = await supabase.from("ai_outputs").insert({ department_id: deptId, feature: "agenda", title: saveTitle.trim(), ai_text: out, created_by: meId });
    setSaving(false);
    if (error) { notify({ kind: "error", title: "Couldn't save the agenda", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: "Agenda saved." });
    loadDrafts();
  }
  async function loadDrafts() {
    const { data } = await supabase.from("ai_outputs").select("*").eq("feature", "agenda").is("deleted_at", null);   // dept-scoped by RLS; hide soft-deleted
    setDrafts((data || []).sort((a, b) => (b.edited_at || b.created_at).localeCompare(a.edited_at || a.created_at)));   // coalesce(edited_at, created_at) desc
  }
  const [deletingId, setDeletingId] = useState(null);   // per-row soft-delete busy
  async function softDelete(d) {
    if (!window.confirm("Delete this record? It moves to the trash and can be restored by an admin.")) return;
    setDeletingId(d.id);
    const { error } = await supabase.rpc("soft_delete_ai_output", { p_id: d.id });   // DB stamps deleted_at + identity (is_dept_admin gate)
    setDeletingId(null);
    if (error) { notify({ kind: "error", title: "Couldn't delete", text: "Something went wrong deleting that. Please try again.", details: error.message }); return; }
    loadDrafts();   // deleted row falls out via the .is("deleted_at", null) filter
  }
  useEffect(() => { loadDrafts(); }, []);
  function closeDraft() { setOpenDraft(null); setEditing(false); setEditBuf(""); }       // backdrop / X
  function reopen(d) { setEditing(false); setEditBuf(""); setOpenDraft(d); }             // list Open — clear stale edit first
  function startEdit() { setEditBuf(openDraft.current_text ?? openDraft.ai_text ?? ""); setEditing(true); }
  async function saveEdit() {
    if (!editBuf.trim()) return;
    setSavingEdit(true);
    const { data, error } = await supabase.from("ai_outputs")
      .update({ current_text: editBuf, edited_by: meId, edited_at: new Date().toISOString() })   // ai_text left pristine
      .eq("id", openDraft.id).select().single();
    setSavingEdit(false);
    if (error) { notify({ kind: "error", title: "Couldn't save your edit", text: "Something went wrong saving your changes. Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: "Changes saved." });
    setOpenDraft(data); setEditing(false); setEditBuf(""); loadDrafts();                 // modal live-updates + list marker lights up
  }

  const Line = ({ children }) => <div style={{ fontSize: 12.5, color: FIRE.textSecondary, padding: "3px 0" }}>{children}</div>;
  const None = () => <div style={{ fontSize: 12.5, color: FIRE.textMuted, padding: "3px 0" }}>None.</div>;
  const SubHead = ({ children }) => <div style={{ fontSize: 11, fontWeight: 700, color: FIRE.textMuted, textTransform: "uppercase", letterSpacing: ".06em", marginTop: 10 }}>{children}</div>;
  return (
    <div>
      <div style={{ ...S.aiBanner, ...FS.card, borderLeft: `3px solid ${FIRE.red}` }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}><ClipboardList size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />AI AGENDA BUILDER</div>
          <h3 style={{ ...S.featTitle, color: FIRE.textPrimary }}>Draft an agenda from your real department data</h3>
          <p style={{ ...S.helpP, color: FIRE.textMuted, marginBottom: 10 }}>Pulled live from your station — the draft references only what's real below, nothing invented.</p>

          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 }}>
            <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Meeting</span><input style={FS.input} value={title} onChange={(e) => setTitle(e.target.value)} /></label>
            <label style={{ ...S.field, minWidth: 140 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Date</span><input style={FS.input} value={mtgDate} placeholder="e.g. Jul 8, 2026" onChange={(e) => setMtgDate(e.target.value)} /></label>
          </div>

          <label style={{ ...S.field, marginBottom: 12 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Additional topics <span style={{ color: FIRE.textMuted, fontWeight: 400 }}>— optional, your own items to add</span></span>
            <textarea style={{ ...FS.input, minHeight: 52, resize: "vertical" }} value={topics} onChange={(e) => setTopics(e.target.value)} placeholder="e.g. tanker purchase decision, fundraiser date vote, Johnson recognition" /></label>

          <div style={{ ...FS.card, padding: "10px 14px", marginBottom: 12 }}>
            <div style={{ ...FS.kicker, marginBottom: 2, fontSize: 10.5 }}>CONTEXT WE'LL USE</div>

            <SubHead>Duties — {openDuties.length} open · {overdueDuties.length} overdue</SubHead>
            {overdueDuties.length === 0 ? <None /> : overdueDuties.slice(0, 6).map((d) => <Line key={d.id}>⚠ {d.duty}{d.due_date ? ` · due ${d.due_date}` : ""}{d.assigned_to ? ` · ${nameById.get(d.assigned_to) || "Unassigned"}` : ""}</Line>)}

            <SubHead>Upcoming training — {upcoming.length}</SubHead>
            {upcoming.length === 0 ? <None /> : upcoming.map((s) => <Line key={s.id}>{s.title} · {fmtSess(s)}{s.audience === "leadership" ? " · leadership" : ""}</Line>)}

            <SubHead>Certifications — {expired.length} expired · {expiring.length} expiring</SubHead>
            {expired.length === 0 && expiring.length === 0 ? <None /> : [...expired, ...expiring].slice(0, 8).map((r, i) => <Line key={i}>{r.member} · {r.cert} · {r.phrase}</Line>)}

            <SubHead>Pending cert proposals — {pendingCerts.length}</SubHead>
            {pendingCerts.length === 0 ? <None /> : pendingCerts.slice(0, 6).map((p) => <Line key={p.id}>{nameById.get(p.member_id) || "A member"} · {p.name}</Line>)}
          </div>

          <button style={{ ...FS.btnPrimary, opacity: loading ? 0.7 : 1 }} onClick={generate} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><Sparkles size={16} /> Generate agenda</>}
          </button>
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
          {out && <RichOutput S={S} text={out} dark />}
          {out && canManage && (
            <div style={{ display: "flex", gap: 8, alignItems: "flex-end", marginTop: 10, flexWrap: "wrap" }}>
              <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Save as</span><input style={FS.input} value={saveTitle} onChange={(e) => setSaveTitle(e.target.value)} placeholder="Agenda title" /></label>
              <button style={{ ...FS.btn, opacity: (saving || !saveTitle.trim()) ? 0.6 : 1 }} onClick={saveDraft} disabled={saving || !saveTitle.trim()}>{saving ? <><Loader2 size={16} className="spin" /> Saving…</> : <><FileText size={16} /> Save agenda</>}</button>
            </div>
          )}
        </div>
      </div>

      <div style={{ ...FS.kicker, marginBottom: 8, marginTop: 22 }}><FileText size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />SAVED AGENDAS</div>
      <div style={{ ...FS.card, padding: "4px 16px", marginBottom: 22 }}>
        {drafts.length === 0 ? <div style={{ fontSize: 13, color: FIRE.textMuted, padding: "10px 0" }}>No saved agendas yet.</div> : drafts.map((d) => {
          const cName = members.find((m) => m.id === d.created_by)?.name || "Unknown";
          const eName = d.edited_by ? (members.find((m) => m.id === d.edited_by)?.name || "Unknown") : null;
          const when = new Date(d.edited_at || d.created_at).toLocaleDateString("en-US", { month: "short", day: "numeric" });
          return (
            <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary }}>{d.title || "Untitled agenda"}</div>
                <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num }}>{cName} · {when}{eName ? ` · edited by ${eName}` : ""}</div>
              </div>
              <button style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }} onClick={() => reopen(d)}>Open</button>
              {isDeptAdmin(role) && <button title="Delete" disabled={deletingId === d.id} style={{ ...FS.btn, padding: "5px 8px", fontSize: 11.5 }} onClick={() => softDelete(d)}><X size={14} color={FIRE.deleteRed} /></button>}
            </div>
          );
        })}
      </div>
      {openDraft && (
        <div onClick={closeDraft} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
          <div onClick={(e) => e.stopPropagation()} style={{ ...FS.card, maxWidth: 720, width: "100%", padding: "18px 20px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, marginBottom: 12 }}>
              <div style={{ ...FS.kicker, marginBottom: 0 }}>{openDraft.title || "Agenda"}</div>
              <div style={{ display: "flex", gap: 8 }}>
                {canManage && !editing && <button style={{ ...FS.btn, padding: "6px 10px" }} onClick={startEdit}><Pencil size={14} color={FIRE.btnIcon} /> Edit</button>}
                <button style={{ ...FS.btn, padding: "6px 10px" }} onClick={closeDraft}><X size={14} color={FIRE.btnIcon} /></button>
              </div>
            </div>
            {editing ? (
              <>
                <textarea style={{ ...FS.input, minHeight: 260, resize: "vertical", width: "100%", fontFamily: "inherit" }} value={editBuf} onChange={(e) => setEditBuf(e.target.value)} />
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 12 }}>
                  <button style={FS.btn} onClick={() => { setEditing(false); setEditBuf(""); }} disabled={savingEdit}>Cancel</button>
                  <button style={{ ...FS.btnPrimary, opacity: (savingEdit || !editBuf.trim()) ? 0.6 : 1 }} onClick={saveEdit} disabled={savingEdit || !editBuf.trim()}>{savingEdit ? <><Loader2 size={16} className="spin" /> Saving…</> : <><FileText size={16} /> Save changes</>}</button>
                </div>
              </>
            ) : (
              <RichOutput S={S} text={openDraft.current_text ?? openDraft.ai_text} dark />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ---------------- New-member Onboarding ---------------- */
const ONBOARD_TEMPLATE = [
  { group: "Paperwork", items: ["Application & emergency contact on file", "Background / driving-record consent signed", "Medical clearance / physical complete", "SOG & policy acknowledgment signed"] },
  { group: "Gear", items: ["Turnout gear sized & issued", "Helmet, boots, and gloves issued", "SCBA fit test completed"] },
  { group: "Training", items: ["Station orientation & safety walk-through", "SOG / policy review session", "Firefighter I enrollment (if applicable)", "CPR / BLS scheduled"] },
  { group: "People & access", items: ["Mentor assigned", "Added to paging / contact roster", "Platform login created"] },
];
function Onboarding({ S, members, setMembers, notify, role }) {
  const canManage = hasAny(role, DEPT_ADMIN_ROLES);   // PA/DA — same set as is_dept_admin() (RLS enforces server-side)
  const assignable = assignableMembers(members);
  const candidates = assignable.length ? assignable : [{ id: 0, name: "New member", role: "Firefighter" }];
  const probI = candidates.findIndex((m) => m.status === "Probationary");
  const [selId, setSelId] = useState(candidates[probI >= 0 ? probI : 0].id);
  const [checks, setChecks] = useState({});
  const [deptId, setDeptId] = useState(null);
  const [items, setItems] = useState(null);   // dept's onboarding_items (null = loading, [] = none)
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const [editMode, setEditMode] = useState(false);
  const [nLabel, setNLabel] = useState(""); const [nCat, setNCat] = useState("");   // new item
  const [editId, setEditId] = useState(null); const [eLabel, setELabel] = useState(""); const [eCat, setECat] = useState("");   // inline edit
  const [busy, setBusy] = useState(false);
  const person = candidates.find((m) => String(m.id) === String(selId)) || candidates[0];
  // group DB items by category (categories in first-appearance order; items already ordered by sort_order)
  const grouped = [];
  (items || []).forEach((it) => { let g = grouped.find((x) => x.category === it.category); if (!g) { g = { category: it.category, items: [] }; grouped.push(g); } g.items.push(it); });
  const doneCount = (items || []).filter((it) => (it.is_mentor ? !!person?.mentorId : !!checks[it.id])).length;   // mentor item = real mentor_id
  const pct = (items && items.length) ? Math.round((doneCount / items.length) * 100) : 0;
  const categories = [...new Set((items || []).map((it) => it.category))];
  useEffect(() => { supabase.rpc("my_department_id").then(({ data }) => setDeptId(data || null)); }, []);
  async function loadItems() {   // RLS scopes to my_department_id(); re-fetched after every edit
    const { data } = await supabase.from("onboarding_items").select("id, category, label, is_mentor, sort_order").order("sort_order", { ascending: true });
    setItems(data || []);
  }
  useEffect(() => { loadItems(); }, []);
  useEffect(() => {   // load this member's saved progress
    if (!selId) { setChecks({}); return; }
    let alive = true;
    supabase.from("onboarding_progress").select("item_id, done").eq("member_id", selId)
      .then(({ data }) => { if (alive) setChecks(Object.fromEntries((data || []).map((r) => [r.item_id, r.done]))); });
    return () => { alive = false; };
  }, [selId]);
  async function toggle(itemId) {
    const next = !checks[itemId];
    setChecks((c) => ({ ...c, [itemId]: next }));   // optimistic
    if (!selId || !deptId) return;
    const { error } = await supabase.from("onboarding_progress").upsert({ member_id: selId, department_id: deptId, item_id: itemId, done: next }, { onConflict: "member_id,item_id" });
    if (error) { setChecks((c) => ({ ...c, [itemId]: !next })); notify({ kind: "error", title: "Couldn't save", text: "That didn't save — please try again.", details: error.message }); }
  }
  async function assignMentor(mentorId) {   // writes members.mentor_id — SAME path/RLS as the edit form (single-sourced)
    if (!person?.id) return;
    const mid = mentorId || null;
    const prev = person.mentorId ?? null;
    setMembers((ms) => ms.map((m) => (m.id === person.id ? { ...m, mentorId: mid } : m)));   // optimistic (shared members array → the file stays in sync)
    const { error } = await supabase.from("members").update({ mentor_id: mid }).eq("id", person.id);
    if (error) {
      setMembers((ms) => ms.map((m) => (m.id === person.id ? { ...m, mentorId: prev } : m)));   // revert
      notify({ kind: "error", title: "Couldn't assign the mentor", text: "Please try again.", details: error.message });
    } else {
      notify({ kind: "success", text: mid ? "Mentor assigned." : "Mentor cleared." });
    }
  }
  async function addItem() {
    const label = nLabel.trim(), category = nCat.trim();
    if (!label || !category) { notify({ kind: "error", title: "Need a label and a category", text: "Enter both." }); return; }
    if (!deptId) return;
    const maxOrder = (items || []).reduce((mx, it) => Math.max(mx, it.sort_order), 0);
    setBusy(true);
    const { error } = await supabase.from("onboarding_items").insert({ department_id: deptId, category, label, is_mentor: false, sort_order: maxOrder + 1 });
    setBusy(false);
    if (error) { notify({ kind: "error", title: "Couldn't add the item", text: "Please try again.", details: error.message }); return; }
    setNLabel(""); await loadItems();   // keep nCat so you can add several to the same category
  }
  function startEdit(it) { setEditId(it.id); setELabel(it.label); setECat(it.category); }
  async function saveEdit() {
    const label = eLabel.trim(), category = eCat.trim();
    if (!label || !category) { notify({ kind: "error", title: "Label & category required", text: "Neither can be blank." }); return; }
    setBusy(true);
    const { error } = await supabase.from("onboarding_items").update({ label, category }).eq("id", editId);   // is_mentor never touched here
    setBusy(false);
    if (error) { notify({ kind: "error", title: "Couldn't save", text: "Please try again.", details: error.message }); return; }
    setEditId(null); await loadItems();
  }
  async function removeItem(it) {
    if (it.is_mentor) return;   // protected — no delete
    if (!window.confirm(`Remove "${it.label}"? This also clears members' progress on it.`)) return;
    setBusy(true);
    const { error } = await supabase.from("onboarding_items").delete().eq("id", it.id);   // FK cascade removes its onboarding_progress rows
    setBusy(false);
    if (error) { notify({ kind: "error", title: "Couldn't remove", text: "Please try again.", details: error.message }); return; }
    await loadItems();
  }
  async function move(it, dir) {   // reorder WITHIN the category — swap sort_order with the same-category neighbor
    const catItems = (items || []).filter((x) => x.category === it.category);
    const idx = catItems.findIndex((x) => x.id === it.id);
    const j = dir === "up" ? idx - 1 : idx + 1;
    if (j < 0 || j >= catItems.length) return;
    const other = catItems[j];
    setBusy(true);
    const r1 = await supabase.from("onboarding_items").update({ sort_order: other.sort_order }).eq("id", it.id);
    const r2 = await supabase.from("onboarding_items").update({ sort_order: it.sort_order }).eq("id", other.id);
    setBusy(false);
    if (r1.error || r2.error) notify({ kind: "error", title: "Couldn't reorder", text: "Please try again.", details: (r1.error || r2.error).message });
    await loadItems();
  }
  async function renameCategory(oldCat) {
    const newCat = (window.prompt(`Rename category "${oldCat}" to:`, oldCat) || "").trim();
    if (!newCat || newCat === oldCat || !deptId) return;
    setBusy(true);
    const { error } = await supabase.from("onboarding_items").update({ category: newCat }).eq("department_id", deptId).eq("category", oldCat);   // bulk rename all items in the category
    setBusy(false);
    if (error) { notify({ kind: "error", title: "Couldn't rename the category", text: "Please try again.", details: error.message }); return; }
    await loadItems();
  }
  async function loadDefaults() {   // idempotent: skip existing (category+label); never add a 2nd mentor item
    if (!deptId) return;
    if (!window.confirm("Add the default checklist items? Existing items are kept; duplicates are skipped.")) return;
    const existing = new Set((items || []).map((it) => `${it.category}||${it.label}`));
    const hasMentor = (items || []).some((it) => it.is_mentor);
    let ord = (items || []).reduce((mx, it) => Math.max(mx, it.sort_order), 0);
    const rows = [];
    ONBOARD_TEMPLATE.forEach((g) => g.items.forEach((label) => {
      if (existing.has(`${g.group}||${label}`)) return;
      const isMentorDefault = g.group === "People & access" && label === "Mentor assigned";
      if (isMentorDefault && hasMentor) return;                         // don't add a second mentor slot
      rows.push({ department_id: deptId, category: g.group, label, is_mentor: isMentorDefault && !hasMentor, sort_order: ++ord });
    }));
    if (!rows.length) { notify({ kind: "success", text: "Defaults already present — nothing to add." }); return; }
    setBusy(true);
    const { error } = await supabase.from("onboarding_items").insert(rows);
    setBusy(false);
    if (error) { notify({ kind: "error", title: "Couldn't load defaults", text: "Please try again.", details: error.message }); return; }
    notify({ kind: "success", text: `Added ${rows.length} default item${rows.length === 1 ? "" : "s"}.` });
    await loadItems();
  }
  async function draftPlan() {
    setLoading(true); setErr(""); setOut("");
    const sys = "You write a warm welcome note and a practical first-30-days onboarding plan for a new volunteer firefighter/EMT joining a small department. Friendly and concrete: a short welcome, then week-by-week steps covering paperwork, gear, orientation, shadowing/mentor, and first trainings. This is a DRAFT for an officer to review and send. Under 320 words, plain headers and bullets.";
    try { const t = await callClaude(sys, `New member: ${person?.name || "New member"}${person?.role ? `, joining as ${person.role}` : ""}.`); setOut(t); }
    catch { setErr("Couldn't draft the plan just now. Try again."); } finally { setLoading(false); }
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      {/* header (inline FS — shared PageHead not used/mutated) */}
      <div style={{ marginBottom: 18 }}>
        <div style={FS.kicker}>NEW-MEMBER ONBOARDING</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Get new members started right</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>A guided checklist for every new volunteer — paperwork, gear, training, and a mentor — plus an AI-drafted welcome and 30-day plan.</div>
      </div>
      <div style={{ ...FS.card, padding: 16, marginBottom: 14, display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
        <label style={{ ...S.field, minWidth: 200 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Onboarding</span>
          <select style={FS.input} value={selId} onChange={(e) => setSelId(e.target.value)}>{candidates.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 12.5, color: FIRE.textSecondary, display: "flex", justifyContent: "space-between", ...FS.num }}><span>Onboarding progress</span><span>{pct}%</span></div>
          <Bar S={S} pct={pct} color={pct >= 100 ? FIRE.green : pct >= 50 ? FIRE.amberText : FIRE.redText} track={FIRE.track} />
        </div>
        {canManage && <button style={{ ...FS.btn, alignSelf: "flex-end" }} onClick={() => { setEditMode((v) => !v); setEditId(null); }}><Pencil size={14} color={FIRE.btnIcon} /> {editMode ? "Done editing" : "Edit checklist"}</button>}
      </div>
      {editMode && canManage ? (
        <>
          <div style={{ ...FS.card, padding: 16, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
            <label style={{ ...S.field, flex: 1, minWidth: 160 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>New item</span><input style={FS.input} value={nLabel} onChange={(e) => setNLabel(e.target.value)} placeholder="e.g. W-4 on file" /></label>
            <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Category</span><input style={FS.input} list="onb-cats" value={nCat} onChange={(e) => setNCat(e.target.value)} placeholder="Paperwork (or a new one)" /></label>
            <datalist id="onb-cats">{categories.map((c) => <option key={c} value={c} />)}</datalist>
            <button style={FS.btnPrimary} onClick={addItem} disabled={busy}><Plus size={15} /> Add item</button>
            <button style={FS.btn} onClick={loadDefaults} disabled={busy}>Load default checklist</button>
          </div>
          {(items || []).length === 0 && <div style={{ ...FS.card, padding: 18, fontSize: 13.5, color: FIRE.textMuted }}>No items yet — add one above or load the defaults.</div>}
          {grouped.map((g) => (
            <div key={g.category} style={{ marginBottom: 6 }}>
              <div style={{ ...FS.kicker, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>{g.category.toUpperCase()}<button style={{ ...FS.btn, padding: "2px 7px", fontSize: 11 }} onClick={() => renameCategory(g.category)} disabled={busy}>Rename</button></div>
              {g.items.map((it) => {
                const catItems = items.filter((x) => x.category === it.category);
                const idx = catItems.findIndex((x) => x.id === it.id);
                const editing = editId === it.id;
                return (
                  <div key={it.id} style={{ ...FS.row, gap: 8, flexWrap: "wrap" }}>
                    <button disabled={idx === 0 || busy} onClick={() => move(it, "up")} title="Move up" style={{ ...FS.btn, padding: "4px 7px", opacity: idx === 0 ? 0.4 : 1 }}><ChevronUp size={14} color={FIRE.btnIcon} /></button>
                    <button disabled={idx === catItems.length - 1 || busy} onClick={() => move(it, "down")} title="Move down" style={{ ...FS.btn, padding: "4px 7px", opacity: idx === catItems.length - 1 ? 0.4 : 1 }}><ChevronDown size={14} color={FIRE.btnIcon} /></button>
                    {editing ? (<>
                      <input style={{ ...FS.input, flex: 1, minWidth: 140 }} value={eLabel} onChange={(e) => setELabel(e.target.value)} />
                      <input style={{ ...FS.input, minWidth: 120 }} list="onb-cats" value={eCat} onChange={(e) => setECat(e.target.value)} />
                      <button style={FS.btnPrimary} onClick={saveEdit} disabled={busy}>Save</button>
                      <button style={FS.btn} onClick={() => setEditId(null)}>Cancel</button>
                    </>) : (<>
                      <span style={{ flex: 1, minWidth: 0, color: FIRE.textPrimary, fontSize: 14 }}>{it.label}{it.is_mentor && <span style={{ marginLeft: 8, fontSize: 10, fontWeight: 700, letterSpacing: ".08em", color: FIRE.amberText, border: `1px solid ${FIRE.amberText}55`, borderRadius: 4, padding: "1px 5px" }}>MENTOR</span>}</span>
                      <button style={{ ...FS.btn, padding: "5px 9px" }} onClick={() => startEdit(it)}>Edit</button>
                      {it.is_mentor
                        ? <button style={{ ...FS.btn, padding: "5px 9px", opacity: 0.45, cursor: "not-allowed" }} disabled title="Required — reflects the assigned mentor">Remove</button>
                        : <button style={{ ...FS.btn, padding: "5px 9px", color: FIRE.deleteRed }} onClick={() => removeItem(it)} disabled={busy}>Remove</button>}
                    </>)}
                  </div>
                );
              })}
            </div>
          ))}
        </>
      ) : items === null ? (
        <div style={{ ...FS.card, padding: 18, fontSize: 13.5, color: FIRE.textMuted }}>Loading checklist…</div>
      ) : items.length === 0 ? (
        <div style={{ ...FS.card, padding: 18, fontSize: 13.5, color: FIRE.textMuted }}>No onboarding checklist yet for your department. Once items are added, they'll appear here.</div>
      ) : grouped.map((g) => (
        <div key={g.category} style={{ marginBottom: 6 }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}>{g.category.toUpperCase()}</div>
          {g.items.map((it) => {
            const mentor = !!it.is_mentor;
            const done = mentor ? !!person?.mentorId : !!checks[it.id];
            return (
              <div key={it.id} style={FS.row}>
                <button onClick={mentor ? undefined : () => toggle(it.id)} disabled={mentor} title={mentor ? "Assign a mentor →" : (done ? "Undo" : "Mark complete")} style={{ background: "none", border: "none", cursor: mentor ? "default" : "pointer", padding: 0, display: "inline-flex", flexShrink: 0 }}>
                  {done ? <CheckCircle2 size={18} color={FIRE.green} /> : <span style={{ width: 16, height: 16, borderRadius: 5, border: `2px solid ${FIRE.textMuted2}`, display: "inline-block" }} />}
                </button>
                {mentor ? (
                  <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                    <span style={{ color: done ? FIRE.textMuted2 : FIRE.textPrimary, fontSize: 14 }}>{it.label}</span>
                    <select style={{ ...FS.input, maxWidth: 240, padding: "5px 9px", flex: "0 1 auto" }} value={person?.mentorId || ""} onChange={(e) => assignMentor(e.target.value)}>
                      <option value="">— None —</option>
                      {(members || []).filter((m) => m.id !== person?.id && m.status === "Active" && isAssignable(m)).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                  </div>
                ) : (
                  <div style={{ flex: 1, minWidth: 0, color: done ? FIRE.textMuted2 : FIRE.textPrimary, textDecoration: done ? "line-through" : "none", fontSize: 14 }}>{it.label}</div>
                )}
              </div>
            );
          })}
        </div>
      ))}
      <div style={{ ...FS.card, padding: 18, marginTop: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}><Sparkles size={13} color={FIRE.red} style={{ marginRight: 5, verticalAlign: "-2px" }} />AI WELCOME & 30-DAY PLAN</div>
          <h3 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 18, fontWeight: 700, color: FIRE.textPrimary, margin: "0 0 4px" }}>Draft a welcome for {person?.name}</h3>
          <p style={{ fontSize: 13, color: FIRE.textMuted, lineHeight: 1.5, marginBottom: 10 }}>A friendly welcome note and a week-by-week first-month plan. You review and send.</p>
          <button style={{ ...FS.btnPrimary, opacity: loading ? 0.7 : 1 }} onClick={draftPlan} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><UserPlus size={16} /> Draft welcome & plan</>}
          </button>
          {err && <div style={{ marginTop: 10, fontSize: 13, color: FIRE.redText }}>{err}</div>}
          {out && <RichOutput S={S} text={out} dark />}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Training Plan + Calendar ---------------- */
const CADENCE_DAYS = { Weekly: 7, "Bi-weekly": 14, Monthly: 30, Quarterly: 90, "Semi-annual": 180, Annual: 365, Biennial: 730 };
const N_FOR_CADENCE = { Weekly: 52, "Bi-weekly": 26, Monthly: 12, Quarterly: 4, "Semi-annual": 2, Annual: 1 };   // a year's worth (recurring default N)
const CADENCE_DAY_STEP = { Weekly: 7, "Bi-weekly": 14 };                              // exact-day cadences
const CADENCE_MONTH_STEP = { Monthly: 1, Quarterly: 3, "Semi-annual": 6, Annual: 12 };
function addMonthsKeepDom(y, m0, dom, k) {   // +k calendar months, keep day-of-month, clamp (Jan31+1mo→Feb28/29)
  const total = m0 + k, yy = y + Math.floor(total / 12), mm = ((total % 12) + 12) % 12;
  return new Date(yy, mm, Math.min(dom, new Date(yy, mm + 1, 0).getDate()));
}
const CADENCES = ["Weekly", "Bi-weekly", "Monthly", "Quarterly", "Semi-annual", "Annual", "One-off"];
const TRAIN_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
function toISO(d) { return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; }
function dueInfo(item) {
  if (item.cadence === "One-off") return { label: item.lastISO ? "Done" : "Not logged", color: item.lastISO ? "#2E7D52" : "#B11E2A", rel: item.lastISO ? "one-off" : "never logged", nextLabel: "—", urgent: !item.lastISO };
  const days = CADENCE_DAYS[item.cadence] || 30;
  if (!item.lastISO) return { label: "Not logged", color: "#B11E2A", rel: "never logged", nextLabel: "—", urgent: true };
  const last = new Date(item.lastISO + "T00:00:00");
  const next = new Date(last.getTime() + days * 86400000);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const diff = Math.round((next - today) / 86400000);
  const nextLabel = next.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  if (diff < 0) return { label: "Overdue", color: "#B11E2A", rel: `${-diff} day${-diff === 1 ? "" : "s"} overdue`, nextLabel, next, urgent: true };
  const window = Math.min(Math.round(days * 0.25), 30);
  if (diff <= window) return { label: "Due soon", color: "#9A6B12", rel: `in ${diff} day${diff === 1 ? "" : "s"}`, nextLabel, next };
  return { label: "On track", color: "#2E7D52", rel: `due ${nextLabel}`, nextLabel, next };
}
const TRAIN_PLAN_SEED = [
  { id: 1, name: "SCBA refresher", cadence: "Quarterly", lastISO: "2026-04-10" },
  { id: 2, name: "Pump operations drill", cadence: "Monthly", lastISO: "2026-05-20" },
  { id: 3, name: "EMS continuing education", cadence: "Monthly", lastISO: "2026-06-02" },
  { id: 4, name: "Live fire / RIT drill", cadence: "Annual", lastISO: "2025-09-15" },
  { id: 5, name: "CPR / BLS", cadence: "Biennial", lastISO: "2025-03-01" },
  { id: 6, name: "Hazmat awareness refresher", cadence: "Annual", lastISO: "2025-11-12" },
  { id: 7, name: "Driver / Operator (EVOC)", cadence: "Annual", lastISO: "2025-08-01" },
];
function trainSessionsSeed() {
  const t = new Date(), y = t.getFullYear(), m = t.getMonth(), dim = new Date(y, m + 1, 0).getDate(), d = t.getDate();
  const back = (off) => { let yy = y, mm = m, dd = d - off; while (dd < 1) { mm--; if (mm < 0) { mm = 11; yy--; } dd += new Date(yy, mm + 1, 0).getDate(); } return { y: yy, m: mm, d: dd }; };
  const fwd = (off) => Math.min(d + off, dim);
  return [
    { id: 101, planId: 4, title: "Live fire / RIT drill", ...back(34), done: true, attendance: [1, 2, 3, 4, 5, 6] },
    { id: 102, planId: 2, title: "Pump operations drill", ...back(20), done: true, attendance: [1, 2, 3, 6] },
    { id: 103, planId: 3, title: "EMS con-ed: Stroke", ...back(13), done: true, attendance: [1, 2, 3, 4, 6] },
    { id: 104, planId: 1, title: "SCBA refresher night", ...back(6), done: true, attendance: [2, 3, 4, 5, 6] },
    { id: 105, planId: 2, title: "Pump operations drill", y, m, d: fwd(5), done: false, attendance: [] },
    { id: 106, planId: null, title: "Ladder throws drill", y, m, d: fwd(9), done: false, attendance: [] },
  ];
}
const sessDate = (s) => new Date(s.y, s.m, s.d);
const fmtSess = (s) => sessDate(s).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
function CheckinConfirm({ S, result, members, meId, go }) {
  const me = members.find((m) => m.id === meId);
  const ok = result?.ok;
  const pending = result?.pending;
  return (
    <div style={{ maxWidth: 520, margin: "0 auto" }}>
      <div style={{ ...S.opCard, textAlign: "center", padding: "34px 22px" }}>
        {pending ? <Loader2 size={48} color="#6A7178" /> : ok ? <CheckCircle2 size={48} color="#2E7D52" /> : <AlertTriangle size={48} color="#B11E2A" />}
        <h2 style={{ ...S.featTitle, marginTop: 14 }}>{pending ? "Checking you in…" : ok ? (result.already ? "Already checked in" : "You're checked in!") : "Couldn't check you in"}</h2>
        <p style={{ color: "#3A4750", fontSize: 14.5, marginTop: 6, lineHeight: 1.5 }}>
          {pending
            ? "One moment while we confirm your sign-in."
            : ok
            ? <>{me ? me.name : "You"} {result.already ? "were already signed in to" : "signed in to"} <b>{result.title}</b>{result.at ? ` at ${result.at}` : ""}.</>
            : (result?.reason || "Something went wrong.")}
        </p>
        <button style={{ ...S.primaryBtn, marginTop: 18 }} onClick={() => go("training")}><GraduationCap size={16} /> Go to my training</button>
      </div>
    </div>
  );
}
// Re-viewable AI plan: modal showing an ai_text session_plan (reused by Training + MemberDashboard)
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
// N-plan chooser: lists a session's attached plans with the same View(ai)/Open(file) buttons the session list uses. Reused by member + leader Training.
function SessionPlanChooser({ S, session, onView, onOpen, onClose }) {
  if (!session) return null;
  const plans = session.plans || [];
  return (
    <div onClick={onClose} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.62)", zIndex: 60, display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "40px 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()} style={{ ...FS.card, maxWidth: 520, width: "100%", padding: "18px 20px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, gap: 10 }}>
          <div style={{ ...FS.kicker, marginBottom: 0 }}>{session.title} — PLANS ({plans.length})</div>
          <button style={{ ...FS.btn, padding: "6px 10px", flexShrink: 0 }} onClick={onClose}><X size={14} color={FIRE.btnIcon} /></button>
        </div>
        {plans.map((p) => (
          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
            <FileText size={14} color={p.kind === "ai" ? FIRE.amberText : FIRE.btnIcon} style={{ flexShrink: 0 }} />
            <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: FIRE.name, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || (p.kind === "ai" ? "AI-drafted plan" : "Untitled")}{p.kind === "ai" ? " · AI" : ""}</span>
            {p.kind === "ai"
              ? <button style={{ ...FS.btn, padding: "5px 9px" }} onClick={() => onView(p)}>View</button>
              : <button style={{ ...FS.btn, padding: "5px 9px" }} onClick={() => onOpen(p)}>Open</button>}
          </div>
        ))}
      </div>
    </div>
  );
}
// Shared plan-viewing: ONE scope-safe return — a consumer gets the handlers AND the mounts from the
// same call, so it can't wire a click without also having the viewer mounted (the white-screen we hit).
// AiPlanViewer + SessionPlanChooser stay module-level; the hook just renders them.
function usePlanViewer(S, notify) {
  const [viewPlan, setViewPlan] = useState(null);
  const [chooserSession, setChooserSession] = useState(null);
  async function openPlan(plan) {                                   // single FILE plan → signed URL (deduped from the 2 identical copies)
    if (!plan?.storage_path) return;
    const { data, error } = await supabase.storage.from("station-documents").createSignedUrl(plan.storage_path, 3600);
    if (error || !data?.signedUrl) { notify({ kind: "error", title: "Couldn't open the plan", text: "The plan couldn't be opened — please try again.", details: error?.message ?? "no signed URL" }); return; }
    const a = document.createElement("a"); a.href = data.signedUrl; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
  }
  function openSessionPlans(s) {                                    // session-level: 0→toast, 1→open, N→chooser
    const plans = s.plans || [];
    if (plans.length === 0) { notify({ title: "No plan attached", text: "No plan is attached to this session yet." }); return; }
    if (plans.length === 1) { const p = plans[0]; if (p.kind === "ai") setViewPlan(p); else openPlan(p); return; }
    setChooserSession(s);
  }
  const mounts = (<>
    {viewPlan && <AiPlanViewer S={S} plan={viewPlan} onClose={() => setViewPlan(null)} />}
    {chooserSession && <SessionPlanChooser S={S} session={chooserSession} onView={(p) => { setViewPlan(p); setChooserSession(null); }} onOpen={(p) => { openPlan(p); setChooserSession(null); }} onClose={() => setChooserSession(null)} />}
  </>);
  return { openSessionPlans, openPlan, setViewPlan, mounts };
}
function LeadershipTag({ audience }) {   // amber "Leadership" pill for leadership-audience events (list rows); returns null otherwise
  if (audience !== "leadership") return null;
  return <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: ".06em", textTransform: "uppercase", color: FIRE.amberText, border: `0.5px solid ${FIRE.amberText}`, borderRadius: 5, padding: "1px 5px", marginLeft: 7, flexShrink: 0, whiteSpace: "nowrap" }}>Leadership</span>;
}
function Training({ S, role, plan, setPlan, loadPlans, sessions, setSessions, loadSessions, members, meId, notify, dept, addFeedback }) {
  const canManage = hasAny(role, CANMANAGE_OPS_ROLES);   // create/edit sessions + take attendance — ops only (DA/Officer, excludes Board + PA)
  const canRunSignin = hasAny(role, SIGNIN_ROLES);   // QR generate-gate (NOT Board Member, NOT Member)
  const canPlanAI = hasAny(role, SIGNIN_ROLES);   // AI drill planner — same PA/DA/TO set as the retired standalone AI page (NOT canManage: excludes Board, includes PA)
  const memberView = !isLeader(role);
  const today = new Date();
  const me = members.find((m) => m.id === meId);
  const [cur, setCur] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [addingPlan, setAddingPlan] = useState(false);
  const [pn, setPn] = useState(""); const [pc, setPc] = useState("Monthly"); const [pcolor, setPcolor] = useState(CATEGORY_COLORS[0]);
  const [editingPlanId, setEditingPlanId] = useState(null);
  const [ed, setEd] = useState({ name: "", cadence: "Monthly", color: CATEGORY_COLORS[0] });
  const [showSess, setShowSess] = useState(false);
  const [openAtt, setOpenAtt] = useState(null);
  const [openSignin, setOpenSignin] = useState(null);
  // Live codes come from open_signin and are held locally for display only — never persisted/loaded, so a member can't read a code without scanning.
  const [signinTokens, setSigninTokens] = useState({});   // sessionId -> 6-char code (this browser, this open)
  async function openSI(s) {
    const { data, error } = await supabase.rpc("open_signin", { p_session_id: s.id });   // generates/rotates; gated DA/TO/PA at the DB
    if (error) { notify({ kind: "error", title: "Couldn't open sign-in", text: error.message || "Please try again.", details: error.message }); return; }
    setSigninTokens((t) => ({ ...t, [s.id]: data }));
    setOpenSignin(s.id);
    loadSessions();   // refresh signin_open
  }
  const rotateSI = openSI;   // open_signin rotates on every call
  async function closeSI(s) {
    const { error } = await supabase.rpc("close_signin", { p_session_id: s.id });
    if (error) { notify({ kind: "error", title: "Couldn't close sign-in", text: error.message || "Please try again.", details: error.message }); return; }
    setSigninTokens((t) => { const n = { ...t }; delete n[s.id]; return n; });
    loadSessions();
  }
  const checkinURL = (s, token) => `${typeof window !== "undefined" ? window.location.origin + window.location.pathname : ""}?checkin=${s.id}&t=${token || ""}`;
  // Full-screen QR overlay + hi-res PNG export for the sign-in code
  const [expandQR, setExpandQR] = useState(null);   // { s, token } | null
  const dlQRRef = useRef(null);                      // wraps the hidden 720px export QR (only one panel open at a time)
  function downloadSigninPNG(s, token) {
    const src = dlQRRef.current?.querySelector("canvas");
    if (!src) { notify({ kind: "error", title: "QR not ready", text: "Give the code a moment to render, then try again." }); return; }
    const qr = src.width;                            // 720 — offscreen hi-res, not the 172px on-screen canvas
    const pad = 56, W = qr + pad * 2;
    const c = document.createElement("canvas");
    const ctx = c.getContext("2d");
    // wrap the session title to at most 2 lines so long names don't overflow
    const wrap = (text, font, maxW) => {
      ctx.font = font; const words = String(text || "").split(/\s+/); const lines = []; let line = "";
      for (const w of words) { const t = line ? line + " " + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; }
      if (line) lines.push(line); return lines.slice(0, 2);
    };
    const titleFont = "700 44px system-ui, -apple-system, sans-serif";
    const titleLines = wrap(s.title || "Training sign-in", titleFont, qr);
    const topPad = 44, titleLH = 54, gap = 28, footTop = 56, footLH = 40;
    const titleBlock = titleLines.length * titleLH;
    c.width = W;
    c.height = topPad + titleBlock + gap + qr + footTop + footLH + 40;
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, c.width, c.height);
    ctx.textAlign = "center";
    ctx.fillStyle = "#111827"; ctx.font = titleFont;
    titleLines.forEach((ln, i) => ctx.fillText(ln, W / 2, topPad + titleLH * (i + 1) - 12));
    ctx.drawImage(src, pad, topPad + titleBlock + gap);
    let y = topPad + titleBlock + gap + qr + footTop;
    ctx.fillStyle = "#111827"; ctx.font = "600 38px system-ui, -apple-system, sans-serif";
    ctx.fillText("Scan to check in", W / 2, y); y += footLH;
    ctx.fillStyle = "#6B7280"; ctx.font = "400 28px system-ui, -apple-system, sans-serif";
    ctx.fillText(`${fmtSess(s)} · Code ${token}`, W / 2, y);
    c.toBlob((b) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `signin-${s.id}-${token}.png`; a.click(); URL.revokeObjectURL(a.href); }, "image/png");
  }
  const dim = new Date(cur.y, cur.m + 1, 0).getDate();
  const [sd, setSd] = useState(Math.min(today.getDate(), dim));
  const [spid, setSpid] = useState(plan[0]?.id || 0);
  const [stitle, setStitle] = useState("");
  const [repeat, setRepeat] = useState(false);          // recurring toggle in the schedule form
  const [sAudience, setSAudience] = useState("everyone");   // create-session audience; feeds BOTH addSession + scheduleRecurring
  const [rCad, setRCad] = useState("Bi-weekly");        // recurring cadence (defaults from the picked category)
  const [rCount, setRCount] = useState("26");           // N occurrences (defaults from cadence)
  // AI training-plan drafter (Card 2) + ai_text viewer
  const [draftOpen, setDraftOpen] = useState(false);
  const { openSessionPlans, openPlan, setViewPlan, mounts } = usePlanViewer(S, notify);
  async function toggleAttend(s, mid) {
    if (s.done) return;   // officer lock (UI also hides the control once done)
    const present = (s.attendance || []).includes(mid);
    if (present) {
      const { error } = await supabase.from("session_attendance").delete().eq("session_id", s.id).eq("member_id", mid);
      if (error) { notify({ kind: "error", title: "Couldn't update attendance", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
      setSessions((ss) => ss.map((x) => { if (x.id !== s.id) return x; const t = { ...(x.times || {}) }; delete t[mid]; return { ...x, attendance: (x.attendance || []).filter((y) => y !== mid), times: t }; }));
    } else {
      const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
      if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "We couldn't determine your department — please try again." }); return; }
      const { error } = await supabase.from("session_attendance").insert({ department_id: deptId, session_id: s.id, member_id: mid, checked_in_at: new Date().toISOString() });
      if (error) { notify({ kind: "error", title: "Couldn't update attendance", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
      const now = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      setSessions((ss) => ss.map((x) => x.id === s.id ? { ...x, attendance: [...(x.attendance || []), mid], times: { ...(x.times || {}), [mid]: now } } : x));
    }
  }

  const rank = (l) => (l === "Overdue" || l === "Not logged") ? 0 : l === "Due soon" ? 1 : 2;
  const _t0 = new Date(today); _t0.setHours(0, 0, 0, 0);
  const upcomingFor = (catId) => sessions.filter((s) => String(s.planId) === String(catId) && !s.done && sessDate(s) >= _t0).sort((a, b) => sessDate(a) - sessDate(b))[0];
  const reconcile = (p) => {   // a pre-scheduled future session overrides the derived last+cadence guess (no "overdue" while sessions sit on the calendar)
    const base = dueInfo(p), up = upcomingFor(p.id);
    if (!up) return base;
    const nd = sessDate(up), nl = nd.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    return { ...base, label: "On track", color: "#2E7D52", rel: `next session ${nl}`, nextLabel: nl, next: nd, urgent: false };
  };
  const planView = plan.map((p) => ({ p, info: reconcile(p) })).sort((a, b) => rank(a.info.label) - rank(b.info.label));
  const over = planView.filter((x) => x.info.urgent).length;
  const soon = planView.filter((x) => x.info.label === "Due soon").length;
  const ok = planView.length - over - soon;

  async function addPlan() {
    const name = pn.trim();
    if (!name) { notify({ kind: "error", title: "Training needs a name", text: "Give the training a name before adding it." }); return; }
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "We couldn't determine your department — please try again." }); return; }
    const { error } = await supabase.from("training_plans").insert({ department_id: deptId, name, cadence: pc, color: pcolor });
    if (error) { notify({ kind: "error", title: "Couldn't add the training", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setPn(""); setPc("Monthly"); setPcolor(CATEGORY_COLORS[0]); setAddingPlan(false); loadPlans();
  }
  async function removePlan(id) {
    const p = plan.find((x) => x.id === id);
    if (!window.confirm(`Remove “${p?.name || "this training"}” from the training plan?`)) return;
    const { error } = await supabase.from("training_plans").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove the training", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadPlans();
  }
  function startEditPlan(p) { setEditingPlanId(p.id); setEd({ name: p.name, cadence: p.cadence, color: p.color || CATEGORY_COLORS[0] }); }
  async function updatePlan() {
    const name = ed.name.trim();
    if (!name) { notify({ kind: "error", title: "Training needs a name", text: "Give the training a name before saving it." }); return; }
    const { error } = await supabase.from("training_plans").update({ name, cadence: ed.cadence, color: ed.color }).eq("id", editingPlanId);   // last_iso intentionally NOT updated
    if (error) { notify({ kind: "error", title: "Couldn't save the training", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setEditingPlanId(null); loadPlans();
  }
  function scheduleFor(p) {
    const info = dueInfo(p); setSpid(p.id); setStitle("");
    if (info.next) { const nd = info.next; setCur({ y: nd.getFullYear(), m: nd.getMonth() }); setSd(Math.min(nd.getDate(), new Date(nd.getFullYear(), nd.getMonth() + 1, 0).getDate())); }
    setShowSess(true);
  }
  async function addSession() {
    const pItem = plan.find((p) => String(p.id) === String(spid));
    const title = stitle.trim() || pItem?.name || "Training session";
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "We couldn't determine your department — please try again." }); return; }
    const { error } = await supabase.from("training_sessions").insert({
      department_id: deptId,
      plan_id: pItem ? pItem.id : null,                       // link the session to its training category (null = one-off)
      title,
      date: toISO(new Date(cur.y, cur.m, Number(sd))),
      done: false,
      audience: sAudience,
    });
    if (error) { notify({ kind: "error", title: "Couldn't schedule the session", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setShowSess(false); setStitle(""); loadSessions();
  }
  function toggleRepeat() {
    if (!repeat) {   // opening: seed cadence from the selected category, N from cadence
      const pItem = plan.find((p) => String(p.id) === String(spid));
      const cad = (pItem?.cadence && pItem.cadence !== "One-off") ? pItem.cadence : "Bi-weekly";
      setRCad(cad); setRCount(String(N_FOR_CADENCE[cad] || 12));
    }
    setRepeat((v) => !v);
  }
  async function scheduleRecurring() {
    const pItem = plan.find((p) => String(p.id) === String(spid));
    const cad = rCad || pItem?.cadence || "Monthly";
    const n = Math.max(1, Math.min(Number(rCount) || N_FOR_CADENCE[cad] || 12, 104));   // clamp 1..104 (no fat-finger table bloat)
    const title = stitle.trim() || pItem?.name || "Training session";
    const startY = cur.y, startM = cur.m, startD = Number(sd);
    const dayStep = CADENCE_DAY_STEP[cad], monthStep = CADENCE_MONTH_STEP[cad] || 1;
    const dates = [];
    for (let k = 0; k < n; k++) {
      const d = dayStep ? new Date(startY, startM, startD + k * dayStep) : addMonthsKeepDom(startY, startM, startD, k * monthStep);
      dates.push(toISO(d));
    }
    const existing = new Set((sessions || []).filter((s) => String(s.planId) === String(pItem?.id)).map((s) => toISO(sessDate(s))));
    const fresh = dates.filter((iso) => !existing.has(iso));   // DEDUPE (plan_id, date)
    if (!fresh.length) { notify({ kind: "error", title: "Already scheduled", text: "Those dates are already on the calendar." }); return; }
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "Please try again." }); return; }
    const sid = crypto.randomUUID();
    const rows = fresh.map((iso) => ({ department_id: deptId, plan_id: pItem ? pItem.id : null, title, date: iso, done: false, series_id: sid, audience: sAudience }));
    const { error } = await supabase.from("training_sessions").insert(rows);   // ONE bulk insert
    if (error) { notify({ kind: "error", title: "Couldn't schedule the series", text: "Something went wrong saving those. Please try again.", details: error.message }); return; }
    if (pItem) await supabase.from("training_plans").update({ starts_on: toISO(new Date(startY, startM, startD)) }).eq("id", pItem.id);
    const skipped = dates.length - fresh.length;
    notify({ kind: "success", title: "Sessions scheduled", text: `Added ${fresh.length} ${cad.toLowerCase()} session${fresh.length === 1 ? "" : "s"}${skipped ? ` (${skipped} already existed)` : ""}.` });
    setShowSess(false); setRepeat(false); setStitle(""); loadSessions();
  }
  // "Done for the night" — does NOT lock. Opens the roll writable so the officer can
  // confirm/complete attendance BEFORE finalizing. The lock/clock-reset moves to finalizeSession.
  function beginCloseout(s) {
    setOpenAtt(s.id);   // expand the attendance roster in writable state
  }
  // Finalize & lock — the explicit second step, run AFTER the roll is confirmed.
  async function finalizeSession(s) {
    if (!window.confirm(`Lock attendance for "${s.title}"? You can reopen it later if needed.`)) return;
    // auto-close any open QR sign-in so no stale code lingers / no post-lock scans
    if (s.signinOpen) {
      const { error: cErr } = await supabase.rpc("close_signin", { p_session_id: s.id });
      if (cErr) { notify({ kind: "error", title: "Couldn't close the sign-in", text: "Attendance was not locked — please try again.", details: cErr.message }); return; }
      setSigninTokens((t) => { const n = { ...t }; delete n[s.id]; return n; });
    }
    const { error } = await supabase.from("training_sessions").update({ done: true }).eq("id", s.id);
    if (error) { notify({ kind: "error", title: "Couldn't finalize the session", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    // plan-linked -> reset the overdue clock to today, persisted. One-offs reset nothing.
    if (s.planId) {
      const iso = toISO(new Date());
      const { error: pErr } = await supabase.from("training_plans").update({ last_iso: iso }).eq("id", s.planId);
      if (pErr) notify({ kind: "error", title: "Locked — clock not reset", text: "Attendance is locked, but the training clock couldn't be reset.", details: pErr.message });
      else setPlan((ps) => ps.map((p) => p.id === s.planId ? { ...p, lastISO: iso } : p));
    }
    loadSessions();
    loadPlans();
  }
  // Recover from a premature finalize — flips done back to false and reopens the writable roll.
  // Direct UPDATE, permitted by the existing "leaders update training_sessions" RLS (same policy that
  // wrote done:true); re-enables manual taps + self check-in. HARDEN LATER: a grace-window reopen RPC
  // (mirroring reopen_action_item) could cap how long a finalized session stays reopenable — deferred
  // for the pilot so leaders keep full flexibility to fix attendance.
  async function reopenSession(s) {
    const { error } = await supabase.from("training_sessions").update({ done: false }).eq("id", s.id);
    if (error) { notify({ kind: "error", title: "Couldn't reopen the session", text: "Something went wrong. Please try again.", details: error.message }); return; }
    setOpenAtt(s.id);   // pop the roll back open, writable, for the correction
    loadSessions();
  }
  async function removeSession(id) {
    const sess = sessions.find((x) => x.id === id);
    if (!window.confirm(`Remove “${sess?.title || "this session"}” from the training calendar?`)) return;
    const { error } = await supabase.from("training_sessions").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove the session", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadSessions();
  }

  async function attachPlan(s, file) {
    if (!file) return;
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "We couldn't determine your department — please try again." }); return; }
    // 1) upload the file (APPEND — existing plans are NOT removed; a session can now hold multiple)
    const path = `${deptId}/plans/${Date.now()}-${file.name}`;
    const { error: upErr } = await supabase.storage.from("station-documents").upload(path, file);
    if (upErr) { notify({ kind: "error", title: "Couldn't upload the plan", text: "Something went wrong uploading that. Please try again.", details: upErr.message }); return; }
    // 2) insert a new row (no delete of existing — append). Same canManage RLS, same bucket + plans/ path.
    const { error: insErr } = await supabase.from("session_plans").insert({ department_id: deptId, session_id: s.id, title: file.name, source: "upload", storage_path: path, created_by: me?.name || "Unknown" });
    if (insErr) { notify({ kind: "error", title: "Couldn't attach the plan", text: "The file uploaded but couldn't be attached. Please try again.", details: insErr.message }); loadSessions(); return; }
    notify({ kind: "success", title: "Plan attached", text: `"${file.name}" was attached to ${s.title}.` });
    loadSessions();
  }
  async function detachPlan(plan) {
    if (!plan?.id) return;
    if (!window.confirm(`Remove the attached plan “${plan.title}”?`)) return;
    if (plan.storage_path) { const { error: rmErr } = await supabase.storage.from("station-documents").remove([plan.storage_path]); if (rmErr) { notify({ kind: "error", title: "Couldn't remove the plan", text: "Please try again.", details: rmErr.message }); return; } }
    const { error } = await supabase.from("session_plans").delete().eq("id", plan.id);
    if (error) { notify({ kind: "error", title: "Couldn't remove the plan", text: "The file was removed but its record wasn't.", details: error.message }); }
    loadSessions();
  }

  const monthSessions = sessions.filter((s) => s.y === cur.y && s.m === cur.m).sort((a, b) => a.d - b.d);

  // ============================ MEMBER VIEW (presentational reskin) ============================
  // Reuses existing reads only (sessions/plan/members/monthSessions, dueInfo helpers). No queries,
  // no attendance logic, no MonthCalendar internals touched. Leader return below is unchanged.
  if (memberView) {
    const DISPLAY = "'Oswald', system-ui, sans-serif";
    const t0 = new Date(today); t0.setHours(0, 0, 0, 0);
    const since90 = new Date(t0); since90.setDate(since90.getDate() - 90);
    const inWindow = (s) => { const d = sessDate(s); return d >= since90 && d <= today; };
    const catOf = (s) => plan.find((p) => String(p.id) === String(s.planId));
    // DATA HONESTY: a session only "has a record" once attendance was actually taken (non-empty).
    // Attendance doesn't persist yet, so today every array is empty → these fall to clean empty states.
    const recorded = sessions.filter((s) => s.done && (s.attendance || []).length > 0 && inWindow(s));
    const totalRecorded = recorded.length;
    const attendedCount = recorded.filter((s) => (s.attendance || []).includes(me?.id)).length;
    const pct = totalRecorded ? Math.round((attendedCount / totalRecorded) * 100) : 0;
    const missed = recorded.filter((s) => !(s.attendance || []).includes(me?.id)).sort((a, b) => sessDate(b) - sessDate(a));

    // IDENTICAL chip logic to the leader calendar — colors/layout unchanged (do not alter).
    const renderChip = (s) => {
      const cat = plan.find((p) => String(p.id) === String(s.planId));
      const base = s.audience === "leadership" ? FIRE.amberText : (cat?.color || "#1F4E79");
      const mix = (hex, tt) => {
        const h = hex.replace("#", "");
        const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        const tr = 42, tg = 46, tb = 53; // #2A2E35
        const to2 = (n) => n.toString(16).padStart(2, "0");
        return "#" + to2(Math.round(r + (tr - r) * tt)) + to2(Math.round(g + (tg - g) * tt)) + to2(Math.round(b + (tb - b) * tt));
      };
      const color = s.done ? mix(base, 0.45) : base;
      return { color, label: `${s.done ? "✓ " : ""}${s.title}`, title: `${s.title}${s.audience === "leadership" ? " · Leadership only" : ""}${s.done ? " (completed)" : ""}${(s.plans || []).length ? " · click to view plan" : ""}`, onClick: () => openSessionPlans(s) };
    };

    const card = { ...FS.card, padding: 18, marginBottom: 14 };   // base + member padding/margin (identical)
    const kick = FS.kicker;
    const num = FS.num;

    return (
      <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
        {mounts}
        {/* 1 — header */}
        <div style={{ marginBottom: 18 }}>
          <div style={kick}>MY TRAINING</div>
          <h1 style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Your training calendar</h1>
          <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>See what's scheduled, what you've missed, and where your attendance stands.</div>
        </div>

        {/* 2 — attendance progress */}
        <div style={card}>
          <div style={kick}>MY ATTENDANCE · LAST 90 DAYS</div>
          {totalRecorded === 0 ? (
            <div style={{ marginTop: 12, fontSize: 13.5, color: FIRE.textMuted }}>No sessions recorded yet.</div>
          ) : (<>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", margin: "12px 0 8px" }}>
              <span style={{ fontSize: 13.5, color: FIRE.textSecondary, ...num }}>{attendedCount} of {totalRecorded} sessions attended</span>
              <span style={{ fontSize: 15, fontWeight: 700, color: FIRE.greenText, ...num }}>{pct}%</span>
            </div>
            <div style={{ height: 8, borderRadius: 999, background: FIRE.track, overflow: "hidden" }}>
              <div style={{ width: `${pct}%`, height: "100%", background: FIRE.green, borderRadius: 999 }} />
            </div>
          </>)}
        </div>

        {/* 3 — missed / catch up (hidden entirely when no real missed records) */}
        {missed.length > 0 && (
          <div style={card}>
            <div style={kick}>TRAINING YOU MISSED · CATCH UP</div>
            <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
              {missed.map((s) => { const cat = catOf(s); return (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 999, background: cat?.color || "#1F4E79", flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary }}>{s.title}</div>
                    <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...num }}>Missed {fmtSess(s)} · {cat?.name || "One-off"}</div>
                  </div>
                </div>
              ); })}
            </div>
          </div>
        )}

        {/* 4 — training calendar (MonthCalendar + chip logic unchanged; dark calendar in dark card) */}
        <div style={card}>
          <div style={{ ...kick, marginBottom: 12 }}>TRAINING CALENDAR</div>
          <div style={{ marginBottom: -10 }}>{/* cancels MonthCalendar's built-in 10px bottom margin → even inset framing */}
            <MonthCalendar
              cur={cur} setCur={setCur} dark
              items={monthSessions}
              renderChip={renderChip}
              todayColor="#C8323A"
              monthLabel={`${TRAIN_MONTHS[cur.m]} ${cur.y}`}
            />
          </div>
        </div>

        {/* 5 — this month's sessions */}
        <div style={card}>
          <div style={kick}>THIS MONTH'S SESSIONS</div>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
            {monthSessions.length === 0 ? (
              <div style={{ fontSize: 13, color: FIRE.textMuted }}>No sessions scheduled in {TRAIN_MONTHS[cur.m]}.</div>
            ) : monthSessions.map((s) => {
              const cat = catOf(s); const att = s.attendance || []; const hasRecord = att.length > 0; const present = att.includes(me?.id);
              return (
                <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 11 }}>
                  <CalendarCheck size={15} color={cat?.color || "#1F4E79"} style={{ flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary, display: "flex", alignItems: "center" }}>{s.title}<LeadershipTag audience={s.audience} /></div>
                    <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...num }}>{TRAIN_MONTHS[cur.m].slice(0, 3)} {s.d} · {s.planId ? "counts toward the plan" : "one-off"}</div>
                  </div>
                  {!s.done ? (
                    <span style={{ fontSize: 10.5, fontWeight: 700, color: FIRE.textMuted2, textTransform: "uppercase", letterSpacing: ".08em" }}>Scheduled</span>
                  ) : hasRecord ? (
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 9 }}>
                      <span style={{ fontSize: 11.5, color: FIRE.textMuted, ...num }}>{att.length} attended</span>
                      <span style={{ fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: present ? FIRE.greenText : FIRE.redText }}>{present ? "You came" : "You missed"}</span>
                    </span>
                  ) : (
                    <span style={{ fontSize: 11.5, color: FIRE.textMuted, ...num }}>{att.length} attended</span>
                  )}
                  {s.plan && <button onClick={() => openSessionPlans(s)} style={{ fontSize: 11.5, fontWeight: 600, color: "#C7CDD6", background: "rgba(255,255,255,.04)", border: "0.5px solid rgba(255,255,255,.1)", borderRadius: 8, padding: "5px 9px", cursor: "pointer", flexShrink: 0 }}>Open plan</button>}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    );
  }

  // ---------- leader view: FIRE-palette styles + derived reads (presentational only) ----------
  const Lcard = { ...FS.card, padding: 16 };                                  // base + leader padding (borderRadius FIRE.cardRadius == 16)
  const Lkick = { ...FS.kicker, display: "flex", alignItems: "center", gap: 6 };
  const Lnum = FS.num;
  const Lbtn = FS.btn;                                                        // FIRE.btnBg/.btnBorder/.btnText == prior literals
  const LbtnIcon = FIRE.btnIcon;                                             // == "#9AA1AC"
  const Lfield = { display: "flex", flexDirection: "column", gap: 6 };       // unchanged (not in the consolidation set)
  const LfieldLabel = { fontSize: 12.5, fontWeight: 600, color: "#B6BDC8" }; // unchanged (not in the consolidation set)
  const Linput = FS.input;                                                    // FIRE.inputBorder/.btnBg/.name == prior literals
  const LprimaryBtn = FS.btnPrimary;                                          // FIRE.white == "#fff"
  const Lrow = FS.row;                                                        // FIRE.hairline == "rgba(255,255,255,.05)"
  // map dueInfo's (unchanged) status to lighter FIRE status colors for dark bg — presentational, dueInfo untouched
  const statusColor = (label) => (label === "On track" || label === "Done") ? "#76C98D" : label === "Due soon" ? "#D6A95E" : "#E58A90";
  // Card 1 — most recent done session's attendance (empty until persistence lands)
  const lastDone = sessions.filter((s) => s.done).sort((a, b) => sessDate(b) - sessDate(a))[0];
  const lastAtt = lastDone ? (lastDone.attendance || []).length : 0;
  const cm = members.filter(countsInStats);   // counted members (owner/test excluded) — counts only, NOT identity/display
  const totalMembers = cm.length;
  const hasAtt = !!lastDone && lastAtt > 0;
  const ringR = 26, ringC = 2 * Math.PI * ringR, ringFrac = totalMembers ? lastAtt / totalMembers : 0;
  // Card 3 — next not-done session from today forward (pure read)
  const t0n = new Date(today); t0n.setHours(0, 0, 0, 0);
  const nextSession = sessions.filter((s) => !s.done && sessDate(s) >= t0n).sort((a, b) => sessDate(a) - sessDate(b))[0];
  const nextCat = nextSession ? plan.find((p) => String(p.id) === String(nextSession.planId)) : null;

  return (
    <div>
      {/* header — readable on dark */}
      <div style={{ marginBottom: 18 }}>
        <div style={Lkick}>TRAINING</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: "#F7F8FA", margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Keep training on schedule</h1>
        <div style={{ fontSize: 14, color: "#9AA1AC", lineHeight: 1.5 }}>Your recurring training plan tracks itself — log a session and the clock resets. The plan shows what's coming and what's overdue at a glance.</div>
      </div>

      {/* TOP ROW — three dark cards (replaces the 3 Stat tiles) */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 12, marginBottom: 16 }}>
        {/* Card 1 — last session attendance (ring or honest empty state) */}
        <div style={Lcard}>
          <div style={Lkick}>LAST SESSION ATTENDANCE</div>
          {hasAtt ? (
            <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 12 }}>
              <svg width="72" height="72" viewBox="0 0 72 72" style={{ flexShrink: 0 }}>
                <circle cx="36" cy="36" r={ringR} fill="none" stroke="rgba(255,255,255,.08)" strokeWidth="6" />
                <circle cx="36" cy="36" r={ringR} fill="none" stroke="#76C98D" strokeWidth="6" strokeLinecap="round" strokeDasharray={ringC} strokeDashoffset={ringC * (1 - ringFrac)} transform="rotate(-90 36 36)" />
                <text x="36" y="40" textAnchor="middle" fontSize="15" fontWeight="700" fill="#F7F8FA" style={{ fontFeatureSettings: '"tnum"' }}>{lastAtt}/{totalMembers}</text>
              </svg>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 13.5, fontWeight: 600, color: "#F0F2F5" }}>{lastDone.title}</div>
                <div style={{ fontSize: 11.5, color: "#7E8794", marginTop: 2, ...Lnum }}>{fmtSess(lastDone)}</div>
              </div>
            </div>
          ) : (
            <div style={{ marginTop: 12, fontSize: 13, color: "#7E8794", lineHeight: 1.5 }}>No attendance recorded yet.<div style={{ fontSize: 11.5, color: "#9AA1AC", marginTop: 3 }}>Activates once session sign-in is saved.</div></div>
          )}
        </div>

        {/* Card 2 — training plan (upload + AI draft; neither built → honest "Coming soon") */}
        <div style={Lcard}>
          <div style={Lkick}>TRAINING PLAN</div>
          <div style={{ marginTop: 12, fontSize: 12.5, color: "#B6BDC8", lineHeight: 1.5 }}>Attach a plan or syllabus to a specific session — use <b style={{ color: "#F0F2F5" }}>Attach plan</b> on any session in the calendar below.</div>
          {canPlanAI && <button onClick={() => setDraftOpen((v) => !v)} style={{ ...Lbtn, marginTop: 10, width: "100%", justifyContent: "center" }}><Sparkles size={14} color={LbtnIcon} /> {draftOpen ? "Close planner" : "Draft with AI"}</button>}
          <div style={{ fontSize: 11, color: "#7E8794", marginTop: 8 }}>Draft a session plan with AI, then attach it to a session.</div>
        </div>

        {/* Card 3 — next session (pure read of existing sessions) */}
        <div style={Lcard}>
          <div style={Lkick}>NEXT SESSION</div>
          {nextSession ? (
            <div style={{ marginTop: 12 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ width: 9, height: 9, borderRadius: 999, background: nextCat?.color || "#1F4E79", flexShrink: 0 }} />
                <div style={{ fontSize: 14, fontWeight: 600, color: "#F0F2F5" }}>{nextSession.title}</div>
              </div>
              <div style={{ fontSize: 12, color: "#B6BDC8", marginTop: 4, ...Lnum }}>{fmtSess(nextSession)}</div>
              {nextCat && <div style={{ fontSize: 11.5, color: "#7E8794", marginTop: 2 }}>Last trained: {nextCat.lastISO ? new Date(nextCat.lastISO + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : <span style={{ color: "#D08A8F" }}>never logged</span>}</div>}
            </div>
          ) : (
            <div style={{ marginTop: 12, fontSize: 13, color: "#7E8794" }}>Nothing scheduled yet.</div>
          )}
        </div>
      </div>

      {draftOpen && canPlanAI && <AIDrillPlanner S={S} addFeedback={addFeedback} sessions={sessions} loadSessions={loadSessions} notify={notify} dept={dept} me={me} role={role} categories={plan} />}
      {mounts}
      {/* overdue banner — kept as-is (light alert, per instruction) */}
      {over > 0 && (
        <div style={{ display: "flex", gap: 9, alignItems: "center", background: "#FBE9EB", border: "1px solid #F0CDD2", color: "#8A1620", borderRadius: 10, padding: "10px 13px", fontSize: 13.5, marginBottom: 16 }}>
          <AlertTriangle size={16} style={{ flexShrink: 0 }} />
          <span><b>{over}</b> training{over === 1 ? "" : "s"} overdue or never logged — see the plan below and schedule a session.</span>
        </div>
      )}

      {/* TRAINING CATEGORIES */}
      <div style={{ ...Lkick, marginBottom: 10 }}><GraduationCap size={13} /> TRAINING CATEGORIES</div>
      {canManage && (addingPlan ? (
        <div style={{ ...Lcard, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...Lfield, flex: 1, minWidth: 170 }}><span style={LfieldLabel}>Training</span><input style={Linput} value={pn} placeholder="e.g. Ladder operations" onChange={(e) => setPn(e.target.value)} /></label>
          <label style={{ ...Lfield, minWidth: 140 }}><span style={LfieldLabel}>How often</span><select style={Linput} value={pc} onChange={(e) => setPc(e.target.value)}>{CADENCES.map((c) => <option key={c}>{c}</option>)}</select></label>
          <div style={{ ...Lfield, minWidth: 150 }}><span style={LfieldLabel}>Color</span>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 2 }}>
              {CATEGORY_COLORS.map((col) => (
                <button key={col} title={col} onClick={() => setPcolor(col)}
                  style={{ width: 24, height: 24, borderRadius: 999, background: col, cursor: "pointer", border: pcolor === col ? "3px solid #F7F8FA" : "2px solid transparent", boxShadow: "0 0 0 1px rgba(255,255,255,.12)" }} />
              ))}
            </div>
          </div>
          <button style={LprimaryBtn} onClick={addPlan}><Plus size={15} /> Add to plan</button>
          <button style={Lbtn} onClick={() => setAddingPlan(false)}>Cancel</button>
        </div>
      ) : <button style={{ ...Lbtn, marginBottom: 12 }} onClick={() => setAddingPlan(true)}><Plus size={15} color={LbtnIcon} /> Add a training</button>)}
      <div>
        {planView.length === 0 ? (
          <div style={{ ...Lcard, fontSize: 13, color: "#9AA1AC" }}>No training requirements yet{canManage ? " — add your first one to start tracking what's due." : "."}</div>
        ) : planView.map(({ p, info }) => (
          editingPlanId === p.id ? (
            <div key={p.id} style={{ ...Lcard, marginBottom: 8, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
              <label style={{ ...Lfield, flex: 1, minWidth: 170 }}><span style={LfieldLabel}>Training</span><input style={Linput} value={ed.name} onChange={(e) => setEd((v) => ({ ...v, name: e.target.value }))} /></label>
              <label style={{ ...Lfield, minWidth: 140 }}><span style={LfieldLabel}>How often</span><select style={Linput} value={ed.cadence} onChange={(e) => setEd((v) => ({ ...v, cadence: e.target.value }))}>{CADENCES.map((c) => <option key={c}>{c}</option>)}</select></label>
              <div style={{ ...Lfield, minWidth: 150 }}><span style={LfieldLabel}>Color</span>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", paddingTop: 2 }}>
                  {CATEGORY_COLORS.map((col) => (
                    <button key={col} title={col} onClick={() => setEd((v) => ({ ...v, color: col }))}
                      style={{ width: 24, height: 24, borderRadius: 999, background: col, cursor: "pointer", border: ed.color === col ? "3px solid #F7F8FA" : "2px solid transparent", boxShadow: "0 0 0 1px rgba(255,255,255,.12)" }} />
                  ))}
                </div>
              </div>
              <button style={LprimaryBtn} onClick={updatePlan}>Save</button>
              <button style={Lbtn} onClick={() => setEditingPlanId(null)}>Cancel</button>
            </div>
          ) : (
            <div key={p.id} style={Lrow}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: p.color || "#1F4E79", flexShrink: 0, display: "inline-block" }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <span style={{ fontWeight: 600, color: "#F0F2F5" }}>{p.name}</span> <span style={{ color: "#9AA1AC", fontSize: 13 }}>· {p.cadence}</span>
                <div style={{ fontSize: 12, color: "#7E8794", marginTop: 1, ...Lnum }}>Last: {p.lastISO ? new Date(p.lastISO + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : <span style={{ color: "#D08A8F" }}>never logged</span>} · <span style={{ color: statusColor(info.label) }}>{info.rel}</span></div>
              </div>
              <Pill S={S} color={statusColor(info.label)}>{info.label.toUpperCase()}</Pill>
              {canManage && <button style={Lbtn} onClick={() => scheduleFor(p)}><CalendarCheck size={14} color={LbtnIcon} /> Schedule</button>}
              {canManage && <button title="Edit" style={{ ...Lbtn, padding: "6px 8px" }} onClick={() => startEditPlan(p)}><Pencil size={14} color={LbtnIcon} /></button>}
              {canManage && <button title="Remove" style={{ ...Lbtn, padding: "6px 8px" }} onClick={() => removePlan(p.id)}><X size={14} color="#C8606A" /></button>}
            </div>
          )
        ))}
      </div>

      {/* TRAINING CALENDAR */}
      <div style={{ ...Lkick, marginTop: 22, marginBottom: 10 }}><Calendar size={13} /> TRAINING CALENDAR</div>
      {canManage && (showSess ? (
        <div style={{ ...Lcard, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...Lfield, minWidth: 90 }}><span style={LfieldLabel}>{repeat ? "Start day" : "Day"}</span><select style={Linput} value={sd} onChange={(e) => setSd(e.target.value)}>{Array.from({ length: dim }, (_, i) => i + 1).map((d) => <option key={d}>{d}</option>)}</select></label>
          <label style={{ ...Lfield, minWidth: 170 }}><span style={LfieldLabel}>Training</span><select style={Linput} value={spid} onChange={(e) => setSpid(e.target.value)}>{plan.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}<option value={0}>Other / one-off…</option></select></label>
          <label style={{ ...Lfield, flex: 1, minWidth: 150 }}><span style={LfieldLabel}>Title (optional)</span><input style={Linput} value={stitle} placeholder="Defaults to the training name" onChange={(e) => setStitle(e.target.value)} /></label>
          <label style={{ ...Lfield, minWidth: 200 }}><span style={LfieldLabel}>Audience</span>
            <div style={{ display: "flex", borderRadius: 8, overflow: "hidden", border: `1px solid ${FIRE.btnBorder}` }}>
              {[["everyone", "Everyone"], ["leadership", "Leadership only"]].map(([val, lbl], i) => {
                const on = sAudience === val;
                return <button key={val} type="button" onClick={() => setSAudience(val)} style={{ flex: 1, padding: "8px 10px", fontSize: 12.5, fontWeight: 600, cursor: "pointer", whiteSpace: "nowrap", border: "none", borderLeft: i ? `1px solid ${FIRE.btnBorder}` : "none", background: on ? "rgba(255,255,255,.10)" : "transparent", color: on ? (val === "leadership" ? FIRE.amberText : "#F0F2F5") : "#9AA1AC" }}>{lbl}</button>;
              })}
            </div></label>
          <label style={{ ...Lfield, minWidth: 120 }}><span style={LfieldLabel}>Repeat</span>
            <button onClick={toggleRepeat} style={{ ...Linput, cursor: "pointer", textAlign: "left", color: repeat ? "#F0F2F5" : "#9AA1AC" }}>{repeat ? "Recurring ✓" : "One session"}</button></label>
          {repeat && <label style={{ ...Lfield, minWidth: 130 }}><span style={LfieldLabel}>How often</span>
            <select style={Linput} value={rCad} onChange={(e) => { setRCad(e.target.value); setRCount(String(N_FOR_CADENCE[e.target.value] || 12)); }}>{Object.keys(N_FOR_CADENCE).map((c) => <option key={c}>{c}</option>)}</select></label>}
          {repeat && <label style={{ ...Lfield, minWidth: 100 }}><span style={LfieldLabel}>Occurrences</span><input type="number" min="1" max="104" style={Linput} value={rCount} onChange={(e) => setRCount(e.target.value)} /></label>}
          {repeat
            ? <button style={LprimaryBtn} onClick={scheduleRecurring}><Plus size={15} /> Schedule {Math.min(Number(rCount) || 0, 104) || "…"} sessions</button>
            : <button style={LprimaryBtn} onClick={addSession}><Plus size={15} /> Add to {TRAIN_MONTHS[cur.m]}</button>}
          <button style={Lbtn} onClick={() => setShowSess(false)}>Cancel</button>
        </div>
      ) : <button style={{ ...Lbtn, marginBottom: 12 }} onClick={() => { setSpid(plan[0]?.id || 0); setSd(Math.min(today.getDate(), dim)); setSAudience("everyone"); setShowSess(true); }}><Plus size={15} color={LbtnIcon} /> Schedule a session</button>)}

      {/* calendar wrapped in dark card; dark calendar in dark card; red today marker */}
      <div style={{ ...Lcard, marginBottom: 16 }}>
        <div style={{ marginBottom: -10 }}>
          <MonthCalendar
            cur={cur} setCur={setCur} dark
            items={monthSessions}
            renderChip={(s) => {
              // base color = linked category's live color, or fallback blue for one-off / deleted category
              const cat = plan.find((p) => String(p.id) === String(s.planId));
              const base = s.audience === "leadership" ? FIRE.amberText : (cat?.color || "#1F4E79");
              // dim toward dark slate for completed (keep dark enough for white text)
              const mix = (hex, t) => {
                const h = hex.replace("#", "");
                const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
                const tr = 42, tg = 46, tb = 53; // #2A2E35
                const to2 = (n) => n.toString(16).padStart(2, "0");
                return "#" + to2(Math.round(r + (tr - r) * t)) + to2(Math.round(g + (tg - g) * t)) + to2(Math.round(b + (tb - b) * t));
              };
              const color = s.done ? mix(base, 0.45) : base;
              return { color, label: `${s.done ? "✓ " : ""}${s.title}`, title: `${s.title}${s.audience === "leadership" ? " · Leadership only" : ""}${s.done ? " (completed)" : ""}${(s.plans || []).length ? " · click to view plan" : ""}`, onClick: () => openSessionPlans(s) };
            }}
            todayColor="#C8323A"
            monthLabel={`${TRAIN_MONTHS[cur.m]} ${cur.y}`}
          />
        </div>

        <div>
          {monthSessions.length === 0 ? <div style={{ fontSize: 12.5, color: "#7E8794", marginTop: 10 }}>No sessions scheduled in {TRAIN_MONTHS[cur.m]}.</div> :
            monthSessions.map((s) => {
              const att = s.attendance || [];
              const open = openAtt === s.id;
              const ldrEvent = s.audience === "leadership";
              const counted = members.filter(countsInStats);                                                          // exclude Project Admins (Ashlea + Demo, by role) + owner/test — same rule as deptAttendance/RECENT EVENTS
              const expected = ldrEvent ? counted.filter((m) => isLeader(m.access)) : counted;                        // counted population (leaders for leadership events)
              const roll = ldrEvent ? counted.filter((m) => isLeader(m.access) || att.includes(m.id)) : counted;      // shown = expected ∪ actual attendees (never hide a real check-in)
              const expCount = expected.length;                                                                        // denominator M
              const attCount = expected.filter((m) => att.includes(m.id)).length;                                      // numerator N — expected who attended
              return (
                <div key={s.id}>
                  <div style={Lrow}>
                    <CalendarCheck size={15} color={plan.find((p) => String(p.id) === String(s.planId))?.color || "#1F4E79"} style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, color: "#F0F2F5" }}>{s.title}<LeadershipTag audience={s.audience} /></span>
                      <div style={{ fontSize: 12, color: "#7E8794", marginTop: 1, ...Lnum }}>{TRAIN_MONTHS[cur.m].slice(0, 3)} {s.d}{s.planId ? " · counts toward the plan" : " · one-off"}{s.done ? ` · ${attCount}/${expCount} attended` : ""}</div>
                    </div>
                    {/* REORDERED: Attendance → QR sign-in → Mark complete / DONE → delete */}
                    <button style={Lbtn} onClick={() => setOpenAtt(open ? null : s.id)}><Users size={14} color={LbtnIcon} /> Attendance {attCount}/{expCount}</button>
                    {canRunSignin && !s.done && <button style={{ ...Lbtn, ...(s.signinOpen ? { color: "#76C98D", borderColor: "rgba(118,201,141,.4)" } : {}) }} onClick={() => setOpenSignin(openSignin === s.id ? null : s.id)}><QrCode size={14} color={s.signinOpen ? "#76C98D" : LbtnIcon} /> QR sign-in{s.signinOpen ? " · open" : ""}</button>}
                    {canManage && (
                      <label style={{ ...Lbtn, cursor: "pointer" }}><FileText size={14} color={LbtnIcon} /> {s.plans.length ? "Attach more" : "Attach plan"}<input type="file" multiple style={{ display: "none" }} onChange={async (e) => { const files = Array.from(e.target.files || []); e.target.value = ""; for (const f of files) await attachPlan(s, f); }} /></label>
                    )}
                    {s.done
                      ? <><Pill S={S} color="#76C98D">DONE</Pill>{canManage && <button style={Lbtn} onClick={() => reopenSession(s)}><RotateCcw size={14} color={LbtnIcon} /> Reopen</button>}</>
                      : canManage && <button style={Lbtn} onClick={() => beginCloseout(s)}><ClipboardCheck size={14} color={LbtnIcon} /> Done for the night</button>}
                    {canManage && <button title="Remove" style={{ ...Lbtn, padding: "6px 8px" }} onClick={() => removeSession(s.id)}><X size={14} color="#C8606A" /></button>}
                  </div>
                  {s.plans.length > 0 && (
                    <div style={{ ...Lcard, margin: "2px 0 10px", padding: 12 }}>
                      <div style={{ fontSize: 11, color: "#7E8794", marginBottom: 6, textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700 }}>Plans &amp; materials ({s.plans.length})</div>
                      {s.plans.map((p) => (
                        <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "6px 0", borderBottom: "0.5px solid rgba(255,255,255,.05)" }}>
                          <FileText size={14} color={p.kind === "ai" ? "#D6A95E" : LbtnIcon} style={{ flexShrink: 0 }} />
                          <span style={{ flex: 1, minWidth: 0, fontSize: 13, color: "#F0F2F5", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title || (p.kind === "ai" ? "AI-drafted plan" : "Untitled")}{p.kind === "ai" ? " · AI" : ""}</span>
                          {p.kind === "file"
                            ? <button style={{ ...Lbtn, padding: "5px 9px" }} onClick={() => openPlan(p)}><FileText size={13} color={LbtnIcon} /> Open</button>
                            : <button style={{ ...Lbtn, padding: "5px 9px" }} onClick={() => setViewPlan(p)}><FileText size={13} color={LbtnIcon} /> View</button>}
                          {canManage && <button title="Remove" style={{ ...Lbtn, padding: "5px 7px" }} onClick={() => detachPlan(p)}><X size={13} color="#C8606A" /></button>}
                        </div>
                      ))}
                    </div>
                  )}
                  {open && (
                    <div style={{ ...Lcard, margin: "2px 0 10px", padding: 12 }}>
                      <div style={{ fontSize: 12, color: "#9AA1AC", marginBottom: 8 }}>{canManage ? (s.done ? "This session is complete — attendance is locked. Reopen to make changes." : "Tap a name to mark who attended, then finalize.") : "Who attended this session."}</div>
                      {roll.map((m) => {
                        const present = att.includes(m.id);
                        return (
                          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderBottom: "0.5px solid rgba(255,255,255,.05)" }}>
                            {canManage && !s.done
                              ? <button onClick={() => toggleAttend(s, m.id)} title={present ? "Mark absent" : "Mark present"} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "inline-flex" }}>{present ? <CheckCircle2 size={18} color="#76C98D" /> : <span style={{ width: 16, height: 16, borderRadius: 999, border: "2px solid rgba(255,255,255,.25)", display: "inline-block" }} />}</button>
                              : (present ? <CheckCircle2 size={18} color="#76C98D" /> : <X size={16} color="#E58A90" />)}
                            <span style={{ flex: 1, fontSize: 13.5, color: present ? "#F0F2F5" : "#9AA1AC" }}>{m.name}{m.id === meId ? " (you)" : ""}{ldrEvent && !isLeader(m.access) ? <span style={{ color: "#7E8794", fontWeight: 400, fontSize: 11.5 }}> · not counted</span> : ""}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, color: present ? "#76C98D" : "#E58A90" }}>{present ? "PRESENT" : "ABSENT"}</span>
                          </div>
                        );
                      })}
                      {canManage && !s.done && (
                        <div style={{ marginTop: 10, display: "flex", justifyContent: "flex-end" }}>
                          <button style={LprimaryBtn} onClick={() => finalizeSession(s)}><ClipboardCheck size={15} /> Finalize &amp; lock attendance</button>
                        </div>
                      )}
                    </div>
                  )}
                  {canRunSignin && !s.done && openSignin === s.id && (() => {
                    const liveToken = signinTokens[s.id];
                    return (
                    <div style={{ ...Lcard, margin: "2px 0 10px", padding: 14 }}>
                      {!liveToken ? (
                        <div>
                          <div style={{ fontSize: 13, color: "#B6BDC8", marginBottom: 10 }}>{s.signinOpen ? <>A sign-in is already live for <b style={{ color: "#F0F2F5" }}>{s.title}</b>. Show the code to display the QR (this generates a fresh code).</> : <>Open a QR sign-in for <b style={{ color: "#F0F2F5" }}>{s.title}</b>. Members scan it on their own phones to check themselves in.</>}</div>
                          <button style={LprimaryBtn} onClick={() => openSI(s)}><QrCode size={15} /> {s.signinOpen ? "Show / refresh code" : "Open sign-in"}</button>
                          {s.signinOpen && <button style={{ ...Lbtn, marginLeft: 8 }} onClick={() => closeSI(s)}><X size={14} color="#C8606A" /> Close</button>}
                        </div>
                      ) : (
                        <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                          <div style={{ textAlign: "center" }}>
                            <div style={{ background: "#fff", padding: 10, border: "1px solid #E7E5EE", borderRadius: 12, display: "inline-block" }}>
                              <QRCodeCanvas value={checkinURL(s, liveToken)} size={172} />
                            </div>
                            {/* offscreen hi-res QR — read by downloadSigninPNG, never shown */}
                            <div ref={dlQRRef} aria-hidden style={{ position: "absolute", left: -99999, top: 0, pointerEvents: "none" }}>
                              <QRCodeCanvas value={checkinURL(s, liveToken)} size={720} marginSize={2} />
                            </div>
                            <div style={{ marginTop: 8, fontSize: 12, color: "#9AA1AC" }}>This session's code: <b style={{ letterSpacing: 2, color: "#F0F2F5" }}>{liveToken}</b></div>
                            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10, flexWrap: "wrap" }}>
                              <button style={Lbtn} onClick={() => setExpandQR({ s, token: liveToken })}><Maximize2 size={14} color={LbtnIcon} /> Expand</button>
                              <button style={Lbtn} onClick={() => downloadSigninPNG(s, liveToken)}><Download size={14} color={LbtnIcon} /> Download PNG</button>
                              <button style={Lbtn} onClick={() => rotateSI(s)}><RefreshCw size={14} color={LbtnIcon} /> Rotate code</button>
                              <button style={{ ...Lbtn, padding: "7px 11px" }} onClick={() => closeSI(s)}><X size={14} color="#C8606A" /> Close</button>
                            </div>
                          </div>
                          <div style={{ flex: 1, minWidth: 190 }}>
                            <div style={{ fontSize: 12, fontWeight: 700, color: "#9AA1AC", marginBottom: 6 }}>SIGNED IN ({(s.attendance || []).length})</div>
                            {(s.attendance || []).length === 0 ? <div style={{ fontSize: 12.5, color: "#7E8794" }}>No one's scanned in yet.</div> :
                              (s.attendance || []).map((id) => { const mm = members.find((x) => x.id === id); const tt = (s.times || {})[id];
                                return (
                                  <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 13 }}>
                                    <CheckCircle2 size={15} color="#76C98D" style={{ flexShrink: 0 }} />
                                    <span style={{ flex: 1, color: "#F0F2F5" }}>{mm ? mm.name : `Member #${id}`}{id === meId ? " (you)" : ""}</span>
                                    <span style={{ fontSize: 11.5, color: "#7E8794" }}>{tt || "added"}</span>
                                  </div>
                                );
                              })}
                            <div style={{ fontSize: 11, color: "#7E8794", marginTop: 12, lineHeight: 1.5 }}>Each session gets its own code; rotate it if it leaks. The code is generated server-side, and a scan records the scanning member's own attendance.</div>
                          </div>
                        </div>
                      )}
                    </div>
                    );
                  })()}
                </div>
              );
            })}
        </div>
      </div>
      {expandQR && (
        <div onClick={() => setExpandQR(null)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.92)", zIndex: 80, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: 24, cursor: "pointer" }}>
          <div style={{ color: "#fff", fontSize: 26, fontWeight: 700, textAlign: "center", marginBottom: 22, maxWidth: 640 }}>{expandQR.s.title}</div>
          <div style={{ background: "#fff", padding: 20, borderRadius: 16 }}>
            <QRCodeCanvas value={checkinURL(expandQR.s, expandQR.token)} size={Math.min((typeof window !== "undefined" ? Math.min(window.innerWidth, window.innerHeight) : 560) - 200, 560)} marginSize={1} />
          </div>
          <div style={{ color: "#fff", fontSize: 22, fontWeight: 600, marginTop: 22 }}>Scan to check in</div>
          <div style={{ color: "rgba(255,255,255,.6)", fontSize: 14, marginTop: 8 }}>{fmtSess(expandQR.s)} · Code {expandQR.token} · tap anywhere to close</div>
        </div>
      )}
    </div>
  );
}

/* ---------------- Brand Kit ---------------- */
const FONT_STACKS = {
  "Condensed (bold)": "'Oswald','Arial Narrow','Helvetica Neue',Arial,sans-serif",
  "Modern sans": "'Inter','Helvetica Neue',Arial,sans-serif",
  "Classic serif": "Georgia,'Times New Roman',serif",
};
const DEFAULT_BRAND = {
  name: "North Hood Country VFD", station: "Station 20",
  primary: "#B11E2A", accent: "#1F4E79", font: "Condensed (bold)",
  tagline: "Neighbors helping neighbors.",
  voice: "Warm, plain-spoken, proud but never boastful — we talk like neighbors, not a corporation.",
  logo: null, guidelines: [],
};
function BrandKit({ S, role, brand, setBrand, setDept }) {
  const canManage = hasAny(role, DEPT_ADMIN_ROLES);
  const set = (k, v) => setBrand((b) => ({ ...b, [k]: v }));
  function onLogo(e) { const file = e.target.files?.[0]; if (!file) return; const r = new FileReader(); r.onload = () => set("logo", r.result); r.readAsDataURL(file); }
  const [saving, setSaving] = useState(false);
  const [saveState, setSaveState] = useState("");   // "" | "ok" | "err"
  async function saveBrand() {
    setSaving(true); setSaveState("");
    const { data: id } = await supabase.rpc("my_department_id");   // same dept-id source as the load; BrandKit has no dept.id
    if (!id) { setSaving(false); setSaveState("err"); return; }
    const { data, error } = await supabase.from("departments").update({
      name: brand.name, station: brand.station, primary_color: brand.primary, accent_color: brand.accent, font: brand.font, tagline: brand.tagline, voice: brand.voice,
    }).eq("id", id).select();   // .select() so we can detect a silent 0-row RLS block (logo_url + guidelines excluded in v1)
    setSaving(false);
    if (error || !data || data.length === 0) { setSaveState("err"); return; }   // 0 rows = RLS blocked → surface an error, never a false "Saved"
    setDept?.((d) => ({ ...(d || {}), name: brand.name }));   // keep the sidebar/header crest name in sync live
    setSaveState("ok"); setTimeout(() => setSaveState(""), 2500);
  }
  const swatch = (k, label) => (
    <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>{label}</span>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <input type="color" value={brand[k]} disabled={!canManage} onChange={(e) => set(k, e.target.value)} style={{ width: 42, height: 38, border: `0.5px solid ${FIRE.btnBorder}`, borderRadius: 8, background: FIRE.btnBg, padding: 2, cursor: canManage ? "pointer" : "default" }} />
        <input style={{ ...FS.input, width: 110 }} value={brand[k]} disabled={!canManage} onChange={(e) => set(k, e.target.value)} />
      </div>
    </label>
  );
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>MEDIA BUILDER</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Build on-brand media</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Set your colors, logo, font, voice, and department guidelines once — then make on-brand graphics. The recruitment and visibility drafters use these too.</div>
      </div>
      {!canManage && <div style={{ ...FS.card, padding: 14, marginBottom: 14, fontSize: 13, color: FIRE.textMuted }}>You can view the brand kit. Editing is limited to department admins.</div>}
      <div style={{ ...FS.card, padding: 18 }}>
        <div style={{ ...FS.kicker, marginBottom: 8 }}><Palette size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />IDENTITY</div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
          <label style={{ ...S.field, flex: 1, minWidth: 200 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Department name</span><input style={FS.input} value={brand.name} disabled={!canManage} onChange={(e) => set("name", e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Station</span><input style={FS.input} value={brand.station} disabled={!canManage} onChange={(e) => set("station", e.target.value)} /></label>
        </div>
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", marginTop: 8 }}>
          {swatch("primary", "Primary color")}
          {swatch("accent", "Accent color")}
          <label style={{ ...S.field, minWidth: 170 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Headline font</span><select style={FS.input} value={brand.font} disabled={!canManage} onChange={(e) => set("font", e.target.value)}>{Object.keys(FONT_STACKS).map((k) => <option key={k}>{k}</option>)}</select></label>
        </div>
      </div>
      <div style={{ ...FS.card, padding: 18, marginTop: 12 }}>
        <div style={{ ...FS.kicker, marginBottom: 8 }}><ImageIcon size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />LOGO</div>
        <div style={{ display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ width: 84, height: 84, borderRadius: 12, border: `0.5px solid ${FIRE.hairline}`, background: FIRE.btnBg, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden", flexShrink: 0 }}>
            {brand.logo ? <img src={brand.logo} alt="logo" style={{ width: "100%", height: "100%", objectFit: "contain" }} /> : <ImageIcon size={26} color={FIRE.textMuted2} />}
          </div>
          {canManage && <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <label style={{ ...FS.btn, cursor: "pointer" }}><Upload size={15} color={FIRE.btnIcon} /> Upload logo<input type="file" accept="image/*" onChange={onLogo} style={{ display: "none" }} /></label>
            {brand.logo && <button style={FS.btn} onClick={() => set("logo", null)}><X size={14} color={FIRE.deleteRed} /> Remove</button>}
          </div>}
        </div>
        <p style={{ ...S.helpP, marginTop: 8, marginBottom: 0, color: FIRE.textMuted }}>PNG with a transparent background works best. The logo is stored in this session for the prototype.</p>
      </div>
      <div style={{ ...FS.card, padding: 18, marginTop: 12 }}>
        <div style={{ ...FS.kicker, marginBottom: 8 }}>VOICE & TAGLINE</div>
        <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Tagline</span><input style={FS.input} value={brand.tagline} disabled={!canManage} onChange={(e) => set("tagline", e.target.value)} /></label>
        <label style={{ ...S.field, marginTop: 8 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>How the department sounds</span><textarea style={{ ...FS.input, minHeight: 70, resize: "vertical", lineHeight: 1.5 }} value={brand.voice} disabled={!canManage} onChange={(e) => set("voice", e.target.value)} /></label>
        <p style={{ ...S.helpP, marginBottom: 0, color: FIRE.textMuted }}>The AI drafters use this so recruitment posts and captions sound like you.</p>
      </div>
      {canManage && (
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 12, flexWrap: "wrap" }}>
          <button style={{ ...FS.btnPrimary, opacity: saving ? 0.7 : 1 }} onClick={saveBrand} disabled={saving}>{saving ? <><Loader2 size={16} className="spin" /> Saving…</> : <><CheckCircle2 size={16} /> Save changes</>}</button>
          {saveState === "ok" && <span style={{ fontSize: 13, color: FIRE.greenText, fontWeight: 600 }}>Saved ✓</span>}
          {saveState === "err" && <span style={{ fontSize: 13, color: FIRE.redText }}>Couldn't save — check your permissions.</span>}
          <span style={{ fontSize: 11.5, color: FIRE.textMuted }}>Saves name, station, colors, font, tagline &amp; voice. (Logo &amp; guidelines coming soon.)</span>
        </div>
      )}
      <div style={{ ...FS.card, padding: 18, marginTop: 12, display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 8 }}><span style={{ width: 28, height: 28, borderRadius: 6, background: brand.primary }} /><span style={{ width: 28, height: 28, borderRadius: 6, background: brand.accent }} /></div>
        <div style={{ fontFamily: FONT_STACKS[brand.font], fontWeight: 800, fontSize: 22, color: FIRE.textPrimary }}>{brand.name}</div>
        <div style={{ fontSize: 13, color: FIRE.textMuted, flex: 1, minWidth: 140 }}>{brand.tagline}</div>
      </div>

      <div style={{ ...FS.card, padding: 18, marginTop: 12 }}>
        <div style={{ ...FS.kicker, marginBottom: 8 }}><FileText size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />DEPARTMENT GUIDELINES</div>
        <p style={{ ...S.helpP, marginTop: 0, color: FIRE.textMuted }}>Upload your department's brand or style guidelines (PDF, image, or doc). They're kept on file here so everyone builds media the way your department needs.</p>
        {canManage && (
          <label style={{ ...FS.btn, marginTop: 4, cursor: "pointer", display: "inline-flex" }}><Upload size={15} color={FIRE.btnIcon} /> Upload guideline
            <input type="file" accept=".pdf,.doc,.docx,image/*" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (!f) return; set("guidelines", [...(brand.guidelines || []), { id: Date.now(), name: f.name }]); e.target.value = ""; }} /></label>
        )}
        <div style={{ marginTop: 10 }}>
          {(brand.guidelines || []).length === 0 ? <div style={{ fontSize: 13, color: FIRE.textMuted }}>No guidelines uploaded yet.</div> :
            (brand.guidelines || []).map((g) => (
              <div key={g.id} style={{ display: "flex", alignItems: "center", gap: 9, padding: "7px 0", borderBottom: `0.5px solid ${FIRE.hairline}` }}>
                <FileText size={15} color={FIRE.btnIcon} style={{ flexShrink: 0 }} />
                <span style={{ flex: 1, fontSize: 13.5, color: FIRE.textPrimary }}>{g.name}</span>
                {canManage && <button title="Remove" style={{ ...FS.btn, padding: "5px 8px" }} onClick={() => set("guidelines", (brand.guidelines || []).filter((x) => x.id !== g.id))}><X size={13} color={FIRE.deleteRed} /></button>}
              </div>
            ))}
        </div>
      </div>

      <div style={{ marginTop: 18 }}><GraphicStudio S={S} brand={brand} /></div>
    </div>
  );
}

/* ---------------- Graphics Studio (on-brand templates) ---------------- */
function escX(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
function initialsOf(name) { return (String(name || "").trim().split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase()) || "VF"; }
function wrapLines(text, max) { const words = String(text || "").split(/\s+/); const lines = []; let cur = ""; words.forEach((w) => { if ((cur + " " + w).trim().length > max) { if (cur) lines.push(cur); cur = w; } else cur = (cur + " " + w).trim(); }); if (cur) lines.push(cur); return lines.length ? lines : [""]; }
function tspans(lines, x, y, lh) { return lines.map((ln, i) => `<tspan x="${x}" y="${y + i * lh}">${escX(ln)}</tspan>`).join(""); }
const GFX_SIZES = [
  { key: "square", name: "Square 1:1", w: 1080, h: 1080, hint: "Instagram / Facebook feed" },
  { key: "portrait", name: "Portrait 4:5", w: 1080, h: 1350, hint: "Taller feed post" },
  { key: "story", name: "Story 9:16", w: 1080, h: 1920, hint: "Stories / Reels / TikTok" },
  { key: "landscape", name: "Landscape 16:9", w: 1200, h: 675, hint: "Facebook / X / website header" },
];
function stackRows(rows, x, anchor, top, bottom) {
  let total = 0;
  rows.forEach((r, i) => { total += r.lines.length * r.lh + (i < rows.length - 1 ? (r.gap ?? 18) : 0); });
  let y = top + Math.max(0, (bottom - top - total) / 2);
  let out = "";
  rows.forEach((r, idx) => {
    r.lines.forEach((ln, i) => { out += `<text x="${x}" y="${Math.round(y + r.size + i * r.lh)}" text-anchor="${anchor}" font-family="${r.ff}" font-size="${r.size}" font-weight="${r.weight || 400}"${r.italic ? ' font-style="italic"' : ''}${r.spacing ? ` letter-spacing="${r.spacing}"` : ''} fill="${r.fill}">${escX(ln)}</text>`; });
    y += r.lines.length * r.lh + (idx < rows.length - 1 ? (r.gap ?? 18) : 0);
  });
  return out;
}
const STYLES = [
  { key: "bold", name: "Bold" },
  { key: "badge", name: "Badge" },
  { key: "checker", name: "Checkered" },
  { key: "classic", name: "Classic" },
];
function shade(hex, p) {
  let h = (hex || "#000000").replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  let r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  const t = p < 0 ? 0 : 255, a = Math.abs(p);
  r = Math.round((1 - a) * r + a * t); g = Math.round((1 - a) * g + a * t); b = Math.round((1 - a) * b + a * t);
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}
function maltesePath(cx, cy, R) {
  const ri = R * 0.18, ro = R, rn = R * 0.58, aOut = 40 * Math.PI / 180, aIn = 33 * Math.PI / 180;
  const pt = (r, a) => `${(cx + r * Math.sin(a)).toFixed(1)} ${(cy - r * Math.cos(a)).toFixed(1)}`;
  const dirs = [0, Math.PI / 2, Math.PI, 3 * Math.PI / 2]; let d = "";
  dirs.forEach((dir, k) => { d += (k === 0 ? "M " : "L ") + pt(ri, dir - aIn) + " L " + pt(ro, dir - aOut) + " L " + pt(rn, dir) + " L " + pt(ro, dir + aOut) + " L " + pt(ri, dir + aIn) + " "; });
  return d + "Z";
}
function buildGraphicSVG(tk, brand, f, photo, bg, size, style) {
  const W = size?.w || 1080, H = size?.h || 1080;
  const ff = FONT_STACKS[brand.font] || FONT_STACKS["Modern sans"];
  const P = brand.primary || "#B11E2A", A = brand.accent || "#1F4E79", GOLD = "#E5B53C";
  const st = style || "bold";
  const darkBase = tk === "post" || tk === "stat";
  const darkBg = !!bg || darkBase;
  const ink = darkBg ? "#ffffff" : "#16181C", sub = darkBg ? "rgba(255,255,255,0.86)" : "#3A4750";
  const logo = brand.logo, M = 64, sc = H < 820 ? 0.78 : 1, Z = (n) => Math.round(n * sc);
  const defs = `<defs>
    <linearGradient id="gp" x1="0" y1="0" x2="0.35" y2="1"><stop offset="0" stop-color="${shade(P, 0.16)}"/><stop offset="1" stop-color="${shade(P, -0.28)}"/></linearGradient>
    <linearGradient id="ga" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${shade(A, 0.12)}"/><stop offset="1" stop-color="${shade(A, -0.30)}"/></linearGradient>
    <linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#EFEEF3"/></linearGradient>
  </defs>`;
  const pFill = st === "classic" ? P : "url(#gp)";
  const aFill = st === "classic" ? A : "url(#ga)";
  let bgLayer;
  if (bg) bgLayer = `<image href="${bg}" x="0" y="0" width="${W}" height="${H}" preserveAspectRatio="xMidYMid slice"/><rect width="${W}" height="${H}" fill="${pFill}" opacity="0.62"/>`;
  else if (darkBg) bgLayer = `<rect width="${W}" height="${H}" fill="${pFill}"/>`;
  else bgLayer = `<rect width="${W}" height="${H}" fill="${st === "classic" ? "#ffffff" : "url(#gl)"}"/>`;
  let deco = "";
  if ((st === "bold" || st === "badge") && !bg) {
    const R = Math.min(W, H) * 0.5;
    deco += `<path d="${maltesePath(W * 0.9, H * 0.88, R)}" fill="${darkBg ? "#ffffff" : P}" opacity="${darkBg ? 0.07 : 0.05}"/>`;
  }
  if (st === "checker") {
    const sq = 30, n = Math.ceil(W / sq);
    for (let i = 0; i < n; i++) deco += `<rect x="${i * sq}" y="0" width="${sq}" height="18" fill="${i % 2 ? "#ffffff" : A}"/>`;
  }
  const emblem = (x, y, s, light) => logo
    ? `<image href="${logo}" x="${x}" y="${y}" width="${s}" height="${s}" preserveAspectRatio="xMidYMid meet"/>`
    : `<path d="${maltesePath(x + s / 2, y + s / 2, s * 0.5)}" fill="${light ? "#ffffff" : P}"/>`;
  const ring = st === "classic" ? P : "url(#ga)";
  let body = "";
  if (tk === "flyer") {
    const bandH = Math.max(92, Math.min(160, Math.round(H * 0.135)));
    const center = stackRows([
      { lines: [(f.l1 || "").toUpperCase()], size: Z(44), lh: Z(54), weight: 700, spacing: 3, fill: A, ff, gap: 14 },
      { lines: wrapLines(f.l2, 16), size: Z(90), lh: Z(100), weight: 800, fill: ink, ff, gap: 22 },
      { lines: wrapLines(f.l3, 40), size: Z(40), lh: Z(50), weight: 400, fill: sub, ff },
    ], M, "start", bandH + 10, H - bandH - 56);
    body = `<rect x="0" y="0" width="${W}" height="${bandH}" fill="${pFill}"/>${emblem(48, (bandH - 78) / 2, 78, true)}
      <text x="${W - 48}" y="${bandH / 2 + 13}" text-anchor="end" font-family="${ff}" font-size="38" font-weight="700" fill="#fff">${escX(brand.name)}</text>
      ${center}
      <text x="${M}" y="${H - bandH - 22}" font-family="${ff}" font-size="28" fill="${sub}">${escX(brand.tagline)}</text>
      <rect x="0" y="${H - bandH}" width="${W}" height="${bandH}" fill="${aFill}"/>
      <text x="${W / 2}" y="${H - bandH / 2 + 13}" text-anchor="middle" font-family="${ff}" font-size="${Z(40)}" font-weight="700" fill="#fff">${escX(f.l4)}</text>`;
  } else if (tk === "post") {
    const center = stackRows([
      { lines: [(f.l1 || "").toUpperCase()], size: Z(34), lh: Z(44), weight: 700, spacing: 2, fill: "rgba(255,255,255,0.92)", ff, gap: 16 },
      { lines: wrapLines(f.l2, 18), size: Z(98), lh: Z(108), weight: 800, fill: "#fff", ff, gap: 20 },
      { lines: wrapLines(f.l3, 34), size: Z(42), lh: Z(52), weight: 400, fill: "rgba(255,255,255,0.9)", ff },
    ], M, "start", 168, H - 96);
    body = `${emblem(M, 56, 80, true)}<text x="${M + 100}" y="109" font-family="${ff}" font-size="38" font-weight="700" fill="#fff">${escX(brand.name)}</text>
      <rect x="${M}" y="148" width="${Z(70)}" height="6" rx="3" fill="${GOLD}"/>
      ${center}
      <rect x="${M}" y="${H - 86}" width="${W - 2 * M}" height="2" fill="rgba(255,255,255,0.3)"/>
      <text x="${M}" y="${H - 42}" font-family="${ff}" font-size="32" fill="rgba(255,255,255,0.85)">${escX(f.l4)}</text>`;
  } else if (tk === "spotlight") {
    const r = Math.round(Math.min(W, H) * 0.16), cx = W / 2, cy = Math.round(H * (H < 820 ? 0.24 : 0.27));
    const pic = photo
      ? `<defs><clipPath id="cc"><circle cx="${cx}" cy="${cy}" r="${r}"/></clipPath></defs><image href="${photo}" x="${cx - r}" y="${cy - r}" width="${r * 2}" height="${r * 2}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cc)"/><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${ring}" stroke-width="12"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${st === "classic" ? A : "url(#ga)"}"/><text x="${cx}" y="${cy + r * 0.22}" text-anchor="middle" font-family="${ff}" font-size="${r * 0.8}" font-weight="800" fill="#fff">${escX(initialsOf(f.l2))}</text>`;
    const ql = wrapLines(f.l4, 38), qLines = ql.map((ln, i) => (i === 0 ? "\u201C" : "") + ln + (i === ql.length - 1 ? "\u201D" : ""));
    const center = stackRows([
      { lines: [(f.l1 || "MEMBER SPOTLIGHT").toUpperCase()], size: Z(38), lh: Z(46), weight: 700, spacing: 3, fill: A, ff, gap: 10 },
      { lines: [f.l2], size: Z(80), lh: Z(88), weight: 800, fill: ink, ff, gap: 6 },
      { lines: [f.l3], size: Z(38), lh: Z(46), weight: 400, fill: sub, ff, gap: 22 },
      { lines: qLines, size: Z(38), lh: Z(50), weight: 400, italic: true, fill: sub, ff },
    ], cx, "middle", cy + r + 22, H - 92);
    body = `<rect x="0" y="0" width="14" height="${H}" fill="${pFill}"/>${pic}<rect x="${cx - 34}" y="${cy + r + 8}" width="68" height="5" rx="2.5" fill="${GOLD}"/>${center}${emblem(cx - 32, H - 86, 64, false)}`;
  } else {
    const big = Math.round(Math.min(W * 0.52, H * (H < 820 ? 0.34 : 0.44)));
    const center = stackRows([
      { lines: [(f.l1 || "").toUpperCase()], size: Z(40), lh: Z(48), weight: 700, spacing: 3, fill: "rgba(255,255,255,0.85)", ff, gap: 4 },
      { lines: [f.l2], size: big, lh: big, weight: 800, fill: "#fff", ff, gap: 2 },
      { lines: wrapLines(f.l3, 26), size: Z(48), lh: Z(56), weight: 400, fill: "rgba(255,255,255,0.92)", ff, gap: 26 },
      { lines: wrapLines(f.l4, 30), size: Z(52), lh: Z(62), weight: 700, fill: "#fff", ff },
    ], M, "start", 150, H - 78);
    body = `${emblem(M, 56, 78, true)}<text x="${M + 96}" y="107" font-family="${ff}" font-size="36" font-weight="700" fill="#fff">${escX(brand.name)}</text>${center}`;
  }
  let frame = "";
  if (st === "badge") frame = `<rect x="22" y="22" width="${W - 44}" height="${H - 44}" fill="none" stroke="${GOLD}" stroke-width="3"/><rect x="31" y="31" width="${W - 62}" height="${H - 62}" fill="none" stroke="${GOLD}" stroke-width="1.5" opacity="0.55"/>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${defs}${bgLayer}${deco}${body}${frame}</svg>`;
}
const GFX_TEMPLATES = [
  { key: "flyer", name: "Recruitment flyer", labels: ["Eyebrow", "Headline", "Subline", "Call to action"], def: { l1: "Now recruiting volunteers", l2: "We need you on the crew", l3: "No experience needed — we train you.", l4: "Stop by the station Tuesdays at 7pm" } },
  { key: "post", name: "Social announcement", labels: ["Label", "Headline", "Details", "Footer / link"], def: { l1: "Community update", l2: "Open house this Saturday", l3: "Food, trucks, and meet your local crew · 10am–2pm.", l4: "North Hood Country VFD · Station 20" } },
  { key: "spotlight", name: "Member spotlight", labels: ["Eyebrow", "Member name", "Role / years", "Quote"], def: { l1: "Member spotlight", l2: "Maria Reyes", l3: "Chief · 12 years of service", l4: "This town is worth showing up for." } },
  { key: "stat", name: "Stat card", labels: ["Eyebrow", "Big number", "What it measures", "Call to action"], def: { l1: "Last month", l2: "41", l3: "calls answered by your volunteers", l4: "Your neighbors need you. Join the crew." } },
];
function GraphicStudio({ S, brand }) {
  const [tk, setTk] = useState("flyer");
  const tmpl = GFX_TEMPLATES.find((t) => t.key === tk);
  const [f, setF] = useState(tmpl.def);
  const [photo, setPhoto] = useState(null);
  const [bg, setBg] = useState(null); const [useBg, setUseBg] = useState(false);
  const [sizeKey, setSizeKey] = useState("square");
  const size = GFX_SIZES.find((s) => s.key === sizeKey) || GFX_SIZES[0];
  const [styleKey, setStyleKey] = useState("bold");
  const [aiOpen, setAiOpen] = useState(false); const [aiPrompt, setAiPrompt] = useState("a red fire engine outside a small-town station at golden hour, cinematic");
  const [aiLoading, setAiLoading] = useState(false); const [aiErr, setAiErr] = useState("");
  function pick(k) { const t = GFX_TEMPLATES.find((x) => x.key === k); setTk(k); setF(t.def); setPhoto(null); }
  function onPhoto(e) { const file = e.target.files?.[0]; if (!file) return; const r = new FileReader(); r.onload = () => setPhoto(r.result); r.readAsDataURL(file); }
  function onUploadBg(e) { const file = e.target.files?.[0]; if (!file) return; const r = new FileReader(); r.onload = () => { setBg(r.result); setUseBg(true); }; r.readAsDataURL(file); e.target.value = ""; }
  const svg = buildGraphicSVG(tk, brand, f, photo, useBg ? bg : null, size, styleKey);
  const dataUrl = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
  function download() {
    const img = new window.Image();
    img.onload = () => { const c = document.createElement("canvas"); c.width = size.w; c.height = size.h; const ctx = c.getContext("2d"); ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, size.w, size.h); ctx.drawImage(img, 0, 0, size.w, size.h); c.toBlob((b) => { const a = document.createElement("a"); a.href = URL.createObjectURL(b); a.download = `${tk}-${size.key}.png`; a.click(); }); };
    img.src = dataUrl;
  }
  async function genAI() {
    setAiLoading(true); setAiErr("");
    try {
      const res = await fetch("/api/image", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: aiPrompt }) });
      const data = await res.json();
      if (!res.ok || data.error) setAiErr(data.error || "AI image isn't available right now.");
      else if (data.image) { setBg(data.image); setUseBg(true); }
    } catch { setAiErr("Couldn't reach the image service."); } finally { setAiLoading(false); }
  }
  return (
    <div style={{ marginTop: 8 }}>
      <div style={S.cardEyebrow}><ImageIcon size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />MAKE A GRAPHIC</div>
      <p style={{ ...S.helpP, color: FIRE.textMuted }}>On-brand graphics using your Brand Kit colors and logo. Pick a template and a size, edit the text, optionally drop in your own background image, and download a ready-to-post PNG.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 10 }}>
        {GFX_TEMPLATES.map((t) => (
          <button key={t.key} onClick={() => pick(t.key)} style={{ ...S.segBtn, background: FIRE.btnBg, borderColor: FIRE.btnBorder, color: FIRE.textSecondary, ...(tk === t.key ? S.segBtnOn : {}) }}>{t.name}</button>
        ))}
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: FIRE.textMuted, letterSpacing: 0.4, marginBottom: 6 }}>SIZE — WHERE'S IT GOING?</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {GFX_SIZES.map((sz) => (
            <button key={sz.key} onClick={() => setSizeKey(sz.key)} title={sz.hint} style={{ ...S.segBtn, background: FIRE.btnBg, borderColor: FIRE.btnBorder, color: FIRE.textSecondary, ...(sizeKey === sz.key ? S.segBtnOn : {}), display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.25, padding: "7px 11px" }}><span>{sz.name}</span><span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7 }}>{sz.hint}</span></button>
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: FIRE.textMuted, letterSpacing: 0.4, marginBottom: 6 }}>STYLE</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {STYLES.map((sy) => (
            <button key={sy.key} onClick={() => setStyleKey(sy.key)} style={{ ...S.segBtn, background: FIRE.btnBg, borderColor: FIRE.btnBorder, color: FIRE.textSecondary, ...(styleKey === sy.key ? S.segBtnOn : {}) }}>{sy.name}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          {[0, 1, 2, 3].map((i) => {
            const key = `l${i + 1}`;
            return (
              <label key={i} style={{ ...S.field, marginBottom: 8 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>{tmpl.labels[i]}</span>
                <input style={FS.input} value={f[key] || ""} onChange={(e) => setF((x) => ({ ...x, [key]: e.target.value }))} /></label>
            );
          })}
          {tk === "spotlight" && (
            <label style={{ ...S.ghostBtn, background: FIRE.btnBg, borderColor: FIRE.btnBorder, color: FIRE.textSecondary, marginTop: 4, cursor: "pointer", display: "inline-flex" }}><Upload size={15} /> {photo ? "Change photo" : "Add member photo"}<input type="file" accept="image/*" onChange={onPhoto} style={{ display: "none" }} /></label>
          )}
          <div style={{ marginTop: 14, padding: 12, border: `1px dashed ${FIRE.btnBorder}`, borderRadius: 10, background: FIRE.btnBg }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: FIRE.textSecondary, display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8 }}><ImageIcon size={14} /> BACKGROUND IMAGE</div>
            <p style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 0, marginBottom: 8 }}>Add a photo behind your text — your text stays readable over it. Optional.</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ ...S.ghostBtn, background: FIRE.btnBg, borderColor: FIRE.btnBorder, color: FIRE.textSecondary, marginTop: 0, cursor: "pointer", display: "inline-flex" }}><Upload size={15} /> Upload image<input type="file" accept="image/*" onChange={onUploadBg} style={{ display: "none" }} /></label>
              {bg && <label style={{ fontSize: 12.5, color: FIRE.textSecondary, display: "inline-flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={useBg} onChange={(e) => setUseBg(e.target.checked)} /> use it</label>}
              {bg && <button style={{ ...S.ghostBtn, marginTop: 0, padding: "5px 9px", fontSize: 12, background: FIRE.btnBg, color: FIRE.redText, borderColor: FIRE.btnBorder }} onClick={() => { setBg(null); setUseBg(false); }}><X size={13} /> Remove</button>}
            </div>
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: `1px solid ${FIRE.hairline}` }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: FIRE.textMuted, display: "inline-flex", alignItems: "center", gap: 6 }}><Wand2 size={13} /> Or generate one with AI <span style={{ fontSize: 10, background: FIRE.btnBg, color: FIRE.textMuted, padding: "1px 6px", borderRadius: 999 }}>BETA</span></div>
                <button style={{ ...S.ghostBtn, background: FIRE.btnBg, borderColor: FIRE.btnBorder, color: FIRE.textSecondary, marginTop: 0, padding: "5px 10px", fontSize: 12 }} onClick={() => setAiOpen((v) => !v)}>{aiOpen ? "Hide" : "Try it"}</button>
              </div>
              {aiOpen && <div style={{ marginTop: 10 }}>
                <p style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 0, marginBottom: 8 }}>Needs an image-provider key set up in the app; each image costs money on the provider's side.</p>
                <textarea style={{ ...FS.input, minHeight: 54, resize: "vertical", fontFamily: "inherit" }} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                  <button style={{ ...FS.btnPrimary, marginTop: 0, opacity: aiLoading ? 0.7 : 1 }} onClick={genAI} disabled={aiLoading}>{aiLoading ? <><Loader2 size={15} className="spin" /> Generating…</> : <><Wand2 size={15} /> Generate</>}</button>
                </div>
                {aiErr && <div style={{ ...S.errBox, marginTop: 8, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{aiErr}</div>}
              </div>}
            </div>
          </div>
        </div>
        <div style={{ width: 300, maxWidth: "100%" }}>
          <div style={{ display: "flex", justifyContent: "center", background: FIRE.btnBg, borderRadius: 12, border: `1px solid ${FIRE.hairline}`, padding: 10 }}>
            <img src={dataUrl} alt="graphic preview" style={{ maxWidth: "100%", maxHeight: 420, borderRadius: 6, display: "block" }} />
          </div>
          <button style={{ ...FS.btnPrimary, marginTop: 10, width: "100%", justifyContent: "center" }} onClick={download}><Download size={16} /> Download {size.w}×{size.h} PNG</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Station Duties ---------------- */
const DUTY_CATEGORIES = ["Cleanup", "Station", "Equipment", "Apparatus", "EMS", "Admin"];
const RECUR = ["Weekly", "Monthly", "Quarterly", "One-time"];
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
function weekStartOf(date, startDay) { const d = new Date(date); d.setHours(0, 0, 0, 0); const diff = (d.getDay() - startDay + 7) % 7; d.setDate(d.getDate() - diff); return d; }
const monthKey = () => { const d = new Date(); return `${d.getFullYear()}-${d.getMonth()}`; };
const quarterKey = () => { const d = new Date(); return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3)}`; };
const DUTY_SEED = [
  { id: 1, duty: "Sweep & mop the apparatus bay", category: "Cleanup", recurrence: "Weekly", done: true, doneBy: "Sam Whitfield", doneAt: "Mon 6:30 PM" },
  { id: 2, duty: "Kitchen & dayroom wipe-down", category: "Cleanup", recurrence: "Weekly", done: false, doneBy: null, doneAt: null },
  { id: 3, duty: "Trash & recycling to the curb", category: "Cleanup", recurrence: "Weekly", done: false, doneBy: null, doneAt: null },
  { id: 4, duty: "Test alarms, lights & bay doors", category: "Station", recurrence: "Monthly", done: false, doneBy: null, doneAt: null },
  { id: 5, duty: "Restock supplies — paper, soap, water", category: "Station", recurrence: "Weekly", done: false, doneBy: null, doneAt: null },
  { id: 6, duty: "Generator fuel & fluid check", category: "Station", recurrence: "Monthly", done: false, doneBy: null, doneAt: null },
  { id: 7, duty: "SCBA & air bottles check", category: "Equipment", recurrence: "Weekly", done: true, doneBy: "Tom Daniels", doneAt: "Mon 6:45 PM" },
  { id: 8, duty: "Hose & nozzle inspection", category: "Equipment", recurrence: "Weekly", done: false, doneBy: null, doneAt: null },
  { id: 9, duty: "Check & stow assigned PPE", category: "Equipment", recurrence: "Weekly", done: false, doneBy: null, doneAt: null },
  { id: 10, duty: "Hose testing & flow records", category: "Equipment", recurrence: "Quarterly", done: false, doneBy: null, doneAt: null },
  { id: 11, duty: "Wash apparatus after calls", category: "Apparatus", recurrence: "Weekly", done: true, doneBy: "Cody Pearson", doneAt: "Tue 7:10 PM" },
  { id: 12, duty: "Fuel & fluid levels on every rig", category: "Apparatus", recurrence: "Weekly", done: false, doneBy: null, doneAt: null },
  { id: 13, duty: "Restock EMS / first-aid bags", category: "EMS", recurrence: "Weekly", done: false, doneBy: null, doneAt: null },
  { id: 14, duty: "Check O2 levels & med expirations", category: "EMS", recurrence: "Monthly", done: false, doneBy: null, doneAt: null },
  { id: 15, duty: "Update run & incident logs", category: "Admin", recurrence: "Weekly", done: false, doneBy: null, doneAt: null },
];
function StationDuties({ S, role, members, meId, notify }) {
  const canManage = hasAny(role, CANMANAGE_OPS_ROLES); // assign/manage duties — ops only (DA/Officer, excludes Board + PA)
  const canCreate = hasAny(role, CANMANAGE_OPS_ROLES); // create duty — ops only (DA/Officer, excludes Board + PA)
  const me = members.find((m) => m.id === meId);
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  const fmtDoneAt = (v) => {
    if (!v) return "";
    const d = new Date(v);
    return isNaN(d.getTime()) ? v : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  };
  const [duties, setDuties] = useState([]);
  const [log, setLog] = useState([]);
  const [pickerForDutyId, setPickerForDutyId] = useState(null); // which duty's picker is open
  const [selectedHelpers, setSelectedHelpers] = useState([]);   // member ids
  const [pickerStage, setPickerStage] = useState("ask");        // "ask" | "pick"
  const [view, setView] = useState("checklist");                // "checklist" | "history"
  const [logEntries, setLogEntries] = useState([]);
  const [weekOffset, setWeekOffset] = useState(0);              // 0 = most recent week with entries
  function loadDuties() {
    supabase.from("duties").select("id, duty, category, recurrence, done, done_by, done_at, helper_ids, assigned_to, due_date").then(({ data, error }) => {
      if (error || !data) return;
      setDuties(data.map((d) => ({
        id: d.id,
        duty: d.duty,
        category: d.category,
        recurrence: d.recurrence,
        done: d.done,
        doneBy: d.done_by,   // raw member UUID (or null) for now — name resolution is a later slice
        doneAt: d.done_at,   // raw timestamptz string for now — formatting is a later slice
        helperIds: d.helper_ids ?? [],
        assignedTo: d.assigned_to ?? null,   // null = station-wide; set = person-assigned
        dueDate: d.due_date ?? null,
      })));
    });
  }
  useEffect(() => { loadDuties(); }, []);
  const loadStationLog = () => {
    supabase.from("station_log")
      .select("id, what, done_by, done_at, created_by")
      .order("done_at", { ascending: false })
      .then(({ data, error }) => {
        if (error || !data) return;
        setLog(data.map((e) => ({ id: e.id, what: e.what, who: e.done_by, when: fmtDoneAt(e.done_at), createdBy: e.created_by })));
      });
  };
  useEffect(() => { loadStationLog(); }, []);
  useEffect(() => {
    if (!canManage) return;
    supabase.from("duty_log")
      .select("id, duty_name, done_by, helper_ids, done_at")
      .order("done_at", { ascending: false })
      .then(({ data, error }) => {
        if (error || !data) return;
        setLogEntries(data.map((e) => ({
          id: e.id,
          dutyName: e.duty_name,
          doneBy: e.done_by,
          helperIds: e.helper_ids ?? [],
          doneAt: e.done_at,
        })));
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canManage]);
  const [addingA, setAddingA] = useState(false);
  const [ad, setAd] = useState(""); const [acat, setAcat] = useState("Cleanup"); const [acatNew, setAcatNew] = useState(""); const [arec, setArec] = useState("Weekly");
  const [assignee, setAssignee] = useState(""); const [due, setDue] = useState("");   // "" = station-wide / no due date
  const [editingDutyId, setEditingDutyId] = useState(null);   // which duty is being edited inline
  const [editBuf, setEditBuf] = useState({ title: "", category: "Cleanup", catNew: "", recurrence: "Weekly", assignee: "", due: "" });
  const [lw, setLw] = useState(""); const [lwho, setLwho] = useState(me?.name || "");
  const [weekStartDay, setWeekStartDay] = useState(1); // Monday by default
  const isoWeek = (day) => toISO(weekStartOf(new Date(), Number(day)));
  const [weekLabel, setWeekLabel] = useState(() => isoWeek(1));
  const weekRef = useRef(weekLabel);
  const monthRef = useRef(monthKey());
  const quarterRef = useRef(quarterKey());
  function setStartDay(day) { setWeekStartDay(Number(day)); const w = isoWeek(day); weekRef.current = w; setWeekLabel(w); }
  useEffect(() => {
    const tick = () => {
      const cw = isoWeek(weekStartDay), cm = monthKey(), cq = quarterKey();
      const kinds = [];
      if (cw !== weekRef.current) { weekRef.current = cw; setWeekLabel(cw); kinds.push("Weekly"); }
      if (cm !== monthRef.current) { monthRef.current = cm; kinds.push("Monthly"); }
      if (cq !== quarterRef.current) { quarterRef.current = cq; kinds.push("Quarterly"); }
      if (kinds.length) setDuties((ds) => ds.map((x) => kinds.includes(x.recurrence) ? { ...x, done: false, doneBy: null, doneAt: null } : x));
    };
    const id = setInterval(tick, 60000); return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [weekStartDay]);
  const fmtWeek = (iso) => new Date(iso + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  const categories = [...DUTY_CATEGORIES.filter((c) => duties.some((d) => d.category === c)), ...[...new Set(duties.map((d) => d.category))].filter((c) => !DUTY_CATEGORIES.includes(c))];
  const allCats = [...new Set([...DUTY_CATEGORIES, ...duties.map((d) => d.category)])];
  function openPicker(id) {
    setEditingDutyId(null);   // close the inline edit card if it's open (mutually exclusive with the completion picker)
    setPickerForDutyId(id);
    setSelectedHelpers([]);
    setPickerStage("ask");
  }
  async function confirmComplete(id) {
    const { error } = await supabase.rpc("complete_duty", { p_duty_id: id, p_helper_ids: selectedHelpers });
    if (error) { notify({ kind: "error", title: "Couldn't mark it done", text: "Something went wrong updating that. Please try again.", details: error.message }); return; }
    setDuties((ds) => ds.map((x) => (x.id === id ? { ...x, done: true, doneBy: me?.id ?? null, doneAt: new Date().toISOString(), helperIds: selectedHelpers } : x)));
    setPickerForDutyId(null);
    setSelectedHelpers([]);
    setPickerStage("ask");
  }
  async function uncompleteDuty(id) {
    const duty = duties.find((x) => x.id === id);
    if (!duty) return;
    // client-side guard mirrors the server rule (doer or leader)
    if (!canManage && duty.doneBy !== me?.id) return;
    const { error } = await supabase.rpc("uncomplete_duty", { p_duty_id: id });
    if (error) { notify({ kind: "error", title: "Couldn't undo that", text: "Something went wrong updating that. Please try again.", details: error.message }); return; }
    setDuties((ds) => ds.map((x) => (x.id === id ? { ...x, done: false, doneBy: null, doneAt: null, helperIds: [] } : x)));
  }
  function resetWeek() { if (!window.confirm("Clear every checkmark and start fresh? Your duties stay on the list.")) return; setDuties((ds) => ds.map((x) => ({ ...x, done: false, doneBy: null, doneAt: null }))); }
  async function addDuty() {
    if (!ad.trim()) return;
    const cat = acat === "__new__" ? (acatNew.trim() || "Cleanup") : acat;
    const { error } = await supabase.rpc("create_duty", { p_title: ad.trim(), p_category: cat, p_recurrence: arec, p_assigned_to: assignee || null, p_due_date: due || null });
    if (error) { notify({ kind: "error", title: "Couldn't add the duty", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    loadDuties();   // re-fetch so the persisted row (real uuid + server-applied recurrence) appears — no optimistic numeric id
    setAd(""); setAcat("Cleanup"); setAcatNew(""); setArec("Weekly"); setAssignee(""); setDue(""); setAddingA(false);
  }
  async function removeDuty(id, title) {
    if (!window.confirm(`Remove “${title}” from the duty checklist? Past completions stay in the log.`)) return;
    const { error } = await supabase.from("duties").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove the duty", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadDuties();   // refetch — UI matches true DB state (covers the silent zero-rows case)
  }
  function startEditDuty(a) {
    setPickerForDutyId(null);   // close the completion picker if it's open on this row
    setEditingDutyId(a.id);
    setEditBuf({ title: a.duty || "", category: a.category || "Cleanup", catNew: "", recurrence: a.recurrence || "Weekly", assignee: a.assignedTo || "", due: a.dueDate || "" });
  }
  async function saveEditDuty(id) {
    if (!editBuf.title.trim()) return;
    const cat = editBuf.category === "__new__" ? (editBuf.catNew.trim() || "Cleanup") : editBuf.category;
    const { error } = await supabase.from("duties").update({ duty: editBuf.title.trim(), category: cat, recurrence: editBuf.recurrence, assigned_to: editBuf.assignee || null, due_date: editBuf.due || null }).eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't save the duty", text: "Something went wrong updating that. Please try again.", details: error.message }); return; }
    setEditingDutyId(null); loadDuties();   // refetch — UI matches true DB state
  }
  async function addLog() {
    if (!lw.trim()) return;
    const { data: deptId, error: deptErr } = await supabase.rpc("my_department_id");
    if (deptErr || !deptId) { notify({ kind: "error", title: "Couldn't find your department", text: "Please try again.", details: deptErr?.message }); return; }
    const { error } = await supabase.from("station_log").insert({ what: lw.trim(), done_by: lwho.trim() || (me?.name || "A member"), department_id: deptId, created_by: meId, done_at: new Date().toISOString() });
    if (error) { notify({ kind: "error", title: "Couldn't log that", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setLw(""); loadStationLog();
  }
  async function removeLog(id) {
    const { error } = await supabase.from("station_log").delete().eq("id", id);
    if (error) { notify({ kind: "error", title: "Couldn't remove that", text: "Something went wrong removing that. Please try again.", details: error.message }); return; }
    loadStationLog();   // refetch — UI matches true DB state (covers the silent zero-rows case)
  }
  const doneCount = duties.filter((d) => d.done).length;
  // History: group duty_log completions by the station's week setting (newest first)
  const historyWeeks = (() => {
    const byWeek = new Map();
    for (const e of logEntries) {
      if (!e.doneAt) continue;
      const wk = toISO(weekStartOf(new Date(e.doneAt), weekStartDay));
      if (!byWeek.has(wk)) byWeek.set(wk, []);
      byWeek.get(wk).push(e);
    }
    return [...byWeek.keys()].sort((a, b) => (a < b ? 1 : -1)).map((wk) => ({ wk, entries: byWeek.get(wk) }));
  })();
  const currentWeek = historyWeeks.length ? historyWeeks[Math.min(weekOffset, historyWeeks.length - 1)] : null;
  const csvField = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  function exportCsv() {
    if (!currentWeek) return;
    const header = ["Duty", "Completed by", "Date & time"];
    const rows = currentWeek.entries.map((e) => {
      const names = [e.doneBy, ...(e.helperIds || [])].map((id) => nameById.get(id)).filter(Boolean).join(", ");
      const d = e.doneAt ? new Date(e.doneAt) : null;
      const when = d && !isNaN(d.getTime()) ? d.toLocaleString("en-US", { year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "";
      return [e.dutyName, names, when];
    });
    const csv = [header, ...rows].map((r) => r.map(csvField).join(",")).join("\r\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `duty-log-week-of-${currentWeek.wk}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      {/* header (inline FS — shared PageHead not mutated) */}
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>STATION DUTIES</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Everyone pitches in</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>The station's duties, grouped into your own categories. Tap the check when something's done — it logs who and when — and recurring duties come back on their own.</div>
      </div>

      {canManage && (
        <div style={{ display: "inline-flex", gap: 6, marginBottom: 14 }}>
          {[["checklist", "Checklist"], ["history", "History"]].map(([k, l]) => {
            const on = view === k;
            return <button key={k} onClick={() => setView(k)} style={{ cursor: "pointer", borderRadius: 999, padding: "6px 14px", fontSize: 13, fontWeight: 700, fontFamily: "inherit", background: on ? FIRE.btnBg : "transparent", color: on ? FIRE.textPrimary : FIRE.navLabel, border: `0.5px solid ${on ? FIRE.red : FIRE.btnBorder}` }}>{l}</button>;
          })}
        </div>
      )}

      {view === "checklist" && (<>
      <div style={{ ...FS.card, padding: 16, marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap" }}>
          <div style={{ flex: 1, minWidth: 180 }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, color: FIRE.textSecondary, marginBottom: 4, ...FS.num }}><span>Week of {fmtWeek(weekLabel)}</span><span><b style={{ color: FIRE.textPrimary }}>{doneCount}</b> of {duties.length} done</span></div>
            <Bar S={S} pct={duties.length ? Math.round((doneCount / duties.length) * 100) : 0} color={FIRE.green} track={FIRE.track} />
          </div>
          {canManage && <button style={FS.btn} onClick={resetWeek}><RefreshCw size={14} color={FIRE.btnIcon} /> Reset now</button>}
          {canCreate && <button style={FS.btn} onClick={() => setAddingA(true)}><Plus size={15} color={FIRE.btnIcon} /> Add a duty</button>}
        </div>
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: `0.5px solid ${FIRE.hairline}`, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", fontSize: 12.5, color: FIRE.textMuted }}>
          <RefreshCw size={13} color={FIRE.btnIcon} style={{ flexShrink: 0 }} />
          <span>Recurring duties roll over on their own — weekly, monthly, or quarterly. One-time duties stay until done.</span>
          {canManage
            ? <label style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 6, color: FIRE.textSecondary }}>Week starts on
                <select style={{ ...FS.input, width: "auto", padding: "5px 8px" }} value={weekStartDay} onChange={(e) => setStartDay(e.target.value)}>{DOW.map((d, i) => <option key={i} value={i}>{d}</option>)}</select>
              </label>
            : <span style={{ marginLeft: "auto", color: FIRE.textMuted }}>Resets every {DOW[weekStartDay]}</span>}
        </div>
      </div>

      {canCreate && addingA && (
        <div style={{ ...FS.card, padding: 16, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
          <label style={{ ...S.field, flex: 1, minWidth: 170 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Duty</span><input style={FS.input} value={ad} placeholder="e.g. Ladder & tool checks" onChange={(e) => setAd(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Category</span><select style={FS.input} value={acat} onChange={(e) => setAcat(e.target.value)}>{allCats.map((c) => <option key={c} value={c}>{c}</option>)}<option value="__new__">+ New category…</option></select></label>
          {acat === "__new__" && <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>New category name</span><input style={FS.input} value={acatNew} placeholder="e.g. Fundraising" onChange={(e) => setAcatNew(e.target.value)} /></label>}
          <label style={{ ...S.field, minWidth: 130 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Recurs</span><select style={FS.input} value={arec} onChange={(e) => setArec(e.target.value)}>{RECUR.map((r) => <option key={r}>{r}</option>)}</select></label>
          <label style={{ ...S.field, minWidth: 160 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Assign to</span><select style={FS.input} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Station-wide (everyone)</option>{members.filter(isAssignable).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Due date (optional)</span><input type="date" style={FS.input} value={due} onChange={(e) => setDue(e.target.value)} /></label>
          <button style={FS.btnPrimary} onClick={addDuty}><Plus size={15} /> Add to checklist</button>
          <button style={FS.btn} onClick={() => setAddingA(false)}>Cancel</button>
        </div>
      )}
      {canCreate && <p style={{ ...S.helpP, marginTop: -2, color: FIRE.textMuted }}>Type a new category name to create one (e.g. “Apparatus,” “Facility,” “Fundraising”). Set a duty to <b>Weekly/Monthly/Quarterly</b> to make it part of your recurring core set, or <b>One-time</b> for a one-off.</p>}

      {categories.map((cat) => {
        const items = duties.filter((d) => d.category === cat);
        if (!items.length) return null;
        const dn = items.filter((d) => d.done).length;
        return (
          <div key={cat} style={{ marginBottom: 16 }}>
            <div style={{ ...FS.kicker, display: "flex", alignItems: "center", marginBottom: 8 }}><ClipboardCheck size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />{cat.toUpperCase()}<span style={{ marginLeft: "auto", fontSize: 11, fontWeight: 700, color: dn === items.length ? FIRE.greenText : FIRE.textSecondary }}>{dn}/{items.length}</span></div>
            {items.map((a) => {
              const participantNames = [a.doneBy, ...(a.helperIds || [])].map((id) => nameById.get(id)).filter(Boolean).join(", ");
              return (
              <div key={a.id}>
                <div style={FS.row}>
                  {(() => {
                    const canUncheck = canManage || a.doneBy === me?.id;
                    const canCompleteThis = a.assignedTo == null || a.assignedTo === me?.id || canManage;
                    if (a.done && !canUncheck) return <span title={`Completed by ${nameById.get(a.doneBy) ?? "a member"} — only they or leadership can undo`} style={{ display: "inline-flex", flexShrink: 0 }}><CheckCircle2 size={22} color={FIRE.green} /></span>;
                    if (!a.done && !canCompleteThis) return <span title={`Assigned to ${nameById.get(a.assignedTo) ?? "a member"} — only they or a leader can complete this`} style={{ display: "inline-flex", flexShrink: 0 }}><span style={{ width: 20, height: 20, borderRadius: 999, border: `2px solid ${FIRE.textMuted2}`, display: "inline-block", opacity: 0.5 }} /></span>;
                    return (
                      <button onClick={() => a.done ? uncompleteDuty(a.id) : openPicker(a.id)} title={a.done ? "Undo (yours)" : "Mark done"} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "inline-flex", flexShrink: 0 }}>
                        {a.done ? <CheckCircle2 size={22} color={FIRE.green} /> : <span style={{ width: 20, height: 20, borderRadius: 999, border: `2px solid ${FIRE.textMuted2}`, display: "inline-block" }} />}
                      </button>
                    );
                  })()}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ fontWeight: 600, color: a.done ? FIRE.textMuted2 : FIRE.textPrimary, textDecoration: a.done ? "line-through" : "none" }}>{a.duty}</span>
                    {a.done && <div style={{ fontSize: 12, color: FIRE.greenText, marginTop: 1 }}>✓ {participantNames || "A member"} · {fmtDoneAt(a.doneAt)}</div>}
                  </div>
                  {a.assignedTo && <span style={{ fontSize: 10.5, fontWeight: 700, color: FIRE.btnText, background: FIRE.btnBg, border: `0.5px solid ${FIRE.btnBorder}`, borderRadius: 999, padding: "3px 8px", flexShrink: 0 }}>Assigned: {nameById.get(a.assignedTo) ?? "Member"}</span>}
                  {a.dueDate && (canManage || a.assignedTo === me?.id) && (() => {
                    const d = new Date(a.dueDate + "T00:00:00");
                    const t = new Date(); t.setHours(0, 0, 0, 0);
                    const days = Math.round((d - t) / 86400000);
                    const tone = days < 0 ? FIRE.redText : days <= 7 ? FIRE.amberText : FIRE.textMuted2;   // overdue red, ≤7d amber, else muted
                    const dl = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
                    return <span style={{ fontSize: 10.5, fontWeight: 700, color: tone, background: FIRE.btnBg, border: `0.5px solid ${FIRE.btnBorder}`, borderRadius: 999, padding: "3px 8px", flexShrink: 0 }}>{days < 0 ? `Overdue ${dl}` : `Due ${dl}`}</span>;
                  })()}
                  <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.3, color: FIRE.navLabel, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, borderRadius: 999, padding: "3px 8px", flexShrink: 0 }}>{(a.recurrence || "Weekly").toUpperCase()}</span>
                  {canManage && <button title="Edit" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => startEditDuty(a)}><Pencil size={14} color={FIRE.textSecondary} /></button>}
                  {canManage && <button title="Remove" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => removeDuty(a.id, a.duty)}><X size={14} color={FIRE.deleteRed} /></button>}
                </div>
                {pickerForDutyId === a.id && (
                  <div style={{ ...FS.card, padding: 14, marginTop: 6, marginBottom: 12, display: "flex", flexDirection: "column", gap: 10 }}>
                    {pickerStage === "ask" ? (<>
                      <span style={{ ...S.fieldLabel, color: FIRE.textPrimary }}>Did you have help?</span>
                      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                        <button style={FS.btnPrimary} onClick={() => confirmComplete(a.id)}><CheckCircle2 size={15} /> No, just me</button>
                        <button style={FS.btn} onClick={() => setPickerStage("pick")}>Yes</button>
                        <button style={FS.btn} onClick={() => { setPickerForDutyId(null); setSelectedHelpers([]); setPickerStage("ask"); }}>Cancel</button>
                      </div>
                    </>) : (<>
                      <span style={{ ...S.fieldLabel, color: FIRE.textPrimary }}>Who helped?</span>
                      <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                        {members.filter((m) => m.id !== me?.id && isAssignable(m)).map((m) => {
                          const sel = selectedHelpers.includes(m.id);
                          return (
                            <button key={m.id} onClick={() => setSelectedHelpers((hs) => hs.includes(m.id) ? hs.filter((x) => x !== m.id) : [...hs, m.id])}
                              style={{ ...FS.btn, padding: "5px 11px", fontSize: 12.5, ...(sel ? { color: FIRE.greenText, border: `0.5px solid ${FIRE.greenText}` } : {}) }}>
                              {m.name}
                            </button>
                          );
                        })}
                      </div>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button style={FS.btnPrimary} onClick={() => confirmComplete(a.id)}><CheckCircle2 size={15} /> Mark done</button>
                        <button style={FS.btn} onClick={() => { setPickerForDutyId(null); setSelectedHelpers([]); setPickerStage("ask"); }}>Cancel</button>
                      </div>
                    </>)}
                  </div>
                )}
                {editingDutyId === a.id && (
                  <div style={{ ...FS.card, padding: 14, marginTop: 6, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
                    <label style={{ ...S.field, flex: 1, minWidth: 170 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Duty</span><input style={FS.input} value={editBuf.title} onChange={(e) => setEditBuf((b) => ({ ...b, title: e.target.value }))} /></label>
                    <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Category</span><select style={FS.input} value={editBuf.category} onChange={(e) => setEditBuf((b) => ({ ...b, category: e.target.value }))}>{allCats.map((c) => <option key={c} value={c}>{c}</option>)}<option value="__new__">+ New category…</option></select></label>
                    {editBuf.category === "__new__" && <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>New category name</span><input style={FS.input} value={editBuf.catNew} onChange={(e) => setEditBuf((b) => ({ ...b, catNew: e.target.value }))} /></label>}
                    <label style={{ ...S.field, minWidth: 130 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Recurs</span><select style={FS.input} value={editBuf.recurrence} onChange={(e) => setEditBuf((b) => ({ ...b, recurrence: e.target.value }))}>{RECUR.map((r) => <option key={r}>{r}</option>)}</select></label>
                    <label style={{ ...S.field, minWidth: 160 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Assign to</span><select style={FS.input} value={editBuf.assignee} onChange={(e) => setEditBuf((b) => ({ ...b, assignee: e.target.value }))}><option value="">Station-wide (everyone)</option>{members.filter(isAssignable).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
                    <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Due date (optional)</span><input type="date" style={FS.input} value={editBuf.due} onChange={(e) => setEditBuf((b) => ({ ...b, due: e.target.value }))} /></label>
                    <button style={FS.btnPrimary} onClick={() => saveEditDuty(a.id)}><CheckCircle2 size={15} /> Save</button>
                    <button style={FS.btn} onClick={() => setEditingDutyId(null)}>Cancel</button>
                  </div>
                )}
              </div>
              );
            })}
          </div>
        );
      })}

      <div style={{ ...FS.kicker, marginTop: 22, marginBottom: 8 }}><CheckCircle2 size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />OTHER WORK LOGGED</div>
      <p style={{ ...S.helpP, color: FIRE.textMuted }}>Did something that isn't on the checklist? Log it here so it's on the record — anyone can add.</p>
      <div style={{ ...FS.card, padding: 16, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>What got done</span><input style={FS.input} value={lw} placeholder="e.g. Tested all hose, logged results" onChange={(e) => setLw(e.target.value)} /></label>
        <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Who</span><input style={FS.input} value={lwho} onChange={(e) => setLwho(e.target.value)} list="dutymembers2" /><datalist id="dutymembers2">{members.filter(isAssignable).map((m) => <option key={m.id} value={m.name} />)}</datalist></label>
        <button style={FS.btnPrimary} onClick={addLog}><Plus size={15} /> Log it</button>
      </div>
      <div>
        {log.map((e) => (
          <div key={e.id} style={FS.row}>
            <CheckCircle2 size={15} color={FIRE.green} style={{ flexShrink: 0 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{e.what}</span>
              <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 1 }}>{e.who} · <span style={{ color: FIRE.textMuted2, ...FS.num }}>{e.when}</span></div>
            </div>
            {canManage && <button title="Remove" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => removeLog(e.id)}><X size={14} color={FIRE.deleteRed} /></button>}
          </div>
        ))}
      </div>
      </>)}

      {view === "history" && canManage && (
        historyWeeks.length === 0 ? (
          <div style={{ ...FS.card, padding: 16, marginBottom: 14, fontSize: 13.5, color: FIRE.textMuted }}>No completions logged yet.</div>
        ) : (
          <>
            <div style={{ ...FS.card, padding: 12, marginBottom: 14, display: "flex", alignItems: "center", gap: 10 }}>
              <button style={{ ...FS.btn, padding: "6px 11px" }} disabled={weekOffset >= historyWeeks.length - 1} onClick={() => setWeekOffset((o) => Math.min(o + 1, historyWeeks.length - 1))}>◀</button>
              <div style={{ flex: 1, textAlign: "center", fontWeight: 600, color: FIRE.textPrimary }}>Week of {fmtWeek(currentWeek.wk)}</div>
              <button style={{ ...FS.btn, padding: "6px 11px" }} disabled={weekOffset <= 0} onClick={() => setWeekOffset((o) => Math.max(o - 1, 0))}>▶</button>
              {currentWeek && <button style={{ ...FS.btn, padding: "6px 10px", fontSize: 12.5 }} onClick={exportCsv}><Download size={14} color={FIRE.btnIcon} /> Download CSV</button>}
            </div>
            <div>
              {currentWeek.entries.map((e) => {
                const names = [e.doneBy, ...(e.helperIds || [])].map((id) => nameById.get(id)).filter(Boolean).join(", ");
                return (
                  <div key={e.id} style={FS.row}>
                    <CheckCircle2 size={15} color={FIRE.green} style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{e.dutyName}</span>
                      <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 1 }}>{names || "A member"} · <span style={FS.num}>{fmtDoneAt(e.doneAt)}</span></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )
      )}
    </div>
  );
}

/* ---------------- Request ---------------- */
function RequestForm({ S, requests, setRequests }) {
  const [topic, setTopic] = useState(""); const [notes, setNotes] = useState(""); const [done, setDone] = useState(false);
  function submit() {
    if (!topic.trim()) return;
    setRequests([{ topic, notes, when: "Just now" }, ...requests]); setTopic(""); setNotes(""); setDone(true); setTimeout(() => setDone(false), 2500);
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      {/* header (inline FS — shared PageHead not used/mutated) */}
      <div style={{ marginBottom: 18 }}>
        <div style={FS.kicker}>CUSTOM TRAINING</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Request a custom packet</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Tell us what your crew needs. We build it into the next monthly drop.</div>
      </div>
      <div style={{ ...FS.card, padding: 22, display: "flex", flexDirection: "column", gap: 14, maxWidth: 620 }}>
        <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Topic or scenario</span><input style={FS.input} placeholder="e.g. Rural water shuttle with one tender" value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
        <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Anything specific to your department?</span><textarea style={{ ...FS.input, minHeight: 88, resize: "vertical" }} placeholder="Apparatus, member count, local hazards, constraints…" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <button style={FS.btnPrimary} onClick={submit}><Send size={16} /> Submit request</button>
        {done && <div style={{ display: "flex", alignItems: "center", gap: 8, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.greenText, borderRadius: 8, padding: "10px 12px", fontSize: 13.5 }}><CheckCircle2 size={16} color={FIRE.green} /> Request received. We'll confirm by email.</div>}
      </div>
      {requests.length > 0 && (
        <div style={{ marginTop: 24 }}><div style={{ ...FS.kicker, marginBottom: 8 }}>YOUR REQUESTS</div>
          {requests.map((r, i) => <div key={i} style={{ ...FS.card, padding: "14px 16px", marginBottom: 8, display: "flex", justifyContent: "space-between", gap: 12, fontSize: 14 }}><div><strong style={{ color: FIRE.textPrimary }}>{r.topic}</strong>{r.notes ? <div style={{ fontSize: 13, color: FIRE.textMuted, marginTop: 3 }}>{r.notes}</div> : null}</div><span style={{ fontSize: 11.5, color: FIRE.textMuted2, flexShrink: 0, ...FS.num }}>{r.when}</span></div>)}
        </div>
      )}
    </div>
  );
}

/* ---------------- Admin ---------------- */
function Admin({ S, library, setLibrary, feedback }) {
  const [title, setTitle] = useState(""); const [track, setTrack] = useState("Fire"); const [time, setTime] = useState("60 min"); const [objective, setObjective] = useState(""); const [done, setDone] = useState(false);
  function publish() {
    if (!title.trim()) return;
    const np = { id: `new-${Date.now()}`, code: `${track.slice(0, 4).toUpperCase()}-${Math.floor(100 + Math.random() * 800)}`, track, title, level: "All levels", time,
      objective: objective || "Objective to be finalized.", equipment: ["To be specified"], instructorGuide: "Draft — review before release.",
      steps: [{ t: "Briefing", d: "Introduce the objective.", m: 10 }], scenario: "Scenario to be added.", discussion: ["Discussion question pending."],
      safety: ["Review against local protocols before use."], evaluation: ["Evaluation criteria pending."], debrief: ["Debrief question pending."], updated: "Just now" };
    setLibrary([np, ...library]); setTitle(""); setObjective(""); setDone(true); setTimeout(() => setDone(false), 2500);
  }
  return (
    <div>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>CONTENT ADMIN</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Publish a packet</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Platform admins add monthly materials. New packets appear in the library immediately.</div>
      </div>
      <div style={{ ...S.formCard, ...FS.card }}>
        <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Packet title</span><input style={FS.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Tanker Shuttle Operations" /></label>
        <div style={S.twoColForm}>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Track</span><select style={FS.input} value={track} onChange={(e) => setTrack(e.target.value)}>{Object.keys(TRACKS).map((k) => <option key={k}>{k}</option>)}</select></label>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Estimated time</span><input style={FS.input} value={time} onChange={(e) => setTime(e.target.value)} /></label>
        </div>
        <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Objective</span><textarea style={{ ...FS.input, minHeight: 66, resize: "vertical" }} value={objective} onChange={(e) => setObjective(e.target.value)} /></label>
        <button style={FS.btnPrimary} onClick={publish}><Plus size={16} /> Publish to library</button>
        {done && <div style={{ ...S.successBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.greenText }}><CheckCircle2 size={16} /> Published. Check the Training Library.</div>}
      </div>

      <div style={{ marginTop: 26 }}>
        <div style={S.cardEyebrow}><MessageSquare size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />FIELD SIGNAL · WHAT WE'RE LEARNING</div>
        <p style={{ ...S.pageSub, marginTop: 0, marginBottom: 14, color: FIRE.textMuted }}>Ratings and critiques from departments on AI-generated plans. Review monthly, spot the patterns, and turn them into sharper prompt rules and better packets — that's how the system improves.</p>
        {(!feedback || feedback.length === 0) ? (
          <div style={{ ...S.empty, ...FS.card, color: FIRE.textMuted }}>No feedback yet. Generate a plan in the AI Training Assistant, rate it, and it'll show up here.</div>
        ) : (
          feedback.map((f, i) => (
            <div key={i} style={{ ...S.fbItem, ...FS.card }}>
              <span style={{ ...S.fbDot, background: f.rating === "up" ? "#2E7D52" : (f.rating === "down" ? "#B11E2A" : "#9AA1A9") }} />
              <div style={{ flex: 1 }}>
                <div style={{ ...S.fbItemTop, color: FIRE.textPrimary }}><strong>{f.topic}</strong>{f.edited && <span style={S.fbEdited}>EDITED</span>}</div>
                {f.tags && f.tags.length > 0 && <div style={{ ...S.fbItemTags, color: FIRE.textMuted }}>{f.tags.join(" · ")}</div>}
                {f.notes && <div style={{ ...S.fbItemNotes, color: FIRE.textSecondary }}>"{f.notes}"</div>}
              </div>
              <span style={{ ...S.reqWhen, color: FIRE.textMuted }}>{f.when}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

/* ---------------- Add Department (Project-Admin-only: create a department + its first admin) ---------------- */
function AddDepartment({ S, role, notify }) {
  const DISPLAY = "'Oswald', system-ui, sans-serif";
  const isPA = hasAny(role, ["Project Admin"]);
  const [f, setF] = useState({ name: "", station: "", city: "", adminName: "", adminEmail: "" });
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState(null);   // { id, name, adminEmail } after success — persists so the link button survives the form reset
  const [linkSent, setLinkSent] = useState(false);
  const set = (k) => (e) => setF((p) => ({ ...p, [k]: e.target.value }));

  // Screen-level PA gate (nav already filters, but guard the render too — mirrors the DB self-gate)
  if (!isPA) return <div style={{ ...FS.card, padding: 24, color: FIRE.textMuted }}>This screen is available to Project Admins only.</div>;

  async function create() {
    const name = f.name.trim(), adminName = f.adminName.trim(), adminEmail = f.adminEmail.trim().toLowerCase();
    if (!name || !adminName || !/^\S+@\S+\.\S+$/.test(adminEmail)) {
      notify({ kind: "error", title: "Missing details", text: "Department name, admin name, and a valid admin email are required." });
      return;
    }
    setBusy(true);
    const { data, error } = await supabase.rpc("pa_create_department", {
      p_name: name, p_station: f.station.trim() || null, p_city: f.city.trim() || null,
      p_admin_name: adminName, p_admin_email: adminEmail,
    });
    setBusy(false);
    if (error) { notify({ kind: "error", title: "Couldn't create the department", text: error.message, details: error.message }); return; }
    setCreated({ id: data, name, adminEmail });
    setLinkSent(false);
    setF({ name: "", station: "", city: "", adminName: "", adminEmail: "" });
    notify({ kind: "success", title: "Department created", text: `${name} is ready — send ${adminEmail} their login link to finish.` });
  }

  async function sendLink() {
    if (!created) return;
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ email: created.adminEmail, options: { emailRedirectTo: APP_URL } });
    setBusy(false);
    if (error) { notify({ kind: "error", title: "Couldn't send the link", text: error.message }); return; }
    setLinkSent(true);
  }

  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>PROJECT ADMIN</div>
        <h1 style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "6px 0 4px", letterSpacing: "-0.01em" }}>Add a department</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Create a new department and its first admin in one step. They sign in with a login link — no password to set up.</div>
      </div>

      <div style={{ ...S.formCard, ...FS.card, maxWidth: 620 }}>
        <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Department name *</span><input style={FS.input} value={f.name} onChange={set("name")} placeholder="e.g. North Hood Volunteer Fire" /></label>
        <div style={S.twoColForm}>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Station</span><input style={FS.input} value={f.station} onChange={set("station")} placeholder="e.g. Station 1" /></label>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>City</span><input style={FS.input} value={f.city} onChange={set("city")} placeholder="e.g. North Hood, TX" /></label>
        </div>
        <div style={{ height: 1, background: FIRE.hairline, margin: "2px 0" }} />
        <div style={FS.kicker}>FIRST ADMIN</div>
        <div style={S.twoColForm}>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Admin name *</span><input style={FS.input} value={f.adminName} onChange={set("adminName")} placeholder="e.g. Scott Miller" /></label>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Admin email *</span><input style={FS.input} type="email" value={f.adminEmail} onChange={set("adminEmail")} placeholder="scott@northhood.org" /></label>
        </div>
        <div style={{ fontSize: 12, color: FIRE.textMuted, lineHeight: 1.5 }}>Created as a <strong style={{ color: FIRE.textSecondary }}>Department Admin</strong>. Their email must be unique and is how they sign in — double-check it.</div>
        <button style={{ ...FS.btnPrimary, opacity: busy ? 0.7 : 1 }} disabled={busy} onClick={create}>{busy ? <Loader2 size={16} className="spin" /> : <Plus size={16} />} Create department</button>
      </div>

      {created && (
        <div style={{ ...FS.card, borderLeft: `3px solid ${FIRE.green}`, padding: "16px 18px", marginTop: 14, maxWidth: 620 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9, color: FIRE.greenText, fontWeight: 700, fontSize: 15 }}><CheckCircle2 size={18} /> {created.name} created</div>
          <div style={{ fontSize: 13.5, color: FIRE.textSecondary, marginTop: 8, lineHeight: 1.5 }}>Send <strong style={{ color: FIRE.textPrimary }}>{created.adminEmail}</strong> a login link so they can sign in and finish setup.</div>
          {linkSent ? (
            <div style={{ display: "flex", alignItems: "center", gap: 8, color: FIRE.greenText, fontSize: 13.5, marginTop: 12 }}><CheckCircle2 size={16} /> Login link sent to {created.adminEmail}.</div>
          ) : (
            <button style={{ ...FS.btn, marginTop: 12, opacity: busy ? 0.7 : 1 }} disabled={busy} onClick={sendLink}><Send size={15} /> Send login link</button>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------- Program Overview (Project-Admin-only, cross-department health/issue radar) ---------------- */
function ProgramOverview({ S, role, notify }) {
  const DISPLAY = "'Oswald', system-ui, sans-serif";
  const [rows, setRows] = useState(null);   // null = loading, [] = loaded/empty
  const [err, setErr] = useState(null);
  const isPA = hasAny(role, ["Project Admin"]);   // PA-only; belt-and-suspenders with the DB self-gate
  const load = () => {
    supabase.rpc("pa_department_radar").then(({ data, error }) => {
      if (error) { setErr(error.message); setRows([]); return; }
      setErr(null); setRows(data || []);
    });
  };
  useEffect(() => { if (isPA) load(); }, []);   // refetched by cards via refresh() after a fix

  // Screen-level PA gate (nav already filters, but guard the render too — mirrors the DB self-gate)
  if (!isPA) return <div style={{ ...FS.card, padding: 24, color: FIRE.textMuted }}>This dashboard is available to Project Admins only.</div>;

  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>PROJECT ADMIN</div>
        <h1 style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "6px 0 4px", letterSpacing: "-0.01em" }}>Program overview</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Issues to act on across your departments — surfaced from live data, so you can catch problems before anyone reports them.</div>
      </div>

      {err && <div style={{ ...FS.card, borderLeft: `3px solid ${FIRE.red}`, padding: "12px 16px", color: FIRE.redText, marginBottom: 12 }}>Couldn't load the overview: {err}</div>}
      {rows === null && !err && <div style={{ ...FS.card, padding: 24, color: FIRE.textMuted, display: "flex", alignItems: "center", gap: 10 }}><Loader2 size={16} className="spin" /> Loading program data…</div>}
      {rows !== null && rows.length === 0 && !err && <div style={{ ...FS.card, padding: 24, color: FIRE.textMuted }}>No departments found.</div>}

      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {(rows || []).map((d) => <ProgramDeptCard key={d.department_id} S={S} d={d} notify={notify} refresh={load} />)}
      </div>
    </div>
  );
}

function ProgramDeptCard({ S, d, notify, refresh }) {
  const DISPLAY = "'Oswald', system-ui, sans-serif";
  const [showNoEmail, setShowNoEmail] = useState(false);
  const healthColor = d.health === "GREEN" ? FIRE.green : d.health === "YELLOW" ? FIRE.amberText : FIRE.redText;
  const healthLabel = d.health === "GREEN" ? "Healthy" : d.health === "YELLOW" ? "Slowing" : "Needs attention";

  // Issue flags — only pushed when count > 0, so a clean dept shows an "all clear" state.
  const flags = [];
  if (d.members_no_email_count  > 0) flags.push({ n: d.members_no_email_count,  tone: "red",   label: "members can't log in (no email)", action: "noemail" });
  if (d.documents_no_text_count > 0) flags.push({ n: d.documents_no_text_count, tone: "amber", label: "SOPs with no readable text (AI grounding off)" });
  if (d.expired_certs_count     > 0) flags.push({ n: d.expired_certs_count,     tone: "red",   label: "expired certifications" });
  if (d.expiring_certs_count    > 0) flags.push({ n: d.expiring_certs_count,    tone: "amber", label: "certs expiring within 3 months" });
  if (d.overdue_duties_count    > 0) flags.push({ n: d.overdue_duties_count,    tone: "amber", label: "overdue station duties" });
  const toneNum = (t) => (t === "red" ? FIRE.redText : FIRE.amberText);
  const toneBar = (t) => (t === "red" ? FIRE.red : FIRE.amberText);

  const daysLabel = d.last_activity == null ? "No activity ever recorded"
    : d.days_since_activity === 0 ? "Active today"
    : `${d.days_since_activity} day${d.days_since_activity === 1 ? "" : "s"} since last activity`;

  return (
    <div style={{ ...FS.card, padding: "18px 20px" }}>
      {/* Header: health dot + department */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <span style={{ width: 12, height: 12, borderRadius: "50%", background: healthColor, boxShadow: `0 0 0 4px ${healthColor}22`, flexShrink: 0 }} />
        <h2 style={{ fontFamily: DISPLAY, fontSize: 22, fontWeight: 700, color: FIRE.textPrimary, margin: 0, letterSpacing: "-0.01em" }}>{d.department_name}</h2>
        {(d.station || d.city) && <span style={{ fontSize: 12.5, color: FIRE.textMuted }}>{[d.station, d.city].filter(Boolean).join(" · ")}</span>}
        <span style={{ marginLeft: "auto", fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em", color: healthColor }}>{healthLabel}</span>
      </div>

      {/* Support: primary admin + resend login link — ONLY when a DA with an email exists.
          When admin_email is null, this hides and the no-email fix below is what applies. */}
      {d.admin_email && (
        <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <span style={{ fontSize: 12, color: FIRE.textMuted }}>Admin: {d.admin_name || d.admin_email}</span>
          <ResendLink email={d.admin_email} notify={notify} />
        </div>
      )}

      {/* NEEDS ATTENTION — the star */}
      <div style={{ marginTop: 16 }}>
        <div style={{ ...FS.kicker, display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <AlertTriangle size={13} style={{ verticalAlign: "-2px" }} /> NEEDS ATTENTION{flags.length > 0 ? ` (${flags.length})` : ""}
        </div>
        {flags.length === 0 ? (
          <div style={{ ...FS.card, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, borderLeft: `3px solid ${FIRE.green}`, padding: "12px 16px", color: FIRE.greenText, fontSize: 13.5, display: "flex", alignItems: "center", gap: 9 }}>
            <CheckCircle2 size={16} /> All clear — nothing needs attention.
          </div>
        ) : (
          <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 10 }}>
            {flags.map((f, i) => f.action === "noemail" ? (
              // the ONLY actionable flag → toggles the inline fix panel
              <button key={i} onClick={() => setShowNoEmail((v) => !v)} style={{ ...FS.card, borderLeft: `3px solid ${toneBar(f.tone)}`, padding: "12px 15px", display: "flex", alignItems: "baseline", gap: 10, cursor: "pointer", textAlign: "left", width: "100%", fontFamily: "inherit" }}>
                <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 26, lineHeight: 1, color: toneNum(f.tone), ...FS.num }}>{f.n}</span>
                <span style={{ flex: 1, fontSize: 13, color: FIRE.textSecondary, lineHeight: 1.35 }}>{f.label}</span>
                <span style={{ fontSize: 11.5, fontWeight: 700, color: FIRE.btnText, whiteSpace: "nowrap" }}>{showNoEmail ? "Close" : "Fix →"}</span>
              </button>
            ) : (
              // every other flag stays informational (non-clickable), exactly as today
              <div key={i} style={{ ...FS.card, borderLeft: `3px solid ${toneBar(f.tone)}`, padding: "12px 15px", display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 26, lineHeight: 1, color: toneNum(f.tone), ...FS.num }}>{f.n}</span>
                <span style={{ fontSize: 13, color: FIRE.textSecondary, lineHeight: 1.35 }}>{f.label}</span>
              </div>
            ))}
          </div>
          {showNoEmail && d.members_no_email_count > 0 && (
            <NoEmailFixPanel S={S} deptId={d.department_id} notify={notify} onFixed={refresh} />
          )}
          </>
        )}
      </div>

      {/* HEALTH PULSE */}
      <div style={{ marginTop: 16 }}>
        <div style={{ ...FS.kicker, marginBottom: 8 }}>HEALTH PULSE</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
          <div style={{ ...S.stat, ...FS.card }}>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: healthColor, flexShrink: 0 }} />
              <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 20, color: FIRE.textPrimary }}>{healthLabel}</span>
            </div>
            <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 6 }}>{daysLabel}</div>
          </div>
          {/* warn when ≤1 active → surfaces the "only one person using it" problem */}
          <Stat S={S} dark n={String(d.active_members_30d)} label="Active members (30d)" warn={Number(d.active_members_30d) <= 1} />
        </div>
      </div>

      {/* SETUP & ACTIVITY */}
      <div style={{ marginTop: 16 }}>
        <div style={{ ...FS.kicker, marginBottom: 8 }}>SETUP &amp; ACTIVITY</div>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: 12 }}>
          <Stat S={S} dark n={String(d.member_count)}            label="Members" />
          <Stat S={S} dark n={String(d.documents_count)}         label="SOPs / documents" />
          <Stat S={S} dark n={String(d.apparatus_count)}         label="Apparatus" />
          <Stat S={S} dark n={String(d.training_sessions_count)} label="Meetings / drills" />
          <Stat S={S} dark n={String(d.open_action_items_count)} label="Open action items" />
          <div style={{ ...S.stat, ...FS.card }}>
            <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
              {d.profile_complete ? <CheckCircle2 size={18} color={FIRE.green} /> : <AlertTriangle size={18} color={FIRE.amberText} />}
              <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 20, color: FIRE.textPrimary }}>{d.profile_complete ? "Complete" : "Incomplete"}</span>
            </div>
            <div style={{ ...S.statLabel, color: FIRE.textMuted }}>Dept profile</div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Resend a login link to a department's admin — signInWithOtp, doesn't disturb the PA's own session.
function ResendLink({ email, notify }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  async function send() {
    setBusy(true);
    const { error } = await supabase.auth.signInWithOtp({ email, options: { emailRedirectTo: APP_URL } });
    setBusy(false);
    if (error) { notify?.({ kind: "error", title: "Couldn't send the link", text: error.message }); return; }
    setSent(true);
  }
  if (sent) return <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: FIRE.greenText }}><CheckCircle2 size={14} /> Login link sent to {email}</span>;
  return (
    <button onClick={send} disabled={busy} style={{ ...FS.btn, padding: "5px 10px", fontSize: 12, opacity: busy ? 0.7 : 1 }}>
      {busy ? <Loader2 size={13} className="spin" /> : <Send size={13} />} Resend login link
    </button>
  );
}

// Inline "fix no-email members" panel — the one actionable radar flag. Lists a dept's no-email
// members (pa_members_missing_email) and sets each email (pa_set_member_email), then refreshes the radar.
function NoEmailFixPanel({ S, deptId, notify, onFixed }) {
  const [list, setList] = useState(null);        // null = loading
  const [drafts, setDrafts] = useState({});      // member_id -> typed email
  const [savingId, setSavingId] = useState(null);
  useEffect(() => {
    supabase.rpc("pa_members_missing_email", { p_department_id: deptId }).then(({ data, error }) => {
      if (error) { notify?.({ kind: "error", title: "Couldn't load members", text: error.message }); setList([]); return; }
      setList(data || []);
    });
  }, [deptId]);
  async function save(m) {
    const email = (drafts[m.member_id] || "").trim();
    if (!/^\S+@\S+\.\S+$/.test(email)) { notify?.({ kind: "error", title: "Invalid email", text: "Enter a valid email address." }); return; }
    setSavingId(m.member_id);
    const { error } = await supabase.rpc("pa_set_member_email", { p_member_id: m.member_id, p_email: email });
    setSavingId(null);
    if (error) { notify?.({ kind: "error", title: "Couldn't save the email", text: error.message }); return; }   // surfaces "already exists" / "valid email required" from the RPC
    notify?.({ kind: "success", title: "Email saved", text: `${m.name} can now sign in with ${email.toLowerCase()}.` });
    setList((l) => (l || []).filter((x) => x.member_id !== m.member_id));   // drop locally
    onFixed?.();   // refresh the radar so the count drops
  }
  return (
    <div style={{ ...FS.card, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, padding: "14px 16px", marginTop: 10 }}>
      <div style={{ fontSize: 12.5, fontWeight: 700, color: FIRE.textSecondary, marginBottom: 10 }}>Add an email so these members can sign in</div>
      {list === null ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: FIRE.textMuted, fontSize: 13 }}><Loader2 size={14} className="spin" /> Loading…</div>
      ) : list.length === 0 ? (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: FIRE.greenText, fontSize: 13 }}><CheckCircle2 size={15} /> All members now have an email.</div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {list.map((m) => (
            <div key={m.member_id} style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <span style={{ fontSize: 13.5, color: FIRE.textPrimary, minWidth: 120 }}>{m.name}</span>
              <input type="email" value={drafts[m.member_id] || ""} onChange={(e) => setDrafts((p) => ({ ...p, [m.member_id]: e.target.value }))} placeholder="name@email.com" style={{ ...FS.input, flex: 1, minWidth: 160, padding: "7px 10px", fontSize: 13.5 }} />
              <button onClick={() => save(m)} disabled={savingId === m.member_id} style={{ ...FS.btn, padding: "6px 12px", fontSize: 12, opacity: savingId === m.member_id ? 0.7 : 1 }}>
                {savingId === m.member_id ? <Loader2 size={13} className="spin" /> : "Save"}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------------- shared bits ---------------- */
function PageHead({ S, eyebrow, title, sub }) {
  return <div style={S.pageHead}><div style={S.cardEyebrow}>{eyebrow}</div><h1 style={S.pageTitle}>{title}</h1>{sub && <p style={S.pageSub}>{sub}</p>}</div>;
}
function Stat({ S, n, label, warn, dark }) {
  return <div style={dark ? { ...S.stat, ...FS.card } : S.stat}><div style={{ ...S.statN, color: warn ? (dark ? FIRE.redBright : "#B11E2A") : (dark ? FIRE.textPrimary : "#191C20") }}>{n}</div><div style={dark ? { ...S.statLabel, color: FIRE.textMuted } : S.statLabel}>{label}</div></div>;
}
function Meta({ Icon, text, dark }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: dark ? FIRE.textMuted : "#6A7178" }}><Icon size={14} /> {text}</span>;
}
function TrackPill({ S, track }) {
  const T = TRACKS[track];
  return <span style={{ ...S.trackPill, background: `${T.accent}18`, color: T.accent }}><T.Icon size={12} /> {T.label}</span>;
}
function Chip({ S, active, accent, onClick, children }) {
  return <button onClick={onClick} style={{ ...S.chip, background: active ? (accent || "#191C20") : "#fff", color: active ? "#fff" : "#3A4750", borderColor: active ? (accent || "#191C20") : "#D2D5D8" }}>{children}</button>;
}
function Section({ S, Icon, title, children }) {
  return <div style={S.section}><div style={S.sectionHead}><Icon size={16} color="#54506B" /> {title}</div>{children}</div>;
}
function Disclaimer({ S, compact, dark }) {
  return <div style={{ ...S.disclaimer, ...(compact ? { marginTop: 0 } : {}), ...(dark ? { background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, borderLeft: `3px solid ${FIRE.amberText}`, color: FIRE.textSecondary } : {}) }}><AlertTriangle size={16} color={dark ? FIRE.amberText : undefined} style={{ flexShrink: 0, marginTop: 1 }} /><span>{DISCLAIMER}</span></div>;
}
function Logo() {
  return <img src="/b4c-logo.png" alt="Before the Call" style={{ height: 34, width: "auto", flexShrink: 0, display: "block" }} />;
}
function Fonts() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Public+Sans:wght@400;500;600;700&family=IBM+Plex+Mono:wght@500;600&display=swap');
      * { box-sizing: border-box; } body { margin: 0; }
      .spin { animation: spin .9s linear infinite; } @keyframes spin { to { transform: rotate(360deg); } }
      input:focus, select:focus, textarea:focus { outline: 2px solid #1F4E79; outline-offset: 1px; }
      button:focus-visible { outline: 2px solid #1F4E79; outline-offset: 2px; }
      @media (max-width: 900px) {
        .dr-side { position: fixed; left: -290px; transition: left .22s ease; z-index: 40; height: 100dvh; }
        .dr-side.open { left: 0; }
        .dr-menu { display: inline-flex !important; }
      }
    `}</style>
  );
}

/* ---------------- styles ---------------- */
function baseStyles() {
  const display = "'Oswald', system-ui, sans-serif", body = "'Public Sans', system-ui, sans-serif", mono = "'IBM Plex Mono', ui-monospace, monospace";
  const INK = "#191C20", SLATE = "#3A4750", ENGINE = "#B11E2A", EMS = "#1F4E79", PAPER = "#E9EBEC", CARD = "#FFFFFF", LINE = "#D9DCDF", MUTED = "#6A7178";
  const chevron = "repeating-linear-gradient(135deg, #B11E2A 0 14px, #191C20 14px 28px)";
  return {
    app: { display: "flex", height: "100dvh", background: FIRE.pageBg, fontFamily: body, color: INK },
    scrim: { position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 35 },
    sidebar: { width: 262, background: FIRE.sidebar, color: "#E8E9EB", display: "flex", flexDirection: "column", padding: 18, paddingTop: "calc(18px + env(safe-area-inset-top))", paddingBottom: "calc(18px + env(safe-area-inset-bottom))", flexShrink: 0, height: "100dvh", overflow: "hidden" },
    brandRow: { display: "flex", alignItems: "center", gap: 11, paddingBottom: 18, borderBottom: "1px solid #2A2F35" },
    brandName: { fontFamily: display, fontWeight: 700, fontSize: 19, letterSpacing: ".5px", lineHeight: 1 },
    brandSub: { fontSize: 10, color: "#8A929B", letterSpacing: ".9px", marginTop: 3, fontFamily: mono },
    nav: { display: "flex", flexDirection: "column", gap: 3, marginTop: 18, flex: 1, minHeight: 0, overflowY: "auto" },
    navItem: { display: "flex", alignItems: "center", gap: 11, padding: "11px 12px", borderRadius: 8, border: "none", background: "transparent", color: "#C3C8CE", fontSize: 14, fontFamily: body, cursor: "pointer", fontWeight: 500 },
    navItemActive: { background: "#262B31", color: "#fff", boxShadow: "inset 3px 0 0 #B11E2A" },
    premiumTag: { fontSize: 9, fontFamily: mono, background: "#54506B", color: "#fff", padding: "2px 6px", borderRadius: 3, letterSpacing: ".5px" },
    deptCard: { background: "#262B31", borderRadius: 10, padding: 14, marginTop: 12 },
    deptLabel: { fontSize: 9.5, fontFamily: mono, color: "#8A929B", letterSpacing: ".8px" },
    deptName: { fontFamily: display, fontWeight: 600, fontSize: 16, marginTop: 4 },
    deptMeta: { fontSize: 12, color: "#9AA1A9", marginTop: 2 },
    main: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0, height: "100dvh", overflowY: "auto" },
    topbar: { height: "calc(60px + env(safe-area-inset-top))", background: FIRE.sidebar, borderBottom: `1px solid ${FIRE.hairline}`, display: "flex", alignItems: "center", gap: 14, padding: "env(safe-area-inset-top) 18px 0", position: "sticky", top: 0, zIndex: 20 },
    menuBtn: { display: "none", alignItems: "center", justifyContent: "center", width: 38, height: 38, border: `1px solid ${LINE}`, borderRadius: 8, background: "#fff", cursor: "pointer", color: INK },
    chevronBand: { flex: 1, height: 8, borderRadius: 2, background: chevron, opacity: .9 },
    viewAs: { display: "flex", alignItems: "center", gap: 8 },
    viewAsLabel: { fontSize: 11, color: MUTED, fontFamily: mono, letterSpacing: ".5px" },
    select: { border: `1px solid ${LINE}`, borderRadius: 8, padding: "7px 9px", fontSize: 13, fontFamily: body, background: "#fff", color: INK },
    logout: { width: 36, height: 36, border: `1px solid ${LINE}`, borderRadius: 8, background: "#fff", cursor: "pointer", color: SLATE, display: "grid", placeItems: "center" },
    content: { padding: "26px clamp(18px, 4vw, 40px)", maxWidth: 1080, width: "100%", margin: "0 auto" },
    pageHead: { marginBottom: 22 },
    cardEyebrow: { fontFamily: mono, fontSize: 11, letterSpacing: "1.2px", color: ENGINE, fontWeight: 600, marginBottom: 8 },
    pageTitle: { fontFamily: display, fontWeight: 700, fontSize: "clamp(26px, 4vw, 34px)", margin: 0, lineHeight: 1.05, letterSpacing: ".3px" },
    pageSub: { color: MUTED, fontSize: 15, marginTop: 8, maxWidth: 640 },
    statRow: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 18 },
    stat: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 10, padding: "16px 18px" },
    statN: { fontFamily: display, fontWeight: 700, fontSize: 28, lineHeight: 1 },
    statLabel: { fontSize: 12.5, color: MUTED, marginTop: 6 },
    /* roadmap */
    roadCard: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: 22, marginBottom: 20 },
    roadHead: { marginBottom: 12 },
    roadTitle: { fontFamily: display, fontWeight: 600, fontSize: 20, margin: "2px 0 0", letterSpacing: ".2px" },
    roadRecommend: { display: "flex", alignItems: "center", gap: 9, background: "#FBF3E4", border: "1px solid #E6C77A", borderRadius: 9, padding: "11px 14px", fontSize: 14, color: "#5a4a22", marginBottom: 14 },
    roadList: { display: "flex", flexDirection: "column", gap: 2 },
    roadRow: { display: "flex", alignItems: "center", gap: 11, padding: "10px 4px", borderBottom: `1px solid ${PAPER}` },
    roadTopic: { fontSize: 14.5, fontWeight: 500, color: INK, flex: 1 },
    roadAgo: { fontFamily: mono, fontSize: 12, color: MUTED },
    roadChip: { fontFamily: mono, fontSize: 9.5, fontWeight: 600, letterSpacing: ".5px", padding: "3px 9px", borderRadius: 999, border: "1px solid" },
    dashGrid: { display: "grid", gridTemplateColumns: "1.5fr 1fr", gap: 16, marginBottom: 12 },
    quickGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(290px, 1fr))", gap: 12 },
    quickCard: { display: "flex", alignItems: "flex-start", gap: 13, background: CARD, border: `1px solid ${LINE}`, borderRadius: 11, padding: "16px", cursor: "pointer", fontFamily: body, textAlign: "left", width: "100%" },
    quickIcon: { width: 36, height: 36, borderRadius: 9, display: "grid", placeItems: "center", flexShrink: 0 },
    quickTitle: { fontFamily: display, fontWeight: 600, fontSize: 15.5, color: INK, display: "flex", alignItems: "center", gap: 7 },
    quickAi: { fontFamily: mono, fontSize: 8.5, background: "#54506B", color: "#fff", padding: "2px 5px", borderRadius: 3, letterSpacing: ".5px" },
    quickBlurb: { fontSize: 12.5, color: MUTED, lineHeight: 1.45, marginTop: 3 },
    featCard: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, overflow: "hidden", display: "flex", flexDirection: "column" },
    featStripe: { height: 8, background: chevron },
    featInner: { padding: 22 },
    featTitle: { fontFamily: display, fontWeight: 700, fontSize: 22, margin: "6px 0 8px", letterSpacing: ".2px" },
    featObj: { color: SLATE, fontSize: 14.5, lineHeight: 1.55, marginBottom: 14 },
    logCard: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: 20 },
    logRow: { display: "flex", gap: 10, padding: "9px 0", borderBottom: `1px solid ${PAPER}`, fontSize: 13.5, color: SLATE },
    logTime: { fontFamily: mono, fontSize: 11.5, color: MUTED, minWidth: 62 },
    logText: { lineHeight: 1.4 },
    logCode: { fontFamily: mono, color: ENGINE, fontWeight: 600 },
    searchBox: { display: "flex", alignItems: "center", gap: 10, background: "#fff", border: `1px solid ${LINE}`, borderRadius: 10, padding: "11px 14px", marginBottom: 14 },
    searchInput: { border: "none", outline: "none", flex: 1, fontSize: 15, fontFamily: body, background: "transparent", color: INK },
    clearBtn: { border: "none", background: "transparent", cursor: "pointer", color: MUTED, display: "grid", placeItems: "center" },
    chipRow: { display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 20 },
    chip: { padding: "7px 14px", borderRadius: 999, border: "1px solid", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: body },
    cardGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 },
    runCard: { textAlign: "left", background: CARD, border: `1px solid ${LINE}`, borderRadius: 10, padding: 18, cursor: "pointer", fontFamily: body, display: "flex", flexDirection: "column", gap: 8 },
    runTop: { display: "flex", justifyContent: "space-between", alignItems: "center" },
    runCode: { fontFamily: mono, fontSize: 12.5, fontWeight: 600, letterSpacing: ".5px" },
    runTitle: { fontFamily: display, fontWeight: 600, fontSize: 17.5, margin: 0, lineHeight: 1.15, color: INK },
    runObj: { fontSize: 13, color: MUTED, lineHeight: 1.5, margin: 0, display: "-webkit-box", WebkitLineClamp: 3, WebkitBoxOrient: "vertical", overflow: "hidden" },
    runFoot: { display: "flex", justifyContent: "space-between", alignItems: "center", fontSize: 12, color: MUTED, marginTop: 2 },
    runUpdated: { fontFamily: mono, fontSize: 11 },
    empty: { background: CARD, border: `1px dashed ${LINE}`, borderRadius: 12, padding: 36, textAlign: "center", color: MUTED },
    backBtn: { display: "inline-flex", alignItems: "center", gap: 6, border: "none", background: "transparent", color: SLATE, fontSize: 13.5, cursor: "pointer", fontFamily: body, fontWeight: 600, marginBottom: 14, padding: 0 },
    packetHead: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, overflow: "hidden", display: "flex", marginBottom: 16 },
    packetStripe: { width: 8, flexShrink: 0 },
    packetHeadInner: { padding: 24 },
    packetTitle: { fontFamily: display, fontWeight: 700, fontSize: "clamp(24px,3.5vw,32px)", margin: "8px 0", lineHeight: 1.05 },
    metaRow: { display: "flex", flexWrap: "wrap", alignItems: "center", gap: 14, margin: "10px 0 16px" },
    trackPill: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, fontWeight: 600, padding: "4px 10px", borderRadius: 999, fontFamily: body },
    section: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: 20, marginBottom: 14 },
    sectionHead: { display: "flex", alignItems: "center", gap: 8, fontFamily: display, fontWeight: 600, fontSize: 15.5, letterSpacing: ".3px", marginBottom: 12, textTransform: "uppercase", color: INK },
    body: { fontSize: 14.5, lineHeight: 1.6, color: SLATE, margin: 0 },
    list: { margin: 0, paddingLeft: 20, fontSize: 14, lineHeight: 1.7, color: SLATE },
    steps: { display: "flex", flexDirection: "column", gap: 10 },
    step: { display: "flex", gap: 14, alignItems: "flex-start" },
    stepNum: { fontFamily: mono, fontSize: 13, fontWeight: 600, color: "#fff", background: INK, borderRadius: 6, padding: "3px 8px", flexShrink: 0 },
    stepTitle: { fontFamily: display, fontWeight: 600, fontSize: 15, color: INK },
    stepMin: { fontFamily: mono, fontSize: 11, color: MUTED, fontWeight: 500, marginLeft: 6 },
    stepDetail: { fontSize: 13.5, color: SLATE, lineHeight: 1.5, marginTop: 2 },
    safetyBox: { background: "#FBF3E4", border: "1px solid #E6C77A", borderRadius: 12, padding: 20, marginBottom: 14 },
    safetyHead: { display: "flex", alignItems: "center", gap: 8, fontFamily: display, fontWeight: 700, fontSize: 15.5, color: "#8A1620", textTransform: "uppercase", letterSpacing: ".3px", marginBottom: 10 },
    checklist: { display: "flex", flexDirection: "column", gap: 9 },
    check: { display: "flex", alignItems: "flex-start", gap: 9, fontSize: 14, color: SLATE, lineHeight: 1.4, cursor: "pointer" },
    disclaimer: { display: "flex", gap: 9, background: "#F3F1EC", border: `1px solid ${LINE}`, borderLeft: "3px solid #E0A100", borderRadius: 8, padding: "12px 14px", fontSize: 12.5, color: SLATE, lineHeight: 1.5, marginBottom: 16 },
    /* AI */
    aiGrid: { display: "grid", gridTemplateColumns: "360px 1fr", gap: 18, alignItems: "start" },
    aiForm: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: 20, display: "flex", flexDirection: "column", gap: 12 },
    aiResult: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: 22, minHeight: 320 },
    aiPlaceholder: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 12, height: "100%", minHeight: 280, color: MUTED, textAlign: "center", fontSize: 14, padding: 20 },
    aiListHead: { display: "flex", alignItems: "center", gap: 7, fontFamily: display, fontWeight: 600, fontSize: 14.5, textTransform: "uppercase", letterSpacing: ".3px", marginBottom: 8 },
    errBox: { background: "#FCEBEC", border: "1px solid #E8A6AB", color: "#8A1620", borderRadius: 8, padding: "10px 12px", fontSize: 13 },
    field: { display: "flex", flexDirection: "column", gap: 6 },
    fieldLabel: { fontSize: 12.5, fontWeight: 600, color: SLATE, fontFamily: body },
    input: { border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", fontSize: 14.5, fontFamily: body, background: "#fff", color: INK, width: "100%" },
    twoColForm: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
    /* recruitment */
    phaseRow: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 20 },
    phaseCard: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 11, padding: "16px 18px" },
    phaseTop: { display: "flex", alignItems: "baseline", justifyContent: "space-between" },
    phaseNum: { fontFamily: mono, fontWeight: 600, fontSize: 16 },
    phaseWeeks: { fontFamily: mono, fontSize: 10.5, color: MUTED, letterSpacing: ".4px" },
    phaseTitle: { fontFamily: display, fontWeight: 600, fontSize: 17, margin: "6px 0 8px" },
    phaseList: { margin: 0, paddingLeft: 17, fontSize: 13, lineHeight: 1.6, color: SLATE },
    aiBanner: { background: "#F6F4F8", border: "1px solid #D8D2E0", borderLeft: "4px solid #54506B", borderRadius: 12, padding: 22, marginBottom: 22, display: "flex" },
    postOut: { marginTop: 14, background: "#fff", border: `1px dashed ${LINE}`, borderRadius: 8, padding: "14px 16px", fontSize: 14, color: "#2B3138", lineHeight: 1.55, whiteSpace: "pre-wrap" },
    toolGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 },
    toolItem: { display: "flex", alignItems: "center", gap: 9, background: CARD, border: `1px solid ${LINE}`, borderRadius: 9, padding: "12px 14px", fontSize: 13.5, color: SLATE },
    /* funding */
    calGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 11, marginBottom: 22 },
    calCard: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 10, padding: 15 },
    calWk: { fontFamily: display, fontWeight: 600, fontSize: 14, marginBottom: 8 },
    calTag: { fontFamily: mono, fontSize: 9, color: "#fff", padding: "3px 7px", borderRadius: 4, letterSpacing: ".4px" },
    calText: { fontSize: 13, color: SLATE, marginTop: 9, lineHeight: 1.45 },
    tierRow: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 12, marginBottom: 22 },
    tier: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: "18px 17px" },
    tierMid: { border: "1.5px solid #9A6B12", boxShadow: "0 8px 24px rgba(154,107,18,.10)" },
    tierName: { fontFamily: display, fontWeight: 600, fontSize: 16 },
    tierPrice: { fontFamily: display, fontWeight: 700, fontSize: 27, margin: "6px 0 2px", lineHeight: 1 },
    tierYr: { fontFamily: mono, fontSize: 11, fontWeight: 500, color: MUTED },
    tierList: { margin: "10px 0 0", paddingLeft: 17, fontSize: 12.5, lineHeight: 1.55, color: SLATE },
    formCard: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 12, padding: 22, display: "flex", flexDirection: "column", gap: 14, maxWidth: 620 },
    successBox: { display: "flex", alignItems: "center", gap: 8, background: "#E7F4EC", border: "1px solid #A6D6BA", color: "#1A6B3C", borderRadius: 8, padding: "10px 12px", fontSize: 13.5 },
    reqRow: { display: "flex", justifyContent: "space-between", gap: 12, background: CARD, border: `1px solid ${LINE}`, borderRadius: 10, padding: "14px 16px", marginBottom: 8, fontSize: 14 },
    reqNotes: { fontSize: 13, color: MUTED, marginTop: 3 },
    reqWhen: { fontFamily: mono, fontSize: 11.5, color: MUTED, flexShrink: 0 },
    fbCard: { background: "#F6F4F8", border: "1px solid #D8D2E0", borderRadius: 12, padding: 18, marginTop: 18 },
    fbHead: { display: "flex", alignItems: "center", gap: 8, fontFamily: display, fontWeight: 600, fontSize: 15, color: INK, textTransform: "uppercase", letterSpacing: ".3px", marginBottom: 12 },
    fbRow: { display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" },
    fbLabel: { fontSize: 13.5, fontWeight: 600, color: SLATE },
    fbLabel2: { fontSize: 12.5, fontWeight: 600, color: SLATE, marginBottom: 7 },
    fbThumb: { display: "inline-flex", alignItems: "center", gap: 6, background: "#fff", border: `1px solid ${LINE}`, borderRadius: 8, padding: "7px 13px", fontSize: 13.5, fontWeight: 600, color: SLATE, cursor: "pointer", fontFamily: body },
    fbThumbUp: { background: "#E7F4EC", borderColor: "#A6D6BA", color: "#1A6B3C" },
    fbThumbDown: { background: "#FCEBEC", borderColor: "#E8A6AB", color: "#8A1620" },
    fbTag: { padding: "6px 12px", borderRadius: 999, border: `1px solid ${LINE}`, background: "#fff", color: SLATE, fontSize: 12.5, fontWeight: 500, cursor: "pointer", fontFamily: body },
    fbTagOn: { background: "#54506B", borderColor: "#54506B", color: "#fff" },
    fbEditBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "#fff", color: SLATE, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: body, marginTop: 13 },
    fbDone: { display: "flex", gap: 11, background: "#E7F4EC", border: "1px solid #A6D6BA", borderRadius: 11, padding: "16px 18px", marginTop: 18, fontSize: 14, color: "#1A6B3C", lineHeight: 1.5 },
    fbItem: { display: "flex", gap: 12, alignItems: "flex-start", background: CARD, border: `1px solid ${LINE}`, borderRadius: 10, padding: "13px 15px", marginBottom: 8 },
    fbDot: { width: 10, height: 10, borderRadius: "50%", flexShrink: 0, marginTop: 6 },
    fbItemTop: { fontSize: 14.5, color: INK, display: "flex", alignItems: "center", gap: 8 },
    fbEdited: { fontFamily: mono, fontSize: 8.5, background: "#54506B", color: "#fff", padding: "2px 6px", borderRadius: 3, letterSpacing: ".5px" },
    fbItemTags: { fontSize: 12.5, color: "#8A1620", marginTop: 3 },
    fbItemNotes: { fontSize: 13, color: SLATE, fontStyle: "italic", marginTop: 4 },
    resGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))", gap: 10, marginBottom: 8 },
    resCard: { display: "flex", gap: 11, alignItems: "flex-start", background: CARD, border: `1px solid ${LINE}`, borderRadius: 10, padding: "13px 15px" },
    resName: { fontSize: 13.5, fontWeight: 600, color: INK, lineHeight: 1.3 },
    resType: { fontFamily: mono, fontSize: 10.5, color: MUTED, marginTop: 3, letterSpacing: ".3px" },
    resDl: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: EMS, flexShrink: 0, alignSelf: "center" },
    ideaGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(230px, 1fr))", gap: 11, marginBottom: 22 },
    ideaCard: { background: "#F6F7F8", border: `1px solid ${LINE}`, borderRadius: 10, padding: "14px 16px" },
    ideaH: { fontFamily: display, fontWeight: 600, fontSize: 14.5, color: INK },
    ideaP: { fontSize: 12.5, color: MUTED, lineHeight: 1.5, marginTop: 4 },
    docDrop: { display: "flex", flexDirection: "column", alignItems: "center", gap: 6, background: "#F6F7F8", border: `2px dashed #C2C6CB`, borderRadius: 12, padding: "30px 20px", marginBottom: 6, cursor: "pointer", textAlign: "center" },
    docDropText: { fontSize: 14.5, color: SLATE, fontWeight: 500 },
    docDropSub: { fontSize: 12, color: MUTED },
    segRow: { display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 14 },
    segBtn: { padding: "8px 14px", borderRadius: 999, border: `1px solid ${LINE}`, background: "#fff", color: SLATE, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: body },
    segBtnOn: { background: "#54506B", borderColor: "#54506B", color: "#fff" },
    helpP: { fontSize: 13.5, color: MUTED, marginTop: -2, marginBottom: 12, maxWidth: 620 },
    richWrap: { display: "flex", flexDirection: "column", gap: 10, marginTop: 14 },
    richCard: { background: "#fff", border: `1px solid ${LINE}`, borderRadius: 10, padding: "15px 17px" },
    richTitle: { fontFamily: display, fontWeight: 600, fontSize: 15.5, color: INK, letterSpacing: ".2px", marginBottom: 9, paddingBottom: 8, borderBottom: `1px solid ${PAPER}` },
    richP: { fontSize: 14, color: SLATE, lineHeight: 1.6, margin: "0 0 8px" },
    richList: { margin: "2px 0 8px", paddingLeft: 20, fontSize: 14, color: SLATE, lineHeight: 1.7 },
    opGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(290px, 1fr))", gap: 12 },
    opCard: { background: CARD, border: `1px solid ${LINE}`, borderRadius: 11, padding: "15px 16px" },
    avatar: { width: 38, height: 38, borderRadius: "50%", background: "#262B31", color: "#fff", display: "grid", placeItems: "center", fontFamily: display, fontWeight: 600, fontSize: 14, flexShrink: 0 },
    personName: { fontFamily: display, fontWeight: 600, fontSize: 15.5, color: INK, lineHeight: 1.2 },
    personMeta: { fontSize: 12.5, color: MUTED, marginTop: 2 },
    opChip: { fontFamily: mono, fontSize: 9.5, fontWeight: 600, letterSpacing: ".5px", padding: "3px 9px", borderRadius: 999, border: "1px solid", flexShrink: 0 },
    certRow: { display: "flex", alignItems: "center", gap: 11, padding: "11px 4px", borderBottom: `1px solid ${PAPER}` },
    eventRow: { display: "flex", alignItems: "center", gap: 4, padding: "11px 4px", borderBottom: `1px solid ${PAPER}` },
    bar: { height: 7, borderRadius: 99, background: "#E4E6E8", overflow: "hidden", marginTop: 5 },
    barFill: { height: "100%", borderRadius: 99, background: EMS },
    forYou: { fontFamily: mono, fontSize: 9, fontWeight: 600, letterSpacing: ".5px", color: "#fff", background: ENGINE, padding: "2px 7px", borderRadius: 4, flexShrink: 0 },
    primaryBtn: { display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 8, background: ENGINE, color: "#fff", border: "none", borderRadius: 9, padding: "12px 20px", fontSize: 14.5, fontWeight: 600, fontFamily: body, cursor: "pointer", alignSelf: "flex-start" },
    ghostBtn: { display: "inline-flex", alignItems: "center", gap: 7, background: "#fff", color: SLATE, border: `1px solid ${LINE}`, borderRadius: 9, padding: "10px 16px", fontSize: 13.5, fontWeight: 600, fontFamily: body, cursor: "pointer", alignSelf: "flex-start", marginTop: 4 },
    loginWrap: { minHeight: "100vh", background: INK, display: "grid", placeItems: "center", padding: 20, fontFamily: body, position: "relative", overflow: "hidden" },
    loginChevron: { position: "absolute", top: 0, left: 0, right: 0, height: 12, background: chevron },
    loginCard: { background: "#fff", borderRadius: 16, padding: "34px 30px", width: "100%", maxWidth: 400, boxShadow: "0 20px 60px rgba(0,0,0,.35)" },
    brandNameLg: { fontFamily: display, fontWeight: 700, fontSize: 24, letterSpacing: ".5px", color: INK },
    loginTag: { fontSize: 14, color: MUTED, lineHeight: 1.55, margin: "4px 0 22px" },
    loginNote: { fontSize: 11.5, color: MUTED, textAlign: "center", marginTop: 14, fontFamily: mono },
  };
}
