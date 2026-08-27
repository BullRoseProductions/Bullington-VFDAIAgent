-- =====================================================================
-- PHASE E — PER-STATION STATION HOURS REPORTING.
--
-- The operational data has been per-station since B3; the leadership reports
-- have not. E adds the per-house dimension as an ENHANCEMENT on top of the
-- existing totals.
--
-- THE RULE THAT DOES NOT BEND: the department's ISO/LOSAP totals come back
-- byte-identical. dept_iso_hours IS NOT TOUCHED BY THIS FILE — not replaced, not
-- edited, not re-granted. The per-station figures arrive in a NEW companion
-- function, which is the cheapest possible proof that the official number did
-- not move: nothing was done to it.
--
-- BUILT ON THE LIVE c2 BODIES, confirmed before writing:
--   • c2 IS live — dept_station_shifts is the ELEVEN-column body with
--     officer_attested, branch B sourced from attested_training().
--   • presence_null_station = 0 — every observed shift is stamped, so the
--     Unassigned bucket is purely officer-attested drill time.
--
-- WHY ISO NEEDS AN ATTRIBUTION RULE AT ALL. dept_iso_hours does not sum hours,
-- it DE-OVERLAPS intervals per member with range_agg. A member with standby at
-- House A 08:00-12:00 and training at House B 10:00-11:00 contributes ONE merged
-- four-hour span, not five hours. Split naively by house that is 4 + 1 = 5
-- against a department total of 4, and the excess is the overlap — which belongs
-- to two houses at once. So the breakdown decomposes the de-overlapped union
-- into elementary intervals and attributes each one to a single house. Section 3
-- sets out the rule and why the decomposition is exact.
--
-- DEPLOY GATE: apply BEFORE the client deploys. The report reads two new
-- functions and two new columns by name.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- 0. PRECONDITIONS — assert, do not assume.
--
-- The dept_station_shifts assertions matter most: this file DROPs it, and it
-- must be certain it is dropping the eleven-column c2 body. Dropping a body that
-- is not what section 2 reproduces would silently lose whatever else was in it.
-- ---------------------------------------------------------------------
DO $pre$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='dept_iso_hours') THEN
    RAISE EXCEPTION 'E precondition failed: dept_iso_hours() is missing. The breakdown mirrors its filters exactly and is meaningless without it.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='attested_training') THEN
    RAISE EXCEPTION 'E precondition failed: attested_training() is missing. Apply sql/training_hours_c1_attested_training.sql first.';
  END IF;

  -- c2 must be live: the ELEVEN-column shape, with officer_attested.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='dept_station_shifts'
                    AND pg_get_function_result(oid) ILIKE '%officer_attested%') THEN
    RAISE EXCEPTION 'E precondition failed: dept_station_shifts() does not return officer_attested, so c2 is not live. Section 2 reproduces the c2 body and would drop columns the report reads.';
  END IF;

  -- ...and branch B must really be sourced from attested_training, not derived
  -- inline. If it is the pre-c2 body, section 2's branch B is wrong.
  IF NOT EXISTS (SELECT 1 FROM pg_proc
                  WHERE pronamespace='public'::regnamespace AND proname='dept_station_shifts'
                    AND prosrc ILIKE '%attested_training(%') THEN
    RAISE EXCEPTION 'E precondition failed: dept_station_shifts() does not call attested_training(). The live body is not the c2 one this file was written against.';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_schema='public' AND table_name='station_presence' AND column_name='station_id') THEN
    RAISE EXCEPTION 'E precondition failed: station_presence.station_id is missing. Apply sql/stations_phaseB3.sql first.';
  END IF;

  RAISE NOTICE 'E pre-flight OK — c2 body confirmed, dept_iso_hours present and will not be touched.';
END
$pre$;


