-- =====================================================================
-- SLICE 7B-3 — off-site check-in: the write path.
--
-- The first slice that CREATES kind='offsite' rows. Safe to apply because:
--   • dept_iso_hours filters kind IN ('standby','training') — it does not know
--     'offsite' exists, so an off-site row cannot reach a credited number.
--   • dept_station_shifts has the same filter, so it cannot reach the report.
--   • Every row is created with approved_at = NULL, and B4 makes approval the
--     gate before B5 teaches dept_iso_hours about offsite at all.
-- So off-site time is RECORDED but INVISIBLE to every hours figure until B4+B5.
-- That is deliberate: the ledger starts collecting before anything can credit.
--
-- NO offsite_check_out RPC. B2 widened station_check_out to
-- kind IN ('standby','offsite'), so the existing Clock-out already closes an
-- off-site row. A second check-out function would be dead code and a second
-- way to do one thing.
--
-- DESIGN (locked with the owner):
--   • ONE LEDGER — station_presence, no activities table. Consequence: each
--     member's check-in carries its OWN label. Eight people at the same parade
--     produce eight rows with eight labels; the B4 queue groups them for the
--     officer rather than the schema forcing a shared event object.
--   • Location denial does NOT block. The row is created with
--     location_confirmed = false so the officer can judge it.
--   • Checking in off-site AUTO-CLOSES an open standby shift — you cannot be
--     on station and at a parade at once.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Integrity guards for the rows this slice starts creating.
--
-- Both are satisfied by every existing row (there are no offsite rows), so
-- adding them changes nothing today — they exist so a malformed off-site row
-- can never be written, including by a future code path that forgets.
--
--   • an offsite row MUST carry a label. The label is what the officer is
--     approving; an unlabelled claim is unreviewable.
--   • an offsite row MUST record whether location was confirmed. NULL would be
--     "we never asked", which is exactly the ambiguity B1's three-state column
--     was added to remove.
-- ---------------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='station_presence_offsite_needs_label'
                    AND conrelid='public.station_presence'::regclass) THEN
    ALTER TABLE public.station_presence
      ADD CONSTRAINT station_presence_offsite_needs_label
      CHECK (kind <> 'offsite' OR (offsite_label IS NOT NULL AND btrim(offsite_label) <> ''));
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                  WHERE conname='station_presence_offsite_needs_locflag'
                    AND conrelid='public.station_presence'::regclass) THEN
    ALTER TABLE public.station_presence
      ADD CONSTRAINT station_presence_offsite_needs_locflag
      CHECK (kind <> 'offsite' OR location_confirmed IS NOT NULL);
  END IF;
END $$;

-- One open off-site row per member. Partial, so it constrains nothing else:
-- standby rows may legitimately repeat, and closed off-site rows are unlimited.
CREATE UNIQUE INDEX IF NOT EXISTS station_presence_one_open_offsite_per_member
  ON public.station_presence (member_id)
  WHERE kind = 'offsite' AND checked_out_at IS NULL;


-- ---------------------------------------------------------------------
-- 2. offsite_check_in — the member action.
--
-- Gate is IDENTITY, not role: same as station_check_in. Any member with a
-- member record can record their own off-site work. What they cannot do is
-- CREDIT it — that is the officer's call in B4, which is the whole point of
-- separating recording from approval.
--
-- ORDER OF OPERATIONS matters and is deliberate:
--   1. validate label (raise, never silently create an unreviewable row)
--   2. already checked in off-site? return that row unchanged — idempotent, so
--      a double-tap or a retried request cannot open two shifts. Mirrors
--      station_check_in's own `if found then return`.
--   3. close any open STANDBY row. You cannot be on station and at a parade at
--      once, and leaving it open would double-count the same minutes in B5.
--      Deliberately NOT closing training rows: those close via the finalize
--      trigger, and a drill you are also being credited for is the officer's
--      business, not this function's.
--   4. insert the off-site row, unapproved.
--
-- verified = false, ALWAYS. An off-site row was not geo-verified against any
-- known point — there is nothing to verify against. The geo fact lives in
-- location_confirmed, and the CREDIT gate is approved_at. Keeping `verified`
-- honest matters: it feeds the report's "Verified at station %", which is
-- reported to outside bodies.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.offsite_check_in(
  p_label    text,
  p_lat      double precision DEFAULT NULL,
  p_lng      double precision DEFAULT NULL,
  p_accuracy double precision DEFAULT NULL
) RETURNS station_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member uuid := public.my_member_id();
  v_dept   uuid := public.my_department_id();
  v_label  text := nullif(btrim(coalesce(p_label, '')), '');
  v_row    public.station_presence;
