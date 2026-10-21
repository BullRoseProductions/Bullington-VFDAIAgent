# Cert catalog (option 4) — Step 0 live output, 2026-10-21

Source: Ashlea ran `sql/cert_catalog_STEP0_CHECK.sql` on live (read-only, one result set) and pasted the rows back.
The app-side answer (item 6) is in `docs/review/cert_catalog_STEP0_app_side.md`.

The SQL editor's markdown export doubles backslashes and escapes pipes. Below, `\\d` is shown as `\d` and `\|` as `|`.
The md5s are the live values, taken from the export, not recomputed here.

No migration has been drafted. Per the order, the reviewer writes it from these definitions.

---

## Findings, ranked

### F1 — `update_cert` and `delete_cert` gate on the UNSCOPED admin function and never check the department (latent cross-department write)

- Both are SECURITY DEFINER and gate only on `is_department_admin()`. That is the role-anywhere gate (md5 `99570e17…`), the same one the 10-20 admin-gate fix took off four policies.
- Both then act on `where id = cert_id` with **no** `department_id = my_department_id()` check.
- So anyone holding Department Admin (or whatever `is_department_admin()` accepts) in any department can rename, re-date or delete any cert in any department, if they know its id.
- Compare `approve_cert_submission` / `reject_cert_submission`: both use `is_dept_admin()` **and** check `sub.department_id is distinct from my_department_id()`. That is the correct pattern.
- **Blast radius today is latent.** Cert ids are uuids, and the certs SELECT policies only reveal ids inside the caller's own department. Exploiting it needs an id that leaked by another route.
- **Relevance to the catalog:** the catalog has to change `update_cert` anyway (it gains the type link). That is the natural place to swap in `is_dept_admin()` and add the department check, and the same goes for `delete_cert`.
- **Reviewer's call:** fold this into the catalog migration, or ship it as its own fix first.

### F2 — Three different "is this a valid YYYY-MM" rules

| Where | Pattern | Month `00` / `13` |
|---|---|---|
| `update_cert` (write check) | `^\d{4}-\d{2}$` | accepted |
| `dept_cert_readiness` (dashboard %) | `^\d{4}-\d{2}$` | counted as dated (`split_part` arithmetic) |
| `expiration_rows` (Expirations, scorecard certs) | `^\d{4}-(0[1-9]|1[0-2])$` | no date |
| app `certStatus` (~10916) | `^\d{4}-\d{2}$` | dated |

- `approve_cert_submission` copies `sub.exp` with **no** format check.
- `cert_submissions.exp` has no CHECK constraint, and neither does `certs.exp`.
- This is how the malformed rows below got in.

### F3 — Expiry rules drift between the dashboard and Expirations

**Expiring window**
- `dept_cert_readiness` (and app `certStatus`): ≤ 3 *months* = expiring.
- `expiration_rows`: ≤ 30 *days* = soon.

**Who is counted**
- `dept_cert_readiness` counts **every** cert row in the department.
- `expiration_rows` (dept mode) excludes Inactive members, Project Admins and separated members.

**Bearing on the catalog:** the catalog's `never_expires` has to land in all three places. These existing differences mean "in step" needs defining first: does no-expiry get its own bucket in each, or is it excluded from `total_dated`?

### F4 — The data a catalog would map onto is messy

| Department | Rows | Distinct names (lower/trim) | Blank exp | Malformed exp | YYYY-MM |
|---|---|---|---|---|---|
| Indian Harbor VFD | 169 | **120** | 112 | 21 | 36 |
| B4C Demo Department | 6 | 4 | 0 | **6** | 0 |
| Granbury / Lipan / North Hood | 0 | 0 | 0 | 0 | 0 |

