import { useState, useEffect, useCallback } from "react";
import { Bell, CheckCheck, AlertTriangle, Award, HardHat, Wrench, CalendarClock, ClipboardCheck, ClipboardList, Settings, Lock, ChevronRight, ArrowLeft, Clock } from "lucide-react";
import { supabase } from "./supabaseClient";
import { useAutoRefresh } from "./useReconnect";
import { FIRE } from "./theme.js";

/* Notification centre — reads the STORED notifications table (not a recomputed list), so read/unread
   survives a refresh and the department keeps a "we told them, on this date" record.

   SCOPE IS THE DATABASE'S JOB, NOT THIS COMPONENT'S. RLS on `notifications` already returns
   own-rows plus department-wide for leaders. Deliberately no .eq("member_id", …) filter here:
   duplicating the rule in the client is how the two drift apart. The `mine` flag below is a
   DISPLAY distinction (yours vs the department's), never a security boundary. */

// Keyed on the prefix BEFORE the first underscore, so event_24h and event_1h share one icon.
// A type with no entry here renders as a generic warning triangle without erroring — so any new
// type added to api/pulse.js needs its prefix added here in the SAME change, or it ships looking
// like a bug nobody filed.
const ICON = { cert: Award, gear: HardHat, maint: Wrench, event: CalendarClock, task: ClipboardCheck, duty: ClipboardList };
const iconFor = (type) => ICON[String(type || "").split("_")[0]] || AlertTriangle;
const COLOR = { critical: "#E58A90", warning: "#D6A95E", info: FIRE.catBlue };   // info: the noir blue

