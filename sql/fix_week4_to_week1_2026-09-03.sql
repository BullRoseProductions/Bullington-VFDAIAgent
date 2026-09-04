-- =====================================================================
-- APPLIED 2026-09-03. One row updated, confirmed:
--   Fire Training Week 1 · 2026-09-03 · 19:00:00 · done true · attendance 12
--
-- WHY. A drill run on 2026-09-03 was recorded against North Hood's "Fire
-- Training Week 4", scheduled for 2026-09-24. open_signin had no date guard, so
-- the QR opened for a session three weeks out and all 12 attendance rows landed
-- on the 24th. sql/open_signin_date_window.sql closes that hole; this corrects
-- the record it let through.
--
-- WHY RENAME RATHER THAN JUST MOVE. North Hood's Fire Training Week 1 falls on
-- the first Thursday. September's — 2026-09-03 — was missing while October's
-- (2026-10-01) existed. That gap is almost certainly why Week 4 was used. This
-- restores the session that should have been there.
--
-- TOUCHED TWO COLUMNS. session_attendance is never referenced: its 12 rows point
-- at this session's id, which did not change, so they travelled with it. done,
-- start_time, signin_open, department_id and series_id were left as they were.
--
-- CONSEQUENCE, on the record: North Hood's September now has no Week 4 on the
-- 24th. If that training night is still planned it must be re-created through
-- the app, which handles series_id and defaults properly.
--
-- SELF-LIMITING. The date and title clauses mean a second run matches nothing
-- rather than moving an already-corrected session.
-- =====================================================================

update public.training_sessions
   set date  = date '2026-09-03',
       title = 'Fire Training Week 1'
 where id    = 'e1b7d1a8-7e24-48ee-a3fd-3bce49f3900c'
   and date  = date '2026-09-24'
   and title ilike '%Fire Training Week 4%'
returning id, title, date, start_time, done, signin_open,
          (select count(*) from public.session_attendance sa
            where sa.session_id = training_sessions.id) as attendance;
