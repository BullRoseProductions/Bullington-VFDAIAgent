# Phase D — Per-station geofencing · PROPOSAL

Discovery only. No code written, no migration drafted. Read this, adjust it, then a build brief follows.

**A limit on this document, stated once.** I read the repo's SQL files, not the live database — I have only the anon key locally. Per the standing rule (`schema.sql` is stale; migrations are applied by hand), a file in `sql/` is evidence of intent, not proof of what is running. Everywhere it matters below I name the exact `pg_get_functiondef` to run instead of asserting. §11 collects them.

---

## 0. Five findings that change the brief's shape

### 0.1 The station geo columns are not named what the brief calls them

The brief says Phase A backfilled `stations` with *"`station_lat`, `station_lng`, `station_radius_m`, `geofence_enabled`."*

On `stations` they are **`lat`, `lng`, `radius_m`, `geofence_enabled`** (`stations_phaseA.sql:99-102`). The `station_*` names belong to **`departments`**. The two sets are different columns on different tables, and every geofence read today goes to the departments one.

Cosmetic on its face; not cosmetic in a migration that has to name columns exactly.

### 0.2 The per-station geo columns have **zero readers**

The brief's premise — *"the storage for per-station fences already exists"* — is true. What it does not say is that nothing has ever read it.

| column set | written by | read by |
|---|---|---|
| `stations.lat / lng / radius_m / geofence_enabled` | Phase A backfill (`stations_phaseA.sql:160-167`), `pa_create_department` (Phase C, just landed) | **nothing** |
| `departments.station_lat / station_lng / station_radius_m` | the department settings screen | `is_at_station()` (`slice1_training_geoverify.sql:43`), `geofence_arrive` (`geofence_g2_rpcs.sql:73`), the client fence registration (`App.jsx:1858`, deps at `:1892`) |
| `departments.geofence_enabled` | `pa_set_geofence_enabled` | `geofence_arrive`'s gate, the client effect gates (`App.jsx:1830, 1855`) |

So D is not "switch the readers over to columns that are already correct." It is "write the first readers those columns have ever had," and that makes their **freshness** an open question rather than an assumption — see 0.3.

### 0.3 Those columns are a **point-in-time copy**, and they can already be stale

Phase A copied the department's pin into the default station **once**. `pa_create_department` copies it again at creation. Nothing keeps them in step afterwards.

Two concrete staleness paths, both reachable today:

- **The pin.** An officer corrects `departments.station_lat/lng` on the settings screen. `stations.lat/lng` still holds the old value. Cut verification over to the station row and a member standing at the corrected pin verifies `false`.
- **The switch.** `pa_set_geofence_enabled` writes `departments.geofence_enabled` only (`pa_geofence_toggle.sql:86`). A department that opted in *after* its Phase A backfill has `stations.geofence_enabled = false` on its own default house. Gate the fence on the station flag and that department's geofencing silently stops.

**D must therefore include a resync, and the resync needs a decided direction of truth.** This is question 3 in §11 and it is the one I most need answered before building.

### 0.4 Houses 2..N have **no coordinates at all**, and no way to get any

`pa_add_station(p_department_id, p_name, p_label, …)` (`stations_phaseB2_pa_add.sql:42`) sets no coordinates. `pa_update_station(p_station_id, p_name, p_label, address…)` (`stations_pa_manage.sql:103`) sets none. `pa_department_stations` returns `(station_id, name, label, address, is_default, is_active)` — no geo. The DA-side station form in `App.jsx` is `{name, label, address}`; I added an address field to the PA create form in Phase C and no pin.

So in a multi-station department today, **only the default house has a pin.** Every other house has `lat`/`lng` null.

This is the finding that most changes D's size. Per-station fencing is not merely unwired — for houses 2..N there is nothing to wire. **A per-station pin editor is not a nice-to-have in D; it is a precondition for D doing anything at all in the multi-station case.**

