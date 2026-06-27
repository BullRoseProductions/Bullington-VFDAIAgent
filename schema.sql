-- =============================================================================
-- The Dayroom — Database Schema Reference
-- Project: BullRoseProductions/Bullington-VFDAIAgent
-- Supabase project: ifeptqnlucmvhlvadcpj
-- Refreshed: 2026-06-27 (adds the station-editable post category system)
-- =============================================================================
--
-- WHAT THIS IS
--   A human-readable snapshot of the Supabase backend: table structures, all
--   Row-Level Security (RLS) policies, and all custom Postgres functions
--   (security helpers + the certification, duty, and category pipelines).
--
--   This file exists because the entire backend lives only inside the live
--   Supabase project. This snapshot makes the security architecture
--   reproducible, recoverable, and reviewable.
--
-- WHAT THIS IS NOT
--   A reference snapshot, not a guaranteed one-click rebuild script. It omits:
--   row data, foreign-key constraints beyond columns, indexes, sequences,
--   grants, triggers, the auth schema, and the members_view definition. For a
--   complete replayable dump + migration history, adopt the Supabase CLI
--   (`supabase db dump`) — tracked as a future task.
--
-- ISOLATION MODEL
--   Every station-specific table is scoped by department via my_department_id(),
--   so one department can never read another's data. Two deliberate exceptions:
--     - training_plans : shared library, readable by any authenticated user.
--     - departments    : readable by any authenticated user (needed to function).
--
-- IDENTITY MODEL
--   No auth_user_id column. Identity bridges via lower(members.email) =
--   lower(auth.email()). Helpers resolve the signed-in user's member id
--   (my_member_id) and department (my_department_id).
--
-- STATION DUTIES (2026-06-27)
--   - duties: the live checklist (done/done_by/done_at + helper_ids). Resets weekly.
--   - duty_log: permanent, append-only completion history (the accountability
--     trail). duty_name is a SNAPSHOT so history survives renames/deletes.
--   - Writes go ONLY through complete_duty / uncomplete_duty (SECURITY DEFINER,
--     server-stamped identity + time). complete_duty also writes the duty_log
--     record atomically.
--
-- POST CATEGORIES (2026-06-27) — station-editable social-calendar categories
--   - post_categories: per-department category list for the Visibility content
--     calendar (label, color, default_text suggestion, sort_order, is_default).
--   - Read: any department member. Write (INSERT/UPDATE): Board Member /
--     Department Admin / Training Officer ONLY (NOT Project Admin — they are
--     platform support, not station operators; this is enforced by inline role
--     checks in the policies). DELETE: same three roles AND is_default = false
--     (the 5 seeded defaults are protected and cannot be deleted, enforced at
--     the DB level).
--   - Posts on the calendar are denormalized (each post copies its category's
--     color/label/text), so deleting a category never affects existing posts.
--
-- KNOWN GAPS / FOLLOW-UPS
--   - profiles : table exists but had no RLS policy in the capture — review
--     before pilot.
--   - Calendar POSTS not yet persisted: content_calendar / events tables have
--     SELECT-only RLS and are not yet read/written by the app (the Visibility
--     posts and Training sessions still run on local/seed state). Categories ARE
--     now persisted (post_categories); posts are the next slice.
--   - members / cert_submissions write policies are leader-gated but NOT yet
--     department-scoped — fine for one station; scope before a 2nd department.
--   - The "Board/Dept Admin/Training Officer minus Project Admin" group is now
--     inlined in 3 post_categories policies. If reused again (e.g. calendar edit
--     permissions), consider a can_edit_calendars() helper to define it once.
-- =============================================================================


-- =============================================================================
-- SECTION 1 — TABLE STRUCTURES
-- (columns / types / nullability / defaults — for reference; _uuid = uuid[])
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
  tags text[],
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