- **Indian Harbor:** 120 distinct names across 169 certs, so the names are nearly free text. Any type backfill has to be a reviewed mapping (or left NULL), not an automatic name match.
- **Blank exp:** 112 of 169 are blank. Some are probably genuinely non-expiring, which is the case `never_expires` is for. Today they all read "no date".
- **Malformed exp:** 21 Indian Harbor rows, and all 6 Demo rows. They show "no date" everywhere except possibly `dept_cert_readiness` (F2). The values themselves were not pulled. A Step 0b can list them if the reviewer wants them.
- **Scope:** only Indian Harbor has real data, so a backfill has a one-department blast radius.

### F5 — Smaller items (note only, don't fix in isolation)

- **`certs · Leaders read all certs` is roles `{public}`, not `{authenticated}`.** It falls in the same future RLS-normalisation pass as `session_attendance`.
- **`certs · Members read own certs` matches on `lower(members.email) = lower(auth.email())` and has no department term.** A person with member rows in two departments sees their own certs from both. These are only their own records (read-only), but it differs from `cert_submissions`, which uses `my_member_id()`.
- **`readiness_requirements` uniqueness is an index, not a constraint.** `set_readiness_requirement` uses `ON CONFLICT (department_id, kind, ref_id)`. pg_constraint shows no unique constraint, because the repo creates `readiness_requirements_uq` as a UNIQUE INDEX … NULLS NOT DISTINCT (`sql/scorecard_2026-10-19.sql:111`). Step 0 didn't query pg_indexes, so it is not confirmed live. It must hold, though: the upsert would error without it.
- **A new `cert_type` kind fits `readiness_requirements_ref_chk` as-is**, because non-credential kinds require `ref_id`. Only `readiness_requirements_kind_check` and the kind list inside `set_readiness_requirement` need the new value. The `readiness_items` CASE chains also need a branch: label, satisfied, status, the expires_on line, and the order-by.

### Confirmed clean

- **No catalog exists yet.** Section 5 returned no catalog-like tables and no catalog-like columns (`cert_type`, `never_expires`, …), only its label row.
- **No triggers** exist on `certs` or `cert_submissions`.
- **Writes go only through RPCs:**
  - `certs` has SELECT policies only, so every write goes through the definer RPCs.
  - `cert_submissions` has SELECT plus INSERT policies, and no UPDATE or DELETE. The approve and reject RPCs are the only mutators.
  - The table grants to anon and authenticated are the Supabase defaults (full). RLS is the gate: on for both tables, not forced.
- **Only three functions write certs:** `approve_cert_submission`, `update_cert` and `delete_cert`.
- **Anon cannot execute any cert function.** Members can execute `approve_cert_submission`, `delete_cert`, `update_cert`, `dept_cert_readiness`, `my_department_rollup`, `my_expirations` and `pa_department_radar`. The internals `expiration_rows`, `readiness_verdict`, `probation_item_states` and `is_muted` are not member-executable.
- **`is_dept_admin()` md5 = `c692e44f62923d2bf4c1a39a21a87bf7`**, unchanged since Step A and dept-scoped.

### Not pulled (Step 0b candidates, read-only)

A `no_expiry` bucket would also pass through these. Their definitions were not part of this Step 0:

- `readiness_window(text, date)`
- `my_expirations()`
- `my_department_rollup()`
- `pa_department_radar()`
- `probation_item_states(uuid,uuid)`
- `is_muted(uuid,text)`
- `qualification_cells`
- the `readiness_requirements_uq` index (pg_indexes)
- the malformed `exp` values themselves

---

## 1 — certs + cert_submissions

**certs columns**
- `id` uuid NOT NULL = gen_random_uuid()
- `department_id` uuid NOT NULL
- `member_id` uuid NOT NULL
- `name` text NOT NULL
- `exp` text
- `proof_path` text
- `created_at` timestamptz NOT NULL = now()

There is no `updated_at`, and no type column.

