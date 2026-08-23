-- =====================================================================
-- FUNDRAISER HQ — slice 1: schema. INERT.
--
-- NOT YET APPLIED. Nothing in the app reads or writes any of this; applying it changes no screen
-- and no number. The two ALTERs add nullable columns to live tables, which is why they are ALTERs
-- and not recreations: action_items and funding_events carry working RLS that must survive.
--
-- SHAPE
--   fundraisers           an event the department runs — the pancake breakfast, the boot drive
--   fundraiser_sponsors   who backed it, what they were promised, whether it was delivered
--   action_items.fundraiser_id    optional tag: this task belongs to that event
--   funding_events.fundraiser_id  optional tag: this calendar date belongs to that event
--
-- The two tags are NULLABLE and ON DELETE SET NULL, deliberately. Deleting a fundraiser must never
-- delete the work or the date — a task somebody still has to do does not stop existing because the
-- event it was filed under was removed. It simply stops being tagged.
--
-- Plain FKs rather than composite on those two, for the same reason donation_activity.campaign_id
-- is plain: a composite SET NULL would try to null department_id, which is NOT NULL. Cross-department
-- tagging is already impossible in practice because RLS never shows you another department's
-- fundraiser id, so there is nothing to paste.
-- =====================================================================

BEGIN;

/* ---------------------------------------------------------------------
   0. A LEGACY `fundraisers` TABLE IS ALREADY THERE, and it broke the first run of this migration.

   It is empty (0 rows), unreferenced by any application code, and shaped
   (id, department_id, name, date, amount, created_at) — a stub superseded by fundraiser_log, which
   is what the app actually writes fundraiser proceeds to.

   The first attempt used CREATE TABLE IF NOT EXISTS, which silently skipped it and then failed
   three statements later with "no unique constraint matching given keys" when the sponsor FK found
   no (id, department_id) pair to reference. That is the wrong failure: IF NOT EXISTS turned "this
   already exists, stop and think" into a skip. Hence the guard below rather than a second
   IF NOT EXISTS.

   THE GUARD REFUSES RATHER THAN ASSUMES. It only drops the table if it is BOTH empty AND
   unreferenced; either condition failing raises and rolls the whole migration back. And it does
   nothing at all if the table already carries the new composite UNIQUE — so re-running this file
   after a successful apply is a no-op rather than a destructive one.
   ------------------------------------------------------------------ */
DO $do$
DECLARE
  v_rows     bigint;
  v_has_uniq boolean;
  v_refs     text;
BEGIN
  IF to_regclass('public.fundraisers') IS NULL THEN
    RETURN;                                    -- nothing there; the CREATE below does the work
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.fundraisers'::regclass AND contype = 'u'
       AND pg_get_constraintdef(oid) ILIKE '%(id, department_id)%'
  ) INTO v_has_uniq;
  IF v_has_uniq THEN
    RAISE NOTICE 'fundraisers already has the composite UNIQUE — leaving it alone (re-run, not first run).';
    RETURN;
  END IF;

  EXECUTE 'SELECT count(*) FROM public.fundraisers' INTO v_rows;
  IF v_rows > 0 THEN
    RAISE EXCEPTION 'The existing fundraisers table holds % row(s). It was expected to be an empty legacy stub. Nothing was changed — inspect it before this migration runs.', v_rows;
  END IF;

  SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ')
    INTO v_refs FROM pg_constraint WHERE confrelid = 'public.fundraisers'::regclass;
  IF v_refs IS NOT NULL THEN
    RAISE EXCEPTION 'Something references the existing fundraisers table: %. Dropping it would break that. Nothing was changed.', v_refs;
  END IF;

  RAISE NOTICE 'Dropping the empty, unreferenced legacy fundraisers stub (columns: name/date/amount).';
  DROP TABLE public.fundraisers;
END
$do$;

