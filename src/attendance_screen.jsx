// =====================================================================
// PASTE THIS INTO App.jsx
// 1. Add to imports at top:
//    import { QRCodeCanvas } from "qrcode.react";
// 2. Add to package.json deps (Claude Code: npm install qrcode.react):
//    "qrcode.react": "^3.1.0"
// 3. Replace <ComingSoon label="Meeting Attendance" /> in renderScreen()
//    with: <MeetingAttendance me={me} />
// 4. Run attendance.sql in Supabase SQL Editor first.
// =====================================================================

// ---- Data helpers (add alongside other async functions in App.jsx) ----

async function listEvents() {
  const { data, error } = await supabase
    .from("events")
    .select("*, event_attendance(member_id, checked_in_at)")
    .order("event_date", { ascending: true });
  if (error) throw error;
  return data || [];
}

async function createEvent(row) {
  const { data, error } = await supabase.from("events").insert(row).select().single();
  if (error) throw error;
  return data;
}

async function openSignin(eventId) {
  const { data, error } = await supabase.rpc("open_signin", { p_event: eventId });
  if (error) throw error;
  return data; // the 6-char token
}

async function closeSignin(eventId) {
  const { error } = await supabase.rpc("close_signin", { p_event: eventId });
  if (error) throw error;
}

async function memberCheckIn(eventId, token) {
  const { data, error } = await supabase.rpc("member_check_in", {
    p_event: eventId,
    p_token: token,
  });
  if (error) throw error;
  return data; // { ok, already, reason, member_id }
}

async function completeEvent(eventId) {
  const { data, error } = await supabase.rpc("complete_event", { p_event: eventId });
  if (error) throw error;
  return data;
}

async function toggleManualAttend(eventId, memberId, deptId, present) {
  if (present) {
    const { error } = await supabase
      .from("event_attendance")
      .delete()
      .eq("event_id", eventId)
      .eq("member_id", memberId);
    if (error) throw error;
  } else {
    const { error } = await supabase.from("event_attendance").insert({
      department_id: deptId,
      event_id: eventId,
      member_id: memberId,
      checked_in_at: new Date().toISOString(),
    });
    if (error) throw error;
  }
}

// ---- Calendar helpers ----
const MONTHS = ["January","February","March","April","May","June",
                "July","August","September","October","November","December"];
const DOW    = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"];
const KIND_COLOR = {
  meeting:   "#9B6BE6",
  board:     "#5a3f8c",
  training:  "#46C793",
  community: "#F0B44A",
  general:   "#57B6E0",
  other:     "#7A7296",
};

