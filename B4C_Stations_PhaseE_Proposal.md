# Phase E — Per-station Station Hours reporting · PROPOSAL

Discovery only. No code written, no migration drafted. Read this, adjust it, then a build brief follows.

**The standing limit, stated once.** I read the repo's SQL, not the live database — only the anon key is here, and every function in scope is `is_leadership()`-gated. That matters more in E than in any previous phase, because `training_hours_c2_officer_attested_credit.sql:6-9` says outright that *"the repo files lag the database, and rebuilding `dept_iso_hours` from slice3 is exactly what produced the superseded Part B, which would have stripped the kind filter off a live function."* §9 lists the captures I need before a build brief is safe to write.

---

## 0. Findings that change the brief's shape

### 0.1 `dept_iso_hours` is a **union of intervals**, not a sum — so buckets cannot sum to it

This is the finding that most changes E, and it lands directly on the brief's invariant *"every credited hour in exactly one bucket; buckets sum to the total."*

`dept_iso_hours` clips each interval to the period, then **de-overlaps per member with `range_agg`** (`training_hours_c2:325-341`):

```sql
agg as (
  select c.mid,
         range_agg(c.span) filter (where c.is_training) as training_mr,
         range_agg(c.span)                              as all_mr
  from live c group by c.mid
)
```

A member with a standby shift at House A from 08:00–12:00 and a training span at House B from 10:00–11:00 contributes **one merged four-hour span**, not five hours. That is deliberate and correct — a minute a person stood somewhere is one minute of ISO credit however many rows describe it.

But it means the department ISO total is **not** the sum of any per-house partition of it. Split that member by house and you get 4 h at A plus 1 h at B = 5 h, against a department total of 4 h. The excess is exactly the overlap, and it belongs to two houses at once.

**So the brief's bucket-sum invariant is satisfiable for Credited and mathematically unsatisfiable for ISO**, unless we adopt an attribution rule that assigns each de-overlapped minute to exactly one house. §1 proposes one, and notes why it would almost never bind in practice.

### 0.2 A whole branch of credited hours has **no station at all** — structurally, not historically

The brief anticipates *"some historical rows may have a null `station_id`."* The reality is the other way round.

`dept_station_shifts` is a **UNION of two branches** (`training_hours_c2:177-221`):

| branch | source | carries `station_id`? |
|---|---|---|
| **A — observed** | `station_presence` | yes — B3 backfilled, the trigger stamps new rows |
| **B — officer-attested** | `attested_training(dept, from, to)` → `session_attendance` → `training_sessions` | **no — the column does not exist** |

`attested_training()` returns `(member_id, session_id, start_at, end_at, optional)` (`training_hours_c1:49-55`) — no station. And `training_sessions` has no `station_id`: Phase A stamped `apparatus`, `equipment`, `duties` and `station_log`, and that table is not among them.

Two consequences:

- **Branch A's null count is probably zero.** B3 backfilled every `station_presence` row and its verify expects `still_null = 0`; the trigger stamps every new one.
- **Every attested-training hour is Unassigned by construction**, and for a department that credits a lot of drill time that is not a rounding error — it could be a large share of the Credited total.

An "Unassigned" bucket is therefore not a tidy-up for stragglers. It is a real, permanent, possibly-large category, and the UI has to explain what is in it rather than imply someone forgot to configure something.

**Fixing it properly is a schema change** — `training_sessions.station_id` plus a backfill and a trigger, exactly Phase A's shape on one more table. That is a decision, not a detail; see §9 q3.

### 0.3 Credited and ISO use **different window semantics**, and already disagree on purpose

`dept_station_shifts` filters on `checked_in_at >= p_from and < p_to` and counts each shift **whole**. `dept_iso_hours` filters on **overlap** and **clips** to the window. The client already documents this and renders the difference as a neutral delta rather than calling it "overlap removed" (`App.jsx:10421-10427`).

E must not quietly pick one. Two per-station breakdowns built on different window rules will not reconcile with each other, and the first person to add them up will file a bug.

### 0.4 `c2` may not be live, and its shape decides the work

`training_hours_c2_officer_attested_credit.sql:4` says **"NOT YET APPLIED."** If that is stale, `dept_station_shifts` returns **11** columns including `officer_attested`, and branch B reads `attested_training`. If it is accurate, it returns **10** and branch B derives inline at full drill length (`training_hours_c2_ROLLBACK.sql:23-30`).

Either way E is a DROP + CREATE on that function, so I must reproduce the live body exactly. This is q1 in §9 and it blocks the build brief, not this proposal.

### 0.5 `c2` already solved the grant problem I got wrong twice

`training_hours_c2:237-249` captures the live ACL into a GUC before the DROP and **replays it** afterwards, raising if the capture is missing. That is strictly better than restating grants from memory — which is exactly how I dropped `service_role` in D1 and again in D2a, both caught by your reviewer rather than by me.

**E should reuse that pattern for every DROP + CREATE**, and I would not write another grant block by hand in this codebase.

---

## 1. `dept_iso_hours` per-station without moving the total

