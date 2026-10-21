# Cert catalog — Step 0b live output, 2026-10-21

Source: Ashlea ran `sql/cert_catalog_STEP0B_CHECK.sql` on live (read-only, one result set) and pasted the rows. Request: the
bottom list of `claude/B4C_CertCatalog_Step0_Review.md`. Step 0 is `docs/review/cert_catalog_STEP0_OUTPUT.md`.
The SQL editor's markdown export escapes one level (`\\` shown for a real `\`, `\|` for `|`); de-escaped below exactly
one level. That rule was proven on Step 0's `update_cert`: its export read `'^\\d{4}-\\d{2}$'` and the byte-exact rebuild
with `'^\d{4}-\d{2}$'` reproduced the live md5 `5cd098a1…`. md5s are the live values. No migration drafted.

All seven functions exist; no 'missing' rows. **Every definition below was checked: de-escaping the export one level
reproduces its live md5 byte-exact (all 7 match)** — so the text here is the live source, backslashes included.

---

## Findings, ranked

### G1 — Indian Harbor's 21 malformed dates are all `0000-00`, and the lax regex reads them as EXPIRED (live, visible today)
Item 8: Indian Harbor's 21 malformed rows are **one value, `0000-00` × 21** (an import placeholder for "no date"). It
**passes** the lax `^\d{4}-\d{2}$` (PGlite: `'0000-00' ~ '^\d{4}-\d{2}$'` = true; the strict `01–12` rule = false), and
month index `0*12 + 0` is in the past, so:
| reader | regex | `0000-00` reads |
|---|---|---|
| app `certStatus()` (roster badge, MemberDetail, NeedsAttention, reports … — origin/main ~10919) | lax | **EXPIRED** (red) |
| `dept_cert_readiness()` (dashboard %) | lax | **expired** (in `total_dated`, drags `pct` down) |
| `pa_department_radar()` `expired_certs_count` | lax | **expired** |
| `expiration_rows()` → Expirations, `my_expirations`, scorecard `certs` | strict | no date |
| `probation_item_states()` `kind='cert'` | strict | not current → `missing` |
So 21 Indian Harbor certs show **red EXPIRED** on the roster and count as expired on the DA dashboard and the PA radar,
while Expirations lists them as "no date". That's F2 made concrete — not latent. (Data/display only; nothing writes.)

### G2 — `my_department_rollup()`'s five cert counts are dead: its regex has a DOUBLED backslash (confirmed byte-exact)
Live source (md5 `058316de…` reproduced from the de-escaped text) carries **`'^\\d{4}-\\d{2}$'`** — two backslashes —
in all five cert counts; `pa_department_radar`, `dept_cert_readiness` and `update_cert` carry one. Under
`standard_conforming_strings = on` that regex means "a literal backslash, then dddd". PGlite, the exact literal inside a
plpgsql function: `'2026-12'` → false, `'0000-00'` → false, `'\dddd-\dd'` → true. So `expiring_certs_count`,
`expired_certs_count`, `my_certs_current`, `my_certs_expiring`, `my_certs_expired` are **always 0** for every caller —
the member's own cert card and the leaders' figures on the department rollup read 0 / 0 / 0 regardless of the data,
while the PA radar (single backslash) counts them. Read-only display bug, live today; no write path involved. Whether
it's fixed in the catalog migration (which has to touch cert reading anyway) or on its own is the reviewer's call.

