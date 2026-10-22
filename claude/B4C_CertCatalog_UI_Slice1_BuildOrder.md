# B4C — Cert Catalog UI **Slice 1** — BUILD ORDER for CC

**Scope (locked Oct 22, mock-approved):** the first, user-facing cert-catalog slice — **manage the cert-type catalog**, **assign a type to a member's cert**, and the **three display fixes** so a never-expires cert reads as satisfied. Built on the live DB: Slice A ([[B4C_CertCatalog_SliceA_DB_ReviewRecord]]) + Slice B ([[B4C_CertCatalog_SliceB_DB_ReviewRecord]]) are **applied and proven**. Mock approved by Ashlea (`b4c_cert_types_mock.html`). **Deliver as a diff for gate review, then promote** (web-layer only; installed apps get it on a later native build).

**NOT in this slice (that's Slice 2):** adding a cert type as a **readiness requirement** in the #5 configurator. The DB for it (Slice B) is live, but the configurator UI is a separate, smaller slice. Don't build it here.

---

## The live DB you're building on (don't re-touch any of it)
- `cert_types(id, department_id, name, never_expires bool, category text ['certification'|'continuing_education'], created/updated at+by)`, RLS on, dept-scoped SELECT for members; writes **RPC-only**.
- `certs.cert_type_id uuid` → `cert_types(id)` ON DELETE SET NULL, nullable.
- RPCs (all `is_dept_admin()`-gated = **DA/PA**, dept-scoped, and they **raise** on refusal — errors are thrown, not silent):
  - `set_cert_type(p_id, p_name, p_never_expires, p_category default 'certification')` → returns the row (p_id null = insert, else update).
  - `delete_cert_type(p_id)` → void (certs keep their row; the FK clears their `cert_type_id`).
  - `dept_cert_types()` → `(id, name, never_expires, category, cert_count int, created_at, updated_at)` — readable by any member of the dept.
  - `assign_cert_type(p_cert_id, p_cert_type_id)` → void (NULL un-assigns; both cert and type must be in the caller's dept).
- Readers already emit `no_expiry`: `expiration_rows` (feeds `my_expirations`/`dept_expirations` → the **Expirations dashboard**), `dept_cert_readiness`. **`update_cert`/`delete_cert` are the F1 versions — don't touch them;** the existing cert edit/delete on a member file stays exactly as is.

---

## 1. Data wiring FIRST — load the type onto cert rows (nothing below works without it)
Today the cert load does **not** select the type. Two selects, both must add `cert_type_id`:
- `src/App.jsx:2391` (bulk roster load) — `select("id, member_id, name, exp, proof_path")` → **add `cert_type_id`**.
- `src/App.jsx:2478` (personal `me.certs` load) — same addition.

Then **enrich each cert row** with its type's `never_expires`, `name`, and `category`, looked up from `dept_cert_types()` (the catalog is small and dept-scoped — load it once where the dept context loads, cache it, join client-side by `cert_type_id`). A cert with `cert_type_id = null`, or whose type was deleted, enriches to `neverExpires:false` and no type label — i.e. it behaves exactly as today. Put the catalog in app state so the manage screen, the assign picker, and the badges all read one source.

## 2. The display fixes — teach the badge "never expires" (the load-bearing one)
There are **two** independent bucket paths; both must learn `no_expiry`, and they are different code:

**(a) `certStatus(exp)` — `src/App.jsx:10985` — the member-file / roster / scorecard / coverage badge.** It takes only `exp` and feeds **compliance + coverage math** (`certCoverage` 11042, `compliance` 11386, Chief's report, exports — ~12 call sites). **Do NOT rewire the math.** Instead:
- Change the signature to `certStatus(exp, neverExpires = false)`. When `neverExpires` is true, return **`{ label: "NO EXPIRY", color: "#2E7D52", rank: 2 }`** — **rank 2 is deliberate**: it's the same rank as CURRENT, so every existing `rank === 2` / `r === 1 || r === 2` test counts a never-expires cert as current/covered/compliant with **no change to any call site's logic**. Only the label + color differ.
- Thread `neverExpires` in from the enriched cert row at each call site: `certStatus(c.exp, c.neverExpires)`. Every call site that has the cert object can pass it; the few that only have a bare `exp` string (if any) pass nothing and keep today's behavior.
- **`CERT_FIRE`** (`src/App.jsx:11062`, dark-badge colors keyed by label) — add **`"NO EXPIRY": FIRE.green`**.

**(b) `expiryBucket` + `BUCKET_RANK` — `shared/expiry.js` — the Expirations dashboard.** The DB already sends `bucket:'no_expiry'`. Fix the passthrough + rank:
- `expiryBucket()` — add `no_expiry` to the passthrough line: `if (row.bucket === "expired" || row.bucket === "no_date" || row.bucket === "no_expiry") return row.bucket;` (so it never falls through to the `monthIndex` recompute → "no_date").
- `BUCKET_RANK` — add `no_expiry`. Rank it as **satisfied/least-urgent**, i.e. `{ expired:0, no_date:1, soon:2, current:3, no_expiry:4 }` (sorts after current — it needs no attention). Confirm the Expirations dashboard renders a `no_expiry` row as a green "No expiry" line, not an attention item, and that `api/expiration-reminders.js` (also imports this file) **skips** `no_expiry` (it should already, since it's not expired/soon — confirm, don't rework the sender).

**Keep the two windows in lockstep as the header comment demands** — you're only adding a satisfied state, not changing the 3-month rule.

## 3. Manage the catalog — the new admin screen (matches the mock)
A **"Cert Types"** screen reached from the Certifications area. Gate the whole screen + all its controls on **`isDeptAdmin(role)` (DA/PA)** — the client twin of the RPCs' `is_dept_admin()`. (If you place it inside the DA-only Admin section via `isDeptAdminOnly`, note that a PA would lose access the DB would otherwise allow — prefer `isDeptAdmin` so DA **and** PA can manage, matching the DB.)
- **List** from `dept_cert_types()`, **grouped by `category`** (Certifications / Continuing education), each row: name, `cert_count` ("12 members hold this"), and a **"Doesn't expire" / "Expires"** flag (green check vs clock, per the mock).
- **Add / Edit** form (inline or modal): **Name**, **Category** toggle (Certification | Continuing education), and a **"This certification expires" switch** (off = `never_expires true`). Save → `set_cert_type(id?, name, !expires, category)`. On the unique-name clash the RPC raises "Your department already has a cert type named …" — **surface that message** inline; don't swallow it.
- **Delete** → `delete_cert_type(id)`. Route it through the existing **`confirmDestructive` typed-phrase gate** (same as other shared deletes; `useCanDeleteShared` = DA/PA, which matches). Copy must say certs that used it are **kept and simply unlinked**, not deleted.
- The RPCs throw on refusal (unlike the E1 silent-RLS case), so a plain `try/catch` surfacing `error.message` is enough — but still **show** the error, never a silent success.

## 4. Assign a type on a member's cert (matches the mock)
On the member file's cert list (`src/App.jsx:~11623`, where `update_cert`/`delete_cert` already live), add an **"Assign a cert type ▾"** control per cert row, gated **`isDeptAdmin(role)`** (matches `assign_cert_type`'s `is_dept_admin()`; the existing `canSetExpiry` is author-or-DA — use `isDeptAdmin` here to mirror the RPC exactly).
- The picker lists `dept_cert_types()` (grouped by category) + an **"— None —"** option (un-assign).
- Select → `assign_cert_type(cert_id, type_id | null)`; on success update the row's `cert_type_id` + re-enrich (so the badge flips immediately — a never-expires type → the badge becomes "No expiry" without a reload). Surface any thrown error.
- A cert already linked shows its type inline ("Type: **Firefighter II** · doesn't expire"), per the mock.

## 5. Scorecard "never expires" line + deleted-type wording (the two quieter fixes)
- **Scorecard** cert list: a never-expires cert shows a clean **"Never expires"** line instead of an empty/"No date" expiry (it already flows through `certStatus` once step 2 lands — just confirm the scorecard renders the new label/rank cleanly rather than an empty date cell).
- **Deleted type:** a cert whose `cert_type_id` was cleared (type deleted) reads like **any untyped cert** — it must NOT say "This qualification is inactive" or any scary readiness wording. (That inactive wording is the readiness-requirement path and is Slice 2's concern; just make sure an unlinked cert on the member file / badge reads normally.)

## Review hooks (what I'll check on the diff)
- **`certStatus` no-expiry = rank 2**, and **no coverage/compliance call site's rank logic changed** — a never-expires cert counts as current/covered everywhere, only label+color differ. (I'll diff `certCoverage`, `compliance`, the report, exports to confirm their math is byte-unchanged except for the threaded `neverExpires` arg.)
- Both `cert_type_id` selects added; cert rows enriched; an untyped/deleted-type cert behaves exactly as today.
- `shared/expiry.js` passthrough + `BUCKET_RANK` gain `no_expiry`; the reminder sender still skips it.
- Manage + assign gated on **`isDeptAdmin` (DA/PA)**, matching `is_dept_admin()`; delete through `confirmDestructive`; **every** RPC error surfaced (no silent success).
- **No DB migration in this diff**, no new hex outside the FIRE/FS tokens, the detail/forms match Industrial Noir, and **no stray `verified` literal** (UI diff, but confirm the App.jsx literal count is unchanged).
- Slice 2 (the #5 configurator requirement screen) is **not** in this diff.

*(Deliver the diff + a quick note on how you threaded `neverExpires` through the `certStatus` call sites — that's the part I'll read most closely.)*
