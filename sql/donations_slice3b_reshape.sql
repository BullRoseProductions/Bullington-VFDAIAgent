-- =====================================================================
-- DONATIONS RESHAPE — donors become DEPARTMENT-LEVEL BUSINESSES, activity becomes their timeline.
--
-- NOT YET APPLIED. Safe: all three tables are empty, so nothing migrates and nothing is lost.
--
-- WHY: the original shape hung a donor off ONE campaign, which is how a Union "cause" works but
-- not how a fire department's giving actually works. The hardware store on Main Street is not a
-- row inside the Engine Fund — it is a relationship the department has, which happens to give to
-- the engine fund this year and the gear fund next. Modelled per-campaign, that business gets
-- re-entered every drive and its history fragments across funds.
--
-- So: one master entry per business, at department level. Money and conversations are the
-- timeline underneath, and the fund is an optional TAG on a gift rather than the parent of the
-- relationship.
--
-- ALTER rather than DROP + CREATE, even though the tables are empty: the RLS policies and grants
-- verified after slice 2 are attached to these tables, and recreating would silently drop them.
-- Re-earning that verification is not worth the tidier diff.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. donation_donors -> the businesses/people the department has a relationship with
-- ---------------------------------------------------------------------

-- The campaign link goes first (the composite FK depends on the column).
ALTER TABLE public.donation_donors DROP CONSTRAINT IF EXISTS donation_donors_campaign_fk;
ALTER TABLE public.donation_donors DROP COLUMN IF EXISTS campaign_id;

/* last_contact_date is DERIVED, not stored. It was a second place for the same fact: a hand-typed
   date that drifts the moment somebody logs a call and forgets to also update the field. Once
   contact touches are rows in the timeline, "last contacted" is max(occurred_on) over them — one
   source, always current, and it cannot disagree with the log sitting directly beneath it. Same
   reasoning that removed amount_received. */
ALTER TABLE public.donation_donors DROP COLUMN IF EXISTS last_contact_date;

/* WHERE THE RELATIONSHIP STANDS — a judgement call, deliberately manual.

   Note that `gave` overlaps with something the ledger already knows, and that is FINE: stage is
   where the CONVERSATION is, received money is arithmetic. A business that gave last year and is
   now being asked again is stage 'talking' with a non-zero received total, and that is the honest
   reading. Do not wire one to the other — a rule like "auto-advance to gave on first contribution"
   would quietly overwrite a human's assessment with a bookkeeping event.

   A CHECK rather than free text so the pipeline stays groupable and a typo cannot invent a stage.
   Adjusting the set later is one DROP CONSTRAINT / ADD CONSTRAINT pair. */
ALTER TABLE public.donation_donors
  ADD COLUMN IF NOT EXISTS stage text NOT NULL DEFAULT 'prospect';
ALTER TABLE public.donation_donors DROP CONSTRAINT IF EXISTS donation_donors_stage_check;
ALTER TABLE public.donation_donors
  ADD CONSTRAINT donation_donors_stage_check
  CHECK (stage IN ('prospect','talking','committed','gave','declined'));

-- The reach-out-again cue. Nullable: most relationships are not waiting on anything.
ALTER TABLE public.donation_donors
  ADD COLUMN IF NOT EXISTS next_follow_up date;

-- department_id, the UNIQUE (id, department_id) pair and the dept index all stay as they were:
-- the pair is what donation_activity's composite FK targets, which is what keeps a timeline row
-- from ever pointing at another department's business.

-- ---------------------------------------------------------------------
-- 2. donation_activity -> the per-business timeline
-- ---------------------------------------------------------------------

/* The FUND TAG becomes optional. A gift may be for the engine fund, or it may just be a gift.

   The composite (campaign_id, department_id) FK is replaced by a plain one so that ON DELETE can
   be SET NULL: deleting a fund must not delete the record that money came in. A composite SET NULL
   would try to null department_id too, which is NOT NULL.

   The cross-department guarantee is barely weakened by this. To mis-tag a gift a leader would need
   another department's campaign uuid, which RLS never shows them — whereas the donor link below,
   which carries the PII and the attribution, keeps its composite FK. Protection where it matters. */
ALTER TABLE public.donation_activity ALTER COLUMN campaign_id DROP NOT NULL;
ALTER TABLE public.donation_activity DROP CONSTRAINT IF EXISTS donation_activity_campaign_fk;
ALTER TABLE public.donation_activity DROP CONSTRAINT IF EXISTS donation_activity_campaign_id_fkey;
ALTER TABLE public.donation_activity
  ADD CONSTRAINT donation_activity_campaign_fk
  FOREIGN KEY (campaign_id) REFERENCES public.donation_campaigns(id) ON DELETE SET NULL;

/* THE DONOR IS NOW THE PRIMARY LINK, and it gets the composite FK.

   Still nullable — NULL is a genuinely anonymous gift (bucket, cash envelope). Under MATCH SIMPLE
   a composite FK is simply not enforced when any of its columns is NULL, so anonymity costs
   nothing and a named row is fully checked.

   NO ACTION on delete, not SET NULL: a business with giving history cannot be deleted out from
   under its own money. That is not an obstacle — `active` already exists for retiring a
   relationship, the same archive-not-delete rule the funds list follows. */
