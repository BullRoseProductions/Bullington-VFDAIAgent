-- =====================================================================
-- B4C · POA Member Hub — seed.sql  (demo data so you can log in and SEE it)
--
-- BEFORE RUNNING: replace  you@example.com  with the email you'll sign in
-- with (twice below). Then run this once in the Supabase SQL Editor.
-- You're seeded as Board so you can file minutes / complete meetings.
-- =====================================================================

insert into departments (id, name, org_type)
values ('00000000-0000-0000-0000-0000000000d1', 'Fort Worth POA', 'poa')
on conflict (id) do nothing;

-- YOU (Board access)  <-- change the email
insert into members (department_id, email, full_name, badge, district, access, standing)
values ('00000000-0000-0000-0000-0000000000d1', 'you@example.com', 'Your Name', '4471', '4',
        array['Board','Member'], 'Good')
on conflict (department_id, lower(email)) do nothing;

-- a second, plain member (so the roster isn't empty)
insert into members (department_id, email, full_name, badge, district, access, standing)
values ('00000000-0000-0000-0000-0000000000d1', 'reyes@example.com', 'M. Reyes', '2213', '4',
        array['Member'], 'Good')
on conflict (department_id, lower(email)) do nothing;

-- an OPEN meeting with an agenda
insert into meetings (id, department_id, title, kind, scheduled_at, location, status, created_by)
values ('00000000-0000-0000-0000-0000000000m1',
        '00000000-0000-0000-0000-0000000000d1',
        'General Membership Meeting', 'general',
        now() + interval '5 days', 'Union Hall', 'open',
        (select id from members where lower(email)=lower('you@example.com')))
on conflict (id) do nothing;

insert into agenda_items (meeting_id, position, title, notes) values
  ('00000000-0000-0000-0000-0000000000m1', 1, 'Call to order & roll', 'Quorum from attendance'),
  ('00000000-0000-0000-0000-0000000000m1', 2, 'Treasurer''s report', null),
  ('00000000-0000-0000-0000-0000000000m1', 3, 'CBA ratification vote', 'Ballot link in the member app'),
  ('00000000-0000-0000-0000-0000000000m1', 4, 'New business & adjourn', null)
on conflict do nothing;

-- action items carried from last meeting (one owned by YOU, so you can close it)
insert into action_items (meeting_id, department_id, title, owner_member_id, due_date, status) values
  ('00000000-0000-0000-0000-0000000000m1', '00000000-0000-0000-0000-0000000000d1',
     'Finalize CBA vote logistics',
     (select id from members where lower(email)=lower('you@example.com')),
     current_date + 3, 'open'),
  ('00000000-0000-0000-0000-0000000000m1', '00000000-0000-0000-0000-0000000000d1',
     'Renew two sponsor agreements',
     (select id from members where lower(email)=lower('reyes@example.com')),
     current_date + 12, 'open'),
  ('00000000-0000-0000-0000-0000000000m1', '00000000-0000-0000-0000-0000000000d1',
     'Post scholarship announcement',
     (select id from members where lower(email)=lower('reyes@example.com')),
     current_date - 1, 'done')
on conflict do nothing;