### 0.5 `my_stations()` returns no coordinates, so the client cannot register per-station fences

`my_stations()` returns `(station_id, name, label, is_default, is_active)` (`stations_phaseB1.sql:103`). The client has no path to per-station coordinates at all — the fence is registered from the `dept` object (`App.jsx:1858`).

D needs a read for this. I propose a **new** `my_station_fences()` rather than widening `my_stations()`, because the latter is the B1 picker's function and widening it means DROP + CREATE on something three screens call. New function, no overload, nothing existing touched.

---

## 1. Fence identity — native region event → `station_id`

**Can the wrapper watch several regions?** Yes. The plugin is `@transistorsoft/capacitor-background-geolocation` (`geofence.js:128`), which exposes `addGeofence` / `addGeofences` and delivers an `identifier` on every event. The identity channel already exists and **we are currently discarding it**:

- `STATION_FENCE_ID = "b4c-station"` — one constant, one fence (`geofence.js:411`).
- `handleGeofenceEvent(evt)` reads `evt.action`, `evt.timestamp`, `evt.location.coords` — **never `evt.identifier`** (`geofence.js:465-507`).
- `persistedToEvent` already *extracts* `identifier` from the replay queue (`geofence.js:536`) and nothing downstream consumes it.

**The proposed path, end to end:**

```
stations row ──► my_station_fences() ──► addGeofence({ identifier: `b4c-station:${station_id}`, … })
                                              │
                                       OS fires DWELL/EXIT
                                              ▼
                        onGeofence(evt) ──► evt.identifier ──► parse station_id
                                              ▼
                    geofence_arrive(p_lat, p_lng, p_accuracy, p_at, p_station_id)
                                              ▼
                    server VALIDATES the hint, re-verifies coords, stamps station_id
```

**The identifier is a hint, never an authority.** That is the G2 trust model unchanged: *"the phone says 'I crossed the fence'. That is a claim, not evidence"* (`geofence_g2_rpcs.sql:9-13`). A rooted device can name any station. So server-side, in order:

1. `p_station_id` given **and** it belongs to `my_department_id()` → use it.
2. Otherwise → resolve server-side to the **nearest** station in the department that has a pin and is within its own radius of `(p_lat, p_lng)`.
3. Otherwise → leave `station_id` null and let the B3 trigger stamp it exactly as today.

Arm 3 is what makes this safe to ship: every path that fails falls through to current behaviour rather than to an error.

**Platform ceiling, flagged not solved:** iOS monitors at most 20 regions per app process. A department with more than 20 houses would need the SDK's proximity-ring approach. No department here is near that; I am naming it so it is a known bound rather than a surprise. **Verify the plural-registration API on a device** rather than trusting my reading of the SDK.

---

## 2. Arrival attribution — the minimal change

**Current:** `geofence_arrive` inserts `(department_id, member_id, verified, source, kind, checked_in_at)` with no `station_id`; the B3 trigger then stamps `my_active_station_id()`, which for a background daemon usually resolves to **the department's default house** — the limit B3 named in advance (`stations_phaseB3.sql:34-39`).

**Proposed:** add a trailing `p_station_id uuid DEFAULT NULL` and set `station_id` explicitly when it resolves.

**This is DROP + CREATE, not CREATE OR REPLACE.** Adding a parameter overloads rather than replaces, and a four-argument call would keep resolving to the old body — the exact lesson Phase C just paid for (`phaseC_pa_onboarding.sql:232-237`). Grants must be re-established on the five-argument signature.

**Single-station no-op, mechanically:** one station is the default; it is the only fence registered; the hint resolves to it; the B3 trigger would have stamped that same station anyway. Identical row, by construction rather than by luck.

**The `geofence_enabled` gate.** I propose the department flag stays the **master switch** (it is PA-controlled and is the opt-in that pays for the feature) and `stations.geofence_enabled` becomes the **per-house switch**, with the effective gate being both. Given 0.3, D's migration must resync the station flag or a currently-fenced department silently loses its fence on the day D lands.