-- ---------------------------------------------------------------------
-- 1. CAPTURE THE GRANTS BEFORE THE DROP.
--
-- Lifted from training_hours_c2:132-152, unchanged apart from the GUC name. That
-- pattern exists because re-granting from memory is how a function comes back
-- subtly more open — or more closed — than it was, and neither is noticeable
-- until something breaks in production. It is also the mistake this project has
-- already paid for twice: D1 and D2a both re-granted by hand and both dropped
-- service_role, caught at review rather than by the file.
--
-- CARRIED IN A SESSION GUC, NOT A TEMP TABLE, and that is c2's hard-won detail:
-- the Supabase SQL editor commits between statements, so CREATE TEMP TABLE
-- ... ON COMMIT DROP fired the instant it was created and was gone before the
-- next statement could read it. set_config(..., false) is session-scoped and
-- survives regardless of how the editor frames each statement.
-- ---------------------------------------------------------------------
DO $do$
DECLARE v_sql text;
BEGIN
  SELECT coalesce(string_agg(
           format('GRANT %s ON FUNCTION public.dept_station_shifts(timestamptz, timestamptz) TO %s;',
                  a.privilege_type,
                  CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE quote_ident(a.grantee::regrole::text) END),
           ' '), '')
    INTO v_sql
    FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) a
   WHERE p.oid = 'public.dept_station_shifts(timestamptz,timestamptz)'::regprocedure;

  PERFORM set_config('b4c.e_dss_grants', v_sql, false);   -- false = session, not transaction

  IF v_sql = '' THEN
    RAISE NOTICE 'dept_station_shifts had a NULL ACL (default: EXECUTE to PUBLIC). Nothing to replay — check this is intended.';
  ELSE
    RAISE NOTICE 'Captured grants to replay: %', v_sql;
  END IF;
END
$do$;


-- ---------------------------------------------------------------------
-- 2. dept_station_shifts — the live c2 body, plus two appended columns.
--
-- REPRODUCED FROM c2 (training_hours_c2:159-223). Branch A's filters, branch B's
-- attested_training source, the capped-interval hours, the four flags and the
-- positional `order by 3 desc` are all carried over unchanged.
--
-- TWO ADDITIONS, BOTH APPENDED LAST so nothing positional shifts — and note that
-- `order by 3 desc` is position-based, so appending at the end leaves it pointing
-- at checked_in_at exactly as before.
--
--   branch A   left join stations -> sp.station_id, st.name
--   branch B   null::uuid, null::text
--
-- LEFT JOIN, NEVER INNER, and this is the load-bearing choice. A LEFT JOIN
-- preserves every left row unconditionally: a null station_id yields one row with
-- nulls, and a station_id pointing at a since-deleted station does too. An INNER
-- join would silently drop both classes and take their credited hours with them —
-- the B3b lesson, proven there with 59 = 59 and 565.26 = 565.26.
--
-- BRANCH B HAS NO STATION AND NEVER WILL under today's schema: attested_training
-- returns (member_id, session_id, start_at, end_at, optional), and
-- training_sessions has no station_id — Phase A stamped apparatus, equipment,
-- duties and station_log, not that table. So these are literals, not a failed
-- lookup, and every attested hour lands in the Unassigned bucket by construction.
-- That was decided deliberately: attested drill time stays department-level.
--
-- ROW COUNT AND SUM(hours) ARE INVARIANT BY CONSTRUCTION: branch A output rows =
-- branch A input rows by the LEFT-join property, and branch B rows gain two
-- literal columns without changing in number or value.
-- ---------------------------------------------------------------------
DROP FUNCTION public.dept_station_shifts(timestamptz, timestamptz);

