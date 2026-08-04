-- =====================================================================
-- SLICE 7B-2 — off-site lifecycle guards. INERT.
--
-- Teaches the two existing lifecycle RPCs that 'offsite' exists, BEFORE
-- anything can create an off-site row (that is B3). Same discipline as slice 0:
-- the guard lands first, so there is never a window where an off-site row
-- exists that the clock-out path does not understand.
--
-- INERT IN PRACTICE. No off-site row exists (verified: station_presence is
-- standby=17, offsite=0), and `kind IN ('standby','offsite')` selects exactly
-- the same rows as `kind = 'standby'` while that is true. The verify block
-- proves that on live data rather than asserting it.
--
-- BOTH BODIES BELOW WERE READ FROM pg_proc, NOT FROM A MIGRATION FILE.
-- They are reproduced byte-for-byte with ONE token changed in each. The live
-- definitions were confirmed identical to what slice 0 wrote (no drift), but
-- that was established by reading the catalog, not by trusting the file.
--
-- GRANTS ARE DELIBERATELY NOT RESTATED. CREATE OR REPLACE preserves the
-- existing ACL; re-granting would risk CHANGING privileges I have not read.
-- The verify block reports them for the record instead.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. station_check_out — close an off-site row the same way it closes standby.
--
-- ONLY CHANGE:  and kind = 'standby'  ->  and kind in ('standby','offsite')
--
-- Everything else is verbatim from the live definition: the CTE that closes
-- EVERY open row and deterministically returns the most recent, both
-- user-facing exception strings, no args, RETURNS station_presence, plpgsql,
-- VOLATILE (the default — the live definition declares no volatility),
-- SECURITY DEFINER, search_path 'public'.
--
-- TRAINING IS STILL EXCLUDED, which is the point of the original filter — a
-- training row closes only via the finalize trigger (slice 2), never via a
-- member tapping Clock out. Widening to off-site preserves that protection
-- exactly; it does not weaken it.
--
-- auto_closed is not referenced here and stays untouched: a row closed by hand
-- keeps auto_closed = false, and the sweeper's rows are already closed so this
-- cannot reach them.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.station_check_out()
 RETURNS station_presence
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_member uuid := public.my_member_id();
  v_row public.station_presence;
begin
  if v_member is null then
    raise exception 'We could not match your login to a member record.';
  end if;
  with closed as (
    update public.station_presence
       set checked_out_at = now()
     where member_id = v_member
       and checked_out_at is null
       and kind in ('standby','offsite')   -- NEVER close a training row; the officer closes those
    returning *
  )
  select * into v_row from closed order by checked_in_at desc limit 1;
  if v_row.id is null then raise exception 'You are not currently checked in.'; end if;
  return v_row;
end;
$function$;


-- ---------------------------------------------------------------------
-- 2. my_open_station_session — an off-site row sorts like standby.
--
-- ONLY CHANGE:  (kind = 'standby') desc  ->  (kind in ('standby','offsite')) desc
--
-- WHY IT MATTERS: this function decides which single open row the clock card
-- displays, and station_check_out (above) decides which row Clock-out acts on.
-- If those two disagreed, the card would show one shift while the button closed
-- another. Boolean DESC puts true first, so a standby OR off-site row now wins
-- over a training row in both places — the two predicates are kept in lockstep
-- deliberately, and should be changed together or not at all.
--
-- Everything else verbatim: no args, RETURNS SETOF station_presence, LANGUAGE
-- sql, STABLE SECURITY DEFINER, search_path 'public', `checked_in_at desc`
-- tiebreak, limit 1.
--
-- Note the return type picks up B1's four new columns automatically — it is
-- SETOF the table's composite type and the body is `select *`. Extra columns
-- are additive for every existing caller.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.my_open_station_session()
 RETURNS SETOF station_presence
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select * from public.station_presence
    where member_id = public.my_member_id() and checked_out_at is null
    order by (kind in ('standby','offsite')) desc, checked_in_at desc
    limit 1;
$function$;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after) — everything read from pg_proc, nothing inferred
-- =====================================================================
--
-- -- 1. The live bodies actually contain the widened predicates. Expect
-- --    has_offsite = true on BOTH rows, and still_excludes_training = true
-- --    (neither body should mention 'training' in its filter).
-- SELECT proname,
--        prosrc ILIKE '%kind in (''standby'',''offsite'')%' AS has_offsite,
--        prosrc NOT ILIKE '%kind = ''standby''%'            AS old_predicate_gone
--   FROM pg_proc
--  WHERE pronamespace = 'public'::regnamespace
--    AND proname IN ('station_check_out','my_open_station_session')
--  ORDER BY proname;
--
-- -- 1b. Eyeball the full bodies:
-- SELECT proname, pg_get_functiondef(oid) FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('station_check_out','my_open_station_session') ORDER BY proname;
--
-- -- 2. Signature / return / volatility / security / grants — compare against
-- --    what these were before. Expect:
-- --      my_open_station_session : args '', SETOF station_presence, s, DEFINER, {search_path=public}
-- --      station_check_out       : args '', station_presence,       v, DEFINER, {search_path=public}
-- SELECT proname,
--        pg_get_function_identity_arguments(oid) AS args,
--        pg_get_function_result(oid)             AS returns,
--        provolatile, prosecdef, proconfig,
--        has_function_privilege('anon',          oid, 'EXECUTE') AS anon_can,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_can,
--        has_function_privilege('public',        oid, 'EXECUTE') AS public_can
--   FROM pg_proc
--  WHERE pronamespace = 'public'::regnamespace
--    AND proname IN ('station_check_out','my_open_station_session')
--  ORDER BY proname;
--
-- -- 3. FUNCTIONAL SANITY — the widened predicate selects exactly the same rows
-- --    as the old one, on live data. Expect old = new and identical = true.
-- SELECT count(*) FILTER (WHERE kind = 'standby')              AS old_predicate,
--        count(*) FILTER (WHERE kind IN ('standby','offsite')) AS new_predicate,
--        count(*) FILTER (WHERE kind = 'standby')
--          = count(*) FILTER (WHERE kind IN ('standby','offsite')) AS identical
--   FROM public.station_presence
--  WHERE checked_out_at IS NULL;
--
-- -- 4. FUNCTIONAL SANITY — the reordering picks the SAME open row for every
-- --    member who has one. Expect `same` = true on every row (0 rows is also
-- --    fine: it just means nobody is clocked in right now).
-- SELECT member_id,
--        (array_agg(id ORDER BY (kind = 'standby')              DESC, checked_in_at DESC))[1] AS old_pick,
--        (array_agg(id ORDER BY (kind IN ('standby','offsite')) DESC, checked_in_at DESC))[1] AS new_pick,
--        (array_agg(id ORDER BY (kind = 'standby')              DESC, checked_in_at DESC))[1]
--          = (array_agg(id ORDER BY (kind IN ('standby','offsite')) DESC, checked_in_at DESC))[1] AS same
--   FROM public.station_presence
--  WHERE checked_out_at IS NULL
--  GROUP BY member_id;
--
-- -- 5. Nothing was created or reclassified. Expect standby=17, offsite absent.
-- SELECT kind, count(*) FROM public.station_presence GROUP BY kind ORDER BY kind;