---

## 3. Manual verification — before / after

**Before** (`slice1_training_geoverify.sql:81`):

```sql
v_verified := public.is_at_station(v_dept, p_lat, p_lng, p_accuracy);
--                                 ^^^^^^ reads departments.station_lat/lng/radius_m
```

**After** (shape, not final text):

```sql
v_station := public.my_active_station_id();
select lat, lng, radius_m into v_slat, v_slng, v_srad
  from stations where id = v_station;

if v_slat is not null and v_slng is not null then
  v_verified := public.is_at_point(v_slat, v_slng, v_srad, p_lat, p_lng, p_accuracy);
else
  v_verified := public.is_at_station(v_dept, p_lat, p_lng, p_accuracy);   -- unchanged fallback
end if;
```

Three deliberate properties:

- **`is_at_station` itself is NOT touched.** It is also called by `member_check_in` for training geo-verification. Changing it would move training verification, which is not D's business and collides with the "off-site is a training concept" line. Only `station_check_in`'s *use* of it changes.
- **`is_at_point` is the existing generic primitive** (`slice7_offsite_training_location.sql:43`) — already `IMMUTABLE`, already revoked from everyone, already the thing `geofence_arrive` verifies with. No new helper.
- **A house with no pin falls back to the department**, so 0.4's coordinate-less houses degrade to exactly today's behaviour instead of verifying `false` for everyone.

**Single-station no-op argument:** the default station's coords were copied from the department, so `is_at_point(station)` ≡ `is_at_station(dept)` — **conditional on the resync in 0.3**. Without it this is the branch that silently starts failing verification for a department that moved its pin. That is why the resync is load-bearing and not tidying.

---

## 4. Auto-close ↔ the fence — the crux, and a locked rule in the way

### 4.1 The three mechanisms today

| mechanism | closes at | flags | file |
|---|---|---|---|
| `geofence_depart` | the EXIT event time; capped at `checked_in_at + max_shift_hours` | `auto_closed` only when capped or out-of-order | `geofence_g4l1_shift_length_guard.sql:213` |
| `auto_close_stale_shifts()` (pg_cron) | `checked_in_at + max_shift_hours`, **blind to the fence** | always `auto_closed` | `slice5_autoclose_guardrail.sql:104` |
| review queue | a human's answer | clears it | `slice6_autoclose_review.sql` |

### 4.2 The collision, precisely

The sweeper is time-based and knows nothing about fences. A legitimate 14-hour standby under a 10-hour cap plays out:

```
08:00  DWELL          → shift opens
18:00  cron sweep     → checked_out_at = 18:00, auto_closed = true      ← 10h, invented
22:00  EXIT fires     → geofence_depart WHERE checked_out_at IS NULL
                        → no match → returns NULL, by design
```

The fence recorded 14 hours. The row says 10, flagged, uncredited. **That is precisely the "auto-close invented a shorter shift than the fence recorded" failure the brief forbids** — and it is not hypothetical, it is the current code path the moment geofencing is switched on for a department whose members work past the cap.

### 4.3 The rule that blocks the obvious fix

The obvious fix is to let a late EXIT overwrite the auto-closed row. **It is not available.** The standing decision is that an `auto_closed` shift is never auto-re-credited — a late finalize was explicitly rejected, and only the needs-review screen may set the real out-time. `geofence_depart`'s `checked_out_at is null` guard is that decision expressed in code, and `slice5` names the same trade-off for the finalize trigger (`slice5_autoclose_guardrail.sql:91-98`).

So D cannot resolve this by writing a better `checked_out_at`. **I am not proposing to weaken that rule**, and if the answer is that it should bend for a fence-reported exit, that is your call to make explicitly rather than mine to assume — question 4 in §11.

### 4.4 What I propose instead: prevent, then preserve

