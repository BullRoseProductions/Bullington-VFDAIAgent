-- =============================================================================
-- The Dayroom — Database Schema Reference
-- Project: BullRoseProductions/Bullington-VFDAIAgent
-- Supabase project: ifeptqnlucmvhlvadcpj
-- Refreshed: 2026-07-06 (SESSION UPDATE — see "2026-07-06 SESSION" note below)
-- Prior refresh: 2026-06-27 (DB-backed calendars: content_calendar posts +
--   color, training_sessions writes, and the new recruitment_events table)
-- =============================================================================
--
-- ⚠️ ACCURACY NOTE (2026-07-06): This refresh applies THIS SESSION'S changes
--   VERBATIM (documents Failsafe + action_items lifecycle + doc-grounding col +
--   departments.city — all run together this session, so they are trustworthy).
--   Everything ELSE is carried forward from the 2026-06-27 snapshot and was NOT
--   re-verified against the live DB in this refresh. A full live re-introspection
--   (columns/functions/policies/triggers/constraints/views) is still worth doing
--   with the Supabase CLI for a guaranteed-complete dump. Known carried-forward
--   staleness is flagged inline (e.g. is_leader()/is_department_admin() show the
--   scalar `access in (...)` form; live uses text[] overlap `access && array[...]`).
--
-- =============================================================================
-- 2026-07-06 SESSION — WHAT CHANGED (all verified this session)
-- -----------------------------------------------------------------------------
-- DOCUMENTS — Failsafe Phase 3 (SOP integrity):
--   Slice A (soft-delete): + deleted_at, deleted_by cols; soft_delete_document(),
--     restore_document() RPCs (DA/PA-gated, server-stamped); guard trigger
--     trg_guard_documents_deleted_at; DELETE policy tightened DA/Officer -> PA-only
--     (documents_delete_leadership dropped -> documents_delete_pa_only).
--   Slice B (version-on-replace): + supersedes, archived_at cols;
--     replace_document(p_old,p_new) RPC (links new->old, archives old);
--     guard trigger trg_guard_documents_archived_at.
--   Doc-grounding: + content_text col (client-side pdfjs text extraction on upload;
--     Station Q&A stuffs current-version SOP text into the prompt).
--   NOTE: documents.storage_path is the LIVE column in use (this snapshot's
--     Section 1 historically showed file_url — storage_path added below).
-- ACTION_ITEMS — full lifecycle (open -> completed/cancelled -> 14d grace -> archive):
--   + assignee_name (snapshot), completed_at, completed_by, cancelled_at,
--     cancelled_by, cancel_reason cols. (Also assigned_to, due_date, source_label
--     exist live from the prototype — added to Section 1 below.)
--   RPCs: complete_action_item(), reopen_action_item() (14-day lock via
--     coalesce(completed_at,cancelled_at)), cancel_action_item(p_id,p_reason)
--     (reason REQUIRED). All SECURITY DEFINER, is_canmanage()-gated, server-stamped.
--   POLICY: the "canmanage update action_items" UPDATE policy was DROPPED — both
--     writers now go through the RPCs (RPC-only), making the 14-day lock
--     unbypassable. So action_items has NO direct UPDATE policy (only SELECT+INSERT).
--   NOTE: action_items.status is free-text (NO check constraint) — 'cancelled'
--     inserts fine.
-- DEPARTMENTS — + city col (department profile). (Live also has a "DA can update
--   own department" UPDATE policy.)
-- HELPERS confirmed live this session (real bodies, text[] overlap form):
--   is_dept_admin() = PA|DA ; is_canmanage() = Board|DA|Officer ;
--   is_canmanage_ops() = DA|Officer. These weren't all in prior snapshots.
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
-- DB-BACKED CALENDARS (2026-06-27) — all use the same three-role write gate
--   (Board Member / Department Admin / Training Officer; Project Admin EXCLUDED).
--   - content_calendar: social posts (Visibility). Added a `color` column (post
--     snapshots its category color). INSERT/UPDATE/DELETE for the three roles.
--   - training_sessions: Training calendar. INSERT/UPDATE/DELETE for the three
--     roles (this also unblocked the Training Officer, previously locked out).
--     NOTE: plan_id sent NULL on insert for now — training_plans are still local
--     number-id seeds, not DB uuids; real plan linkage waits for the plan feature.
--   - recruitment_events: NEW table — the Recruitment page calendar (title, date,
--     color, optional notes). Read = members; INSERT/UPDATE/DELETE = three roles.
--   - Still to come: a funding/events calendar + a unified dashboard calendar.
--
-- ANNOUNCEMENTS (2026-07-03) — leader-posted messages shown in the dashboard feed.
--   - announcements table: audience 'everyone' | 'leadership'.
--   - READ (RLS): dept members see 'everyone'; 'leadership' visible to is_leader()
--     ONLY (Board included — the oversight role reads all, posts none).
--   - POST: is_announcer() = Department Admin / Project Admin / Officer
--     (Board EXCLUDED — is_canmanage() would wrongly include Board). author_id is
--     pinned to my_member_id() so no one can post as someone else.
--   - UPDATE/DELETE: the author OR a Department Admin (moderation).
--   - Verified one policy at a time against the live DB before shipping.
--
-- KNOWN GAPS / FOLLOW-UPS
--   - profiles : table exists but had no RLS policy in the capture — review
--     before pilot.
--   - Attendance/QR (session_attendance) is unused — Training attendance is still
--     in-memory; persisting it is a separate future slice.
--   - members / cert_submissions write policies are leader-gated but NOT yet
--     department-scoped — fine for one station; scope before a 2nd department.
--   - The "Board/Dept Admin/Training Officer minus Project Admin" group is now
--     inlined across many policies (post_categories + all three calendars). If
--     reused again, consider a can_edit_calendars() helper to define it once.
--   - members.access is text[] (an ARRAY of roles) in the LIVE db, NOT the scalar
--     text shown in Section 1 — this snapshot is stale on that column. Role checks
--     must use array overlap: `access && array['Role', ...]::text[]` (as
--     is_announcer() does), NOT `access in (...)` / `= ANY(ARRAY[...])` (which
--     throw "malformed array literal"). Older inline policies here reflect the
--     scalar assumption and would need the && form live.
-- =============================================================================


-- =============================================================================
-- SECTION 1 — TABLE STRUCTURES
-- (columns / types / nullability / defaults — for reference; _uuid = uuid[])
-- =============================================================================

-- Action items — full lifecycle (2026-07-06): open -> completed OR cancelled ->
--   14-day reopenable grace -> permanent read-only archive. Writes go ONLY through
--   complete_action_item / reopen_action_item / cancel_action_item (SECURITY DEFINER,
--   server-stamped); the direct UPDATE policy was DROPPED (RPC-only). status is
--   free-text (no CHECK) — values: 'open' | 'done' | 'cancelled'.
CREATE TABLE public.action_items (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  meeting_id uuid,
  text text NOT NULL,
  owner text,
  status text DEFAULT 'open'::text,              -- 'open' | 'done' | 'cancelled' (free-text, no CHECK)
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  assigned_to uuid,                              -- member the item is assigned to (prototype)
  due_date date,                                 -- optional due date (prototype)
  source_label text,                             -- snapshot of where it came from (prototype)
  completed_at timestamp with time zone,         -- server-stamped on completion
  completed_by uuid,                             -- who completed it
  assignee_name text,                            -- SNAPSHOT of assignee name (survives member removal) (2026-07-06)
  cancelled_at timestamp with time zone,         -- server-stamped on cancellation (2026-07-06)
  cancelled_by uuid,                             -- who cancelled it (2026-07-06)
  cancel_reason text                             -- REQUIRED reason on cancel (2026-07-06)
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

-- AI-drafted documents/outputs keyed by `feature` (minutes, agenda, recruitment,
-- fundraiser). ai_text = original draft (kept pristine); current_text = edited body.
-- Soft-deletable: deleted_at NULL = live, set = hidden but retained (DA/PA only,
-- via soft_delete_ai_output() + the guard trigger — Sections 2 & 3).
CREATE TABLE public.ai_outputs (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  feature text NOT NULL,
  title text,
  ai_text text NOT NULL,
  current_text text,
  created_by uuid,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  edited_by uuid,
  edited_at timestamp with time zone,
  deleted_at timestamp with time zone            -- soft-delete stamp; NULL = live
);

-- Leader-posted announcements shown in the dashboard feed. audience gates
-- visibility ('everyone' = all dept members; 'leadership' = is_leader() only).
CREATE TABLE public.announcements (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  author_id uuid,                       -- members.id (my_member_id()); nullable so deleting a member keeps their posts
  title text,                           -- optional headline
  body text NOT NULL,                   -- the message
  audience text NOT NULL DEFAULT 'everyone'::text,   -- CHECK: audience in ('everyone','leadership')
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
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  color text                          -- snapshot of the post's category color (denormalized; survives category deletion)
);

CREATE TABLE public.departments (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  name text NOT NULL,
  station text,
  city text,                                     -- department city (2026-07-06)
  primary_color text DEFAULT '#B11E2A'::text,
  accent_color text DEFAULT '#1F4E79'::text,
  font text DEFAULT 'Modern sans'::text,
  tagline text,
  voice text,
  logo_url text,
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

-- Station Documents (SOPs/SOGs/policies). Failsafe Phase 3 (2026-07-06):
--   soft-delete (deleted_at/deleted_by) + version-on-replace (supersedes/archived_at)
--   + doc-grounding text (content_text). See the 2026-07-06 SESSION note up top.
--   storage_path is the LIVE file pointer (station-documents bucket); file_url is
--   a legacy/unused column retained from an earlier build.
CREATE TABLE public.documents (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  name text NOT NULL,
  type text,
  file_url text,                                 -- legacy/unused; storage_path is live
  storage_path text,                             -- LIVE file pointer (station-documents bucket)
  uploaded_by text,
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  deleted_at timestamp with time zone,           -- soft-delete stamp; NULL = live (Slice A)
  deleted_by uuid,                               -- who trashed it (Slice A)
  supersedes uuid,                               -- -> the older version this replaced (Slice B)
  archived_at timestamp with time zone,          -- set when superseded by a newer version (Slice B)
  content_text text,                             -- extracted SOP text for AI grounding (NULL = scan/unreadable)
  plan_id uuid                                   -- (present live; training-plan linkage)
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

-- Recruitment-drive calendar events (the Recruitment page calendar).
-- Simple by design: title + date + color (+ notes column, not yet surfaced in UI).
CREATE TABLE public.recruitment_events (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  title text NOT NULL,
  date date NOT NULL,
  color text NOT NULL DEFAULT '#1F4E79'::text,
  notes text,
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

-- Training-plan documents/AI plans attached to a specific session (separate from Station Documents).
CREATE TABLE public.session_plans (
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  department_id uuid NOT NULL,
  session_id uuid REFERENCES public.training_sessions(id) ON DELETE SET NULL,  -- the link; no UNIQUE (reuse left open)
  title text,
  source text,                          -- 'upload' | 'ai' (CHECK: source is null or in ('upload','ai'))
  storage_path text,                    -- null for AI plans (reuses station-documents bucket, plans/ prefix)
  ai_text text,                         -- null for uploaded files
  created_by text,
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

-- --- Announcement post-gate: DA / Project Admin / Officer (NO Board).
-- Mirrors is_leader()/is_department_admin(); uses array overlap because
-- members.access is text[] live. Board is deliberately excluded from posting.
CREATE OR REPLACE FUNCTION public.is_announcer()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
    from members
    where lower(members.email) = lower(auth.email())
      and members.access && array['Department Admin', 'Project Admin', 'Officer']::text[]
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

-- --- AI outputs soft-delete (DA/PA only) ------------------------------------
-- soft_delete_ai_output stamps deleted_at (the app filters deleted_at IS NULL);
-- guard_ai_outputs_deleted_at (BEFORE UPDATE trigger, Section 3) blocks ANY change
-- to deleted_at unless DA/PA — so even the canmanage UPDATE policy can't soft-delete
-- or restore. Both gate on is_dept_admin() (DA/PA) — captured verbatim from live;
-- note that name differs from is_department_admin() used elsewhere in this file.

CREATE OR REPLACE FUNCTION public.soft_delete_ai_output(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_row public.ai_outputs;
begin
  -- must be DA or PA
  if not public.is_dept_admin() then
    raise exception 'Only a Department Admin or Project Admin can delete this document';
  end if;
  select * into v_row from public.ai_outputs where id = p_id;
  if not found then
    raise exception 'Document not found';
  end if;
  -- must be in the caller's department
  if v_row.department_id <> public.my_department_id() then
    raise exception 'Not authorized: document belongs to another department';
  end if;
  -- already soft-deleted? no-op guard
  if v_row.deleted_at is not null then
    return;
  end if;
  update public.ai_outputs
  set deleted_at = now()
  where id = p_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.guard_ai_outputs_deleted_at()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  -- if deleted_at is being changed (either direction), require DA/PA
  if (new.deleted_at is distinct from old.deleted_at) then
    if not public.is_dept_admin() then
      raise exception 'Only a Department Admin or Project Admin can change the deleted state of this document';
    end if;
  end if;
  return new;
end;
$function$;

-- --- DOCUMENTS Failsafe Phase 3 (2026-07-06) --------------------------------
-- Slice A: soft-delete/restore (DA/PA-gated, server-stamped). The live library
-- filters deleted_at IS NULL; the guard trigger (Section 3) locks the deleted
-- state to DA/PA. Hard DELETE is PA-only (documents_delete_pa_only policy).

CREATE OR REPLACE FUNCTION public.soft_delete_document(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_row public.documents;
begin
  if not public.is_dept_admin() then
    raise exception 'Only a Department Admin or Project Admin can delete this document';
  end if;
  select * into v_row from public.documents where id = p_id;
  if not found then raise exception 'Document not found'; end if;
  if v_row.department_id <> public.my_department_id() then
    raise exception 'Not authorized: document belongs to another department';
  end if;
  if v_row.deleted_at is not null then return; end if;  -- already trashed, no-op
  update public.documents
    set deleted_at = now(), deleted_by = public.my_member_id()
    where id = p_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.restore_document(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_row public.documents;
begin
  if not public.is_dept_admin() then
    raise exception 'Only a Department Admin or Project Admin can restore this document';
  end if;
  select * into v_row from public.documents where id = p_id;
  if not found then raise exception 'Document not found'; end if;
  if v_row.department_id <> public.my_department_id() then
    raise exception 'Not authorized: document belongs to another department';
  end if;
  update public.documents
    set deleted_at = null, deleted_by = null
    where id = p_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.guard_documents_deleted_at()
 RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if (new.deleted_at is distinct from old.deleted_at) then
    if not public.is_dept_admin() then
      raise exception 'Only a Department Admin or Project Admin can change the deleted state of this document';
    end if;
  end if;
  return new;
end;
$function$;

-- Slice B: version-on-replace. Called after the client uploads the new file +
-- inserts the new row; links new->old via supersedes and archives the old.
CREATE OR REPLACE FUNCTION public.replace_document(p_old_id uuid, p_new_id uuid)
 RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_old public.documents; v_new public.documents;
begin
  if not public.is_dept_admin() then
    raise exception 'Only a Department Admin or Project Admin can replace a document';
  end if;
  select * into v_old from public.documents where id = p_old_id;
  if not found then raise exception 'Original document not found'; end if;
  select * into v_new from public.documents where id = p_new_id;
  if not found then raise exception 'New document not found'; end if;
  if v_old.department_id <> public.my_department_id()
     or v_new.department_id <> public.my_department_id() then
    raise exception 'Not authorized: document belongs to another department';
  end if;
  update public.documents set supersedes = p_old_id where id = p_new_id;
  update public.documents set archived_at = now() where id = p_old_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.guard_documents_archived_at()
 RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
begin
  if (new.archived_at is distinct from old.archived_at) then
    if not public.is_dept_admin() then
      raise exception 'Only a Department Admin or Project Admin can change the version state of this document';
    end if;
  end if;
  return new;
end;
$function$;

-- --- ACTION_ITEMS lifecycle (2026-07-06) ------------------------------------
-- Writes go ONLY through these RPCs (the direct UPDATE policy was dropped).
-- All is_canmanage()-gated (Board/DA/Officer), dept-checked, server-stamped,
-- and snapshot the assignee name so archived history survives member removal.

CREATE OR REPLACE FUNCTION public.complete_action_item(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_row public.action_items;
begin
  if not public.is_canmanage() then raise exception 'Not authorized to complete action items'; end if;
  select * into v_row from public.action_items where id = p_id;
  if not found then raise exception 'Action item not found'; end if;
  if v_row.department_id <> public.my_department_id() then
    raise exception 'Not authorized: belongs to another department';
  end if;
  update public.action_items set
    status = 'done', completed_at = now(), completed_by = public.my_member_id(),
    assignee_name = coalesce(
      (select m.name from public.members m where m.id = v_row.assigned_to),
      assignee_name)
  where id = p_id;
end;
$function$;

-- Reopen handles BOTH completed and cancelled; 14-day lock via coalesce.
CREATE OR REPLACE FUNCTION public.reopen_action_item(p_id uuid)
 RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_row public.action_items; v_resolved timestamp with time zone;
begin
  if not public.is_canmanage() then raise exception 'Not authorized to reopen action items'; end if;
  select * into v_row from public.action_items where id = p_id;
  if not found then raise exception 'Action item not found'; end if;
  if v_row.department_id <> public.my_department_id() then
    raise exception 'Not authorized: belongs to another department';
  end if;
  v_resolved := coalesce(v_row.completed_at, v_row.cancelled_at);
  if v_resolved is not null and (now() - v_resolved) >= interval '14 days' then
    raise exception 'This item was resolved over 14 days ago and is now archived — it can no longer be reopened';
  end if;
  update public.action_items set
    status = 'open',
    completed_at = null, completed_by = null,
    cancelled_at = null, cancelled_by = null, cancel_reason = null
  where id = p_id;
end;
$function$;

-- Cancel = distinct "no longer needed" outcome; reason REQUIRED.
CREATE OR REPLACE FUNCTION public.cancel_action_item(p_id uuid, p_reason text)
 RETURNS void
 LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public'
AS $function$
declare v_row public.action_items;
begin
  if not public.is_canmanage() then raise exception 'Not authorized to cancel action items'; end if;
  if p_reason is null or btrim(p_reason) = '' then
    raise exception 'A reason is required to cancel an action item';
  end if;
  select * into v_row from public.action_items where id = p_id;
  if not found then raise exception 'Action item not found'; end if;
  if v_row.department_id <> public.my_department_id() then
    raise exception 'Not authorized: belongs to another department';
  end if;
  update public.action_items set
    status = 'cancelled', cancelled_at = now(), cancelled_by = public.my_member_id(),
    cancel_reason = btrim(p_reason),
    assignee_name = coalesce(
      (select m.name from public.members m where m.id = v_row.assigned_to),
      assignee_name)
  where id = p_id;
end;
$function$;

-- --- Helper functions confirmed live this session (2026-07-06) ---------------
-- These weren't all in prior snapshots. Real bodies use text[] overlap.
-- is_dept_admin() = Project Admin | Department Admin.
CREATE OR REPLACE FUNCTION public.is_dept_admin()
 RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.members
    where lower(members.email) = lower(auth.email())
      and members.access && array['Project Admin','Department Admin']::text[]
  );
$function$;

-- is_canmanage() = Board Member | Department Admin | Officer.
CREATE OR REPLACE FUNCTION public.is_canmanage()
 RETURNS boolean
 LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from members
    where lower(members.email) = lower(auth.email())
      and members.access && array['Board Member','Department Admin','Officer']::text[]
  );
$function$;

-- is_canmanage_ops() = Department Admin | Officer (ops-management, no Board).
-- [Body carried forward — captured live this session; verify with
--  SELECT pg_get_functiondef('public.is_canmanage_ops()'::regprocedure); ]


-- =============================================================================
-- SECTION 3 — ROW-LEVEL SECURITY POLICIES
-- Enable RLS on every table, then the read/write policies.
-- =============================================================================

ALTER TABLE public.action_items        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_feedback         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ai_outputs          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.announcements       ENABLE ROW LEVEL SECURITY;
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
ALTER TABLE public.recruitment_events  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_attendance  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_plans      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.training_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_plans       ENABLE ROW LEVEL SECURITY;
-- profiles: review intended RLS before pilot (no policy captured).

-- --- Department-scoped leader reads -----------------------------------------

CREATE POLICY "leaders can read action_items" ON public.action_items FOR SELECT TO public
  USING ((is_leader() AND (department_id = my_department_id())));

-- action_items write model (2026-07-06): INSERT via is_canmanage(); there is
-- deliberately NO direct UPDATE policy — completion/reopen/cancel go ONLY through
-- complete_action_item / reopen_action_item / cancel_action_item (SECURITY DEFINER),
-- which makes the 14-day reopen lock unbypassable. (The old "canmanage update
-- action_items" UPDATE policy was DROPPED this session.)
CREATE POLICY "canmanage insert action_items" ON public.action_items FOR INSERT TO authenticated
  WITH CHECK (((department_id = my_department_id()) AND is_canmanage()));

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

-- --- DOCUMENTS write policies + Failsafe triggers (2026-07-06) ---------------
-- INSERT/UPDATE: is_canmanage_ops() (DA/Officer). Hard DELETE: PA ONLY.
-- Soft-delete/restore runs through soft_delete_document/restore_document and is
-- locked to DA/PA by trg_guard_documents_deleted_at; version-on-replace archives
-- via replace_document, locked by trg_guard_documents_archived_at.
CREATE POLICY documents_insert_leadership ON public.documents FOR INSERT TO authenticated
  WITH CHECK (((department_id = my_department_id()) AND is_canmanage_ops()));

CREATE POLICY documents_update_leadership ON public.documents FOR UPDATE TO authenticated
  USING (((department_id = my_department_id()) AND is_canmanage_ops()))
  WITH CHECK (((department_id = my_department_id()) AND is_canmanage_ops()));

-- Hard delete tightened to PA-only this session (was documents_delete_leadership DA/Officer).
CREATE POLICY documents_delete_pa_only ON public.documents FOR DELETE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access && ARRAY['Project Admin'::text]))))));

-- Guard: any change to deleted_at (soft-delete OR restore) requires DA/PA.
CREATE TRIGGER trg_guard_documents_deleted_at BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION guard_documents_deleted_at();

-- Guard: any change to archived_at (version-on-replace state) requires DA/PA.
CREATE TRIGGER trg_guard_documents_archived_at BEFORE UPDATE ON public.documents
  FOR EACH ROW EXECUTE FUNCTION guard_documents_archived_at();

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

-- --- Calendar writes (the three-role gate: Board Member / Department Admin /
-- --- Training Officer; Project Admin excluded — they're platform support).
-- --- content_calendar = social posts; training_sessions; recruitment_events.

CREATE POLICY "leaders write content_calendar" ON public.content_calendar FOR INSERT TO authenticated
  WITH CHECK (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "leaders update content_calendar" ON public.content_calendar FOR UPDATE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))))
  WITH CHECK (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "leaders delete content_calendar" ON public.content_calendar FOR DELETE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "leaders write training_sessions" ON public.training_sessions FOR INSERT TO authenticated
  WITH CHECK (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "leaders update training_sessions" ON public.training_sessions FOR UPDATE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))))
  WITH CHECK (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "leaders delete training_sessions" ON public.training_sessions FOR DELETE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

-- session_plans: read = all dept members; insert/update/delete = canManage (Board Member + Department Admin + Training Officer).
CREATE POLICY "members read session_plans" ON public.session_plans FOR SELECT TO authenticated
  USING ((department_id = my_department_id()));

CREATE POLICY "canmanage insert session_plans" ON public.session_plans FOR INSERT TO authenticated
  WITH CHECK (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "canmanage update session_plans" ON public.session_plans FOR UPDATE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))))
  WITH CHECK (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "canmanage delete session_plans" ON public.session_plans FOR DELETE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "members read recruitment_events" ON public.recruitment_events FOR SELECT TO authenticated
  USING ((department_id = my_department_id()));

CREATE POLICY "leaders write recruitment_events" ON public.recruitment_events FOR INSERT TO authenticated
  WITH CHECK (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "leaders update recruitment_events" ON public.recruitment_events FOR UPDATE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))))
  WITH CHECK (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

CREATE POLICY "leaders delete recruitment_events" ON public.recruitment_events FOR DELETE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access = ANY (ARRAY['Board Member'::text, 'Department Admin'::text, 'Training Officer'::text])))))));