ALTER TABLE public.donation_activity DROP CONSTRAINT IF EXISTS donation_activity_donor_id_fkey;
ALTER TABLE public.donation_activity DROP CONSTRAINT IF EXISTS donation_activity_donor_fk;
ALTER TABLE public.donation_activity
  ADD CONSTRAINT donation_activity_donor_fk
  FOREIGN KEY (donor_id, department_id)
  REFERENCES public.donation_donors (id, department_id);

-- 'contact' joins the kinds: a phone call, a visit, a dropped-off letter.
ALTER TABLE public.donation_activity DROP CONSTRAINT IF EXISTS donation_activity_kind_check;
ALTER TABLE public.donation_activity
  ADD CONSTRAINT donation_activity_kind_check
  CHECK (kind IN ('contact','contribution','update','outcome'));

/* `label` becomes optional. The two forms members actually use are "log a touch" (date + note) and
   "log a gift" (amount + date), neither of which naturally has a headline — requiring one would be
   double entry, and people faced with a mandatory field they do not need type "call" forever. The
   UI shows the label when present and derives a line from the kind when it is not. */
ALTER TABLE public.donation_activity ALTER COLUMN label DROP NOT NULL;

/* EACH KIND MUST CARRY WHAT MAKES IT MEANINGFUL.

   A contribution without an amount silently adds zero to every total while looking like a logged
   gift; without a date it counts toward a business's received total but vanishes from "raised this
   year", so the two disagree for a reason nobody can see.

   A contact without a date cannot sit in a timeline, and without a note records that somebody was
   contacted while withholding what was said — which is the entire value of a contact log. Empty
   string is rejected too; a required field people can satisfy with a space is not required. */
ALTER TABLE public.donation_activity DROP CONSTRAINT IF EXISTS donation_activity_contribution_complete;
ALTER TABLE public.donation_activity
  ADD CONSTRAINT donation_activity_contribution_complete
  CHECK (kind <> 'contribution' OR (amount IS NOT NULL AND occurred_on IS NOT NULL));
ALTER TABLE public.donation_activity DROP CONSTRAINT IF EXISTS donation_activity_contact_complete;
ALTER TABLE public.donation_activity
  ADD CONSTRAINT donation_activity_contact_complete
  CHECK (kind <> 'contact' OR (occurred_on IS NOT NULL AND note IS NOT NULL AND btrim(note) <> ''));

-- ---------------------------------------------------------------------
-- 3. Indexes for the new access patterns
-- ---------------------------------------------------------------------
-- The timeline: a business's rows, newest first.
CREATE INDEX IF NOT EXISTS donation_activity_donor_date_idx
  ON public.donation_activity (donor_id, occurred_on DESC);

-- "Who is due a follow-up" — partial, so it only holds the ones actually waiting on somebody.
CREATE INDEX IF NOT EXISTS donation_donors_followup_idx
  ON public.donation_donors (next_follow_up)
  WHERE next_follow_up IS NOT NULL AND active;

-- Pipeline grouping.
CREATE INDEX IF NOT EXISTS donation_donors_stage_idx ON public.donation_donors (stage);

-- donation_donors_campaign_idx went with the column it indexed; Postgres drops it automatically.

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — read-only. Returns rows you can read, not counts to interpret.
-- =====================================================================
--
-- -- 1. The new shape. donation_donors should have NO campaign_id and NO last_contact_date, and
-- --    SHOULD have stage (default 'prospect') and next_follow_up.
-- SELECT table_name, ordinal_position AS pos, column_name, data_type, is_nullable, column_default
--   FROM information_schema.columns
--  WHERE table_schema='public' AND table_name IN ('donation_donors','donation_activity')
--  ORDER BY table_name, ordinal_position;
--
-- -- 2. The constraints that carry the design. Expect: donors stage CHECK; activity kind CHECK
-- --    naming 'contact'; BOTH completeness CHECKs; the composite donor FK; the plain campaign FK
-- --    with ON DELETE SET NULL.
-- SELECT conrelid::regclass AS tbl, conname, pg_get_constraintdef(oid)
--   FROM pg_constraint
--  WHERE conrelid IN ('public.donation_donors'::regclass, 'public.donation_activity'::regclass)
--    AND contype IN ('f','c','u')
--  ORDER BY conrelid::regclass::text, conname;
--
-- -- 3. RLS SURVIVED THE ALTERs. This is the one thing ALTER was chosen to protect, so confirm it
-- --    rather than assume: expect 3 tables, rls = t, 3 policies, all with a non-null with_check.
-- SELECT c.relname AS tbl, c.relrowsecurity AS rls, p.polname, p.polcmd,
--        (p.polwithcheck IS NOT NULL) AS has_with_check
--   FROM pg_class c LEFT JOIN pg_policy p ON p.polrelid = c.oid
--  WHERE c.relname LIKE 'donation_%' AND c.relkind = 'r'
--  ORDER BY c.relname;
--
-- -- 4. Still empty, so nothing was migrated or lost. Expect 0, 0, 0.
-- SELECT (SELECT count(*) FROM public.donation_campaigns) AS campaigns,
--        (SELECT count(*) FROM public.donation_donors)    AS donors,
--        (SELECT count(*) FROM public.donation_activity)  AS activity;