CREATE FUNCTION public.dept_station_shifts(
  p_from timestamp with time zone DEFAULT date_trunc('month'::text, now()),
  p_to   timestamp with time zone DEFAULT now()
)
 RETURNS TABLE(member_id uuid, member_name text, checked_in_at timestamp with time zone,
               checked_out_at timestamp with time zone, hours numeric, kind text,
               verified boolean, auto_closed boolean, source text, optional boolean,
               officer_attested boolean,
               station_id uuid, station_name text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;
  return query
    -- A. OBSERVED — unchanged except for the two new columns. A real punch is
    -- never "attested": it was measured, and the distinction is the whole point.
    select m.id, m.name, sp.checked_in_at, sp.checked_out_at,
           round((extract(epoch from (sp.checked_out_at - sp.checked_in_at)) / 3600.0)::numeric, 2) as hours,
           sp.kind, sp.verified, sp.auto_closed,
           coalesce(sp.source, 'geo')::text as source,
           false as optional,
           false as officer_attested,
           sp.station_id,
           st.name::text as station_name
    from public.station_presence sp
    join public.members m on m.id = sp.member_id
    left join public.stations st on st.id = sp.station_id     -- LEFT: never drops a row
    where sp.department_id = v_dept
      and sp.checked_out_at is not null
      and sp.kind in ('standby','training')
      and sp.checked_in_at >= p_from
      and sp.checked_in_at <  p_to
    union all
    -- B. OFFICER-ATTESTED — sourced from attested_training so this and
    -- dept_iso_hours cannot disagree about what an attested interval is. The cap,
    -- the timezone, the four gates and the observed-wins dedup all live there.
    --
    -- hours is the CAPPED interval, not the drill's length: end_at is already
    -- start_at + least(90 min, duration).
    --
    -- The station columns are NULL LITERALS — there is no station to look up.
    select m.id, m.name,
           att.start_at                                  as checked_in_at,
           att.end_at                                    as checked_out_at,
           round((extract(epoch from (att.end_at - att.start_at)) / 3600.0)::numeric, 2) as hours,
           'training'::text                             as kind,
           false                                        as verified,   -- attested, NOT location-verified
           false                                        as auto_closed,
           'officer_manual'::text                       as source,
           att.optional                                  as optional,
           true                                         as officer_attested,
           null::uuid                                   as station_id,
           null::text                                   as station_name
    from public.attested_training(v_dept, p_from, p_to) att
    join public.members m on m.id = att.member_id
    where att.start_at >= p_from
      and att.start_at <  p_to
    order by 3 desc;                                     -- positional: checked_in_at, unchanged
end;
$function$;


-- ---------------------------------------------------------------------
-- 3. REPLAY THE CAPTURED GRANTS.
--
-- Reads back what section 1 stored. current_setting(..., true) returns NULL
-- rather than raising if the GUC is absent, so a partial run says so plainly.
--
-- IF THIS RAISES, the function exists but may have NO grants — the app would get
-- permission-denied on dept_station_shifts. The fix is one line, and the capture
-- NOTICE in section 1 will have shown the exact text:
--     GRANT EXECUTE ON FUNCTION public.dept_station_shifts(timestamptz, timestamptz) TO authenticated;
-- ---------------------------------------------------------------------
DO $do$
DECLARE v_sql text := current_setting('b4c.e_dss_grants', true);
BEGIN
  IF v_sql IS NULL THEN
    RAISE EXCEPTION 'The captured grants are missing — section 1 did not run in this session. dept_station_shifts may now have NO grants; re-grant by hand before using the app.';
  ELSIF v_sql = '' THEN
    RAISE NOTICE 'Nothing to replay (NULL ACL captured).';
  ELSE
    EXECUTE v_sql;
    RAISE NOTICE 'Replayed grants: %', v_sql;
  END IF;
END
$do$;


-- ---------------------------------------------------------------------
-- 4. dept_iso_hours_by_station — the ISO breakdown. NEW; dept_iso_hours itself
--    is not touched.
--
-- THE PROBLEM. dept_iso_hours de-overlaps per member with range_agg, so the
-- department total is the MEASURE OF A UNION, not a sum. No partition of the
-- input spans can sum to it: overlapping minutes belong to two houses at once.
--
-- THE METHOD — ELEMENTARY INTERVALS, and why it is exact.
--   1. Take the same clipped spans dept_iso_hours takes, with the SAME filters.
--   2. Collect every span boundary for a member and cut the timeline at each one.
--   3. Between two consecutive boundaries, THE SET OF COVERING SPANS CANNOT
--      CHANGE — that is what makes the decomposition exact rather than an
--      approximation. Every elementary interval is wholly inside or wholly
--      outside each span.
--   4. The elementary intervals that are covered at all partition the union
--      exactly, so their durations sum to the de-overlapped total.
--   5. An elementary interval counts as TRAINING if ANY covering span is
--      training — which is precisely what range_agg's
--      `filter (where is_training)` measures.
--
-- THE ATTRIBUTION RULE, and one deviation from the brief, flagged:
--
--   approved:   earliest-starting covering span, ties by station_id
--   implemented: a span WITH a house beats one without, THEN earliest start,
--                THEN station_id
--
-- WHY THE DEVIATION. Under the literal rule, an attested drill (no house) that
-- started earlier than an overlapping observed standby would pull that minute
-- into "Unassigned" — reporting a minute we KNOW was spent at House A as "not
-- recorded at a house". Preferring the known house is strictly more informative
-- and never less true, and it changes no total, only which bucket a minute lands
-- in. To revert to the literal rule, delete the first ORDER BY term
-- `(l.sid is null) asc` — one line, nothing else changes.
--
-- IT FOOTS, AND HERE IS WHY: attribution decides which bucket a minute goes to,
-- never whether it is counted. Sum over stations of total_secs = measure of the
-- union = dept_iso_hours' total. Sum over stations of training_secs = measure of
-- the training union = dept_iso_hours' training_hours. Check 4 in VERIFY proves
-- this against live data at SECONDS precision.
--
-- ROUNDING, STATED PLAINLY: each row is rounded to 2dp exactly as dept_iso_hours
-- rounds each member. A client that SUMS the displayed per-house figures can
-- therefore differ from the displayed headline by up to 0.01 per row. The
-- underlying seconds are exact; only the display can drift. The verify check
-- compares seconds for that reason.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dept_iso_hours_by_station(
  p_from timestamp with time zone,
  p_to   timestamp with time zone
)
 RETURNS TABLE(
   member_id       uuid,
   member_name     text,
   station_id      uuid,
   station_name    text,
   training_hours  numeric,
   standby_hours   numeric,
   iso_total_hours numeric
 )
 LANGUAGE plpgsql
 STABLE
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
begin
  -- Same gate and same argument validation as dept_iso_hours, deliberately
  -- worded identically so the two cannot drift apart.
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;
  if p_from is null or p_to is null then
    raise exception 'A start and end date are both required.';
  end if;
  if p_from >= p_to then
    raise exception 'The start of the period must come before the end.';
  end if;

  return query
  with clipped as (
    -- A. OBSERVED. Filters copied from dept_iso_hours verbatim — verified,
    -- closed, not auto_closed, standby/training, overlapping the window.
    -- Any divergence here would make the breakdown describe a different
    -- population than the headline.
    select
      sp.member_id                              as mid,
      (sp.kind = 'training')                    as is_training,
      sp.station_id                             as sid,
      greatest(sp.checked_in_at, p_from)        as lo,
      least(sp.checked_out_at, p_to)            as hi
    from public.station_presence sp
    where sp.department_id   = v_dept
      and sp.verified
      and sp.checked_out_at is not null
      and not sp.auto_closed
      and sp.kind in ('standby','training')
      and sp.checked_in_at  <  p_to
      and sp.checked_out_at >  p_from

    union all

    -- B. OFFICER-ATTESTED. No station, ever — sid is a null literal, which is
    -- what puts every attested minute in the Unassigned bucket. `not optional`
    -- and the overlap test mirror dept_iso_hours exactly.
    select
      att.member_id                             as mid,
      true                                      as is_training,
      null::uuid                                as sid,
      greatest(att.start_at, p_from)            as lo,
      least(att.end_at, p_to)                   as hi
    from public.attested_training(v_dept, p_from, p_to) att
    where not att.optional
      and att.start_at < p_to
      and att.end_at   > p_from
  ),
  live as (
    select * from clipped where hi > lo          -- the isempty(span) equivalent
  ),
  -- Every boundary, per member. UNION not UNION ALL: a repeated boundary would
  -- produce a zero-length elementary interval, harmless but pointless.
  bounds as (
    select mid, lo as t from live
    union
    select mid, hi as t from live
  ),
  -- Cut the timeline at each boundary. Between consecutive boundaries the set of
  -- covering spans is constant — the property the whole method rests on.
  elems as (
    select mid, t as lo, lead(t) over (partition by mid order by t) as hi
    from bounds
  ),
  cut as (
    select * from elems where hi is not null and hi > lo
  ),
  attributed as (
    select
      c.mid,
      c.lo,
      c.hi,
      bool_or(l.is_training) as is_training,       -- training if ANY cover is
      -- THE ATTRIBUTION RULE. See the header for the one deviation and how to
      -- revert it.
      (array_agg(l.sid ORDER BY (l.sid is null) asc, l.lo asc, l.sid asc))[1] as sid
    from cut c
    join live l
      on  l.mid = c.mid
      and l.lo <= c.lo
      and l.hi >= c.hi                             -- covers the whole elementary interval
    group by c.mid, c.lo, c.hi
  ),
  per as (
    select
      a.mid,
      a.sid,
      coalesce(sum(extract(epoch from (a.hi - a.lo))) filter (where a.is_training), 0) as training_secs,
      sum(extract(epoch from (a.hi - a.lo)))                                           as total_secs
    from attributed a
    group by a.mid, a.sid
  )
  select
    p.mid,
    m.name,
    p.sid,
    st.name::text,
    round((p.training_secs / 3600.0)::numeric, 2),
    round(((p.total_secs - p.training_secs) / 3600.0)::numeric, 2),
    round((p.total_secs / 3600.0)::numeric, 2)
  from per p
  join public.members m on m.id = p.mid
  left join public.stations st on st.id = p.sid    -- LEFT: Unassigned must survive
  order by m.name, (p.sid is null) asc, st.name;   -- Unassigned last within a member
end;
$function$;

REVOKE ALL    ON FUNCTION public.dept_iso_hours_by_station(timestamptz, timestamptz) FROM anon, public;
GRANT EXECUTE ON FUNCTION public.dept_iso_hours_by_station(timestamptz, timestamptz) TO authenticated;
GRANT EXECUTE ON FUNCTION public.dept_iso_hours_by_station(timestamptz, timestamptz) TO service_role;


-- ---------------------------------------------------------------------
-- 5. dept_on_station_now_all — who is on station, across every house.
--
-- dept_on_station_now IS NOT TOUCHED. It is scoped to the ACTIVE station and
-- fails open, which is right for the operational "my house right now" view, and
-- it has a live caller at App.jsx:10298. This is the leadership view beside it.
--
-- Built from B3's body (stations_phaseB3:138-168) with the active-station clause
-- removed and the station carried out through a LEFT JOIN. Same is_leadership()
-- gate, same distinct-on-member, same training-wins tiebreak.
--
-- ORDERED BY HOUSE so the client can group without re-sorting: default house
-- first, then by name, Unassigned last. A member on an unstamped shift would
-- sort last rather than vanish — presence_null_station is 0 today, so that arm
-- is defensive rather than expected.
--
-- NO CREDITED NUMBER IS COMPUTED HERE. This reads open presence rows; it totals
-- nothing and feeds no compliance figure.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dept_on_station_now_all()
 RETURNS TABLE(
   member_id     uuid,
   member_name   text,
   checked_in_at timestamp with time zone,
   kind          text,
   verified      boolean,
   station_id    uuid,
   station_name  text
 )
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_dept uuid := public.my_department_id();
begin
  if not public.is_leadership() then
    raise exception 'Not authorized';
  end if;
  return query
    select x.member_id, x.member_name, x.checked_in_at, x.kind, x.verified,
           x.station_id, st.name::text
    from (
      select distinct on (m.id)
             m.id as member_id, m.name as member_name,
             sp.checked_in_at, sp.kind, sp.verified, sp.station_id
      from public.station_presence sp
      join public.members m on m.id = sp.member_id
      where sp.department_id = v_dept
        and sp.checked_out_at is null
        and sp.kind in ('standby','training')
      order by m.id, (sp.kind = 'training') desc, sp.checked_in_at
    ) x
    left join public.stations st on st.id = x.station_id
    order by st.is_default desc nulls last, st.name nulls last, x.checked_in_at;
end;
$function$;

REVOKE ALL    ON FUNCTION public.dept_on_station_now_all() FROM anon, public;
GRANT EXECUTE ON FUNCTION public.dept_on_station_now_all() TO authenticated;
GRANT EXECUTE ON FUNCTION public.dept_on_station_now_all() TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';


-- =====================================================================
-- VERIFY (run after). Check 4 is the one that matters — it proves the
-- breakdown foots to the headline, and it runs as postgres.
-- =====================================================================
--
-- -- 1. Shapes and grants. EXPECT: dept_station_shifts copies=1 with THIRTEEN
-- --    columns ending station_name; its acl IDENTICAL to the pre-apply capture
-- --    (that is what section 1/3 exists to guarantee); the two new functions
-- --    anon=f, auth=t, svc=t.
-- SELECT format('%s(%s)', proname, pg_get_function_identity_arguments(oid)) AS fn,
--        count(*) OVER (PARTITION BY proname) AS copies,
--        prosecdef AS definer,
--        has_function_privilege('anon',          oid, 'EXECUTE') AS anon_exec,
--        has_function_privilege('authenticated', oid, 'EXECUTE') AS auth_exec,
--        has_function_privilege('service_role',  oid, 'EXECUTE') AS svc_exec,
--        proacl::text AS acl
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace
--    AND proname IN ('dept_station_shifts','dept_iso_hours_by_station',
--                    'dept_on_station_now_all','dept_iso_hours','dept_on_station_now')
--  ORDER BY proname;
--
-- -- 2. dept_iso_hours AND dept_on_station_now ARE UNTOUCHED. Diff each against
-- --    the pre-apply capture — they must be character-for-character identical.
-- SELECT pg_get_functiondef('public.dept_iso_hours'::regproc);
-- SELECT pg_get_functiondef('public.dept_on_station_now'::regproc);
--
-- -- 3. The station columns really landed, and branch B really is null literals.
-- --    EXPECT has_station_cols=t, left_join=t, branch_b_null=t.
-- SELECT (pg_get_function_result(oid) ILIKE '%station_name%') AS has_station_cols,
--        (prosrc ILIKE '%left join public.stations%')          AS left_join,
--        (prosrc ILIKE '%null::uuid%')                         AS branch_b_null
--   FROM pg_proc
--  WHERE pronamespace='public'::regnamespace AND proname='dept_station_shifts';
--
--
-- ============ CHECK 4 — THE FOOTING PROOF ============================
-- Both RPCs are is_leadership()-gated and raise 'Not authorized' as postgres, so
-- this replicates BOTH computations from base tables and compares them at
-- SECONDS precision, where the arithmetic is exact.
--
--   headline  = range_agg de-overlap, exactly as dept_iso_hours does it
--   breakdown = the elementary-interval decomposition, summed back over houses
--
-- EXPECT: zero rows. Any row is a member whose per-house figures do not foot to
-- their department total, and E must not ship.
--
-- Replace the department id on the first line. Get one with:
--   SELECT id, name FROM public.departments ORDER BY name;
--
-- WITH params AS (
--   SELECT 'PASTE-DEPARTMENT-UUID-HERE'::uuid AS dept,
--          date_trunc('year', now())           AS p_from,
--          now()                               AS p_to
-- ),
-- clipped AS (
--   SELECT sp.member_id AS mid, (sp.kind = 'training') AS is_training, sp.station_id AS sid,
--          greatest(sp.checked_in_at, x.p_from) AS lo, least(sp.checked_out_at, x.p_to) AS hi
--     FROM public.station_presence sp CROSS JOIN params x
--    WHERE sp.department_id = x.dept AND sp.verified AND sp.checked_out_at IS NOT NULL
--      AND NOT sp.auto_closed AND sp.kind IN ('standby','training')
--      AND sp.checked_in_at < x.p_to AND sp.checked_out_at > x.p_from
--   UNION ALL
--   SELECT att.member_id, true, NULL::uuid,
--          greatest(att.start_at, x.p_from), least(att.end_at, x.p_to)
--     FROM params x CROSS JOIN LATERAL public.attested_training(x.dept, x.p_from, x.p_to) att
--    WHERE NOT att.optional AND att.start_at < x.p_to AND att.end_at > x.p_from
-- ),
-- live AS (SELECT * FROM clipped WHERE hi > lo),
-- -- the headline, the real function's way
-- agg AS (
--   SELECT mid,
--          range_agg(tstzrange(lo, hi, '[)')) FILTER (WHERE is_training) AS tmr,
--          range_agg(tstzrange(lo, hi, '[)'))                            AS amr
--     FROM live GROUP BY mid
-- ),
-- headline AS (
--   SELECT mid,
--          coalesce((SELECT sum(extract(epoch FROM (upper(r) - lower(r)))) FROM unnest(tmr) r), 0) AS h_train,
--          coalesce((SELECT sum(extract(epoch FROM (upper(r) - lower(r)))) FROM unnest(amr) r), 0) AS h_total
--     FROM agg
-- ),
-- -- the breakdown, the new function's way
-- bounds AS (SELECT mid, lo AS t FROM live UNION SELECT mid, hi FROM live),
-- elems  AS (SELECT mid, t AS lo, lead(t) OVER (PARTITION BY mid ORDER BY t) AS hi FROM bounds),
-- cut    AS (SELECT * FROM elems WHERE hi IS NOT NULL AND hi > lo),
-- attributed AS (
--   SELECT c.mid, c.lo, c.hi, bool_or(l.is_training) AS is_training,
--          (array_agg(l.sid ORDER BY (l.sid IS NULL) ASC, l.lo ASC, l.sid ASC))[1] AS sid
--     FROM cut c JOIN live l ON l.mid = c.mid AND l.lo <= c.lo AND l.hi >= c.hi
--    GROUP BY c.mid, c.lo, c.hi
-- ),
-- breakdown AS (
--   SELECT mid,
--          coalesce(sum(extract(epoch FROM (hi - lo))) FILTER (WHERE is_training), 0) AS b_train,
--          sum(extract(epoch FROM (hi - lo)))                                          AS b_total
--     FROM attributed GROUP BY mid
-- )
-- SELECT m.name, h.h_train, b.b_train, h.h_train - b.b_train AS training_delta_secs,
--                h.h_total, b.b_total, h.h_total - b.b_total AS total_delta_secs
--   FROM headline h JOIN breakdown b USING (mid) JOIN public.members m ON m.id = h.mid
--  WHERE h.h_train IS DISTINCT FROM b.b_train
--     OR h.h_total IS DISTINCT FROM b.b_total;
--
-- -- 4b. THE SAME PROOF, PER HOUSE, for eyeballing one real member. Swap the
-- --     WHERE at the end of 4 for a member filter and group by sid instead of
-- --     dropping it, or simply run the function signed in as leadership:
-- --       SELECT * FROM public.dept_iso_hours_by_station(date_trunc('year',now()), now())
-- --        WHERE member_name = 'SOME NAME';
-- --       SELECT * FROM public.dept_iso_hours(date_trunc('year',now()), now())
-- --        WHERE member_name = 'SOME NAME';
-- --     The per-house rows must sum to the single headline row, to within 0.01
-- --     per house from rounding (check 4 is the exact version).
--
--
-- -- 5. THE CREDITED TOTAL DID NOT MOVE. Branch A only — branch B has no base
-- --    table to sum this way — so this is a floor, not the whole proof.
-- --    Compare to the same query run BEFORE applying.
-- SELECT count(*) AS closed_shifts,
--        round(sum(extract(epoch FROM (checked_out_at - checked_in_at)) / 3600.0)::numeric, 2) AS total_hours
--   FROM public.station_presence
--  WHERE checked_out_at IS NOT NULL AND kind IN ('standby','training');
--
-- -- 5b. THE AUTHORITATIVE before/after must be taken FROM THE APP as leadership,
-- --     because branch B only exists inside the RPCs:
-- --       SELECT * FROM public.dept_iso_hours(date_trunc('year',now()), now());
-- --       SELECT count(*), sum(hours) FROM public.dept_station_shifts(date_trunc('year',now()), now());
-- --     Both must be identical to the pre-apply capture.
--
-- -- 6. Unassigned is purely attested. EXPECT presence_null_station = 0, which is
-- --    what makes "mostly officer-attested drill time" an accurate label.
-- SELECT count(*) FILTER (WHERE station_id IS NULL) AS presence_null_station,
--        count(*)                                    AS total_presence_rows
--   FROM public.station_presence;
--
-- ---------- SIGNED IN, on the deployed app ----------
-- -- 7.  Multi-station department: the breakdown panel foots to the headline, and
-- --     the Unassigned row carries the attested drill time.
-- -- 8.  Single-station department: no breakdown panel at all (suppressed).
-- -- 9.  "Who's on now" groups by house; a house with nobody shows as empty
-- --     rather than being absent.
-- -- 10. The shift log's station column shows the house for observed rows and
-- --     blank-with-a-dash for attested ones.