// =====================================================================
// MEETING ATTENDANCE SCREEN
// =====================================================================
function MeetingAttendance({ me }) {
  const today      = new Date();
  const [cur, setCur]             = useState({ y: today.getFullYear(), m: today.getMonth() });
  const [events, setEvents]       = useState(null);
  const [members, setMembers]     = useState([]);
  const [detail, setDetail]       = useState(null);   // selected event
  const [adding, setAdding]       = useState(false);
  const [signinTokens, setSigninTokens] = useState({}); // eventId -> live token
  const [err, setErr]             = useState("");
  const [busy, setBusy]           = useState(false);
  const [newEvt, setNewEvt]       = useState({
    title: "", kind: "meeting", event_date: "", event_time: "", location: "", notes: "",
  });

  async function load() {
    const [evts, mems] = await Promise.all([listEvents(), listMembers()]);
    setEvents(evts);
    setMembers(mems);
    // re-sync detail if open
    if (detail) setDetail(evts.find(e => e.id === detail.id) || null);
  }
  useEffect(() => { load(); }, []);

  // ---- QR check-in capture on URL params (mirrors fire) ----
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    const eid = p.get("checkin");
    const tok = p.get("t");
    if (!eid || !tok) return;
    // strip params from URL without reload
    window.history.replaceState({}, "", window.location.pathname);
    memberCheckIn(eid, tok).then(res => {
      if (res.ok) {
        setErr(res.already ? "✓ Already checked in." : "✓ Checked in!");
      } else {
        setErr("Check-in failed: " + (res.reason || "unknown error"));
      }
      load();
    }).catch(e => setErr("Check-in error: " + e.message));
  }, []);

  const checkinURL = (eventId, token) =>
    `${window.location.origin}${window.location.pathname}?checkin=${eventId}&t=${token}`;

  async function doOpenSignin(evt) {
    setErr("");
    try {
      const tok = await openSignin(evt.id);
      setSigninTokens(t => ({ ...t, [evt.id]: tok }));
      await load();
    } catch (e) { setErr(e.message); }
  }

  async function doCloseSignin(evt) {
    setErr("");
    try {
      await closeSignin(evt.id);
      setSigninTokens(t => { const n = { ...t }; delete n[evt.id]; return n; });
      await load();
    } catch (e) { setErr(e.message); }
  }

  async function doComplete(evt) {
    if (!confirm(`Mark "${evt.title}" as done? This locks attendance.`)) return;
    setBusy(true); setErr("");
    try { await completeEvent(evt.id); await load(); setDetail(null); }
    catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  async function doToggle(evt, memberId) {
    const present = (evt.event_attendance || []).some(a => a.member_id === memberId);
    try {
      await toggleManualAttend(evt.id, memberId, me.department_id, present);
      await load();
    } catch (e) { setErr(e.message); }
  }

  async function doCreate() {
    if (!newEvt.title.trim() || !newEvt.event_date) { setErr("Title and date are required."); return; }
    setBusy(true); setErr("");
    try {
      await createEvent({
        department_id: me.department_id,
        title: newEvt.title.trim(),
        kind: newEvt.kind,
        event_date: newEvt.event_date,
        event_time: newEvt.event_time || null,
        location: newEvt.location.trim() || null,
        notes: newEvt.notes.trim() || null,
        created_by: me.id,
      });
      setAdding(false);
      setNewEvt({ title: "", kind: "meeting", event_date: "", event_time: "", location: "", notes: "" });
      await load();
    } catch (e) { setErr(e.message); }
    finally { setBusy(false); }
  }

  if (!events) return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 200 }}>
      <Loader2 size={22} color={POA.accent} style={{ animation: "spin 1s linear infinite" }} />
    </div>
  );

  // ---- build calendar grid ----
  const dim      = new Date(cur.y, cur.m + 1, 0).getDate();
  const startDow = new Date(cur.y, cur.m, 1).getDay();
  const cells    = [];
  for (let i = 0; i < startDow; i++) cells.push(null);
  for (let d = 1; d <= dim; d++) cells.push(d);
  while (cells.length % 7) cells.push(null);

  const eventsThisMonth = events.filter(e => {
    const d = new Date(e.event_date + "T12:00:00");
    return d.getFullYear() === cur.y && d.getMonth() === cur.m;
  });
  const byDay = {};
  eventsThisMonth.forEach(e => {
    const d = new Date(e.event_date + "T12:00:00").getDate();
    (byDay[d] = byDay[d] || []).push(e);
  });

  const isToday = d => d && cur.y === today.getFullYear() && cur.m === today.getMonth() && d === today.getDate();

  // ---- detail panel ----
  if (detail) {
    const att       = detail.event_attendance || [];
    const liveToken = signinTokens[detail.id];
    const manage    = canManage(me.access);

    return (
      <div>
        <button onClick={() => { setDetail(null); setErr(""); }}
          style={{ ...PS.btn, marginBottom: 16 }}>
          <ArrowLeft size={13} /> Calendar
        </button>

        {err && <div style={{ background: "rgba(70,199,147,.1)", border: "0.5px solid rgba(70,199,147,.3)", color: POA.greenText, borderRadius: 10, padding: "11px 14px", fontSize: 13, marginBottom: 12 }}>{err}</div>}

        <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 18 }}>
          <div style={{ width: 10, height: 10, borderRadius: "50%", background: KIND_COLOR[detail.kind] || POA.accent, marginTop: 8, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <p style={{ ...PS.kicker, marginBottom: 4 }}>{detail.kind}</p>
            <h2 style={{ fontFamily: "inherit", fontSize: 22, fontWeight: 700, color: POA.textPrimary, margin: "0 0 4px" }}>{detail.title}</h2>
            <div style={{ fontSize: 13, color: POA.textMuted }}>
              {new Date(detail.event_date + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" })}
              {detail.event_time ? ` · ${detail.event_time.slice(0,5)}` : ""}
              {detail.location ? ` · ${detail.location}` : ""}
            </div>
          </div>
          <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 999, background: detail.done ? "rgba(70,199,147,.14)" : POA.accentSoft, color: detail.done ? POA.green : POA.accent }}>
            {detail.done ? "Done" : "Open"}
          </span>
        </div>

        {detail.notes && (
          <div style={{ ...PS.card, padding: "12px 15px", marginBottom: 14, fontSize: 13.5, color: POA.textSecondary, lineHeight: 1.65 }}>
            {detail.notes}
          </div>
        )}

        {/* ---- QR sign-in panel (board only, event not done) ---- */}
        {manage && !detail.done && (
          <div style={{ ...PS.card, padding: "16px 18px", marginBottom: 16 }}>
            <p style={{ ...PS.kicker, marginBottom: 10 }}>QR sign-in</p>
            {!liveToken ? (
              <div>
                <div style={{ fontSize: 13, color: POA.textMuted, marginBottom: 10, lineHeight: 1.55 }}>
                  {detail.signin_open
                    ? <>A sign-in is live for <b style={{ color: POA.textPrimary }}>{detail.title}</b>. Show the code to display the QR (generates a fresh one).</>
                    : <>Open a QR sign-in. Members scan on their own phone — the code records <em>their</em> attendance, not whoever shows the screen.</>}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={PS.btnPrimary} onClick={() => doOpenSignin(detail)}>
                    <QrCode size={15} /> {detail.signin_open ? "Show / refresh code" : "Open sign-in"}
                  </button>
                  {detail.signin_open && (
                    <button style={PS.btn} onClick={() => doCloseSignin(detail)}>
                      <X size={13} color={POA.red} /> Close
                    </button>
                  )}
                </div>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 22, flexWrap: "wrap" }}>
                {/* QR code */}
                <div style={{ textAlign: "center" }}>
                  <div style={{ background: "#fff", padding: 10, borderRadius: 12, display: "inline-block" }}>
                    <QRCodeCanvas value={checkinURL(detail.id, liveToken)} size={180} />
                  </div>
                  <div style={{ marginTop: 8, fontSize: 12, color: POA.textMuted }}>
                    Code: <b style={{ letterSpacing: 3, color: POA.textPrimary, fontFamily: "monospace" }}>{liveToken}</b>
                  </div>
                  <div style={{ display: "flex", gap: 8, justifyContent: "center", marginTop: 10, flexWrap: "wrap" }}>
                    <button style={PS.btn} onClick={() => doOpenSignin(detail)}>
                      <RefreshCw size={13} /> Rotate
                    </button>
                    <button style={PS.btn} onClick={() => doCloseSignin(detail)}>
                      <X size={13} color={POA.red} /> Close
                    </button>
                  </div>
                  <div style={{ fontSize: 11, color: POA.textMuted, marginTop: 8, maxWidth: 200, lineHeight: 1.5 }}>
                    Each event gets its own code. Rotate if it leaks. Scanning records the member's own check-in.
                  </div>
                </div>

                {/* Live signed-in list */}
                <div style={{ flex: 1, minWidth: 200 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: POA.textMuted, letterSpacing: ".08em", marginBottom: 8 }}>
                    SIGNED IN ({att.length})
                  </div>
                  {att.length === 0
                    ? <div style={{ fontSize: 13, color: POA.textMuted }}>No one's scanned in yet.</div>
                    : att.map(a => {
                      const m = members.find(x => x.id === a.member_id);
                      const t = a.checked_in_at ? new Date(a.checked_in_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
                      return (
                        <div key={a.member_id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: `0.5px solid ${POA.hairline}`, fontSize: 13 }}>
                          <CheckCircle2 size={15} color={POA.green} style={{ flexShrink: 0 }} />
                          <span style={{ flex: 1, color: POA.textPrimary }}>{m?.full_name || "Member"}{a.member_id === me.id ? " (you)" : ""}</span>
                          <span style={{ fontSize: 11, color: POA.textMuted }}>{t}</span>
                        </div>
                      );
                    })
                  }
                </div>
              </div>
            )}
          </div>
        )}

        {/* ---- Roster / manual toggle ---- */}
        <div style={{ ...PS.card, padding: "16px 18px", marginBottom: 14 }}>
          <p style={{ ...PS.kicker, marginBottom: 10 }}>Attendance roll ({att.length} / {members.length})</p>
          <div style={{ fontSize: 12, color: POA.textMuted, marginBottom: 10 }}>
            {manage && !detail.done ? "Tap a name to toggle — or use the QR code above for self-serve." : "Attendance record."}
          </div>
          {members.map(m => {
            const present = att.some(a => a.member_id === m.id);
            return (
              <div key={m.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderBottom: `0.5px solid ${POA.hairline}` }}>
                {manage && !detail.done
                  ? <button onClick={() => doToggle(detail, m.id)}
                      style={{ background: "none", border: "none", cursor: "pointer", padding: 0, display: "inline-flex" }}>
                      {present
                        ? <CheckCircle2 size={18} color={POA.green} />
                        : <span style={{ width: 18, height: 18, borderRadius: "50%", border: `2px solid ${POA.accentDim}`, display: "inline-block" }} />}
                    </button>
                  : (present ? <CheckCircle2 size={18} color={POA.green} /> : <X size={16} color={POA.red} />)
                }
                <span style={{ flex: 1, fontSize: 13.5, color: present ? POA.textPrimary : POA.textMuted }}>
                  {m.full_name}{m.id === me.id ? " (you)" : ""}
                </span>
                <span style={{ fontSize: 11, fontWeight: 700, color: present ? POA.greenText : POA.redText }}>
                  {present ? "PRESENT" : "ABSENT"}
                </span>
              </div>
            );
          })}
        </div>

        {manage && !detail.done && (
          <button style={{ ...PS.btnPrimary, width: "100%" }} disabled={busy} onClick={() => doComplete(detail)}>
            <CalendarCheck size={15} /> Mark event done — lock attendance
          </button>
        )}
      </div>
    );
  }

  // ---- calendar view ----
  return (
    <div>
      {err && (
        <div style={{ background: "rgba(70,199,147,.1)", border: "0.5px solid rgba(70,199,147,.3)", color: POA.greenText, borderRadius: 10, padding: "11px 14px", fontSize: 13, marginBottom: 14 }}>
          {err}
        </div>
      )}

      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 20 }}>
        <div>
          <p style={{ ...PS.kicker, marginBottom: 4 }}>Meeting Attendance</p>
          <h1 style={{ fontFamily: "inherit", fontSize: 24, fontWeight: 700, color: POA.textPrimary, margin: 0 }}>
            {MONTHS[cur.m]} {cur.y}
          </h1>
        </div>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {canManage(me.access) && (
            <button style={PS.btn} onClick={() => setAdding(!adding)}>
              <Plus size={13} /> Add event
            </button>
          )}
          <button style={PS.btn} onClick={() => setCur(c => c.m === 0 ? { y: c.y - 1, m: 11 } : { ...c, m: c.m - 1 })}>‹</button>
          <button style={PS.btn} onClick={() => setCur({ y: today.getFullYear(), m: today.getMonth() })}>Today</button>
          <button style={PS.btn} onClick={() => setCur(c => c.m === 11 ? { y: c.y + 1, m: 0 } : { ...c, m: c.m + 1 })}>›</button>
        </div>
      </div>

      {/* Add event form */}
      {adding && (
        <div style={{ ...PS.card, padding: "18px 20px", marginBottom: 18 }}>
          <p style={{ ...PS.kicker, marginBottom: 12 }}>New event</p>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
            <div style={{ gridColumn: "1 / -1" }}>
              <div style={{ fontSize: 12, color: POA.textMuted, marginBottom: 4 }}>Title</div>
              <input value={newEvt.title} onChange={e => setNewEvt({ ...newEvt, title: e.target.value })} style={PS.input} placeholder="e.g. General Membership Meeting" />
            </div>
            <div>
              <div style={{ fontSize: 12, color: POA.textMuted, marginBottom: 4 }}>Type</div>
              <select value={newEvt.kind} onChange={e => setNewEvt({ ...newEvt, kind: e.target.value })} style={PS.input}>
                {["meeting","board","training","community","general","other"].map(k => <option key={k} value={k}>{k}</option>)}
              </select>
            </div>
            <div>
              <div style={{ fontSize: 12, color: POA.textMuted, marginBottom: 4 }}>Date</div>
              <input type="date" value={newEvt.event_date} onChange={e => setNewEvt({ ...newEvt, event_date: e.target.value })} style={PS.input} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: POA.textMuted, marginBottom: 4 }}>Time (optional)</div>
              <input type="time" value={newEvt.event_time} onChange={e => setNewEvt({ ...newEvt, event_time: e.target.value })} style={PS.input} />
            </div>
            <div>
              <div style={{ fontSize: 12, color: POA.textMuted, marginBottom: 4 }}>Location (optional)</div>
              <input value={newEvt.location} onChange={e => setNewEvt({ ...newEvt, location: e.target.value })} style={PS.input} placeholder="Union Hall" />
            </div>
          </div>
          <ErrBox msg={err} />
          <div style={{ display: "flex", gap: 8 }}>
            <button style={PS.btnPrimary} disabled={busy} onClick={doCreate}>{busy ? "Saving…" : "Save event"}</button>
            <button style={PS.btn} onClick={() => { setAdding(false); setErr(""); }}>Cancel</button>
          </div>
        </div>
      )}

      {/* Calendar grid */}
      <div style={{ ...PS.card, padding: "16px 18px", marginBottom: 20 }}>
        {/* Day-of-week header */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 8 }}>
          {DOW.map(d => (
            <div key={d} style={{ fontSize: 10, fontWeight: 700, textAlign: "center", color: POA.textMuted, textTransform: "uppercase", letterSpacing: ".06em", padding: "4px 0" }}>{d}</div>
          ))}
        </div>
        {/* Weeks */}
        {Array.from({ length: cells.length / 7 }, (_, w) => (
          <div key={w} style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 2, marginBottom: 2 }}>
            {cells.slice(w * 7, w * 7 + 7).map((d, i) => {
              const evts = d ? (byDay[d] || []) : [];
              return (
                <div key={i} style={{ minHeight: 72, background: isToday(d) ? "rgba(155,107,230,.12)" : "transparent", border: `0.5px solid ${isToday(d) ? POA.accent : POA.hairline}`, borderRadius: 8, padding: "5px 6px" }}>
                  {d && (
                    <>
                      <div style={{ fontSize: 12, fontWeight: isToday(d) ? 700 : 400, color: isToday(d) ? POA.accent : POA.textMuted, marginBottom: 4 }}>{d}</div>
                      {evts.map(e => (
                        <button key={e.id} onClick={() => { setDetail(e); setErr(""); }}
                          style={{ display: "block", width: "100%", textAlign: "left", background: KIND_COLOR[e.kind] || POA.accent, border: "none", borderRadius: 4, padding: "3px 5px", fontSize: 10.5, fontWeight: 600, color: "#fff", marginBottom: 2, cursor: "pointer", lineHeight: 1.3, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", opacity: e.done ? 0.5 : 1 }}>
                          {e.event_time ? e.event_time.slice(0,5) + " " : ""}{e.title}
                        </button>
                      ))}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        ))}
      </div>

      {/* Upcoming list below calendar */}
      <p style={{ ...PS.kicker, marginBottom: 10 }}>Upcoming events</p>
      {events.filter(e => !e.done && new Date(e.event_date + "T23:59:59") >= today).length === 0
        ? <div style={{ ...PS.card, padding: "14px 16px", color: POA.textMuted, fontSize: 13.5 }}>No upcoming events scheduled.</div>
        : events
            .filter(e => !e.done && new Date(e.event_date + "T23:59:59") >= today)
            .slice(0, 8)
            .map(e => (
              <div key={e.id} style={{ ...PS.card, padding: "13px 16px", marginBottom: 8, cursor: "pointer", display: "flex", alignItems: "center", gap: 12 }}
                onClick={() => { setDetail(e); setErr(""); }}>
                <div style={{ width: 10, height: 10, borderRadius: "50%", background: KIND_COLOR[e.kind] || POA.accent, flexShrink: 0 }} />
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 700, fontSize: 14, color: POA.textPrimary }}>{e.title}</div>
                  <div style={{ fontSize: 12, color: POA.textMuted, marginTop: 2 }}>
                    {new Date(e.event_date + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}
                    {e.event_time ? ` · ${e.event_time.slice(0,5)}` : ""}
                    {e.location ? ` · ${e.location}` : ""}
                  </div>
                </div>
                <div style={{ fontSize: 12, color: POA.textMuted }}>
                  {(e.event_attendance || []).length} / {members.length}
                </div>
                {e.signin_open && (
                  <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 999, background: "rgba(70,199,147,.14)", color: POA.green }}>LIVE</span>
                )}
                <ChevronRight size={15} color={POA.textMuted} />
              </div>
            ))
      }
    </div>
  );
}