-- ---------------------------------------------------------------------
-- 1. fundraisers
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fundraisers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id   uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  name            text NOT NULL,
  description     text,
  target_date     date,
  goal_amount     numeric,
  status          text NOT NULL DEFAULT 'planning'
                    CHECK (status IN ('planning','active','done','archived')),
  point_person_id uuid REFERENCES public.members(id) ON DELETE SET NULL,

  -- Optional link to a fund the proceeds are being raised FOR. Column now, behaviour in slice 6.
  -- SET NULL so deleting a fund untags the event rather than deleting the event.
  campaign_id     uuid REFERENCES public.donation_campaigns(id) ON DELETE SET NULL,

  /* PROCEEDS IS A STORED NUMBER, and that is a deliberate departure from how donations work —
     worth knowing before slice 6, because the two models are about to meet.

     Everywhere in Donations, money received is DERIVED: summed from kind='contribution' rows, never
     stored, so it cannot drift. Here proceeds is typed in by hand, matching fundraiser_log.amount,
     because a pancake breakfast produces one figure at the end of the night and nobody wants to
     enter forty individual gifts to reconstruct it.

     THE COLLISION TO RESOLVE IN SLICE 6: once campaign_id links a fundraiser to a fund, the same
     money can exist twice — once as this typed total, once as contributions tagged to that fund.
     Adding them would double-count. A rule is needed, and it belongs in slice 6 rather than here:
     either proceeds is the authoritative figure for events and contributions tagged to the fund are
     excluded when an event owns them, or proceeds becomes derived when a campaign is linked. This
     comment exists so that decision is made rather than discovered. */
  proceeds        numeric,

  sort            int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.members(id) ON DELETE SET NULL,

  -- The composite-FK target for fundraiser_sponsors. Redundant as a uniqueness claim (id is already
  -- the PK); its job is to be referenceable as a pair, not to constrain anything.
  CONSTRAINT fundraisers_id_dept_key UNIQUE (id, department_id)
);

-- ---------------------------------------------------------------------
-- 2. fundraiser_sponsors
--
-- CASCADE here, unlike the tag columns above, and the difference is the point: a sponsor line has no
-- meaning without its event. "Gold package, banner at the finish line, delivered" is not a fact
-- about the department, it is a fact about that fundraiser. Deleting the event should take it.
-- Composite FK so a sponsor line can never hang off another department's event.
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.fundraiser_sponsors (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fundraiser_id  uuid NOT NULL,
  department_id  uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  name           text NOT NULL,
  package        text,               -- "Gold", "Hole sponsor", "In-kind"
  whats_included text,               -- what we promised them
  what_they_gave text,               -- what actually arrived: cash, goods, services
  delivered      boolean NOT NULL DEFAULT false,   -- did WE deliver what was promised
  notes          text,
  sort           int NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fundraiser_sponsors_fundraiser_fk
    FOREIGN KEY (fundraiser_id, department_id)
    REFERENCES public.fundraisers (id, department_id) ON DELETE CASCADE
);

-- ---------------------------------------------------------------------
-- 3. Tag columns on existing tables
--
-- RLS IS UNAFFECTED, and this is checkable rather than assumed — see VERIFY 5. Policies are
-- row-level expressions, so a new column changes nothing about which rows are visible. The one way
-- it COULD matter is column-level privileges: if authenticated held GRANT UPDATE (col_a, col_b)
-- rather than a table-wide grant, a new column would not be writable. VERIFY 5 checks for exactly
-- that, because it is the only assumption here worth testing.
-- ---------------------------------------------------------------------
ALTER TABLE public.action_items
  ADD COLUMN IF NOT EXISTS fundraiser_id uuid REFERENCES public.fundraisers(id) ON DELETE SET NULL;
ALTER TABLE public.funding_events
  ADD COLUMN IF NOT EXISTS fundraiser_id uuid REFERENCES public.fundraisers(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.action_items.fundraiser_id IS
  'Optional tag: this task is part of that fundraiser. SET NULL on delete — removing an event must not remove work somebody still has to do.';
COMMENT ON COLUMN public.funding_events.fundraiser_id IS
  'Optional tag: this calendar entry belongs to that fundraiser. SET NULL on delete.';

-- ---------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS fundraisers_dept_idx           ON public.fundraisers (department_id);
CREATE INDEX IF NOT EXISTS fundraisers_status_idx         ON public.fundraisers (status);
CREATE INDEX IF NOT EXISTS fundraiser_sponsors_fr_idx     ON public.fundraiser_sponsors (fundraiser_id);
CREATE INDEX IF NOT EXISTS action_items_fundraiser_idx    ON public.action_items (fundraiser_id);
CREATE INDEX IF NOT EXISTS funding_events_fundraiser_idx  ON public.funding_events (fundraiser_id);

-- ---------------------------------------------------------------------
-- 5. RLS + grants on the two NEW tables only
--
-- Leadership-only on read AND write, matching the donation tables. Sponsor rows carry business
-- names and what was promised to them — commitments the department is on the hook for — which is
-- department business rather than roster reading.
--
-- The existing tables' policies are untouched: they already govern their own rows, and a new
-- nullable column does not change who may see them.
-- ---------------------------------------------------------------------
ALTER TABLE public.fundraisers         ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.fundraiser_sponsors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS fundraisers_leadership ON public.fundraisers;
CREATE POLICY fundraisers_leadership ON public.fundraisers
  FOR ALL TO authenticated
  USING      (department_id = public.my_department_id() AND public.is_canmanage())
  WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage());