**Recommendation: do not touch `dept_iso_hours`.** It is the official number, it is `CREATE OR REPLACE`-able but there is no reason to take the risk, and leaving it byte-identical is the cheapest possible proof that the total did not move.

Add a companion read: **`dept_iso_hours_by_station(p_from, p_to)`**, returning `(member_id, member_name, station_id, station_name, training_hours, standby_hours, iso_total_hours)`.

The design question is what it does about §0.1. Two honest options:

### Option A — per-house de-overlap, sum ≥ department total

De-overlap **within each house**. Every house's number is internally correct: "this member accrued N ISO hours at this house." Where a member overlapped two houses, the house figures sum to more than the department total, and the report says so in a line under the breakdown.

- *For:* no invented attribution; each figure means exactly what it says.
- *Against:* the breakdown does not reconcile with the headline, which is the first thing a chief will try.

### Option B — attribute each de-overlapped minute to one house (**recommended**)

De-overlap per member exactly as `dept_iso_hours` does, then assign every resulting minute to a single house by a deterministic rule — **the house of the span that covers that minute and started earliest**; ties broken by `station_id` so it is stable across runs.

- *For:* buckets sum to the department total, exactly. The brief's invariant holds, and the headline reconciles.
- *Against:* a minute where two houses genuinely overlap is credited to one of them. That is a modelling choice and must be stated in the report's provenance text, next to the existing ISO/Credited explainer.

**Why I recommend B despite the modelling cost:** the case it fudges is close to unreachable today. A member cannot hold two open `station_presence` rows — `geofence_arrive`'s already-open check and `station_check_in`'s identical guard both prevent it — so two *observed* spans at two houses cannot overlap. The remaining overlap source is branch B attested training against a standby shift, and **branch B has no house at all**, so it never competes for attribution. The rule would almost never bind; defining it is about being correct when it does, not about a common case.

Either way, `dept_iso_hours` itself is untouched, so the official total is protected by the strongest available argument: nothing changed.

---

## 2. `dept_station_shifts` — the station column

Add `station_id uuid` and `station_name text`. Return shape widens → **DROP + CREATE** → ACL captured and replayed per §0.5.

- **Branch A:** `left join public.stations st on st.id = sp.station_id`.
- **Branch B:** `null::uuid as station_id, null::text as station_name` — literals, no join at all.

**Why the join cannot drop a row.** A `LEFT JOIN` preserves every left row unconditionally: `sp.station_id` null produces one output row with nulls, and a `station_id` pointing at a since-deleted station does too. Neither is possible to lose. An `INNER` join would silently drop both classes and take their credited hours with them — the B3b lesson, proven there with 59 = 59 / 565.26 = 565.26, and the same proof applies here.

**The row-count proof for E:** branch A output rows = branch A input rows (LEFT join property); branch B rows are untouched and gain two literal columns. So `count(*)` and `sum(hours)` are invariant by construction, and the before/after check in §7 confirms it empirically rather than resting on the argument alone.

---

## 3. The Unassigned bucket

Per §0.2 this is a real category, not a straggler bin. Two distinct populations land in it:

1. **Branch B — attested training.** Permanent under today's schema. Possibly large.
2. **Branch A with a null `station_id`.** Expected to be zero; worth confirming rather than assuming (§9 q2).

**Every credited hour lands in exactly one bucket, provably**, for Credited: the breakdown is `GROUP BY coalesce(station_id, <unassigned sentinel>)` over a plain per-row sum. A partition on a single expression is exhaustive and disjoint by definition, so the buckets sum to the total identically. That is the strong version of the brief's invariant and it holds for Credited without qualification.

For ISO it holds **only under Option B** in §1, and by construction of the attribution rule rather than by partition.

**The UI must name what is in it.** "Unassigned" reading as a configuration failure, when it is mostly attested training that was never recorded at a house, would send a DA hunting for a setting that does not exist. Proposed wording: *"Not recorded at a house — mostly officer-attested drill time, which is credited to the department rather than to a station."*

---

## 4. "Who's at which house"

The human-facing payoff, and the cleanest part of E because it touches no credited number.

`dept_on_station_now` is currently scoped to the **active** station and fails open when the active station cannot be resolved (`stations_phaseB3:160-163`). That is the right behaviour for the operational "my house right now" view and **it stays exactly as it is**.

Add **`dept_on_station_now_all()`** — same `is_leadership()` gate, same distinct-on-member shape, no station filter, plus `station_id` and `station_name` via a LEFT join. The client groups by house.

- New function rather than widening the existing one: `dept_on_station_now` has a live caller (`App.jsx:10298`) and B3's scoping is deliberate.
- This is a **view**, not a report. It reads presence rows; it computes no credited total and feeds no compliance figure.

The D/E line drawn in the D proposal put exactly this in E, and it lands here unchanged.

---

## 5. The compliance boundary

**Feeds the official ISO/LOSAP number — additive reads only, do not modify:**

| function | disposition |
|---|---|
| `dept_iso_hours` | **untouched.** New companion instead. |
| `attested_training` | **untouched.** Feeds both ISO and Credited; the cap and the four gates live there. |

**Compliance-adjacent — published as "Credited", changed carefully:**

