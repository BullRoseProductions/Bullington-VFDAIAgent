# Phase B3 — Station Hours per station · PROPOSAL

Discovery only. No code written. Read this, adjust it, then a build brief follows.

---

## 0. Three findings that change the brief's shape

Before answering the questions, three things the inspection turned up that the brief assumed otherwise.

### 0.1 Shifts do not live in `station_log`

The brief says *"`station_log` holds two things: station-hours shifts AND the ad-hoc 'Other work logged' entries."*

**Shifts live in `station_presence`.** Every writer confirms it:

| writer | inserts into |
|---|---|
| `station_check_in` (`slice1_training_geoverify.sql:82`) | `station_presence` |
| `geofence_arrive` (`geofence_g2_rpcs.sql:100`) | `station_presence` |
| `slice7b3_offsite_checkin.sql:130` | `station_presence` |
| `geofence_g4l1_shift_length_guard.sql:174` | `station_presence` |

`station_log` is referenced in exactly one component — `StationDuties` — for the ad-hoc work log, plus a delete and an insert on the same screen. The in-file comment at `App.jsx:16324` says as much: history buckets *"checklist completions (`duty_log`) and other work (`station_log`)"*. No shifts.

### 0.2 Therefore the write side is **not** already correct

The brief hoped *"the B1 trigger already stamps the active station — if yes, the write side may already be correct."*

**Phase A never touched `station_presence`.** It added `station_id` to `apparatus`, `equipment`, `duties`, `station_log` — four tables, and that table is not among them. There is no `station_id` column on `station_presence`, no backfill, and no trigger. Every shift ever recorded, and every shift recorded today, has **no station attribution at all**.

That makes B3 structurally larger than "add filters": it needs its own Phase-A-shaped pass (column + backfill + trigger) before any filter has something to filter on.

### 0.3 There is no two-reader inconsistency

Question 5 asks to resolve `station_log` being *"read filtered (work log) and unfiltered (shift lists)."*

That inconsistency **does not exist**, because the shift lists never read `station_log`. It has exactly one reader, and B2 scoped it. The table is consistent today.

> **Correction I owe:** the comment I wrote in B2 at `App.jsx:16124` says *"station_log ALSO holds station-hours shifts, and those lists are deliberately left alone — they are B3."* That is **wrong** — I wrote it from the brief's premise without verifying. It should be corrected in the B3 build regardless of what else we do. Flagging it as my error rather than letting it sit.

---

## 1. Attribution on check-in

**Current state:** `station_check_in` inserts `(department_id, member_id, verified, source, kind, session_id)`. `geofence_arrive` inserts `(department_id, member_id, verified, source, kind, checked_in_at)`. Neither can carry a station because the column does not exist.

**Minimal change:** mirror Phase A exactly, on one table.

1. `ALTER TABLE station_presence ADD COLUMN station_id uuid REFERENCES stations(id)` — nullable.
2. Backfill existing rows to their department's default station.
3. Add the **existing** `set_default_station_id()` trigger (BEFORE INSERT) to `station_presence`.

Step 3 is the whole point: that function was upgraded in B1 to prefer `my_active_station_id()`, with the department guard. Attaching it means `station_check_in` and `geofence_arrive` both become station-aware **with no change to either RPC** — the same trick that made duties work in B1 without touching `create_duty`.

**Recommendation: do this in B3.** It is the smallest possible change, reuses a function already proven on four tables, and leaves both check-in RPCs byte-identical.

**One caveat worth deciding:** a geofence arrival fires from a background daemon, where `my_active_station_id()` resolves through `auth.email()`. If the daemon's session context differs, arm 1 misses and it falls back to the default station — correct, but a geofenced multi-station department would attribute every automatic arrival to the default house. That is acceptable in B3 (geofencing is per-department until Phase D) but should be **named as a known limit** rather than discovered later.

---

## 2. `is_at_point` / `is_at_station` verification

**Current state:** `station_check_in` calls `is_at_station(v_dept, p_lat, p_lng, p_accuracy)`, which reads `departments.station_lat / station_lng / station_radius_m` with a 400 m fallback.

**Recommendation: defer to Phase D. Do not touch it in B3.**

Reasoning:

- Changing what verification compares against **changes whether a shift is credited**, and credited hours feed ISO/LOSAP. That is a compliance-visible behaviour change, not a UI filter, and it violates B3's own principle.
- Phase A copied `lat/lng/radius` onto each `stations` row precisely so this cut-over has data waiting. The copy was explicitly *not* a move — the geofence still reads `departments` until Phase D.
- Doing it in B3 would mean a department with two houses suddenly fails verification at the second one **until** Phase D also moves the geofence, so the two must land together.

B3 makes a shift *say which house it belongs to*. Phase D makes the app *verify you were at that house*. Those are different promises and should ship separately.

---

## 3. Which reads scope, which stay department-wide