**(a) Prevention — the sweeper stops firing early on fenced shifts.**

Give `auto_close_stale_shifts()` one branch: an open row with `source='gps_geofence'` whose house has geofencing on is swept at a **backstop** interval — longer than `max_shift_hours` — rather than at the cap. The cap remains what `geofence_depart` applies **when an exit actually arrives**; the sweeper's job narrows to what the brief asks of it, "still closes a shift that never reports a departure."

This keeps the locked rule fully intact, because the row is never auto-closed in the first place. It also keeps the sweeper deterministic and idempotent — it still closes at `checked_in_at + <interval>`, never `now()`, for the reason slice 5 gives.

Open decision: backstop as a new `departments.geofence_backstop_hours`, or a fixed multiple of the cap. I lean toward a column — a department that sets a 10-hour cap for manual shifts has said nothing about how long a phone may stay silent.

**(b) Preservation — the fence's evidence survives even when the sweeper wins.**

Add `station_presence.fence_exit_at timestamptz` (nullable). A late EXIT that finds an already-closed geofence row **does not touch `checked_out_at`** — it records the exit time in that column and returns. The review queue then shows the officer the machine's guess *and* the fence's actual reading, so resolving becomes confirming a known number instead of guessing one.

This is the piece that makes "never shrink" honest rather than aspirational: even in the residual case, the true departure is not thrown away — it is put in front of the human whose decision it is.

### 4.5 The no-shrink proof

**For existing data — trivially, and provably:**

1. D writes no `checked_out_at` anywhere. No backfill, no UPDATE on closed rows.
2. Every closed row is therefore byte-identical after the migration.
3. Open `gps_geofence` rows: **expected zero today** — G2's own verify note recorded 0 of 2 departments opted in, and `geofence_arrive` refuses outright when the department flag is off. To be confirmed on the live DB (§11 q2), not assumed.

**Going forward — by construction:**

4. The backstop interval is **≥ `max_shift_hours`**, never below. So no shift closes earlier than it closes today.
5. `geofence_depart`'s cap logic is unchanged for the in-cap case: a real exit still closes at the real exit time.
6. Path (b) only ever *adds* a column value; it can move no credited hour by itself.

**How it gets shown, in the B3 discipline:** capture `dept_iso_hours(date_trunc('year',now()), now())` and `count(*), sum(hours)` from `dept_station_shifts` before applying, re-run after, diff. Plus the count of open `gps_geofence` rows before and after.

---

## 5. Compliance boundary

**Touched by D:**

| function | disposition |
|---|---|
| `geofence_arrive` | DROP + CREATE — new trailing `p_station_id` |
| `geofence_depart` | CREATE OR REPLACE — same signature; backstop-aware, records `fence_exit_at` |
| `auto_close_stale_shifts` | CREATE OR REPLACE — fenced-row branch |
| `station_check_in` | CREATE OR REPLACE — same signature; verifies against the active house |
| `dept_shifts_needing_review` | CREATE OR REPLACE *or* DROP + CREATE — depends on whether `fence_exit_at` is surfaced as a new column (it should be) |
| `my_station_fences` | **new** |
| per-station pin write path | new, or DROP + CREATE on `pa_update_station` |

**Untouched, and each one verified by diffing `pg_get_functiondef` before and after:**

`dept_iso_hours` · `dept_station_shifts` · `my_station_shifts` · `dept_on_station_now` · `resolve_auto_closed_shift` · `void_auto_closed_shift` · `is_at_station` · `is_at_point` · `set_default_station_id` · `my_stations` · `my_active_station_id` · `set_active_station` · `my_department_id` · `my_member_id` · the `is_*` family.

**The one compliance-adjacent risk I want named, because it is not zero.** `verified` is not what `dept_iso_hours` excludes — that is `auto_closed` — but the client rollup splits credited from unverified on it (`slice5_autoclose_guardrail.sql:145-148`). §3 changes *what coordinates verification is measured against* for future rows. No existing row's `verified` is rewritten, so no past number moves; but a department whose station pin disagrees with its department pin would see the split shift for new shifts. That is another argument for the resync being part of D rather than after it.