### G3 — `readiness_window()` has no notion of "never expires" — a new bucket falls to `no_date` unless it's taught one
```
when p_bucket in ('expired','no_date') then p_bucket
when p_expires is null then 'no_date'      <- a no_expiry row (null date) lands here
when month-diff <= 3 then 'soon' else 'current'
```
Month arithmetic on America/Chicago, `≤ 3` — the shared/expiry.js `EXPIRING_MONTHS` rule (its comment: "keep in lockstep
with shared/expiry.js + certStatus(); the RETEST checks every month -2..+8"). So if `expiration_rows` emits a new
`no_expiry` bucket with a null `expires_on`, both callers (`readiness_items`' `creds`, `readiness_verdict`'s `certs`
list) would show it as **no_date** — the gap colour — unless `readiness_window` passes `no_expiry` through. Same for the
client's `expiryBucket()` (shared/expiry.js): `expired`/`no_date` stand, anything else with no parsable date → `no_date`.

### G4 — `probation_item_states()` already has a cert item, matched by NAME, and a never-expires cert can't satisfy it
`kind = 'cert'` items: satisfied = `exists` a cert of the member with `lower(btrim(c.name)) = lower(btrim(i.cert_name))`
AND strict `YYYY-MM` AND expiry month ≥ this month (Chicago; "expiring" counts as current). A cert with blank exp — the
112 blank Indian Harbor rows, and every future never-expires cert — reads **`missing`**. Two catalog consequences for the
reviewer: (a) `never_expires` has to land here too, and (b) the item's free-text `cert_name` match is the natural thing
for a `cert_type_id` to replace (or sit alongside). Note `c.member_id = p_member` has no department term here, but the
member id is already department-pinned by `mem` (`m.id = p_member and m.department_id = p_dept`) — cross-join gives 0
rows otherwise. No department leak.

### G5 — the two dashboard readers carry their own cert logic (not `expiration_rows`)
`my_department_rollup()` and `pa_department_radar()` each count certs inline (the rollup's regex is broken — G2; the radar's is the lax one): **`now()` in UTC** (not
America/Chicago — differs from `dept_cert_readiness` / `readiness_window` for a few hours at a month boundary),
expiring = month-diff `between 0 and 3`, expired = `< 0`, and **every cert row** in the department (no Inactive /
separated / PA exclusion — unlike `expiration_rows`). A never-expires cert with blank exp is simply not counted by
either (only dated rows are), so `never_expires` doesn't perturb them **unless** a never-expires type is allowed to keep
a date. The `0000-00` rows (G1) do count as expired in the radar.

### Confirmed / unaffected
- **`my_expirations()`** delegates entirely: `return query select * from public.expiration_rows(v_dept, v_me)` (after
  the `my_department_id` / `my_member_id` null check). Inherits whatever `expiration_rows` does.
- **`is_muted(uuid,text)`** matched the Step 0 `certs` scan only because `'certs'` is a notification-family string
  (`p_family IN ('certs','gear','maint','events','tasks','shifts')`). Unaffected by the catalog.
- **`qualification_cells(uuid,uuid)`** — the shape to mirror: honest roster `mem` CTE (same Inactive / PA / separated
  exclusion as `expiration_rows`) × the department's **active** types, left-joined to the per-member record; status
  `qualified` / `in_progress` / `not_started`. Members exec: not checked (internal, like `expiration_rows`).
- **`readiness_requirements_uq`** live: `CREATE UNIQUE INDEX readiness_requirements_uq ON public.readiness_requirements
  USING btree (department_id, kind, ref_id) NULLS NOT DISTINCT` — valid, ready, unique. A `cert_type` kind with a
  non-null `ref_id` is covered by the same `ON CONFLICT (department_id, kind, ref_id)`.
- **Demo's 6 malformed** are full ISO dates `YYYY-MM-DD` (2026-09-15, 2026-12-31, 2027-03-01, 2027-05-01, 2027-06-01,
  2028-01-01) — fail both regexes (anchored `$`), read "no date" everywhere; each truncates cleanly to `YYYY-MM`. Demo
  data, so low stakes.

## Malformed `exp` values (item 8, distinct, no PII)
| department | value | rows |
|---|---|---|
| Indian Harbor VFD | `0000-00` | 21 |
| B4C Demo Department | `2026-09-15` · `2026-12-31` · `2027-03-01` · `2027-05-01` · `2027-06-01` · `2028-01-01` | 1 each (6) |
Totals: Indian Harbor 21 rows / 1 distinct · Demo 6 rows / 6 distinct = the 27 Step 0 counted.

---

## Full definitions

### readiness_window(text,date) — md5 35a62755ffc68b4db8b05dbe26d3b37b
```sql
CREATE OR REPLACE FUNCTION public.readiness_window(p_bucket text, p_expires date)
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:scorecard (internal) — shared/expiry.js expiryBucket() in SQL: expired / no_date stand; otherwise the expiry MONTH
-- within EXPIRING_MONTHS (3) of this month (America/Chicago) = 'soon', else 'current'. Keep in lockstep with
-- shared/expiry.js + certStatus() (the RETEST checks every month -2..+8).
  select case
    when p_bucket in ('expired', 'no_date') then p_bucket
    when p_expires is null then 'no_date'
    when (extract(year from p_expires)::int * 12 + extract(month from p_expires)::int)
         - (extract(year from (now() at time zone 'America/Chicago'))::int * 12 + extract(month from (now() at time zone 'America/Chicago'))::int) <= 3
      then 'soon'
    else 'current' end;
$function$
```

