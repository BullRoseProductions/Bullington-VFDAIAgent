import React, { useState, useMemo, useEffect, useRef } from "react";
import {
  Flame, HeartPulse, Search, ShieldAlert, Users, FileText, Download, Plus,
  ChevronRight, Sparkles, ClipboardList, GraduationCap, Megaphone, Landmark,
  Briefcase, AlertTriangle, LogOut, LayoutDashboard, Send, CheckCircle2, XCircle, Clock,
  Wrench, X, Menu, ArrowLeft, Loader2, Building2, TrendingUp, Calendar, DollarSign,
  ThumbsUp, ThumbsDown, Pencil, MessageSquare,
  FolderOpen, Upload, FilePlus, PartyPopper,
  Truck, Award, CalendarCheck, BarChart3, UserPlus, Phone, ClipboardCheck,
  Palette, Image as ImageIcon, Wand2, QrCode, RefreshCw, Trash2,
} from "lucide-react";
import { downloadDepartmentReport } from "./report.js";
import { QRCodeCanvas } from "qrcode.react";
import { supabase } from "./supabaseClient";

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
  input: { border: `0.5px solid ${FIRE.inputBorder}`, borderRadius: 8, padding: "10px 12px", fontSize: 14.5, fontFamily: "inherit", background: FIRE.btnBg, color: FIRE.name, width: "100%" },
  row: { display: "flex", alignItems: "center", gap: 11, flexWrap: "wrap", padding: "11px 4px", borderBottom: `0.5px solid ${FIRE.hairline}` },
};

const ROLES = ["Project Admin", "Department Admin", "Board Member", "Training Officer", "Member"];
const LEADERSHIP = ["Project Admin", "Department Admin", "Board Member", "Training Officer"];
const isLeader = (role) => LEADERSHIP.includes(role);
const canAssign = (role) => role === "Project Admin" || role === "Department Admin";

const TRACKS = {
  Fire:        { label: "Fire",        accent: "#B11E2A", Icon: Flame },
  EMS:         { label: "EMS",         accent: "#1F4E79", Icon: HeartPulse },
  Leadership:  { label: "Leadership",  accent: "#3A4750", Icon: GraduationCap },
  Operations:  { label: "Operations",  accent: "#54506B", Icon: Briefcase },
};

const DISCLAIMER =
  "For training, discussion, and planning only. Your department is responsible for compliance with local protocols, medical direction, state requirements, agency policy, and applicable law. This platform does not provide medical direction, legal advice, or certification.";

/* ---- training roadmap (department memory / gap detection) ---------- */
const ROADMAP = [
  { topic: "Mayday Operations",     track: "Fire", months: 18, target: 6 },
  { topic: "Pediatric Emergencies", track: "EMS",  months: 9,  target: 6 },
  { topic: "Search & Rescue",       track: "Fire", months: 6,  target: 6 },
  { topic: "Stroke Recognition",    track: "EMS",  months: 5,  target: 6 },
  { topic: "Water Supply",          track: "Fire", months: 3,  target: 6 },
  { topic: "Vehicle Extrication",   track: "Fire", months: 2,  target: 6 },
];
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

const ACTIVITY = [
  { code: "OPS-120", who: "Chief Reyes", action: "downloaded", when: "08:42" },
  { code: "EMS-114", who: "T/O Daniels", action: "assigned to crew", when: "07:15" },
  { code: "FIRE-118", who: "Asst. Chief Okafor", action: "saved", when: "Yesterday" },
];

