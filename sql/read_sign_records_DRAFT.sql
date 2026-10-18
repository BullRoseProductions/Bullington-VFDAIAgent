-- =====================================================================
-- READ & SIGN — the department's SIGNED RECORDS (Board / DA / Officer): each member's signed version — signature,
-- attestation wording, version, fingerprint, date — for the station's own audit copy.
-- DRAFT — UNREVIEWED. Not applied. Test: sql/read_sign_records_RETEST.sql (run AFTER, separately).
-- Brief: claude/B4C_Phase3.1_ReadSign_AdminSignedRecords_BuildOrder.md.
--
-- WHAT CHANGES (purely additive — one new read function):
--   dept_signed_records(p_document_id uuid DEFAULT NULL)
--     -> (member_id, name, series_id, title, version, content_hash, ack_statement, signature_data, signed_name, signed_at)
--   SECURITY DEFINER, STABLE, read-only. Fails CLOSED: raises unless the caller has a department AND is_canmanage()
--   (Board / DA / Officer of THAT department — the live is_canmanage() is department-scoped and requires Active /
--   Probationary). Every row is filtered to department_id = my_department_id() on BOTH the acknowledgment and its series.
--   p_document_id: any row of the series (current, replaced or archived) scopes to that series — refused if that
--   document isn't in the caller's department. NULL = every series in the department that currently requires a signature.
--   `name` is the member's current roster name; `signed_name` is the server's snapshot at signing (the record).
--   REVOKE anon, public / GRANT authenticated (the gate enforces leadership inside).
--
-- NOTE FOR THE REVIEW (divergence from the brief's premise): the live read policy document_acknowledgments_read
--   (read_sign_2026-10-17.sql) is NOT member-only — it is
--     department_id = my_department_id() AND (member_id = my_member_id() OR is_canmanage())
--   so a Board / DA / Officer can ALREADY select the department's rows, signature_data included, straight from the
--   table. This function is therefore not a widening of who can read a signature; it adds the roster name + a
--   series/document scope in one gated call. The policy is left exactly as it is (the brief says don't touch it); if
--   signatures should be leadership-readable ONLY through this function, that is a separate policy change to decide.
--
-- UNCHANGED (post-conditions prove it, else the whole block rolls back): every policy (character for character),
--   dept_read_sign_compliance() and acknowledge_document() bodies, the append-only trigger, no write grant on
--   document_acknowledgments. Never reads or writes `verified`.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_cmp_before text; v_ack_before text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public'$q$;
BEGIN
  -- preconditions
  IF to_regclass('public.document_acknowledgments') IS NULL
     OR (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_acknowledgments'
           AND column_name IN ('signature_data', 'signed_name')) <> 2 THEN
    RAISE EXCEPTION 'Precondition failed: apply read_sign + read_sign_signature first.';
  END IF;
  IF to_regprocedure('public.dept_read_sign_compliance()') IS NULL OR to_regprocedure('public.acknowledge_document(uuid,integer,text,text)') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: dept_read_sign_compliance() / the 4-arg acknowledge_document is missing.';
  END IF;
  IF to_regprocedure('public.is_canmanage()') IS NULL OR to_regprocedure('public.my_department_id()') IS NULL
     OR position('my_department_id()' in pg_get_functiondef('public.is_canmanage()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Precondition failed: is_canmanage() is missing or no longer department-scoped — do not build on it.';
  END IF;
  IF to_regprocedure('public.dept_signed_records(uuid)') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: dept_signed_records already exists — already applied. Nothing changed.';
  END IF;
  EXECUTE pol_sql INTO v_pol_before;
  v_cmp_before := pg_get_functiondef('public.dept_read_sign_compliance()'::regprocedure);
  v_ack_before := pg_get_functiondef('public.acknowledge_document(uuid,integer,text,text)'::regprocedure);

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.dept_signed_records(p_document_id uuid DEFAULT NULL)
 RETURNS TABLE(member_id uuid, name text, series_id uuid, title text, version integer, content_hash text,
               ack_statement text, signature_data text, signed_name text, signed_at timestamptz)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:read_sign — Board / DA / Officer of the department: the department's signed records (signature, wording,
-- version, fingerprint, date). Read-only; fails closed; department-scoped on the row AND the series.
-- Never touches `verified`.
declare v_dept uuid := public.my_department_id(); v_series uuid;
begin
  if v_dept is null or not coalesce(public.is_canmanage(), false) then
    raise exception 'Only department leadership can see signed records.';
  end if;
  if p_document_id is not null then
    select d.series_id into v_series from public.documents d where d.id = p_document_id and d.department_id = v_dept;
    if v_series is null then raise exception 'That document isn''t in your department.'; end if;
  end if;
  return query
  select a.member_id, coalesce(m.name, a.signed_name), a.series_id, a.title, a.version, a.content_hash,
         a.ack_statement, a.signature_data, a.signed_name, a.signed_at
    from public.document_acknowledgments a
    join public.document_series s on s.series_id = a.series_id and s.department_id = v_dept
    left join public.members m on m.id = a.member_id
   where a.department_id = v_dept
     and (case when v_series is not null then a.series_id = v_series else s.requires_ack end)
   order by 4, 2, 5 desc, 10 desc;
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.dept_signed_records(uuid) FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.dept_signed_records(uuid) TO authenticated;

  -- post-conditions — any failure undoes the whole block
  IF has_function_privilege('anon', 'public.dept_signed_records(uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.dept_signed_records(uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: dept_signed_records grants are wrong (anon must not, authenticated must). Rolling back.';
  END IF;
  IF position('is_canmanage()' in pg_get_functiondef('public.dept_signed_records(uuid)'::regprocedure)) = 0
     OR position('a.department_id = v_dept' in pg_get_functiondef('public.dept_signed_records(uuid)'::regprocedure)) = 0
     OR position('s.department_id = v_dept' in pg_get_functiondef('public.dept_signed_records(uuid)'::regprocedure)) = 0
     OR position('d.department_id = v_dept' in pg_get_functiondef('public.dept_signed_records(uuid)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: dept_signed_records lost its leadership gate or a department check. Rolling back.';
  END IF;
  IF (SELECT provolatile FROM pg_proc WHERE oid = 'public.dept_signed_records(uuid)'::regprocedure) <> 's'
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.dept_signed_records(uuid)'::regprocedure) THEN
    RAISE EXCEPTION 'Post-condition failed: dept_signed_records must be STABLE SECURITY DEFINER. Rolling back.';
  END IF;
  IF pg_get_functiondef('public.dept_read_sign_compliance()'::regprocedure) IS DISTINCT FROM v_cmp_before
     OR pg_get_functiondef('public.acknowledge_document(uuid,integer,text,text)'::regprocedure) IS DISTINCT FROM v_ack_before THEN
    RAISE EXCEPTION 'Post-condition failed: the compliance RPC or acknowledge_document changed. Rolling back.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'document_acknowledgments_append_only' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'Post-condition failed: the append-only trigger is missing or disabled. Rolling back.';
  END IF;
  IF has_table_privilege('authenticated', 'public.document_acknowledgments', 'INSERT')
     OR has_table_privilege('authenticated', 'public.document_acknowledgments', 'UPDATE')
     OR has_table_privilege('authenticated', 'public.document_acknowledgments', 'DELETE')
     OR has_table_privilege('anon', 'public.document_acknowledgments', 'SELECT') THEN
    RAISE EXCEPTION 'Post-condition failed: a write grant (or anon read) on document_acknowledgments. Rolling back.';
  END IF;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy changed. Rolling back.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: fn true · anon_exec false · auth_exec true · secdef true · append_only true ·
-- total_policies 160 (unchanged)
SELECT to_regprocedure('public.dept_signed_records(uuid)') IS NOT NULL AS fn,
       has_function_privilege('anon', 'public.dept_signed_records(uuid)', 'EXECUTE') AS anon_exec,
       has_function_privilege('authenticated', 'public.dept_signed_records(uuid)', 'EXECUTE') AS auth_exec,
       (SELECT prosecdef FROM pg_proc WHERE oid = 'public.dept_signed_records(uuid)'::regprocedure) AS secdef,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'document_acknowledgments_append_only' AND tgenabled = 'O') AS append_only,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies;

-- ROLLBACK (only if needed, separately): DROP FUNCTION public.dept_signed_records(uuid); NOTIFY pgrst, 'reload schema';
-- Nothing else to undo — no table, policy, column or other function was touched.
