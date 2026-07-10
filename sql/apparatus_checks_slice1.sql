-- =====================================================================
-- APPARATUS TRUCK CHECK - Slice 1 (schema, RPC, RLS)
-- Readiness only: no call/dispatch/incident data.
--
-- Gates:
--   perform a check    = any ACTIVE dept member (RPC-enforced, server-stamped)
--   read history       = all dept members (department_id = my_department_id())
--   correct a check    = is_canmanage()      (Board / Dept Admin / Officer)
--   manage templates   = is_canmanage_ops()  (Dept Admin / Officer)
--   manage photos      = is_canmanage_ops()  (Dept Admin / Officer)
--
-- PRE-FLIGHT: confirm these live functions exist first (should return 5 rows):
--   select proname from pg_proc
--   where proname in ('my_member_id','my_department_id','is_canmanage','is_canmanage_ops','is_leader');
-- =====================================================================

-- ---------- 1. Checklist template (per apparatus) --------------------
CREATE TABLE IF NOT EXISTS public.apparatus_check_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id  uuid NOT NULL,
  apparatus_id   uuid NOT NULL REFERENCES public.apparatus(id) ON DELETE CASCADE,
  label          text NOT NULL,
  category       text,
  sort_order     int  NOT NULL DEFAULT 0,
  active         boolean NOT NULL DEFAULT true,      -- retire without breaking history
  -- Phase 2 (tappable markers) - nullable now so no ALTER later:
  photo_id       uuid,                               -- points to apparatus_photos(id)
  marker_x       real,                               -- normalized 0 to 1 position on the photo
  marker_y       real,                               -- normalized 0 to 1 position on the photo
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apparatus_check_items_apparatus_idx
  ON public.apparatus_check_items (apparatus_id, sort_order);

