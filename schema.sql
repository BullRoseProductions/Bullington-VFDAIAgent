-- =============================================================================
-- The Dayroom — Database Schema Reference
-- Project: BullRoseProductions/Bullington-VFDAIAgent
-- Supabase project: ifeptqnlucmvhlvadcpj
-- Captured: 2026-06-27
-- =============================================================================
--
-- WHAT THIS IS
--   A human-readable snapshot of the Supabase backend: table structures, all
--   Row-Level Security (RLS) policies, and all custom Postgres functions
--   (security helpers + the certification pipeline).
--
--   This file exists because the entire backend lives only inside the live
--   Supabase project — it is not otherwise tracked in git. This snapshot makes
--   the security architecture reproducible, recoverable, and reviewable.
--
-- WHAT THIS IS NOT
--   This is a *reference* snapshot, not a guaranteed one-click rebuild script.
--   It does not include: row data, foreign-key/constraint definitions beyond
--   columns, indexes, sequences, grants, triggers, the auth schema, or the
--   members_view definition. For a complete, replayable dump + migration
--   history, adopt the Supabase CLI (`supabase db dump`) — tracked as a future
--   task. Until then, this file is the durable record of the structure.
--
-- ISOLATION MODEL (built 2026-06-27)
--   Every station-specific table is scoped by department via the helper
--   my_department_id(), so one department can never read another's data.
--   Two deliberate exceptions:
--     - training_plans : shared library, readable by any authenticated user.
--     - departments    : readable by any authenticated user (needed to function).
--
-- KNOWN GAPS / FOLLOW-UPS
--   - duties, duty_log : still readable by any authenticated user (USING true).
--       They have a department_id column but were NOT yet department-scoped.
--       Harmless for a single-department pilot; MUST be scoped before a 2nd
--       department joins. (Same pattern as the others:
--       USING (department_id = my_department_id()).)
--   - profiles : table exists but had no RLS policy in the capture — review
--       before pilot (confirm intended access / whether it's in use).
--   - Write policies: most tables have SELECT policies only. Writes are denied
--       by default (RLS denies unless allowed). Add leader-write policies
--       table-by-table as edit features are built. The certs table is mutated
--       ONLY through the SECURITY DEFINER functions below, never direct writes.
-- =============================================================================


-- =============================================================================
-- SECTION 1 — TABLE STRUCTURES
-- (columns / types / nullability / defaults — for reference)
-- =============================================================================

CREATE TABLE public.action_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  meeting_id uuid,
  text text NOT NULL,
  owner text,
  status text DEFAULT 'open'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.ai_feedback (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  feature text,
  rating text,
  tags ARRAY,
  original text,
  edited text,
  by text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.apparatus (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  name text NOT NULL,
  type text,
  last_check text,
  checked_by text,
  status text DEFAULT 'Pass'::text,
  note text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.cert_submissions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  member_id uuid NOT NULL,
  name text NOT NULL,
  exp text,
  status text NOT NULL DEFAULT 'pending'::text,
  source text NOT NULL DEFAULT 'manual'::text,
  note text,
  proposed_by uuid,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.certs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  member_id uuid NOT NULL,
  name text NOT NULL,
  exp text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.content_calendar (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  date date,
  theme text,
  caption text,
  status text DEFAULT 'planned'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.departments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  station text,
  primary_color text DEFAULT '#B11E2A'::text,
  accent_color text DEFAULT '#1F4E79'::text,
  font text DEFAULT 'Modern sans'::text,
  tagline text,
  voice text,
  logo_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  name text NOT NULL,
  type text,
  file_url text,
  uploaded_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- NOTE: duties.department_id exists but this table is NOT yet department-scoped (see header).
CREATE TABLE public.duties (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  duty text NOT NULL,
  category text DEFAULT 'Station'::text,
  recurrence text DEFAULT 'Weekly'::text,
  done boolean NOT NULL DEFAULT false,
  done_by text,
  done_at text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- NOTE: duty_log.department_id exists but this table is NOT yet department-scoped (see header).
CREATE TABLE public.duty_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  what text NOT NULL,
  who text,
  "when" text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  name text NOT NULL,
  date text,
  type text,
  present integer,
  total integer,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.fundraisers (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  name text NOT NULL,
  date text,
  amount numeric DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.maintenance (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  unit text,
  task text NOT NULL,
  cadence text DEFAULT 'Monthly'::text,
  last text,
  status text DEFAULT 'Current'::text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.meetings (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  title text NOT NULL,
  date date,
  minutes text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.member_notes (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  member_id uuid NOT NULL,
  text text NOT NULL,
  by text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.members (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  name text NOT NULL,
  role text,
  access text NOT NULL DEFAULT 'Member'::text,
  status text DEFAULT 'Active'::text,
  phone text,
  joined text,
  participation integer,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  email text,
  address text
);

-- members_view is a VIEW (column-masking layer over members), not a base table.
-- Its full definition is NOT captured here — recapture with:
--   SELECT pg_get_viewdef('public.members_view'::regclass, true);
-- Columns (for reference):
--   id, department_id, name, role, access, status, phone, joined,
--   participation, created_at, email, address

CREATE TABLE public.onboarding_progress (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  member_id uuid,
  item_key text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- NOTE: profiles had no RLS policy in the capture — review before pilot (see header).
CREATE TABLE public.profiles (
  id uuid NOT NULL,
  department_id uuid,
  member_id uuid,
  access text NOT NULL DEFAULT 'Member'::text,
  email text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.session_attendance (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  session_id uuid NOT NULL,
  member_id uuid NOT NULL,
  checked_in_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.training_plans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  name text NOT NULL,
  cadence text NOT NULL DEFAULT 'Monthly'::text,
  last_iso date,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE TABLE public.training_sessions (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  plan_id uuid,
  title text NOT NULL,
  date date NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);


-- =============================================================================
-- SECTION 2 — CUSTOM FUNCTIONS
-- Security helpers + certification pipeline. All SECURITY DEFINER.
-- =============================================================================

-- --- Security helpers -------------------------------------------------------

CREATE OR REPLACE FUNCTION public.is_leader()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from members
    where lower(members.email) = lower(auth.email())
      and members.access in (
        'Project Admin',
        'Department Admin',
        'Board Member',
        'Training Officer'
      )
  );
$function$;

CREATE OR REPLACE FUNCTION public.is_department_admin()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from members
    where lower(members.email) = lower(auth.email())
      and members.access in ('Department Admin', 'Project Admin')
  );
$function$;

CREATE OR REPLACE FUNCTION public.my_department_id()
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select department_id
  from public.members
  where lower(email) = lower(auth.email())
  limit 1;
$function$;

-- --- Certification pipeline (the ONLY write path into public.certs) ----------

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
  -- authority gate (definer bypasses RLS, so we check explicitly)
  if not public.is_department_admin() then
    raise exception 'Not authorized to approve cert submissions';
  end if;

  select * into sub from public.cert_submissions where id = submission_id;

  if not found then
    raise exception 'Submission not found';
  end if;

  if sub.status <> 'pending' then
    raise exception 'Submission is not pending (current status: %)', sub.status;
  end if;

  -- promote to the live certs table
  insert into public.certs (id, department_id, member_id, name, exp, created_at)
  values (gen_random_uuid(), sub.department_id, sub.member_id, sub.name, sub.exp, now())
  returning id into new_cert_id;

  -- stamp the submission as approved
  update public.cert_submissions
  set status = 'approved', reviewed_by = auth.uid(), reviewed_at = now()
  where id = submission_id;

  return new_cert_id;
end;
$function$;

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
  if not public.is_department_admin() then
    raise exception 'Not authorized to reject cert submissions';
  end if;

  select * into sub from public.cert_submissions where id = submission_id;

  if not found then
    raise exception 'Submission not found';
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
$function$;

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
$function$;

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
$function$;


-- =============================================================================
-- SECTION 3 — ROW-LEVEL SECURITY POLICIES
-- Enable RLS on every table, then the read/write policies.
-- (Department-scoped via my_department_id(); see header for the model.)
-- =============================================================================

-- Enable RLS (each table)
ALTER TABLE public.action_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_feedback         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apparatus           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cert_submissions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.certs               ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.content_calendar    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.departments         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.documents           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duties              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.duty_log            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.events              ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fundraisers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.maintenance         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.meetings            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_notes        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.members             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.onboarding_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_attendance  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_sessions   ENABLE ROW LEVEL SECURITY;
-- profiles: review intended RLS before pilot (no policy captured).

-- --- Department-scoped leader reads -----------------------------------------

CREATE POLICY "leaders can read action_items" ON public.action_items FOR SELECT TO public
  USING ((is_leader() AND (department_id = my_department_id())));

CREATE POLICY "leaders can read ai_feedback" ON public.ai_feedback FOR SELECT TO public
  USING ((is_leader() AND (department_id = my_department_id())));

CREATE POLICY "leaders can read fundraisers" ON public.fundraisers FOR SELECT TO public
  USING ((is_leader() AND (department_id = my_department_id())));

CREATE POLICY "leaders can read meetings" ON public.meetings FOR SELECT TO public
  USING ((is_leader() AND (department_id = my_department_id())));

CREATE POLICY "leaders can read member_notes" ON public.member_notes FOR SELECT TO public
  USING ((is_leader() AND (department_id = my_department_id())));

CREATE POLICY "leaders can read onboarding_progress" ON public.onboarding_progress FOR SELECT TO public
  USING ((is_leader() AND (department_id = my_department_id())));

CREATE POLICY "Leaders read all certs" ON public.certs FOR SELECT TO public
  USING ((is_leader() AND (department_id = my_department_id())));

CREATE POLICY "leaders read members base table" ON public.members FOR SELECT TO public
  USING ((is_leader() AND (department_id = my_department_id())));

-- --- Department-scoped member-readable (any authenticated dept member) -------

CREATE POLICY "authenticated can read apparatus" ON public.apparatus FOR SELECT TO public
  USING ((department_id = my_department_id()));

CREATE POLICY "authenticated can read content_calendar" ON public.content_calendar FOR SELECT TO public
  USING ((department_id = my_department_id()));

CREATE POLICY "authenticated can read documents" ON public.documents FOR SELECT TO public
  USING ((department_id = my_department_id()));

CREATE POLICY "authenticated can read events" ON public.events FOR SELECT TO public
  USING ((department_id = my_department_id()));

CREATE POLICY "authenticated can read maintenance" ON public.maintenance FOR SELECT TO public
  USING ((department_id = my_department_id()));

CREATE POLICY "authenticated can read session_attendance" ON public.session_attendance FOR SELECT TO public
  USING ((department_id = my_department_id()));

CREATE POLICY "authenticated can read training_sessions" ON public.training_sessions FOR SELECT TO public
  USING ((department_id = my_department_id()));

-- --- Self-read paths (individual sees only their own) ------------------------

CREATE POLICY "members read own row" ON public.members FOR SELECT TO authenticated
  USING ((email = auth.email()));

CREATE POLICY "Members read own certs" ON public.certs FOR SELECT TO authenticated
  USING ((member_id IN ( SELECT members.id
     FROM members
    WHERE (lower(members.email) = lower(auth.email())))));

-- --- members writes (leader-gated; not yet department-scoped) ----------------
-- FOLLOW-UP: add "AND department_id = my_department_id()" before 2nd department.

CREATE POLICY "leaders insert members" ON public.members FOR INSERT TO authenticated
  WITH CHECK (is_leader());

CREATE POLICY "leaders delete members" ON public.members FOR DELETE TO authenticated
  USING (is_leader());

-- --- cert_submissions (propose -> review pipeline) --------------------------

CREATE POLICY "Leaders propose cert submissions" ON public.cert_submissions FOR INSERT TO authenticated
  WITH CHECK ((is_leader() AND (status = 'pending'::text) AND (proposed_by = auth.uid())));

CREATE POLICY "Dept admins read cert submissions" ON public.cert_submissions FOR SELECT TO authenticated
  USING (is_department_admin());

-- --- Shared / global reads (intentional, NOT department-scoped) --------------

CREATE POLICY "authenticated can read training_plans" ON public.training_plans FOR SELECT TO authenticated
  USING (true);  -- shared library across departments (intentional)

CREATE POLICY "signed in can read departments" ON public.departments FOR SELECT TO authenticated
  USING (true);  -- department info readable to function

-- --- FOLLOW-UP: not yet department-scoped (single-dept-pilot OK) -------------
-- These have a department_id column but still read open to any authenticated
-- user. Scope before a 2nd department joins:
--   USING (department_id = my_department_id())

CREATE POLICY "authenticated can read duties" ON public.duties FOR SELECT TO authenticated
  USING (true);  -- TODO: department-scope before 2nd department

CREATE POLICY "authenticated can read duty_log" ON public.duty_log FOR SELECT TO authenticated
  USING (true);  -- TODO: department-scope before 2nd department

-- =============================================================================
-- END OF SCHEMA SNAPSHOT
-- =============================================================================
