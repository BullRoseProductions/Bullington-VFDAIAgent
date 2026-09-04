-- =====================================================================
-- STATUS: APPLIED 2026-09-02. Three rows zeroed, confirmed:
--   9ba2248a (Jeff Harper, 0.51h) · e9fabc20 (Matt Hohon, 1.64h) · 808d1c4f (Matt Hohon, 0.59h)
--   all now hours_now = 0.00. A later re-run returned NO rows, which is the
--   scoping working as designed: `checked_out_at = t.close_at` no longer matches
--   once a row has been zeroed, so a second run cannot touch anything.
--
-- 2.74 credited hours removed. Randy Little's 24.18h pair is untouched and still
-- needs the officer who set its out-times — see the exclusion below.
--
-- THIS HEADER WAS BRIEFLY WRONG, and the reason is worth keeping. It first said
-- NOT APPLIED, because nobody had reported a result back and absence of
-- confirmation was read as absence of a run. That is precisely the trap the
-- "migrations applied by hand" rule names: a file, a commit and a conversation
-- all say nothing about whether SQL is live. Only the rows do. Check them —
-- the three ids above should read checked_out_at = checked_in_at.
--
-- VOID THE UNAMBIGUOUS REPLAY DUPLICATES. One statement, three rows.
--
-- Each pair is one presence recorded twice by the pre-fix geofence_arrive: a
-- second, genuine DWELL from a fence flapping at its boundary, delivered late
-- and inserted with its original timestamp into a span already on the books.
-- All three pairs close at the SAME MILLISECOND — one EXIT event closing both —
-- which is the fingerprint, and in each the row being voided is entirely
-- CONTAINED by the one being kept.
--
--   VOID 9ba2248a  14:31:30 → 15:02:13  0.51h   KEEP d45cee11  14:22:44 → 15:02:13  0.66h
--        Jeff Harper, Indian Harbor, 2026-08-31
--   VOID e9fabc20  14:12:57 → 15:51:15  1.64h   KEEP 04580ac9  14:08:52 → 15:51:15  1.71h
--        Matt Hohon, Granbury, 2026-08-30
--   VOID 808d1c4f  20:57:59 → 21:33:28  0.59h   KEEP 81459f7c  20:55:56 → 21:33:28  0.63h
--        Matt Hohon, Granbury, 2026-08-30
--
-- KEEP THE SPANNING ROW, ALWAYS. It starts earlier and contains the other, so
-- keeping it credits from the member's FIRST arrival rather than a second fence
-- trigger minutes later — the reading that favours the member.
--
-- ZEROED, NOT DELETED, matching exactly what void_auto_closed_shift does to a
-- reviewed shift: the record stays and credits nothing. Deleting would destroy
-- the only evidence of the replay. That RPC cannot be used here — it guards on
-- auto_closed, and a replay duplicate is verified = true, auto_closed = false,
-- so it never reaches the review queue and both correction RPCs refuse it.
--
-- RANDY LITTLE'S PAIR IS DELIBERATELY EXCLUDED, by name in the NOT IN below
-- rather than merely by omission. It is a different shape — manual + fence, no
-- shared close, and an officer has ALREADY set out-times on both rows through
-- the review screen. 24.18 hours turn on which row is right and what end time
-- is correct, and that is a question for whoever made those corrections, not
-- for a script.
--
-- AFTERWARDS these three rows have checked_out_at = checked_in_at and will show
-- up in any "zero_length" count. That is the void, not the 2026-08-28 depart
-- bug — worth knowing before someone reads a future diagnostic and re-opens a
-- closed investigation.
--
-- EXPECTED: exactly 3 rows returned, hours_now 0.00 on each, removing 2.74
-- credited hours (0.51 + 1.64 + 0.59). Over-credit should fall from 26.92h to
-- 24.18h — Randy's pair, untouched.
-- =====================================================================

with targets(void_id, keep_id, close_at) as (values
  ('9ba2248a-a4f6-4783-ac27-00e3994a206e'::uuid,
   'd45cee11-a831-4cb7-8ddb-998c5318625c'::uuid,
   timestamptz '2026-08-31 15:02:13.030 America/Chicago'),
  ('e9fabc20-1127-4a4b-ab12-a33af99c5f28'::uuid,
   '04580ac9-26bd-4f15-94e5-ac2da74a3331'::uuid,
   timestamptz '2026-08-30 15:51:15.015 America/Chicago'),
  ('808d1c4f-e37c-4ae9-a65b-9729861b468c'::uuid,
   '81459f7c-2837-4b63-acec-e1e9063977f5'::uuid,
   timestamptz '2026-08-30 21:33:28.634 America/Chicago')
)
update public.station_presence sp
   set checked_out_at = sp.checked_in_at        -- zero duration: kept on record, credits nothing
  from targets t
 where sp.id = t.void_id
   -- the row being voided must belong to the SAME member as the row being kept
   and sp.member_id = (select member_id from public.station_presence where id = t.keep_id)
   and sp.verified
   and not coalesce(sp.auto_closed, false)
   and sp.checked_out_at = t.close_at
   -- Randy Little's pair, excluded by name so the exclusion is visible
   and sp.id not in ('79973f28-b1fd-460c-a28f-400be63eaeab'::uuid,
                     'f5bb4702-268e-4c0f-9858-74b8b01a1198'::uuid)
returning sp.id,
          (select name from public.members m where m.id = sp.member_id)          as member,
          (sp.checked_in_at at time zone 'America/Chicago')                      as checked_in_ct,
          round(extract(epoch from (sp.checked_out_at - sp.checked_in_at))/3600.0, 2) as hours_now;
