-- EXPIRES_ON RLS TEST v2. Reader is explicitly NOT the author (the author bypass is by design).
begin;

insert into announcements (department_id, author_id, title, body, audience, expires_on)
select dd.id, aa.id, t.title, 'rls fixture', 'everyone', t.exp
  from (select d1.id from departments d1 where d1.name ilike '%North Hood%' limit 1) dd
  join (select m1.id from members m1
         where m1.department_id = (select d2.id from departments d2 where d2.name ilike '%North Hood%' limit 1)
           and m1.email is not null order by m1.id limit 1) aa on true
  cross join (values
    ('ZZTEST expired',  (now() at time zone 'America/Chicago')::date - 1),
    ('ZZTEST today',    (now() at time zone 'America/Chicago')::date),
    ('ZZTEST tomorrow', (now() at time zone 'America/Chicago')::date + 1),
    ('ZZTEST forever',  null::date)
  ) as t(title, exp);

-- Reader: same department, has an email, NOT leadership/admin, and NOT the author above.
select set_config('request.jwt.claims', json_build_object('email', (
  select m3.email from members m3
   where m3.department_id = (select d3.id from departments d3 where d3.name ilike '%North Hood%' limit 1)
     and m3.email is not null
     and not (m3.access && array['Department Admin','Project Admin','Board Member','Officer'])
     and m3.id <> (select m4.id from members m4
                    where m4.department_id = (select d4.id from departments d4 where d4.name ilike '%North Hood%' limit 1)
                      and m4.email is not null order by m4.id limit 1)
   order by m3.id limit 1))::text, true) as acting_as_member;

set local role authenticated;
select coalesce((select string_agg(a1.title, ', ' order by a1.title)
                   from announcements a1 where a1.title like 'ZZTEST%'),'(none)') as member_sees;
reset role;

rollback;
