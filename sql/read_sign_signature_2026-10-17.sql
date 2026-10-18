-- =====================================================================
-- READ & SIGN — a DRAWN signature on every acknowledgment (matches equipment sign-out).
-- Record: Claude gate review PASS 2026-10-17 (recorded BEFORE apply).
-- APPLIED by hand 2026-10-17. State check: old_3arg false · new_4arg true · anon_exec false · cols 2 · append_only true ·
-- total_policies 160. RETEST on live: 57 passed, 0 failed, 2 skipped (IH, Lipan, North Hood 19/19 incl. SG1 + A2).
-- Test: sql/read_sign_RETEST.sql (updated: every sign passes a signature; SG1 blank / non-PNG refused; A2 checks the
-- stored signature + the roster-name snapshot).
--
-- WHAT CHANGES:
--   1. document_acknowledgments + signature_data text (the SignaturePad PNG data URL) + signed_name text (the signer's
--      roster name, snapshotted by the server). Both NULLABLE so the column add can't fail on existing rows; every row
--      written from now on carries both (the RPC requires the signature). The append-only UPDATE/DELETE trigger already
--      covers the new columns — a stored signature can never be altered or removed.
--   2. acknowledge_document(uuid, integer, text) is REPLACED by acknowledge_document(uuid, integer, text, text) —
--      + p_signature_data. The 3-arg version is DROPPED, not overloaded, so nothing can sign without a drawing. Safe now:
--      no shipped client calls it (the Read & Sign UI is unpromoted; the 3.0 native bundle predates it).
--      All existing validation is kept exactly: caller in the document's department, requires_ack + a published version,
--      audience (rs_member_in_audience), current version, fingerprint. New: signature required, must be a PNG data URL,
--      <= 1,000,000 chars. signed_name comes from members.name, never from the client. No witness (a member signing their
--      own read-receipt isn't self-issue custody).
--   DROP + CREATE re-opens EXECUTE to anon on Supabase — revoked explicitly and proved below.
-- UNCHANGED: every other function, table, policy and grant. Members still read only their own acknowledgments (the
--   receipt reads signature_data from their own row); Board/DA/Officer read the department's.
-- ONE STATEMENT. A single DO block — all-or-nothing. Re-running after success is refused by the guard.
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text;
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public'$q$;
BEGIN
  IF to_regclass('public.document_acknowledgments') IS NULL THEN RAISE EXCEPTION 'Precondition failed: apply read_sign first.'; END IF;
  IF to_regprocedure('public.acknowledge_document(uuid,integer,text)') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: the 3-arg acknowledge_document is gone — already migrated, or drifted. Nothing changed.';
  END IF;
  IF position('B4C:read_sign' in pg_get_functiondef('public.acknowledge_document(uuid,integer,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Precondition failed: acknowledge_document(uuid,integer,text) is not the B4C:read_sign version.';
  END IF;
  IF to_regprocedure('public.acknowledge_document(uuid,integer,text,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Precondition failed: a 4-arg acknowledge_document already exists.';
  END IF;
  EXECUTE pol_sql INTO v_pol_before;

  ALTER TABLE public.document_acknowledgments ADD COLUMN IF NOT EXISTS signature_data text;
  ALTER TABLE public.document_acknowledgments ADD COLUMN IF NOT EXISTS signed_name text;
  COMMENT ON COLUMN public.document_acknowledgments.signature_data IS 'B4C:read_sign — the drawn signature (PNG data URL). Append-only.';
  COMMENT ON COLUMN public.document_acknowledgments.signed_name IS 'B4C:read_sign — the signer''s roster name at signing (server snapshot).';

  DROP FUNCTION public.acknowledge_document(uuid, integer, text);
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.acknowledge_document(p_document_id uuid, p_version integer, p_content_hash text, p_signature_data text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:read_sign — the member signs the CURRENT version with a DRAWN signature, fingerprint-checked. Idempotent.
-- Snapshots the signer's roster name. Never touches `verified`.
declare d public.documents%rowtype; s public.document_series%rowtype; v public.document_versions%rowtype;
        v_me uuid := public.my_member_id(); v_stmt text; v_name text;
begin
  select * into d from public.documents where id = p_document_id;
  if not found or d.department_id is distinct from public.my_department_id() or v_me is null then
    raise exception 'That document isn''t in your department.';
  end if;
  select * into s from public.document_series where series_id = d.series_id;
  if not found or not s.requires_ack or s.current_version = 0 then raise exception 'This document doesn''t need a signature.'; end if;
  if not public.rs_member_in_audience(v_me, s.required_roles) then raise exception 'This document isn''t required for you.'; end if;
  if p_version is distinct from s.current_version then
    raise exception 'A newer version has been published — reopen it and sign the current one.';
  end if;
  select * into v from public.document_versions where series_id = s.series_id and version = s.current_version;
  if v.content_hash is distinct from p_content_hash then
    raise exception 'The document changed since you opened it — reopen it and sign again.';
  end if;
  -- the drawn signature: a PNG data URL from the app's SignaturePad, non-empty, bounded
  if coalesce(btrim(p_signature_data), '') = '' then raise exception 'Draw your signature to sign.'; end if;
  if left(p_signature_data, 22) <> 'data:image/png;base64,' or length(p_signature_data) < 60 then
    raise exception 'That signature didn''t come through — clear it and sign again.';
  end if;
  if length(p_signature_data) > 1000000 then raise exception 'That signature is too large — clear it and sign again.'; end if;
  select m.name into v_name from public.members m where m.id = v_me;   -- roster name snapshot (never client-supplied)
  v_stmt := format('I have read and understand %s (v%s) and agree to comply.', v.title, v.version);
  insert into public.document_acknowledgments (department_id, series_id, document_id, member_id, version, content_hash, title, ack_statement, signature_data, signed_name)
  values (d.department_id, s.series_id, v.document_id, v_me, v.version, v.content_hash, v.title, v_stmt, p_signature_data, v_name)
  on conflict (member_id, series_id, version) do nothing;
  return jsonb_build_object('series_id', s.series_id, 'version', v.version, 'status', 'current',
    'signed_at', (select signed_at from public.document_acknowledgments where member_id = v_me and series_id = s.series_id and version = v.version));
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.acknowledge_document(uuid, integer, text, text) FROM anon, public;
  GRANT  EXECUTE ON FUNCTION public.acknowledge_document(uuid, integer, text, text) TO authenticated;

  -- post-conditions
  IF to_regprocedure('public.acknowledge_document(uuid,integer,text)') IS NOT NULL THEN
    RAISE EXCEPTION 'Post-condition failed: the 3-arg acknowledge_document still exists. Rolling back.';
  END IF;
  IF has_function_privilege('anon', 'public.acknowledge_document(uuid,integer,text,text)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.acknowledge_document(uuid,integer,text,text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: acknowledge_document grants are wrong (anon must not, authenticated must). Rolling back.';
  END IF;
  IF position('rs_member_in_audience' in pg_get_functiondef('public.acknowledge_document(uuid,integer,text,text)'::regprocedure)) = 0
     OR position('p_content_hash' in pg_get_functiondef('public.acknowledge_document(uuid,integer,text,text)'::regprocedure)) = 0
     OR position('Draw your signature' in pg_get_functiondef('public.acknowledge_document(uuid,integer,text,text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'Post-condition failed: the new body lost a check (audience / fingerprint / signature). Rolling back.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'document_acknowledgments_append_only' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'Post-condition failed: the append-only trigger is missing or disabled. Rolling back.';
  END IF;
  IF has_table_privilege('authenticated', 'public.document_acknowledgments', 'INSERT')
     OR has_table_privilege('authenticated', 'public.document_acknowledgments', 'UPDATE') THEN
    RAISE EXCEPTION 'Post-condition failed: authenticated can write document_acknowledgments. Rolling back.';
  END IF;
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy changed. Rolling back.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: old_3arg false · new_4arg true · anon_exec false · cols 2 · append_only true · 160
SELECT to_regprocedure('public.acknowledge_document(uuid,integer,text)') IS NOT NULL AS old_3arg,
       to_regprocedure('public.acknowledge_document(uuid,integer,text,text)') IS NOT NULL AS new_4arg,
       has_function_privilege('anon', 'public.acknowledge_document(uuid,integer,text,text)', 'EXECUTE') AS anon_exec,
       (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'document_acknowledgments'
          AND column_name IN ('signature_data', 'signed_name')) AS cols,
       EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'document_acknowledgments_append_only' AND tgenabled = 'O') AS append_only,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public') AS total_policies;

-- ROLLBACK (only if needed, separately): DROP the 4-arg function, re-create the 3-arg body from read_sign_2026-10-17.sql
-- §5 (+ REVOKE anon/public, GRANT authenticated), and leave the two columns (signatures already stored stay on the trail).