-- The live duty checklist. helper_ids carries the CURRENT completion's helpers
-- (for display); resets weekly. Mutated only via complete_duty/uncomplete_duty
-- (+ the members-update RLS policy backing the optimistic UI).
CREATE TABLE public.duties (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  duty text NOT NULL,
  category text DEFAULT 'Station'::text,
  recurrence text DEFAULT 'Weekly'::text,
  done boolean NOT NULL DEFAULT false,
  done_by uuid,
  done_at timestamp with time zone,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  helper_ids uuid[] DEFAULT '{}'::uuid[]
);

-- Permanent, append-only completion history (the accountability trail).
-- duty_name is a SNAPSHOT so history stays readable if a duty is renamed/removed.
CREATE TABLE public.duty_log (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  duty_id uuid,
  duty_name text,
  done_by uuid,
  helper_ids uuid[] DEFAULT '{}'::uuid[],
  done_at timestamp with time zone DEFAULT now()
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
-- Full definition NOT captured here — recapture with:
--   SELECT pg_get_viewdef('public.members_view'::regclass, true);
-- Columns: id, department_id, name, role, access, status, phone, joined,
--          participation, created_at, email, address

CREATE TABLE public.onboarding_progress (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  member_id uuid,
  item_key text NOT NULL,
  done boolean NOT NULL DEFAULT false,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Station-editable category list for the Visibility content calendar.
-- is_default = true marks the 5 seeded defaults (protected from deletion).
-- default_text is a suggested post idea pre-filled when the category is picked.
CREATE TABLE public.post_categories (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  label text NOT NULL,
  color text NOT NULL DEFAULT '#54506B'::text,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  default_text text,
  is_default boolean NOT NULL DEFAULT false
);

-- NOTE: profiles had no RLS policy in the capture — review before pilot.
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
-- Security helpers + certification pipeline + duty pipeline. All SECURITY DEFINER.
-- (No new functions added for the category system — it reuses my_department_id.)
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

CREATE OR REPLACE FUNCTION public.my_member_id()
 RETURNS uuid
 LANGUAGE sql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select id
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
  insert into public.certs (id, department_id, member_id, name, exp, created_at)
  values (gen_random_uuid(), sub.department_id, sub.member_id, sub.name, sub.exp, now())
  returning id into new_cert_id;
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

-- --- Duty pipeline (the ONLY write path for duty completions) ----------------

-- Mark a duty done WITH optional helpers, server-stamped, atomic.
CREATE OR REPLACE FUNCTION public.complete_duty(p_duty_id uuid, p_helper_ids uuid[] DEFAULT '{}'::uuid[])
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d public.duties;
  my_id uuid;
  clean_helpers uuid[];
begin
  my_id := public.my_member_id();
  if my_id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  select * into d from public.duties where id = p_duty_id;
  if not found then
    raise exception 'Duty not found';
  end if;
  if d.department_id <> public.my_department_id() then
    raise exception 'Not authorized: duty belongs to another department';
  end if;
  -- sanitize helpers: drop nulls, drop the doer, keep only real members of THIS dept, de-dupe
  select coalesce(array_agg(distinct m.id), '{}')
  into clean_helpers
  from public.members m
  where m.id = any(p_helper_ids)
    and m.id <> my_id
    and m.department_id = d.department_id;
  update public.duties
  set done = true,
      done_by = my_id,
      done_at = now(),
      helper_ids = clean_helpers
  where id = p_duty_id;
  insert into public.duty_log (department_id, duty_id, duty_name, done_by, helper_ids, done_at)
  values (d.department_id, d.id, d.duty, my_id, clean_helpers, now());
end;
$function$;

-- Un-mark a duty: only the doer or a leader. Clears the live row's helpers;
-- duty_log history is intentionally LEFT INTACT (accountability trail stays).
CREATE OR REPLACE FUNCTION public.uncomplete_duty(p_duty_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  d public.duties;
  my_id uuid;
begin
  my_id := public.my_member_id();
  if my_id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  select * into d from public.duties where id = p_duty_id;
  if not found then
    raise exception 'Duty not found';
  end if;
  if d.department_id <> public.my_department_id() then
    raise exception 'Not authorized: duty belongs to another department';
  end if;
  if d.done_by is distinct from my_id and not public.is_leader() then
    raise exception 'Only the member who completed this, or a leader, can undo it';
  end if;
  update public.duties
  set done = false,
      done_by = null,
      done_at = null,
      helper_ids = '{}'
  where id = p_duty_id;
end;
$function$;


-- =============================================================================
-- SECTION 3 — ROW-LEVEL SECURITY POLICIES
-- Enable RLS on every table, then the read/write policies.
-- =============================================================================

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
ALTER TABLE public.post_categories     ENABLE ROW LEVEL SECURITY;
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

CREATE POLICY "authenticated can read duties" ON public.duties FOR SELECT TO public
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

-- --- members writes (leader-gated; NOT yet department-scoped — see header) ---

CREATE POLICY "leaders insert members" ON public.members FOR INSERT TO authenticated
  WITH CHECK (is_leader());

CREATE POLICY "leaders delete members" ON public.members FOR DELETE TO authenticated
  USING (is_leader());

-- --- cert_submissions (propose -> review pipeline) --------------------------

CREATE POLICY "Leaders propose cert submissions" ON public.cert_submissions FOR INSERT TO authenticated
  WITH CHECK ((is_leader() AND (status = 'pending'::text) AND (proposed_by = auth.uid())));

CREATE POLICY "Dept admins read cert submissions" ON public.cert_submissions FOR SELECT TO authenticated
  USING (is_department_admin());

-- --- DUTIES write (members mark done in their dept; backs optimistic UI) -----
-- Authoritative write path is complete_duty/uncomplete_duty (SECURITY DEFINER).

CREATE POLICY "members update duties in their dept" ON public.duties FOR UPDATE TO authenticated
  USING ((department_id = my_department_id()))
  WITH CHECK ((department_id = my_department_id()));

-- --- DUTY_LOG (the accountability trail) ------------------------------------
-- INSERT: any dept member, only as themselves. SELECT: leadership. UPDATE: Dept
-- Admin only. No DELETE policy (trail is not casually deletable).

CREATE POLICY "members log completions as themselves" ON public.duty_log FOR INSERT TO authenticated
  WITH CHECK (((department_id = my_department_id()) AND (done_by = my_member_id())));

CREATE POLICY "leaders read duty_log" ON public.duty_log FOR SELECT TO authenticated
  USING ((is_leader() AND (department_id = my_department_id())));

CREATE POLICY "dept admins edit duty_log" ON public.duty_log FOR UPDATE TO authenticated
  USING ((is_department_admin() AND (department_id = my_department_id())))
  WITH CHECK ((is_department_admin() AND (department_id = my_department_id())));

-- --- POST_CATEGORIES (station-editable social-calendar categories) ----------
-- READ: any dept member. INSERT/UPDATE: Board Member / Department Admin /
-- Training Officer ONLY (Project Admin intentionally excluded — inline role
-- check, NOT is_leader()). DELETE: same three roles AND is_default = false
-- (the 5 seeded defaults are protected at the DB level).

CREATE POLICY "members read post_categories" ON public.post_categories FOR SELECT TO authenticated
  USING ((department_id = my_department_id()));

CREATE POLICY "leaders write post_categories" ON public.post_categories FOR INSERT TO authenticated
  WITH CHECK (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "leaders update post_categories" ON public.post_categories FOR UPDATE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))))
  WITH CHECK (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "leaders delete own post_categories" ON public.post_categories FOR DELETE TO authenticated
  USING (((department_id = my_department_id()) AND (is_default = false) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

-- --- Shared / global reads (intentional, NOT department-scoped) --------------

CREATE POLICY "authenticated can read training_plans" ON public.training_plans FOR SELECT TO authenticated
  USING (true);  -- shared library across departments (intentional)

CREATE POLICY "signed in can read departments" ON public.departments FOR SELECT TO authenticated
  USING (true);  -- department info readable to function

-- =============================================================================
-- END OF SCHEMA SNAPSHOT
-- =============================================================================
