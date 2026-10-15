-- =====================================================================
-- ONE-OFF DATA REPAIR — APPLIED 2026-10-13 by hand. Do NOT re-run.
-- Step 1 count: 23 rows (20 from Sep 12, 3 from Oct 7), 1 department (Indian Harbor 6fbb2d91…).
-- Result: pending_now = 23, still_rejected = 0, all_josh_submissions = 23, josh certs = 0 (unchanged).
--
-- Josh Merritt (member 019d1fd0…, Indian Harbor VFD) filed 23 cert submissions with Indian Harbor.
-- All 23 were rejected by auth user 819dd88d… with "no longer in department" / "No longer in
-- service at NHCVFD" — apparently a North Hood admin who could see another department's queue.
-- This puts EXACTLY those rows back to 'pending' so an Indian Harbor admin can review them.
--
-- Touches ONLY cert_submissions rows matching all four conditions below. Does NOT touch certs,
-- verified, anyone else's submissions, or the proof files. Clears the reviewer stamp and the
-- rejection note (the reject function overwrote the member's own note — nothing to restore).
-- Expects exactly 23 rows; any other count changes nothing and raises.
-- =====================================================================
begin;

do $fix$
declare
  v_n int;
begin
  update public.cert_submissions
     set status      = 'pending',
         reviewed_by = null,
         reviewed_at = null,
         note        = null
   where member_id   = '019d1fd0-e063-4d7d-adae-d770d444a1dd'
     and status      = 'rejected'
     and reviewed_by = '819dd88d-08b2-439d-ba13-8ae072e61573'
     and note ilike '%no longer%';
  get diagnostics v_n = row_count;
  if v_n <> 23 then
    raise exception 'Expected to reset exactly 23 submissions, matched %. Nothing changed.', v_n;
  end if;
end
$fix$;

commit;

-- state check (read-only) — expect pending_now = 23, still_rejected = 0, certs untouched
select count(*) filter (where status = 'pending')  as pending_now,
       count(*) filter (where status = 'rejected') as still_rejected,
       count(*)                                    as all_josh_submissions,
       (select count(*) from public.certs where member_id = '019d1fd0-e063-4d7d-adae-d770d444a1dd') as josh_certs_unchanged
  from public.cert_submissions
 where member_id = '019d1fd0-e063-4d7d-adae-d770d444a1dd';