begin
  if v_member is null or v_dept is null then
    raise exception 'We could not match your login to a member record.';
  end if;
  if v_label is null then
    raise exception 'Say what the work is before checking in (for example, "Memorial Day parade").';
  end if;

  -- already on an off-site shift -> hand back the same row, do not open a second
  select * into v_row from public.station_presence
   where member_id = v_member and kind = 'offsite' and checked_out_at is null
   order by checked_in_at desc limit 1;
  if found then return v_row; end if;

  -- cannot be on station and off-site at the same time
  update public.station_presence
     set checked_out_at = now()
   where member_id = v_member and kind = 'standby' and checked_out_at is null;

  insert into public.station_presence
    (department_id, member_id, verified, source, kind, offsite_label, location_confirmed)
  values
    (v_dept, v_member, false, 'geo', 'offsite', v_label,
     (p_lat is not null and p_lng is not null))
  returning * into v_row;

  return v_row;
end;
$function$;

REVOKE ALL ON FUNCTION public.offsite_check_in(text, double precision, double precision, double precision)
  FROM public, anon;
GRANT EXECUTE ON FUNCTION public.offsite_check_in(text, double precision, double precision, double precision)
  TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — read from the catalog, not from this file
-- =====================================================================
--
-- -- 1. The function, its signature and grants. Expect exactly one row:
-- --    args=[p_label text, p_lat double precision, p_lng double precision,
-- --          p_accuracy double precision], definer=t, anon=f, auth=t.
-- SELECT format('offsite_check_in') AS check,
--        format('args=[%s] returns=%s definer=%s cfg=%s anon=%s auth=%s',
--               pg_get_function_identity_arguments(oid), pg_get_function_result(oid),
--               prosecdef, coalesce(array_to_string(proconfig,','),'-'),
--               has_function_privilege('anon', oid, 'EXECUTE'),
--               has_function_privilege('authenticated', oid, 'EXECUTE')) AS value
--   FROM pg_proc WHERE proname='offsite_check_in' AND pronamespace='public'::regnamespace;
--
-- -- 2. The three new guards exist:
-- SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
--  WHERE conrelid='public.station_presence'::regclass
--    AND conname LIKE 'station_presence_offsite%';
-- SELECT indexname, indexdef FROM pg_indexes
--  WHERE tablename='station_presence'
--    AND indexname='station_presence_one_open_offsite_per_member';
--
-- -- 3. STILL NO CREDIT PATH — this is the safety proof. Both must show the
-- --    offsite-free filter, i.e. neither function mentions 'offsite' yet:
-- SELECT proname, prosrc ILIKE '%offsite%' AS knows_offsite
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('dept_iso_hours','dept_station_shifts');
-- -- expect knows_offsite = f on BOTH. If either is true, stop: an unapproved
-- -- off-site row could reach a credited figure before B4 exists.
--
-- -- 4. Nothing created yet (until someone taps the button):
-- SELECT kind, count(*),
--        count(*) FILTER (WHERE checked_out_at IS NULL) AS open,
--        count(*) FILTER (WHERE approved_at IS NULL)    AS unapproved
--   FROM public.station_presence GROUP BY kind ORDER BY kind;
--
-- -- 5. END-TO-END, safely, with a rollback. Runs as the SQL editor's role, so
-- --    my_member_id() is null and it should RAISE the login error — that alone
-- --    proves the function is reachable and its guard fires. To test for real,
-- --    use the app once the client lands.
-- --   BEGIN;
-- --     SELECT public.offsite_check_in('Memorial Day parade', 34.0, -84.0, 12);
-- --   ROLLBACK;
--
-- -- 6. After a REAL check-in from the app, the row should look like this:
-- --    kind=offsite, verified=f, location_confirmed=t (or f if denied),
-- --    approved_at=NULL, offsite_label set, checked_out_at NULL.
-- SELECT m.name, sp.kind, sp.offsite_label, sp.verified, sp.location_confirmed,
--        sp.approved_at, sp.checked_in_at, sp.checked_out_at
--   FROM public.station_presence sp JOIN public.members m ON m.id = sp.member_id
--  WHERE sp.kind = 'offsite' ORDER BY sp.checked_in_at DESC;
--
-- -- 7. And the standby auto-close should have fired: the same member must have
-- --    NO open standby row left. Expect 0.
-- SELECT count(*) AS open_standby_for_offsite_members
--   FROM public.station_presence s
--  WHERE s.kind='standby' AND s.checked_out_at IS NULL
--    AND s.member_id IN (SELECT member_id FROM public.station_presence
--                         WHERE kind='offsite' AND checked_out_at IS NULL);