DROP POLICY IF EXISTS fundraiser_sponsors_leadership ON public.fundraiser_sponsors;
CREATE POLICY fundraiser_sponsors_leadership ON public.fundraiser_sponsors
  FOR ALL TO authenticated
  USING      (department_id = public.my_department_id() AND public.is_canmanage())
  WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage());

REVOKE ALL ON public.fundraisers         FROM anon, public;
REVOKE ALL ON public.fundraiser_sponsors FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fundraisers         TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.fundraiser_sponsors TO authenticated;

COMMIT;

-- Without this, PostgREST serves a cached schema that has never heard of these tables or the two
-- new columns, and slice 2's first query 404s.
NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — all read-only.
-- =====================================================================
--
-- -- 1. Both new tables exist with RLS ENABLED. Expect 2 rows, rls = t.
-- SELECT c.relname AS tbl, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname='public' AND c.relname IN ('fundraisers','fundraiser_sponsors')
--  ORDER BY c.relname;
--
-- -- 2. One FOR-ALL policy each, roles {authenticated}, BOTH using and with_check non-null and
-- --    naming my_department_id AND is_canmanage. A null with_check = unguarded inserts.
-- SELECT c.relname AS tbl, p.polname, p.polcmd,
--        coalesce(array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(p.polroles)),','),'PUBLIC') AS roles,
--        pg_get_expr(p.polqual, p.polrelid)      AS using_expr,
--        pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
--   FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
--  WHERE c.relname IN ('fundraisers','fundraiser_sponsors') ORDER BY c.relname;
--
-- -- 3. The two tag columns exist and are NULLABLE. Expect 2 rows, is_nullable = YES.
-- SELECT table_name, column_name, data_type, is_nullable
--   FROM information_schema.columns
--  WHERE table_schema='public' AND column_name='fundraiser_id'
--    AND table_name IN ('action_items','funding_events')
--  ORDER BY table_name;
--
-- -- 4. The constraints carrying the design: the status CHECK, the composite sponsor FK (CASCADE),
-- --    the two tag FKs (SET NULL), and the UNIQUE (id, department_id) target.
-- SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid IN ('public.fundraisers'::regclass, 'public.fundraiser_sponsors'::regclass,
--                     'public.action_items'::regclass, 'public.funding_events'::regclass)
--    AND (conname LIKE '%fundraiser%' OR conname LIKE '%status%')
--  ORDER BY conrelid::regclass::text, conname;
--
-- -- 5. THE ONE ASSUMPTION WORTH TESTING — that adding a column needed no RLS change.
-- --    Policies are row-level so a new column cannot affect visibility; the only way it could bite
-- --    is COLUMN-LEVEL grants, where authenticated holds UPDATE on a named list rather than the
-- --    whole table. Expect ZERO rows: no column-scoped privileges on either table.
-- SELECT table_name, column_name, grantee, privilege_type
--   FROM information_schema.column_privileges
--  WHERE table_schema='public'
--    AND table_name IN ('action_items','funding_events')
--    AND grantee IN ('authenticated','anon')
--  ORDER BY table_name, column_name;
--
-- -- 6. Existing policies on the tagged tables are UNCHANGED and still present — the ALTERs must not
-- --    have disturbed them. Expect the same policies these tables had before this migration.
-- SELECT c.relname AS tbl, p.polname, p.polcmd
--   FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
--  WHERE c.relname IN ('action_items','funding_events') ORDER BY c.relname, p.polname;
--
-- -- 6b. THE LEGACY STUB IS GONE and the new shape is in place. The old table had
-- --     (name, date, amount); the new one has status, goal_amount, campaign_id, proceeds.
-- --     Expect 'date' and 'amount' to be ABSENT and the new columns present.
-- SELECT string_agg(column_name, ', ' ORDER BY ordinal_position) AS columns
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name='fundraisers';
--
-- -- 7. INERT PROOF. Expect 0, 0, and 0 rows carrying a tag.
-- SELECT (SELECT count(*) FROM public.fundraisers)                                  AS fundraisers,
--        (SELECT count(*) FROM public.fundraiser_sponsors)                          AS sponsors,
--        (SELECT count(*) FROM public.action_items   WHERE fundraiser_id IS NOT NULL) AS tagged_tasks,
--        (SELECT count(*) FROM public.funding_events WHERE fundraiser_id IS NOT NULL) AS tagged_dates;
