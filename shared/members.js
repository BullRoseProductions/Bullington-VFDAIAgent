/* Who is a member, and who COUNTS — ONE definition for every screen and the weekly email (WS-4c, metric B).
 *
 * WHY THIS FILE EXISTS. "30 / 29 / 28 members" — five populations were in use: every status (countsInStats), Active +
 * Probationary, Active only, the server's "Active + Probationary, not PA, not separated", and raw members. The email
 * carried its own copy of countsInStats and of the id list. Same reasoning as shared/maint-due.js: one rule, imported by
 * src/App.jsx and api/digest.js. docs/review/ws4c_members_test.mjs pins every listed count site to this file.
 *
 * TWO PREDICATES, ON PURPOSE:
 *   isListedMember(m)  — a real person on the roster: not an owner/test/demo id, not a Project Admin. LISTS, names,
 *                        assignees, the roster table (Inactive stays visible there, behind its toggle). This is exactly
 *                        what countsInStats was.
 *   isCountedMember(m) — the HEADCOUNT and every denominator: listed ∧ status ∈ {Active, Probationary} ∧ not separated.
 *                        B-1 Inactive out · B-2 Probationary in · B-3 PA/owner/test/demo out · B-4 separated out.
 * separated comes from members_view.separated (WS-4c DB), the server's own rule: a member_separation row exists
 * (dept_readiness_packet / dept_probation_board). The email reads member_separation directly and sets the same flag.
 *
 * MASKED FIELDS. members_view hides status (and separated) from non-leaders — NULL, not a value. A NULL is "can't see",
 * never "not counted": a plain member's screens keep counting every listed member, as they did. Leaders and the email see
 * the real values, so for them the rule is exact.
 */

/* Owner, test and demo accounts — out of every count and every assignee picker. Was hard-coded TWICE (App.jsx and
   api/digest.js, "MUST stay in sync"); now once. */
export const STATS_EXCLUDED_IDS = new Set([
  "0ad3dc98-5af3-4ae5-8c04-f7902e0cf7c4",  // Ashlea (owner)
  "02c4a728-9d58-4e58-89b4-4f277aad2272",  // test account
  "fc4a1a0f-f885-4ca9-baf9-ce47eb47448f",  // Demo Account (test@b4c.com)
]);

const isProjectAdmin = (m) => Array.isArray(m?.access) && m.access.includes("Project Admin");
const COUNTED_STATUSES = new Set(["Active", "Probationary"]);

export const isListedMember = (m) => !!m && !STATS_EXCLUDED_IDS.has(m.id) && !isProjectAdmin(m);

export const isCountedMember = (m) => isListedMember(m)
  && (m.status == null || COUNTED_STATUSES.has(m.status))   // NULL = masked for this viewer → can't exclude on it
  && m.separated !== true;                                  // B-4; NULL (masked) / undefined → not known to be separated

// The headcount, with Inactive alongside — never inside it ("30 members · + 2 inactive").
export function headcount(members) {
  const listed = (members || []).filter(isListedMember);
  return {
    counted: listed.filter(isCountedMember).length,
    active: listed.filter((m) => isCountedMember(m) && m.status === "Active").length,
    probationary: listed.filter((m) => isCountedMember(m) && m.status === "Probationary").length,
    inactive: listed.filter((m) => m.status === "Inactive" && m.separated !== true).length,
    separated: listed.filter((m) => m.separated === true).length,
    listed: listed.length,
  };
}
