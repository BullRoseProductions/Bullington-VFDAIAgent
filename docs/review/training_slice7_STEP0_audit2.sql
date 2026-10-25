-- READ-ONLY Step 0 (Slice 7), part 2: the live-only move_week / swap_week_dates bodies, and how the other SQL readers use
-- training_sessions (the lines that mention it, with their neighbours). No writes.
WITH fn AS (SELECT p.proname, pg_get_functiondef(p.oid) def, p.prosecdef, has_function_privilege('authenticated', p.oid, 'EXECUTE') auth
              FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f')
SELECT jsonb_pretty(jsonb_build_object(
  'move_week', (SELECT jsonb_build_object('auth', auth, 'def', def) FROM fn WHERE proname = 'move_week' LIMIT 1),
  'swap_week_dates', (SELECT jsonb_build_object('auth', auth, 'def', def) FROM fn WHERE proname = 'swap_week_dates' LIMIT 1),
  'reader_lines', (SELECT jsonb_object_agg(proname, lines) FROM (
      SELECT f.proname, jsonb_agg(btrim(l.line) ORDER BY l.n) lines
        FROM fn f, LATERAL (SELECT row_number() OVER () n, x line FROM regexp_split_to_table(f.def, E'\n') x) l
       WHERE f.proname IN ('my_department_rollup', 'pa_department_radar', 'readiness_verdict', 'probation_item_states',
                           'set_my_session_registration', 'guard_ai_outputs_session_id', 'set_member_termination')
         AND (l.line ILIKE '%training_sessions%' OR l.line ~* '\m(ts|s)\.(done|date|audience|counts_toward|is_meeting)')
       GROUP BY f.proname) y)
)) AS r;
