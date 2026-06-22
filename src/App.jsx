import React, { useState, useMemo } from "react";
import {
  Flame, HeartPulse, Search, ShieldAlert, Users, FileText, Download, Plus,
  ChevronRight, Sparkles, ClipboardList, GraduationCap, Megaphone, Landmark,
  Briefcase, AlertTriangle, LogOut, LayoutDashboard, Send, CheckCircle2, Clock,
  Wrench, X, Menu, ArrowLeft, Loader2, Building2, TrendingUp, Calendar, DollarSign,
} from "lucide-react";

/* ------------------------------------------------------------------ */
/*  Working title: THE DAYROOM  (name not final — easy to swap)        */
/*  Volunteer Fire & EMS — Training, Recruitment & Operations          */
/* ------------------------------------------------------------------ */
const APP = "THE DAYROOM";

const ROLES = ["Platform Admin", "Department Admin", "Training Officer", "Member"];

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
  { key: "ai", label: "AI Training Assistant", Icon: Sparkles, roles: ["Platform Admin", "Department Admin", "Training Officer"], premium: true },
  { key: "recruit", label: "Recruitment", Icon: Megaphone, roles: ["Platform Admin", "Department Admin", "Training Officer"] },
  { key: "funding", label: "Visibility & Funding", Icon: DollarSign, roles: ["Platform Admin", "Department Admin", "Training Officer"] },
  { key: "request", label: "Request Custom Training", Icon: Send, roles: ["Platform Admin", "Department Admin", "Training Officer"] },
  { key: "admin", label: "Content Admin", Icon: ShieldAlert, roles: ["Platform Admin"] },
];

/* ================================================================== */
export default function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [role, setRole] = useState("Training Officer");
  const [screen, setScreen] = useState("dashboard");
  const [packetId, setPacketId] = useState(null);
  const [drawer, setDrawer] = useState(false);
  const [library, setLibrary] = useState(SEED);
  const [requests, setRequests] = useState([]);
  const S = baseStyles();

  function go(k) { setScreen(k); setPacketId(null); setDrawer(false); }
  function openPacket(id) { setPacketId(id); setScreen("packet"); setDrawer(false); }
  const visibleNav = NAV.filter((n) => n.roles.includes(role));
  const packet = library.find((p) => p.id === packetId);

  if (!loggedIn) return <Login S={S} role={role} setRole={setRole} onEnter={() => setLoggedIn(true)} />;

  return (
    <div style={S.app}>
      <Fonts />
      {drawer && <div style={S.scrim} onClick={() => setDrawer(false)} />}
      <aside className={`dr-side${drawer ? " open" : ""}`} style={S.sidebar}>
        <div style={S.brandRow}>
          <Logo />
          <div>
            <div style={S.brandName}>{APP}</div>
            <div style={S.brandSub}>WORKING TITLE</div>
          </div>
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
        <div style={S.deptCard}>
          <div style={S.deptLabel}>DEPARTMENT</div>
          <div style={S.deptName}>Cedar Hollow VFD</div>
          <div style={S.deptMeta}>Premium · 14 members</div>
        </div>
      </aside>

      <div style={S.main}>
        <header style={S.topbar}>
          <button className="dr-menu" style={S.menuBtn} onClick={() => setDrawer(true)} aria-label="Open menu"><Menu size={20} /></button>
          <div style={S.chevronBand} />
          <div style={S.viewAs}>
            <span style={S.viewAsLabel}>View as</span>
            <select value={role} onChange={(e) => { setRole(e.target.value); setScreen("dashboard"); }} style={S.select}>
              {ROLES.map((r) => <option key={r}>{r}</option>)}
            </select>
            <button style={S.logout} onClick={() => setLoggedIn(false)} aria-label="Sign out"><LogOut size={16} /></button>
          </div>
        </header>

        <main style={S.content}>
          {screen === "dashboard" && <Dashboard S={S} role={role} library={library} openPacket={openPacket} go={go} />}
          {screen === "library" && <Library S={S} library={library} openPacket={openPacket} />}
          {screen === "packet" && packet && <Packet S={S} packet={packet} back={() => setScreen("library")} />}
          {screen === "ai" && <AIAssistant S={S} />}
          {screen === "recruit" && <Recruitment S={S} />}
          {screen === "funding" && <Funding S={S} />}
          {screen === "request" && <RequestForm S={S} requests={requests} setRequests={setRequests} />}
          {screen === "admin" && <Admin S={S} library={library} setLibrary={setLibrary} />}
        </main>
      </div>
    </div>
  );
}

