# B4C — Training Overhaul Slice 4 (type-exclusive attach) — STEP 0 (audit + plan, no code)

The ask: a **training** session shows only **"Attach plan"**; a **meeting / leadership / board** event shows only **"Attach
agenda"**. One attach control per session, decided by the session's type, never both on screen.

Audited from the live code on **main `dd88f11`** (`src/App.jsx`; line numbers are main's), plus one read-only live query
(`docs/review/training_slice4_STEP0_OUTPUT.json`: every existing attachment by session type × kind, the `session_plans`
policies, the attach RPC's gate).

**Scope: UI-only as recommended.** No schema change, no new RPC, `verified` untouched, Notify held back. It reuses the
existing `session_plans` upload path, the agenda snapshot path (`AttachAgendaModal`) and `attach_drill_plan_to_session`.
**One pre-existing DB mismatch is flagged below (finding 3). It is not Slice 4's to fix.**

## 1. Where each attach is surfaced today, and its exact gate
There are **three** ways to attach something to a session. All three write a `session_plans` row; there's no separate
agenda table.

| Path | Where | What it writes | UI gate (today) | DB gate (live) |
|---|---|---|---|---|
| **"Attach plan"** — a file upload | the leader **Sessions row** (25031), a `<label>` with a file input → `attachPlan(s, file)` (24490) | storage upload + `session_plans` insert: `source 'upload'`, `storage_path` | **`canManage`** = `!!canManageTraining` (Slice 1: a DA or a training officer). **Not type-gated**: every row, training or meeting | INSERT policy **`is_canmanage()`** (Board / DA / Officer in the dept) — see finding 3 |
| **"Attach agenda"** — a saved AI agenda as a **snapshot** | the leader **Sessions row** (25033) → `AttachAgendaModal` (23435, mounted once at 24886) | `session_plans` insert: `source 'ai'`, `title` + `ai_text` copied from `ai_outputs` (`feature='agenda'`, `current_text ?? ai_text`) — **no marker that it's an agenda** | **`isRestrictedEvent(s) && (canManage \|\| isBoard(role))`**: only leadership / board audiences; a Board Member can attach | the same INSERT policy `is_canmanage()` |
| **Attach a library drill plan** | the **Training Plans tab** (the Library), a session picker → `attach_drill_plan_to_session` RPC (23786) | `session_plans` insert: `source 'ai'`, `drill_plan_id` set | `canWrite` = `canManageTraining`. **The picker offers every not-done session** (`!s.done`), meetings included | the RPC gates on **`is_training_manager()`** (live; re-pointed from `is_canmanage_ops()` by Training Officers); it **doesn't check session type** |

- So the **plan** controls follow the post-Slice-1 twin (`canManageTraining` / `is_training_manager()`), and the
  **agenda** control is `canManage || isBoard`. **Slice 4 keeps every one of these gates exactly**; it only decides which
  control a given row shows.
- **Not counted:** the legacy inline `AIDrillPlanner` save-to-session inserts (5898 / 5915). That component has been
  unmounted since Slice 2, so it's dead code.

## 2. The type predicate — plan vs agenda
The real fields:
- `audience ∈ { everyone, leadership, board }`. Live values are exactly these three; the column defaults to `everyone`,
  so treat `NULL` as `everyone`.
- `is_meeting`: the "This is a meeting" checkbox. It's offered and saved **only for everyone-audience sessions** (24284 /
  24471: `audience === "everyone" && isMeeting`). Live: 0 restricted sessions carry it.

**Recommend reusing the app's existing meeting rule:**
- `isMeeting(s) = isRestrictedEvent(s) || !!s.isMeeting` (19982). It's the helper the Meetings / Minutes page already uses
  ("leadership and board sessions are meetings already").
- **Meeting → "Attach agenda". Otherwise (training) → "Attach plan".** Exactly one of the two for every session:

| Audience | is_meeting | Type | The row shows |
|---|---|---|---|
| everyone (or NULL) | false | **training** | **Attach plan** (unchanged) |
| everyone | true | meeting | **Attach agenda** — **new for this case**: today it shows "Attach plan" and *no* agenda, because the agenda gate only checks the audience. Live: 0 such sessions |
| leadership | (always false) | meeting | **Attach agenda** (today: **both** controls) |
| board | (always false) | meeting | **Attach agenda** (today: **both** controls) |
| leadership / board | true (not settable in the UI; 0 live) | meeting | Attach agenda |

**"A leadership-audience training"**: the data has no field that says "this leadership session is a training rather than
a meeting". `is_meeting` exists only for everyone-audience sessions, and the app treats leadership and board as meetings
everywhere (Minutes, the Next-Training card's exclusion at 3854, the Meeting checkbox's own copy). **So under this rule a
leadership-only drill gets "Attach agenda", not "Attach plan".**
- **Ruling 1** offers the alternative (leadership → plan; only board and everyone+meeting → agenda), with its trade-off.
- Live: the 13 leadership sessions have **no** attachments at all.

## 3. Capability check — does the split remove anything in use?
Live attachments by session type × kind (read-only, Oct 25):

| Session type | Sessions | Agenda snapshot | Uploaded file | Library drill plan | Legacy AI planner / other AI plan |
|---|---|---|---|---|---|
| board | 13 | **6** (3 on done sessions) | **3** (2 on done) | 0 | 0 |
| leadership | 13 | 0 | 0 | 0 | 0 |
| everyone + meeting | 0 | — | — | — | — |
| training | 150 | **0** | 6 | 0 | 11 + 3 |

**Findings:**
1. **One cross-type combination is in use: file uploads on board meetings (3).** They went through the row's "Attach
   plan" control, because the agenda modal can only pick a saved AI agenda, never a file. A strict split ("meetings show
   only the agenda modal") **removes the only way to attach a file (a PDF agenda, a packet) to a meeting.**
   **Recommend (Ruling 2):** the meeting's **"Attach agenda"** control offers both:
   - **"Pick a saved agenda"** (the existing snapshot modal), gated by `canManage || isBoard`, as today;
   - **"Upload a file"** (the existing `attachPlan` upload path, the same `session_plans` row), gated by `canManage`, as
     the row's upload is today.

   Nobody gains or loses an ability: Board still can't upload, DA / training officers still can.
2. **No agenda is attached to any training (0), and no library drill plan is attached anywhere (0).** So hiding "Attach
   agenda" from trainings, and filtering meetings out of the Library's session picker (Ruling 3), **orphans nothing and
   removes nothing in use.**
3. **A pre-existing DB / UI mismatch (from Training Officers Slice 1; flagged, not fixed here):**
   - `session_plans` **INSERT** is still `is_canmanage()` (Board / DA / Officer). UPDATE and DELETE are
     `is_training_manager()`.
   - So a **training officer who is a plain Member** sees "Attach plan" on a training (the UI uses `canManageTraining`),
     but the **insert is refused by RLS**. The same applies to the agenda snapshot.
   - The other way round, an **Officer who isn't a training officer** passes the INSERT policy but has no control.
   - It's invisible today only if no plain-Member training officer has tried it. Fixing it means re-pointing that one
     policy to `is_training_manager()` (or `… OR is_board` for agendas). **That's a DB change: a separate small
     migration, Step 0 first, not Slice 4.** Ruling 5.

## 4. Viewing existing attachments is unaffected
The split is only about the **attach control**:
- Every place that **shows** an attachment reads `s.plans` (all `session_plans` rows for the session), whatever its
  kind or the session's type:
  - the Sessions row's **"Plans (N)"** button (`s.plans.length > 0`) and its panel (25030);
  - the hero's **"View plan"**;
  - the member Up-next **"View plan"**;
  - `openSessionPlans` / `AiPlanViewer`.
- **Detach** (remove an attachment) stays where it is, on the same `canManage` gate, for any kind.
- So the 3 files on board meetings and the 11 + 3 AI plans and 6 files on trainings all stay visible and removable.

**Cosmetic, optional (Ruling 4):** on a meeting the viewer button still says "Plans (N)" even when it holds agendas. It
could read "Agenda (N)" on meetings. That's label-only; it doesn't change behaviour.

## 5. "One attach per session"
This means **one attach control** per row, chosen by type. It doesn't mean one attachment: "Attach more plans" and
attaching several agendas keep working as today, since the 6 board agendas sit on 3 sessions.

## What the build would touch (`src/App.jsx` only)
- **The Sessions row:**
  - `const meetingRow = isMeeting(s)`;
  - the upload `<label>` only when `!meetingRow && canManage`;
  - the agenda control only when `meetingRow && (canManage || isBoard(role))`, opening an attach chooser that has
    "Pick a saved agenda" (the modal) and, for `canManage`, "Upload a file" (the same `attachPlan`).
- **The Library picker:** `upcoming = sessions.filter((s) => !s.done && !isMeeting(s))` (Ruling 3). It's a UI filter;
  the RPC stays type-agnostic.
- **Gates:** unchanged. No schema, no new RPC.
- **Tests:**
  - a happy-dom test: the predicate table above, row by row; each role's controls on a training vs a board vs a
    leadership vs an everyone+meeting row; the upload inside the agenda control; existing attachments still listed; the
    Library picker excluding meetings;
  - source checks, pinned to the release in the promote push.

## Rulings needed
1. **Predicate:** meeting = `isRestrictedEvent || is_meeting` (the existing Minutes helper), so leadership → **agenda**
   (recommended: one rule app-wide, and 0 leadership attachments live). Alternative: leadership → **plan** (treat
   leadership as "officer training" and only board + everyone-meeting as meetings), which splits from the Minutes /
   Next-Training rule.
2. **Files on meetings:** the agenda control also offers **"Upload a file"** (gated `canManage`, the existing upload).
   Recommended: it keeps the 3 board-meeting uploads' capability. Or strict saved-agenda-only, which removes file
   attachments from meetings going forward (existing ones stay visible).
3. **Library picker:** list **training sessions only** (recommended: completes the split for drill plans). Or leave every
   not-done session; the RPC allows either.
4. **Viewer label on meetings:** "Agenda (N)" instead of "Plans (N)": yes / no (cosmetic).
5. **(Separate, DB)** Schedule a small Step 0 to align the `session_plans` INSERT policy with the UI gates
   (`is_training_manager()` for plans, plus Board for agendas). Today a plain-Member training officer's attach is refused.