### my_expirations() — md5 ffcceab959e8ea59e71a9d9c6d241590
```sql
CREATE OR REPLACE FUNCTION public.my_expirations()
 RETURNS TABLE(scope text, source text, item_id uuid, member_id uuid, apparatus_id uuid, subject text, kind text, label text, cls text, expires_on date, days_until integer, bucket text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:expirations — the caller's own: their certs, credentials and assigned gear, ranked. Read-only.
declare v_dept uuid := public.my_department_id(); v_me uuid := public.my_member_id();
begin
  if v_dept is null or v_me is null then raise exception 'We could not match your login to a department.'; end if;
  return query select * from public.expiration_rows(v_dept, v_me);
end;
$function$
```

### is_muted(uuid,text) — md5 4e5107d4104e2ac4a8bd2d2347b5db49
```sql
CREATE OR REPLACE FUNCTION public.is_muted(p_member uuid, p_family text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_enabled boolean;
begin
  IF p_family IS NULL OR p_family NOT IN ('certs','gear','maint','events','tasks','shifts') THEN
    RAISE EXCEPTION 'is_muted: unknown notification family %. A typo here would silently ignore a member''s opt-out.', coalesce(p_family, '<null>');
  END IF;

  select enabled into v_enabled
    from public.notification_prefs
   where member_id = p_member and family = p_family;

  -- ABSENCE MEANS ON, matching the client: a member who has never opened the
  -- preferences screen has no row, and no row is not an opt-out.
  return v_enabled is not null and v_enabled = false;
end;
$function$
```

### qualification_cells(uuid,uuid) — md5 1bc131666ee85c5012337ffb10b56cb6
```sql
CREATE OR REPLACE FUNCTION public.qualification_cells(p_dept uuid, p_member uuid DEFAULT NULL::uuid)
 RETURNS TABLE(member_id uuid, type_id uuid, status text, drives integer, signed_off_by_name text, signed_off_at timestamp with time zone, note text, revoked_at timestamp with time zone, revoked_by_name text, revoke_reason text)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:qualifications (internal) — every ACTIVE type of the department x the given member (or the honest roster:
-- not Inactive, not former, not a Project Admin). Read-only.
  with mem as (
    select m.id from public.members m
     where m.department_id = p_dept
       and (case when p_member is not null then m.id = p_member
                 else m.status is distinct from 'Inactive'
                      and not coalesce(m.access && array['Project Admin']::text[], false)
                      and not exists (select 1 from public.member_separation s where s.member_id = m.id) end)
  ),
  ty as (select t.id, t.kind from public.qualification_types t where t.department_id = p_dept and t.active),
  dr as (select ss.member_id, ss.counts_toward, count(*)::int as n from public.supervised_sessions ss
          where ss.department_id = p_dept and ss.voided_at is null and ss.kind = 'drive'
          group by ss.member_id, ss.counts_toward)
  select mem.id, ty.id,
         case when q.id is not null and q.revoked_at is null then 'qualified'
              when coalesce(dr.n, 0) > 0 then 'in_progress'
              else 'not_started' end,
         coalesce(dr.n, 0),
         sb.name, q.signed_off_at, q.note, q.revoked_at, rb.name, q.revoke_reason
    from mem cross join ty
    left join public.member_qualifications q on q.member_id = mem.id and q.qualification_type_id = ty.id and q.department_id = p_dept
    left join dr on dr.member_id = mem.id and dr.counts_toward = ty.id::text
    left join public.members sb on sb.id = q.signed_off_by
    left join public.members rb on rb.id = q.revoked_by;
$function$
```