-- --- ANNOUNCEMENTS -----------------------------------------------------------
-- READ: dept members see 'everyone'; 'leadership' audience visible to is_leader()
-- only (Board included — reads all, posts none). POST: is_announcer() = DA / PA /
-- Officer (Board EXCLUDED), author pinned to my_member_id(). UPDATE/
-- DELETE: the author OR a Department Admin (moderation).

CREATE POLICY "read announcements for my audience" ON public.announcements FOR SELECT TO authenticated
  USING (((department_id = my_department_id()) AND ((audience = 'everyone'::text) OR is_leader())));

CREATE POLICY "announcers insert announcements" ON public.announcements FOR INSERT TO authenticated
  WITH CHECK (((department_id = my_department_id()) AND (author_id = my_member_id()) AND is_announcer()));

CREATE POLICY "author or dept admin update announcements" ON public.announcements FOR UPDATE TO authenticated
  USING (((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin())))
  WITH CHECK (((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin())));

CREATE POLICY "author or dept admin delete announcements" ON public.announcements FOR DELETE TO authenticated
  USING (((department_id = my_department_id()) AND ((author_id = my_member_id()) OR is_department_admin())));

-- --- AI OUTPUTS (minutes/agenda/recruitment/fundraiser; soft-deletable) ------
-- READ: any dept member (dept-scoped). INSERT/UPDATE: is_canmanage_ops() OR
-- (is_canmanage() AND feature in minutes/agenda), with created_by/edited_by pinned.
-- Hard DELETE: PA ONLY (access && ARRAY['Project Admin']). Soft-delete (deleted_at)
-- runs through soft_delete_ai_output() and is guarded DA/PA by the trigger below.