---

## 6. The D / E line

**In D — make geofencing and attribution per-station:**

- per-station fences registered and routed by the fence that fired
- manual check-in verified against the active house
- auto-close respecting the fence, with the backstop
- the per-station pin editor, because 0.4 means D is inert without it

**Deferred to E — per-station *reporting*:**

- `dept_iso_hours` broken down by station
- a station column or filter on `dept_station_shifts`
- any cross-house "who is at which house" roll-up

`dept_on_station_now` is already scoped to the active station by B3 and **stays exactly as it is** in D — showing one house is current behaviour; showing all houses side by side is E.

**The test, stated so it settles arguments later:** if a change alters what a leadership report *shows or totals*, it is E. If it alters which house a row is *labelled with* or which coordinates a check is *measured against*, it is D. Adding `fence_exit_at` to the review queue is D by this test — the queue is an operational fix-it screen, not a compliance report, and the column is evidence for a human decision rather than a credited number.

---

## 7. Migration shape

One file, one transaction, in this order:

0. **Preconditions** — `stations.lat/lng/radius_m/geofence_enabled` exist; `station_presence.station_id` exists (B3); `set_default_station_id` is the B1 body; `is_at_point` exists; **and assert which `geofence_arrive` is live** before replacing it.
1. **The resync** (§0.3) — direction per §11 q3. Capture the pre-resync values first.
2. `ALTER TABLE station_presence ADD COLUMN fence_exit_at timestamptz` + comment.
3. Optional `departments.geofence_backstop_hours`.
4. `DROP` + `CREATE` `geofence_arrive` (5 args), grants re-established.
5. `CREATE OR REPLACE` `geofence_depart`.
6. `CREATE OR REPLACE` `auto_close_stale_shifts`.
7. `CREATE OR REPLACE` `station_check_in`.
8. `my_station_fences()` + grants.
9. The per-station pin write path + grants.
10. `dept_shifts_needing_review` surfacing `fence_exit_at`.
11. `REVOKE … FROM anon, public` / `GRANT … TO authenticated` on everything new; `COMMIT`; `NOTIFY pgrst, 'reload schema'`.

Migration before client, as always — the client will call `my_station_fences` by name and PostgREST 404s what it has not seen.

---

## 8. Client and native changes

**`src/geofence.js`:**

- `STATION_FENCE_ID` constant → `b4c-station:${station_id}` builder + a parser, and a prefix predicate.
- `fenceSignature` (one `lat|lng|radius` string) → a map keyed by station id, so re-registration is per-house and a pin correction on house B does not tear down house A's fence.
- `stopGeofence` and `isStationGeofenceActive` currently hardcode the single id (`:395`, `:746`) — both become prefix-based.
- `handleGeofenceEvent` reads `evt.identifier` and passes `p_station_id`.
- `persistedToEvent` already carries `identifier` through — **verify on a device that the SDK actually persists it**, because the replay path is where this would fail silently.
- `startStationGeofence({ dept })` → takes the fence list.

**`src/App.jsx`:**

- load `my_station_fences()` alongside the existing station context.
- the effect's dependency array (`:1892`) is keyed on `dept.station_lat/lng/radius_m` — it becomes a stable digest of the fence list, or a pin correction on any house re-registers nothing.
- the DA station form gains pin fields (0.4).

---

## 9. The single-station invariant

Every branch D introduces is a no-op for a one-station department, by construction:

| D branch | single-station outcome |
|---|---|
| N fences registered | one station → one fence, same pin, same radius |
| routing by `evt.identifier` | the only identifier is the default house |
| `p_station_id` on arrive | resolves to the station the B3 trigger would have stamped |
| verification against the active house | the active station *is* the default, whose coords were copied from the department — **given the resync** |
| the sweeper backstop | backstop ≥ cap, so nothing closes earlier than today |
| `fence_exit_at` | a new nullable column; null changes nothing |