### probation_item_states(uuid,uuid) — md5 bbe66fcac2ddd9931e12d9226d1ed800
```sql
CREATE OR REPLACE FUNCTION public.probation_item_states(p_member uuid, p_dept uuid)
 RETURNS TABLE(item_id uuid, label text, category text, phase text, kind text, clears_to_run boolean, sort_order integer, satisfied boolean, state text, signed_by_name text, signed_at timestamp with time zone, have numeric, target numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation (internal) — every onboarding item of the department, resolved for one member. Read-only.
-- onboarding_item_config: a manual item can also read approver_not_set / awaiting_check / awaiting_approval.
  with mem as (select m.id, m.mentor_id from public.members m where m.id = p_member and m.department_id = p_dept),
       pr as (select (select mp.started_on from public.member_probation mp where mp.member_id = p_member) as started_on),
       td as (select (now() at time zone 'America/Chicago')::date as d)
  select i.id, i.label, i.category, i.phase, i.kind, i.clears_to_run, i.sort_order,
         case when i.kind = 'manual' and i.is_mentor then mem.mentor_id is not null
              when i.kind = 'manual' then coalesce(pg.done, false)
              when i.kind = 'ack'    then ak.series_id is not null and ak.published and (not ak.in_audience or ak.signed_current)
              when i.kind = 'hours'  then i.hours_target is not null and i.hours_source is not null and hr.have >= i.hours_target
              when i.kind = 'cert'   then nullif(btrim(coalesce(i.cert_name, '')), '') is not null and ct.current
         end,
         case when i.kind = 'manual' and i.is_mentor then case when mem.mentor_id is not null then 'mentor_assigned' else 'open' end
              when i.kind = 'manual' then case when pg.done and pg.checked_by is not null then 'signed'
                                               when pg.done then 'done_unrecorded'
                                               when not coalesce(ap.resolvable, true) then 'approver_not_set'
                                               when pg.ready_at is not null and i.requires_doc then 'awaiting_check'
                                               when pg.ready_at is not null then 'awaiting_approval' else 'open' end
              when i.kind = 'ack' then case when ak.series_id is null or not ak.published then 'not_configured'
                                            when not ak.in_audience then 'not_required'
                                            when ak.signed_current then 'signed_current' else 'needs_signature' end
              when i.kind = 'hours' then case when i.hours_target is null or i.hours_source is null then 'not_configured'
                                              when hr.have >= i.hours_target then 'met' else 'in_progress' end
              when i.kind = 'cert' then case when nullif(btrim(coalesce(i.cert_name, '')), '') is null then 'not_configured'
                                             when ct.current then 'current' else 'missing' end
         end,
         case when i.kind = 'manual' and not i.is_mentor and pg.done then pg.signer end,
         case when i.kind = 'manual' and not i.is_mentor and pg.done then pg.checked_at end,
         case when i.kind = 'hours' then hr.have end,
         case when i.kind = 'hours' then i.hours_target end
    from public.onboarding_items i
    cross join mem cross join pr cross join td
    left join lateral (select p.done, p.checked_by, p.checked_at, p.ready_at, cb.name as signer
                         from public.onboarding_progress p left join public.members cb on cb.id = p.checked_by
                        where p.member_id = p_member and p.item_id = i.id
                        order by p.checked_at desc nulls last limit 1) pg on true
    left join lateral (select s.series_id, (s.requires_ack and s.current_version > 0) as published,
                              public.rs_member_in_audience(p_member, s.required_roles) as in_audience,
                              exists (select 1 from public.document_acknowledgments k
                                       where k.member_id = p_member and k.series_id = s.series_id and k.version = s.current_version
                                         and (not s.annual_resign or (k.signed_at at time zone 'America/Chicago')::date + interval '12 months' > td.d)) as signed_current
                         from public.document_series s
                        where i.kind = 'ack' and s.series_id = i.ack_series_id and s.department_id = p_dept) ak on true
    left join lateral (select case when i.hours_source = 'training_nights' then
                                (select count(distinct a.session_id)::numeric from public.session_attendance a
                                   join public.training_sessions t on t.id = a.session_id and t.department_id = p_dept
                                  where a.member_id = p_member and t.date <= td.d)
                              else
                                (select coalesce(sum(ss.hours), 0) from public.supervised_sessions ss
                                  where ss.member_id = p_member and ss.department_id = p_dept and ss.voided_at is null
                                    and (i.hours_source = 'supervised' or ss.kind = i.hours_source))
                              end as have
                        where i.kind = 'hours') hr on true
    left join lateral (select exists (select 1 from public.certs c
                                        where c.member_id = p_member and lower(btrim(c.name)) = lower(btrim(i.cert_name))
                                          and c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'
                                          and split_part(c.exp, '-', 1)::int * 12 + split_part(c.exp, '-', 2)::int
                                              >= extract(year from td.d)::int * 12 + extract(month from td.d)::int) as current
                        where i.kind = 'cert') ct on true
    left join lateral (select case when i.approver_kind = 'person' then exists (select 1 from public.members am
                                        where am.id = i.approver_member_id and am.department_id = p_dept and am.status in ('Active', 'Probationary'))
                                   when i.approver_role is not null then exists (select 1 from public.members am
                                        where am.department_id = p_dept and am.status in ('Active', 'Probationary') and am.access && array[i.approver_role])
                                   else true end as resolvable
                        where i.kind = 'manual' and not i.is_mentor) ap on true
   where i.department_id = p_dept;
$function$
```

## Full definitions, continued — the two dashboard readers (de-escaped one level; md5s reproduced byte-exact)

