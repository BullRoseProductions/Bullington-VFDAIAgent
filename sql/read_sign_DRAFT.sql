-- =====================================================================
-- PHASE 3.1 #1 — READ & SIGN (document acknowledgment). DRAFT — for the reviewing Claude, then Ashlea applies.
-- Test script: sql/read_sign_RETEST.sql (run AFTER, separately). Run sql/read_sign_STEP0_CHECK.sql first.
--
-- WHAT IT STORES: an acknowledgment TRAIL ONLY — member · document series · version · content fingerprint · time ·
-- the attestation wording shown. No personal documents, nothing a member signs about themselves. Never reads or
-- writes `verified`.
--
-- DECISIONS (Ashlea, 2026-10-17, A–F):
--   A. SERIES IDENTITY. "Replace file" makes a NEW documents row (version-on-replace, supersedes/archived_at), so a
--      signature tied to documents.id would drift. Every document gets a stable documents.series_id (the root of its
--      supersedes chain); config, versions and signatures bind to the series. A replace INHERITS the series
--      (trigger below — replace_document itself is not edited). ONLY "Publish new version" bumps the required
--      version; replacing a file / fixing a typo never forces a re-sign.
--   B. FINGERPRINT FROM THE FILE: sha256(documents.id | storage_path | content_text) of the row live at publish. Every
--      upload is a new immutable storage path, and scans have no text, so text alone can't be the fingerprint. The
--      version row snapshots that row's id/name/storage_path: members read and sign exactly what was published.
--   C. WHO CONFIGURES / PUBLISHES: Department Admin + Officer (the documents table's own edit gate is
--      is_canmanage_ops()), and ALWAYS scoped to the document's department with an explicit members-row test —
--      never a role-anywhere helper alone (the 2026-10-13 cert-leak class). Leaders who may READ the department's
--      signatures: Board Member / Department Admin / Officer (is_canmanage's set), same explicit department scope.
--   D. AUDIENCE: required_roles matches members.access; empty/NULL = every member. The honest count includes only
--      members who are not Inactive, not former (member_separation), and not Project Admin accounts.
--   E. Publish-only re-sign · default wording "I have read and understand {title} (v{n}) and agree to comply." ·
--      annual re-sign computed at read (12 months after signing, America/Chicago) · no push nudge.
--
-- SHAPE NOTE vs the build order §2.3: the ack config is NOT columns on documents — it lives on a new
-- document_series row (series_id PK), because documents rows are replaced. documents gains only series_id.
--
-- WHAT CHANGES — ADDITIVE:
--   documents: + series_id uuid NOT NULL (backfilled to the chain root) + 2 triggers that keep it (insert / a
--     supersedes link). No documents policy, column or existing trigger changes.
--   NEW document_series (config + current_version + title snapshot) · document_versions (immutable) ·
--     document_acknowledgments (append-only: an UPDATE/DELETE trigger refuses every change, even for the owner).
--     RLS on all three. Reads: series + versions = the department; acknowledgments = your own rows, or the
--     department's for a Board/DA/Officer OF THAT DEPARTMENT. NO write grants or write policies anywhere —
--     every write is one of the RPCs below.
--   RPCs (SECURITY DEFINER; EXECUTE revoked from anon/public, granted to authenticated):
--     set_document_ack_config(p_document_id, p_requires, p_required_roles, p_annual)  — DA/Officer of the dept;
--         first time requires_ack goes on with no version -> publishes v1
--     publish_document_version(p_document_id)                                         — DA/Officer of the dept
--     acknowledge_document(p_document_id, p_version, p_content_hash)                 — a member in the audience;
--         validates current version + fingerprint; idempotent; server-built wording
--     my_read_sign_queue()           — the caller's required documents with their status (needs / re-sign / current)
--     dept_read_sign_compliance()    — DA/Officer/Board of the dept: per series, X of Y current + who's outstanding
--   The two reads exist because the honest audience needs member_separation (locked, RPC-only) and one shared rule.
--   Post-condition proves: every OTHER table's policies byte-identical; RLS on; no write privilege for
--   anon/authenticated on the three tables; anon can't execute any of the RPCs; the append-only trigger is enabled.
--
-- ONE STATEMENT. A single DO block — all-or-nothing in any SQL editor. Safe to re-run (idempotent).
-- =====================================================================
DO $migrate$
DECLARE
  v_pol_before text; v_pol_after text; v_n int; v_t text;
  OURS constant text[] := array['document_series', 'document_versions', 'document_acknowledgments'];
  pol_sql constant text := $q$
    SELECT coalesce(string_agg(format('%s|%s|%s|%s|%s|%s', tablename, policyname, cmd, roles::text, qual, with_check), E'\n' ORDER BY tablename, policyname, cmd), '')
      FROM pg_policies WHERE schemaname = 'public' AND tablename NOT IN ('document_series', 'document_versions', 'document_acknowledgments')$q$;
BEGIN
  -- 0. preconditions — the live shapes this is written against
  IF to_regprocedure('public.my_department_id()') IS NULL OR to_regprocedure('public.my_member_id()') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: my_department_id() / my_member_id() missing.';
  END IF;
  FOREACH v_t IN ARRAY array['id', 'department_id', 'name', 'storage_path', 'content_text', 'supersedes', 'archived_at', 'deleted_at'] LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'documents' AND column_name = v_t) THEN
      RAISE EXCEPTION 'Precondition failed: documents.% missing.', v_t;
    END IF;
  END LOOP;
  SELECT data_type INTO v_t FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'members' AND column_name = 'access';
  IF v_t IS DISTINCT FROM 'ARRAY' THEN RAISE EXCEPTION 'Precondition failed: members.access is %, expected text[].', coalesce(v_t, 'missing'); END IF;
  IF to_regclass('public.member_separation') IS NULL THEN
    RAISE EXCEPTION 'Precondition failed: member_separation missing (membership_window must be applied first).';
  END IF;
  FOREACH v_t IN ARRAY array['public.set_document_ack_config(uuid,boolean,text[],boolean)', 'public.publish_document_version(uuid)',
                             'public.acknowledge_document(uuid,integer,text)', 'public.my_read_sign_queue()', 'public.dept_read_sign_compliance()',
                             'public.rs_member_in_audience(uuid,text[])', 'public.rs_is_dept_role(uuid,text[])',
                             'public.tg_documents_series()', 'public.tg_document_acks_append_only()', 'public.rs_publish(uuid,uuid,uuid)'] LOOP
    IF to_regprocedure(v_t) IS NOT NULL THEN   -- nested: SQL AND doesn't short-circuit
      IF position('B4C:read_sign' in pg_get_functiondef(to_regprocedure(v_t))) = 0 THEN
        RAISE EXCEPTION 'Precondition failed: a different % exists — not overwriting it.', v_t;
      END IF;
    END IF;
  END LOOP;
  EXECUTE pol_sql INTO v_pol_before;

  -- 1. series identity on documents (A)
  ALTER TABLE public.documents ADD COLUMN IF NOT EXISTS series_id uuid;
  WITH RECURSIVE chain AS (
    SELECT id, id AS root FROM public.documents WHERE supersedes IS NULL
    UNION ALL
    SELECT d.id, c.root FROM public.documents d JOIN chain c ON d.supersedes = c.id
  )
  UPDATE public.documents d SET series_id = c.root FROM chain c WHERE c.id = d.id AND d.series_id IS NULL;
  UPDATE public.documents SET series_id = id WHERE series_id IS NULL;   -- anything outside a clean chain: its own series
  ALTER TABLE public.documents ALTER COLUMN series_id SET NOT NULL;
  CREATE INDEX IF NOT EXISTS documents_series_id_idx ON public.documents (series_id);

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.tg_documents_series()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:read_sign — keep documents.series_id: a new upload starts its own series; a row that supersedes another
-- (replace_document) joins that row's series, so a replaced file keeps its signature trail.
begin
  if NEW.supersedes is not null and (TG_OP = 'INSERT' or NEW.supersedes is distinct from OLD.supersedes) then
    select d.series_id into NEW.series_id from public.documents d where d.id = NEW.supersedes;
  end if;
  if NEW.series_id is null then NEW.series_id := NEW.id; end if;
  return NEW;
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.tg_documents_series() FROM anon, authenticated, public;
  DROP TRIGGER IF EXISTS documents_series ON public.documents;
  CREATE TRIGGER documents_series BEFORE INSERT OR UPDATE OF supersedes ON public.documents
    FOR EACH ROW EXECUTE FUNCTION public.tg_documents_series();

  -- 2. the three tables
  CREATE TABLE IF NOT EXISTS public.document_series (
    series_id        uuid PRIMARY KEY,
    department_id    uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    requires_ack     boolean NOT NULL DEFAULT false,
    required_roles   text[],                                    -- NULL/empty = every member (see the audience rule)
    annual_resign    boolean NOT NULL DEFAULT false,
    current_version  integer NOT NULL DEFAULT 0 CHECK (current_version >= 0),
    title            text,                                      -- snapshot, refreshed on config/publish
    updated_at       timestamptz NOT NULL DEFAULT now()
  );
  CREATE TABLE IF NOT EXISTS public.document_versions (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id  uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    series_id      uuid NOT NULL REFERENCES public.document_series(series_id) ON DELETE CASCADE,
    version        integer NOT NULL CHECK (version >= 1),
    document_id    uuid NOT NULL,                               -- the documents row published (no FK: the trail outlives a hard delete)
    title          text NOT NULL,                               -- snapshots: renames/deletes never corrupt the trail
    storage_path   text,
    content_hash   text NOT NULL,
    effective_on   date NOT NULL,                               -- America/Chicago
    published_by   uuid,                                        -- members.id
    published_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (series_id, version)
  );
  CREATE TABLE IF NOT EXISTS public.document_acknowledgments (
    id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    department_id  uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    series_id      uuid NOT NULL REFERENCES public.document_series(series_id) ON DELETE CASCADE,
    document_id    uuid NOT NULL,                               -- the published row that was read
    member_id      uuid NOT NULL,
    version        integer NOT NULL,
    content_hash   text NOT NULL,
    title          text NOT NULL,
    ack_statement  text NOT NULL,                               -- the exact wording attested
    method         text NOT NULL DEFAULT 'in_app',
    signed_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (member_id, series_id, version)
  );
  CREATE INDEX IF NOT EXISTS document_acknowledgments_series_idx ON public.document_acknowledgments (series_id, version);
  COMMENT ON TABLE public.document_series IS 'B4C:read_sign — acknowledgment config per document series. Writes: set_document_ack_config / publish_document_version only.';
  COMMENT ON TABLE public.document_versions IS 'B4C:read_sign — immutable published versions (what a signature binds to).';
  COMMENT ON TABLE public.document_acknowledgments IS 'B4C:read_sign — APPEND-ONLY signature trail. Writes: acknowledge_document only; UPDATE/DELETE refused by trigger.';

  FOREACH v_t IN ARRAY OURS LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_t);
    EXECUTE format('REVOKE ALL ON public.%I FROM anon, authenticated, public', v_t);
    EXECUTE format('GRANT SELECT ON public.%I TO authenticated', v_t);
  END LOOP;

  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.tg_document_acks_append_only()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
