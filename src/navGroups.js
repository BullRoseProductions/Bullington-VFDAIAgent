/* SIDEBAR GROUPING (Bret's five groups + a gear menu). PRESENTATION ONLY.

   The sidebar used to be one flat list of NAV items. It is now the SAME items, filtered by the SAME rules (role, module
   toggle, the equipment-manager exception, Read & Sign only while something is outstanding: visibleNav in App.jsx),
   arranged under five headers, with the support/admin screens behind one gear entry. Nothing here decides who may see
   a screen or where a click goes: every item still calls App's go(key), so R1's routing (paths, push/replace, Back) is
   untouched.

   An item's group is fixed by this map. A group with no visible items is never rendered (a member never sees an empty
   "Outreach" header). "notifications" has no NAV entry (the bell in the top bar has always been its door); the sidebar
   adds it under Today so its unread count can surface on the Today header like Read & Sign's does on Station. */

export const NAV_GROUPS = [
  { id: "today", label: "Today", keys: ["dashboard", "notifications", "duties", "minutes"] },
  { id: "train", label: "Train", keys: ["training", "study", "qanda"] },
  { id: "people", label: "People", keys: ["roster", "onboarding", "qualifications", "expirations", "reports"] },
  { id: "station", label: "Station", keys: ["apparatus", "equipment", "myequipment", "stationhours", "documents", "readiness", "readsign", "resources"] },
  { id: "outreach", label: "Outreach", keys: ["recruit", "funding", "visibility"] },
];
// Behind the gear: support and Project-Admin oversight. "department" (the PA's department list) sits with the other
// PA-only screens; see the item-map questions in the slice note.
export const GEAR_KEYS = ["settings", "admin", "adddept", "department"];

// Screens with no sidebar entry of their own light up their parent (same rule as App's SCREEN_PARENT).
const PARENT = { library: "training", packet: "training" };
export const ownerKey = (screen) => PARENT[screen] || screen;

/* visibleItems: the already-filtered sidebar items, in NAV order, each { key, … }.
   → { groups: [{ id, label, items }], gear: [items] }; empty groups dropped, items kept in the map's order.
   Any visible key the map doesn't name lands in the LAST rendered group rather than vanishing (a new NAV entry
   without a home must still be reachable; the test fails on it so it gets a real home). */
export function groupNav(visibleItems) {
  const byKey = new Map((visibleItems || []).map((n) => [n.key, n]));
  const placed = new Set();
  const groups = NAV_GROUPS.map((g) => {
    const items = g.keys.filter((k) => byKey.has(k)).map((k) => { placed.add(k); return byKey.get(k); });
    return { id: g.id, label: g.label, items };
  }).filter((g) => g.items.length > 0);
  const gear = GEAR_KEYS.filter((k) => byKey.has(k)).map((k) => { placed.add(k); return byKey.get(k); });
  const stray = (visibleItems || []).filter((n) => !placed.has(n.key));
  if (stray.length) {
    if (groups.length) groups[groups.length - 1].items.push(...stray);
    else groups.push({ id: "more", label: "More", items: stray });
  }
  return { groups, gear };
}

/* A group's header badge: the sum of its items' badge counts. App passes counts as { readsign: n, notifications: n }. */
export const groupBadge = (group, counts) => group.items.reduce((s, n) => s + (Number(counts?.[n.key]) || 0), 0);

/* Is a group (or the gear menu) holding the screen on show? Then it is always open, whatever was remembered. */
export const holdsScreen = (items, screen) => items.some((n) => n.key === ownerKey(screen));

/* Collapsed groups, remembered per device. A convenience only: every read and write is guarded, and a missing or
   unreadable value means "everything open". */
export const NAV_COLLAPSE_KEY = "b4c_nav_collapsed";
export function readCollapsed(storage) {
  try {
    const s = storage || (typeof window !== "undefined" ? window.localStorage : null);
    const v = JSON.parse((s && s.getItem(NAV_COLLAPSE_KEY)) || "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}
export function writeCollapsed(map, storage) {
  try {
    const s = storage || (typeof window !== "undefined" ? window.localStorage : null);
    if (s) s.setItem(NAV_COLLAPSE_KEY, JSON.stringify(map || {}));
  } catch { /* private mode / blocked storage: the sidebar just won't remember */ }
}