### pa_department_radar() — md5 224f9ec3d5cdd53600b7d5d74319708a
```sql
CREATE OR REPLACE FUNCTION public.pa_department_radar()
 RETURNS TABLE(department_id uuid, department_name text, station text, city text, admin_name text, admin_email text, health text, last_activity timestamp with time zone, days_since_activity integer, active_members_30d bigint, member_count bigint, documents_count bigint, apparatus_count bigint, training_sessions_count bigint, profile_complete boolean, members_no_email_count bigint, documents_no_text_count bigint, expiring_certs_count bigint, expired_certs_count bigint, overdue_duties_count bigint, open_action_items_count bigint, open_long_shifts_count bigint, profile_missing text[])
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not is_project_admin() then raise exception 'Not authorized'; end if;
  return query
  with base as (
    select
      d.id as department_id, d.name as department_name, d.station, d.city,
      (select m.name from members m
         where m.department_id = d.id and m.access && array['Department Admin']::text[]
           and m.email is not null and btrim(m.email) <> ''
         order by m.created_at asc nulls last limit 1) as admin_name,
      (select lower(m.email) from members m
         where m.department_id = d.id and m.access && array['Department Admin']::text[]
           and m.email is not null and btrim(m.email) <> ''
         order by m.created_at asc nulls last limit 1) as admin_email,
      greatest(
        (select max(sa.checked_in_at) from session_attendance sa where sa.department_id = d.id),
        (select max(dl.done_at)       from duty_log dl          where dl.department_id = d.id),
        (select max(ai.created_at)    from action_items ai      where ai.department_id = d.id),
        (select max(doc.created_at)   from documents doc        where doc.department_id = d.id
                                                                  and doc.deleted_at is null and doc.archived_at is null),
        (select max(an.created_at)    from announcements an     where an.department_id = d.id),
        (select max(ts.created_at)    from training_sessions ts where ts.department_id = d.id)
      ) as last_activity,
      (select count(distinct mid) from (
          select sa.member_id as mid from session_attendance sa
            where sa.department_id = d.id and sa.checked_in_at >= now() - interval '30 days'
          union
          select dl.done_by from duty_log dl
            where dl.department_id = d.id and dl.done_at >= now() - interval '30 days'
          union
          select ai.completed_by from action_items ai
            where ai.department_id = d.id and ai.completed_at >= now() - interval '30 days'
       ) act where mid is not null) as active_members_30d,
      (select count(*) from members mm where mm.department_id = d.id
                                        and not (mm.access && array['Project Admin']::text[])) as member_count,
      (select count(*) from documents dc where dc.department_id = d.id
                                          and dc.deleted_at is null and dc.archived_at is null) as documents_count,
      (select count(*) from apparatus ap where ap.department_id = d.id) as apparatus_count,
      (select count(*) from training_sessions ts where ts.department_id = d.id) as training_sessions_count,
      (    d.tagline is not null and btrim(d.tagline) <> ''
       and d.voice is not null and btrim(d.voice) <> ''
       and d.primary_color is not null and d.primary_color <> '#B11E2A'
       and d.accent_color is not null and d.accent_color <> '#1F4E79') as profile_complete,
      (select count(*) from members mm where mm.department_id = d.id
                                        and not (mm.access && array['Project Admin']::text[])
                                        and (mm.email is null or btrim(mm.email) = '')) as members_no_email_count,
      (select count(*) from documents dc where dc.department_id = d.id
                                          and dc.deleted_at is null and dc.archived_at is null
                                          and (dc.content_text is null or btrim(dc.content_text) = '')) as documents_no_text_count,
      (select count(*) from certs c where c.department_id = d.id and c.exp ~ '^\d{4}-\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) between 0 and 3) as expiring_certs_count,
      (select count(*) from certs c where c.department_id = d.id and c.exp ~ '^\d{4}-\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) < 0) as expired_certs_count,
      (select count(*) from duties du where du.department_id = d.id
                                       and du.done = false and du.due_date is not null and du.due_date < current_date) as overdue_duties_count,
      (select count(*) from action_items ai where ai.department_id = d.id and ai.status = 'open') as open_action_items_count,
      (select count(*) from station_presence sp
         where sp.department_id = d.id
           and sp.checked_out_at is null
           and sp.checked_in_at < now() - interval '24 hours') as open_long_shifts_count,
      -- One label per UNMET profile_complete condition, each the exact negation of its clause above,
      -- so the array is empty exactly when profile_complete is true.
      array_remove(array[
        case when d.tagline is not null and btrim(d.tagline) <> ''          then null else 'Tagline' end,
        case when d.voice is not null and btrim(d.voice) <> ''              then null else 'Voice' end,
        case when d.primary_color is not null and d.primary_color <> '#B11E2A' then null else 'Custom primary color' end,
        case when d.accent_color is not null and d.accent_color <> '#1F4E79'   then null else 'Custom accent color' end
      ], null) as profile_missing
    from departments d
  )
  select b.department_id, b.department_name, b.station, b.city, b.admin_name, b.admin_email,
    case when b.last_activity is null then 'RED'
         when current_date - b.last_activity::date < 14 then 'GREEN'
         when current_date - b.last_activity::date <= 30 then 'YELLOW'
         else 'RED' end as health,
    b.last_activity,
    case when b.last_activity is null then null else current_date - b.last_activity::date end as days_since_activity,
    b.active_members_30d, b.member_count, b.documents_count, b.apparatus_count, b.training_sessions_count,
    b.profile_complete, b.members_no_email_count, b.documents_no_text_count,
    b.expiring_certs_count, b.expired_certs_count, b.overdue_duties_count, b.open_action_items_count,
    b.open_long_shifts_count,
    b.profile_missing
  from base b
  order by
    case when b.last_activity is null then 0
         when current_date - b.last_activity::date > 30 then 0
         when current_date - b.last_activity::date >= 14 then 1 else 2 end,
    b.last_activity asc nulls first, b.department_name asc;
end;
$function$
```