const NAV = [
  { key: "dashboard", label: "Dashboard", Icon: LayoutDashboard, roles: ROLES },
  { key: "library", label: "Training Library", Icon: FileText, roles: ROLES },
  { key: "training", label: "Training", Icon: GraduationCap, roles: ROLES },
  { key: "ai", label: "AI Training Assistant", Icon: Sparkles, roles: ["Project Admin", "Department Admin", "Training Officer"], premium: true },
  { key: "documents", label: "Station Documents", Icon: FolderOpen, roles: ROLES },
  { key: "roster", label: "Roster", Icon: Users, roles: ROLES },
  { key: "onboarding", label: "New-Member Onboarding", Icon: UserPlus, roles: ["Project Admin", "Department Admin"] },
  { key: "apparatus", label: "Apparatus", Icon: Truck, roles: ROLES },
  { key: "recruit", label: "Recruitment", Icon: Megaphone, roles: LEADERSHIP },
  { key: "visibility", label: "Public Relations", Icon: Calendar, roles: LEADERSHIP },
  { key: "brand", label: "Media Builder", Icon: ImageIcon, roles: LEADERSHIP },
  { key: "duties", label: "Station Duties", Icon: ClipboardCheck, roles: ROLES },
  { key: "funding", label: "Funding", Icon: DollarSign, roles: LEADERSHIP },
  { key: "minutes", label: "Meeting Minutes", Icon: ClipboardList, roles: LEADERSHIP },
  { key: "request", label: "Request Custom Training", Icon: Send, roles: ["Project Admin", "Department Admin", "Training Officer"] },
  { key: "admin", label: "Content Admin", Icon: ShieldAlert, roles: ["Project Admin"] },
];

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
  const [role, setRole] = useState("Member");
  const [realRole, setRealRole] = useState("Member");
  const [authEmail, setAuthEmail] = useState(null);
  const [myMemberId, setMyMemberId] = useState(null);
  const [identityChecked, setIdentityChecked] = useState(false);
  const [screen, setScreen] = useState("dashboard");
  const [packetId, setPacketId] = useState(null);
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
            joined: m.joined,
            participation: m.participation,
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
    if (!authEmail) { setRealRole("Member"); setRole("Member"); setMyMemberId(null); setIdentityChecked(false); return; }
    let cancelled = false;
    setIdentityChecked(false);
    supabase
      .from("members")
      .select("id, access")
      .eq("email", authEmail)
      .single()
      .then(({ data, error }) => {
        if (cancelled) return;
        const ok = !error && !!data;
        const access = ok && ROLES.includes(data.access) ? data.access : "Member";
        setRealRole(access);
        setRole(access);
        setMyMemberId(ok ? data.id : null);
        setIdentityChecked(true);
      });
    return () => { cancelled = true; };
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
      supabase.from("training_sessions").select("id, plan_id, title, date, done, signin_open"),
      supabase.from("session_attendance").select("session_id, member_id, checked_in_at"),
      supabase.from("session_plans").select("id, title, storage_path, session_id").order("created_at", { ascending: false }),
    ]);
    if (sErr || !srows) { setTrainingSessions([]); return; }   // sessions are source of truth; attendance/plan reads are non-fatal
    const byS = {};
    (arows || []).forEach((a) => {
      const e = byS[a.session_id] || (byS[a.session_id] = { attendance: [], times: {} });
      e.attendance.push(a.member_id);
      if (a.checked_in_at) e.times[a.member_id] = new Date(a.checked_in_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    });
    const planByS = {};   // most-recent plan per session wins (query ordered desc; no UNIQUE on session_id)
    (prows || []).forEach((p) => { if (p.session_id && !planByS[p.session_id]) planByS[p.session_id] = { id: p.id, title: p.title, storage_path: p.storage_path, session_id: p.session_id }; });
    setTrainingSessions(
      srows.filter((r) => r.date).map((r) => {
        const [yy, mm, dd] = r.date.split("-").map(Number);
        const ae = byS[r.id] || { attendance: [], times: {} };
        return { id: r.id, planId: r.plan_id, title: r.title, y: yy, m: (mm || 1) - 1, d: dd, done: !!r.done, signinOpen: !!r.signin_open, attendance: ae.attendance, times: ae.times, plan: planByS[r.id] || null };
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

  function go(k) { setScreen(k); setPacketId(null); setDrawer(false); }
  function openPacket(id) { setPacketId(id); setScreen("packet"); setDrawer(false); }
  const visibleNav = NAV.filter((n) => n.roles.includes(role));
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
          <div style={S.deptName}>North Hood Country VFD</div>
          <div style={S.deptMeta}>Premium · 14 members</div>
        </div>
      </aside>

      <div style={S.main}>
        <header style={S.topbar}>
          <button className="dr-menu" style={S.menuBtn} onClick={() => setDrawer(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div style={{ flex: 1 }} />
          <div style={S.viewAs}>
            {isLeader(realRole) && (
              <>
                <span style={S.viewAsLabel}>View as</span>
                <select value={role} onChange={(e) => { setRole(e.target.value); setScreen("dashboard"); }} style={S.select}>
                  {ROLES.map((r) => <option key={r}>{r}</option>)}
                </select>
              </>
            )}
          </div>
        </header>

        <main style={S.content}>
          {screen === "dashboard" && <Dashboard S={S} role={role} members={members} library={library} openPacket={openPacket} go={go} meId={myMemberId} sessions={trainingSessions} notify={notify} />}
          {screen === "library" && <Library S={S} library={library} openPacket={openPacket} />}
          {screen === "training" && <Training S={S} role={role} plan={trainingPlan} setPlan={setTrainingPlan} loadPlans={loadPlans} sessions={trainingSessions} setSessions={setTrainingSessions} loadSessions={loadSessions} members={members} meId={myMemberId} checkIn={doCheckIn} notify={notify} />}
          {screen === "checkin" && <CheckinConfirm S={S} result={checkinResult} members={members} meId={myMemberId} go={go} />}
          {screen === "packet" && packet && <Packet S={S} packet={packet} back={() => setScreen("library")} />}
          {screen === "ai" && <AIAssistant S={S} addFeedback={addFeedback} />}
          {screen === "documents" && <Documents S={S} role={role} notify={notify} uploaderName={members.find((m) => m.id === myMemberId)?.name || authEmail || "Unknown"} />}
          {screen === "roster" && <Roster S={S} role={role} members={members} setMembers={setMembers} sessions={trainingSessions} notify={notify} />}
          {screen === "onboarding" && <Onboarding S={S} members={members} />}
          {screen === "apparatus" && <Apparatus S={S} role={role} />}
          {screen === "recruit" && <Recruitment S={S} brand={brand} role={role} notify={notify} />}
          {screen === "visibility" && <Visibility S={S} brand={brand} role={role} notify={notify} />}
          {screen === "brand" && <BrandKit S={S} role={role} brand={brand} setBrand={setBrand} />}
          {screen === "duties" && <StationDuties S={S} role={role} members={members} meId={myMemberId} notify={notify} />}
          {screen === "funding" && <Funding S={S} role={role} notify={notify} />}
          {screen === "minutes" && <Minutes S={S} />}
          {screen === "request" && <RequestForm S={S} requests={requests} setRequests={setRequests} />}
          {screen === "admin" && <Admin S={S} library={library} setLibrary={setLibrary} feedback={feedback} />}
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
function Dashboard({ S, role, members, library, openPacket, go, meId, sessions, notify }) {
  if (role === "Member") return <MemberDashboard S={S} role={role} members={members} go={go} meId={meId} sessions={sessions} notify={notify} />;
  const featured = library.find((p) => p.id === "fire-118");
  const sorted = [...ROADMAP].sort((a, b) => (b.months - b.target) - (a.months - a.target));
  const next = sorted[0];
  const me = members.find((m) => m.id === meId) || null;
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>THIS WATCH</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>{dashboardGreeting(me)}</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Here's where your crew stands this month.</div>
      </div>

      <div style={S.statRow}>
        <Stat S={S} dark n="6" label="Topics tracked" />
        <Stat S={S} dark n="2" label="Overdue for training" warn />
        <Stat S={S} dark n="9" label="Packets in library" />
        <Stat S={S} dark n="14" label="Active members" />
      </div>

      <DashboardCalendar S={S} />

      <div style={S.dashGrid}>
        <div style={{ ...S.featCard, ...FS.card }}>
          <div style={S.featStripe} />
          <div style={S.featInner}>
            <div style={{ ...FS.kicker, marginBottom: 8 }}>BUILD THIS WEEK</div>
            <h3 style={{ ...S.featTitle, color: FIRE.textPrimary }}>{featured.title}</h3>
            <p style={{ ...S.featObj, color: FIRE.textSecondary }}>{featured.objective}</p>
            <div style={S.metaRow}><Meta Icon={Clock} dark text={featured.time} /><Meta Icon={Users} dark text={featured.level} /><TrackPill S={S} track={featured.track} /></div>
            <button style={FS.btnPrimary} onClick={() => openPacket(featured.id)}>Open packet <ChevronRight size={16} /></button>
          </div>
        </div>
        <div style={{ ...S.logCard, ...FS.card }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}>STATION LOG</div>
          {ACTIVITY.map((a, i) => (
            <div key={i} style={{ ...S.logRow, borderBottom: `0.5px solid ${FIRE.hairline}`, color: FIRE.textSecondary }}><span style={{ ...S.logTime, color: FIRE.textMuted }}>{a.when}</span>
              <span style={S.logText}><strong style={{ color: FIRE.textPrimary }}>{a.who}</strong> {a.action} <span style={{ ...S.logCode, color: FIRE.textMuted }}>{a.code}</span></span></div>
          ))}
          <button style={FS.btn} onClick={() => go("ai")}><Sparkles size={15} /> Draft a drill with AI</button>
        </div>
      </div>

      {/* Training roadmap — department memory / gap detection */}
      <div style={{ ...S.roadCard, ...FS.card }}>
        <div style={S.roadHead}>
          <div><div style={{ ...FS.kicker, marginBottom: 8 }}><TrendingUp size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />TRAINING ROADMAP</div>
            <h3 style={{ ...S.roadTitle, color: FIRE.textPrimary }}>What your crew hasn't trained lately</h3></div>
        </div>
        <div style={{ ...S.roadRecommend, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, borderLeft: `3px solid ${FIRE.amberText}`, color: FIRE.textSecondary }}>
          <Sparkles size={16} color={FIRE.amberText} />
          <span>Recommended next: <strong>{next.topic}</strong> — last trained {next.months} months ago.</span>
        </div>
        <div style={S.roadList}>
          {sorted.map((r) => {
            const st = statusOf(r.months, r.target); const T = TRACKS[r.track];
            return (
              <div key={r.topic} style={{ ...S.roadRow, borderBottom: `0.5px solid ${FIRE.hairline}` }}>
                <T.Icon size={15} color={T.accent} style={{ flexShrink: 0 }} />
                <span style={{ ...S.roadTopic, color: FIRE.textPrimary }}>{r.topic}</span>
                <span style={{ ...S.roadAgo, color: FIRE.textMuted }}>{r.months} mo ago</span>
                <span style={{ ...S.roadChip, color: st.color, borderColor: `${st.color}55`, background: `${st.color}12` }}>{st.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <QuickAccess S={S} role={role} go={go} />
    </div>
  );
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
  const items = NAV.filter((n) => n.key !== "dashboard" && n.roles.includes(role));
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
/* FS-based stat box (NEW — does not touch the shared <Stat>) */
function FireStat({ label, value, sub, subColor, extra }) {
  return (
    <div style={{ ...FS.card, padding: "14px 16px" }}>
      <div style={{ fontSize: 10, textTransform: "uppercase", letterSpacing: ".14em", color: FIRE.textMuted2, fontWeight: 700 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color: FIRE.textPrimary, marginTop: 6, ...FS.num }}>{value}</div>
      {sub && <div style={{ fontSize: 11.5, color: subColor || FIRE.textMuted, marginTop: 2 }}>{sub}</div>}
      {extra}
    </div>
  );
}
function MemberDashboard({ S, role, members, go, meId, sessions, notify }) {
  const DISPLAY = "'Oswald', system-ui, sans-serif";
  const me = members.find((m) => m.id === meId) || null;
  const sess = sessions || [];
  // ---- derived (lifted from the member Training branch; no new query/RLS) ----
  const today = new Date();
  const t0 = new Date(today); t0.setHours(0, 0, 0, 0);
  const since90 = new Date(t0); since90.setDate(since90.getDate() - 90);
  const inWindow = (s) => { const d = sessDate(s); return d >= since90 && d <= today; };
  const recorded = sess.filter((s) => s.done && (s.attendance || []).length > 0 && inWindow(s));
  const totalRecorded = recorded.length;
  const attendedCount = me ? recorded.filter((s) => (s.attendance || []).includes(me.id)).length : 0;
  const pct = totalRecorded ? Math.round((attendedCount / totalRecorded) * 100) : 0;
  const hasAtt = totalRecorded > 0;
  const trainingsThisMonth = sess.filter((s) => s.y === today.getFullYear() && s.m === today.getMonth()).length;
  const upcoming = sess.filter((s) => !s.done && sessDate(s) >= t0).sort((a, b) => sessDate(a) - sessDate(b));
  const certsAll = me ? me.certs.map((c) => ({ ...c, st: certStatus(c.exp) })).sort((a, b) => a.st.rank - b.st.rank) : [];
  const certsCurrent = certsAll.filter((c) => c.st.rank === 2).length;
  const certsTotal = certsAll.length;
  const expiringSoon = certsAll.filter((c) => c.st.rank === 1).length;
  const expired = certsAll.filter((c) => c.st.rank === 0).length;
  const certAlert = expired > 0 ? { color: FIRE.redText, text: `${expired} expired` } : expiringSoon > 0 ? { color: FIRE.amberText, text: `${expiringSoon} expiring soon` } : { color: FIRE.greenText, text: "All current" };
  const fireCert = (st) => st.rank === 2 ? FIRE.greenText : st.rank === 1 ? FIRE.amberText : FIRE.redText;
  const dots = [...recorded].sort((a, b) => sessDate(a) - sessDate(b)).map((s) => ({ present: (s.attendance || []).includes(me?.id), date: sessDate(s) }));   // one per recorded drill, oldest→newest — same `recorded` the % uses
  async function openPlan(plan) {
    if (!plan?.storage_path) return;
    const { data, error } = await supabase.storage.from("station-documents").createSignedUrl(plan.storage_path, 3600);
    if (error || !data?.signedUrl) { notify({ kind: "error", title: "Couldn't open the plan", text: "The plan couldn't be opened — please try again.", details: error?.message ?? "no signed URL" }); return; }
    const a = document.createElement("a"); a.href = data.signedUrl; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
  }
  // ---- "Assigned to me" duties (self-contained; no App threading; existing read RLS) ----
  const [mine, setMine] = useState([]);
  function loadMine() {
    if (!meId) return;
    supabase.from("duties").select("id, duty, due_date, done, assigned_to").eq("assigned_to", meId).eq("done", false)
      .then(({ data }) => setMine(data || []));
  }
  useEffect(() => { loadMine(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [meId]);
  async function markMineDone(id) {
    const { error } = await supabase.rpc("complete_duty", { p_duty_id: id, p_helper_ids: [] });   // assignee allowed by the RPC rule
    if (error) { notify({ kind: "error", title: "Couldn't mark it done", text: "Something went wrong updating that. Please try again.", details: error.message }); return; }
    loadMine();   // refetch — the completed duty drops off (done=true no longer matches)
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      {/* 1 — greeting */}
      <div style={{ marginBottom: 18 }}>
        <div style={FS.kicker}>MY STATION · North Hood Country VFD</div>
        <h1 style={{ fontFamily: DISPLAY, fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>{dashboardGreeting(me)}</h1>
        <div style={{ fontSize: 14, color: FIRE.textMuted2, lineHeight: 1.5 }}>Here's exactly where you stand — and what's coming up for you.</div>
      </div>

      {/* 2 — three stat boxes */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 14 }}>
        <FireStat label="My attendance" value={hasAtt ? `${pct}%` : "—"} sub={hasAtt ? `${attendedCount} of ${totalRecorded} drills` : "No record yet"} extra={dots.length > 0 ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 8 }}>
            {dots.map((d, i) => {
              const t = d.date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
              return d.present
                ? <CheckCircle2 key={i} size={13} color={FIRE.green} title={`${t} — present`} />
                : <XCircle key={i} size={13} color={FIRE.red} title={`${t} — missed`} />;
            })}
          </div>
        ) : null} />
        <FireStat label="Certs current" value={`${certsCurrent}/${certsTotal}`} sub={certAlert.text} subColor={certAlert.color} />
        <FireStat label="Trainings this month" value={String(trainingsThisMonth)} sub={TRAIN_MONTHS[today.getMonth()]} />
      </div>

      {/* 4 — two columns: certifications | upcoming training */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))", gap: 12, marginBottom: 14 }}>
        <div style={{ ...FS.card, padding: 18 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
            <div style={FS.kicker}>MY CERTIFICATIONS</div>
            <span style={{ fontSize: 11, fontWeight: 700, color: certAlert.color }}>{certAlert.text}</span>
          </div>
          <div style={{ marginTop: 10 }}>
            {certsAll.length === 0 ? (
              <div style={{ fontSize: 13, color: FIRE.textMuted }}>No certifications on file yet.</div>
            ) : certsAll.map((c, i) => (
              <div key={c.id ?? i} style={{ ...FS.row, padding: "9px 0" }}>
                <Award size={15} color={fireCert(c.st)} style={{ flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.name }}>{c.name}</div>
                  <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...FS.num }}>{expPhrase(c.exp)}</div>
                </div>
                <Pill S={S} color={fireCert(c.st)}>{c.st.label}</Pill>
              </div>
            ))}
          </div>
        </div>
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
                {s.plan && <button onClick={() => openPlan(s.plan)} style={{ ...FS.btn, padding: "5px 9px", fontSize: 11.5 }}>Open plan</button>}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 4b — assigned to me (self-contained loader; hidden entirely when empty) */}
      {mine.length > 0 && (
        <div style={{ ...FS.card, padding: 18, marginBottom: 14 }}>
          <div style={FS.kicker}>ASSIGNED TO ME</div>
          <div style={{ marginTop: 10 }}>
            {mine.map((d) => {
              let badge = null;
              if (d.due_date) {
                const dd = new Date(d.due_date + "T00:00:00");
                const tn = new Date(); tn.setHours(0, 0, 0, 0);
                const days = Math.round((dd - tn) / 86400000);
                const tone = days < 0 ? FIRE.redText : days <= 7 ? FIRE.amberText : FIRE.textMuted2;   // overdue red, ≤7d amber, else muted — same as the StationDuties badge
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
          </div>
        </div>
      )}

      {/* 5 — station calendar: shared DashboardCalendar wrapped in a dark FS card (light inset; NOT mutated) */}
      <div style={{ ...FS.card, padding: 16, marginBottom: 14 }}>
        <DashboardCalendar S={S} />
      </div>

      {/* 6 — quick actions (member-filtered NAV; new FS styling, shared QuickAccess untouched) */}
      <div style={{ ...FS.card, padding: 18 }}>
        <div style={FS.kicker}>QUICK ACTIONS</div>
        <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 10 }}>
          {NAV.filter((n) => n.key !== "dashboard" && n.roles.includes(role)).map((n) => (
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
function AIAssistant({ S, addFeedback }) {
  const [form, setForm] = useState({ size: "12", apparatus: "1 engine, 1 brush truck", topic: "Search and rescue", level: "Intermediate", time: "90", history: "Have not trained on search & rescue in 6 months." });
  const [loading, setLoading] = useState(false); const [err, setErr] = useState(""); const [plan, setPlan] = useState(null); const [genId, setGenId] = useState(0);
  const up = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function generate() {
    setLoading(true); setErr(""); setPlan(null);
    const sys = "You are an experienced volunteer fire/EMS training officer drafting a SAFE, practical drill plan. You are NOT a substitute for certified instruction, medical direction, or the AHJ. Defer to local protocols, state requirements, and medical direction. For any high-risk evolution (live fire, hazmat, technical rescue, invasive medical skills), note in safetyNotes that it requires a qualified instructor and assigned safety officer plus authorization. Respond with ONLY one valid JSON object, no markdown, no code fences. Schema: {\"summary\":string,\"durationMin\":number,\"equipment\":string[],\"safetyNotes\":string[],\"steps\":[{\"title\":string,\"detail\":string,\"minutes\":number}],\"talkingPoints\":string[],\"debriefQuestions\":string[],\"evaluationChecklist\":string[]}. Keep arrays to 3-6 concise items. Realistic for the stated staffing and apparatus.";
    const user = `Department size: ${form.size} members\nApparatus/equipment: ${form.apparatus}\nTopic: ${form.topic}\nSkill level: ${form.level}\nTime: ${form.time} minutes\nRecent history: ${form.history}`;
    try {
      let t = (await callClaude(sys, user)).replace(/```json|```/g, "").trim();
      let parsed; try { parsed = JSON.parse(t); } catch { const m = t.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
      if (!parsed) throw new Error("parse"); setPlan(parsed); setGenId((g) => g + 1);
    } catch { setErr("Couldn't generate a plan just now. Check the connection and try again."); } finally { setLoading(false); }
  }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>AI TRAINING ASSISTANT</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Draft a drill plan</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Describe your crew and constraints. You'll get a starting plan to adapt — then review it against your protocols.</div>
      </div>
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
function Recruitment({ S, brand, role, notify }) {
  const [town, setTown] = useState("North Hood Country");
  const [size, setSize] = useState("14");
  const [need, setNeed] = useState("A few younger volunteers and people who can run daytime calls.");
  const [loading, setLoading] = useState(false); const [plan, setPlan] = useState(""); const [err, setErr] = useState("");
  async function draft() {
    setLoading(true); setErr(""); setPlan("");
    const sys = "You are a recruitment advisor for a volunteer fire/EMS department. Build a practical recruitment plan that uses ONLY three channels: (1) community events and an open house, (2) recruiting in person at local places — employers, schools/trade programs, churches, community spots, and (3) social media calls-to-action. Weight the plan HEAVILY toward social media calls-to-action: give it the most space, several specific sample posts, each with a clear ask, a concrete next step, and a tie to a real need. For each of the three channels, give 2-3 concrete steps a tiny crew can actually do, written in the department's voice. Do NOT suggest any other channels. Warm, honest, never desperate. Plain-text headers and bullets. Under 350 words.";
    try { const t = await callClaude(sys, `Town: ${town}\nDepartment size: ${size} members\nWhat they need: ${need}\nDepartment voice: ${brand?.voice || ""}\nTagline: ${brand?.tagline || ""}`); setPlan(t); }
    catch { setErr("Couldn't draft a plan just now. Try again in a moment."); } finally { setLoading(false); }
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
          <div style={{ ...FS.kicker, marginBottom: 8 }}><Sparkles size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />AI RECRUITMENT PLANNER</div>
          <h3 style={{ ...S.featTitle, color: FIRE.textPrimary }}>Draft a recruitment plan for your department</h3>
          <div style={S.twoColForm}>
            <AIField S={S} dark label="Your town" value={town} onChange={setTown} />
            <AIField S={S} dark label="Department size" value={size} onChange={setSize} />
          </div>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>What you need</span>
            <textarea style={{ ...FS.input, minHeight: 48, resize: "vertical" }} value={need} onChange={(e) => setNeed(e.target.value)} /></label>
          <button style={{ ...FS.btnPrimary, marginTop: 12, opacity: loading ? 0.7 : 1 }} onClick={draft} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><Sparkles size={16} /> Draft a plan</>}
          </button>
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
          {plan && <RichOutput S={S} text={plan} dark />}
        </div>
      </div>

      <div style={{ ...FS.kicker, marginBottom: 8 }}>WAYS TO RECRUIT BEYOND SOCIAL MEDIA</div>
      <IdeaGrid S={S} dark items={[
        { h: "Current-member referrals", p: "Your people's networks convert best. Give them a one-line script to forward." },
        { h: "Local employers", p: "Release-time or support partnerships — many owners want the community goodwill." },
        { h: "Schools & trade programs", p: "High schools, EMT classes, and fire-science programs build your pipeline." },
        { h: "Community events", p: "Festivals, markets, ballgames — bring an apparatus and a sign-up sheet." },
        { h: "Former members", p: "A warm 'we'd love to have you back' reopens more doors than you'd think." },
        { h: "Open house", p: "Your highest-converting event — tour, demo, food, and fast follow-up." },
      ]} />

      <div style={{ ...FS.kicker, marginBottom: 8 }}><Calendar size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />RECRUITMENT CALENDAR</div>
      <RecruitmentCalendar S={S} role={role} notify={notify} />

      <GraphicStudio S={S} brand={brand} />

      <div style={{ ...FS.kicker, marginBottom: 8 }}>RECRUITMENT LIBRARY</div>
      <ResourceLibrary S={S} dark items={[
        { name: "Volunteer Recruitment Playbook", type: "PDF · 90-day plan + templates" },
        { name: "Printable recruitment flyer", type: "PDF · fill-in-the-blank" },
        { name: "Member-referral scripts", type: "Doc · copy & send" },
        { name: "Employer & school outreach emails", type: "Doc · templates" },
        { name: "Open-house checklist & funnel tracker", type: "PDF" },
      ]} />
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
const DOC_TYPES = ["SOP / SOG", "Policy", "Handbook", "Forms", "Agreement", "Reference", "Other"];
function Documents({ S, role, notify, uploaderName }) {
  const leader = isLeader(role);
  const canManageDocs = ["Board Member", "Department Admin", "Training Officer"].includes(role);
  const [docs, setDocs] = useState([]);
  const [docsLoading, setDocsLoading] = useState(true);
  const [uploadType, setUploadType] = useState("SOP / SOG");
  function loadDocs() {
    return supabase
      .from("documents")
      .select("id, name, type, storage_path")
      .order("created_at", { ascending: false })
      .then(({ data, error }) => {
        if (error || !data) { setDocsLoading(false); return; }   // leave existing docs in place on a flaky read
        setDocs(data.map((r) => ({ id: r.id, name: r.name, type: r.type, storage_path: r.storage_path })));
        setDocsLoading(false);
      });
  }
  useEffect(() => { loadDocs(); }, []);
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
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      // collision-proof path: {deptId}/{timestamp}-{index}-{filename}
      const path = `${deptId}/${Date.now()}-${i}-${file.name}`;
      // 1) upload the file bytes to the private bucket
      const { error: upErr } = await supabase.storage.from("station-documents").upload(path, file);
      if (upErr) { failed.push(file.name); lastErr = upErr.message; continue; }
      // 2) write the metadata row
      const row = { department_id: deptId, name: file.name, type: uploadType, storage_path: path, uploaded_by: uploaderName };
      const { data: docData, error: docErr } = await supabase.from("documents").insert(row).select().single();
      if (docErr || !docData) { failed.push(file.name); lastErr = docErr?.message ?? "unknown error"; continue; }
      // confirmed-committed row — map to loadDocs's exact shape for an optimistic prepend
      added.push({ id: docData.id, name: docData.name, type: docData.type, storage_path: docData.storage_path });
      okCount++;
    }

    // 3) show the just-inserted rows instantly (already committed), then reconcile with DB truth
    if (added.length) setDocs((d) => [...added, ...d]);
    await loadDocs();   // non-destructive: a flaky read leaves the optimistic rows in place
    if (failed.length === 0) {
      notify({ kind: "success", title: "Documents uploaded", text: `${okCount} document${okCount === 1 ? "" : "s"} uploaded.` });
    } else if (okCount > 0) {
      notify({ kind: "error", title: "Some uploads failed", text: `${okCount} uploaded, ${failed.length} couldn't be added: ${failed.join(", ")}.` });
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
  async function deleteDoc(item) {
    if (!item?.storage_path || !item?.id) return;
    if (!window.confirm(`Delete "${item.name}"? This can't be undone.`)) return;
    // 1) remove the file from storage first (safer failure mode)
    const { error: rmErr } = await supabase.storage.from("station-documents").remove([item.storage_path]);
    if (rmErr) {
      notify({ kind: "error", title: "Couldn't delete file", text: "The document couldn't be removed — please try again.", details: rmErr.message });
      return;
    }
    // 2) then delete the metadata row
    const { error: rowErr } = await supabase.from("documents").delete().eq("id", item.id);
    if (rowErr) {
      notify({ kind: "error", title: "File removed, record not", text: "The file was deleted but its record couldn't be removed.", details: rowErr.message });
      loadDocs();
      return;
    }
    notify({ kind: "success", title: "Document deleted", text: `"${item.name}" was removed.` });
    loadDocs();
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

        <div style={{ ...FS.kicker, marginTop: 24, marginBottom: 8 }}><FilePlus size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />DRAFT A NEW DOCUMENT</div>
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

      <div style={{ ...FS.kicker, marginTop: 24, marginBottom: 8 }}><FolderOpen size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />YOUR DOCUMENT LIBRARY</div>
      {!docsLoading && docs.length === 0 ? (
        <div style={{ ...S.empty, ...FS.card, color: FIRE.textMuted }}>
          {canManageDocs
            ? "No documents yet — upload your first above."
            : "No documents have been added yet."}
        </div>
      ) : (
        <ResourceLibrary S={S} dark verb="Open" items={docs} onOpen={openDoc} onDelete={["Board Member", "Department Admin", "Training Officer"].includes(role) ? deleteDoc : undefined} />
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
    dow: { display: "grid", gridTemplateColumns: "repeat(7,1fr)", background: dark ? FIRE.btnBg : "#F7F6FA" },
    dowc: { padding: "7px 0", textAlign: "center", fontSize: 10.5, fontWeight: 700, color: dark ? FIRE.textMuted : "#8A8696", letterSpacing: 0.4 },
    grid: { display: "grid", gridTemplateColumns: "repeat(7,1fr)" },
    cell: { minHeight: 74, borderTop: `1px solid ${dark ? FIRE.hairline : "#EFEEF3"}`, borderLeft: `1px solid ${dark ? FIRE.hairline : "#EFEEF3"}`, padding: 5, display: "flex", flexDirection: "column", gap: 3 },
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
  const canEditCategories = ["Board Member", "Department Admin", "Training Officer"].includes(role);
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
  const canEdit = ["Board Member", "Department Admin", "Training Officer"].includes(role);

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
  const canEdit = ["Board Member", "Department Admin", "Training Officer"].includes(role);

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
const SOURCE_COLORS = { social: "#B11E2A", training: "#1F4E79", recruit: "#0E6B62", funding: "#9A6B12" };
const SOURCE_RANK = { training: 0, funding: 1, recruit: 2, social: 3 };
const SOURCE_TIER = { training: "bar", funding: "pill", recruit: "pill", social: "dot" };
function DashboardCalendar({ S }) {
  const today = new Date();
  const [cur, setCur] = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [items, setItems] = useState([]);
  const [filter, setFilter] = useState("all");
  const loadAll = () => {
    Promise.all([
      supabase.from("content_calendar").select("id, date, caption"),
      supabase.from("training_sessions").select("id, date, title"),
      supabase.from("recruitment_events").select("id, date, title"),
      supabase.from("funding_events").select("id, date, title"),
    ]).then(([social, training, recruit, funding]) => {
      const mapRows = (res, source, labelOf) =>
        (res.data || []).filter((r) => r.date).map((r) => {        // null data (source error) → []
          const [yy, mm, dd] = r.date.split("-").map(Number);
          return { source, id: `${source}-${r.id}`, y: yy, m: (mm || 1) - 1, d: dd, label: labelOf(r), color: SOURCE_COLORS[source], tier: SOURCE_TIER[source] };
        });
      setItems([
        ...mapRows(social, "social", (r) => r.caption || ""),
        ...mapRows(training, "training", (r) => r.title),
        ...mapRows(recruit, "recruit", (r) => r.title),
        ...mapRows(funding, "funding", (r) => r.title),
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
    { label: "Recruitment", key: "recruit", color: SOURCE_COLORS.recruit }, // teal — key is "recruit"
    { label: "Funding", key: "funding", color: SOURCE_COLORS.funding },   // amber
    { label: "Social", key: "social", color: SOURCE_COLORS.social },      // red
  ];

  return (
    <div>
      <div style={{ ...FS.kicker, marginBottom: 8 }}><Calendar size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />STATION CALENDAR</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 10 }}>
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
      <MonthCalendar
        cur={cur} setCur={setCur} dark
        items={monthItems}
        renderChip={(it) => ({ color: it.color, label: it.label, title: it.label, ...(filter === "all" ? { tier: it.tier } : {}) })}
        todayColor={FIRE.red}
        monthLabel={`${CAL_MONTHS[cur.m]} ${cur.y}`}
        overflowIndicator
      />
    </div>
  );
}
function Visibility({ S, brand, role, notify }) {
  const [topic, setTopic] = useState("A Tuesday-night ladder drill");
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

      <div style={{ ...FS.kicker, marginBottom: 8 }}>IDEAS FOR THINGS TO MAKE</div>
      <IdeaGrid S={S} dark items={[
        { h: "60-second station tour", p: "Walk the bay on a phone camera. People love seeing inside." },
        { h: "Member spotlight", p: "One photo + why they serve. Faces build trust the fastest." },
        { h: "Safety tip card", p: "Smoke alarms, seasonal hazards — useful posts get shared." },
        { h: "Training night clip", p: "A short drill video shows the work most people never see." },
        { h: "Apparatus feature", p: "\u201CMeet Engine 1 — here's what it carries.\u201D" },
        { h: "Thank-you post", p: "Recognize a donor, a volunteer, or the whole community." },
      ]} />

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

      <div style={{ ...FS.kicker, marginBottom: 8 }}>PUBLIC RELATIONS LIBRARY</div>
      <ResourceLibrary S={S} dark items={[
        { name: "Monthly content calendar template", type: "PDF · copy & repeat" },
        { name: "Caption starters", type: "Doc · fill-in" },
        { name: "Social Media Playbook", type: "PDF · the full guide" },
      ]} />
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
function Funding({ S, role, notify }) {
  const [mode, setMode] = useState("Plan a fundraiser");
  const [detail, setDetail] = useState("A pancake breakfast to raise money for new turnout gear.");
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const [log, setLog] = useState([
    { id: 1, name: "Pancake Breakfast", date: "May 2026", amount: 2150 },
    { id: 2, name: "Fill-the-Boot Drive", date: "Apr 2026", amount: 980 },
    { id: 3, name: "Spaghetti Dinner", date: "Feb 2026", amount: 1420 },
  ]);
  const [addingLog, setAddingLog] = useState(false);
  const [ln, setLn] = useState(""); const [ld, setLd] = useState(""); const [la, setLa] = useState("");
  const totalRaised = log.reduce((s, e) => s + (e.amount || 0), 0);
  const recentFor = (idea) => log.find((e) => e.name.toLowerCase().includes(idea.key) || idea.title.toLowerCase().includes(e.name.toLowerCase().split(" ")[0]));
  function planThis(idea) { setMode("Plan a fundraiser"); setDetail(`A ${idea.title.toLowerCase()} to raise money for the department.`); setOut(""); if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" }); }
  function addLog() { if (!ln.trim()) return; setLog((l) => [{ id: Date.now(), name: ln.trim(), date: ld.trim() || "Recent", amount: Number(String(la).replace(/[^0-9.]/g, "")) || 0 }, ...l]); setLn(""); setLd(""); setLa(""); setAddingLog(false); }
  function removeLog(id) { setLog((l) => l.filter((x) => x.id !== id)); }
  async function generate() {
    setLoading(true); setErr(""); setOut("");
    let sys;
    if (mode === "Plan a fundraiser") sys = "You help a volunteer fire/EMS department plan a fundraiser. Given their event idea, return a practical, plain-text plan a small volunteer crew can actually run: a one-line goal, a simple timeline/checklist, the roles/volunteers needed, a few promotion steps, and a realistic money target for a small town.\n\nThen the most important part — an in-depth 'Sponsorship Packages' section tailored to THIS specific event:\n1) Three or four headline tiers (such as Title/Presenting, Gold, Silver, Bronze), each with a suggested dollar amount and exactly what that sponsor gets (logo placement, banner, event shirt, program, PA shout-outs, social posts, top billing).\n2) An 'A la carte sponsorships' list of individual items that fit THIS event, each with a suggested price and what the sponsor gets. Pick the ones that make sense for the event from options like: event title, booth/vendor space, printed banner, PA/radio announcements, beverage/drink station, food/meal, dessert, coffee & water station, event t-shirt, swag bag, photo booth, kids' zone/bounce house, trophy/award, hole sponsor (for golf), raffle prize, parking, tent/shade, fire apparatus display, social media shout-out, live stream, yard signs, program ad, and in-kind goods/services. Aim for 8-12 relevant items.\n3) One short, ready-to-send outreach line the department can text or email to a local business.\n\nKeep dollar amounts realistic for a small community. Use clear short headings and simple dash bullet lines (no markdown symbols like # or *). Aim for 450-650 words.";
    else if (mode === "Community call-to-action") sys = "You write a short, warm community call-to-action for a volunteer fire/EMS department's fundraiser — for social or a flyer. Lead with purpose, make the ask clear, tie dollars to a concrete outcome. Under 90 words. Return only the text.";
    else sys = "You format a clear, warm donation-request letter for a volunteer fire/EMS department to send to a local business or community member. Proper letter structure, a specific ask, dollars tied to outcomes, gracious close. Use [BRACKETED] placeholders for names and amounts. Under 250 words.";
    try { const t = await callClaude(sys, `Department: North Hood Country VFD\nDetails: ${detail}`); setOut(t); }
    catch { setErr("Couldn't generate that just now. Try again."); } finally { setLoading(false); }
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
          <div style={{ ...FS.kicker, marginBottom: 8 }}><PartyPopper size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />FUNDRAISER PLANNER</div>
          <div style={S.segRow}>
            {["Plan a fundraiser", "Community call-to-action", "Format a letter"].map((m) => (
              <button key={m} onClick={() => { setMode(m); setOut(""); }} style={{ ...S.segBtn, background: mode === m ? FIRE.btnBg : "transparent", borderColor: mode === m ? FIRE.red : FIRE.btnBorder, color: mode === m ? FIRE.textPrimary : FIRE.navLabel }}>{m}</button>
            ))}
          </div>
          <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Tell us about it</span>
            <textarea style={{ ...FS.input, minHeight: 60, resize: "vertical" }} value={detail} onChange={(e) => setDetail(e.target.value)} /></label>
          <button style={{ ...FS.btnPrimary, marginTop: 12, opacity: loading ? 0.7 : 1 }} onClick={generate} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Working…</> : <><Sparkles size={16} /> Generate</>}
          </button>
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
          {out && <RichOutput S={S} text={out} dark />}
        </div>
      </div>

      <div style={{ ...FS.kicker, marginBottom: 8 }}><PartyPopper size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />EVENT IDEAS</div>
      <p style={{ ...S.helpP, color: FIRE.textMuted }}>Tap “Plan this” to load an idea into the planner above. Anything you’ve run lately is flagged so you can mix it up — or repeat it on purpose.</p>
      <div style={S.opGrid}>
        {FUNDRAISER_IDEAS.map((idea) => {
          const recent = recentFor(idea);
          return (
            <div key={idea.title} style={{ ...S.opCard, ...FS.card }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
                <div style={{ flex: 1, minWidth: 0 }}><div style={{ ...S.personName, color: FIRE.textPrimary }}>{idea.title}</div></div>
                {recent && <Pill S={S} color={FIRE.amberText}>DONE {recent.date}</Pill>}
              </div>
              <div style={{ fontSize: 13, color: FIRE.textSecondary, marginTop: 7 }}>{idea.p}</div>
              <div style={{ display: "flex", alignItems: "center", marginTop: 11 }}>
                <button style={{ ...FS.btn, marginLeft: "auto", padding: "7px 12px", fontSize: 12.5 }} onClick={() => planThis(idea)}><Sparkles size={14} /> Plan this</button>
              </div>
            </div>
          );
        })}
      </div>

      <div style={{ ...FS.kicker, marginBottom: 8 }}><Calendar size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />FUNDING CALENDAR</div>
      <FundingCalendar S={S} role={role} notify={notify} />

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

      <div style={{ ...FS.kicker, marginBottom: 8 }}>FUNDING LIBRARY</div>
      <ResourceLibrary S={S} dark items={[
        { name: "Fundraising idea menu", type: "PDF" },
        { name: "Sponsor package one-pager", type: "Doc · editable" },
        { name: "Donor & business outreach letters", type: "Doc · templates" },
        { name: "Fundraising plan & tracker", type: "PDF" },
      ]} />
    </div>
  );
}

/* ---------------- Roster & Operations ---------------- */
const MEMBERS = [
  { id: 1, name: "Maria Reyes", role: "Chief", access: "Department Admin", status: "Active", phone: "(817) 555-0142", joined: "2014", participation: 96, certs: [{ name: "Firefighter II", exp: "2027-03" }, { name: "EMT-B", exp: "2026-08" }, { name: "Hazmat Ops", exp: "2027-01" }], notes: [{ text: "Completed officer development course. Strong candidate for deputy chief.", by: "Department Admin", when: "May 2026" }] },
  { id: 2, name: "Tom Daniels", role: "Training Officer", access: "Training Officer", status: "Active", phone: "(817) 555-0188", joined: "2017", participation: 91, certs: [{ name: "Firefighter II", exp: "2026-09" }, { name: "EMT-B", exp: "2026-05" }, { name: "Fire Instructor I", exp: "2027-06" }], notes: [] },
  { id: 3, name: "Janelle Okafor", role: "Asst. Chief", access: "Board Member", status: "Active", phone: "(817) 555-0119", joined: "2015", participation: 88, certs: [{ name: "Firefighter II", exp: "2027-02" }, { name: "Paramedic", exp: "2026-07" }], notes: [] },
  { id: 4, name: "Cody Pearson", role: "Firefighter", access: "Member", status: "Active", phone: "(817) 555-0173", joined: "2021", participation: 76, certs: [{ name: "Firefighter I", exp: "2026-12" }, { name: "EMT-B", exp: "2026-04" }], notes: [{ text: "EMT-B lapsed — reminded to register for the July refresher.", by: "Training Officer", when: "Jun 2026" }] },
  { id: 5, name: "Sam Whitfield", role: "Firefighter", access: "Member", status: "Probationary", phone: "(817) 555-0166", joined: "2026", participation: 62, certs: [{ name: "Firefighter I", exp: "2027-05" }], notes: [{ text: "Probationary. Eager, good attitude — pair with a mentor.", by: "Training Officer", when: "Jun 2026" }] },
  { id: 6, name: "Dana Cole", role: "Firefighter / EMT", access: "Member", status: "Active", phone: "(817) 555-0150", joined: "2019", participation: 84, certs: [{ name: "Firefighter II", exp: "2026-08" }, { name: "EMT-B", exp: "2027-04" }], notes: [] },
];
const EVENTS = [
  { id: 1, name: "Tuesday Drill — Ladder Throws", date: "Jun 17", type: "Drill", present: 11, total: 14 },
  { id: 2, name: "Monthly Business Meeting", date: "Jun 10", type: "Meeting", present: 12, total: 14 },
  { id: 3, name: "EMS Refresher — Stroke", date: "Jun 3", type: "Drill", present: 9, total: 14 },
  { id: 4, name: "Structure Fire — Co. 2 mutual aid", date: "May 28", type: "Call", present: 7, total: 14 },
];
const APPARATUS_SEED = [
  { id: 1, name: "Engine 1", type: "Pumper", lastCheck: "Jun 22", by: "Daniels", status: "Pass", note: "All systems good" },
  { id: 2, name: "Brush 2", type: "Brush truck", lastCheck: "Jun 22", by: "Pearson", status: "Pass", note: "Water topped off" },
  { id: 3, name: "Tanker 1", type: "Tender", lastCheck: "Jun 15", by: "Cole", status: "Needs attention", note: "Low on foam concentrate" },
  { id: 4, name: "Rescue 1", type: "Rescue", lastCheck: "Jun 20", by: "Okafor", status: "Pass", note: "" },
];
function certStatus(exp) {
  if (typeof exp !== "string" || !/^\d{4}-\d{2}$/.test(exp)) return { label: "NO DATE", color: "#6A7178", rank: 3 };
  const [y, m] = exp.split("-").map(Number);
  const diff = (y * 12 + m) - (2026 * 12 + 6);
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
  const d = (y * 12 + m) - (2026 * 12 + 6);
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

function Roster({ S, role, members, setMembers, sessions, notify }) {
  const leader = isLeader(role);
  const tabs = leader
    ? [["members", "Members"], ["certs", "Certifications"], ["attendance", "Attendance"], ["reports", "Chief's Reports"], ...(canAssign(role) ? [["pending", "Pending Items"]] : [])]
    : [["members", "Members"]];
  const [tab, setTab] = useState("members");
  const [sel, setSel] = useState(null);
  const selected = members.find((m) => m.id === sel);
  const update = (m) => setMembers((ms) => ms.map((x) => (x.id === m.id ? m : x)));
  if (selected && leader) return <MemberDetail S={S} member={selected} role={role} back={() => setSel(null)} onUpdate={update} sessions={sessions} notify={notify} />;
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>ROSTER</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>Your people, all in one place</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>{leader ? "Members, certifications, who's showing up — and the reports the chief needs. Tap a member to see their full file." : "Your station directory and contacts."}</div>
      </div>
      <div style={S.segRow}>
        {tabs.map(([k, l]) => <button key={k} onClick={() => setTab(k)} style={{ ...S.segBtn, background: tab === k ? FIRE.btnBg : "transparent", borderColor: tab === k ? FIRE.red : FIRE.btnBorder, color: tab === k ? FIRE.textPrimary : FIRE.navLabel }}>{l}</button>)}
      </div>
      {tab === "members" && <RosterMembers S={S} role={role} members={members} setMembers={setMembers} onOpen={leader ? setSel : null} notify={notify} />}
      {tab === "certs" && leader && <RosterCerts S={S} members={members} />}
      {tab === "attendance" && leader && <RosterAttendance S={S} members={members} />}
      {tab === "reports" && leader && <RosterReports S={S} members={members} />}
      {tab === "pending" && canAssign(role) && <RosterPending S={S} members={members} notify={notify} />}
    </div>
  );
}
function RosterMembers({ S, role, members, setMembers, onOpen, notify }) {
  const canAdd = canAssign(role);
  const [adding, setAdding] = useState(false); const [nm, setNm] = useState(""); const [rl, setRl] = useState("Firefighter"); const [ph, setPh] = useState(""); const [em, setEm] = useState("");
  const sColor = (s) => s === "Active" ? FIRE.green : (s === "Probationary" ? FIRE.amberText : FIRE.textMuted);
  async function add() {
    if (!nm.trim()) return;
    const { data: dept } = await supabase.from("departments").select("id").limit(1).single();
    const newRow = { department_id: dept ? dept.id : null, name: nm.trim(), role: rl, access: "Member", status: "Probationary", phone: ph.trim() || "—", email: em.trim() || null, joined: "2026", participation: 0 };
    const { data, error } = await supabase.from("members").insert(newRow).select().single();
    if (error || !data) { notify({ kind: "error", title: "Couldn't add the member", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setMembers((m) => [...m, { id: data.id, name: data.name, role: data.role, access: data.access, status: data.status, phone: data.phone, email: data.email, joined: data.joined, participation: data.participation, certs: [], notes: [] }]);
    setNm(""); setPh(""); setEm(""); setAdding(false);
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
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Rank</span><select style={FS.input} value={rl} onChange={(e) => setRl(e.target.value)}><option>Firefighter</option><option>Firefighter / EMT</option><option>Training Officer</option><option>Asst. Chief</option><option>Chief</option></select></label>
          <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Phone</span><input style={FS.input} value={ph} onChange={(e) => setPh(e.target.value)} /></label>
          <label style={{ ...S.field, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Email</span><input style={FS.input} value={em} onChange={(e) => setEm(e.target.value)} /></label>
          <button style={{ ...FS.btnPrimary, flex: "0 0 auto" }} onClick={add}><UserPlus size={15} /> Add member</button>
        </div>
      ) : <button style={{ ...FS.btn, marginBottom: 12 }} onClick={() => setAdding(true)}><UserPlus size={15} /> Add member</button>)}
      <div style={S.opGrid}>
        {members.map((m) => (
          <div key={m.id} style={{ ...S.opCard, ...FS.card, ...(onOpen ? { cursor: "pointer" } : {}) }} onClick={onOpen ? () => onOpen(m.id) : undefined}>
            <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
              <Initials S={S} dark name={m.name} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...S.personName, color: FIRE.textPrimary }}>{m.name}</div>
                <div style={{ ...S.personMeta, color: FIRE.textMuted }}>{m.role}{m.access !== "Member" ? ` · ${m.access}` : ""} · since {m.joined}</div>
              </div>
              <Pill S={S} color={sColor(m.status)}>{m.status.toUpperCase()}</Pill>
              {canAdd && <button title="Remove from roster" style={{ ...FS.btn, padding: "6px 8px", marginLeft: 4 }} onClick={(e) => { e.stopPropagation(); remove(m.id, m.name); }}><X size={14} color={FIRE.deleteRed} /></button>}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 11, fontSize: 13, color: FIRE.textMuted }}>
              <Phone size={13} /> {m.phone}
              {onOpen ? <span style={{ marginLeft: "auto", display: "inline-flex", alignItems: "center", gap: 3, color: FIRE.btnText, fontWeight: 600, fontSize: 12.5 }}>View file <ChevronRight size={14} /></span>
                : <span style={{ marginLeft: "auto", fontFamily: "'IBM Plex Mono', ui-monospace, monospace" }}>{m.certs.length} certs</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
function MemberDetail({ S, member, role, back, onUpdate, sessions, notify }) {
  const assign = canAssign(role);
  const [note, setNote] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [editingCertId, setEditingCertId] = useState(null);
  const [draft, setDraft] = useState({ name: "", exp: "" });
  const certs = (member.certs || []).map((c) => ({ ...c, st: certStatus(c.exp) })).sort((a, b) => a.st.rank - b.st.rank);
  const notes = member.notes || [];
  function addNote() { if (!note.trim()) return; onUpdate({ ...member, notes: [{ text: note.trim(), by: role, when: "Just now" }, ...notes] }); setNote(""); }
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
          <div style={{ fontSize: 12.5, color: FIRE.textSecondary, display: "flex", justifyContent: "space-between" }}><span>Participation (90 days)</span><span>{member.participation == null ? "—" : `${member.participation}%`}</span></div>
          {member.participation != null && <Bar S={S} pct={member.participation} track={FIRE.track} color={member.participation >= 75 ? FIRE.green : member.participation >= 50 ? FIRE.amberText : FIRE.redText} />}
        </div>
        {assign && (
          <div style={{ marginTop: 16, paddingTop: 14, borderTop: `0.5px solid ${FIRE.hairline}` }}>
            <label style={S.field}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Station role &amp; access</span>
              <select style={{ ...FS.input, maxWidth: 260 }} value={member.access} onChange={(e) => onUpdate({ ...member, access: e.target.value })}>
                <option>Member</option><option>Training Officer</option><option>Board Member</option><option>Department Admin</option>
              </select></label>
            <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 5 }}>Sets what this person can see and do across the platform.</div>
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
        const done = (sessions || []).filter((s) => s.done).sort((a, b) => sessDate(b) - sessDate(a));
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
                      <div style={{ flex: 1, minWidth: 0 }}><span style={{ fontWeight: 600, color: FIRE.textPrimary }}>{s.title}</span> <span style={{ color: FIRE.textMuted, fontSize: 13 }}>· {fmtSess(s)}</span></div>
                      <Pill S={S} color={present ? FIRE.green : FIRE.redBright}>{present ? "PRESENT" : "ABSENT"}</Pill>
                    </div>
                  );
                })}
              </>)}
            </div>
          </>
        );
      })()}

      <div style={{ ...FS.kicker, marginBottom: 8 }}><MessageSquare size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />MEMBER LOG — LEADERSHIP ONLY</div>
      <div style={{ ...S.opCard, ...FS.card }}>
        <div style={{ display: "flex", gap: 8, marginBottom: notes.length ? 14 : 0 }}>
          <input style={{ ...FS.input, flex: 1 }} placeholder="Add a note — training, performance, kudos, follow-ups…" value={note} onChange={(e) => setNote(e.target.value)} />
          <button style={FS.btnPrimary} onClick={addNote}>Add</button>
        </div>
        {notes.map((n, i) => (
          <div key={i} style={{ ...S.certRow, borderBottom: i === notes.length - 1 ? "none" : `0.5px solid ${FIRE.hairline}`, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}><div style={{ fontSize: 13.5, color: FIRE.textSecondary, lineHeight: 1.5 }}>{n.text}</div><div style={{ fontSize: 11.5, color: FIRE.textMuted, marginTop: 3 }}>{n.by} · {n.when}</div></div>
          </div>
        ))}
        {notes.length === 0 && <div style={{ fontSize: 13, color: FIRE.textMuted }}>No notes yet. Notes here are visible to leadership only — never to the member.</div>}
      </div>
    </div>
  );
}
function ProposeCert({ S, role, member, notify }) {
  const canPropose = isLeader(role);
  const [open, setOpen] = useState(false);
  const [cName, setCName] = useState("");
  const [cExp, setCExp] = useState("");        // "YYYY-MM" string, matches certs.exp
  const [cNote, setCNote] = useState("");
  const [busy, setBusy] = useState(false);

  async function propose() {
    if (!cName.trim()) { notify({ kind: "error", title: "Certification needs a name", text: "Enter the certification name before submitting." }); return; }
    const exp = cExp.trim();
    if (exp && !/^\d{4}-\d{2}$/.test(exp)) { notify({ kind: "error", title: "Check the expiration format", text: "Expiration must be YYYY-MM (e.g. 2027-06)." }); return; }
    setBusy(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { notify({ kind: "error", title: "You're not signed in", text: "Please sign in again to continue." }); setBusy(false); return; }
    const row = {
      department_id: member.department_id,
      member_id: member.id,
      name: cName.trim(),
      exp: exp || null,
      source: "manual",
      note: cNote.trim() || null,
      proposed_by: user.id,
      // status omitted → defaults to 'pending'
    };
    const { data, error } = await supabase.from("cert_submissions").insert(row).select().single();
    setBusy(false);
    if (error || !data) { notify({ kind: "error", title: "Couldn't submit", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setCName(""); setCExp(""); setCNote(""); setOpen(false);
    notify({ kind: "success", text: "Submitted for review." });
  }

  if (!canPropose || !member) return null;
  return open ? (
    <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
      <label style={{ ...S.field, flex: 1, minWidth: 160 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Certification</span><input style={FS.input} value={cName} onChange={(e) => setCName(e.target.value)} /></label>
      <label style={{ ...S.field, minWidth: 130 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Expires (YYYY-MM)</span><input style={FS.input} value={cExp} onChange={(e) => setCExp(e.target.value)} placeholder="2027-06" /></label>
      <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Note (optional)</span><input style={FS.input} value={cNote} onChange={(e) => setCNote(e.target.value)} /></label>
      <button style={{ ...FS.btnPrimary, flex: "0 0 auto" }} disabled={busy} onClick={propose}>{busy ? "Submitting…" : "Submit for review"}</button>
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
function RosterAttendance({ S, members }) {
  const people = [...members].sort((a, b) => (b.participation ?? -1) - (a.participation ?? -1));
  return (
    <div>
      <div style={{ ...FS.kicker, marginBottom: 8 }}><CalendarCheck size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />RECENT EVENTS</div>
      <div style={{ ...FS.card, padding: "4px 16px", marginBottom: 22 }}>
        {EVENTS.map((e) => {
          const pct = Math.round((e.present / e.total) * 100);
          return (
            <div key={e.id} style={{ ...S.eventRow, borderBottom: `0.5px solid ${FIRE.hairline}` }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ ...S.personName, color: FIRE.textPrimary }}>{e.name}</div>
                <div style={{ ...S.personMeta, color: FIRE.textMuted }}>{e.type} · {e.date}</div>
              </div>
              <div style={{ width: 130 }}><div style={{ fontSize: 12.5, color: FIRE.textSecondary, textAlign: "right" }}>{e.present}/{e.total} ({pct}%)</div><Bar S={S} pct={pct} track={FIRE.track} color={pct >= 75 ? FIRE.green : FIRE.amberText} /></div>
            </div>
          );
        })}
      </div>
      <div style={{ ...FS.kicker, marginBottom: 8 }}>MEMBER PARTICIPATION (LAST 90 DAYS)</div>
      <div style={{ ...FS.card, padding: "4px 16px" }}>
        {people.map((m) => (
          <div key={m.id} style={{ ...S.eventRow, borderBottom: `0.5px solid ${FIRE.hairline}` }}>
            <Initials S={S} dark name={m.name} />
            <div style={{ flex: 1, minWidth: 0, marginLeft: 11 }}><div style={{ ...S.personName, color: FIRE.textPrimary }}>{m.name}</div><div style={{ ...S.personMeta, color: FIRE.textMuted }}>{m.role}</div></div>
            <div style={{ width: 130 }}><div style={{ fontSize: 12.5, color: FIRE.textSecondary, textAlign: "right" }}>{m.participation == null ? "—" : `${m.participation}%`}</div>{m.participation != null && <Bar S={S} pct={m.participation} track={FIRE.track} color={m.participation >= 75 ? FIRE.green : (m.participation >= 50 ? FIRE.amberText : FIRE.redText)} />}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
function RosterReports({ S, members }) {
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const active = members.filter((m) => m.status === "Active").length;
  const prob = members.filter((m) => m.status === "Probationary").length;
  const certs = []; members.forEach((m) => m.certs.forEach((c) => certs.push(certStatus(c.exp).rank)));
  const cur = certs.filter((r) => r === 2).length, expg = certs.filter((r) => r === 1).length, expd = certs.filter((r) => r === 0).length;
  const rated = members.filter((m) => m.participation != null);
  const avgPart = rated.length ? Math.round(rated.reduce((s, m) => s + m.participation, 0) / rated.length) : 0;
  const rigsReady = APPARATUS_SEED.filter((r) => r.status === "Pass").length;
  function buildReportData() {
    const flaggedCerts = [];
    members.forEach((m) => m.certs.forEach((c) => {
      const st = certStatus(c.exp);
      if (st.rank < 2) flaggedCerts.push({ member: m.name, cert: c.name, exp: expPhrase(c.exp), status: st.rank === 0 ? "Lapsed" : "Expiring" });
    }));
    return {
      deptName: "North Hood Country Volunteer Fire Department",
      station: "Station 20",
      kpis: { active, total: members.length, certPct: Math.round((cur / (cur + expg + expd)) * 100), certWarn: expd > 0, avgPart, rigsReady, rigsTotal: APPARATUS_SEED.length },
      counts: { active, prob, total: members.length, cur, expg, expd, avgPart },
      members: members.map((m) => ({ name: m.name, role: m.role, participation: m.participation, status: m.status })),
      flaggedCerts,
      apparatus: APPARATUS_SEED.map((r) => ({ name: r.name, type: r.type, lastCheck: r.lastCheck, ready: r.status === "Pass", note: r.note })),
      activity: EVENTS.map((e) => ({ name: e.name, date: e.date, type: e.type, present: e.present, total: e.total })),
    };
  }
  async function draft() {
    setLoading(true); setErr(""); setOut("");
    const summary = `North Hood Country VFD snapshot:\n- Members: ${active} active, ${prob} probationary (${members.length} total)\n- Certifications: ${cur} current, ${expg} expiring within 90 days, ${expd} expired\n- Average participation (90 days): ${avgPart}%\n- Apparatus ready: ${rigsReady} of ${APPARATUS_SEED.length}\n- Recent activity: ${EVENTS.length} events in the last 30 days (drills, a meeting, and a mutual-aid call)`;
    const sys = "You write a concise, professional readiness and activity report for a volunteer fire department chief to share with the city council or board. Use clear sections with bold titles and bullet points: an overview, training & certifications (flag the expiring/expired certs as an action item), participation, and apparatus readiness. Confident, factual tone. Under 350 words.";
    try { const t = await callClaude(sys, summary); setOut(t); } catch { setErr("Couldn't draft the report just now. Try again."); } finally { setLoading(false); }
  }
  return (
    <div>
      <div style={S.statRow}>
        <Stat S={S} dark n={`${active}/${members.length}`} label="Active members" />
        <Stat S={S} dark n={`${Math.round((cur / (cur + expg + expd)) * 100)}%`} label="Cert compliance" warn={expd > 0} />
        <Stat S={S} dark n={`${avgPart}%`} label="Avg participation" />
        <Stat S={S} dark n={`${rigsReady}/${APPARATUS_SEED.length}`} label="Apparatus ready" />
      </div>
      <div style={{ ...S.aiBanner, ...FS.card, borderLeft: `3px solid ${FIRE.red}` }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}><BarChart3 size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />BOARD &amp; CITY REPORT</div>
          <h3 style={{ ...S.featTitle, color: FIRE.textPrimary }}>Turn your numbers into a report — in one tap</h3>
          <p style={{ ...S.helpP, color: FIRE.textMuted, marginBottom: 10 }}>The summary the chief usually hand-builds for the city, drafted from your current roster, certs, participation, and apparatus.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button style={{ ...FS.btnPrimary, opacity: loading ? 0.7 : 1 }} onClick={draft} disabled={loading}>
              {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><BarChart3 size={16} /> Draft the report</>}
            </button>
            <button
              style={FS.btn}
              onClick={() => downloadDepartmentReport(buildReportData())}>
              <Download size={16} /> Download PDF
            </button>
          </div>
          {err && <div style={{ ...S.errBox, background: FIRE.btnBg, border: `0.5px solid ${FIRE.hairline}`, color: FIRE.redText }}>{err}</div>}
          {out && <RichOutput S={S} text={out} dark />}
        </div>
      </div>
    </div>
  );
}

/* ---------------- Apparatus ---------------- */
const APPARATUS_TYPES = ["Pumper", "Tender / Tanker", "Brush truck", "Rescue", "Ladder / Aerial", "Squad", "Command", "Ambulance", "Other"];
function Apparatus({ S, role }) {
  const [rigs, setRigs] = useState(APPARATUS_SEED);
  const canManage = canAssign(role);
  const [adding, setAdding] = useState(false);
  const [nm, setNm] = useState(""); const [tp, setTp] = useState("Pumper"); const [rd, setRd] = useState("Ready");
  const ready = rigs.filter((r) => r.status === "Pass").length;
  const flagged = rigs.length - ready;
  function logCheck(id) { setRigs((rs) => rs.map((r) => r.id === id ? { ...r, lastCheck: "Just now", by: "You", status: "Pass", note: "Checked — all good" } : r)); }
  function addRig() {
    if (!nm.trim()) return;
    setRigs((rs) => [...rs, { id: Date.now(), name: nm.trim(), type: tp, lastCheck: "—", by: "—", status: rd === "Ready" ? "Pass" : "Needs attention", note: rd === "Ready" ? "" : "Newly added — needs a check" }]);
    setNm(""); setTp("Pumper"); setRd("Ready"); setAdding(false);
  }
  function removeRig(id, name) {
    if (window.confirm(`Take "${name}" out of the station? This removes it from the apparatus list.`)) {
      setRigs((rs) => rs.filter((r) => r.id !== id));
    }
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
                {canManage && <button title="Take out of station" style={{ ...FS.btn, padding: "6px 8px", marginLeft: 4 }} onClick={() => removeRig(r.id, r.name)}><X size={14} color={FIRE.deleteRed} /></button>}
              </div>
              {r.note && <div style={{ fontSize: 13, color: ok ? FIRE.textSecondary : FIRE.redText, marginTop: 10 }}>{r.note}</div>}
              <div style={{ display: "flex", alignItems: "center", marginTop: 11, fontSize: 12, color: FIRE.textMuted }}>
                <span>Last check: {r.lastCheck} · {r.by}</span>
                <button style={{ ...FS.btn, marginLeft: "auto", padding: "7px 12px", fontSize: 12.5 }} onClick={() => logCheck(r.id)}><ClipboardCheck size={14} /> Log a check</button>
              </div>
            </div>
          );
        })}
      </div>
      )}
      <MaintenancePanel S={S} role={role} rigs={rigs} />
    </div>
  );
}

/* ---------------- Maintenance reminders + checklists ---------------- */
const MAINT_SEED = [
  { id: 1, unit: "Engine 1", task: "Pump & water-tank check", cadence: "Weekly", last: "Jun 22", status: "Current" },
  { id: 2, unit: "Engine 1", task: "Annual pump service test", cadence: "Annual", last: "Aug 2025", status: "Due soon" },
  { id: 3, unit: "Brush 2", task: "Equipment & PPE check", cadence: "Weekly", last: "Jun 22", status: "Current" },
  { id: 4, unit: "Tanker 1", task: "Foam concentrate level", cadence: "Monthly", last: "May 10", status: "Overdue" },
  { id: 5, unit: "Rescue 1", task: "SCBA flow test", cadence: "Annual", last: "Sep 2025", status: "Due soon" },
  { id: 6, unit: "All units", task: "Registration & insurance", cadence: "Annual", last: "Jan 2026", status: "Current" },
];
const MAINT_COLOR = { Overdue: "#B11E2A", "Due soon": "#9A6B12", Current: "#2E7D52" };
const MAINT_FIRE = { Overdue: FIRE.redText, "Due soon": FIRE.amberText, Current: FIRE.greenText };
function MaintenancePanel({ S, role, rigs }) {
  const canManage = canAssign(role);
  const [items, setItems] = useState(MAINT_SEED);
  const [adding, setAdding] = useState(false);
  const [u, setU] = useState(rigs[0]?.name || "All units"); const [t, setT] = useState(""); const [cad, setCad] = useState("Monthly");
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const order = { Overdue: 0, "Due soon": 1, Current: 2 };
  const sorted = [...items].sort((a, b) => order[a.status] - order[b.status]);
  const due = items.filter((i) => i.status !== "Current").length;
  function markDone(id) { setItems((xs) => xs.map((x) => x.id === id ? { ...x, status: "Current", last: "Just now" } : x)); }
  function addItem() { if (!t.trim()) return; setItems((xs) => [...xs, { id: Date.now(), unit: u, task: t.trim(), cadence: cad, last: "—", status: "Due soon" }]); setT(""); setAdding(false); }
  function removeItem(id) { setItems((xs) => xs.filter((x) => x.id !== id)); }
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
            {canManage && <button title="Remove" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => removeItem(i.id)}><X size={14} color={FIRE.deleteRed} /></button>}
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
function Minutes({ S }) {
  const [title, setTitle] = useState("Monthly Business Meeting");
  const [date, setDate] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const [actions, setActions] = useState([
    { id: 1, text: "Get vendor quote for Engine 2 pump repair", owner: "Chief Reyes", due: "Jun 30", done: false },
    { id: 2, text: "Confirm July EMT-B refresher seats", owner: "T.O. Daniels", due: "Jul 1", done: false },
    { id: 3, text: "Post open-house recap to socials", owner: "Okafor", due: "Jun 20", done: true },
  ]);
  const [at, setAt] = useState(""); const [ao, setAo] = useState(""); const [ad, setAd] = useState("");
  const open = actions.filter((a) => !a.done).length;
  async function draft() {
    if (!notes.trim()) { setErr("Add a few rough notes first and I'll shape them into minutes."); return; }
    setLoading(true); setErr(""); setOut("");
    const sys = "You turn a volunteer fire department's rough meeting notes into clean, structured DRAFT minutes for the secretary and board to review and approve. Use plain headers: Attendees, Old Business, New Business, Decisions, and Action Items (each action with an owner and a due date if implied). Keep it factual to the notes — never invent attendance, votes, or decisions that aren't there. Under 350 words.";
    try { const t = await callClaude(sys, `Meeting: ${title}${date ? ` on ${date}` : ""}\nRough notes:\n${notes}`); setOut(t); }
    catch { setErr("Couldn't draft the minutes just now. Try again."); } finally { setLoading(false); }
  }
  function addAction() { if (!at.trim()) return; setActions((a) => [...a, { id: Date.now(), text: at.trim(), owner: ao.trim() || "Unassigned", due: ad.trim() || "—", done: false }]); setAt(""); setAo(""); setAd(""); }
  function toggle(id) { setActions((a) => a.map((x) => x.id === id ? { ...x, done: !x.done } : x)); }
  function removeA(id) { setActions((a) => a.filter((x) => x.id !== id)); }
  return (
    <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
      <div style={{ marginBottom: 16 }}>
        <div style={FS.kicker}>MEETING MINUTES</div>
        <h1 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 30, fontWeight: 700, color: FIRE.textPrimary, margin: "7px 0 6px", letterSpacing: "-0.01em" }}>From rough notes to clean minutes</h1>
        <div style={{ fontSize: 14, color: FIRE.textSecondary, lineHeight: 1.5 }}>Type your notes, get a structured draft to approve, and carry every action item to the next meeting.</div>
      </div>
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
        </div>
      </div>

      <div style={{ ...FS.kicker, marginBottom: 8 }}>ACTION ITEMS{open > 0 ? ` · ${open} OPEN` : ""}</div>
      <div style={{ ...S.opCard, ...FS.card, marginBottom: 12, display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <label style={{ ...S.field, flex: 1, minWidth: 180 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Action</span><input style={FS.input} value={at} placeholder="What needs to happen?" onChange={(e) => setAt(e.target.value)} /></label>
        <label style={{ ...S.field, minWidth: 130 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Owner</span><input style={FS.input} value={ao} placeholder="Who?" onChange={(e) => setAo(e.target.value)} /></label>
        <label style={{ ...S.field, minWidth: 120 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Due</span><input style={FS.input} value={ad} placeholder="When?" onChange={(e) => setAd(e.target.value)} /></label>
        <button style={FS.btnPrimary} onClick={addAction}><Plus size={15} /> Add</button>
      </div>
      <div>
        {actions.map((a) => (
          <div key={a.id} style={{ ...S.certRow, borderBottom: `0.5px solid ${FIRE.hairline}` }}>
            <button onClick={() => toggle(a.id)} title={a.done ? "Mark open" : "Mark done"} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "inline-flex", flexShrink: 0 }}>
              {a.done ? <CheckCircle2 size={18} color={FIRE.green} /> : <span style={{ width: 16, height: 16, borderRadius: 999, border: `2px solid ${FIRE.textMuted}`, display: "inline-block" }} />}
            </button>
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ fontWeight: 600, color: a.done ? FIRE.textMuted2 : FIRE.textPrimary, textDecoration: a.done ? "line-through" : "none" }}>{a.text}</span>
              <div style={{ fontSize: 12, color: FIRE.textMuted, marginTop: 1 }}>{a.owner} · due {a.due}</div>
            </div>
            <button title="Remove" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => removeA(a.id)}><X size={14} color={FIRE.deleteRed} /></button>
          </div>
        ))}
      </div>
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
function Onboarding({ S, members }) {
  const candidates = members.length ? members : [{ id: 0, name: "New member", role: "Firefighter" }];
  const probI = candidates.findIndex((m) => m.status === "Probationary");
  const [who, setWho] = useState(candidates[probI >= 0 ? probI : 0].name);
  const [checks, setChecks] = useState({});
  const [loading, setLoading] = useState(false); const [out, setOut] = useState(""); const [err, setErr] = useState("");
  const all = ONBOARD_TEMPLATE.flatMap((g) => g.items.map((_, i) => `${who}::${g.group}::${i}`));
  const doneCount = all.filter((k) => checks[k]).length;
  const pct = Math.round((doneCount / all.length) * 100);
  const person = candidates.find((m) => m.name === who);
  function toggle(key) { setChecks((c) => ({ ...c, [key]: !c[key] })); }
  async function draftPlan() {
    setLoading(true); setErr(""); setOut("");
    const sys = "You write a warm welcome note and a practical first-30-days onboarding plan for a new volunteer firefighter/EMT joining a small department. Friendly and concrete: a short welcome, then week-by-week steps covering paperwork, gear, orientation, shadowing/mentor, and first trainings. This is a DRAFT for an officer to review and send. Under 320 words, plain headers and bullets.";
    try { const t = await callClaude(sys, `New member: ${who}${person?.role ? `, joining as ${person.role}` : ""}.`); setOut(t); }
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
          <select style={FS.input} value={who} onChange={(e) => { setWho(e.target.value); }}>{candidates.map((m) => <option key={m.id}>{m.name}</option>)}</select></label>
        <div style={{ flex: 1, minWidth: 180 }}>
          <div style={{ fontSize: 12.5, color: FIRE.textSecondary, display: "flex", justifyContent: "space-between", ...FS.num }}><span>Onboarding progress</span><span>{pct}%</span></div>
          <Bar S={S} pct={pct} color={pct >= 100 ? FIRE.green : pct >= 50 ? FIRE.amberText : FIRE.redText} track={FIRE.track} />
        </div>
      </div>
      {ONBOARD_TEMPLATE.map((g) => (
        <div key={g.group} style={{ marginBottom: 6 }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}>{g.group.toUpperCase()}</div>
          {g.items.map((it, i) => {
            const key = `${who}::${g.group}::${i}`; const done = !!checks[key];
            return (
              <div key={i} style={FS.row}>
                <button onClick={() => toggle(key)} title={done ? "Undo" : "Mark complete"} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "inline-flex", flexShrink: 0 }}>
                  {done ? <CheckCircle2 size={18} color={FIRE.green} /> : <span style={{ width: 16, height: 16, borderRadius: 5, border: `2px solid ${FIRE.textMuted2}`, display: "inline-block" }} />}
                </button>
                <div style={{ flex: 1, minWidth: 0, color: done ? FIRE.textMuted2 : FIRE.textPrimary, textDecoration: done ? "line-through" : "none", fontSize: 14 }}>{it}</div>
              </div>
            );
          })}
        </div>
      ))}
      <div style={{ ...FS.card, padding: 18, marginTop: 10 }}>
        <div style={{ flex: 1 }}>
          <div style={{ ...FS.kicker, marginBottom: 8 }}><Sparkles size={13} color={FIRE.red} style={{ marginRight: 5, verticalAlign: "-2px" }} />AI WELCOME & 30-DAY PLAN</div>
          <h3 style={{ fontFamily: "'Oswald', system-ui, sans-serif", fontSize: 18, fontWeight: 700, color: FIRE.textPrimary, margin: "0 0 4px" }}>Draft a welcome for {who}</h3>
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
function Training({ S, role, plan, setPlan, loadPlans, sessions, setSessions, loadSessions, members, meId, checkIn, notify }) {
  const canManage = ["Board Member", "Department Admin", "Training Officer"].includes(role);
  const canRunSignin = ["Department Admin", "Training Officer", "Project Admin"].includes(role);   // QR generate-gate (NOT Board Member, NOT Member)
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
  const dim = new Date(cur.y, cur.m + 1, 0).getDate();
  const [sd, setSd] = useState(Math.min(today.getDate(), dim));
  const [spid, setSpid] = useState(plan[0]?.id || 0);
  const [stitle, setStitle] = useState("");
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
  const planView = plan.map((p) => ({ p, info: dueInfo(p) })).sort((a, b) => rank(a.info.label) - rank(b.info.label));
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
    });
    if (error) { notify({ kind: "error", title: "Couldn't schedule the session", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    setShowSess(false); setStitle(""); loadSessions();
  }
  async function completeSession(s) {
    const { error } = await supabase.from("training_sessions").update({ done: true }).eq("id", s.id);
    if (error) { notify({ kind: "error", title: "Couldn't update the session", text: "Something went wrong saving that. Please try again.", details: error.message }); return; }
    // plan-linked -> reset the overdue clock to today, persisted. One-offs reset nothing.
    if (s.planId) {
      const iso = toISO(new Date());
      const { error: pErr } = await supabase.from("training_plans").update({ last_iso: iso }).eq("id", s.planId);
      if (pErr) notify({ kind: "error", title: "Session complete — clock not reset", text: "The session was saved, but the training clock couldn't be reset.", details: pErr.message });
      else setPlan((ps) => ps.map((p) => p.id === s.planId ? { ...p, lastISO: iso } : p));
    }
    setOpenAtt(s.id);   // (a) open the attendance roster in the same step
    loadSessions();
    loadPlans();
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
    // 1) upload the new file FIRST (so the old plan stays intact if upload fails)
    const path = `${deptId}/plans/${Date.now()}-${file.name}`;
    const { error: upErr } = await supabase.storage.from("station-documents").upload(path, file);
    if (upErr) { notify({ kind: "error", title: "Couldn't upload the plan", text: "Something went wrong uploading that. Please try again.", details: upErr.message }); return; }
    // 2) REPLACE: clear any existing plan(s) for this session — storage-first, then rows (like deleteDoc)
    const { data: olds } = await supabase.from("session_plans").select("id, storage_path").eq("session_id", s.id);
    const oldPaths = (olds || []).map((p) => p.storage_path).filter(Boolean);
    if (oldPaths.length) await supabase.storage.from("station-documents").remove(oldPaths);
    if (olds && olds.length) await supabase.from("session_plans").delete().eq("session_id", s.id);
    // 3) insert the new plan
    const { error: insErr } = await supabase.from("session_plans").insert({ department_id: deptId, session_id: s.id, title: file.name, source: "upload", storage_path: path, created_by: me?.name || "Unknown" });
    if (insErr) { notify({ kind: "error", title: "Couldn't attach the plan", text: "The file uploaded but couldn't be attached. Please try again.", details: insErr.message }); loadSessions(); return; }
    notify({ kind: "success", title: "Plan attached", text: `"${file.name}" is now the plan for ${s.title}.` });
    loadSessions();
  }
  async function openPlan(plan) {
    if (!plan?.storage_path) return;
    const { data, error } = await supabase.storage.from("station-documents").createSignedUrl(plan.storage_path, 3600);
    if (error || !data?.signedUrl) { notify({ kind: "error", title: "Couldn't open the plan", text: "The plan couldn't be opened — please try again.", details: error?.message ?? "no signed URL" }); return; }
    const a = document.createElement("a"); a.href = data.signedUrl; a.target = "_blank"; a.rel = "noopener"; document.body.appendChild(a); a.click(); a.remove();
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
    const upcoming = sessions.filter((s) => !s.done && sessDate(s) >= t0).sort((a, b) => sessDate(a) - sessDate(b));

    // IDENTICAL chip logic to the leader calendar — colors/layout unchanged (do not alter).
    const renderChip = (s) => {
      const cat = plan.find((p) => String(p.id) === String(s.planId));
      const base = cat?.color || "#1F4E79";
      const mix = (hex, tt) => {
        const h = hex.replace("#", "");
        const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
        const tr = 42, tg = 46, tb = 53; // #2A2E35
        const to2 = (n) => n.toString(16).padStart(2, "0");
        return "#" + to2(Math.round(r + (tr - r) * tt)) + to2(Math.round(g + (tg - g) * tt)) + to2(Math.round(b + (tb - b) * tt));
      };
      const color = s.done ? mix(base, 0.45) : base;
      return { color, label: `${s.done ? "✓ " : ""}${s.title}`, title: `${s.title}${s.done ? " (completed)" : ""}` };
    };

    const card = { ...FS.card, padding: 18, marginBottom: 14 };   // base + member padding/margin (identical)
    const kick = FS.kicker;
    const num = FS.num;

    return (
      <div style={{ background: FIRE.pageBg, borderRadius: 20, padding: "22px 20px", margin: "-6px -2px 0" }}>
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
                    <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary }}>{s.title}</div>
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
                  {s.plan && <button onClick={() => openPlan(s.plan)} style={{ fontSize: 11.5, fontWeight: 600, color: "#C7CDD6", background: "rgba(255,255,255,.04)", border: "0.5px solid rgba(255,255,255,.1)", borderRadius: 8, padding: "5px 9px", cursor: "pointer", flexShrink: 0 }}>Open plan</button>}
                </div>
              );
            })}
          </div>
        </div>

        {/* 6 — upcoming / prep ahead (no "Open plan" control — materials are greenfield) */}
        <div style={card}>
          <div style={kick}>UPCOMING · PREP AHEAD</div>
          <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 9 }}>
            {upcoming.length === 0 ? (
              <div style={{ fontSize: 13, color: FIRE.textMuted }}>Nothing on the calendar yet.</div>
            ) : upcoming.map((s) => { const cat = catOf(s); return (
              <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 11 }}>
                <span style={{ width: 9, height: 9, borderRadius: 999, background: cat?.color || "#1F4E79", flexShrink: 0 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary }}>{s.title}</div>
                  <div style={{ fontSize: 11.5, color: FIRE.textMuted, ...num }}>{fmtSess(s)} · {cat?.name || "One-off"}</div>
                </div>
                {s.plan && <button onClick={() => openPlan(s.plan)} style={{ fontSize: 11.5, fontWeight: 600, color: "#C7CDD6", background: "rgba(255,255,255,.04)", border: "0.5px solid rgba(255,255,255,.1)", borderRadius: 8, padding: "5px 9px", cursor: "pointer", flexShrink: 0 }}>Open plan</button>}
              </div>
            ); })}
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
  const totalMembers = members.length;
  const hasAtt = !!lastDone && lastAtt > 0;
  const ringR = 26, ringC = 2 * Math.PI * ringR, ringFrac = totalMembers ? lastAtt / totalMembers : 0;
  // Card 3 — next not-done session from today forward (pure read)
  const t0n = new Date(today); t0n.setHours(0, 0, 0, 0);
  const nextSession = sessions.filter((s) => !s.done && sessDate(s) >= t0n).sort((a, b) => sessDate(a) - sessDate(b))[0];
  const nextCat = nextSession ? plan.find((p) => String(p.id) === String(nextSession.planId)) : null;
  // Card 2 — neither upload-to-session nor AI-draft is built; controls are honest about it
  const comingSoon = (what) => notify({ title: "Coming soon", text: `${what} isn't available yet — it lands in an upcoming update.` });

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
          <button onClick={() => comingSoon("Draft with AI")} style={{ ...Lbtn, marginTop: 10, width: "100%", justifyContent: "center" }}><Sparkles size={14} color={LbtnIcon} /> Draft with AI</button>
          <div style={{ fontSize: 11, color: "#7E8794", marginTop: 8 }}>AI plan drafting — coming soon.</div>
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
          <label style={{ ...Lfield, minWidth: 90 }}><span style={LfieldLabel}>Day</span><select style={Linput} value={sd} onChange={(e) => setSd(e.target.value)}>{Array.from({ length: dim }, (_, i) => i + 1).map((d) => <option key={d}>{d}</option>)}</select></label>
          <label style={{ ...Lfield, minWidth: 170 }}><span style={LfieldLabel}>Training</span><select style={Linput} value={spid} onChange={(e) => setSpid(e.target.value)}>{plan.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}<option value={0}>Other / one-off…</option></select></label>
          <label style={{ ...Lfield, flex: 1, minWidth: 150 }}><span style={LfieldLabel}>Title (optional)</span><input style={Linput} value={stitle} placeholder="Defaults to the training name" onChange={(e) => setStitle(e.target.value)} /></label>
          <button style={LprimaryBtn} onClick={addSession}><Plus size={15} /> Add to {TRAIN_MONTHS[cur.m]}</button>
          <button style={Lbtn} onClick={() => setShowSess(false)}>Cancel</button>
        </div>
      ) : <button style={{ ...Lbtn, marginBottom: 12 }} onClick={() => { setSpid(plan[0]?.id || 0); setSd(Math.min(today.getDate(), dim)); setShowSess(true); }}><Plus size={15} color={LbtnIcon} /> Schedule a session</button>)}

      {/* calendar wrapped in dark card; dark calendar in dark card; red today marker */}
      <div style={{ ...Lcard, marginBottom: 16 }}>
        <div style={{ marginBottom: -10 }}>
          <MonthCalendar
            cur={cur} setCur={setCur} dark
            items={monthSessions}
            renderChip={(s) => {
              // base color = linked category's live color, or fallback blue for one-off / deleted category
              const cat = plan.find((p) => String(p.id) === String(s.planId));
              const base = cat?.color || "#1F4E79";
              // dim toward dark slate for completed (keep dark enough for white text)
              const mix = (hex, t) => {
                const h = hex.replace("#", "");
                const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
                const tr = 42, tg = 46, tb = 53; // #2A2E35
                const to2 = (n) => n.toString(16).padStart(2, "0");
                return "#" + to2(Math.round(r + (tr - r) * t)) + to2(Math.round(g + (tg - g) * t)) + to2(Math.round(b + (tb - b) * t));
              };
              const color = s.done ? mix(base, 0.45) : base;
              return { color, label: `${s.done ? "✓ " : ""}${s.title}`, title: `${s.title}${s.done ? " (completed)" : ""}` };
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
              return (
                <div key={s.id}>
                  <div style={Lrow}>
                    <CalendarCheck size={15} color={plan.find((p) => String(p.id) === String(s.planId))?.color || "#1F4E79"} style={{ flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <span style={{ fontWeight: 600, color: "#F0F2F5" }}>{s.title}</span>
                      <div style={{ fontSize: 12, color: "#7E8794", marginTop: 1, ...Lnum }}>{TRAIN_MONTHS[cur.m].slice(0, 3)} {s.d}{s.planId ? " · counts toward the plan" : " · one-off"}{s.done ? ` · ${att.length}/${members.length} attended` : ""}</div>
                    </div>
                    {/* REORDERED: Attendance → QR sign-in → Mark complete / DONE → delete */}
                    <button style={Lbtn} onClick={() => setOpenAtt(open ? null : s.id)}><Users size={14} color={LbtnIcon} /> Attendance {att.length}/{members.length}</button>
                    {canRunSignin && !s.done && <button style={{ ...Lbtn, ...(s.signinOpen ? { color: "#76C98D", borderColor: "rgba(118,201,141,.4)" } : {}) }} onClick={() => setOpenSignin(openSignin === s.id ? null : s.id)}><QrCode size={14} color={s.signinOpen ? "#76C98D" : LbtnIcon} /> QR sign-in{s.signinOpen ? " · open" : ""}</button>}
                    {canManage && (s.plan
                      ? <span style={{ display: "inline-flex", gap: 4 }}>
                          <button style={Lbtn} onClick={() => openPlan(s.plan)}><FileText size={14} color={LbtnIcon} /> Open plan</button>
                          <button title="Remove plan" style={{ ...Lbtn, padding: "6px 8px" }} onClick={() => detachPlan(s.plan)}><X size={14} color="#C8606A" /></button>
                        </span>
                      : <label style={{ ...Lbtn, cursor: "pointer" }}><FileText size={14} color={LbtnIcon} /> Attach plan<input type="file" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ""; attachPlan(s, f); }} /></label>)}
                    {s.done ? <Pill S={S} color="#76C98D">DONE</Pill> : canManage && <button style={Lbtn} onClick={() => completeSession(s)}><ClipboardCheck size={14} color={LbtnIcon} /> Mark complete</button>}
                    {canManage && <button title="Remove" style={{ ...Lbtn, padding: "6px 8px" }} onClick={() => removeSession(s.id)}><X size={14} color="#C8606A" /></button>}
                  </div>
                  {open && (
                    <div style={{ ...Lcard, margin: "2px 0 10px", padding: 12 }}>
                      <div style={{ fontSize: 12, color: "#9AA1AC", marginBottom: 8 }}>{canManage ? (s.done ? "This session is complete — attendance is locked." : "Tap a name to mark who attended.") : "Who attended this session."}</div>
                      {members.map((m) => {
                        const present = att.includes(m.id);
                        return (
                          <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "5px 0", borderBottom: "0.5px solid rgba(255,255,255,.05)" }}>
                            {canManage && !s.done
                              ? <button onClick={() => toggleAttend(s, m.id)} title={present ? "Mark absent" : "Mark present"} style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "inline-flex" }}>{present ? <CheckCircle2 size={18} color="#76C98D" /> : <span style={{ width: 16, height: 16, borderRadius: 999, border: "2px solid rgba(255,255,255,.25)", display: "inline-block" }} />}</button>
                              : (present ? <CheckCircle2 size={18} color="#76C98D" /> : <X size={16} color="#E58A90" />)}
                            <span style={{ flex: 1, fontSize: 13.5, color: present ? "#F0F2F5" : "#9AA1AC" }}>{m.name}{m.id === meId ? " (you)" : ""}</span>
                            <span style={{ fontSize: 11, fontWeight: 700, color: present ? "#76C98D" : "#E58A90" }}>{present ? "PRESENT" : "ABSENT"}</span>
                          </div>
                        );
                      })}
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
                            <div style={{ marginTop: 8, fontSize: 12, color: "#9AA1AC" }}>This session's code: <b style={{ letterSpacing: 2, color: "#F0F2F5" }}>{liveToken}</b></div>
                            <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10, flexWrap: "wrap" }}>
                              <button style={Lbtn} onClick={() => rotateSI(s)}><RefreshCw size={14} color={LbtnIcon} /> Rotate code</button>
                              <button style={{ ...Lbtn, padding: "7px 11px" }} onClick={() => closeSI(s)}><X size={14} color="#C8606A" /> Close</button>
                            </div>
                            <button style={{ ...Lbtn, marginTop: 8 }} onClick={async () => { const r = await checkIn(s.id, liveToken, meId); notify(r.ok ? { title: r.already ? "Already checked in" : "Checked in", text: `${me?.name || "You"} ${r.already ? "were already on the list" : "added"}.` } : { kind: "error", title: "Couldn't check in", text: r.reason }); }}>Simulate a scan (check me in)</button>
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
function BrandKit({ S, role, brand, setBrand }) {
  const canManage = canAssign(role);
  const set = (k, v) => setBrand((b) => ({ ...b, [k]: v }));
  function onLogo(e) { const file = e.target.files?.[0]; if (!file) return; const r = new FileReader(); r.onload = () => set("logo", r.result); r.readAsDataURL(file); }
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
      <p style={S.helpP}>On-brand graphics using your Brand Kit colors and logo. Pick a template and a size, edit the text, optionally drop in your own background image, and download a ready-to-post PNG.</p>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 7, marginBottom: 10 }}>
        {GFX_TEMPLATES.map((t) => (
          <button key={t.key} onClick={() => pick(t.key)} style={{ ...S.segBtn, ...(tk === t.key ? S.segBtnOn : {}) }}>{t.name}</button>
        ))}
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#8A8696", letterSpacing: 0.4, marginBottom: 6 }}>SIZE — WHERE'S IT GOING?</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {GFX_SIZES.map((sz) => (
            <button key={sz.key} onClick={() => setSizeKey(sz.key)} title={sz.hint} style={{ ...S.segBtn, ...(sizeKey === sz.key ? S.segBtnOn : {}), display: "flex", flexDirection: "column", alignItems: "flex-start", lineHeight: 1.25, padding: "7px 11px" }}><span>{sz.name}</span><span style={{ fontSize: 10, fontWeight: 500, opacity: 0.7 }}>{sz.hint}</span></button>
          ))}
        </div>
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={{ fontSize: 11, fontWeight: 700, color: "#8A8696", letterSpacing: 0.4, marginBottom: 6 }}>STYLE</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 7 }}>
          {STYLES.map((sy) => (
            <button key={sy.key} onClick={() => setStyleKey(sy.key)} style={{ ...S.segBtn, ...(styleKey === sy.key ? S.segBtnOn : {}) }}>{sy.name}</button>
          ))}
        </div>
      </div>
      <div style={{ display: "flex", gap: 18, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          {[0, 1, 2, 3].map((i) => {
            const key = `l${i + 1}`;
            return (
              <label key={i} style={{ ...S.field, marginBottom: 8 }}><span style={S.fieldLabel}>{tmpl.labels[i]}</span>
                <input style={S.input} value={f[key] || ""} onChange={(e) => setF((x) => ({ ...x, [key]: e.target.value }))} /></label>
            );
          })}
          {tk === "spotlight" && (
            <label style={{ ...S.ghostBtn, marginTop: 4, cursor: "pointer", display: "inline-flex" }}><Upload size={15} /> {photo ? "Change photo" : "Add member photo"}<input type="file" accept="image/*" onChange={onPhoto} style={{ display: "none" }} /></label>
          )}
          <div style={{ marginTop: 14, padding: 12, border: "1px dashed #D9D5E2", borderRadius: 10, background: "#FBFAFC" }}>
            <div style={{ fontSize: 12.5, fontWeight: 700, color: "#54506B", display: "inline-flex", alignItems: "center", gap: 6, marginBottom: 8 }}><ImageIcon size={14} /> BACKGROUND IMAGE</div>
            <p style={{ fontSize: 12, color: "#6A7178", marginTop: 0, marginBottom: 8 }}>Add a photo behind your text — your text stays readable over it. Optional.</p>
            <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ ...S.ghostBtn, marginTop: 0, cursor: "pointer", display: "inline-flex" }}><Upload size={15} /> Upload image<input type="file" accept="image/*" onChange={onUploadBg} style={{ display: "none" }} /></label>
              {bg && <label style={{ fontSize: 12.5, color: "#3A4750", display: "inline-flex", alignItems: "center", gap: 6 }}><input type="checkbox" checked={useBg} onChange={(e) => setUseBg(e.target.checked)} /> use it</label>}
              {bg && <button style={{ ...S.ghostBtn, marginTop: 0, padding: "5px 9px", fontSize: 12, color: "#B11E2A", borderColor: "#E4C7CB" }} onClick={() => { setBg(null); setUseBg(false); }}><X size={13} /> Remove</button>}
            </div>
            <div style={{ marginTop: 10, paddingTop: 10, borderTop: "1px solid #ECEAF1" }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: "#7A7488", display: "inline-flex", alignItems: "center", gap: 6 }}><Wand2 size={13} /> Or generate one with AI <span style={{ fontSize: 10, background: "#EDEBF2", color: "#7A7488", padding: "1px 6px", borderRadius: 999 }}>BETA</span></div>
                <button style={{ ...S.ghostBtn, marginTop: 0, padding: "5px 10px", fontSize: 12 }} onClick={() => setAiOpen((v) => !v)}>{aiOpen ? "Hide" : "Try it"}</button>
              </div>
              {aiOpen && <div style={{ marginTop: 10 }}>
                <p style={{ fontSize: 12, color: "#6A7178", marginTop: 0, marginBottom: 8 }}>Needs an image-provider key set up in the app; each image costs money on the provider's side.</p>
                <textarea style={{ ...S.input, minHeight: 54, resize: "vertical", fontFamily: "inherit" }} value={aiPrompt} onChange={(e) => setAiPrompt(e.target.value)} />
                <div style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 8, flexWrap: "wrap" }}>
                  <button style={{ ...S.primaryBtn, marginTop: 0, opacity: aiLoading ? 0.7 : 1 }} onClick={genAI} disabled={aiLoading}>{aiLoading ? <><Loader2 size={15} className="spin" /> Generating…</> : <><Wand2 size={15} /> Generate</>}</button>
                </div>
                {aiErr && <div style={{ ...S.errBox, marginTop: 8 }}>{aiErr}</div>}
              </div>}
            </div>
          </div>
        </div>
        <div style={{ width: 300, maxWidth: "100%" }}>
          <div style={{ display: "flex", justifyContent: "center", background: "#F4F3F7", borderRadius: 12, border: "1px solid #E7E5EE", padding: 10 }}>
            <img src={dataUrl} alt="graphic preview" style={{ maxWidth: "100%", maxHeight: 420, borderRadius: 6, display: "block" }} />
          </div>
          <button style={{ ...S.primaryBtn, marginTop: 10, width: "100%", justifyContent: "center" }} onClick={download}><Download size={16} /> Download {size.w}×{size.h} PNG</button>
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
const DUTYLOG_SEED = [
  { id: 1, what: "Refilled air bottles, logged 6", who: "Tom Daniels", when: "Jun 22" },
  { id: 2, what: "Washed Engine 1, restocked EMS bags", who: "Cody Pearson", when: "Jun 21" },
  { id: 3, what: "Posted open-house recap", who: "Dana Cole", when: "Jun 20" },
];
function StationDuties({ S, role, members, meId, notify }) {
  const canManage = isLeader(role); // board members + officers + admins assign duties
  const canCreate = ["Board Member", "Department Admin", "Training Officer"].includes(role); // matches create_duty's DB gate (excludes Project Admin)
  const me = members.find((m) => m.id === meId);
  const nameById = new Map(members.map((m) => [m.id, m.name]));
  const fmtDoneAt = (v) => {
    if (!v) return "";
    const d = new Date(v);
    return isNaN(d.getTime()) ? v : d.toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" });
  };
  const [duties, setDuties] = useState([]);
  const [log, setLog] = useState(DUTYLOG_SEED);
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
  function removeDuty(id) { setDuties((ds) => ds.filter((x) => x.id !== id)); }
  function addLog() { if (!lw.trim()) return; setLog((l) => [{ id: Date.now(), what: lw.trim(), who: lwho.trim() || "A member", when: "Just now" }, ...l]); setLw(""); }
  function removeLog(id) { setLog((l) => l.filter((x) => x.id !== id)); }
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
          <label style={{ ...S.field, minWidth: 160 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Assign to</span><select style={FS.input} value={assignee} onChange={(e) => setAssignee(e.target.value)}><option value="">Station-wide (everyone)</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
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
                  {canManage && <button title="Remove" style={{ ...FS.btn, padding: "6px 8px" }} onClick={() => removeDuty(a.id)}><X size={14} color={FIRE.deleteRed} /></button>}
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
                        {members.filter((m) => m.id !== me?.id).map((m) => {
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
        <label style={{ ...S.field, minWidth: 150 }}><span style={{ ...S.fieldLabel, color: FIRE.textSecondary }}>Who</span><input style={FS.input} value={lwho} onChange={(e) => setLwho(e.target.value)} list="dutymembers2" /><datalist id="dutymembers2">{members.map((m) => <option key={m.id} value={m.name} />)}</datalist></label>
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
      <PageHead S={S} eyebrow="CONTENT ADMIN" title="Publish a packet" sub="Platform admins add monthly materials. New packets appear in the library immediately." />
      <div style={S.formCard}>
        <label style={S.field}><span style={S.fieldLabel}>Packet title</span><input style={S.input} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Tanker Shuttle Operations" /></label>
        <div style={S.twoColForm}>
          <label style={S.field}><span style={S.fieldLabel}>Track</span><select style={S.input} value={track} onChange={(e) => setTrack(e.target.value)}>{Object.keys(TRACKS).map((k) => <option key={k}>{k}</option>)}</select></label>
          <label style={S.field}><span style={S.fieldLabel}>Estimated time</span><input style={S.input} value={time} onChange={(e) => setTime(e.target.value)} /></label>
        </div>
        <label style={S.field}><span style={S.fieldLabel}>Objective</span><textarea style={{ ...S.input, minHeight: 66, resize: "vertical" }} value={objective} onChange={(e) => setObjective(e.target.value)} /></label>
        <button style={S.primaryBtn} onClick={publish}><Plus size={16} /> Publish to library</button>
        {done && <div style={S.successBox}><CheckCircle2 size={16} /> Published. Check the Training Library.</div>}
      </div>

      <div style={{ marginTop: 26 }}>
        <div style={S.cardEyebrow}><MessageSquare size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />FIELD SIGNAL · WHAT WE'RE LEARNING</div>
        <p style={{ ...S.pageSub, marginTop: 0, marginBottom: 14 }}>Ratings and critiques from departments on AI-generated plans. Review monthly, spot the patterns, and turn them into sharper prompt rules and better packets — that's how the system improves.</p>
        {(!feedback || feedback.length === 0) ? (
          <div style={S.empty}>No feedback yet. Generate a plan in the AI Training Assistant, rate it, and it'll show up here.</div>
        ) : (
          feedback.map((f, i) => (
            <div key={i} style={S.fbItem}>
              <span style={{ ...S.fbDot, background: f.rating === "up" ? "#2E7D52" : (f.rating === "down" ? "#B11E2A" : "#9AA1A9") }} />
              <div style={{ flex: 1 }}>
                <div style={S.fbItemTop}><strong>{f.topic}</strong>{f.edited && <span style={S.fbEdited}>EDITED</span>}</div>
                {f.tags && f.tags.length > 0 && <div style={S.fbItemTags}>{f.tags.join(" · ")}</div>}
                {f.notes && <div style={S.fbItemNotes}>"{f.notes}"</div>}
              </div>
              <span style={S.reqWhen}>{f.when}</span>
            </div>
          ))
        )}
      </div>
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
        .dr-side { position: fixed; left: -290px; transition: left .22s ease; z-index: 40; height: 100%; }
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
    app: { display: "flex", minHeight: "100vh", background: FIRE.pageBg, fontFamily: body, color: INK },
    scrim: { position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 35 },
    sidebar: { width: 262, background: FIRE.sidebar, color: "#E8E9EB", display: "flex", flexDirection: "column", padding: 18, flexShrink: 0 },
    brandRow: { display: "flex", alignItems: "center", gap: 11, paddingBottom: 18, borderBottom: "1px solid #2A2F35" },
    brandName: { fontFamily: display, fontWeight: 700, fontSize: 19, letterSpacing: ".5px", lineHeight: 1 },
    brandSub: { fontSize: 10, color: "#8A929B", letterSpacing: ".9px", marginTop: 3, fontFamily: mono },
    nav: { display: "flex", flexDirection: "column", gap: 3, marginTop: 18, flex: 1 },
    navItem: { display: "flex", alignItems: "center", gap: 11, padding: "11px 12px", borderRadius: 8, border: "none", background: "transparent", color: "#C3C8CE", fontSize: 14, fontFamily: body, cursor: "pointer", fontWeight: 500 },
    navItemActive: { background: "#262B31", color: "#fff", boxShadow: "inset 3px 0 0 #B11E2A" },
    premiumTag: { fontSize: 9, fontFamily: mono, background: "#54506B", color: "#fff", padding: "2px 6px", borderRadius: 3, letterSpacing: ".5px" },
    deptCard: { background: "#262B31", borderRadius: 10, padding: 14, marginTop: 12 },
    deptLabel: { fontSize: 9.5, fontFamily: mono, color: "#8A929B", letterSpacing: ".8px" },
    deptName: { fontFamily: display, fontWeight: 600, fontSize: 16, marginTop: 4 },
    deptMeta: { fontSize: 12, color: "#9AA1A9", marginTop: 2 },
    main: { flex: 1, display: "flex", flexDirection: "column", minWidth: 0 },
    topbar: { height: 60, background: FIRE.sidebar, borderBottom: `1px solid ${FIRE.hairline}`, display: "flex", alignItems: "center", gap: 14, padding: "0 18px", position: "sticky", top: 0, zIndex: 20 },
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
