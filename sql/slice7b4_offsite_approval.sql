-- =====================================================================
-- SLICE 7B-4 — off-site approval: the officer's decision.
--
-- Off-site rows have existed since B3 and reach NO hours figure. This slice
-- adds the path that decides them. It still does not credit anything —
-- dept_iso_hours learns about 'offsite' in B5. What B4 does is make the
-- decision recordable, so B5 has something to filter on.
--
-- FOLDED INTO THE EXISTING NEEDS-REVIEW QUEUE, not a second panel. Same shape
-- (rows awaiting a human decision, with approve / adjust / void), same screen,
-- one list. Two panels doing one job is the duplication PersonalView just had
-- removed.
--
-- dept_shifts_needing_review now returns rows where:
--     auto_closed                                     -- slice 6, guessed stop time
--  OR (kind='offsite' AND approved_at IS NULL          -- new: needs approval
--      AND checked_out_at IS NOT NULL)                 -- ...but only once finished
-- plus a `reason` column so the UI knows which buttons to offer, and the label.
--
-- THE 'both' CASE IS REAL: an off-site shift that ran past max_shift_hours is
-- auto_closed AND unapproved. One action must fix the time and approve, or the
-- officer is stuck in a two-step dance — see approve_offsite below.
--
-- RETURN TYPE CHANGES -> DROP + CREATE, grants restated. Verified live before
-- writing: dept_shifts_needing_review is anon=false / authenticated=true.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. The queue, generalized.
--
-- Still UNWINDOWED and oldest-first, for the same reason as slice 6: a work
-- list that can hide items is not a work list. That also means every off-site
-- row created since B3 surfaces here the moment this lands — nothing recorded
-- in the gap is lost.
--
-- `capped_hours` keeps its slice-6 meaning (the duration as it currently
-- stands) and is computed identically to dept_station_shifts' `hours`, so the
-- queue and the shift log never disagree about the same row.
-- ---------------------------------------------------------------------
DROP FUNCTION IF EXISTS public.dept_shifts_needing_review();