The one place the invariant depends on something rather than on structure is the resync, which is the third time this document has landed on that question.

---

## 10. Rollback

- **Functions:** revert each body from its pre-apply `pg_get_functiondef` capture. `geofence_arrive` needs `DROP FUNCTION …(5 args)` then recreate the 4-arg body and re-grant.
- **Columns:** `fence_exit_at` and `geofence_backstop_hours` drop cleanly — neither is read by anything credited.
- **The resync is the only irreversible step**, which is why step 1 captures the prior values into a scratch table in the same transaction. Without that capture there is no rollback for it, only a re-derivation.
- **Client/native:** revert `geofence.js` to the single-fence constant. The server tolerates it — `p_station_id` is defaulted and arm 3 falls through to the B3 trigger.

---

## 11. What I need before building

1. **Which `geofence_arrive` / `geofence_depart` is live?** `geofence_g4l1_shift_length_guard.sql:4` says *"NOT YET APPLIED. Review, then run by hand."* If that is stale, D builds on the g4l1 bodies; if it is accurate, the G2 bodies are live and §4 changes shape — the cap would not yet be in `depart` at all.
   `SELECT pg_get_functiondef('public.geofence_arrive'::regproc);` and the same for `geofence_depart`, `auto_close_stale_shifts`, `station_check_in`, `is_at_station`.
2. **How many departments have `geofence_enabled = true` today, and is any of them multi-station?** Also: `SELECT count(*) FROM station_presence WHERE source='gps_geofence' AND checked_out_at IS NULL;` — §4.5 step 3 rests on this being 0.
3. **Direction of truth for the pin.** Does D make `stations.lat/lng` authoritative and leave `departments.station_lat/lng` as a legacy fallback, or keep the department as master and mirror down on write? I lean to the former — per-station is where this is going, and two writable sources of one fact is the bug in 0.3. But it means the DA settings screen's pin field has to move to the station editor in D, which enlarges the client work.
4. **Does the "never auto-re-credit an `auto_closed` shift" rule bend for a fence-reported exit?** I propose **no**, with §4.4(b) as the compensation. If you want it to bend, say so explicitly and D gets simpler and riskier in one move.
5. **Is the D/E line in §6 where you want it?** Specifically: `fence_exit_at` appearing in the review queue — I have called that D; it is the one item that could reasonably be argued into E.
6. **Backstop shape** — new `departments.geofence_backstop_hours`, or a fixed multiple of `max_shift_hours`?

---

## 12. Verification plan

**Provable on web / in SQL, before any device exists:**

- every `pg_get_functiondef` before/after diff in §5
- single-station no-op: arrive with and without `p_station_id` resolves to the same row
- the hint is not trusted: pass another department's `station_id` → refused, falls to arm 2/3
- a house with no pin: check-in falls back to the department, does not verify false
- sweeper math: an open fenced row is not closed at the cap; an open **manual** row still is
- `fence_exit_at` written on a late exit while `checked_out_at` is untouched
- before/after `dept_iso_hours` and `dept_station_shifts` totals — identical
- the client registering N fences and their identifiers, inspectable without a real transition

**Genuinely needs a phone, a native build, and simulated locations:**

- that the OS fires enter/exit for **several** regions and reports the right `identifier`
- background and terminated-app delivery per house
- that the SDK **persists `identifier`** into the replay queue (the silent-failure candidate)
- the iOS When-In-Use → Always upgrade with multiple regions registered
- dwell behaviour where two houses are close enough for their radii to overlap
- battery cost of N fences vs one

**Sequencing I would suggest:** land the SQL and prove the whole first list on web with geofencing still off; then a single device on one department with two houses and simulated locations; then a real drive between houses before any other department is switched on.
