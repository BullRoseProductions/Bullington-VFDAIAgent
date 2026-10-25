# B4C — Training Overhaul Slice 6 (corrections + audit log + roll-call-at-close) — STEP 0 (concept + live audit; no SQL, no code)

Spec: [[B4C_TrainingOverhaul_Spec_Step0]] §"Reconcile with the attendance-capture gap" and decision 3 ("keep a gated, logged
correction path").

**Sources:**
- the code on **main `7092a60`** (`src/App.jsx`; line numbers are main's);
- two **read-only** live queries:
  - `docs/review/training_slice6_STEP0_audit.sql` (SHA-256 `358ad377…`);
  - `docs/review/training_slice6_STEP0_audit2.sql` (`ea4e547b…`);
  - results in `docs/review/training_slice6_STEP0_OUTPUT.json`.

> **Source caveat — read first.** [[B4C_Training_Attendance_Capture_Gap]] and [[B4C_Training_Hours_From_Attendance_Brief]]
> **are not in the repo, the main checkout or anywhere under the home directory.** Google Drive wasn't reachable from this
> session (its connector failed to authenticate).
>
> I worked from the two places those rules are **implemented**, both quoted below:
> - the Spec's own summary of the gap;
> - the live hours code: C1 `attested_training` and C2 `dept_station_shifts` / `dept_iso_hours_for`, whose headers in
>   `sql/training_hours_c1_attested_training.sql` and `…_c2_officer_attested_credit.sql` restate the brief.
>
> If either brief says something the live code doesn't, the brief wins. Please paste or attach it and I'll re-check the
> roll-call section against it.

---

## TL;DR — four premise corrections that change the build

1. **The lock is client-side only.** `locked = done || signinOpen || attendance>0` (25077) only hides the Edit pencil.
   - The **live `training_sessions` UPDATE policy is just `department_id = my_department_id() AND is_training_manager()`**,
     with no `done` term.
   - Any training manager's client could rewrite a finalized session's date, title or length today, unlogged.
   - The Sep-24→Sep-3 fix needed SQL because **the UI** won't edit, not the database.
   - **So a correction log is meaningless unless 6-DB also closes the direct-UPDATE route on locked sessions.**
2. **Reopen is a raw `update({done:false})`** (24467), so it's unlogged and unbounded.
   - The roster is DB-locked on a finalized session: the `session_attendance` INSERT/DELETE policies require
     `ts.done = false`.
   - So Reopen is the **only** way to change a closed roll today.
   - Reopen alone **can't** fix a date: a reopened session with anyone on its roll is still `locked` (`attendance>0`), so
     the Edit pencil stays hidden. That's the exact Sep-24→Sep-3 trap.
3. **Officer-attested hours are derived, never written.**
   - `officer_manual` / flat-90 / `verified=false` is **not a row** anywhere. `station_presence.source` CHECKs
     `IN ('geo','gps_geofence')`, so there is no `officer_manual` row to write.
   - It's the output label of C2's branch B, computed from `session_attendance` by `attested_training` (C1, **live**:
     called by `dept_station_shifts`, `dept_iso_hours_by_station`, `dept_iso_hours_for`).
   - **Consequences:**
     - roll-call-at-close writes **only `session_attendance` rows** (exactly what `toggleAttend` writes);
     - the brief's attested path then applies automatically: capped at min(90, length), `verified=false`, observed wins;
     - `verified` is never touched by anything in this slice.
     - Also, **every correction to a closed drill's date, start time, length, audience, off-site flag or roster changes
       credited and ISO hours**, because `attested_training` reads those columns live.
4. **A drawn-signature component already exists.**
   - `SignaturePad` (18210) is used by equipment sign-out (`equipment_issue_batch.signature_data` / `witness_signature`)
     and document acknowledgments (`acknowledge_document(…, p_signature_data)` → `document_acknowledgments.signature_data`).
   - "Net-new for Slice 7" is really "reuse": 6-UI could take a signature at near-zero UI cost.

---

## 1. Today — lock, edit, finalize, Reopen (main `7092a60`)

**The predicate** (25077):

```js
const locked = s.done || s.signinOpen || (s.attendance?.length > 0);
```

It gates **only** the Edit pencil (`canManage && editSessionMode && !locked`, 25122).
- **Remove** uses its own test (`!s.done && !(attendance>0)`, mirroring the DELETE policy).
- **Attach plan / agenda** and **QR** ignore `locked`.

**Editable before lock** (`saveEditSession`, 24506): title, date, start time, length, category (`plan_id`), audience,
counts-toward-attendance, is-meeting, off-site + label (clearing coordinates when turned off). It's one direct
`training_sessions` update with a 0-row guard.

**Finalize** is two steps, per [[attendance-two-step-finalize]]:
1. **"Complete"** → `beginCloseout` (24391) opens the roll writable. It doesn't lock.
2. **`finalizeSession`** (24395):
   - an **empty-roll-only** confirm (a low roll is deliberately *not* warned; see its comment, 24396–24405);
   - closes QR if open;
   - prompts for length only if blank;
   - direct `update({done:true, duration_min?})`;
   - **stamps `training_plans.last_iso = today`** for a category-linked drill;
   - the `trg_close_training_presence_on_done` trigger closes open training presence rows.

**Reopen** (`reopenSession`, 24466; button 25120, `canManage`):
- `update({done:false})` + open the roll;
- no reason, no record, no time limit;
- its comment already says "HARDEN LATER: a grace-window reopen RPC … deferred for the pilot".

**The gap, precisely:**

| Want to fix on a closed drill | Today |
|---|---|
| attendance (add/remove) | Reopen → mark → re-finalize. **Works, unlogged.** |
| length still blank | Reopen → re-finalize (the prompt re-asks). Works, unlogged. The "finished drills with no length" notice (24841) tells officers to "open a session and set its length", but Edit is hidden on these (`attendance>0`). |
| **date / start time / title / length (set) / audience / category** | **Impossible in the UI** once anyone is on the roll, even after Reopen. Needed scoped SQL (`sql/fix_week4_to_week1_2026-09-03.sql`). Possible to anyone hand-calling the API (finding 1). |

**Live sizing:**
- 34 sessions are finalized;
- 1 has an empty roll;
- 2 have 1–2 present;
- 11 have no length;
- 6 have no start time;
- the Sep-3 row is intact (Fire Training Week 1 · 2026-09-03 · done · 12 present).

---

## 2. The correction path

### 2a. What a correction may change (on a locked session)

| Field | Correctable | Note |
|---|---|---|
| date | **yes** | The live `training_session_date_membership_window` trigger (BEFORE UPDATE OF date) re-checks every existing attendee against their join..termination window. A move that puts someone outside it is **refused** (`MEMBERSHIP_WINDOW:`), which is correct. |
| start time | yes | moves the attested interval |
| title | yes | the Sep-3 fix renamed too |
| length (`duration_min`) | yes, **including null → value** | hours-bearing; the no-length notice routes here |
| audience | yes | hours-bearing (`board` is excluded from attested) |
| category (`plan_id`) | yes | **recommend** it also re-derives `last_iso` (§3c) |
| counts-toward-attendance / is-meeting | yes | `counts_toward_attendance=false` makes it optional, so not ISO-qualifying |
| off-site + label | yes | hours-bearing (off-site is excluded from station hours) |
| **roster** add / remove | **yes, inside the same correction** | Through the RPC, so the DB's `done=false` attendance policies stay as they are. The membership-window trigger on `session_attendance` still fires. |
| `done`, `signin_*`, coordinates, `series_id`, `department_id` | **no** | done = Reopen / Finalize; sign-in = open/close_signin; coordinates = C3 |

### 2b. Gate — **Ruling C1**

- **Recommend: `is_training_manager()`** (= `canManageTraining`), the same gate that today finalizes, reopens and marks
  rosters. The correction is *more* accountable than what those people can already do (Reopen + re-mark, unlogged).
- **Alternative: DA-only (`is_dept_admin()`-style).** It's stricter for rewriting finalized records, but:
  - the training officer who ran the drill becomes unable to fix their own typo;
  - it adds a request-the-DA loop to an ordinary mistake.
- **Middle option:** TO may correct within N days of the drill date; older ones are DA-only. That's one extra branch in the
  RPC.
- **Recommendation: `is_training_manager()` plus a required reason plus the log.** Revisit with the window if the log shows
  abuse.

### 2c. Reason + signature — **Ruling C2**

- **Reason:** required, non-blank, server-enforced (e.g. ≥ 10 characters after trim). A blank reason is refused, not
  defaulted.
- **Signature: recommend NO drawn signature on a correction; logging + reason is enough.**
  - A correction is a single-actor fix of a clerical error by an authenticated, gated user. The log already records
    who / when / what / old→new / why.
  - Your drawn-signature rule exists for the **attestation** acts:
    - two-person reschedule/cancel (Slice 7);
    - hand-signed custody (equipment);
    - acknowledgment (documents).
  - A signature on every typo fix would train people to scribble through it.
- **Trade-off:** if you'd rather any rewrite of a finalized attendance record carry a signature (a rule auditors like),
  6-UI can reuse `SignaturePad` and 6-DB adds one nullable `signature_data text` to the log. It's cheap now and awkward to
  add later.
- **Middle option:** require the signature only when a correction **removes** someone from a finalized roll, or **moves
  the date across a month**, since those are the two that change a member's credited record.

### 2d. The audit log — proposed schema (6-DB) — **Ruling C3: a new table (recommended) vs columns**

**Recommended: a new append-only table `training_session_audit`.** Columns on `training_sessions` (e.g.
`corrected_at/by/reason`) only hold the **last** change and can't hold old→new or roster deltas. Every existing
`*_log` table here (`duty_log`, `apparatus_maintenance_log`, `fundraiser_log`, `station_log`, `document_versions`) is a
separate table, so this matches.

```
training_session_audit
  id            uuid pk default gen_random_uuid()
  department_id uuid not null  -> departments          (RLS scope; copied from the session)
  session_id    uuid not null  -> training_sessions ON DELETE RESTRICT? (see note)
  action        text not null  check in ('correct','reopen','finalize')   -- finalize: Ruling C4
  actor_id      uuid not null  -> members  (my_member_id() at write time)
  actor_name    text not null  (snapshot — survives a member rename/removal)
  at            timestamptz not null default now()
  reason        text           (required for correct + reopen; check (action='finalize' or length(btrim(reason)) >= 10))
  changes       jsonb not null default '{}'   -- {"date":{"old":"2026-09-24","new":"2026-09-03"}, "title":{...}}
  roster_added   uuid[] not null default '{}'
  roster_removed uuid[] not null default '{}'
  roster_before  int, roster_after int         -- counts, for a glanceable log
  signature_data text                          -- only if Ruling C2 = signature
```

**RLS / grants** (by the patterns in memory):
- RLS on;
- **SELECT** to `authenticated` where `department_id = my_department_id() AND is_training_manager()`. **Ruling C5:** or
  `is_leadership()`, so chiefs and board can read the log too. I recommend leadership-readable, because it's an
  accountability record;
- **no INSERT / UPDATE / DELETE policies and no table grants beyond SELECT.** Written only by the SECURITY DEFINER RPCs.
  Append-only by construction.

**Session delete:** a session with an audit row is by definition locked or was, and the DELETE policy already refuses
done-or-attended sessions. **Recommend `ON DELETE RESTRICT`**: the log must never be the thing that silently disappears.

### 2e. Writers (RPCs) — and closing the bypass

New SECURITY DEFINER RPCs. Each one gets:
- `REVOKE … FROM anon, public; GRANT … TO authenticated` ([[anon-execute-revoke-pattern]]);
- `SET search_path = public`;
- a refusal when the session isn't in `my_department_id()`;
- `NOTIFY pgrst` at the end ([[migration-notify-pgrst-reload]]).

| RPC | Does | Refuses |
|---|---|---|
| `correct_training_session(p_session_id, p_changes jsonb, p_add uuid[], p_remove uuid[], p_reason text)` | One transaction: diffs `p_changes` against the row (whitelisted keys only, §2a); applies the field update; inserts/deletes `session_attendance` for the roster deltas; writes **one** audit row with old→new + roster arrays. | not `is_training_manager()`; the session isn't locked (an unlocked session uses the normal edit); blank reason; a no-op (nothing changed); unknown keys; a membership-window refusal (propagates, nothing written) |
| `reopen_training_session(p_session_id, p_reason)` | `done = false`, plus an audit row. **Ruling C6:** reason required on Reopen (recommend **yes**, the same ≥ 10 characters). | not a manager; not done; blank reason |
| *(optional, Ruling C4)* `finalize_training_session(p_session_id, p_duration_min)` | the `done=true` + length the client does today, plus an audit row (no reason) | |

**Closing the direct route** (needed, or the log is optional):
- **Policy:** `training_sessions` UPDATE `USING` gains `AND done IS NOT TRUE`.
  - A finalized row can then **only** change through the RPCs (Reopen included).
  - Finalize still works: it updates a `done=false` row, and the `WITH CHECK` has no `done` term.
- **Guard trigger** for the *not-done-but-attended* state (sign-in open / people checked in; the Sep-24 case happened
  here):
  - `BEFORE UPDATE` on `training_sessions`: if `EXISTS (session_attendance for OLD.id)` **and** a protected field (§2a
    "yes" rows) changed. There is **no live `session_has_attendance()` function**: the App.jsx comment at the Remove button
    names one, but the live DELETE policy inlines the `EXISTS`, and the audit found no such function. **and** the RPC's transaction-local flag (`set_config('b4c.session_correction','on',true)`) isn't set →
    `RAISE 'LOCKED_SESSION: …'`.
  - **Exempt:** `duration_min` null → value (Finalize's TOUCHPOINT 2), `done`, `signin_*`, coordinates.
  - A policy can't do this: finalize must still update an attended row.
- **Ruling C7 — enforce the lock in the DB (recommended) vs UI-only.** UI-only keeps today's bypass and makes the log
  advisory. The trigger costs one more function to review.

**Existing writers that change behaviour** (each must be re-pointed or proven unaffected):

| Writer | Today | After 6 |
|---|---|---|
| `saveEditSession` (24506) | direct UPDATE | unchanged for **unlocked** sessions; the guard trigger proves it can't touch locked ones |
| `finalizeSession` (24395) | direct UPDATE `done:true` (+length) | unchanged (C4 = no) or → `finalize_training_session` (C4 = yes) |
| `reopenSession` (24466) | direct UPDATE `done:false` | **→ `reopen_training_session` + reason** (the direct update is refused by the new policy) |
| `toggleAttend` (24262) | direct INSERT/DELETE (done=false only) | unchanged: works on unfinalized sessions; on a closed one corrections go through the RPC |
| `member_check_in` RPC | QR self check-in | unchanged (refuses `done`) |
| `open_signin` / `close_signin` RPCs | `signin_*`, coordinates | unchanged (non-protected fields) |
| `addSession` / `scheduleRecurring` (+ Slice 5 attach) | INSERT | unchanged |
| `removeSession` + DELETE policy | refuses done/attended | unchanged |
| `AIDrillPlanner.scheduleOnDate` (5912) | INSERT | dead code since Slice 2 (unmounted); unchanged |
| SQL-editor hand fixes (`sql/fix_week4…`) | direct UPDATE as owner | owner bypasses RLS but **not** the guard trigger. A future hand fix must set the flag deliberately, which is the point. |

**Readers the log + corrections touch:**

| Reader | Effect |
|---|---|
| `attested_training` → `dept_station_shifts`, `dept_iso_hours_for` / `dept_iso_hours`, `dept_iso_hours_by_station` (and `dept_member_iso_hours_by_month` if applied) | read `date`, `start_time`, `duration_min`, `audience`, `is_offsite`, `counts_toward_attendance` and the roster live, so **a correction moves credited + ISO hours immediately**. Intended; the log is what explains the move. No function change. |
| Station-hours report / Chief's Report / Agenda (`mergeStationHours`, 14886; 27557ff) | numbers move with the correction; no change |
| `api/digest.js:641`, `api/assistant.js:165–180`, `api/pulse.js:264–289` | read sessions + attendance; reflect corrections; no change |
| Training page: sessions list, attendance counts, trend, member Up-next / catch-up | reflect corrections on reload; no change |
| `training_plans.last_iso` / `dueInfo` (23171) / status strip (25361) | see §3c; a category or date correction should re-derive it |
| **New:** a per-session "Corrections (N)" history (6-UI) | reads `training_session_audit` |

---

## 3. Roll-call-at-close

### 3a. Pre-fill from who was on station — **Ruling R1**

**Source:** `station_presence` rows with `kind = 'standby'` (the only non-training kind with live data) that **overlap the
drill window** (`date + start_time` in America/Chicago, for `duration_min`, or 90 if blank), same department.

**Live sizing** (closed drills with a start time):
- 73 standby-overlap pairs:
  - **61 are already on the roll**;
  - **12 are not** (the prefill opportunity);
- 20 sessions are involved;
- 6 closed drills have no start time, so there's no window and no prefill.

**How it writes:**
- **Recommend: suggest, don't auto-mark.**
  - The Complete roll shows a "**On station during the drill (N)**" group, **pre-ticked**.
  - The officer unticks anyone who was on standby but not at the drill, then confirms.
  - Each confirmed name becomes an ordinary `session_attendance` insert (the `toggleAttend` path, done=false). Nothing
    else.
- **Alternative:** auto-insert at Complete. Faster, but it would attest people the officer never looked at, which is the
  opposite of attested.
- **Ruling R1b:** pre-ticked (recommended; the common case is "they were there") vs unticked (safer, more taps).

**Binding constraints** (hours brief, as implemented):
- **Never write `station_presence`** from roll-call. Its source CHECK forbids anything but geo/GPS anyway.
- **Never set or read-to-write `verified`.**
- A prefilled member is credited by C2 branch B exactly like any officer-marked member:
  - `officer_manual`, capped at min(90, length), `verified=false`;
  - excluded if `board`, off-site, not done or no length.
- **Observed still wins:** a member with a real `training` presence for the session gets their clocked interval and no
  attestation. Prefill doesn't change that.
- **Double-count check:**
  - ISO (`dept_iso_hours_for`) merges each member's standby + attested-training intervals with `range_agg`, so the
    overlap is counted once; it just moves from standby to training.
  - The credited figures on every report come from that merged split (`mergeStationHours`, 14886), so **no double
    count**.
  - The raw `dept_station_shifts` list does show both rows. That's true today for the 61 and isn't summed anywhere for
    credit.
- The **membership-window** trigger still refuses a prefilled name outside their window. The UI must surface it per name
  (the `isMembershipWindowErr` message already exists), not abort the batch.

**Where it runs:** at **Complete** (`beginCloseout`, which opens the roll), **not** at Finalize. The officer reviews it while
the roll is still writable, which keeps the two-step finalize intact.

**Reader:** `station_presence` SELECT for the drill window. **Ruling R2:**
- (a) a client-side read: officers can read department presence today — **verify the `station_presence` SELECT policy in
  6-DB's pre-flight**;
- (b) **recommended:** a small read RPC `drill_window_presence(p_session_id)` that applies the window, timezone and gates
  server-side, so the window math matches `attested_training`'s exactly (C1's "one definition" lesson).

### 3b. Warn on closing a low / zero roll — **Ruling R3**

- **Today:** zero-only, deliberately ("A low roll is ordinary — three people at a Tuesday drill is a real Tuesday —
  and warning about it would train officers to click through the warning that matters", 24398–24404).
- **Your ask** says low *or* zero. **Recommend:**
  - keep zero as the strong (danger) confirm;
  - add **"low" only relative to the prefill**: if the **on-station suggestions were left unticked**, or the roll is
    below the number on station, show a soft line in the existing Lock-attendance confirm ("3 present · 7 were on
    station"), not a second dialog.
  - That warns on the real failure (the roll closed incomplete) without crying wolf on small drills.
- **Alternative:** a fixed threshold (e.g. under 25 % of expected). It's simple but fires on every legitimately small drill.

### 3c. "Days since training" tied to attendance-recorded — **Ruling R4**

- **Today:** `finalizeSession` sets the category's `last_iso = toISO(new Date())`, the **finalize date**, not the drill's
  date. It does so **even on an empty roll**. So:
  - finalizing the Sep-3 drill on the 24th would have stamped the 24th;
  - a no-show drill resets the "days since" clock.
- **Recommend:** `last_iso` = the **drill's date**, and **only when the roll is non-empty**.
  - Use max(existing, drill date), so finalizing an older drill never moves the clock backwards.
  - A correction that changes date, category or roster, and a Reopen, **re-derive** it as max(date) over that category's
    done sessions with attendance. That's a server-side recompute in the RPCs, so a correction can't leave the clock
    stale.
- **Readers:** `dueInfo` (23171), the status strip (25361), the hero's due counts, `reconcile` (Up-next). The member-level
  "days since their last B4C attendance" (4217) is already attendance-based, so no change.
- **Trade-off:** pure UI (stamp the drill date, skip on empty) fixes new finalizes but not corrections. The recompute in the
  RPCs closes it.

---

## 4. Proposed split

### 6-DB (one migration, full gate discipline)

- **Pre-flight (refuse, don't break):**
  - pin the md5 of every live function the migration reads or wraps:
    - `is_training_manager` `472b87b0…`, `my_department_id` `87f54665…`, `my_member_id` `3f66369c…`;
    - `close_training_presence_on_done` `71097308…`;
    - `attested_training` `aff25333…`, `dept_station_shifts` `894bbaa8…`, `dept_iso_hours` `306fa11b…` (read-only
      dependency; must be **unchanged** after);
    - the two membership-window trigger functions;
  - pin the current `training_sessions` UPDATE policy text;
  - check `station_presence`'s SELECT policy (R2);
  - refuse if `training_session_audit` already exists.
- **Body:**
  - the `training_session_audit` table + RLS + SELECT-only grant;
  - `correct_training_session`, `reopen_training_session` (+ `finalize_training_session` if C4), and
    `drill_window_presence` if R2b;
  - the guard trigger;
  - the UPDATE-policy `done IS NOT TRUE` term;
  - the `last_iso` recompute helper (R4);
  - revoke/grant on every new function;
  - `NOTIFY pgrst, 'reload schema'`.
- **Dry run** inside `BEGIN … ROLLBACK`, acting as a real TO via `request.jwt.claims` ([[station-presence-constraints]]):
  - correct the date of a finalized, attended session → succeeds, one audit row, old→new right, attendees intact;
  - a move outside a member's window → `MEMBERSHIP_WINDOW` refused, nothing written;
  - a direct UPDATE of a done session → refused by policy;
  - a direct date UPDATE of an attended, not-done session → `LOCKED_SESSION`;
  - finalize of an attended session still works, including length null→value;
  - Reopen without a reason → refused; with one → done=false + an audit row;
  - roster add/remove through the correction → `attested_training` output moves accordingly;
  - **`verified`: count of `station_presence WHERE verified` = 941 before and after; no `station_presence` write
    anywhere.**
- **SENTINEL RETEST:** the standard sentinel pass plus:
  - Officer-not-TO, Board, PA and Member refused on every new RPC;
  - anon has no EXECUTE;
  - a foreign-department `p_session_id` refused;
  - the audit table has no write path for `authenticated`;
  - the C1/C2 function md5s are unchanged.
- **Post-state row:** policy text, function list + ACLs, row counts (34 done / 0 audit rows), `verified`-count unchanged.

### 6-UI (`src/App.jsx`, after 6-DB is applied and verified)

- **Locked session row:**
  - **"Correct…"** (`canManage`) opens the edit form pre-filled, plus the roster, plus a required **Reason**;
  - it calls `correct_training_session`;
  - a **"Corrections (N)"** link shows the log (who / when / old→new / roster ± / reason).
- **Reopen** asks for a reason → `reopen_training_session`.
- **No-length notice:** its instruction now works (Correct → length), and it's logged.
- **Complete roll:** the "On station during the drill" prefill group (R1); low/zero warnings per R3.
- **Finalize:** `last_iso` per R4 (or the RPC per C4).
- Signature via `SignaturePad` only if C2 = yes.
- **Happy-dom test:**
  - Correct writes one RPC with the right diff and refuses a blank reason;
  - Reopen requires a reason;
  - prefill shows the on-station members pre-ticked and writes plain `session_attendance` inserts only;
  - no `station_presence` write, no `verified` reference added (token count unchanged);
  - role matrix (DA / TO / Officer-not-TO / Board / PA / Member);
  - Notify held.

---

## Rulings needed

| # | Question | Recommendation | Trade-off |
|---|---|---|---|
| C1 | Correction gate | `is_training_manager()` | DA-only is stricter but blocks a TO fixing their own typo; a time-window hybrid is possible |
| C2 | Drawn signature on a correction? | **No:** log + required reason | Yes = reuse `SignaturePad` + one nullable column; scribble fatigue. Middle: only on roster removals / cross-month date moves |
| C3 | Audit storage | New append-only `training_session_audit` table | Columns hold only the last change, no old→new |
| C4 | Log Finalize too? | **Yes** (cheap; makes the log a complete close → reopen → correct history) | Moves finalize to an RPC; slightly larger 6-DB |
| C5 | Who reads the log | `is_leadership()` | TO-only keeps it narrower |
| C6 | Reason required on Reopen | Yes | One more field on a common action |
| C7 | Enforce the lock in the DB (policy + guard trigger) | **Yes**, or the log is optional | One more trigger to review; SQL hand-fixes must set the flag |
| R1 | Prefill source + mode | Standby overlapping the drill window, **suggested pre-ticked**, written as plain `session_attendance` | Auto-insert attests unseen people; unticked = more taps |
| R2 | Prefill reader | Read RPC `drill_window_presence` | A client read duplicates the window/timezone math |
| R3 | Low-roll warning | Keep zero as danger; add "N present · M were on station" inside the existing confirm | A fixed threshold nags on every small drill |
| R4 | Days-since | `last_iso` = drill date, only with a non-empty roll; recompute on correction / reopen | UI-only fixes new finalizes, not corrections |

**Not in this slice:** reschedule/cancel (Slice 7, on the fence); the `session_attendance` SELECT-role normalization
([[session-attendance-select-policy-roles]]); attendance-read paging.