**cert_submissions columns**
- `id` uuid NOT NULL = gen_random_uuid()
- `department_id` uuid NOT NULL
- `member_id` uuid NOT NULL
- `name` text NOT NULL
- `exp` text
- `note` text
- `proof_path` text
- `proposed_by` uuid
- `reviewed_at` timestamptz
- `reviewed_by` uuid
- `source` text NOT NULL = 'manual'
- `status` text NOT NULL = 'pending'
- `created_at` timestamptz NOT NULL = now()

**Constraints**
- `certs_pkey` PRIMARY KEY (id)
- `certs_department_id_fkey` → departments(id) ON DELETE CASCADE
- `certs_member_id_fkey` → members(id) ON DELETE CASCADE
- `cert_submissions_pkey` PRIMARY KEY (id)
- `cert_submissions_department_id_fkey` → departments(id) (no cascade)
- `cert_submissions_member_id_fkey` → members(id) (no cascade)
- `cert_submissions_proposed_by_fkey` → auth.users(id)
- `cert_submissions_reviewed_by_fkey` → auth.users(id)
- `cert_submissions_source_check` CHECK source IN ('manual','ai','sfma','self')
- `cert_submissions_status_check` CHECK status IN ('pending','approved','rejected')

**RLS:** certs on, not forced. cert_submissions on, not forced.

**Grants:** anon and authenticated both have SELECT INSERT UPDATE DELETE on both tables, with some column insertable and some column updatable.

**Policies**
- `certs · Leaders read all certs [SELECT] {public}`
  - USING `is_leader() AND department_id = my_department_id()`
- `certs · Members read own certs [SELECT] {authenticated}`
  - USING `member_id IN (SELECT members.id FROM members WHERE lower(members.email) = lower(auth.email()))`
- `cert_submissions · Dept admins read own dept cert submissions [SELECT] {authenticated}`
  - USING `is_dept_admin() AND department_id = my_department_id()`
- `cert_submissions · members read own cert submissions [SELECT] {authenticated}`
  - USING `member_id = my_member_id()`
- `cert_submissions · Leaders propose cert submissions [INSERT] {authenticated}`
  - CHECK `is_leader() AND department_id = my_department_id() AND member_id IN (SELECT m.id FROM members m WHERE m.department_id = my_department_id()) AND status = 'pending' AND proposed_by = auth.uid()`
- `cert_submissions · members propose own cert submissions [INSERT] {authenticated}`
  - CHECK `member_id = my_member_id() AND department_id = my_department_id() AND proposed_by = auth.uid() AND status = 'pending' AND proof_path IS NOT NULL`

**Triggers:** none.

## 2 — functions touching certs

| Function | Mode | md5 | Writes certs | Members exec | Anon exec |
|---|---|---|---|---|---|
| approve_cert_submission(uuid) | DEFINER | 5a1a89ee0cc2254ad4347f27a141b94e | true | true | false |
| delete_cert(uuid) | DEFINER | 8d0a006c2ef91ac044a64f23772ef40d | true | true | false |
| update_cert(uuid,text,text) | DEFINER | 5cd098a11f04d4c80c8ca564ee068302 | true | true | false |
| dept_cert_readiness() | DEFINER | 808e173f70446e20e15626cd9bb282dd | false | true | false |
| expiration_rows(uuid,uuid) | DEFINER | 3223629e82c12eeec2cbd34daebf8085 | false | false | false |
| is_muted(uuid,text) | DEFINER | 4e5107d4104e2ac4a8bd2d2347b5db49 | false | false | false |
| my_department_rollup() | DEFINER | 058316de93cfdde8fbe732121c4b903f | false | true | false |
| my_expirations() | DEFINER | ffcceab959e8ea59e71a9d9c6d241590 | false | true | false |
| pa_department_radar() | DEFINER | 224f9ec3d5cdd53600b7d5d74319708a | false | true | false |
| probation_item_states(uuid,uuid) | DEFINER | bbe66fcac2ddd9931e12d9226d1ed800 | false | false | false |
| readiness_verdict(uuid,uuid) | DEFINER | e72e20424e274308e62dd2ad170b8c7f | false | false | false |

