# RLS admin-gate fix — Steps A + B, live output (2026-10-20)

`sql/rls_admin_gate_STEP_AB_CHECK.sql`, run read-only on live by Ashlea. Emails are short hashes; nothing else elided.

## A1 — the gate functions (full live `pg_get_functiondef`)

| function | md5 | security | department-scoped | roles |
|---|---|---|---|---|
| `is_dept_admin()` | `c692e44f62923d2bf4c1a39a21a87bf7` | DEFINER | **yes** (`members.department_id = public.my_department_id()`) | Project Admin, Department Admin |
| `is_department_admin()` | `99570e1790f233594464da32436c8ca7` | DEFINER | **no** | Department Admin, Project Admin |
| `is_project_admin()` | `c9ccab22952488726207085155d7fdef` | DEFINER | no (cross-department by design) | Project Admin |
| `my_department_id()` | `87f546659c3804a943b48e419e017f18` | DEFINER | — (re-checks active membership of a saved department) | — |

Both `is_dept_admin()` and `is_department_admin()` were rebuilt byte-exact from these rows (md5s reproduce).

```sql
CREATE OR REPLACE FUNCTION public.is_dept_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.members
    where lower(members.email) = lower(auth.email())
      and members.status in ('Active','Probationary')
      and members.department_id = public.my_department_id()
      and members.access && array['Project Admin','Department Admin']::text[]
  );
$function$

CREATE OR REPLACE FUNCTION public.is_department_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from members
    where lower(members.email) = lower(auth.email())
      and members.status in ('Active','Probationary')
      and members.access && array['Department Admin','Project Admin']::text[]
  );
$function$
```

## A2 — the four policies as they are live (the draft pins these exactly)

| table · policy | cmd | USING | WITH CHECK |
|---|---|---|---|
| announcements · author or dept admin update announcements | UPDATE | `((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin()))` | same |
| announcements · author or dept admin delete announcements | DELETE | `((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin()))` | — |
| departments · DA can update own department | UPDATE | `((id = my_department_id()) AND is_department_admin())` | same |
| duty_log · dept admins edit duty_log | UPDATE | `(is_department_admin() AND (department_id = my_department_id()))` | same |

## B1 — every function that writes `departments`

| function | security | gate |
|---|---|---|
| `pa_create_department(...)` | DEFINER | `is_project_admin()` |
| `pa_set_disabled_modules(p_department_id, p_modules)` | DEFINER | `is_project_admin()` — any department by id |
| `pa_set_geofence_enabled(p_department_id, p_enabled)` | DEFINER | `is_project_admin()` — any department by id |
| `set_aftercall_enabled(p_enabled)` | DEFINER | `is_dept_admin()` — caller's own department |
| `set_probation_enabled(p_enabled)` | DEFINER | inline real-DA check — caller's own department |

**→ A Project Admin's cross-department reach is the `pa_*` RPCs, not the direct policy.** The app's three direct `departments` writes (name/station/city, brand kit, week start) all target `id = my_department_id()`.

## B2 — Project Admin member rows

| PA | department | status | access | PA access on this row |
|---|---|---|---|---|
| pa 0329021c | North Hood County VFD | Active | Project Admin, Department Admin, Board Member, Officer, Member | true |
| pa dabbc222 | Indian Harbor VFD | Active | Project Admin, Department Admin | true |

**→ Every PA holds PA access on each of their department rows → the plain swap on `departments` changes no PA's behaviour.** (The draft enforces this as a precondition.)

## B3 — blast radius

**0** people are DA/PA in one department and a plain member in another. The gap is latent: nobody can use it today, and the fix closes it before anyone can.