| function | disposition |
|---|---|
| `dept_station_shifts` | DROP + CREATE for two appended columns; ACL captured and replayed. Semantics identical. |

**Operational — safe to extend:**

| function | disposition |
|---|---|
| `dept_on_station_now` | untouched |
| `dept_on_station_now_all` | **new** |
| `my_station_shifts` | untouched — B3b already gave it `station_id` / `station_name` |

**Untouched and verified so:** `my_department_id`, `my_member_id`, the `is_*` family, `set_default_station_id`, `my_active_station_id`, `geofence_arrive`, `geofence_depart`, `station_check_in`, `auto_close_stale_shifts`.

---

## 6. Client UI

**The department total stays the headline.** The breakdown is an enhancement beneath it, never a replacement.

- **Under the ISO/Credited tiles:** a per-house breakdown panel — one row per house, plus a trailing **Unassigned** row with the explanatory line from §3. Under Option B it foots exactly to the headline, and the panel says so.
- **Shift log:** a station column, and a station filter chip row reusing the **"All stations"** grouped pattern already shipped for Apparatus, Equipment and Station Duties (`97d0d73`) — same idiom, so it reads as the same product.
- **Who's on now:** grouped sections per house, each with its own count; houses with nobody on station still shown, so an empty house reads as "nobody there" rather than as missing data.
- **Single-station departments:** the breakdown panel renders one section identical to the headline, or is suppressed entirely — my preference is to suppress it, because a "breakdown" with one row that repeats the total above it is noise. Same test B1 used: `my_stations()` returning one row hides the picker.

---

## 7. Migration shape and the proof

One file, one transaction:

0. **Preconditions** — assert the live `dept_station_shifts` shape (10 vs 11 columns, per §0.4), that `stations` exists, and that `dept_iso_hours` is present and *not* being modified.
1. **Capture the ACL** of `dept_station_shifts` into a GUC (the c2 pattern).
2. `DROP` + `CREATE` `dept_station_shifts` with the two new columns.
3. **Replay the ACL**, raising if the capture is missing.
4. `dept_iso_hours_by_station()` — new, grants explicit.
5. `dept_on_station_now_all()` — new, grants explicit.
6. `COMMIT` / `NOTIFY pgrst, 'reload schema'`.

**The before/after proof.** Both report RPCs are `is_leadership()`-gated and raise `Not authorized` in the SQL editor, so the capture has to be either run from the app while signed in as leadership, or taken against base tables. The base-table version — the same substitute that worked in D2a:

```sql
SELECT count(*) AS closed_shifts,
       round(sum(extract(epoch from (checked_out_at - checked_in_at)) / 3600.0)::numeric, 2) AS total_hours
  FROM public.station_presence
 WHERE checked_out_at IS NOT NULL AND kind IN ('standby','training');
```

That covers branch A only. Branch B has no base table to sum this way, so the **authoritative before/after must be taken from the app as leadership** — `dept_iso_hours` and `dept_station_shifts` over the same window, before and after, diffed. I would not sign off E on the base-table substitute alone.

---

## 8. Rollback

- `dept_station_shifts` — restore from the pre-apply `pg_get_functiondef` capture, then re-grant. `training_hours_c2_ROLLBACK.sql` is the model, and is itself a reminder that a half-applied DROP + CREATE leaves the app erroring on a function that no longer exists.
- The two new functions — `DROP FUNCTION`; nothing reads them until the client ships.
- `dept_iso_hours` — nothing to roll back, because nothing is done to it. That is the point of §1.
- No data migration, so no data rollback — unless q3 is answered "yes", which adds a column and a backfill and needs its own capture.

---

## 9. What I need before writing the build brief

1. **The live bodies.** `pg_get_functiondef` for `dept_station_shifts`, `dept_iso_hours`, `dept_on_station_now`, and `attested_training`. The first two are blocking: E rebuilds one and must not disturb the other, and c2's header is explicit that reconstructing from `sql/` has already produced a wrong version once.
2. **Is `c2` live?** Equivalently: does `dept_station_shifts` return 10 columns or 11? Also `SELECT count(*) FROM station_presence WHERE station_id IS NULL;` — expected 0, and §3 rests on it.
3. **Should `training_sessions` gain a `station_id`?** This decides whether Unassigned is a permanent category or a transitional one. It is Phase A's shape on one more table (column, backfill, trigger) and would let attested training attribute to a house. **My recommendation: not in E.** E is a reporting phase; adding a column that changes how a compliance-adjacent number is attributed belongs in its own phase with its own before/after. But E's UI copy depends on the answer, so I need it either way.
4. **Option A or Option B in §1?** I recommend B — buckets that foot to the headline, with a stated attribution rule that today is nearly unreachable. A is defensible if you would rather never invent an attribution at all.
5. **Confirm the window semantics** (§0.3): the per-station breakdown should follow **Credited** semantics (whole shifts, start-in-period) for the shift-log breakdown, and **ISO** semantics (clipped, overlap) for the ISO breakdown — i.e. each breakdown matches the number it sits under. Confirm that is what you want rather than one rule for both.
6. **Suppress or show** the one-row breakdown for single-station departments (§6). I lean suppress.
