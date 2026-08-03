-- =====================================================================
-- SLICE 6 — the "needs review" queue: the ONLY sanctioned way to clear
-- auto_closed.
--
-- THE INVARIANT THIS FILE EXISTS TO UPHOLD:
--   An auto_closed row carries a stop time a MACHINE guessed
--   (checked_in_at + departments.max_shift_hours). It credits zero hours in
--   dept_iso_hours and sits in the uncredited bucket on the report. Nothing may
--   un-flag or re-credit such a row except a human decision recorded through
--   one of the two RPCs below.
--
--   Specifically REJECTED (2026-08-03): re-stamping auto-closed training rows
--   when an officer finalizes a session late. A late finalize is just a second
--   machine timestamp, not evidence of when anyone actually left — it would
--   restore exactly the unwitnessed hours the guardrail exists to prevent.
--   If a future feature wants to close one of these automatically, that is the
--   same mistake wearing a different hat. Surface it here instead.
--
-- Both mutations are deliberately scoped to `auto_closed = true` rows ONLY.
-- They are NOT a general shift editor: an ordinary shift stays immutable from
-- the client, so this file cannot become a back door for adjusting credited
-- hours generally.
--
-- VERIFIED LIVE BEFORE WRITING (2026-08-03):
--   • station_presence PK is `id uuid`.
--   • columns: id, department_id, member_id, checked_in_at, checked_out_at,
--     verified, ... auto_closed.
--   • is_leadership() is the gate used by dept_station_shifts / dept_iso_hours /
--     dept_on_station_now, all of which are anon=false / authenticated=true.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 1. dept_shifts_needing_review() — the queue.
--
-- UNWINDOWED, on purpose. Every other read on this page takes p_from/p_to and
-- is filtered by the range chips, but a shift flagged two weeks ago is still
-- wrong today and must not vanish because the report is showing "This month".
-- A review queue that can hide items is not a review queue.
--
-- OLDEST FIRST — the opposite of the shift log's newest-first — because this is
-- a work list, and the stalest correction is the one most likely to be
-- forgotten and the hardest to reconstruct from memory.
--
-- capped_hours is computed exactly as dept_station_shifts computes `hours`
-- (round(epoch/3600, 2)), so the number in the queue matches the number the
-- leader sees in the shift log for the same row.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dept_shifts_needing_review()
 RETURNS TABLE(
   shift_id       uuid,
   member_id      uuid,
   member_name    text,
   kind           text,
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
    select sp.id, m.id, m.name, sp.kind, sp.checked_in_at, sp.checked_out_at,
           round((extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2)
    from public.station_presence sp
    join public.members m on m.id = sp.member_id
    where sp.department_id = v_dept
      and sp.auto_closed
    order by sp.checked_in_at asc;   -- oldest first: this is a work list
end;
$function$;

REVOKE ALL ON FUNCTION public.dept_shifts_needing_review() FROM public, anon;
GRANT EXECUTE ON FUNCTION public.dept_shifts_needing_review() TO authenticated;


-- ---------------------------------------------------------------------
-- 2. resolve_auto_closed_shift(p_shift_id, p_checked_out_at) — the human answer.
--
-- NEVER SILENTLY NO-OPS. Every rejection path raises with a message a leader can
-- act on. A guardrail that quietly does nothing when handed a bad id is worse
-- than one that refuses loudly — the UI would report success and the row would
-- stay wrong.
--
-- The row is re-read FOR UPDATE before validating, so two leaders resolving the
-- same shift at once cannot interleave: the second waits, then finds
-- auto_closed already false and is told so rather than overwriting the first
-- answer.
--
-- Bounds:
--   p_checked_out_at > checked_in_at   — a shift cannot end before it began
--   p_checked_out_at <= now()          — and cannot end in the future
-- Note there is deliberately NO upper bound at max_shift_hours: the whole point
-- is that a human may legitimately assert a longer shift than the cap. The cap
-- decides when to FLAG, not what is true.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.resolve_auto_closed_shift(
  p_shift_id       uuid,
  p_checked_out_at timestamptz
) RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
  v_row  public.station_presence;
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;
  if p_checked_out_at is null then
    raise exception 'Enter the time the member actually left.';
  end if;

  select * into v_row
    from public.station_presence
   where id = p_shift_id and department_id = v_dept
   for update;

  if not found then
    raise exception 'That shift was not found in your department.';
  end if;
  if not v_row.auto_closed then
    raise exception 'That shift has already been reviewed.';
  end if;
  if p_checked_out_at <= v_row.checked_in_at then
    raise exception 'The out-time must be after the member checked in.';
  end if;
  if p_checked_out_at > now() then
    raise exception 'The out-time cannot be in the future.';
  end if;

  update public.station_presence
     set checked_out_at = p_checked_out_at,
         auto_closed    = false
   where id = p_shift_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.resolve_auto_closed_shift(uuid, timestamptz) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.resolve_auto_closed_shift(uuid, timestamptz) TO authenticated;


-- ---------------------------------------------------------------------
-- 3. void_auto_closed_shift(p_shift_id) — resolved as zero.
--
-- For a shift that should not count at all (a mis-punch, someone who never
-- actually stayed). Sets checked_out_at = checked_in_at, so the row survives as
-- a record but has zero duration.
--
-- WHY ZERO-LENGTH RATHER THAN A DELETE: the punch happened, and deleting it
-- would erase the evidence that someone's clock discipline needs a word. This
-- keeps the audit trail and credits nothing.
--
-- It lands correctly everywhere without any further change:
--   dept_iso_hours     tstzrange(x, x) is empty -> dropped by the isempty filter
--   dept_station_shifts hours = 0.00, still listed in the shift log
--   auto_close_stale_shifts  only touches checked_out_at IS NULL, so a voided
--                            row can never be re-swept
--
-- Separate function rather than a flag on resolve(): the two actions take
-- different inputs, and a boolean that silently makes p_checked_out_at
-- meaningless is the classic footgun.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.void_auto_closed_shift(p_shift_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
  v_row  public.station_presence;
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;

  select * into v_row
    from public.station_presence
   where id = p_shift_id and department_id = v_dept
   for update;

  if not found then
    raise exception 'That shift was not found in your department.';
  end if;
  if not v_row.auto_closed then
    raise exception 'That shift has already been reviewed.';
  end if;

  update public.station_presence
     set checked_out_at = v_row.checked_in_at,   -- zero duration: kept, credits nothing
         auto_closed    = false
   where id = p_shift_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.void_auto_closed_shift(uuid) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.void_auto_closed_shift(uuid) TO authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after)
-- =====================================================================
-- -- 1. All three exist, SECURITY DEFINER, anon locked out, authenticated in:
-- SELECT proname, pg_get_function_identity_arguments(oid) AS args, prosecdef,
--        has_function_privilege('anon', oid, 'EXECUTE')          AS anon_can,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_can
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('dept_shifts_needing_review','resolve_auto_closed_shift','void_auto_closed_shift')
--  ORDER BY proname;
--
-- -- 2. The queue (empty today — nothing has been auto-closed yet):
-- SELECT * FROM public.dept_shifts_needing_review();
--
-- -- 3. Rejection paths must RAISE, not no-op. Each of these should error:
-- --    SELECT public.resolve_auto_closed_shift(gen_random_uuid(), now());        -- not found
-- --    SELECT public.resolve_auto_closed_shift('<real-id>', '1999-01-01Z');      -- before check-in
-- --    SELECT public.resolve_auto_closed_shift('<real-id>', now() + interval '1 day');  -- future
-- --    SELECT public.resolve_auto_closed_shift('<already-resolved-id>', now());  -- already reviewed
--
-- -- 4. After resolving, the row must leave the queue AND appear in credited
-- --    hours. Expect 0 rows from the first, and the member in the second.
-- SELECT count(*) AS still_flagged FROM public.dept_shifts_needing_review();
-- SELECT * FROM public.dept_iso_hours(date_trunc('month', now()), now());
