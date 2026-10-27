/* Apparatus status — ONE definition of "ready" for every screen and the weekly email (WS-4b, metric A).
 *
 * WHY THIS FILE EXISTS. "Ready" meant three things: the dashboards counted in-service + Pass (a rig added as
 * "Ready" with no check on file was ready), the Apparatus page counted Pass AND checked, and the email counted
 * in_service only — including retired rigs. Same reasoning as shared/maint-due.js: one rule, imported by
 * src/App.jsx and api/digest.js. docs/review/ws4b_shared_test.mjs pins every listed call site to this file.
 *
 * THE RULE (Ashlea's rulings A-1 + A-3, STRICT; A-2 denominator):
 *   retired          deleted_at set — out of EVERY count and denominator
 *   out_of_service   in_service = false
 *   never_checked    in service, no last_check_at (its own bucket — never "ready", A-1)
 *   needs_attention  in service and checked, but not Pass — or its check is OVERDUE on its schedule (A-3)
 *   ready            in service ∧ Pass ∧ last_check_at set ∧ not overdue
 * Overdue mirrors the Apparatus page's checkDue: only a rig WITH a check_interval_days can be overdue; due =
 * last_check_at + interval days; past that instant it is overdue. No schedule → never overdue.
 *
 * INPUT SHAPE. Raw apparatus rows (snake_case, as the email reads them) or the App's mapped rigs (camelCase) —
 * both are accepted so the two engines can't drift on a field rename.
 */

const DAY_MS = 86_400_000;

export const RIG_STATUSES = ["ready", "needs_attention", "never_checked", "out_of_service", "retired"];

const pickField = (r, snake, camel) => (r[camel] !== undefined ? r[camel] : r[snake]);

export function checkOverdue(rig, now = Date.now()) {
  const days = Number(pickField(rig, "check_interval_days", "checkIntervalDays"));
  const last = pickField(rig, "last_check_at", "lastCheckAt");
  if (!days || !last) return false;
  const t = Date.parse(last);
  if (!Number.isFinite(t)) return false;
  return now > t + days * DAY_MS;
}

export function rigStatus(rig, { now = Date.now() } = {}) {
  if (pickField(rig, "deleted_at", "deletedAt")) return "retired";
  const inService = rig.inService !== undefined ? rig.inService !== false : rig.in_service !== false;   // null reads as in service (the column's long-standing default)
  if (!inService) return "out_of_service";
  if (!pickField(rig, "last_check_at", "lastCheckAt")) return "never_checked";
  if (rig.status !== "Pass" || checkOverdue(rig, now)) return "needs_attention";
  return "ready";
}

// Bucket counts over the NON-RETIRED rigs: ready + needsAttention + neverChecked + outOfService === total.
export function apparatusCounts(rigs, { now = Date.now() } = {}) {
  const c = { total: 0, ready: 0, needsAttention: 0, neverChecked: 0, outOfService: 0 };
  for (const r of rigs || []) {
    const s = rigStatus(r, { now });
    if (s === "retired") continue;
    c.total += 1;
    if (s === "ready") c.ready += 1;
    else if (s === "needs_attention") c.needsAttention += 1;
    else if (s === "never_checked") c.neverChecked += 1;
    else c.outOfService += 1;
  }
  return c;
}