| RPC | Disposition | Why |
|---|---|---|
| `my_station_shifts` | **Client-side filter, opt-in toggle** | A member's own hours are *theirs*, and their LOSAP total is a department figure. Silently showing only the active station would under-report their year and look like lost hours. Proposal: keep the RPC unchanged, return all, and let the screen show a per-station breakdown with the department total still headline. |
| `dept_on_station_now` | **Scope to active station** | "Who is on now" is a question about a building. Answering it across three houses is actively misleading — you would staff on a number that includes people twelve miles away. Strongest case for scoping in the whole subsystem. |
| `dept_station_shifts` | **Unchanged in B3** | Leadership report. Per-station breakdown is Phase E. |
| `dept_iso_hours` | **Unchanged in B3** | ISO/LOSAP figure. Touching it changes a compliance number. Phase E. |

The asymmetry is deliberate: **operational** views scope to the house; **record/compliance** views stay department-wide until Phase E gives them an explicit per-station-with-roll-up design.

---

## 4. The B3 / Phase E line

**In B3:**
- `station_presence.station_id` — column, backfill, trigger
- `dept_on_station_now` scoped to the active station
- Station Hours screen shows which station a shift belongs to
- Fix the incorrect B2 comment

**Deferred to Phase D:** per-station geofence verification, per-station `is_at_station`, auto-close ↔ fence interaction.

**Deferred to Phase E:** `dept_station_shifts` / `dept_iso_hours` per-station reporting with department roll-up, per-station ISO/LOSAP, CSV/PDF changes.

**The line, stated once:** B3 changes *what a shift is labelled with* and *which shifts an operational screen shows*. It does not change *whether a shift is credited*, *how many hours it is worth*, or *what any report totals*. If a proposed change would alter a number on a compliance report, it is not B3.

---

## 5. The two-reader inconsistency

Does not exist — see §0.3. `station_log` has one reader, already scoped in B2.

**Action in B3:** correct the wrong comment at `App.jsx:16124`. No code change.

---

## 6. Auto-close ↔ geofence

**Inspected:** `slice5_autoclose_*`, `slice6_autoclose_review`, `geofence_g4l1_shift_length_guard`, `geofence_depart`.

The standing requirement — when geofencing is on, the fence's real depart time is the checkout rather than a timed cap, with a backstop for a shift that never reports a departure — is **Phase D**, and B3 should touch none of it.

**What B3 must not do:**
- not change `geofence_depart`, the auto-close sweeper, or the shift-length guard
- not change `auto_closed` semantics or which shifts are credited

**One interaction to note now:** once `station_presence` carries `station_id`, an auto-closed shift will carry one too, and the "needs review" screen will be able to show which house it was at. That is a *free* improvement from the column existing — no auto-close logic changes. Worth confirming it reads through, and nothing more.

**And a standing rule that still holds:** never auto-re-credit an `auto_closed` shift. Adding a station label does not change that.

---

## 7. Migration shape

One file, `sql/stations_phaseB3.sql`, `BEGIN`/`COMMIT`, precondition-asserted like Phase A:

```
ALTER TABLE station_presence ADD COLUMN IF NOT EXISTS station_id uuid REFERENCES stations(id);
UPDATE  station_presence  SET station_id = <department default>  WHERE station_id IS NULL;
CREATE TRIGGER trg_station_id_station_presence BEFORE INSERT ON station_presence
  FOR EACH ROW EXECUTE FUNCTION public.set_default_station_id();
```

Plus, if `dept_on_station_now` is scoped server-side, a `CREATE OR REPLACE` of that one function built from its **live** `pg_get_functiondef` — captured before, diffed after.

**No `NOT NULL`** in B3 (Phase B-later, once every path is proven). **No `ON DELETE` action** on the FK, matching Phase A: a station cannot be deleted while shifts point at it.

---

## 8. Client changes

- Station Hours screen: show the station on each shift row, and scope "on station now."
- Member's own hours: per-station breakdown, **department total stays the headline**.
- Correct the B2 comment.

Everything else on that screen unchanged.

---

## 9. The single-station invariant

Holds by the same argument as A/B1/B2, and it is worth writing out because it is the whole safety case:

1. One station ⇒ it is the default.
2. The backfill stamps every existing `station_presence` row with that default.
3. The trigger stamps every new one — arm 1 (active station) and arm 2 (default) resolve to the *same* station when there is only one.
4. Any `.eq(station_id, active)` therefore matches every row.
5. `dept_iso_hours` and `dept_station_shifts` are untouched, so **no credited number moves**.

Point 5 is the one that matters most: B3 cannot change anybody's hours, because it does not touch the functions that compute them.

---

## 10. Rollback

```
DROP TRIGGER trg_station_id_station_presence ON public.station_presence;
ALTER TABLE public.station_presence DROP COLUMN station_id;
-- and, if dept_on_station_now was replaced, restore it from the captured pg_get_functiondef
```

Fully additive apart from that one function, which is why its before-capture is mandatory.

---

## 11. What I need before building

1. **Ruling on §3** — particularly `my_station_shifts`. My recommendation (keep the department total as headline, add a per-station breakdown) is a product judgement about whether a member's hours read as "mine" or "mine here", and that is yours to make.
2. **Confirmation that §2 defers** — per-station verification waits for Phase D.
3. **Live `pg_get_functiondef` for `dept_on_station_now`**, and for `my_station_shifts` if we scope it — neither is in `sql/` in current form, and both must be built from the live body.
4. **Before-capture** of anything §7 touches, for the untouched-proof.