function timeAgo(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

// Shared loader. Returns rows or null — null means the READ FAILED, which is not the same as
// "no notifications" and must never render as an empty inbox.
async function fetchNotifications(limit = 50) {
  const { data, error } = await supabase
    .from("notifications")
    .select("id, member_id, type, title, body, severity, created_at, read_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) return null;
  return data || [];
}

/* The bell + unread count for the app chrome. */
export function NotificationBell({ meId, onOpen }) {
  const [unread, setUnread] = useState(0);
  const load = useCallback(async () => {
    const rows = await fetchNotifications(50);
    if (rows === null) return;                                   // keep the last-known count on a failed read
    setUnread(rows.filter((r) => !r.read_at && r.member_id === meId).length);   // badge counts YOUR items only
  }, [meId]);

  useEffect(() => {
    load();
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [load]);

  return (
    <button
      onClick={onOpen}
      aria-label={unread ? `Notifications — ${unread} unread` : "Notifications"}
      style={{ position: "relative", background: "none", border: "none", cursor: "pointer", padding: 6, display: "inline-flex", alignItems: "center", color: "#B6BDC8" }}
    >
      <Bell size={19} />
      {unread > 0 && (
        <span style={{ position: "absolute", top: 0, right: 0, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "#C8323A", color: "#fff", fontSize: 10.5, fontWeight: 700, lineHeight: "16px", textAlign: "center" }}>
          {unread > 9 ? "9+" : unread}
        </span>
      )}
    </button>
  );
}

/* The inbox itself. */
/* ---------------- notification preferences ----------------

   WHAT A MEMBER CAN ACTUALLY SILENCE, and why the list is short.

   Only api/pulse.js consults is_muted(), and pulse only produces event_* and task_* rows. The
   compliance families (certs / gear / maint) come from the weekly digest, which never checks
   preferences — so a toggle for them would be a switch wired to nothing. Rather than hide that,
   the screen states it: an always-on row that explains the rule. A control that silently does
   nothing is worse than no control, and a member who believes they muted cert warnings and then
   misses a renewal has been actively misled by the UI.

   ABSENCE MEANS ON. notification_prefs holds only explicit choices; a member who has never
   touched this screen has no rows at all. So "no row" and "enabled = true" both render ON, and
   the first-run case needs no seeding.

   Turning a family back on writes enabled = true rather than deleting the row — deliberately,
   matching the table, which has no DELETE policy. A deletion and an enabled=true say the same
   thing about intent but different things about history, and updated_at is worth keeping. */
// The Back buttons used S.btn, which the app's style object does not define — they rendered as bare
// native buttons. This is the app's FS.btn (not exported from App.jsx), built from the same FIRE tokens.
const BACK_BTN = { display: "inline-flex", alignItems: "center", gap: 6, padding: "7px 11px", fontSize: 12.5, fontWeight: 600, background: FIRE.card2Noir, border: `1px solid ${FIRE.line2Noir}`, borderRadius: 9, color: FIRE.btnText, cursor: "pointer", fontFamily: "inherit" };
const MUTABLE_FAMILIES = [
  { key: "events", label: "Event & training reminders",
    desc: "A day before and an hour before each drill, meeting or training session you're expected at." },
  { key: "tasks", label: "Tasks & assignments",
    desc: "When something assigned to you is due tomorrow, due today, or overdue." },
  /* 'shifts' is mutable in is_muted() as of the early-catch V2 migration, so it MUST appear here.
     A family the database will honour an opt-out for, with no control in the UI, is the exact
     "control that exists and cannot be reached" this file's header warns about — except inverted:
     the member cannot turn it off at all. */
  { key: "shifts", label: "Station hours check-ins",
    desc: "A quiet nudge when a station shift has been running longer than you normally work, in case a check-out was missed." },
];

const ALWAYS_ON_BLURB =
  "Expiring certifications, gear past its service life and overdue maintenance always notify you. " +
  "These are the records your department is measured on, so they can't be switched off.";

function Toggle({ on, disabled, onChange, label }) {
  return (
    <button
      role="switch" aria-checked={on} aria-label={label} disabled={disabled}
      onClick={() => !disabled && onChange(!on)}
      style={{
        width: 44, height: 26, borderRadius: 13, flexShrink: 0, position: "relative",
        border: "1px solid " + (on ? "rgba(118,201,141,.5)" : "rgba(255,255,255,.14)"),
        background: on ? "rgba(118,201,141,.22)" : "rgba(255,255,255,.05)",
        cursor: disabled ? "default" : "pointer", opacity: disabled ? 0.5 : 1,
        transition: "background .15s, border-color .15s", padding: 0,
      }}
    >
      <span aria-hidden="true" style={{
        position: "absolute", top: 2, left: on ? 20 : 2, width: 20, height: 20, borderRadius: 10,
        background: on ? "#76C98D" : "#8B93A0", transition: "left .15s, background .15s",
      }} />
    </button>
  );
}

export function NotificationSettings({ S, meId, back }) {
  const [prefs, setPrefs] = useState(null);      // null = not loaded yet; Map family -> enabled
  const [err, setErr] = useState("");
  const [saving, setSaving] = useState(null);    // which family is mid-write

  /* No .eq("member_id", …) here. RLS on notification_prefs already restricts SELECT to
     member_id = my_member_id(), and the rest of this file follows the same rule — duplicating a
     scope check in the client is how the two drift apart. meId is still needed for the WRITE,
     because member_id is part of the primary key. */
  const load = useCallback(async () => {
    const { data, error } = await supabase.from("notification_prefs").select("family, enabled");
    if (error) {
      /* A FAILED READ IS NOT AN EMPTY RESULT. Rendering every toggle ON because the query failed
         would tell a member their opt-out had vanished, and might prompt them to "fix" a setting
         that was never broken. Keep whatever was last known (possibly nothing) and say so. */
      setErr("Couldn't load your notification settings. Check your connection and try again.");
      return;
    }
    setErr("");
    setPrefs(new Map((data || []).map((r) => [r.family, r.enabled])));
  }, []);
  useEffect(() => { load(); }, [load]);

  // No row means opted in. Only an explicit false mutes — same rule the server's is_muted() applies.
  const isOn = (family) => (prefs?.get(family) ?? true) !== false;

  async function setFamily(family, next) {
    if (!meId) { setErr("We couldn't match your login to a member record."); return; }
    const prior = prefs ? new Map(prefs) : new Map();
    setPrefs((p) => new Map(p || []).set(family, next));   // optimistic — the switch must feel instant
    setSaving(family);
    const { error } = await supabase.from("notification_prefs").upsert(
      { member_id: meId, family, enabled: next, updated_at: new Date().toISOString() },
      { onConflict: "member_id,family" },
    );
    setSaving(null);
    if (error) {
      setPrefs(prior);            // put the switch back rather than leave it lying about the server
      setErr("Couldn't save that. Your setting hasn't changed — please try again.");
      return;
    }
    setErr("");
  }

  const loading = prefs === null && !err;

  return (
    <div>
      {back && <button style={{ ...BACK_BTN, marginBottom: 14 }} onClick={back}>← Back</button>}
      <h1 style={{ fontSize: 20, fontWeight: 800, color: "#F7F8FA", margin: "0 0 4px" }}>Notification settings</h1>
      <div style={{ fontSize: 13, color: "#7E8794", lineHeight: 1.5, marginBottom: 6 }}>
        Choose what B4C sends to your phone. Everything stays in your notifications list either way —
        turning something off only stops the alert.
      </div>

      {err && <div style={{ fontSize: 13, color: "#E58A90", margin: "10px 0", lineHeight: 1.5 }}>{err}</div>}

      {loading ? (
        <div style={{ fontSize: 13.5, color: "#7E8794", marginTop: 14 }}>Loading…</div>
      ) : (
        <div style={{ marginTop: 10 }}>
          {MUTABLE_FAMILIES.map((f) => (
            <div key={f.key} style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "14px 2px", borderTop: "1px solid rgba(255,255,255,.06)" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "#F7F8FA" }}>{f.label}</div>
                <div style={{ fontSize: 12.5, color: "#B6BDC8", marginTop: 3, lineHeight: 1.45 }}>{f.desc}</div>
                {saving === f.key && <div style={{ fontSize: 11.5, color: "#7E8794", marginTop: 4 }}>Saving…</div>}
              </div>
              <Toggle on={isOn(f.key)} disabled={saving === f.key} label={f.label}
                      onChange={(next) => setFamily(f.key, next)} />
            </div>
          ))}

          {/* Stated, not hidden. See the note above MUTABLE_FAMILIES. */}
          <div style={{ display: "flex", gap: 12, alignItems: "flex-start", padding: "14px 2px", borderTop: "1px solid rgba(255,255,255,.06)", opacity: 0.9 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 14, fontWeight: 600, color: "#F7F8FA", display: "flex", alignItems: "center", gap: 6 }}>
                <Lock size={13} color="#7E8794" /> Certification, gear &amp; maintenance alerts
              </div>
              <div style={{ fontSize: 12.5, color: "#B6BDC8", marginTop: 3, lineHeight: 1.45 }}>{ALWAYS_ON_BLURB}</div>
            </div>
            <div style={{ fontSize: 11.5, fontWeight: 700, color: "#76C98D", letterSpacing: ".04em", textTransform: "uppercase", paddingTop: 3, flexShrink: 0 }}>
              Always on
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function NotificationCenter({ S, meId, back }) {
  const [view, setView] = useState("inbox");
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState("all");   // All / Unread / Training / Gear — display only

  const load = useCallback(async () => {
    const data = await fetchNotifications(100);
    setLoaded(true);
    if (data === null) { setErr("Couldn't load your notifications. Pull again in a moment."); return; }   // keep prior rows
    setErr(""); setRows(data);
  }, []);
  useEffect(() => { load(); }, [load]);
  /* Resume-refresh the inbox. The bell above already re-reads on every visibilitychange with no
     throttle, deliberately — a badge count is one cheap select and wants to be instant. The list
     is the heavier read, so it takes the shared throttle instead of a second ad-hoc listener. */
  useAutoRefresh(load);

  async function markRead(id) {
    setRows((rs) => rs.map((r) => (r.id === id ? { ...r, read_at: r.read_at || new Date().toISOString() } : r)));   // optimistic
    const { error } = await supabase.rpc("mark_notification_read", { p_id: id });
    if (error) load();                                            // server refused → resync rather than lie
  }
  async function markAll() {
    setBusy(true);
    const { error } = await supabase.rpc("mark_all_notifications_read");
    setBusy(false);
    if (error) { setErr("Couldn't mark those read. Please try again."); return; }
    load();
  }

  /* Rendered AFTER every hook above, never before — an early return placed higher would change
     the hook call order between renders and React would throw. */
  if (view === "settings") {
    return <NotificationSettings S={S} meId={meId} back={() => { setView("inbox"); load(); }} />;
  }

  const mine = rows.filter((r) => r.member_id === meId);
  const dept = rows.filter((r) => r.member_id !== meId);          // leaders only — RLS returns nothing here for a plain member
  const unreadMine = mine.filter((r) => !r.read_at).length;

  /* THE CENTER, built to b4c_notifications_center_noir.html: typed colour tiles, unread rows with a red left
     accent + status dot, OVERDUE / IN 1 HR style pills read off the stored type, Today / Earlier groups and
     All / Unread / Training / Gear filters. Same rows, same mark-read rules (only YOUR unread items, on tap). */
  const DISP = "'Oswald', system-ui, sans-serif";
  const fam = (t) => String(t || "").split("_")[0];
  const TILE = {
    maint: ["rgba(200,50,58,.13)", "#E07982", "rgba(200,50,58,.35)"],
    event: ["rgba(79,144,214,.13)", "#7FB2E6", "rgba(79,144,214,.35)"],
    shift: ["rgba(79,144,214,.13)", "#7FB2E6", "rgba(79,144,214,.35)"],
    cert:  ["rgba(216,162,74,.13)", "#D8A24A", "rgba(216,162,74,.35)"],
    gear:  ["rgba(216,162,74,.13)", "#D8A24A", "rgba(216,162,74,.35)"],
    duty:  ["rgba(47,168,105,.13)", "#55BE87", "rgba(47,168,105,.35)"],
    task:  ["rgba(47,168,105,.13)", "#55BE87", "rgba(47,168,105,.35)"],
  };
  const DOT = { critical: "#E03A44", warning: "#CC9E52", info: "#4F90D6" };
  const pillFor = (t) => {
    t = String(t || "");
    if (t.endsWith("_overdue")) return ["OVERDUE", "over"];
    if (t === "cert_expired") return ["EXPIRED", "over"];
    if (t === "event_1h") return ["IN 1 HR", "soon"];
    if (t.endsWith("_due_today")) return ["DUE TODAY", "soon"];
    if (t === "event_24h" || t.endsWith("_due_tomorrow")) return ["TOMORROW", "soon"];
    return null;
  };
  const PILL = { over: { background: "#241216", color: "#E07982", border: "1px solid rgba(200,50,58,.4)" }, soon: { background: "#1c1509", color: "#CC9E52", border: "1px solid rgba(204,158,82,.35)" } };
  const FILTERS = [["all", "All"], ["unread", "Unread"], ["training", "Training"], ["gear", "Gear"]];
  const pass = (n) => filter === "all" ? true
    : filter === "unread" ? !n.read_at
    : filter === "training" ? fam(n.type) === "event"
    : ["gear", "maint"].includes(fam(n.type));
  const startToday = new Date(); startToday.setHours(0, 0, 0, 0);
  const weekAgo = startToday.getTime() - 6 * 864e5;
  const groupOf = (n) => { const t = Date.parse(n.created_at); return t >= startToday.getTime() ? "Today" : t >= weekAgo ? "Earlier this week" : "Older"; };
  const when = (n) => { const t = Date.parse(n.created_at); return t >= weekAgo ? timeAgo(n.created_at) : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }); };

  const Row = ({ n, dim, last }) => {
    const Icon = iconFor(n.type);
    const [bg, fg, bd] = TILE[fam(n.type)] || ["rgba(255,255,255,.05)", "#A4ADBA", "rgba(255,255,255,.13)"];
    const unread = !n.read_at && !dim;
    const pill = pillFor(n.type);
    return (
      <div onClick={() => unread && markRead(n.id)}
        style={{ display: "flex", gap: 13, alignItems: "flex-start", padding: "13px 15px", borderBottom: last ? "none" : `1px solid ${FIRE.lineNoir}`, position: "relative", cursor: unread ? "pointer" : "default", background: unread ? "rgba(79,144,214,.04)" : "transparent", opacity: dim ? 0.8 : 1 }}>
        {unread && <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: 3, background: "#E03A44" }} />}
        <span style={{ width: 38, height: 38, borderRadius: 10, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, background: bg, color: fg, border: `1px solid ${bd}` }}><Icon size={18} /></span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 13.5, fontWeight: 600, color: FIRE.textPrimary, display: "flex", alignItems: "center", gap: 8 }}>
            {unread && <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: "50%", flexShrink: 0, background: DOT[n.severity] || DOT.info }} />}{n.title}
          </div>
          {n.body && <div style={{ fontSize: 12, color: FIRE.textSecondary, marginTop: 3, lineHeight: 1.45 }}>{n.body}</div>}
          <div style={{ fontSize: 11, color: FIRE.textMuted, marginTop: 5, display: "flex", alignItems: "center", gap: 7, flexWrap: "wrap" }}>
            {pill && <span style={{ fontSize: 10, fontWeight: 700, borderRadius: 5, padding: "2px 7px", letterSpacing: ".03em", ...PILL[pill[1]] }}>{pill[0]}</span>}
            <span>· {when(n)}{!n.read_at || dim ? "" : " · read"}</span>
          </div>
        </div>
        {unread && <ChevronRight size={16} color={FIRE.textMuted} style={{ alignSelf: "center", flexShrink: 0 }} />}
      </div>
    );
  };
  const listBox = { background: "linear-gradient(180deg, #0F131A, #0B0E13)", border: `1px solid ${FIRE.lineNoir}`, borderRadius: 13, overflow: "hidden", marginBottom: 18 };
  const grpHead = { fontFamily: DISP, fontWeight: 700, fontSize: 11, letterSpacing: ".11em", textTransform: "uppercase", color: FIRE.textMuted, margin: "4px 0 9px" };
  const shown = mine.filter(pass);
  const groups = ["Today", "Earlier this week", "Older"].map((g) => [g, shown.filter((n) => groupOf(n) === g)]).filter(([, l]) => l.length);
  const deptShown = dept.filter(pass);

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
        {back && <button style={BACK_BTN} onClick={back}><ArrowLeft size={13} /> Back</button>}
        <h1 style={{ fontFamily: DISP, fontWeight: 700, fontSize: 22, margin: 0, flex: 1, color: FIRE.textPrimary, minWidth: 150 }}>
          Notifications
          {unreadMine > 0 && <span style={{ fontFamily: "inherit", fontSize: 12, fontWeight: 600, color: "#E07982", background: "rgba(200,50,58,.16)", border: "1px solid rgba(200,50,58,.4)", borderRadius: 999, padding: "2px 9px", marginLeft: 8, verticalAlign: "middle" }}>{unreadMine} new</span>}
        </h1>
        {unreadMine > 0 && (
          <button onClick={markAll} disabled={busy} style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: "#55BE87", background: "#0e1c14", border: "1px solid rgba(47,168,105,.3)", borderRadius: 9, padding: "8px 12px", cursor: "pointer", fontFamily: "inherit", opacity: busy ? 0.6 : 1 }}>
            <CheckCheck size={13} /> {busy ? "Marking…" : "Mark all read"}
          </button>
        )}
        {/* Always present, unlike "Mark all read" — a member who wants to turn notifications
            down is most likely to look for it while their inbox is empty of unread items. */}
        <button onClick={() => setView("settings")} aria-label="Notification settings" title="Notification settings"
                style={{ width: 36, height: 36, borderRadius: 9, border: `1px solid ${FIRE.line2Noir}`, background: FIRE.card2Noir, color: FIRE.textSecondary, display: "inline-flex", alignItems: "center", justifyContent: "center", cursor: "pointer", padding: 0 }}>
          <Settings size={15} />
        </button>
      </div>

      <div style={{ display: "inline-flex", flexWrap: "wrap", background: FIRE.card2Noir, border: `1px solid ${FIRE.line2Noir}`, borderRadius: 10, padding: 3, marginBottom: 18 }}>
        {FILTERS.map(([k, l]) => {
          const on = filter === k;
          return (
            <button key={k} onClick={() => setFilter(k)} aria-pressed={on} style={{ fontSize: 12, fontWeight: 600, padding: "6px 13px", borderRadius: 7, border: "none", cursor: "pointer", fontFamily: "inherit", background: on ? "#E03A44" : "transparent", color: on ? "#fff" : FIRE.textSecondary }}>
              {l}{k === "unread" && unreadMine > 0 ? <span style={{ opacity: 0.8, marginLeft: 4 }}>{unreadMine}</span> : null}
            </button>
          );
        })}
      </div>

      {err && <div style={{ fontSize: 12.5, color: "#E07982", margin: "0 0 12px", padding: "8px 11px", borderRadius: 8, background: "rgba(200,50,58,.08)", border: "1px solid rgba(200,50,58,.3)" }}>{err}</div>}

      {!loaded ? (
        <div style={{ fontSize: 13.5, color: FIRE.textMuted, marginTop: 14 }}>Loading…</div>
      ) : (
        <>
          {mine.length === 0 && dept.length === 0 && !err && (
            <div style={{ fontSize: 13.5, color: FIRE.textMuted, marginTop: 4, lineHeight: 1.6 }}>
              Nothing needs your attention right now. Expiring certifications, gear past its service life,
              and overdue maintenance will show up here.
            </div>
          )}
          {(mine.length > 0 || dept.length > 0) && groups.length === 0 && deptShown.length === 0 && (
            <div style={{ fontSize: 13, color: FIRE.textMuted, marginTop: 4 }}>Nothing in this filter.</div>
          )}
          {groups.map(([g, list]) => (
            <div key={g}>
              <div style={grpHead}>{g}</div>
              <div style={listBox}>{list.map((n, i) => <Row key={n.id} n={n} last={i === list.length - 1} />)}</div>
            </div>
          ))}
          {deptShown.length > 0 && (
            <>
              <div style={{ ...grpHead, marginTop: 8 }}>Department-wide</div>
              {/* Leader view. Read-only on purpose: marking another member's item read on their
                  behalf would corrupt the "they were told" record — the RPC refuses it too. */}
              <div style={listBox}>{deptShown.map((n, i) => <Row key={n.id} n={n} dim last={i === deptShown.length - 1} />)}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