/* ---------------- Login ---------------- */
function Login({ S, role, setRole, onEnter }) {
  return (
    <div style={S.loginWrap}>
      <Fonts />
      <div style={S.loginChevron} />
      <div style={S.loginCard}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 6 }}>
          <Logo /><div style={S.brandNameLg}>{APP}</div>
        </div>
        <p style={S.loginTag}>Training, recruitment, and operations support for volunteer fire and EMS — built by people who've stood in the bay.</p>
        <label style={S.field}><span style={S.fieldLabel}>Department email</span><input style={S.input} defaultValue="to@cedarhollowvfd.org" /></label>
        <label style={S.field}><span style={S.fieldLabel}>Password</span><input style={S.input} type="password" defaultValue="demo" /></label>
        <label style={S.field}><span style={S.fieldLabel}>Sign in as (demo)</span>
          <select style={S.input} value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</select>
        </label>
        <button style={S.primaryBtn} onClick={onEnter}>Sign in</button>
        <p style={S.loginNote}>Prototype — any credentials work. Switch roles anytime with "View as."</p>
      </div>
    </div>
  );
}

/* ---------------- Dashboard ---------------- */
function Dashboard({ S, role, library, openPacket, go }) {
  const featured = library.find((p) => p.id === "fire-118");
  const sorted = [...ROADMAP].sort((a, b) => (b.months - b.target) - (a.months - a.target));
  const next = sorted[0];
  const firstName = role === "Member" ? "Firefighter" : "Chief";
  return (
    <div>
      <PageHead S={S} eyebrow="THIS WATCH" title={`Good morning, ${firstName}.`} sub="Here's where your crew stands this month." />

      <div style={S.statRow}>
        <Stat S={S} n="6" label="Topics tracked" />
        <Stat S={S} n="2" label="Overdue for training" warn />
        <Stat S={S} n="9" label="Packets in library" />
        <Stat S={S} n="14" label="Active members" />
      </div>

      {/* Training roadmap — department memory / gap detection */}
      <div style={S.roadCard}>
        <div style={S.roadHead}>
          <div><div style={S.cardEyebrow}><TrendingUp size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />TRAINING ROADMAP</div>
            <h3 style={S.roadTitle}>What your crew hasn't trained lately</h3></div>
        </div>
        <div style={S.roadRecommend}>
          <Sparkles size={16} color="#E0A100" />
          <span>Recommended next: <strong>{next.topic}</strong> — last trained {next.months} months ago.</span>
        </div>
        <div style={S.roadList}>
          {sorted.map((r) => {
            const st = statusOf(r.months, r.target); const T = TRACKS[r.track];
            return (
              <div key={r.topic} style={S.roadRow}>
                <T.Icon size={15} color={T.accent} style={{ flexShrink: 0 }} />
                <span style={S.roadTopic}>{r.topic}</span>
                <span style={S.roadAgo}>{r.months} mo ago</span>
                <span style={{ ...S.roadChip, color: st.color, borderColor: `${st.color}55`, background: `${st.color}12` }}>{st.label}</span>
              </div>
            );
          })}
        </div>
      </div>

      <QuickAccess S={S} role={role} go={go} />

      <div style={S.dashGrid}>
        <div style={S.featCard}>
          <div style={S.featStripe} />
          <div style={S.featInner}>
            <div style={S.cardEyebrow}>BUILD THIS WEEK</div>
            <h3 style={S.featTitle}>{featured.title}</h3>
            <p style={S.featObj}>{featured.objective}</p>
            <div style={S.metaRow}><Meta Icon={Clock} text={featured.time} /><Meta Icon={Users} text={featured.level} /><TrackPill S={S} track={featured.track} /></div>
            <button style={S.primaryBtn} onClick={() => openPacket(featured.id)}>Open packet <ChevronRight size={16} /></button>
          </div>
        </div>
        <div style={S.logCard}>
          <div style={S.cardEyebrow}>STATION LOG</div>
          {ACTIVITY.map((a, i) => (
            <div key={i} style={S.logRow}><span style={S.logTime}>{a.when}</span>
              <span style={S.logText}><strong>{a.who}</strong> {a.action} <span style={S.logCode}>{a.code}</span></span></div>
          ))}
          <button style={S.ghostBtn} onClick={() => go("ai")}><Sparkles size={15} /> Draft a drill with AI</button>
        </div>
      </div>
    </div>
  );
}

