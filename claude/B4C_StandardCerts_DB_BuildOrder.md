# B4C — Standard Cert Pre-load (DB) — BUILD ORDER for CC

**Scope (locked Oct 22):** pre-load the standard Texas fire/EMS certs so departments pick them instead of typing them, with matching names across departments. Built on the **live** cert catalog (Slice A + B). The approved design (see [[B4C_StandardCerts_Draft_ForTommy]]) is a **shared master list + an "Add from the standard list" action that copies a chosen standard type into the department's own catalog** — this is deliberately chosen so it **does NOT alter `cert_types`' shape, the four cert-type RPCs, the readers, or any gating** we just reviewed. Additive only; `verified` never touched; standard discipline.

**Heads-up on the data:** the seed list below is from the official sources, but the `never_expires` flags are **proposed defaults that Tommy will review after this ships**. That's fine by design — the seed is plain reference data, correctable later by a follow-up migration **without touching any department's catalog** (a department's copies are independent rows once added). Build the mechanism now; the exact flags/names can be tuned after.

**Two DB pieces, one migration; then a UI slice.** Deliver the migration + dry run + RETEST for gate review before apply, same as Slices A/B.

---

## DB

### 1. New table `standard_cert_types` (global reference — above departments)
`id uuid PK = gen_random_uuid()` · `track text NOT NULL` CHECK in (`sffma`,`tcfp`,`ems`,`cards`) · `name text NOT NULL` CHECK non-blank · `never_expires boolean NOT NULL` · `category text NOT NULL` CHECK in (`certification`,`continuing_education`) · `sort_order int NOT NULL DEFAULT 0` · `created_at timestamptz NOT NULL DEFAULT now()`.
- **RLS ON**; **one** policy: `SELECT TO authenticated USING (true)` — it's non-sensitive reference data, identical for every department. **No write policy** (seed-only; no runtime writes).
- A UNIQUE index on `(track, lower(btrim(name)))`.
- **Not** department-scoped and **no** FK to departments — it's global.

### 2. Seed it (same migration, idempotent)
Insert the rows in **§ Seed list** below. Make it re-runnable: `ON CONFLICT (track, lower(btrim(name))) DO NOTHING`, or precondition the table empty. (A later migration can correct names/flags after Tommy with plain `UPDATE`s — dept catalogs are unaffected.)

### 3. One new RPC `add_standard_cert_type(p_standard_id uuid)`
`SECURITY DEFINER`, `search_path=public`, EXECUTE `authenticated` only (revoke PUBLIC/anon).
- `is_dept_admin()`-gated (DA/PA) + `my_department_id()`-scoped — same gate as `set_cert_type`.
- Reads the `standard_cert_types` row for `p_standard_id`; **inserts into `public.cert_types`** `(department_id = my_department_id(), name, never_expires, category, created_by, updated_by)` copied from the standard row; returns the new `cert_types` row.
- On the existing `cert_types` unique clash (`department_id, lower(btrim(name))`) → friendly error: **"That cert type is already in your catalog."** (catch `unique_violation`, like `set_cert_type` does).
- **Do NOT modify `set_cert_type` / `assign_cert_type` / `delete_cert_type` / `dept_cert_types` or the readers.** This is a new, standalone RPC. Once added, a department's copy is an ordinary `cert_types` row — editable via the existing `set_cert_type`, deletable via `delete_cert_type` — so no `standard_ref` column is needed (dedupe is the existing per-dept unique name).
- Reading the master list for the picker: the client reads `standard_cert_types` directly through its SELECT policy (no RPC needed), or add a tiny `list_standard_cert_types()` if you prefer one call — your choice; if you add it, it's `STABLE SECURITY DEFINER`, authenticated-only, returns the table ordered by `track, sort_order, name`.

### 4. Discipline + proof
Single all-or-nothing DO block. Preconditions: `cert_types` + `is_dept_admin()` (md5 `c692e44f…`) live; `standard_cert_types` does not already exist (re-run-safe); refuse if the RPC already exists. Post-conditions: the table (RLS on, the one SELECT policy, the unique index, the two CHECKs), the seed row count = the number seeded, the RPC is SECURITY DEFINER/search_path public/authenticated-only; **every other function + policy byte-identical**; `total_policies` delta = **+1** (the new SELECT policy); the `verifie||d` token count unchanged; `verified` untouched. **PGlite dry run with mutations** (a write policy slipped onto the table → caught; the RPC not dept-scoped → caught; anon can execute → caught; the clash not friendly → caught). **Live RETEST (SENTINEL-rolled-back):** a DA calls `add_standard_cert_type` on a seeded id → a matching row appears in that dept's `dept_cert_types()` with the right `never_expires`/`category`; adding the same one twice → the friendly clash; a plain member is refused; a DA of another dept adds only to their own dept; the master list is readable by a plain member. Roll back.

---

## § Seed list (proposed — Tommy reviews after)

**Track `sffma` — category `certification` — never_expires `true` (all 24):**
Firefighter · Master Firefighter · Support Personnel · Instructor · Fire Inspector · Fire/Arson Investigator · Driver/Operator · Fire Officer · Incident Safety Officer · Public Information Officer · Fire & Life Safety Educator · Wildland Fire Fighting · Telecommunicator · Rope Rescue · Confined Space Rescue · Trench Rescue · Structural Collapse Rescue · Common Vehicle Rescue · Surface Water Rescue · Swiftwater Rescue · Wilderness Search & Rescue · Machinery Rescue · Heavy Vehicle Rescue · Hazardous Materials

**Track `tcfp` — category `certification` — never_expires `true` (all 32):**
Full Structure Fire Fighting · Firefighter I · Firefighter II · Aircraft Rescue Firefighter · Marine Firefighter · Driver Operator–Pumper · Driver Operator–Aerial · Officer I · Officer II · Officer III · Officer IV · Instructor I · Instructor II · Instructor III · Fire Inspector · Inspector I · Inspector II · Plans Examiner I · Investigator · Fire Marshal · Fire & Life Safety Educator I · Fire & Life Safety Educator II · Incident Safety Officer · Incident Commander · Basic Wildland Firefighter · Intermediate Wildland · Hazardous Materials Awareness · Hazardous Materials Operations · Hazardous Materials Technician · Hazardous Materials Incident Commander · Rope Rescue Awareness/Operations · Rope Rescue Technician

**Track `ems` — category `certification` — never_expires `false` (renew every 4 yrs, per DSHS) (all 5):**
Emergency Care Attendant (ECA) · Emergency Medical Technician (EMT) · Advanced EMT (AEMT) · EMT-Paramedic (EMT-P) · Licensed Paramedic (LP)

**Track `cards` — category `continuing_education`:**
never_expires `false`: CPR / BLS · ACLS · PALS · PHTLS / ITLS
never_expires `true`: NIMS/ICS 100 · NIMS/ICS 200 · NIMS/ICS 700 · NIMS/ICS 800

*(sort_order: number them within each track in the order listed so the picker reads sensibly.)*

---

## Then the UI slice (after the DB PASS)
On the existing **Cert Types** panel (Roster → Certifications, DA/PA), add **"Add from the standard list"**: a picker grouped by track (SFFMA / TCFP / Texas EMS / Cards), each item showing its name + Expires/Doesn't-expire, multi-select, with the ones already in the department's catalog shown as already-added (disabled). Confirm → call `add_standard_cert_type` for each selected (surface the friendly clash per item); refresh the catalog. Industrial-Noir, matches the Slice 1 panel. Deliver as a diff for review, then promote.

**Draft the DB migration first; deliver the migration + dry run + RETEST for gate review before apply.**