CREATE POLICY "dept reads ai_outputs" ON public.ai_outputs FOR SELECT TO public
  USING ((department_id = my_department_id()));

CREATE POLICY "canmanage insert ai_outputs" ON public.ai_outputs FOR INSERT TO authenticated
  WITH CHECK (((department_id = my_department_id()) AND (created_by = my_member_id()) AND (is_canmanage_ops() OR (is_canmanage() AND (feature = ANY (ARRAY['minutes'::text, 'agenda'::text]))))));

CREATE POLICY "canmanage update ai_outputs" ON public.ai_outputs FOR UPDATE TO authenticated
  USING (((department_id = my_department_id()) AND (is_canmanage_ops() OR (is_canmanage() AND (feature = ANY (ARRAY['minutes'::text, 'agenda'::text]))))))
  WITH CHECK (((department_id = my_department_id()) AND (edited_by = my_member_id()) AND (is_canmanage_ops() OR (is_canmanage() AND (feature = ANY (ARRAY['minutes'::text, 'agenda'::text]))))));

CREATE POLICY "pa hard delete ai_outputs" ON public.ai_outputs FOR DELETE TO authenticated
  USING (((department_id = my_department_id()) AND (EXISTS ( SELECT 1
     FROM members
    WHERE ((lower(members.email) = lower(auth.email())) AND (members.access && ARRAY['Project Admin'::text]))))));

-- Guard trigger: any change to deleted_at (soft-delete OR restore) requires DA/PA.
CREATE TRIGGER trg_guard_ai_outputs_deleted_at BEFORE UPDATE ON public.ai_outputs
  FOR EACH ROW EXECUTE FUNCTION guard_ai_outputs_deleted_at();

-- --- Shared / global reads (intentional, NOT department-scoped) --------------

CREATE POLICY "authenticated can read training_plans" ON public.training_plans FOR SELECT TO authenticated
  USING (true);  -- shared library across departments (intentional)

CREATE POLICY "signed in can read departments" ON public.departments FOR SELECT TO authenticated
  USING (true);  -- department info readable to function

-- A Department Admin can update their own department (profile/brand). Confirmed live.
CREATE POLICY "DA can update own department" ON public.departments FOR UPDATE TO authenticated
  USING ((id = my_department_id()) AND is_dept_admin())
  WITH CHECK ((id = my_department_id()) AND is_dept_admin());

-- =============================================================================
-- END OF SCHEMA SNAPSHOT
-- =============================================================================