CREATE FUNCTION public.dept_shifts_needing_review()
 RETURNS TABLE(
   shift_id       uuid,
   member_id      uuid,
   member_name    text,
   kind           text,
   reason         text,          -- 'auto_closed' | 'offsite_pending' | 'both'
   offsite_label  text,
   location_confirmed boolean,
   checked_in_at  timestamptz,
   checked_out_at timestamptz,
   capped_hours   numeric
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;
  return query
    select sp.id, m.id, m.name, sp.kind,
           case
             when sp.auto_closed and sp.kind = 'offsite' and sp.approved_at is null then 'both'
             when sp.auto_closed                                                    then 'auto_closed'
             else                                                                        'offsite_pending'
           end,
           sp.offsite_label, sp.location_confirmed,
           sp.checked_in_at, sp.checked_out_at,
           round((extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2)
    from public.station_presence sp
    join public.members m on m.id = sp.member_id
    where sp.department_id = v_dept
      and (
        sp.auto_closed
        or (sp.kind = 'offsite' and sp.approved_at is null and sp.checked_out_at is not null)
      )
    order by sp.checked_in_at asc;   -- oldest first: this is a work list
end;
$function$;

REVOKE ALL ON FUNCTION public.dept_shifts_needing_review() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dept_shifts_needing_review() TO authenticated;


-- ---------------------------------------------------------------------
-- 2. approve_offsite — the credit decision, and the time fix, in ONE action.
--
-- Optional p_checked_in_at / p_checked_out_at let the officer correct the
-- window while approving. Passing neither approves the times as recorded.
--
-- IT ALSO CLEARS auto_closed. This is load-bearing, not tidiness: an off-site
-- shift that tripped the sweeper carries a machine-guessed stop AND needs
-- approval. dept_iso_hours excludes auto_closed rows, so approving without
-- clearing it would leave the row uncredited and make approval look broken.
-- One action resolves both flags.
--
-- FOR UPDATE before validating, so two officers cannot interleave — the second
-- waits, sees approved_at already set, and is told so rather than overwriting.
--
-- Every rejection RAISES. A guardrail that silently no-ops on a bad id is worse
-- than one that refuses loudly: the UI would report success and the row would
-- stay pending.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.approve_offsite(
  p_shift_id       uuid,
  p_checked_in_at  timestamptz DEFAULT NULL,
  p_checked_out_at timestamptz DEFAULT NULL
) RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
  v_me   uuid := public.my_member_id();
  v_row  public.station_presence;
  v_in   timestamptz;
  v_out  timestamptz;
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;

  select * into v_row from public.station_presence
   where id = p_shift_id and department_id = v_dept
   for update;

  if not found then
    raise exception 'That shift was not found in your department.';
  end if;
  if v_row.kind <> 'offsite' then
    raise exception 'That is not an off-site shift.';
  end if;
  if v_row.approved_at is not null then
    raise exception 'That off-site time has already been reviewed.';
  end if;
  if v_row.checked_out_at is null then
    raise exception 'That shift is still open — it can be approved once the member checks out.';
  end if;

  v_in  := coalesce(p_checked_in_at,  v_row.checked_in_at);
  v_out := coalesce(p_checked_out_at, v_row.checked_out_at);

  if v_out <= v_in then
    raise exception 'The end time must be after the start time.';
  end if;
  if v_out > now() then
    raise exception 'The end time cannot be in the future.';
  end if;

  update public.station_presence
     set checked_in_at  = v_in,
         checked_out_at = v_out,
         auto_closed    = false,   -- the officer has confirmed the window
         approved_at    = now(),
         approved_by    = v_me
   where id = p_shift_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.approve_offsite(uuid, timestamptz, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.approve_offsite(uuid, timestamptz, timestamptz) TO authenticated;


-- ---------------------------------------------------------------------
-- 3. reject_offsite — decided, but worth nothing.
--
-- Sets checked_out_at = checked_in_at (zero duration) and stamps approved_at,
-- so the row LEAVES the queue and credits nothing. Same idiom as
-- void_auto_closed_shift in slice 6, and the same reasoning: not a delete. The
-- member did check in; erasing it would erase the evidence, and a rejected
-- claim is exactly the thing you want a record of.
--
-- approved_at is stamped on a rejection too. That reads oddly but is correct —
-- the column means DECIDED, and the zero duration is what makes it worth
-- nothing. The alternative, a third state, buys nothing that zero hours does
-- not already say.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.reject_offsite(p_shift_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
  v_me   uuid := public.my_member_id();
  v_row  public.station_presence;
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;

  select * into v_row from public.station_presence
   where id = p_shift_id and department_id = v_dept
   for update;

  if not found then
    raise exception 'That shift was not found in your department.';
  end if;
  if v_row.kind <> 'offsite' then
    raise exception 'That is not an off-site shift.';
  end if;
  if v_row.approved_at is not null then
    raise exception 'That off-site time has already been reviewed.';
  end if;

  update public.station_presence
     set checked_out_at = v_row.checked_in_at,   -- zero duration: kept, credits nothing
         auto_closed    = false,
         approved_at    = now(),
         approved_by    = v_me
   where id = p_shift_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.reject_offsite(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.reject_offsite(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
--
-- -- 1. All three functions, signatures and grants. Expect definer=t, anon=f,
-- --    auth=t on all three, and exactly ONE dept_shifts_needing_review.
-- SELECT format('%s', proname) AS check,
--        format('args=[%s] returns=%s definer=%s anon=%s auth=%s',
--               pg_get_function_identity_arguments(oid), pg_get_function_result(oid),
--               prosecdef,
--               has_function_privilege('anon', oid, 'EXECUTE'),
--               has_function_privilege('authenticated', oid, 'EXECUTE')) AS value
--   FROM pg_proc WHERE pronamespace='public'::regnamespace
--    AND proname IN ('dept_shifts_needing_review','approve_offsite','reject_offsite')
--  ORDER BY proname;
--
-- -- 2. STILL NO CREDIT. dept_iso_hours must not know about offsite yet — that
-- --    is B5. Expect f.
-- SELECT prosrc ILIKE '%offsite%' AS iso_knows_offsite
--   FROM pg_proc WHERE proname='dept_iso_hours' AND pronamespace='public'::regnamespace;
--
-- -- 3. The queue runs and returns the right shape (empty is fine — it means
-- --    nothing is auto-closed and no off-site shift is finished-and-pending):
-- SELECT * FROM public.dept_shifts_needing_review();
--
-- -- 4. What WOULD appear, computed directly, so you can compare against #3:
-- SELECT sp.kind, sp.auto_closed, sp.approved_at IS NULL AS pending,
--        sp.checked_out_at IS NOT NULL AS finished, sp.offsite_label
--   FROM public.station_presence sp
--  WHERE sp.auto_closed
--     OR (sp.kind='offsite' AND sp.approved_at IS NULL AND sp.checked_out_at IS NOT NULL)
--  ORDER BY sp.checked_in_at;
--
-- -- 5. Rejection paths must RAISE, not no-op. Each should error:
-- --   SELECT public.approve_offsite(gen_random_uuid());                    -- not found
-- --   SELECT public.approve_offsite('<a standby row id>');                 -- not off-site
-- --   SELECT public.approve_offsite('<an OPEN offsite id>');               -- still open
-- --   SELECT public.approve_offsite('<id>', now(), now() - interval '1h'); -- end before start
-- --   SELECT public.approve_offsite('<id>', NULL, now() + interval '1d');  -- end in the future
--
-- -- 6. After approving one for real, it must leave the queue and carry an
-- --    approver. Expect 0 rows from the first, and approved_by populated.
-- SELECT count(*) AS still_pending FROM public.dept_shifts_needing_review()
--  WHERE reason <> 'auto_closed';
-- SELECT sp.offsite_label, sp.approved_at, m.name AS approved_by
--   FROM public.station_presence sp LEFT JOIN public.members m ON m.id = sp.approved_by
--  WHERE sp.kind='offsite' ORDER BY sp.checked_in_at DESC;