### my_department_rollup() — md5 058316de93cfdde8fbe732121c4b903f
```sql
CREATE OR REPLACE FUNCTION public.my_department_rollup()
 RETURNS TABLE(department_id uuid, department_name text, station text, city text, can_manage boolean, admin_name text, admin_email text, health text, last_activity timestamp with time zone, days_since_activity integer, active_members_30d bigint, member_count bigint, documents_count bigint, apparatus_count bigint, training_sessions_count bigint, profile_complete boolean, members_no_email_count bigint, documents_no_text_count bigint, expiring_certs_count bigint, expired_certs_count bigint, overdue_duties_count bigint, open_action_items_count bigint, my_attendance_pct integer, my_attendance_total integer, my_attendance_attended integer, my_certs_current integer, my_certs_expiring integer, my_certs_expired integer, my_open_duties integer, my_overdue_duties integer, my_next_event_date date, my_next_event_title text, my_next_event_type text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  return query
  with base as (
    select
      d.id as department_id, d.name as department_name, d.station, d.city,

      -- WHAT THE CALLER IS **HERE**. me.my_access is this person's roles at THIS
      -- department; a leader at one station is not a leader at the next.
      coalesce(me.my_access && array['Board Member','Department Admin','Officer']::text[], false) as can_manage,
      -- is_leader()'s array, used ONLY to decide whether restricted drills count
      -- toward this member's own attendance rate (mirrors MemberDashboard).
      coalesce(me.my_access && array['Project Admin','Department Admin','Board Member','Officer']::text[], false) as my_is_leader,
      me.my_mid,

      (select m.name from members m
         where m.department_id = d.id and m.access && array['Department Admin']::text[]
           and m.email is not null and btrim(m.email) <> ''
         order by m.created_at asc nulls last limit 1) as admin_name,
      (select lower(m.email) from members m
         where m.department_id = d.id and m.access && array['Department Admin']::text[]
           and m.email is not null and btrim(m.email) <> ''
         order by m.created_at asc nulls last limit 1) as admin_email,
      greatest(
        (select max(sa.checked_in_at) from session_attendance sa where sa.department_id = d.id),
        (select max(dl.done_at)       from duty_log dl          where dl.department_id = d.id),
        (select max(ai.created_at)    from action_items ai      where ai.department_id = d.id),
        (select max(doc.created_at)   from documents doc        where doc.department_id = d.id
                                                                  and doc.deleted_at is null and doc.archived_at is null),
        (select max(an.created_at)    from announcements an     where an.department_id = d.id),
        (select max(ts.created_at)    from training_sessions ts where ts.department_id = d.id)
      ) as last_activity,
      (select count(distinct mid) from (
          select sa.member_id as mid from session_attendance sa
            where sa.department_id = d.id and sa.checked_in_at >= now() - interval '30 days'
          union
          select dl.done_by from duty_log dl
            where dl.department_id = d.id and dl.done_at >= now() - interval '30 days'
          union
          select ai.completed_by from action_items ai
            where ai.department_id = d.id and ai.completed_at >= now() - interval '30 days'
       ) act where mid is not null) as active_members_30d,
      (select count(*) from members mm where mm.department_id = d.id) as member_count,
      (select count(*) from documents dc where dc.department_id = d.id
                                          and dc.deleted_at is null and dc.archived_at is null) as documents_count,
      (select count(*) from apparatus ap where ap.department_id = d.id) as apparatus_count,
      (select count(*) from training_sessions ts where ts.department_id = d.id) as training_sessions_count,
      (    d.tagline is not null and btrim(d.tagline) <> ''
       and d.voice is not null and btrim(d.voice) <> ''
       and d.primary_color is not null and d.primary_color <> '#B11E2A'
       and d.accent_color is not null and d.accent_color <> '#1F4E79') as profile_complete,
      (select count(*) from members mm where mm.department_id = d.id
                                        and (mm.email is null or btrim(mm.email) = '')) as members_no_email_count,
      (select count(*) from documents dc where dc.department_id = d.id
                                          and dc.deleted_at is null and dc.archived_at is null
                                          and (dc.content_text is null or btrim(dc.content_text) = '')) as documents_no_text_count,
      (select count(*) from certs c where c.department_id = d.id and c.exp ~ '^\\d{4}-\\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) between 0 and 3) as expiring_certs_count,
      (select count(*) from certs c where c.department_id = d.id and c.exp ~ '^\\d{4}-\\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) < 0) as expired_certs_count,
      (select count(*) from duties du where du.department_id = d.id
                                       and du.done = false and du.due_date is not null and du.due_date < current_date) as overdue_duties_count,
      (select count(*) from action_items ai where ai.department_id = d.id and ai.status = 'open') as open_action_items_count,

      -- ================= MEMBER-SCOPED =================
      -- Every one of these is filtered to me.my_mid. They are computed for all
      -- callers (they are the caller's OWN data, never anybody else's) and are
      -- what a non-managing member sees in place of the leadership figures.

      -- ATTENDANCE, this calendar month, mirroring MemberDashboard.monthRate:
      -- a drill counts only if it is done, has at least one recorded attendee,
      -- is not flagged optional, and — for a non-leader — is not restricted.
      -- The "has an attendee" test is what makes this "recorded drills" rather
      -- than "scheduled drills"; a session nobody signed into is not a missed
      -- drill, it is an unheld one.
      (select count(*) from training_sessions ts
        where ts.department_id = d.id and ts.done
          and date_trunc('month', ts.date) = date_trunc('month', current_date)
          and coalesce(ts.counts_toward_attendance, true) <> false
          and (coalesce(me.my_access && array['Project Admin','Department Admin','Board Member','Officer']::text[], false)
               or coalesce(ts.audience,'everyone') not in ('leadership','board'))
          and exists (select 1 from session_attendance sa where sa.session_id = ts.id)
      )::int as my_attendance_total,
      (select count(*) from training_sessions ts
        where ts.department_id = d.id and ts.done
          and date_trunc('month', ts.date) = date_trunc('month', current_date)
          and coalesce(ts.counts_toward_attendance, true) <> false
          and (coalesce(me.my_access && array['Project Admin','Department Admin','Board Member','Officer']::text[], false)
               or coalesce(ts.audience,'everyone') not in ('leadership','board'))
          and exists (select 1 from session_attendance sa
                       where sa.session_id = ts.id and sa.member_id = me.my_mid)
      )::int as my_attendance_attended,

      -- CERTS — same month-arithmetic and same regex as the leadership columns
      -- above, filtered to this member. The three buckets are disjoint, so a
      -- cert is current, expiring, or expired, never two of them.
      (select count(*) from certs c where c.department_id = d.id and c.member_id = me.my_mid
           and c.exp ~ '^\\d{4}-\\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) > 3)::int as my_certs_current,
      (select count(*) from certs c where c.department_id = d.id and c.member_id = me.my_mid
           and c.exp ~ '^\\d{4}-\\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) between 0 and 3)::int as my_certs_expiring,
      (select count(*) from certs c where c.department_id = d.id and c.member_id = me.my_mid
           and c.exp ~ '^\\d{4}-\\d{2}$'
           and (split_part(c.exp,'-',1)::int*12 + split_part(c.exp,'-',2)::int)
             - (extract(year from now())::int*12 + extract(month from now())::int) < 0)::int as my_certs_expired,

      -- DUTIES assigned to me here. Two numbers, because the card needs both:
      -- open drives the "N due" stat, overdue drives the red edge.
      (select count(*) from duties du where du.department_id = d.id
                                       and du.assigned_to = me.my_mid and du.done = false)::int as my_open_duties,
      (select count(*) from duties du where du.department_id = d.id
                                       and du.assigned_to = me.my_mid and du.done = false
                                       and du.due_date is not null and du.due_date < current_date)::int as my_overdue_duties,

      -- NEXT EVENT across the same four calendar sources MemberDashboard reads.
      -- Audience-aware: a non-leader is not told about a leadership-only drill
      -- they cannot attend. content_calendar's text column is `caption`, not
      -- `title` — confirmed against the live schema, not assumed.
      nx.nd as my_next_event_date, nx.nt as my_next_event_title, nx.nk as my_next_event_type

    from departments d
    -- The caller's own member row AT THIS DEPARTMENT. Phase 1b's unique index on
    -- (lower(email), department_id) guarantees at most one, so this cannot fan out;
    -- the limit 1 is belt and braces.
    left join lateral (
      select m.id as my_mid, m.access as my_access
        from members m
       where m.email is not null
         and lower(m.email) = lower(auth.email())
         and m.status in ('Active','Probationary')
         and m.department_id = d.id
       limit 1
    ) me on true
    left join lateral (
      select x.d as nd, x.t as nt, x.k as nk
        from (
          select ts.date as d, ts.title as t, 'Training'::text as k
            from training_sessions ts
           where ts.department_id = d.id and ts.date >= current_date
             and (coalesce(me.my_access && array['Project Admin','Department Admin','Board Member','Officer']::text[], false)
                  or coalesce(ts.audience,'everyone') not in ('leadership','board'))
          union all
          select fe.date, fe.title, 'Funding'::text
            from funding_events fe where fe.department_id = d.id and fe.date >= current_date
          union all
          select re.date, re.title, 'Recruitment'::text
            from recruitment_events re where re.department_id = d.id and re.date >= current_date
          union all
          select cc.date, cc.caption, 'Content'::text
            from content_calendar cc where cc.department_id = d.id and cc.date >= current_date
        ) x
       order by x.d asc, x.k asc
       limit 1
    ) nx on true
    -- UNCHANGED FROM PHASE 2 — the authorization boundary, verbatim.
    where d.id in (
      select m.department_id from public.members m
      where lower(m.email) = lower(auth.email())
        and m.status in ('Active','Probationary')
    )
  )
  select
    b.department_id, b.department_name, b.station, b.city,
    b.can_manage,
    -- EVERY leadership column is gated on can_manage. This is the whole point of
    -- the migration: a non-managing member gets NULL over the wire, not a number
    -- the client is trusted to hide.
    case when b.can_manage then b.admin_name  end,
    case when b.can_manage then b.admin_email end,
    case when b.can_manage then
      case when b.last_activity is null then 'RED'
           when current_date - b.last_activity::date < 14 then 'GREEN'
           when current_date - b.last_activity::date <= 30 then 'YELLOW'
           else 'RED' end
    end as health,
    case when b.can_manage then b.last_activity end,
    case when b.can_manage then
      case when b.last_activity is null then null else current_date - b.last_activity::date end
    end as days_since_activity,
    case when b.can_manage then b.active_members_30d      end,
    case when b.can_manage then b.member_count            end,
    case when b.can_manage then b.documents_count         end,
    case when b.can_manage then b.apparatus_count         end,
    case when b.can_manage then b.training_sessions_count end,
    case when b.can_manage then b.profile_complete        end,
    case when b.can_manage then b.members_no_email_count  end,
    case when b.can_manage then b.documents_no_text_count end,
    case when b.can_manage then b.expiring_certs_count    end,
    case when b.can_manage then b.expired_certs_count     end,
    case when b.can_manage then b.overdue_duties_count    end,
    case when b.can_manage then b.open_action_items_count end,
    -- Member-scoped: always returned, always the caller's own data.
    -- pct is NULL when the month held no qualifying drills — "no drills yet" and
    -- "attended none of them" are different facts and must not both read as 0%.
    case when b.my_attendance_total > 0
         then round(b.my_attendance_attended * 100.0 / b.my_attendance_total)::int end as my_attendance_pct,
    b.my_attendance_total, b.my_attendance_attended,
    b.my_certs_current, b.my_certs_expiring, b.my_certs_expired,
    b.my_open_duties, b.my_overdue_duties,
    b.my_next_event_date, b.my_next_event_title, b.my_next_event_type
  from base b
  order by
    case when b.last_activity is null then 0
         when current_date - b.last_activity::date > 30 then 0
         when current_date - b.last_activity::date >= 14 then 1 else 2 end,
    b.last_activity asc nulls first, b.department_name asc;
end;
$function$
```