/* ---------------- Quick access (home page doorways) ---------------- */
const QUICK = {
  library: { accent: "#1F4E79", blurb: "Ready-to-run packets for Fire, EMS, Leadership & Operations." },
  ai:      { accent: "#54506B", blurb: "Describe your crew — get a full drill plan in seconds." },
  recruit: { accent: "#0E6B62", blurb: "A 90-day plan, ready-to-send templates, and a printable flyer." },
  funding: { accent: "#9A6B12", blurb: "Content calendar, sponsor packages, and fundraising tools." },
  request: { accent: "#3A4750", blurb: "Tell us what your crew needs; we build it into the next drop." },
  admin:   { accent: "#B11E2A", blurb: "Publish new monthly materials to the library." },
};
function QuickAccess({ S, role, go }) {
  const items = NAV.filter((n) => n.key !== "dashboard" && n.roles.includes(role));
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={S.cardEyebrow}>EXPLORE THE PLATFORM</div>
      <div style={S.quickGrid}>
        {items.map((n) => {
          const q = QUICK[n.key] || {};
          return (
            <button key={n.key} style={S.quickCard} onClick={() => go(n.key)}>
              <span style={{ ...S.quickIcon, background: q.accent }}><n.Icon size={18} color="#fff" /></span>
              <div style={{ flex: 1 }}>
                <div style={S.quickTitle}>{n.label}{n.premium && <span style={S.quickAi}>AI</span>}</div>
                <div style={S.quickBlurb}>{q.blurb}</div>
              </div>
              <ChevronRight size={16} color="#9AA1A9" style={{ flexShrink: 0, alignSelf: "center" }} />
            </button>
          );
        })}
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
    <div>
      <PageHead S={S} eyebrow="TRAINING LIBRARY" title="Find a packet" sub="Search by topic or filter by track. Every packet is ready to run tonight." />
      <div style={S.searchBox}>
        <Search size={18} color="#6A7178" />
        <input style={S.searchInput} placeholder="Search packets (e.g. stroke, mayday, budget)…" value={q} onChange={(e) => setQ(e.target.value)} />
        {q && <button style={S.clearBtn} onClick={() => setQ("")}><X size={15} /></button>}
      </div>
      <div style={S.chipRow}>
        <Chip S={S} active={track === "All"} onClick={() => setTrack("All")}>All</Chip>
        {Object.keys(TRACKS).map((k) => <Chip key={k} S={S} active={track === k} accent={TRACKS[k].accent} onClick={() => setTrack(k)}>{TRACKS[k].label}</Chip>)}
      </div>
      {results.length === 0 ? (
        <div style={S.empty}>No packets match that yet. Try a broader term, or request a custom packet from the menu.</div>
      ) : (
        <div style={S.cardGrid}>{results.map((p) => <RunCard key={p.id} S={S} p={p} onClick={() => openPacket(p.id)} />)}</div>
      )}
    </div>
  );
}
function RunCard({ S, p, onClick }) {
  const T = TRACKS[p.track];
  return (
    <button style={{ ...S.runCard, borderLeft: `4px solid ${T.accent}` }} onClick={onClick}>
      <div style={S.runTop}><span style={{ ...S.runCode, color: T.accent }}>{p.code}</span><T.Icon size={16} color={T.accent} /></div>
      <h3 style={S.runTitle}>{p.title}</h3>
      <p style={S.runObj}>{p.objective}</p>
      <div style={S.runFoot}><span><Clock size={13} /> {p.time}</span><span style={S.runUpdated}>Updated {p.updated}</span></div>
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

/* ---------------- AI Training Assistant ---------------- */
function AIAssistant({ S }) {
  const [form, setForm] = useState({ size: "12", apparatus: "1 engine, 1 brush truck", topic: "Search and rescue", level: "Intermediate", time: "90", history: "Have not trained on search & rescue in 6 months." });
  const [loading, setLoading] = useState(false); const [err, setErr] = useState(""); const [plan, setPlan] = useState(null);
  const up = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  async function generate() {
    setLoading(true); setErr(""); setPlan(null);
    const sys = "You are an experienced volunteer fire/EMS training officer drafting a SAFE, practical drill plan. You are NOT a substitute for certified instruction, medical direction, or the AHJ. Defer to local protocols, state requirements, and medical direction. For any high-risk evolution (live fire, hazmat, technical rescue, invasive medical skills), note in safetyNotes that it requires a qualified instructor and assigned safety officer plus authorization. Respond with ONLY one valid JSON object, no markdown, no code fences. Schema: {\"summary\":string,\"durationMin\":number,\"equipment\":string[],\"safetyNotes\":string[],\"steps\":[{\"title\":string,\"detail\":string,\"minutes\":number}],\"talkingPoints\":string[],\"debriefQuestions\":string[],\"evaluationChecklist\":string[]}. Keep arrays to 3-6 concise items. Realistic for the stated staffing and apparatus.";
    const user = `Department size: ${form.size} members\nApparatus/equipment: ${form.apparatus}\nTopic: ${form.topic}\nSkill level: ${form.level}\nTime: ${form.time} minutes\nRecent history: ${form.history}`;
    try {
      let t = (await callClaude(sys, user)).replace(/```json|```/g, "").trim();
      let parsed; try { parsed = JSON.parse(t); } catch { const m = t.match(/\{[\s\S]*\}/); parsed = m ? JSON.parse(m[0]) : null; }
      if (!parsed) throw new Error("parse"); setPlan(parsed);
    } catch { setErr("Couldn't generate a plan just now. Check the connection and try again."); } finally { setLoading(false); }
  }
  return (
    <div>
      <PageHead S={S} eyebrow="AI TRAINING ASSISTANT" title="Draft a drill plan" sub="Describe your crew and constraints. You'll get a starting plan to adapt — then review it against your protocols." />
      <div style={S.aiGrid}>
        <div style={S.aiForm}>
          <AIField S={S} label="Department size (members)" value={form.size} onChange={(v) => up("size", v)} />
          <AIField S={S} label="Available apparatus / equipment" value={form.apparatus} onChange={(v) => up("apparatus", v)} />
          <AIField S={S} label="Training topic" value={form.topic} onChange={(v) => up("topic", v)} />
          <label style={S.field}><span style={S.fieldLabel}>Skill level</span>
            <select style={S.input} value={form.level} onChange={(e) => up("level", e.target.value)}><option>New / probationary</option><option>Intermediate</option><option>Experienced</option><option>Mixed</option></select></label>
          <AIField S={S} label="Time available (minutes)" value={form.time} onChange={(v) => up("time", v)} />
          <label style={S.field}><span style={S.fieldLabel}>Recent training history</span>
            <textarea style={{ ...S.input, minHeight: 66, resize: "vertical" }} value={form.history} onChange={(e) => up("history", e.target.value)} /></label>
          <button style={{ ...S.primaryBtn, width: "100%", justifyContent: "center", opacity: loading ? 0.7 : 1 }} onClick={generate} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Drafting…</> : <><Sparkles size={16} /> Generate drill plan</>}
          </button>
          {err && <div style={S.errBox}>{err}</div>}
        </div>
        <div style={S.aiResult}>
          {!plan && !loading && <div style={S.aiPlaceholder}><Sparkles size={28} color="#54506B" /><p>Your drafted plan appears here. It's a starting point — a real training officer should review and adapt it before use.</p></div>}
          {loading && <div style={S.aiPlaceholder}><Loader2 size={28} className="spin" color="#54506B" /><p>Drafting a plan for {form.size} members, {form.time} minutes…</p></div>}
          {plan && (
            <div>
              <Disclaimer S={S} compact />
              <h3 style={S.featTitle}>{form.topic}</h3>
              <p style={S.body}>{plan.summary}</p>
              {plan.durationMin ? <div style={S.metaRow}><Meta Icon={Clock} text={`${plan.durationMin} min`} /></div> : null}
              <AIList S={S} Icon={ShieldAlert} title="Safety notes" items={plan.safetyNotes} warn />
              <AIList S={S} Icon={Wrench} title="Equipment" items={plan.equipment} />
              {Array.isArray(plan.steps) && (
                <div style={{ marginTop: 16 }}><div style={S.aiListHead}><FileText size={16} /> Drill steps</div>
                  <div style={S.steps}>{plan.steps.map((s, i) => (
                    <div key={i} style={S.step}><span style={S.stepNum}>{String(i + 1).padStart(2, "0")}</span>
                      <div style={{ flex: 1 }}><div style={S.stepTitle}>{s.title} {s.minutes ? <span style={S.stepMin}>{s.minutes} min</span> : null}</div><div style={S.stepDetail}>{s.detail}</div></div></div>
                  ))}</div></div>
              )}
              <AIList S={S} Icon={Megaphone} title="Instructor talking points" items={plan.talkingPoints} />
              <AIList S={S} Icon={ClipboardList} title="Debrief questions" items={plan.debriefQuestions} />
              <AIList S={S} Icon={CheckCircle2} title="Evaluation checklist" items={plan.evaluationChecklist} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
function AIField({ S, label, value, onChange }) {
  return <label style={S.field}><span style={S.fieldLabel}>{label}</span><input style={S.input} value={value} onChange={(e) => onChange(e.target.value)} /></label>;
}
function AIList({ S, Icon, title, items, warn }) {
  if (!Array.isArray(items) || items.length === 0) return null;
  return (
    <div style={{ marginTop: 16 }}>
      <div style={{ ...S.aiListHead, color: warn ? "#8A1620" : "#191C20" }}><Icon size={16} /> {title}</div>
      <ul style={S.list}>{items.map((it, i) => <li key={i}>{it}</li>)}</ul>
    </div>
  );
}

/* ---------------- Recruitment ---------------- */
function Recruitment({ S }) {
  const [town, setTown] = useState("Cedar Hollow");
  const [need, setNeed] = useState("We need a few younger volunteers and people who can run daytime calls.");
  const [loading, setLoading] = useState(false); const [post, setPost] = useState(""); const [err, setErr] = useState("");
  async function draft() {
    setLoading(true); setErr(""); setPost("");
    const sys = "You write warm, honest recruitment social posts for a volunteer fire/EMS department. Lead with purpose and 'we train you,' name the real objection, keep it under 80 words, plain and genuine — never desperate or guilt-tripping. Return only the post text.";
    try { const t = await callClaude(sys, `Town: ${town}\nWhat the department needs: ${need}`); setPost(t); }
    catch { setErr("Couldn't draft a post just now. Try again in a moment."); } finally { setLoading(false); }
  }
  return (
    <div>
      <PageHead S={S} eyebrow="RECRUITMENT" title="The hardest problem, handed to you ready to use" sub="A 90-day plan, ready-to-send templates, a printable flyer — and an assistant that tailors them to your town." />
      <div style={S.phaseRow}>
        <Phase S={S} n="01" weeks="Weeks 1–4" title="Foundation" items={["Assign a recruitment lead", "Define who you're looking for", "Stand up a simple interest form", "Set a 90-day target"]} accent="#B11E2A" />
        <Phase S={S} n="02" weeks="Weeks 5–8" title="Outreach" items={["Launch social posts", "Run a 'bring a friend' drive", "Employer + school outreach", "Pick an open-house date"]} accent="#1F4E79" />
        <Phase S={S} n="03" weeks="Weeks 9–12" title="Convert" items={["Host the open house", "Follow up within 48 hours", "Move them through onboarding", "Assign a buddy / mentor"]} accent="#0E6B62" />
      </div>

      <div style={S.aiBanner}>
        <div style={{ flex: 1 }}>
          <div style={S.cardEyebrow}><Sparkles size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />AI RECRUITMENT ASSISTANT</div>
          <h3 style={S.featTitle}>Draft a recruitment post for your town</h3>
          <div style={S.twoColForm}>
            <AIField S={S} label="Your town" value={town} onChange={setTown} />
            <label style={S.field}><span style={S.fieldLabel}>What you need</span>
              <textarea style={{ ...S.input, minHeight: 44, resize: "vertical" }} value={need} onChange={(e) => setNeed(e.target.value)} /></label>
          </div>
          <button style={{ ...S.primaryBtn, opacity: loading ? 0.7 : 1 }} onClick={draft} disabled={loading}>
            {loading ? <><Loader2 size={16} className="spin" /> Writing…</> : <><Sparkles size={16} /> Draft a post</>}
          </button>
          {err && <div style={S.errBox}>{err}</div>}
          {post && <div style={S.postOut}>{post}</div>}
        </div>
      </div>

      <div style={S.cardEyebrow}>INCLUDED IN THE TOOLKIT</div>
      <div style={S.toolGrid}>
        {["90-day recruitment plan", "Social post templates", "Member-referral scripts", "Employer & school outreach emails", "Printable recruitment flyer", "Open-house checklist & funnel tracker"].map((t) => (
          <div key={t} style={S.toolItem}><CheckCircle2 size={15} color="#0E6B62" /> <span>{t}</span></div>
        ))}
      </div>
    </div>
  );
}
function Phase({ S, n, weeks, title, items, accent }) {
  return (
    <div style={{ ...S.phaseCard, borderTop: `3px solid ${accent}` }}>
      <div style={S.phaseTop}><span style={{ ...S.phaseNum, color: accent }}>{n}</span><span style={S.phaseWeeks}>{weeks}</span></div>
      <div style={S.phaseTitle}>{title}</div>
      <ul style={S.phaseList}>{items.map((i) => <li key={i}>{i}</li>)}</ul>
    </div>
  );
}

/* ---------------- Funding ---------------- */
function Funding({ S }) {
  const cal = [
    { wk: "Week 1", tag: "PEOPLE", c: "#B11E2A", t: "Member spotlight — why they serve" },
    { wk: "Week 2", tag: "COMMUNITY", c: "#0E6B62", t: "Seasonal safety tip" },
    { wk: "Week 3", tag: "THE ASK", c: "#9A6B12", t: "Fundraiser promo + link" },
    { wk: "Week 4", tag: "BEHIND SCENES", c: "#1F4E79", t: "Training night photo" },
  ];
  const tiers = [
    { name: "Supporter", price: "$250", items: ["Name on website", "Social thank-you", "Window decal"] },
    { name: "Partner", price: "$1,000", items: ["Banner at events", "Logo on website", "Quarterly shout-outs"], mid: true },
    { name: "Champion", price: "$2,500", items: ["Event sponsor", "Apparatus signage", "Annual recognition"] },
  ];
  return (
    <div>
      <PageHead S={S} eyebrow="VISIBILITY & FUNDING" title="Get seen. Get funded. Get staffed." sub="The same 20 minutes a week of showing your work feeds recruitment and funding both." />
      <div style={S.cardEyebrow}><Calendar size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />MONTHLY CONTENT CALENDAR</div>
      <div style={S.calGrid}>
        {cal.map((c) => (
          <div key={c.wk} style={S.calCard}><div style={S.calWk}>{c.wk}</div>
            <span style={{ ...S.calTag, background: c.c }}>{c.tag}</span><div style={S.calText}>{c.t}</div></div>
        ))}
      </div>
      <div style={S.cardEyebrow}><DollarSign size={13} style={{ marginRight: 5, verticalAlign: "-2px" }} />SPONSOR PACKAGES</div>
      <div style={S.tierRow}>
        {tiers.map((t) => (
          <div key={t.name} style={{ ...S.tier, ...(t.mid ? S.tierMid : {}) }}>
            <div style={S.tierName}>{t.name}</div><div style={S.tierPrice}>{t.price}<span style={S.tierYr}>/yr</span></div>
            <ul style={S.tierList}>{t.items.map((i) => <li key={i}>{i}</li>)}</ul>
          </div>
        ))}
      </div>
      <div style={S.cardEyebrow}>ALSO INCLUDED</div>
      <div style={S.toolGrid}>
        {["Fundraising idea menu", "Donor & business outreach templates", "Recruitment campaign calendar", "Fundraising plan & tracker"].map((t) => (
          <div key={t} style={S.toolItem}><CheckCircle2 size={15} color="#0E6B62" /> <span>{t}</span></div>
        ))}
      </div>
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
    <div>
      <PageHead S={S} eyebrow="CUSTOM TRAINING" title="Request a custom packet" sub="Tell us what your crew needs. We build it into the next monthly drop." />
      <div style={S.formCard}>
        <label style={S.field}><span style={S.fieldLabel}>Topic or scenario</span><input style={S.input} placeholder="e.g. Rural water shuttle with one tender" value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
        <label style={S.field}><span style={S.fieldLabel}>Anything specific to your department?</span><textarea style={{ ...S.input, minHeight: 88, resize: "vertical" }} placeholder="Apparatus, member count, local hazards, constraints…" value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
        <button style={S.primaryBtn} onClick={submit}><Send size={16} /> Submit request</button>
        {done && <div style={S.successBox}><CheckCircle2 size={16} /> Request received. We'll confirm by email.</div>}
      </div>
      {requests.length > 0 && (
        <div style={{ marginTop: 24 }}><div style={S.cardEyebrow}>YOUR REQUESTS</div>
          {requests.map((r, i) => <div key={i} style={S.reqRow}><div><strong>{r.topic}</strong>{r.notes ? <div style={S.reqNotes}>{r.notes}</div> : null}</div><span style={S.reqWhen}>{r.when}</span></div>)}
        </div>
      )}
    </div>
  );
}

/* ---------------- Admin ---------------- */
function Admin({ S, library, setLibrary }) {
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
    </div>
  );
}

/* ---------------- shared bits ---------------- */
function PageHead({ S, eyebrow, title, sub }) {
  return <div style={S.pageHead}><div style={S.cardEyebrow}>{eyebrow}</div><h1 style={S.pageTitle}>{title}</h1>{sub && <p style={S.pageSub}>{sub}</p>}</div>;
}
function Stat({ S, n, label, warn }) {
  return <div style={S.stat}><div style={{ ...S.statN, color: warn ? "#B11E2A" : "#191C20" }}>{n}</div><div style={S.statLabel}>{label}</div></div>;
}
function Meta({ Icon, text }) {
  return <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 13, color: "#6A7178" }}><Icon size={14} /> {text}</span>;
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
function Disclaimer({ S, compact }) {
  return <div style={{ ...S.disclaimer, ...(compact ? { marginTop: 0 } : {}) }}><AlertTriangle size={16} style={{ flexShrink: 0, marginTop: 1 }} /><span>{DISCLAIMER}</span></div>;
}
function Logo() {
  return <div style={{ width: 38, height: 38, borderRadius: 8, background: "#191C20", display: "grid", placeItems: "center", flexShrink: 0, border: "1.5px solid #B11E2A" }}><Flame size={20} color="#B11E2A" /></div>;
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
    app: { display: "flex", minHeight: "100vh", background: PAPER, fontFamily: body, color: INK },
    scrim: { position: "fixed", inset: 0, background: "rgba(0,0,0,.4)", zIndex: 35 },
    sidebar: { width: 262, background: INK, color: "#E8E9EB", display: "flex", flexDirection: "column", padding: 18, flexShrink: 0 },
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
    topbar: { height: 60, background: CARD, borderBottom: `1px solid ${LINE}`, display: "flex", alignItems: "center", gap: 14, padding: "0 18px", position: "sticky", top: 0, zIndex: 20 },
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