-- B4C:read_sign — the signature trail is append-only: no update, no delete, for anyone.
begin
  raise exception 'Signatures are permanent: document_acknowledgments is append-only.';
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.tg_document_acks_append_only() FROM anon, authenticated, public;
  DROP TRIGGER IF EXISTS document_acknowledgments_append_only ON public.document_acknowledgments;
  CREATE TRIGGER document_acknowledgments_append_only BEFORE UPDATE OR DELETE ON public.document_acknowledgments
    FOR EACH ROW EXECUTE FUNCTION public.tg_document_acks_append_only();

  -- 3. helpers (internal; not callable by members)
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.rs_is_dept_role(p_department uuid, p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- B4C:read_sign — the caller holds one of p_roles IN THIS DEPARTMENT (never role-anywhere).
  select p_department is not null and p_department = public.my_department_id() and exists (
    select 1 from public.members me
     where lower(me.email) = lower(auth.email()) and me.department_id = p_department and me.access && p_roles);
$function$
$ddl$;
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.rs_member_in_audience(p_member uuid, p_roles text[])
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- B4C:read_sign — the honest audience: not Inactive, not a former member, not a Project Admin account, and (when
  -- the document names roles) holding one of them.
  select exists (
    select 1 from public.members m
     where m.id = p_member
       and m.status is distinct from 'Inactive'
       and not coalesce(m.access && array['Project Admin']::text[], false)
       and not exists (select 1 from public.member_separation s where s.member_id = m.id)
       and (p_roles is null or cardinality(p_roles) = 0 or m.access && p_roles));
$function$
$ddl$;
  -- publish: the shared body of set_document_ack_config's auto-v1 and publish_document_version
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.rs_publish(p_series uuid, p_department uuid, p_member uuid)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:read_sign — cut the next version from the series' LIVE row (newest non-deleted, non-archived).
declare d public.documents%rowtype; v_next int;
begin
  select * into d from public.documents
   where series_id = p_series and department_id = p_department and deleted_at is null and archived_at is null
   order by created_at desc limit 1;
  if not found then raise exception 'This document has no live file to publish.'; end if;
  update public.document_series set current_version = current_version + 1, title = d.name, updated_at = now()
   where series_id = p_series returning current_version into v_next;
  insert into public.document_versions (department_id, series_id, version, document_id, title, storage_path, content_hash, effective_on, published_by)
  values (p_department, p_series, v_next, d.id, d.name, d.storage_path,
          encode(sha256(convert_to(d.id::text || '|' || coalesce(d.storage_path, '') || '|' || coalesce(d.content_text, ''), 'UTF8')), 'hex'),
          (now() at time zone 'America/Chicago')::date, p_member);
  return v_next;
end;
$function$
$ddl$;
  REVOKE EXECUTE ON FUNCTION public.rs_is_dept_role(uuid, text[])        FROM anon, public;
  -- authenticated KEEPS execute on rs_is_dept_role: the acknowledgments read policy calls it AS THE MEMBER. It only
  -- answers "does the caller hold one of these roles in their own department" — nothing another member could use.
  GRANT  EXECUTE ON FUNCTION public.rs_is_dept_role(uuid, text[])        TO authenticated;
  REVOKE EXECUTE ON FUNCTION public.rs_member_in_audience(uuid, text[])  FROM anon, authenticated, public;
  REVOKE EXECUTE ON FUNCTION public.rs_publish(uuid, uuid, uuid)          FROM anon, authenticated, public;

  -- 4. read policies (no write policies at all)
  DROP POLICY IF EXISTS document_series_read ON public.document_series;
  CREATE POLICY document_series_read ON public.document_series FOR SELECT TO authenticated
    USING (department_id = public.my_department_id());
  DROP POLICY IF EXISTS document_versions_read ON public.document_versions;
  CREATE POLICY document_versions_read ON public.document_versions FOR SELECT TO authenticated
    USING (department_id = public.my_department_id());
  DROP POLICY IF EXISTS document_acknowledgments_read ON public.document_acknowledgments;
  CREATE POLICY document_acknowledgments_read ON public.document_acknowledgments FOR SELECT TO authenticated
    USING (department_id = public.my_department_id()
           AND (member_id = public.my_member_id()
                OR public.rs_is_dept_role(department_id, array['Board Member','Department Admin','Officer']::text[])));

  -- 5. RPCs
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.set_document_ack_config(p_document_id uuid, p_requires boolean, p_required_roles text[], p_annual boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:read_sign — Department Admin / Officer of the document's department.
declare d public.documents%rowtype; v_me uuid := public.my_member_id(); v_roles text[]; v_bad text; v_ver int;
begin
  select * into d from public.documents where id = p_document_id;
  if not found or not public.rs_is_dept_role(d.department_id, array['Department Admin','Officer']::text[]) then
    raise exception 'Only a Department Admin or Officer of this department can change this.';
  end if;
  v_roles := case when p_required_roles is null or cardinality(p_required_roles) = 0 then null else p_required_roles end;
  select r into v_bad from unnest(coalesce(v_roles, '{}')) r
   where r not in ('Member', 'Officer', 'Board Member', 'Department Admin') limit 1;
  if v_bad is not null then raise exception 'Unknown role: %', v_bad; end if;
  insert into public.document_series (series_id, department_id, requires_ack, required_roles, annual_resign, title)
  values (d.series_id, d.department_id, coalesce(p_requires, false), v_roles, coalesce(p_annual, false), d.name)
  on conflict (series_id) do update set requires_ack = excluded.requires_ack, required_roles = excluded.required_roles,
                                        annual_resign = excluded.annual_resign, updated_at = now();
  select current_version into v_ver from public.document_series where series_id = d.series_id;
  if coalesce(p_requires, false) and v_ver = 0 then
    v_ver := public.rs_publish(d.series_id, d.department_id, v_me);   -- first time on: there must be a version to sign
  end if;
  return jsonb_build_object('series_id', d.series_id, 'requires_ack', coalesce(p_requires, false), 'current_version', v_ver);
end;
$function$
$ddl$;
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.publish_document_version(p_document_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:read_sign — the deliberate "everyone re-signs" action. Department Admin / Officer of the department.
declare d public.documents%rowtype; s public.document_series%rowtype; v_ver int;
begin
  select * into d from public.documents where id = p_document_id;
  if not found or not public.rs_is_dept_role(d.department_id, array['Department Admin','Officer']::text[]) then
    raise exception 'Only a Department Admin or Officer of this department can publish.';
  end if;
  select * into s from public.document_series where series_id = d.series_id for update;
  if not found or not s.requires_ack then raise exception 'Turn on "requires acknowledgment" before publishing a version.'; end if;
  v_ver := public.rs_publish(d.series_id, d.department_id, public.my_member_id());
  return jsonb_build_object('series_id', d.series_id, 'current_version', v_ver);
end;
$function$
$ddl$;
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.acknowledge_document(p_document_id uuid, p_version integer, p_content_hash text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:read_sign — the member signs the CURRENT version, fingerprint-checked. Idempotent. Never touches `verified`.
declare d public.documents%rowtype; s public.document_series%rowtype; v public.document_versions%rowtype;
        v_me uuid := public.my_member_id(); v_stmt text;
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
  v_stmt := format('I have read and understand %s (v%s) and agree to comply.', v.title, v.version);
  insert into public.document_acknowledgments (department_id, series_id, document_id, member_id, version, content_hash, title, ack_statement)
  values (d.department_id, s.series_id, v.document_id, v_me, v.version, v.content_hash, v.title, v_stmt)
  on conflict (member_id, series_id, version) do nothing;
  return jsonb_build_object('series_id', s.series_id, 'version', v.version, 'status', 'current',
    'signed_at', (select signed_at from public.document_acknowledgments where member_id = v_me and series_id = s.series_id and version = v.version));
end;
$function$
$ddl$;
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.my_read_sign_queue()
 RETURNS TABLE(series_id uuid, document_id uuid, title text, version integer, content_hash text, storage_path text,
               effective_on date, annual_resign boolean, required_roles text[], status text,
               signed_version integer, signed_at timestamptz, resign_due date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  -- B4C:read_sign — the caller's required documents. status: needs | resign (newer version, or annual lapse) | current.
  with me as (select public.my_member_id() as id, public.my_department_id() as dept),
  req as (
    select s.*, v.document_id, v.title as vtitle, v.content_hash, v.storage_path, v.effective_on
      from public.document_series s
      join public.document_versions v on v.series_id = s.series_id and v.version = s.current_version
      join me on s.department_id = me.dept
     where s.requires_ack and s.current_version > 0 and public.rs_member_in_audience(me.id, s.required_roles)
  ),
  last as (
    select distinct on (a.series_id) a.series_id, a.version, a.signed_at
      from public.document_acknowledgments a join me on a.member_id = me.id
     order by a.series_id, a.version desc, a.signed_at desc
  )
  select r.series_id, r.document_id, r.vtitle, r.current_version, r.content_hash, r.storage_path, r.effective_on,
         r.annual_resign, r.required_roles,
         case when l.version is null then 'needs'
              when l.version < r.current_version then 'resign'
              when r.annual_resign and (l.signed_at at time zone 'America/Chicago')::date + interval '12 months'
                                        <= (now() at time zone 'America/Chicago')::date then 'resign'
              else 'current' end,
         l.version, l.signed_at,
         case when r.annual_resign and l.signed_at is not null
              then ((l.signed_at at time zone 'America/Chicago')::date + interval '12 months')::date end
    from req r left join last l on l.series_id = r.series_id
   order by r.vtitle;   -- the client groups needs / resign / current
$function$
$ddl$;
  EXECUTE $ddl$
CREATE OR REPLACE FUNCTION public.dept_read_sign_compliance()
 RETURNS TABLE(series_id uuid, title text, version integer, required_roles text[], annual_resign boolean,
               audience integer, current_count integer, outstanding jsonb)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
-- B4C:read_sign — Board / DA / Officer of the department: per required series, how many of the honest audience are
-- current, and who is outstanding. audience 0 = "not applicable" (the client never shows that as 100%).
declare v_dept uuid := public.my_department_id();
begin
  if not public.rs_is_dept_role(v_dept, array['Board Member','Department Admin','Officer']::text[]) then
    raise exception 'Only department leadership can see compliance.';
  end if;
  return query
  with req as (
    select s.* from public.document_series s where s.department_id = v_dept and s.requires_ack and s.current_version > 0
  ),
  aud as (
    select r.series_id, m.id as member_id, m.name
      from req r join public.members m on m.department_id = v_dept
     where public.rs_member_in_audience(m.id, r.required_roles)
  ),
  st as (
    select a.series_id, a.member_id, a.name,
           exists (select 1 from public.document_acknowledgments k join req r on r.series_id = k.series_id
                    where k.series_id = a.series_id and k.member_id = a.member_id and k.version = r.current_version
                      and (not r.annual_resign or (k.signed_at at time zone 'America/Chicago')::date + interval '12 months'
                                                   > (now() at time zone 'America/Chicago')::date)) as is_current
      from aud a
  )
  select r.series_id, r.title, r.current_version, r.required_roles, r.annual_resign,
         (select count(*) from st where st.series_id = r.series_id)::int,
         (select count(*) from st where st.series_id = r.series_id and st.is_current)::int,
         coalesce((select jsonb_agg(jsonb_build_object('member_id', st.member_id, 'name', st.name) order by st.name)
                     from st where st.series_id = r.series_id and not st.is_current), '[]'::jsonb)
    from req r order by r.title;
end;
$function$
$ddl$;
  FOREACH v_t IN ARRAY array['public.set_document_ack_config(uuid,boolean,text[],boolean)', 'public.publish_document_version(uuid)',
                             'public.acknowledge_document(uuid,integer,text)', 'public.my_read_sign_queue()', 'public.dept_read_sign_compliance()'] LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM anon, public', v_t);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', v_t);
  END LOOP;

  -- 6. post-conditions — any failure undoes the whole block
  FOREACH v_t IN ARRAY OURS LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = ('public.' || v_t)::regclass) THEN
      RAISE EXCEPTION 'Post-condition failed: RLS off on %.', v_t;
    END IF;
    IF has_table_privilege('authenticated', 'public.' || v_t, 'INSERT') OR has_table_privilege('authenticated', 'public.' || v_t, 'UPDATE')
       OR has_table_privilege('authenticated', 'public.' || v_t, 'DELETE') OR has_table_privilege('anon', 'public.' || v_t, 'SELECT') THEN
      RAISE EXCEPTION 'Post-condition failed: % has a write privilege for authenticated, or anon can read it.', v_t;
    END IF;
    SELECT count(*) INTO v_n FROM pg_policies WHERE schemaname = 'public' AND tablename = v_t AND cmd <> 'SELECT';
    IF v_n <> 0 THEN RAISE EXCEPTION 'Post-condition failed: % has % write policies (expected none).', v_t, v_n; END IF;
  END LOOP;
  FOREACH v_t IN ARRAY array['public.set_document_ack_config(uuid,boolean,text[],boolean)', 'public.publish_document_version(uuid)',
                             'public.acknowledge_document(uuid,integer,text)', 'public.my_read_sign_queue()', 'public.dept_read_sign_compliance()'] LOOP
    IF has_function_privilege('anon', v_t, 'EXECUTE') THEN RAISE EXCEPTION 'Post-condition failed: anon can execute %.', v_t; END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public.rs_publish(uuid,uuid,uuid)', 'EXECUTE')
     OR has_function_privilege('authenticated', 'public.rs_member_in_audience(uuid,text[])', 'EXECUTE')
     OR has_function_privilege('anon', 'public.rs_is_dept_role(uuid,text[])', 'EXECUTE') THEN
    RAISE EXCEPTION 'Post-condition failed: an internal helper is callable by members (rs_publish / rs_member_in_audience) or anon.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'document_acknowledgments_append_only' AND tgenabled = 'O')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'documents_series' AND tgenabled = 'O') THEN
    RAISE EXCEPTION 'Post-condition failed: a read_sign trigger is missing or disabled.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.documents WHERE series_id IS NULL) THEN
    RAISE EXCEPTION 'Post-condition failed: a document has no series.';
  END IF;
  -- EVERY OTHER TABLE'S POLICIES UNCHANGED (documents' own policies included), character for character
  EXECUTE pol_sql INTO v_pol_after;
  IF v_pol_after IS DISTINCT FROM v_pol_before THEN RAISE EXCEPTION 'Post-condition failed: a policy on another table changed.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- state check (read-only) — expect: docs_without_series 0 · rls true ×3 · write_policies 0 · auth_insert false ·
-- anon_rpc false · triggers 2 · other_policies = what you had before (157)
SELECT (SELECT count(*) FROM public.documents WHERE series_id IS NULL) AS docs_without_series,
       (SELECT count(DISTINCT series_id) FROM public.documents) AS series,
       (SELECT bool_and(relrowsecurity) FROM pg_class WHERE oid IN ('public.document_series'::regclass, 'public.document_versions'::regclass, 'public.document_acknowledgments'::regclass)) AS rls_on,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('document_series', 'document_versions', 'document_acknowledgments') AND cmd <> 'SELECT') AS write_policies,
       has_table_privilege('authenticated', 'public.document_acknowledgments', 'INSERT') AS auth_insert,
       has_function_privilege('anon', 'public.acknowledge_document(uuid,integer,text)', 'EXECUTE') AS anon_rpc,
       (SELECT count(*) FROM pg_trigger WHERE tgname IN ('documents_series', 'document_acknowledgments_append_only')) AS triggers,
       (SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename NOT IN ('document_series', 'document_versions', 'document_acknowledgments')) AS other_policies;

-- =====================================================================
-- ROLLBACK (only if needed, separately). DESTROYS the signature trail — export it first if anything was signed.
-- =====================================================================
-- DO $rb$
-- BEGIN
--   DROP FUNCTION IF EXISTS public.dept_read_sign_compliance(), public.my_read_sign_queue(),
--     public.acknowledge_document(uuid,integer,text), public.publish_document_version(uuid),
--     public.set_document_ack_config(uuid,boolean,text[],boolean), public.rs_publish(uuid,uuid,uuid),
--     public.rs_member_in_audience(uuid,text[]), public.rs_is_dept_role(uuid,text[]);
--   DROP TABLE IF EXISTS public.document_acknowledgments, public.document_versions, public.document_series;
--   DROP TRIGGER IF EXISTS documents_series ON public.documents;
--   DROP FUNCTION IF EXISTS public.tg_documents_series(), public.tg_document_acks_append_only();
--   ALTER TABLE public.documents DROP COLUMN IF EXISTS series_id;
-- END
-- $rb$;
-- NOTIFY pgrst, 'reload schema';