-- ---------- 2. A completed check (run header = history record) -------
CREATE TABLE IF NOT EXISTS public.apparatus_checks (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id      uuid NOT NULL,
  apparatus_id       uuid REFERENCES public.apparatus(id) ON DELETE SET NULL,
  apparatus_name     text NOT NULL,                  -- SNAPSHOT (survives rename/delete)
  performed_by       uuid,                           -- members(id)
  performed_by_name  text NOT NULL,                  -- SNAPSHOT (hard requirement)
  performed_at       timestamptz NOT NULL DEFAULT now(),   -- server-stamped
  status             text NOT NULL CHECK (status IN ('pass','fail')),
  pass_count         int  NOT NULL DEFAULT 0,
  fail_count         int  NOT NULL DEFAULT 0,
  general_note       text,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apparatus_checks_apparatus_idx
  ON public.apparatus_checks (apparatus_id, performed_at DESC);
CREATE INDEX IF NOT EXISTS apparatus_checks_dept_idx
  ON public.apparatus_checks (department_id, performed_at DESC);

-- ---------- 3. Per-item pass/fail + note (run line items) ------------
CREATE TABLE IF NOT EXISTS public.apparatus_check_results (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id  uuid NOT NULL,
  check_id       uuid NOT NULL REFERENCES public.apparatus_checks(id) ON DELETE CASCADE,
  item_id        uuid REFERENCES public.apparatus_check_items(id) ON DELETE SET NULL,
  item_label     text NOT NULL,                      -- SNAPSHOT of what was checked
  result         text NOT NULL CHECK (result IN ('pass','fail')),
  note           text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  -- FAIL REQUIRES A NOTE - enforced at the DB level:
  CONSTRAINT apparatus_check_results_fail_requires_note
    CHECK (result <> 'fail' OR (note IS NOT NULL AND btrim(note) <> ''))
);
CREATE INDEX IF NOT EXISTS apparatus_check_results_check_idx
  ON public.apparatus_check_results (check_id);

-- ---------- 4. Truck photos (Phase 2, modeled now) ------------------
CREATE TABLE IF NOT EXISTS public.apparatus_photos (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id  uuid NOT NULL,
  apparatus_id   uuid NOT NULL REFERENCES public.apparatus(id) ON DELETE CASCADE,
  storage_path   text,                               -- station-documents bucket
  angle_label    text,                               -- "Driver side", "Pump panel", "Rear"
  sort_order     int NOT NULL DEFAULT 0,
  uploaded_by    uuid,
  deleted_at     timestamptz,                        -- soft-delete (mirrors documents)
  deleted_by     uuid,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS apparatus_photos_apparatus_idx
  ON public.apparatus_photos (apparatus_id, sort_order);

-- =====================================================================
-- RPC: perform_apparatus_check
--   Any ACTIVE member; server-stamps name/date/time; validates
--   fail-requires-note; writes header + results atomically; updates the
--   apparatus latest-status pointer. Returns the new check id.
-- p_results: jsonb array of
--   { "item_id": uuid|null, "item_label": text, "result": "pass"|"fail", "note": text|null }
-- =====================================================================
CREATE OR REPLACE FUNCTION public.perform_apparatus_check(
  p_apparatus_id uuid,
  p_general_note text DEFAULT NULL,
  p_results      jsonb DEFAULT '[]'::jsonb
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
declare
  v_member    public.members;
  v_app       public.apparatus;
  v_check_id  uuid;
  v_pass      int := 0;
  v_fail      int := 0;
  v_status    text;
  r           jsonb;
  v_result    text;
  v_note      text;
begin
  -- 1. identity: a real member for the signed-in user
  select * into v_member from public.members where id = public.my_member_id();
  if v_member.id is null then
    raise exception 'No member record for the signed-in user';
  end if;
  -- "active member" = not inactive (Active + Probationary allowed)
  if v_member.status = 'Inactive' then
    raise exception 'Inactive members cannot perform apparatus checks';
  end if;

  -- 2. apparatus must exist and belong to the caller's department
  select * into v_app from public.apparatus where id = p_apparatus_id;
  if v_app.id is null then
    raise exception 'Apparatus not found';
  end if;
  if v_app.department_id <> v_member.department_id then
    raise exception 'Not authorized: apparatus belongs to another department';
  end if;

  -- 3. must have at least one result
  if p_results is null or jsonb_typeof(p_results) <> 'array'
     or jsonb_array_length(p_results) = 0 then
    raise exception 'A check must include at least one item result';
  end if;

  -- 4. validate + tally (fail requires a note)
  for r in select * from jsonb_array_elements(p_results) loop
    v_result := r->>'result';
    v_note   := r->>'note';
    if v_result not in ('pass','fail') then
      raise exception 'Invalid result "%": must be pass or fail', v_result;
    end if;
    if v_result = 'fail' then
      if v_note is null or btrim(v_note) = '' then
        raise exception 'A failed item requires a note (item: %)', coalesce(r->>'item_label','?');
      end if;
      v_fail := v_fail + 1;
    else
      v_pass := v_pass + 1;
    end if;
  end loop;

  v_status := case when v_fail > 0 then 'fail' else 'pass' end;

  -- 5. header (server-stamped identity + time + snapshots)
  insert into public.apparatus_checks
    (department_id, apparatus_id, apparatus_name, performed_by, performed_by_name,
     performed_at, status, pass_count, fail_count, general_note)
  values
    (v_member.department_id, v_app.id, v_app.name, v_member.id, v_member.name,
     now(), v_status, v_pass, v_fail, nullif(btrim(coalesce(p_general_note,'')), ''))
  returning id into v_check_id;

  -- 6. line items
  insert into public.apparatus_check_results
    (department_id, check_id, item_id, item_label, result, note)
  select
    v_member.department_id,
    v_check_id,
    nullif(e->>'item_id','')::uuid,
    e->>'item_label',
    e->>'result',
    nullif(btrim(coalesce(e->>'note','')), '')
  from jsonb_array_elements(p_results) as e;

  -- 7. latest-status pointer on the apparatus row (list-view convenience)
  update public.apparatus
     set last_check_at = now(),
         status        = case when v_status = 'fail' then 'Needs attention' else 'Pass' end,
         checked_by    = v_member.id
   where id = v_app.id;

  return v_check_id;
end;
$function$;

REVOKE ALL ON FUNCTION public.perform_apparatus_check(uuid, text, jsonb) FROM public;
GRANT EXECUTE ON FUNCTION public.perform_apparatus_check(uuid, text, jsonb) TO authenticated;

-- =====================================================================
-- RLS
-- =====================================================================
ALTER TABLE public.apparatus_check_items   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apparatus_checks        ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apparatus_check_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.apparatus_photos        ENABLE ROW LEVEL SECURITY;

-- --- Template items: all members READ; ops (DA/Officer) MANAGE --------
DROP POLICY IF EXISTS "members read check items" ON public.apparatus_check_items;
CREATE POLICY "members read check items" ON public.apparatus_check_items
  FOR SELECT TO authenticated
  USING (department_id = my_department_id());

DROP POLICY IF EXISTS "ops manage check items" ON public.apparatus_check_items;
CREATE POLICY "ops manage check items" ON public.apparatus_check_items
  FOR ALL TO authenticated
  USING (is_canmanage_ops() AND department_id = my_department_id())
  WITH CHECK (is_canmanage_ops() AND department_id = my_department_id());

-- --- Checks (history header): all members READ; leadership CORRECT ----
-- No INSERT policy on purpose - writes go ONLY through the SECURITY
-- DEFINER RPC, which guarantees server-stamped name/date/time.
DROP POLICY IF EXISTS "members read checks" ON public.apparatus_checks;
CREATE POLICY "members read checks" ON public.apparatus_checks
  FOR SELECT TO authenticated
  USING (department_id = my_department_id());

DROP POLICY IF EXISTS "leadership correct checks" ON public.apparatus_checks;
CREATE POLICY "leadership correct checks" ON public.apparatus_checks
  FOR UPDATE TO authenticated
  USING (is_canmanage() AND department_id = my_department_id())
  WITH CHECK (is_canmanage() AND department_id = my_department_id());

-- --- Results (history line items): same as header --------------------
DROP POLICY IF EXISTS "members read results" ON public.apparatus_check_results;
CREATE POLICY "members read results" ON public.apparatus_check_results
  FOR SELECT TO authenticated
  USING (department_id = my_department_id());

DROP POLICY IF EXISTS "leadership correct results" ON public.apparatus_check_results;
CREATE POLICY "leadership correct results" ON public.apparatus_check_results
  FOR UPDATE TO authenticated
  USING (is_canmanage() AND department_id = my_department_id())
  WITH CHECK (is_canmanage() AND department_id = my_department_id());

-- --- Photos: all members READ; ops MANAGE ---------------------------
DROP POLICY IF EXISTS "members read photos" ON public.apparatus_photos;
CREATE POLICY "members read photos" ON public.apparatus_photos
  FOR SELECT TO authenticated
  USING (department_id = my_department_id());

DROP POLICY IF EXISTS "ops manage photos" ON public.apparatus_photos;
CREATE POLICY "ops manage photos" ON public.apparatus_photos
  FOR ALL TO authenticated
  USING (is_canmanage_ops() AND department_id = my_department_id())
  WITH CHECK (is_canmanage_ops() AND department_id = my_department_id());

-- =====================================================================
-- POST-RUN VERIFICATION (optional - run separately, not part of migration)
-- =====================================================================
-- -- 1. RLS enabled on all four:
-- select relname, relrowsecurity from pg_class
-- where relname in ('apparatus_check_items','apparatus_checks','apparatus_check_results','apparatus_photos');
--
-- -- 2. Policies present:
-- select tablename, policyname, cmd from pg_policies
-- where tablename like 'apparatus_check%' or tablename = 'apparatus_photos'
-- order by tablename, cmd;
--
-- -- 3. RPC exists + is SECURITY DEFINER (prosecdef = true):
-- select proname, prosecdef from pg_proc where proname = 'perform_apparatus_check';
--
-- -- 4. FAIL-requires-note constraint bites (this INSERT should ERROR):
-- --    run inside a transaction you roll back
-- -- begin;
-- -- insert into public.apparatus_check_results(department_id, check_id, item_label, result, note)
-- -- values (gen_random_uuid(), gen_random_uuid(), 'test', 'fail', '');   -- expect: violates check constraint
-- -- rollback;
