-- =====================================================================
-- DONATIONS — slice 2: tables, RLS, indexes. INERT.
--
-- NOT YET APPLIED. Nothing in the app reads or writes these until slice 3, so applying this
-- changes no screen and no number.
--
-- SHAPE, and what it deliberately does NOT have:
--   donation_campaigns  the fund/appeal ("New Engine Fund")
--   donation_donors     the pipeline — who might give, what they PLEDGED
--   donation_activity   the dated ledger — updates, outcomes, and MONEY ACTUALLY RECEIVED
--
-- There is no cause_events equivalent (events live in the Fundraiser Log), and no
-- donors.amount_received column. Received money has exactly ONE source: activity rows with
-- kind = 'contribution'. That is what makes a donor's received total, the campaign total, and
-- "raised this calendar year" three views of the same rows instead of three numbers that can
-- drift apart. The Union edition this is modelled on summed three independent sources and could
-- double-count a gift entered in two places; this cannot.
--
-- donation_activity.donor_id is NULLABLE on purpose: NULL means a gift with no named donor — a
-- bucket collection, a cash envelope, an anonymous cheque. The money still counts toward the
-- campaign; it simply has nobody to attribute it to.
--
-- ACCESS IS STRICTER THAN ANYTHING ELSE IN THIS APP, deliberately. Every other table lets a
-- member read their own department's rows. These hold donor names, phone numbers, home
-- organisations and giving history — so read AND write are both gated on is_canmanage()
-- (Board Member / Department Admin / Officer). A plain member reading this would be wrong, and
-- the Union edition shipped its equivalent tables with NO policies at all, which is the specific
-- mistake this file exists not to repeat.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Campaigns
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.donation_campaigns (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id   uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  name            text NOT NULL,
  tagline         text,
  description     text,
  status          text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  goal_amount     numeric,
  external_url    text,                    -- link OUT to donate; we track money, we never process it
  -- SET NULL, not CASCADE: if the point person leaves the roster the campaign must survive. Losing
  -- an attribution is a smaller harm than deleting a fund because somebody resigned.
  point_person_id uuid REFERENCES public.members(id) ON DELETE SET NULL,
  sort            int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  created_by      uuid REFERENCES public.members(id) ON DELETE SET NULL,

  /* Lets the child tables point at (id, department_id) as a pair. See the note on donation_donors.
     Redundant as a uniqueness claim — id is already the primary key — and that is fine; its job is
     to be a referenceable target, not to constrain anything. */
  CONSTRAINT donation_campaigns_id_dept_key UNIQUE (id, department_id)
);

-- ---------------------------------------------------------------------
-- 2. Donors — the pipeline
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.donation_donors (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id        uuid NOT NULL,
  department_id      uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  name               text NOT NULL,
  organization       text,
  role               text NOT NULL DEFAULT 'Donor',
  phone              text,
  email              text,
  -- The PLEDGE, entered by hand. Deliberately NOT paired with an amount_received column: what has
  -- actually arrived is derived from this donor's kind='contribution' activity rows, so committed
  -- and received can never silently disagree about the same gift.
  amount_committed   numeric,
  last_contact_date  date,
  relationship_notes text,
  active             boolean NOT NULL DEFAULT true,
  sort               int NOT NULL DEFAULT 0,
  created_at         timestamptz NOT NULL DEFAULT now(),

  /* COMPOSITE FK, not a plain campaign_id reference. This makes it structurally impossible for a
     donor to hang off another department's campaign — the pair must match a real (campaign,
     department) combination.

     The realistic failure it prevents is not malice but a bug: a stale `dept` prop or a wrong id
     passed from the client would otherwise create rows that are department-scoped one way and
     campaign-scoped another, which reads as "the donor vanished" and is miserable to diagnose.
     This turns that into an immediate foreign-key error at the write.

     Strike this and use a plain REFERENCES donation_campaigns(id) if the extra constraint is not
     wanted; RLS still prevents writing rows for another department. */
  CONSTRAINT donation_donors_campaign_fk
    FOREIGN KEY (campaign_id, department_id)
    REFERENCES public.donation_campaigns (id, department_id) ON DELETE CASCADE,

  CONSTRAINT donation_donors_id_dept_key UNIQUE (id, department_id)
);

-- ---------------------------------------------------------------------
-- 3. Activity — the dated ledger, and the ONLY source of received money
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.donation_activity (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id   uuid NOT NULL,
  department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
  -- NULL = a gift with no named donor (bucket, cash, anonymous). SET NULL rather than CASCADE on
  -- delete: removing a donor from the pipeline must not erase money the department actually
  -- received. The gift stays, and becomes anonymous.
  donor_id      uuid REFERENCES public.donation_donors(id) ON DELETE SET NULL,
  kind          text NOT NULL DEFAULT 'update' CHECK (kind IN ('update','contribution','outcome')),
  label         text NOT NULL,
  amount        numeric,
  occurred_on   date,
  note          text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  created_by    uuid REFERENCES public.members(id) ON DELETE SET NULL,

  CONSTRAINT donation_activity_campaign_fk
    FOREIGN KEY (campaign_id, department_id)
    REFERENCES public.donation_campaigns (id, department_id) ON DELETE CASCADE,

  /* A CONTRIBUTION MUST CARRY BOTH AN AMOUNT AND A DATE.
     For kind='contribution' the amount IS the record — a NULL one silently contributes zero to
     every total while looking like a logged gift. And occurred_on is what the calendar-year figure
     filters on, so a dated-NULL contribution would count toward the campaign total but vanish from
     "raised this year", making the two disagree for a reason nobody could see. Updates and
     outcomes stay free-form. */
  CONSTRAINT donation_activity_contribution_complete
    CHECK (kind <> 'contribution' OR (amount IS NOT NULL AND occurred_on IS NOT NULL))
);

