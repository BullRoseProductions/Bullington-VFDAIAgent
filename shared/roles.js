/* THE ROLE VOCABULARY — one definition, imported by both the Vite client and the Vercel functions.
 *
 * Framework-agnostic on purpose: no React, no browser globals, no imports at all. That is what lets
 * api/ and src/ share it.
 *
 * WHY THIS EXISTS. api/pulse.js needed to know who a "leadership" training session applies to, and
 * carried its own copy of the list. That copy drifted before it ever ran — it dropped "Board Member"
 * and added "Chief"/"Assistant Chief", which are members.role RANK labels and can never appear in a
 * members.access array. The effect would have been every leadership-event reminder silently withheld
 * from board members: nothing erroring, no failed run, no log line, just notifications that never
 * arrived. Role literals do not "fail loudly" — that was the argument for tolerating the duplicate,
 * and it was wrong.
 *
 * ACCESS vs ROLE. Everything here describes values of members.access — the permission array. It is
 * NOT members.role, which holds rank labels (Chief, Assistant Chief, Firefighter). Mixing the two is
 * the exact mistake above, and it fails silently because a rank label is a perfectly valid string
 * that simply never matches.
 *
 * The whole vocabulary moved, not just the two entries pulse needs. A split vocabulary — some role
 * constants here, some in App.jsx — leaves the next person with no way to know where a new one
 * belongs, and that ambiguity is how the duplicate that started this got created.
 */

export const ROLES             = ["Project Admin", "Department Admin", "Board Member", "Officer", "Member"];
export const LEADERSHIP        = ["Project Admin", "Department Admin", "Board Member", "Officer"];
export const BOARD             = ["Board Member"];
export const DEPT_ADMIN_ROLES  = ["Department Admin", "Project Admin"];
export const CANMANAGE_ROLES   = ["Board Member", "Department Admin", "Officer"];   // NO Project Admin
export const CANMANAGE_OPS_ROLES = ["Department Admin", "Officer"];   // ops writes — Board EXCLUDED (governance-only) + no PA; client half of the live is_canmanage_ops() DB gate
export const SIGNIN_ROLES      = ["Project Admin", "Department Admin", "Officer"];  // PA/DA/TO — QR sign-in + AI planner
export const ANNOUNCE_ROLES    = ["Project Admin", "Department Admin", "Officer"];  // who can POST announcements — NOT Board; matches is_announcer() at the DB
export const GRANTABLE_ROLES   = ["Member", "Officer", "Board Member", "Department Admin"];   // roster editor checkboxes — Project Admin NOT grantable

export const hasAny           = (rs, set) => Array.isArray(rs) && rs.some((r) => set.includes(r));
export const isLeader         = (rs) => hasAny(rs, LEADERSHIP);
export const isDeptAdmin      = (rs) => hasAny(rs, DEPT_ADMIN_ROLES);
export const isBoard          = (rs) => hasAny(rs, BOARD);
export const canManage        = (rs) => hasAny(rs, CANMANAGE_ROLES);
export const isTrainingLeader = (rs) => hasAny(rs, SIGNIN_ROLES);