(`reject_cert_submission` doesn't match the `certs\y` scan because it only touches cert_submissions. Its full definition is below.)

### approve_cert_submission(uuid) — md5 5a1a89ee…

```sql
CREATE OR REPLACE FUNCTION public.approve_cert_submission(submission_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  sub public.cert_submissions;
  new_cert_id uuid;
begin
  if not public.is_dept_admin() then
    raise exception 'Not authorized to approve cert submissions';
  end if;
  select * into sub from public.cert_submissions where id = submission_id;
  if not found then
    raise exception 'Submission not found';
  end if;
  if sub.department_id is distinct from public.my_department_id() then
    raise exception 'Not in your department';
  end if;
  if sub.status <> 'pending' then
    raise exception 'Submission is not pending (current status: %)', sub.status;
  end if;
  insert into public.certs (id, department_id, member_id, name, exp, proof_path, created_at)
  values (gen_random_uuid(), sub.department_id, sub.member_id, sub.name, sub.exp, sub.proof_path, now())
  returning id into new_cert_id;
  update public.cert_submissions
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  where id = submission_id;
  return new_cert_id;
end;
$function$
```

### reject_cert_submission(uuid,text)

```sql
CREATE OR REPLACE FUNCTION public.reject_cert_submission(submission_id uuid, reason text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  sub public.cert_submissions;
begin
  -- same authority gate as approve
  if not public.is_dept_admin() then
    raise exception 'Not authorized to reject cert submissions';
  end if;

  select * into sub from public.cert_submissions where id = submission_id;

  if not found then
    raise exception 'Submission not found';
  end if;

  if sub.department_id is distinct from public.my_department_id() then
    raise exception 'Not in your department';
  end if;

  if sub.status <> 'pending' then
    raise exception 'Submission is not pending (current status: %)', sub.status;
  end if;

  update public.cert_submissions
  set status = 'rejected',
      reviewed_by = auth.uid(),
      reviewed_at = now(),
      note = coalesce(reason, note)
  where id = submission_id;
end;
$function$
```

### update_cert(uuid,text,text) — md5 5cd098a1… (F1, F2)

```sql
CREATE OR REPLACE FUNCTION public.update_cert(cert_id uuid, new_name text, new_exp text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_department_admin() then
    raise exception 'Not authorized to edit certifications';
  end if;

  if new_name is null or btrim(new_name) = '' then
    raise exception 'Certification name is required';
  end if;

  -- exp must be null/empty (no expiration) or a valid YYYY-MM string
  if new_exp is not null and btrim(new_exp) <> '' and new_exp !~ '^\d{4}-\d{2}$' then
    raise exception 'Expiration must be YYYY-MM (got: %)', new_exp;
  end if;

  update public.certs
  set name = btrim(new_name),
      exp  = case when new_exp is null or btrim(new_exp) = '' then null else new_exp end
  where id = cert_id;

  if not found then
    raise exception 'Certification not found';
  end if;
end;
$function$
```

### delete_cert(uuid) — md5 8d0a006c… (F1)

```sql
CREATE OR REPLACE FUNCTION public.delete_cert(cert_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_department_admin() then
    raise exception 'Not authorized to delete certifications';
  end if;

  delete from public.certs where id = cert_id;

  if not found then
    raise exception 'Certification not found';
  end if;
end;
$function$
```

### dept_cert_readiness() — md5 808e173f… (F2, F3)

```sql
CREATE OR REPLACE FUNCTION public.dept_cert_readiness()
 RETURNS TABLE(current integer, expiring integer, expired integer, no_date integer, total_dated integer, pct integer)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  with n as (
    select ( extract(year  from (now() at time zone 'America/Chicago'))::int * 12
           + extract(month from (now() at time zone 'America/Chicago'))::int ) as now_ym
  ),
  bucketed as (
    select
      case
        when c.exp is null or c.exp !~ '^\d{4}-\d{2}$' then 'no_date'
        when (split_part(c.exp,'-',1)::int * 12 + split_part(c.exp,'-',2)::int) <  n.now_ym then 'expired'
        when (split_part(c.exp,'-',1)::int * 12 + split_part(c.exp,'-',2)::int) - n.now_ym <= 3 then 'expiring'
        else 'current'
      end as bucket
    from public.certs c
    cross join n
    where c.department_id = public.my_department_id()
  )
  select
    count(*) filter (where bucket = 'current')::int                         as "current",
    count(*) filter (where bucket = 'expiring')::int                        as expiring,
    count(*) filter (where bucket = 'expired')::int                         as expired,
    count(*) filter (where bucket = 'no_date')::int                         as no_date,
    count(*) filter (where bucket in ('current','expiring','expired'))::int as total_dated,
    round(
      100.0 * count(*) filter (where bucket = 'current')
      / nullif(count(*) filter (where bucket in ('current','expiring','expired')), 0)
    )::int                                                                  as pct
  from bucketed;
$function$
```

## 3 — expiration_rows(uuid,uuid) — md5 3223629e82c12eeec2cbd34daebf8085

```sql
CREATE OR REPLACE FUNCTION public.expiration_rows(p_dept uuid, p_member uuid DEFAULT NULL::uuid)
 RETURNS TABLE(scope text, source text, item_id uuid, member_id uuid, apparatus_id uuid, subject text, kind text, label text, cls text, expires_on date, days_until integer, bucket text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations (internal) — certs (approved ONLY; never the pending-submission queue) + member_credentials + gear_items + apparatus_tests,
-- one row each, bucketed + ranked. p_member NULL = the department (honest roster); else that member's own rows.
  with td as (select (now() at time zone 'America/Chicago')::date as d),
  people as (
    select m.id, m.name from public.members m
     where m.department_id = p_dept
       and (case when p_member is not null then m.id = p_member
                 else m.status is distinct from 'Inactive'
                      and not coalesce(m.access && array['Project Admin']::text[], false)
                      and not exists (select 1 from public.member_separation s where s.member_id = m.id) end)
  ),
  raw as (
    -- legacy certs: 'YYYY-MM' -> the last day of that month; anything else -> no date
    select 'member'::text as scope, 'cert'::text as source, c.id as item_id, c.member_id, null::uuid as apparatus_id, p.name as subject,
           'cert'::text as kind, c.name as label, null::text as cls,
           case when c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'
                then (date_trunc('month', to_date(c.exp || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day')::date end as expires_on
      from public.certs c join people p on p.id = c.member_id
     where c.department_id = p_dept
    union all
    select 'member', 'credential', mc.id, mc.member_id, null, p.name, mc.kind, mc.label, mc.cls, mc.expires_on
      from public.member_credentials mc join people p on p.id = mc.member_id
     where mc.department_id = p_dept
    union all
    select 'gear', 'gear', g.id, g.member_id, null, coalesce(p.name, 'Pool gear'), 'gear', g.label, null,
           nullif(least(coalesce(g.next_inspection_on, 'infinity'::date),
                        coalesce((g.in_service_on + interval '10 years')::date, 'infinity'::date)), 'infinity'::date)
      from public.gear_items g left join people p on p.id = g.member_id
     where g.department_id = p_dept and g.retired_at is null
       and (case when p_member is not null then g.member_id = p_member
                 else g.member_id is null or p.id is not null end)
    union all
    select 'apparatus', 'apparatus_test', t.id, null, t.apparatus_id, a.name, t.test_type, t.test_type || ' test', null, t.next_due_on
      from public.apparatus_tests t join public.apparatus a on a.id = t.apparatus_id and a.department_id = p_dept and a.deleted_at is null
     where t.department_id = p_dept and p_member is null
  )
  select r.scope, r.source, r.item_id, r.member_id, r.apparatus_id, r.subject, r.kind, r.label, r.cls, r.expires_on,
         case when r.expires_on is null then null else (r.expires_on - td.d) end,
         case when r.expires_on is null then 'no_date'
              when r.expires_on < td.d then 'expired'
              when r.expires_on - td.d <= 30 then 'soon'
              else 'current' end
    from raw r cross join td
   order by case when r.expires_on is null then 1 when r.expires_on < td.d then 0 when r.expires_on - td.d <= 30 then 2 else 3 end,
            r.expires_on nulls last, r.subject, r.label;
$function$
```

## 4 — readiness machinery

**readiness_requirements columns**
- `id` uuid NOT NULL = gen_random_uuid()
- `department_id` uuid NOT NULL
- `kind` text NOT NULL
- `ref_id` uuid
- `required` boolean NOT NULL = true
- `created_at` timestamptz NOT NULL = now()
- `created_by` uuid
- `updated_at` timestamptz NOT NULL = now()
- `updated_by` uuid

**Constraints**
- `readiness_requirements_pkey` PRIMARY KEY (id)
- `readiness_requirements_department_id_fkey` → departments(id) ON DELETE CASCADE
- `readiness_requirements_kind_check` CHECK kind IN ('credential_license','credential_med_card','credential_fit_test','qualification_type','document')
- `readiness_requirements_ref_chk` CHECK `(kind LIKE 'credential\_%') = (ref_id IS NULL)`
- The unique index `readiness_requirements_uq` isn't listed because it is an index, not a constraint. See F5.

**Policy:** `readiness_requirements_read [SELECT] {authenticated}`, USING `department_id = my_department_id()`. This is the only policy, so all writes go through the RPC.

### set_readiness_requirement(text,uuid,boolean) — md5 5ac03cd738f3897b0eb0ae7a6768670e

```sql
CREATE OR REPLACE FUNCTION public.set_readiness_requirement(p_kind text, p_ref_id uuid DEFAULT NULL::uuid, p_required boolean DEFAULT true)
 RETURNS readiness_requirements
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard — a Department Admin (or PA) sets the department's readiness standard: add / keep (required) or drop
-- from the count (required = false). Never touches the locked verification column.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id(); v_ref uuid := p_ref_id; v_row public.readiness_requirements;
begin
  if v_dept is null or not coalesce(public.is_dept_admin(), false) then
    raise exception 'Only a Department Admin can set the readiness standard.';
  end if;
  if p_kind is null or p_kind not in ('credential_license', 'credential_med_card', 'credential_fit_test', 'qualification_type', 'document') then
    raise exception 'Unknown requirement type.';
  end if;
  if p_kind like 'credential\_%' then
    if v_ref is not null then raise exception 'A credential requirement is the credential type itself — no item to pick.'; end if;
  elsif p_kind = 'qualification_type' then
    if v_ref is null or not exists (select 1 from public.qualification_types where id = v_ref and department_id = v_dept) then
      raise exception 'That qualification is not set up in your department.';
    end if;
  else   -- document: a series id, or any document row of it (mapped through documents.series_id)
    if v_ref is not null and not exists (select 1 from public.document_series where series_id = v_ref and department_id = v_dept) then
      select d.series_id into v_ref from public.documents d where d.id = p_ref_id and d.department_id = v_dept;
    end if;
    if v_ref is null or not exists (select 1 from public.document_series where series_id = v_ref and department_id = v_dept) then
      raise exception 'That document is not in your department.';
    end if;
  end if;
  insert into public.readiness_requirements (department_id, kind, ref_id, required, created_by, updated_by)
  values (v_dept, p_kind, v_ref, coalesce(p_required, true), v_me, v_me)
  on conflict (department_id, kind, ref_id) do update set required = excluded.required, updated_by = excluded.updated_by, updated_at = now()
  returning * into v_row;
  return v_row;
end;
$function$
```

### member_scorecard(uuid) — md5 78ca036d9c5b9171623aef8cb1302b5a

```sql
CREATE OR REPLACE FUNCTION public.member_scorecard(p_member_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard — one member's readiness: themself, or (Board / DA / Officer) a member of their department. Read-only;
-- display-only in v1.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id();
begin
  if v_dept is null or v_me is null then raise exception 'We could not match your login to a department.'; end if;
  if p_member_id is distinct from v_me and not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can see another member''s scorecard.';
  end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  return public.readiness_verdict(v_dept, p_member_id);
end;
$function$
```

### readiness_items(uuid,uuid) — md5 2a0bca8bdd97be68b26daaa6a22106f5

```sql
CREATE OR REPLACE FUNCTION public.readiness_items(p_dept uuid, p_member uuid)
 RETURNS TABLE(requirement_id uuid, kind text, ref_id uuid, label text, satisfied boolean, status text, expires_on date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard (internal) — every REQUIRED item of the department for one member, each resolved through the existing
-- read for its kind. Read-only.
  with td as (select (now() at time zone 'America/Chicago')::date as d),
  req as (select r.* from public.readiness_requirements r where r.department_id = p_dept and r.required),
  quals as (select c.type_id, c.status from public.qualification_cells(p_dept, p_member) c),
  creds as (select e.kind, e.expires_on, public.readiness_window(e.bucket, e.expires_on) as w
              from public.expiration_rows(p_dept, p_member) e where e.source = 'credential'),
  best_cred as (   -- per kind, the member's best: current > soon > no_date > expired, then the latest date
    select distinct on (c.kind) c.kind, c.expires_on, c.w
      from creds c
     order by c.kind, case c.w when 'current' then 0 when 'soon' then 1 when 'no_date' then 2 else 3 end, c.expires_on desc nulls last)
  select r.id, r.kind, r.ref_id,
         case when r.kind = 'qualification_type' then coalesce(qt.name, 'Qualification (removed)')
              when r.kind = 'document' then coalesce(ds.title, 'Document (removed)')
              when r.kind = 'credential_license' then 'Driver''s license'
              when r.kind = 'credential_med_card' then 'Med card'
              else 'Fit test' end,
         -- satisfied — NEVER null (bool_and ignores nulls: an unknown must read unsatisfied, not drop out of the verdict)
         coalesce(case when r.kind = 'qualification_type' then coalesce(qt.active, false) and q.status = 'qualified'
              when r.kind = 'document' then ds.series_id is not null and ds.requires_ack and ds.current_version > 0
                                            and (not public.rs_member_in_audience(p_member, ds.required_roles) or ack.ok)
              else bc.w in ('current', 'soon') end, false),   -- expiring = still valid: satisfied, flagged in renewals_due
         -- status
         case when r.kind = 'qualification_type' then
                case when qt.id is null or not qt.active then 'not_configured'
                     when q.status = 'qualified' then 'qualified'
                     when q.status = 'in_progress' then 'in_progress' else 'missing' end
              when r.kind = 'document' then
                case when ds.series_id is null or not ds.requires_ack or ds.current_version = 0 then 'not_configured'
                     when not public.rs_member_in_audience(p_member, ds.required_roles) then 'not_required'
                     when ack.ok then 'signed' else 'unsigned' end
              else case when bc.kind is null then 'missing' when bc.w = 'soon' then 'expiring' else bc.w end end,
         case when r.kind like 'credential\_%' then bc.expires_on end
    from req r cross join td
    left join public.qualification_types qt on r.kind = 'qualification_type' and qt.id = r.ref_id and qt.department_id = p_dept
    left join quals q on r.kind = 'qualification_type' and q.type_id = r.ref_id
    left join public.document_series ds on r.kind = 'document' and ds.series_id = r.ref_id and ds.department_id = p_dept
    left join lateral (select exists (select 1 from public.document_acknowledgments k
                                        where k.member_id = p_member and k.series_id = ds.series_id and k.version = ds.current_version
                                          and (not ds.annual_resign or (k.signed_at at time zone 'America/Chicago')::date + interval '12 months' > td.d)) as ok
                        where r.kind = 'document') ack on true
    left join best_cred bc on r.kind like 'credential\_%' and bc.kind = substr(r.kind, 12)
   order by case when r.kind = 'qualification_type' then 0 when r.kind like 'credential\_%' then 1 else 2 end, 4;
$function$
```

Note for the catalog: the label CASE and the `satisfied` CASE both end in a catch-all `else`. The label falls through to `'Fit test'`, and `satisfied` falls through to the credential `bc.w` test. A new `cert_type` kind added without its own branches would be labelled "Fit test" and judged against `best_cred`, which would be NULL, so it would read unsatisfied and "missing". It must get explicit branches.

### readiness_verdict(uuid,uuid) — md5 e72e20424e274308e62dd2ad170b8c7f

```sql
CREATE OR REPLACE FUNCTION public.readiness_verdict(p_dept uuid, p_member uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard (internal) — the verdict + items + certs (visibility only) + activity (information only). Read-only.
  with it as (select * from public.readiness_items(p_dept, p_member)),
  td as (select (now() at time zone 'America/Chicago')::date as d)
  select jsonb_build_object(
    'member_id', m.id, 'name', m.name, 'status', m.status,
    'state', case when (select count(*) from it) = 0 then 'not_set'
                  when (select bool_and(it.satisfied) from it) then 'ready' else 'not_ready' end,
    'required', (select count(*) from it),
    'satisfied', (select count(*) from it where it.satisfied),
    'items', coalesce((select jsonb_agg(to_jsonb(it)) from it), '[]'::jsonb),
    'outstanding', coalesce((select jsonb_agg(it.label || ' — ' || replace(it.status, '_', ' ')) from it where not it.satisfied), '[]'::jsonb),
    'renewals_due', coalesce((select jsonb_agg(jsonb_build_object('label', it.label, 'expires_on', it.expires_on)) from it where it.satisfied and it.status = 'expiring'), '[]'::jsonb),
    'certs', coalesce((select jsonb_agg(jsonb_build_object('label', e.label, 'expires_on', e.expires_on,
                                                           'status', public.readiness_window(e.bucket, e.expires_on)) order by e.expires_on nulls first)
                         from public.expiration_rows(p_dept, p_member) e where e.source = 'cert'), '[]'::jsonb),
    'activity', jsonb_build_object(
      'window', 'last 12 months',
      'station_hours', coalesce((select round(sum(extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 1)
                                   from public.station_presence sp
                                  where sp.member_id = p_member and sp.department_id = p_dept and sp.checked_out_at is not null
                                    and not coalesce(sp.auto_closed, false) and sp.checked_in_at >= now() - interval '12 months'), 0),
      'trainings', (select count(distinct a.session_id) from public.session_attendance a
                      join public.training_sessions t on t.id = a.session_id and t.department_id = p_dept
                     where a.member_id = p_member and t.date <= td.d and t.date > td.d - interval '12 months'),
      'drives', (select count(*) from public.supervised_sessions ss
                  where ss.member_id = p_member and ss.department_id = p_dept and ss.kind = 'drive' and ss.voided_at is null
                    and ss.occurred_on > td.d - interval '12 months')))
    from public.members m cross join td
   where m.id = p_member and m.department_id = p_dept;
$function$
```

## 5 — catalog check

There are no catalog-like tables and no catalog-like columns. Only the label row came back, which means no catalog exists yet.

## 7 — certs per department

See the F4 table.

## 8 — gate

`is_dept_admin()` md5 `c692e44f62923d2bf4c1a39a21a87bf7`, equal to Step A (dept-scoped).