-- ---------------------------------------------------------------------
-- 4. Indexes
-- ---------------------------------------------------------------------
CREATE INDEX IF NOT EXISTS donation_donors_campaign_idx   ON public.donation_donors (campaign_id);
CREATE INDEX IF NOT EXISTS donation_donors_dept_idx       ON public.donation_donors (department_id);
CREATE INDEX IF NOT EXISTS donation_activity_campaign_idx ON public.donation_activity (campaign_id);
CREATE INDEX IF NOT EXISTS donation_activity_dept_idx     ON public.donation_activity (department_id);
CREATE INDEX IF NOT EXISTS donation_activity_donor_idx    ON public.donation_activity (donor_id);
CREATE INDEX IF NOT EXISTS donation_campaigns_dept_idx    ON public.donation_campaigns (department_id);

-- The "raised this calendar year" filter. Partial, because only contributions carry money and only
-- contributions are ever date-filtered — so the index stays small no matter how many update and
-- outcome rows accumulate.
CREATE INDEX IF NOT EXISTS donation_activity_contrib_date_idx
  ON public.donation_activity (occurred_on)
  WHERE kind = 'contribution';

-- ---------------------------------------------------------------------
-- 5. RLS — leadership only, read AND write
--
-- FOR ALL with matching USING and WITH CHECK: USING decides which rows may be seen, updated or
-- deleted; WITH CHECK decides what may be left behind by an insert or update. Both are needed, and
-- both carry the same two conditions — a member of this department, who is leadership.
--
-- Table GRANTs are explicit rather than left to Supabase's default privileges. RLS filters rows;
-- it does not grant table access, and anon should not hold any on a table of donor phone numbers.
-- ---------------------------------------------------------------------
ALTER TABLE public.donation_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.donation_donors    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.donation_activity  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS donation_campaigns_leadership ON public.donation_campaigns;
CREATE POLICY donation_campaigns_leadership ON public.donation_campaigns
  FOR ALL TO authenticated
  USING      (department_id = public.my_department_id() AND public.is_canmanage())
  WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage());

DROP POLICY IF EXISTS donation_donors_leadership ON public.donation_donors;
CREATE POLICY donation_donors_leadership ON public.donation_donors
  FOR ALL TO authenticated
  USING      (department_id = public.my_department_id() AND public.is_canmanage())
  WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage());

DROP POLICY IF EXISTS donation_activity_leadership ON public.donation_activity;
CREATE POLICY donation_activity_leadership ON public.donation_activity
  FOR ALL TO authenticated
  USING      (department_id = public.my_department_id() AND public.is_canmanage())
  WITH CHECK (department_id = public.my_department_id() AND public.is_canmanage());

REVOKE ALL ON public.donation_campaigns FROM anon, public;
REVOKE ALL ON public.donation_donors    FROM anon, public;
REVOKE ALL ON public.donation_activity  FROM anon, public;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.donation_campaigns TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.donation_donors    TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.donation_activity  TO authenticated;

COMMIT;

-- Without this, PostgREST keeps serving a cached schema that has never heard of these tables and
-- slice 3's first query 404s.
NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — all read-only.
-- =====================================================================
--
-- -- 1. All three exist, with RLS ENABLED. Expect 3 rows, rls = t.
-- SELECT c.relname AS tbl, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced
--   FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
--  WHERE n.nspname='public' AND c.relname LIKE 'donation_%' ORDER BY c.relname;
--
-- -- 2. THE POLICIES. Expect one FOR ALL policy per table, roles {authenticated}, and BOTH
-- --    using_expr and with_check naming my_department_id AND is_canmanage. A NULL with_check would
-- --    mean inserts are unguarded.
-- SELECT c.relname AS tbl, p.polname, p.polcmd,
--        coalesce(array_to_string(ARRAY(SELECT rolname FROM pg_roles WHERE oid = ANY(p.polroles)),','),'PUBLIC') AS roles,
--        pg_get_expr(p.polqual, p.polrelid)      AS using_expr,
--        pg_get_expr(p.polwithcheck, p.polrelid) AS with_check
--   FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
--  WHERE c.relname LIKE 'donation_%' ORDER BY c.relname;
--
-- -- 3. GRANTS. anon must appear NOWHERE. Expect only authenticated (and the owner).
-- SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
--   FROM information_schema.role_table_grants
--  WHERE table_schema='public' AND table_name LIKE 'donation_%'
--  GROUP BY table_name, grantee ORDER BY table_name, grantee;
--
-- -- 4. Indexes, including the partial contribution-date one the year filter needs.
-- SELECT tablename, indexname, indexdef FROM pg_indexes
--  WHERE schemaname='public' AND tablename LIKE 'donation_%' ORDER BY tablename, indexname;
--
-- -- 5. The constraints that carry the design decisions — the composite campaign FKs and the
-- --    contribution-completeness CHECK.
-- SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid::regclass::text LIKE 'donation_%' AND contype IN ('f','c','u')
--  ORDER BY conrelid::regclass::text, conname;
--
-- -- 6. INERT PROOF. Expect 0, 0, 0 — nothing writes these until slice 3.
-- SELECT (SELECT count(*) FROM public.donation_campaigns) AS campaigns,
--        (SELECT count(*) FROM public.donation_donors)    AS donors,
--        (SELECT count(*) FROM public.donation_activity)  AS activity;
--
-- -- 7. As postgres in the SQL editor my_department_id() is NULL, so the policies match nothing and
-- --    these SELECTs return 0 rows even once slice 3 has written data. That is the gate working,
-- --    not a failure — the real check is from the app as a leader.
