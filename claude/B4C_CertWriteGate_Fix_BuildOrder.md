# B4C — Cert write-gate fix (Step 0 F1) — BUILD ORDER for CC

**The gap (confirmed from the live bodies in [[cert_catalog_STEP0_OUTPUT]]):** `update_cert(uuid,text,text)` (md5 `5cd098a11f04d4c80c8ca564ee068302`) and `delete_cert(uuid)` (md5 `8d0a006c2ef91ac044a64f23772ef40d`) both gate on **`is_department_admin()`** — the unscoped role-anywhere gate (md5 `99570e1790f233594464da32436c8ca7`), the same one the Oct 20 admin-gate fix removed from four policies — and then act on `where id = cert_id` with **no `department_id = my_department_id()` check**. So a Department Admin of any department can rename, re-date, or delete any department's cert given its id. Latent (cert ids are uuids; the `certs` SELECT policies only reveal ids inside the caller's own department), but a real cross-department write/delete hole. The correct pattern is already in `approve_cert_submission`: `is_dept_admin()` + a department check.

**Standalone, ahead of the catalog.** This is a security fix, independent of the catalog feature (`delete_cert` isn't otherwise touched by it). DB functions only — live on web AND native the moment applied, no deploy.

## The change — two functions, gate swap + dept scope, nothing else

**`update_cert`** — swap the gate and scope the UPDATE. Keep the name/exp validation exactly as-is (the F2 date-format cleanup is deferred to the catalog work — do NOT change the regex here):
```sql
CREATE OR REPLACE FUNCTION public.update_cert(cert_id uuid, new_name text, new_exp text)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if not public.is_dept_admin() then
    raise exception 'Not authorized to edit certifications';
  end if;
  if new_name is null or btrim(new_name) = '' then
    raise exception 'Certification name is required';
  end if;
  if new_exp is not null and btrim(new_exp) <> '' and new_exp !~ '^\d{4}-\d{2}$' then
    raise exception 'Expiration must be YYYY-MM (got: %)', new_exp;
  end if;
  update public.certs
     set name = btrim(new_name),
         exp  = case when new_exp is null or btrim(new_exp) = '' then null else new_exp end
   where id = cert_id
     and department_id = public.my_department_id();   -- <-- added
  if not found then
    raise exception 'Certification not found';
  end if;
end;
$function$
```

**`delete_cert`** — same gate swap + scope:
```sql
CREATE OR REPLACE FUNCTION public.delete_cert(cert_id uuid)
 RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if not public.is_dept_admin() then
    raise exception 'Not authorized to delete certifications';
  end if;
  delete from public.certs
   where id = cert_id
     and department_id = public.my_department_id();   -- <-- added
  if not found then
    raise exception 'Certification not found';
  end if;
end;
$function$
```

**Why scoping the WHERE (not a separate select+check) is right:** a cross-department id — or a nonexistent id — both yield 0 rows → the existing `if not found` raises "Certification not found". Non-leaky (never reveals that the id exists in another department) and minimal.

## Migration discipline (same as every security fix)
- Single all-or-nothing DO block, re-run-safe.
- **Preconditions (pin, refuse on drift):** `update_cert` current md5 = `5cd098a1…` and `delete_cert` = `8d0a006c…` (so we're replacing exactly what Step 0 read); `is_dept_admin()` body is the dept-scoped one, md5 `c692e44f62923d2bf4c1a39a21a87bf7`; `is_department_admin()` is the unscoped one, md5 `99570e17…` (the thing we're removing). Refuse if already applied (neither function still references `is_department_admin`).
- **Post-conditions:** re-read both bodies — assert neither references `is_department_admin` any more, both reference `is_dept_admin()` AND `my_department_id()`; no other function or policy changed (snapshot count); `verified` appears nowhere and is untouched; `total_policies` unchanged.
- PGlite dry run WITH mutations: (a) gate left on `is_department_admin` → caught; (b) dept scope dropped from one function → caught; (c) wrong function body changed → caught; (d) the name/exp validation altered → caught (it must stay byte-identical except the two intended lines).

## Live RETEST (SENTINEL-rolled-back, separate from the migration)
Build a real cross-department scenario: a DA of dept A, a plain member + a cert in dept B.
- **X1 (regression catch):** as the dept-A DA, `update_cert` and `delete_cert` on **dept B's** cert → both refused ("Certification not found"), 0 rows changed. Pre-fix they would have succeeded — show that by running the measure against the pre-fix body first (or assert the pin would have allowed it).
- **X2 (real DA still works):** as dept B's DA, `update_cert` + `delete_cert` on dept B's own cert → succeed.
- **X3 (plain member refused):** a plain member of dept B → both refused on authority.
- Expect clean across Indian Harbor / Lipan / North Hood; Demo/Granbury skip if they lack the two-member shape.

**Deliver the draft + dry run for my gate review BEFORE apply.** Ashlea applies after PASS; confirm the state row (both functions re-gated, `is_department_admin` refs 0 on these two, `verified` untouched). Then the live RETEST, rolled back.
