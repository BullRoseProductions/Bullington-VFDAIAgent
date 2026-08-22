import { useState, useEffect, useCallback } from "react";
import { Bell, CheckCheck, AlertTriangle, Award, HardHat, Wrench, CalendarClock, ClipboardCheck, Settings, Lock } from "lucide-react";
import { supabase } from "./supabaseClient";

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
const COLOR = { critical: "#E58A90", warning: "#D6A95E", info: "#8FA3C4" };

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
const MUTABLE_FAMILIES = [
  { key: "events", label: "Event & training reminders",
    desc: "A day before and an hour before each drill, meeting or training session you're expected at." },
  { key: "tasks", label: "Tasks & assignments",
    desc: "When something assigned to you is due tomorrow, due today, or overdue." },
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
      {back && <button style={{ ...S.btn, marginBottom: 14 }} onClick={back}>← Back</button>}
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

  const load = useCallback(async () => {
    const data = await fetchNotifications(100);
    setLoaded(true);
    if (data === null) { setErr("Couldn't load your notifications. Pull again in a moment."); return; }   // keep prior rows
    setErr(""); setRows(data);
  }, []);
  useEffect(() => { load(); }, [load]);

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

  const Row = ({ n, dim }) => {
    const Icon = iconFor(n.type);
    const color = COLOR[n.severity] || COLOR.info;
    const unread = !n.read_at;
    return (
      <div
        onClick={() => unread && !dim && markRead(n.id)}
        style={{ display: "flex", gap: 11, padding: "12px 2px", borderTop: "1px solid rgba(255,255,255,.06)", cursor: unread && !dim ? "pointer" : "default", opacity: dim ? 0.75 : 1 }}
      >
        <div style={{ paddingTop: 2, color }}><Icon size={17} /></div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: unread ? 700 : 500, color: "#F7F8FA", lineHeight: 1.35 }}>{n.title}</div>
          {n.body && <div style={{ fontSize: 13, color: "#B6BDC8", marginTop: 2, lineHeight: 1.45 }}>{n.body}</div>}
          <div style={{ fontSize: 11.5, color: "#7E8794", marginTop: 4 }}>
            {timeAgo(n.created_at)}{!unread && !dim ? " · read" : ""}
          </div>
        </div>
        {unread && !dim && <div aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 4, background: color, marginTop: 6, flexShrink: 0 }} />}
      </div>
    );
  };

  return (
    <div>
      {back && <button style={{ ...S.btn, marginBottom: 14 }} onClick={back}>← Back</button>}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 4 }}>
        <h1 style={{ fontSize: 20, fontWeight: 800, color: "#F7F8FA", margin: 0 }}>Notifications</h1>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 8 }}>
          {unreadMine > 0 && (
            <button onClick={markAll} disabled={busy} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", color: "#B6BDC8", borderRadius: 8, padding: "5px 10px", fontSize: 12.5, fontWeight: 600, cursor: busy ? "default" : "pointer" }}>
              <CheckCheck size={13} /> {busy ? "Marking…" : "Mark all read"}
            </button>
          )}
          {/* Always present, unlike "Mark all read" — a member who wants to turn notifications
              down is most likely to look for it while their inbox is empty of unread items. */}
          <button onClick={() => setView("settings")} aria-label="Notification settings" title="Notification settings"
                  style={{ display: "inline-flex", alignItems: "center", background: "rgba(255,255,255,.04)", border: "1px solid rgba(255,255,255,.1)", color: "#B6BDC8", borderRadius: 8, padding: "6px 8px", cursor: "pointer" }}>
            <Settings size={14} />
          </button>
        </div>
      </div>

      {err && <div style={{ fontSize: 13, color: "#E58A90", margin: "8px 0" }}>{err}</div>}

      {!loaded ? (
        <div style={{ fontSize: 13.5, color: "#7E8794", marginTop: 14 }}>Loading…</div>
      ) : (
        <>
          {mine.length === 0 && dept.length === 0 && !err && (
            <div style={{ fontSize: 13.5, color: "#7E8794", marginTop: 16, lineHeight: 1.6 }}>
              Nothing needs your attention right now. Expiring certifications, gear past its service life,
              and overdue maintenance will show up here.
            </div>
          )}
          {mine.length > 0 && <div style={{ marginTop: 10 }}>{mine.map((n) => <Row key={n.id} n={n} />)}</div>}
          {dept.length > 0 && (
            <>
              <div style={{ fontSize: 11.5, letterSpacing: ".06em", textTransform: "uppercase", color: "#7E8794", fontWeight: 700, margin: "22px 0 2px" }}>
                Department-wide
              </div>
              {/* Leader view. Read-only on purpose: marking another member's item read on their
                  behalf would corrupt the "they were told" record — the RPC refuses it too. */}
              <div>{dept.map((n) => <Row key={n.id} n={n} dim />)}</div>
            </>
          )}
        </>
      )}
    </div>
  );
}
