-- LIVE function text captured by Step 0 / 0b (2026-10-19), byte-exact (md5 below = pg_get_functiondef on live). Reference only — do not run.
-- set_onboarding_item(uuid,uuid,boolean) md5 99e6c6944216fe3811c6bbc365958e75 · self-sign block md5 43179b88c2683b93d0d227044be7df9f
CREATE OR REPLACE FUNCTION public.set_onboarding_item(p_member_id uuid, p_item_id uuid, p_done boolean)
 RETURNS onboarding_progress
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
  v_me   uuid := public.my_member_id();
  v_done boolean := coalesce(p_done, false);
  v_row  public.onboarding_progress;
begin
  if not public.is_canmanage() then
    raise exception 'Not authorized';
  end if;
  if v_dept is null or v_me is null then
    raise exception 'We could not match your login to a department.';
  end if;
  -- SELF-SIGN BLOCK (the only change): a leader can't sign off their OWN onboarding.
  if p_member_id = v_me then
    raise exception 'You can''t sign off your own onboarding — a mentor or officer does.';
  end if;
  if not exists (select 1 from public.members where id = p_member_id and department_id = v_dept) then
    raise exception 'That member is not in your department.';
  end if;
  if not exists (select 1 from public.onboarding_items where id = p_item_id and department_id = v_dept) then
    raise exception 'That checklist item is not in your department.';
  end if;
  if exists (select 1 from public.onboarding_items where id = p_item_id and is_mentor) then
    raise exception 'The mentor item completes when a mentor is assigned.';
  end if;

  insert into public.onboarding_progress (department_id, member_id, item_id, done, checked_by, checked_at)
  values (v_dept, p_member_id, p_item_id, v_done,
          case when v_done then v_me end,
          case when v_done then now() end)
  on conflict (member_id, item_id) do update
     set done       = excluded.done,
         checked_by = excluded.checked_by,
         checked_at = excluded.checked_at
  returning * into v_row;

  return v_row;
end;
$function$

-- probation_item_states(uuid,uuid) md5 0e91cf1d69f03a7b1dcb9234b7284357
CREATE OR REPLACE FUNCTION public.probation_item_states(p_member uuid, p_dept uuid)
 RETURNS TABLE(item_id uuid, label text, category text, phase text, kind text, clears_to_run boolean, sort_order integer, satisfied boolean, state text, signed_by_name text, signed_at timestamp with time zone, have numeric, target numeric)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:probation (internal) — every onboarding item of the department, resolved for one member. Read-only.
  with mem as (select m.id, m.mentor_id from public.members m where m.id = p_member and m.department_id = p_dept),
       pr as (select (select mp.started_on from public.member_probation mp where mp.member_id = p_member) as started_on),
       td as (select (now() at time zone 'America/Chicago')::date as d)
  select i.id, i.label, i.category, i.phase, i.kind, i.clears_to_run, i.sort_order,
         case when i.kind = 'manual' and i.is_mentor then mem.mentor_id is not null
              when i.kind = 'manual' then coalesce(pg.done, false)
              when i.kind = 'ack'    then ak.series_id is not null and ak.published and (not ak.in_audience or ak.signed_current)
              when i.kind = 'hours'  then i.hours_target is not null and i.hours_source is not null and hr.have >= i.hours_target
              when i.kind = 'cert'   then nullif(btrim(coalesce(i.cert_name, '')), '') is not null and ct.current
         end,
         case when i.kind = 'manual' and i.is_mentor then case when mem.mentor_id is not null then 'mentor_assigned' else 'open' end
              when i.kind = 'manual' then case when pg.done and pg.checked_by is not null then 'signed'
                                               when pg.done then 'done_unrecorded' else 'open' end
              when i.kind = 'ack' then case when ak.series_id is null or not ak.published then 'not_configured'
                                            when not ak.in_audience then 'not_required'
                                            when ak.signed_current then 'signed_current' else 'needs_signature' end
              when i.kind = 'hours' then case when i.hours_target is null or i.hours_source is null then 'not_configured'
                                              when hr.have >= i.hours_target then 'met' else 'in_progress' end
              when i.kind = 'cert' then case when nullif(btrim(coalesce(i.cert_name, '')), '') is null then 'not_configured'
                                             when ct.current then 'current' else 'missing' end
         end,
         case when i.kind = 'manual' and not i.is_mentor and pg.done then pg.signer end,
         case when i.kind = 'manual' and not i.is_mentor and pg.done then pg.checked_at end,
         case when i.kind = 'hours' then hr.have end,
         case when i.kind = 'hours' then i.hours_target end
    from public.onboarding_items i
    cross join mem cross join pr cross join td
    left join lateral (select p.done, p.checked_by, p.checked_at, cb.name as signer
                         from public.onboarding_progress p left join public.members cb on cb.id = p.checked_by
                        where p.member_id = p_member and p.item_id = i.id
                        order by p.checked_at desc nulls last limit 1) pg on true
    left join lateral (select s.series_id, (s.requires_ack and s.current_version > 0) as published,
                              public.rs_member_in_audience(p_member, s.required_roles) as in_audience,
                              exists (select 1 from public.document_acknowledgments k
                                       where k.member_id = p_member and k.series_id = s.series_id and k.version = s.current_version
                                         and (not s.annual_resign or (k.signed_at at time zone 'America/Chicago')::date + interval '12 months' > td.d)) as signed_current
                         from public.document_series s
                        where i.kind = 'ack' and s.series_id = i.ack_series_id and s.department_id = p_dept) ak on true
    left join lateral (select case when i.hours_source = 'training_nights' then
                                (select count(distinct a.session_id)::numeric from public.session_attendance a
                                   join public.training_sessions t on t.id = a.session_id and t.department_id = p_dept
                                  where a.member_id = p_member and t.date <= td.d)
                              else
                                (select coalesce(sum(ss.hours), 0) from public.supervised_sessions ss
                                  where ss.member_id = p_member and ss.department_id = p_dept and ss.voided_at is null
                                    and (i.hours_source = 'supervised' or ss.kind = i.hours_source))
                              end as have
                        where i.kind = 'hours') hr on true
    left join lateral (select exists (select 1 from public.certs c
                                        where c.member_id = p_member and lower(btrim(c.name)) = lower(btrim(i.cert_name))
                                          and c.exp ~ '^\d{4}-(0[1-9]|1[0-2])$'
                                          and split_part(c.exp, '-', 1)::int * 12 + split_part(c.exp, '-', 2)::int
                                              >= extract(year from td.d)::int * 12 + extract(month from td.d)::int) as current
                        where i.kind = 'cert') ct on true
   where i.department_id = p_dept;
$function$
