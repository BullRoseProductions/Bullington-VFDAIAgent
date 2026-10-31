// node docs/review/e1e3_sliceR_build.mjs           — write the files
// node docs/review/e1e3_sliceR_build.mjs --check   — regenerate in memory; exit 1 unless every file on disk is byte-identical
// E1/E3 SLICE R (training reactions, DB). GENERATED from the live captures (2026-10-31, read-only, AFTER Slice T was applied):
//   docs/review/e1e3_sliceR_LIVE_fns.json   (sql/e1e3_sliceR_CAPTURE_A_fns.sql)  — the function definitions + md5 + ACL
//   docs/review/e1e3_sliceR_LIVE_meta.json  (sql/e1e3_sliceR_CAPTURE_B_meta.sql) — triggers, constraints, columns, policies, grants, counts, ledger
// Writes:
//   sql/e1e3_sliceR_session_reactions_DRAFT.sql · _RETEST.sql · _ROLLBACK.sql · docs/review/e1e3_sliceR_CHANGE_LIST.md
// Rulings (Step 0 design/e1e3-step0 @ 813ed0e + review record; the Slice R directive): one ±1 row per (session, member); members
// read only their own row; NO write policy — writes only through set_session_reaction (own department, finalized + not
// cancelled, on the roll, re-vote updates, closed more than 14 days after the session's date); leadership sees COUNTS ONLY via
// session_reaction_tally (is_leader(), own department, only voters still on the roll, nothing until ≥ 3 counted votes).
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
const root = fileURLToPath(new URL("../../", import.meta.url));
const F = JSON.parse(readFileSync(join(root, "docs/review/e1e3_sliceR_LIVE_fns.json"), "utf8"));
const M = JSON.parse(readFileSync(join(root, "docs/review/e1e3_sliceR_LIVE_meta.json"), "utf8"));
const out = {};
const q = (s) => s.replace(/'/g, "''");
const must = (c, why) => { if (!c) throw new Error(`capture drifted from what Slice R was designed on: ${why}`); };
const fn = (name) => { const e = Object.entries(F).find(([k]) => k.startsWith(name + "(")); must(e, `${name} missing`); return { sig: e[0], ...e[1] }; };
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const byC = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);   // code-point order = ORDER BY … COLLATE "C"

// ---------------------------------------------------------------- the capture must still say what the design rests on
const GRD = fn("tg_training_session_lock_guard"), COR = fn("correct_training_session"), ATT = fn("attested_training"), ISO = fn("dept_iso_hours_for");
const LEAD = fn("is_leader"), MEM = fn("my_member_id"), DEP = fn("my_department_id");
must(GRD.md5 === "c1af95df40d551b75998cde0a8f290f7" && COR.md5 === "8c00066509e9dca338dc3662f55e1211", "the guard / correct are not the post-Slice-T bodies");
must(F["finalize_training_session(p_session_id uuid, p_actual_start time without time zone, p_actual_end time without time zone, p_setup_min integer)"]?.md5 === "b702ad77a183903c06710e3edc33b637", "the times finalize is not the Slice T body");
must(ATT.md5 === "aff25333771cd38c1f473bcde5e1e96e" && ISO.md5 === "705c9a9b5532d28824f5e50e74d6059f", "the ledger functions moved");
must(!Object.keys(F).some((k) => /^(set_session_reaction|session_reaction_tally)\(/.test(k)) && M.reactions_table === false, "a Slice R object already exists");
must(/members\.department_id = public\.my_department_id\(\)/.test(LEAD.def) && /'Project Admin','Department Admin','Board Member','Officer'/.test(LEAD.def), "is_leader() is not the department-scoped leadership gate");
must(/department_id = public\.my_department_id\(\)/.test(MEM.def), "my_member_id() is not department-scoped");
const saCols = M.columns.session_attendance.map((c) => c.name).join(",");
must(saCols === "id,department_id,session_id,member_id,checked_in_at,created_at", "session_attendance columns");
must(M.constraints["session_attendance.session_attendance_session_id_member_id_key"] === "UNIQUE (session_id, member_id)", "session_attendance is no longer one row per (session, member)");
must(M.columns.training_sessions.some((c) => c.name === "status") && M.constraints["training_sessions.training_sessions_status_check"] === "CHECK ((status = ANY (ARRAY['scheduled'::text, 'cancelled'::text])))", "training_sessions.status");
must(/^\{postgres=arwdDxtm\/postgres,authenticated=arwdDxtm\/postgres,service_role=arwdDxtm\/postgres\}$/.test(M.default_acl.find((d) => d.role === "postgres" && d.ns === "public" && d.type === "r")?.acl || ""), "the default table ACL for postgres in public changed");

// ---------------------------------------------------------------- the new objects
const T = "public.training_session_reactions";
const SET_SIG = "public.set_session_reaction(uuid, integer)", TALLY_SIG = "public.session_reaction_tally(uuid[])";
const NEW_FNS = ["set_session_reaction(uuid,integer)", "session_reaction_tally(uuid[])"];
const POLICY = { name: "members read own reaction", cmd: "SELECT", roles: "{authenticated}", qual: "(member_id = my_member_id())" };
const LEADERS = "array['Project Admin','Department Admin','Board Member','Officer']::text[]";
const TABLE_SQL = `  CREATE TABLE ${T} (
    id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    department_id uuid NOT NULL REFERENCES public.departments(id) ON DELETE CASCADE,
    session_id uuid NOT NULL REFERENCES public.training_sessions(id) ON DELETE CASCADE,
    member_id uuid NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
    value smallint NOT NULL CONSTRAINT training_session_reactions_value_check CHECK (value IN (-1, 1)),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT training_session_reactions_session_member_key UNIQUE (session_id, member_id)
  );
  CREATE INDEX training_session_reactions_member_idx ON ${T} (member_id);
  ALTER TABLE ${T} ENABLE ROW LEVEL SECURITY;
  -- the postgres default ACL would give authenticated ALL: take it back to SELECT only (RLS = own row). No write grant, no write policy.
  REVOKE ALL ON TABLE ${T} FROM PUBLIC, anon, authenticated;
  GRANT SELECT ON TABLE ${T} TO authenticated;
  GRANT ALL ON TABLE ${T} TO service_role;
  CREATE POLICY "${POLICY.name}" ON ${T} FOR SELECT TO authenticated USING (member_id = public.my_member_id());`;
// exactly what information_schema / pg_constraint must say afterwards
const COLS_NEW = "id:uuid:NO:gen_random_uuid(),department_id:uuid:NO:,session_id:uuid:NO:,member_id:uuid:NO:,value:int2:NO:,created_at:timestamptz:NO:now(),updated_at:timestamptz:NO:now()";
const CON_NEW = ["c:value::", "f:department_id:departments:c", "f:member_id:members:c", "f:session_id:training_sessions:c", "p:id::", "u:session_id,member_id::"].sort().join(";");

const SET_BODY = `
    -- B4C:E1E3 slice R — a member's thumbs up / down (1 / -1) on a training session they attended. The ONLY write path to
    -- training_session_reactions: the table has no write policy and authenticated holds SELECT only. One vote per member per
    -- session; voting again changes it. Allowed for the caller's own member row, on a session in their department that is
    -- finalized and not cancelled, where they are on the roll, until 14 days after the session's date (America/Chicago).
    -- A reopened session refuses new votes until it is finalized again; existing votes stay.
    declare
      v_me   uuid := public.my_member_id();
      v_dept uuid := public.my_department_id();
      s      record;
      v_row  public.training_session_reactions%rowtype;
    begin
      if v_me is null or v_dept is null then
        raise exception 'NOT_ALLOWED: only an active member can react to a session.';
      end if;
      if p_value is null or p_value not in (-1, 1) then
        raise exception 'BAD_VALUE: a reaction is 1 (thumbs up) or -1 (thumbs down).';
      end if;
      select ts.id, ts.department_id, ts."date", ts.done, ts.status into s
        from public.training_sessions ts where ts.id = p_session_id;
      if not found or s.department_id is distinct from v_dept then
        raise exception 'NOT_FOUND: no such session in your department.';
      end if;
      if s.done is not true then
        raise exception 'NOT_FINALIZED: reactions open once the session is finalized.';
      end if;
      if s.status = 'cancelled' then
        raise exception 'CANCELLED: this session was cancelled.';
      end if;
      if not exists (select 1 from public.session_attendance a where a.session_id = s.id and a.member_id = v_me) then
        raise exception 'NOT_PRESENT: only members on the session''s roll can react.';
      end if;
      if (now() at time zone 'America/Chicago')::date - s."date" > 14 then
        raise exception 'CLOSED: reactions close 14 days after the session.';
      end if;
      insert into public.training_session_reactions as r (department_id, session_id, member_id, value)
      values (s.department_id, s.id, v_me, p_value)
      on conflict (session_id, member_id) do update set value = excluded.value, updated_at = now()
      returning r.* into v_row;
      return jsonb_build_object('session_id', v_row.session_id, 'value', v_row.value, 'updated_at', v_row.updated_at);
    end;
`;
const TALLY_BODY = `
    -- B4C:E1E3 slice R — leadership's view of the reactions: COUNTS ONLY, never who. is_leader() (PA / DA / Board / Officer in
    -- the caller's active department). Counts only votes from members STILL on the session's roll (someone removed via Correct
    -- drops out), only sessions in the caller's department (any other id returns nothing), and a session returns NO row until
    -- it has at least 3 counted votes — so a small session can't be de-anonymised. Enforced here, so the API can't bypass it.
    declare v_dept uuid := public.my_department_id();
    begin
      if v_dept is null or not public.is_leader() then
        raise exception 'NOT_ALLOWED: only department leadership can see reaction tallies.';
      end if;
      return query
        select r.session_id,
               (count(*) filter (where r.value = 1))::integer,
               (count(*) filter (where r.value = -1))::integer
          from public.training_session_reactions r
          join public.training_sessions ts on ts.id = r.session_id and ts.department_id = v_dept
         where r.session_id = any (p_session_ids)
           and r.department_id = v_dept
           and exists (select 1 from public.session_attendance a where a.session_id = r.session_id and a.member_id = r.member_id)
         group by r.session_id
        having count(*) >= 3;
    end;
`;
const SET_DEF = `CREATE OR REPLACE FUNCTION public.set_session_reaction(p_session_id uuid, p_value integer)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$${SET_BODY}$function$
`;
const TALLY_DEF = `CREATE OR REPLACE FUNCTION public.session_reaction_tally(p_session_ids uuid[])
 RETURNS TABLE(session_id uuid, up integer, down integer)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$${TALLY_BODY}$function$
`;

// ---------------------------------------------------------------- shared SQL pieces
const PINS = Object.keys(F).sort();
const regp = (sig) => `'public.${sig.replace(/\(.*$/, "")}(${sig.replace(/^[^(]*\(|\)$/g, "").split(", ").filter(Boolean).map((a) => a.replace(/^\w+ /, "")).join(", ")})'::regprocedure`;
const fmd5 = (sig) => `md5(pg_get_functiondef(${regp(sig)}))`;
const ALL_FN_MD5 = `(SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text)) FROM pg_proc p
       WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f' AND p.oid::regprocedure::text NOT IN (${NEW_FNS.map((s) => `'${s}'`).join(", ")}))`;
const FN_N = `(SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f')`;
const REL_N = `(SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm'))`;
const POL_MD5_OTHERS = `(SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'public' AND tablename <> 'training_session_reactions')`;
const POL_N = `(SELECT count(*) FROM pg_policies WHERE schemaname = 'public')`;
const TBLS = "('public.training_sessions'::regclass, 'public.session_attendance'::regclass)";
const TRG_MD5 = `(SELECT md5(string_agg(c.relname || '.' || t.tgname || '|' || pg_get_triggerdef(t.oid), ',' ORDER BY (c.relname || '.' || t.tgname) COLLATE "C")) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE t.tgrelid IN ${TBLS} AND NOT t.tgisinternal)`;
// contype 'n' (NOT NULL recorded as a constraint — newer Postgres) is excluded: NOT NULL is pinned by the column lists.
const CON_MD5 = `(SELECT md5(string_agg(c.relname || '.' || k.conname || '|' || pg_get_constraintdef(k.oid), ',' ORDER BY (c.relname || '.' || k.conname) COLLATE "C")) FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid WHERE k.conrelid IN ${TBLS} AND k.contype <> 'n')`;
const TRG_PIN = md5(Object.entries(M.triggers).sort(byC).map(([n, d]) => `${n}|${d}`).join(","));
const CON_PIN = md5(Object.entries(M.constraints).sort(byC).map(([n, d]) => `${n}|${d}`).join(","));
const COLS_SQL = (t) => `(SELECT string_agg(column_name || ':' || udt_name || ':' || is_nullable, ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = '${t}')`;
const COLS_PIN = (t) => M.columns[t].map((c) => `${c.name}:${c.type}:${c.null ? "YES" : "NO"}`).join(",");
const NEW_COLS_SQL = `(SELECT string_agg(column_name || ':' || udt_name || ':' || is_nullable || ':' || coalesce(column_default, ''), ',' ORDER BY ordinal_position) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'training_session_reactions')`;
const NEW_CON_SQL = `(SELECT string_agg(k.contype::text || ':' || coalesce((SELECT string_agg(a.attname, ',' ORDER BY u.ord) FROM unnest(k.conkey) WITH ORDINALITY u(n, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n), '')
         || ':' || CASE WHEN k.contype = 'f' THEN (SELECT relname FROM pg_class WHERE oid = k.confrelid) ELSE '' END || ':' || CASE WHEN k.contype = 'f' THEN k.confdeltype::text ELSE '' END,
         ';' ORDER BY (k.contype::text || ':' || coalesce((SELECT string_agg(a.attname, ',' ORDER BY u.ord) FROM unnest(k.conkey) WITH ORDINALITY u(n, ord) JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n), '')) COLLATE "C")
     FROM pg_constraint k WHERE k.conrelid = '${T}'::regclass AND k.contype <> 'n')`;
const ROWS_MD5 = (t) => `(SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '')) FROM public.${t} x)`;
const LEDGER = (into) => `
    ${into} := '{}'::jsonb;
    FOR d IN SELECT id FROM public.departments ORDER BY id LOOP
      ${into} := ${into} || jsonb_build_object(d::text, jsonb_build_object(
        'attested', (SELECT md5(coalesce(string_agg(a.member_id || '|' || a.session_id || '|' || a.start_at || '|' || a.end_at || '|' || a.optional, ',' ORDER BY a.member_id, a.session_id), ''))
                       FROM public.attested_training(d, '1900-01-01'::timestamptz, '2200-01-01'::timestamptz) a),
        'iso', (SELECT md5(coalesce(string_agg(h.member_id || '|' || h.training_hours || '|' || h.standby_hours || '|' || h.iso_total_hours, ',' ORDER BY h.member_id), ''))
                  FROM public.dept_iso_hours_for(d, '1900-01-01'::timestamptz, '2200-01-01'::timestamptz) h)));
    END LOOP;`;
const FN_ACL = "{postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}";
const TBL_PRIVS = `has_table_privilege('authenticated', '${T}', 'SELECT')
     AND NOT has_table_privilege('authenticated', '${T}', 'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     AND NOT has_table_privilege('anon', '${T}', 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     AND NOT EXISTS (SELECT 1 FROM aclexplode((SELECT relacl FROM pg_class WHERE oid = '${T}'::regclass)) g WHERE g.grantee = 0)
     AND NOT EXISTS (SELECT 1 FROM information_schema.column_privileges WHERE table_schema = 'public' AND table_name = 'training_session_reactions' AND grantee IN ('anon', 'authenticated', 'PUBLIC') AND privilege_type <> 'SELECT')`;
const POLICY_OK = `(SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_reactions') = 1
     AND EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_reactions' AND policyname = '${POLICY.name}'
                   AND cmd = '${POLICY.cmd}' AND roles::text = '${POLICY.roles}' AND qual = '${POLICY.qual}' AND with_check IS NULL AND permissive = 'PERMISSIVE')
     AND (SELECT relrowsecurity FROM pg_class WHERE oid = '${T}'::regclass)`;
const FN_OK = (sig, body, vol) => `(SELECT p.prosrc = '${q(body)}' AND p.prosecdef AND p.provolatile = '${vol}' AND p.proconfig = ARRAY['search_path=public']
             AND coalesce(p.proacl::text, '') = '${FN_ACL}' AND NOT has_function_privilege('anon', p.oid, 'EXECUTE') AND p.pronargdefaults = 0
        FROM pg_proc p WHERE p.oid = to_regprocedure('${sig}'))`;

// ================================================================ DRAFT
out["sql/e1e3_sliceR_session_reactions_DRAFT.sql"] = `-- =====================================================================
-- E1/E3 SLICE R — training session REACTIONS (thumbs up / down) (DB). DRAFT for gate review — NOT APPLIED.
-- GENERATED by docs/review/e1e3_sliceR_build.mjs from the live captures (${M.read_at.slice(0, 16)} UTC, after Slice T):
-- docs/review/e1e3_sliceR_LIVE_fns.json + docs/review/e1e3_sliceR_LIVE_meta.json.
-- Step 0: claude/B4C_E1E3_TrainingTime_Reactions_Step0.md (design/e1e3-step0 @ 813ed0e) + the gate's Slice R directive.
--
-- WHAT IT DOES:
--   1. NEW TABLE training_session_reactions: one row per (session, member), value smallint ±1, created_at / updated_at.
--      FKs cascade like session_attendance's (department, session, member). RLS ON with ONE policy — SELECT TO authenticated
--      USING (member_id = my_member_id()): a member reads only their own row. NO insert / update / delete policy, and
--      authenticated holds SELECT only (the default ALL is revoked); anon and PUBLIC hold nothing.
--   2. NEW set_session_reaction(p_session_id, p_value) — SECURITY DEFINER, the only write path: own member row, own department,
--      the session finalized and not cancelled, the caller on its roll, re-vote updates (ON CONFLICT), refused more than 14 days
--      after the session's date (America/Chicago). EXECUTE authenticated + service_role only.
--   3. NEW session_reaction_tally(p_session_ids uuid[]) — SECURITY DEFINER, STABLE: is_leader() in the caller's department;
--      returns (session_id, up, down) — counts only, never member ids; counts only voters still on the roll; a session returns
--      NOTHING until it has ≥ 3 counted votes. EXECUTE authenticated + service_role only.
--   Nothing else: no existing function, policy, trigger, constraint, grant or row changes.
--
-- PREFLIGHT (refuses, changes nothing): the table / either function / the policy already exists → refuse. md5 pins on the 15
-- captured functions (incl. the POST-Slice-T guard c1af95df / correct 8c000665 / times finalize b702ad77, attested_training,
-- dept_iso_hours_for, is_leader, my_member_id, my_department_id, the session_attendance membership-window trigger); the trigger and
-- constraint definitions of training_sessions + session_attendance; every public policy (md5); both tables' column lists.
-- IN-TRANSACTION PROOF (any miss → RAISE → everything rolls back):
--   · THE LEDGER: for EVERY department, md5 of attested_training(dept, all time) AND dept_iso_hours_for(dept, all time), BEFORE
--     and AFTER — byte-identical. training_sessions + session_attendance rows byte-identical; verified presence unchanged.
--   · the new table EXACTLY as intended: columns + defaults, constraints (pk, unique (session, member), 3 cascading FKs, the ±1
--     CHECK), RLS on, exactly the one own-row SELECT policy, privileges (authenticated SELECT only; anon + PUBLIC nothing), empty,
--     no trigger on it, no view reading it
--   · both functions exactly the generated text, SECURITY DEFINER, search_path=public, no defaults, ACL authenticated +
--     service_role (anon cannot execute); the tally STABLE
--   · every OTHER public function (definition + ACL), every other policy, every training_sessions / session_attendance trigger
--     and constraint byte-identical; functions +2, policies +1, relations +1
-- Dry run: docs/review/e1e3_sliceR_DRYRUN.txt. RETEST (separately, after): sql/e1e3_sliceR_session_reactions_RETEST.sql.
-- =====================================================================
DO $migrate$
DECLARE
  d uuid; r record; v_t text;
  v_led_before jsonb; v_led_after jsonb; v_ts_rows text; v_sa_rows text; v_others text; v_fn_n bigint; v_pol_n bigint; v_rel_n bigint; v_ver bigint;
BEGIN
  -- ---------------------------------------------------------------- 0. preflight
  IF to_regclass('${T}') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_session_reaction', 'session_reaction_tally'))
     OR EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = '${POLICY.name}') THEN
    RAISE EXCEPTION 'PREFLIGHT: training_session_reactions, set_session_reaction, session_reaction_tally or the reactions policy already exists — Slice R looks applied. Refusing.';
  END IF;
  FOR r IN SELECT * FROM (VALUES
${PINS.map((s) => `      ('${q(s)}', '${F[s].md5}')`).join(",\n")}) v(sig, md5) LOOP
    SELECT md5(pg_get_functiondef(p.oid)) INTO v_t FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND (p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')') = r.sig;
    IF v_t IS DISTINCT FROM r.md5 THEN RAISE EXCEPTION 'PREFLIGHT: % drifted from the capture (or is gone). Refusing.', r.sig; END IF;
  END LOOP;
  IF ${TRG_MD5} IS DISTINCT FROM '${TRG_PIN}' THEN RAISE EXCEPTION 'PREFLIGHT: a training_sessions / session_attendance trigger changed. Refusing.'; END IF;
  IF ${CON_MD5} IS DISTINCT FROM '${CON_PIN}' THEN RAISE EXCEPTION 'PREFLIGHT: a training_sessions / session_attendance constraint changed. Refusing.'; END IF;
  IF ${POL_MD5_OTHERS} IS DISTINCT FROM '${M.policies_md5}' THEN RAISE EXCEPTION 'PREFLIGHT: a public policy changed since the capture. Refusing.'; END IF;
  IF ${COLS_SQL("training_sessions")} IS DISTINCT FROM '${COLS_PIN("training_sessions")}'
     OR ${COLS_SQL("session_attendance")} IS DISTINCT FROM '${COLS_PIN("session_attendance")}' THEN
    RAISE EXCEPTION 'PREFLIGHT: the training_sessions / session_attendance columns changed since the capture. Refusing.';
  END IF;
  v_fn_n := ${FN_N}; v_pol_n := ${POL_N}; v_rel_n := ${REL_N};
  SELECT count(*) INTO v_ver FROM public.station_presence WHERE verified;
  v_ts_rows := ${ROWS_MD5("training_sessions")};
  v_sa_rows := ${ROWS_MD5("session_attendance")};
  v_others := ${ALL_FN_MD5};
${LEDGER("v_led_before")}

  -- ---------------------------------------------------------------- 1. the table: own-row read, no write path but the RPC
${TABLE_SQL}

  -- ---------------------------------------------------------------- 2. set_session_reaction (the only write path)
${SET_DEF};
  REVOKE ALL ON FUNCTION ${SET_SIG} FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION ${SET_SIG} TO authenticated, service_role;

  -- ---------------------------------------------------------------- 3. session_reaction_tally (leadership: counts only, ≥ 3)
${TALLY_DEF};
  REVOKE ALL ON FUNCTION ${TALLY_SIG} FROM PUBLIC, anon;
  GRANT EXECUTE ON FUNCTION ${TALLY_SIG} TO authenticated, service_role;

  -- ---------------------------------------------------------------- 4. post-conditions (in-transaction)
${LEDGER("v_led_after")}
  IF v_led_after IS DISTINCT FROM v_led_before THEN
    SELECT string_agg(k, ', ') INTO v_t FROM jsonb_object_keys(v_led_before) k WHERE (v_led_before->k) IS DISTINCT FROM (v_led_after->k);
    RAISE EXCEPTION 'Post-condition failed: the credited-hours ledger moved for department(s) %. Rolling back.', v_t;
  END IF;
  IF ${ROWS_MD5("training_sessions")} IS DISTINCT FROM v_ts_rows OR ${ROWS_MD5("session_attendance")} IS DISTINCT FROM v_sa_rows THEN
    RAISE EXCEPTION 'Post-condition failed: a training_sessions / session_attendance row changed. Rolling back.';
  END IF;
  -- the table, exactly
  IF ${NEW_COLS_SQL} IS DISTINCT FROM '${COLS_NEW}' THEN RAISE EXCEPTION 'Post-condition failed: the reactions table columns are not as intended. Rolling back.'; END IF;
  IF ${NEW_CON_SQL} IS DISTINCT FROM '${CON_NEW}' THEN
    RAISE EXCEPTION 'Post-condition failed: the reactions table constraints are not exactly pk + unique (session, member) + 3 cascading FKs + the value CHECK. Rolling back.';
  END IF;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = '${T}'::regclass AND conname = 'training_session_reactions_value_check') !~ '-1' THEN
    RAISE EXCEPTION 'Post-condition failed: the value CHECK is not ±1. Rolling back.';
  END IF;
  IF NOT (${POLICY_OK}) THEN
    RAISE EXCEPTION 'Post-condition failed: the reactions table RLS is not exactly ON + the one own-row SELECT policy (no write policy, no leadership read). Rolling back.';
  END IF;
  IF NOT (${TBL_PRIVS}) THEN
    RAISE EXCEPTION 'Post-condition failed: reactions table privileges — authenticated must hold SELECT only, anon and PUBLIC nothing. Rolling back.';
  END IF;
  IF EXISTS (SELECT 1 FROM ${T}) OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = '${T}'::regclass AND NOT tgisinternal)
     OR EXISTS (SELECT 1 FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('v', 'm') AND pg_get_viewdef(c.oid) ~ 'training_session_reactions') THEN
    RAISE EXCEPTION 'Post-condition failed: the reactions table is not empty, has a trigger, or a view reads it. Rolling back.';
  END IF;
  -- the two functions, exactly
  IF NOT coalesce(${FN_OK(SET_SIG, SET_BODY, "v")}, false) THEN
    RAISE EXCEPTION 'Post-condition failed: set_session_reaction is not the generated body / SECURITY DEFINER / search_path=public / authenticated + service_role only (anon must not execute). Rolling back.';
  END IF;
  IF NOT coalesce(${FN_OK(TALLY_SIG, TALLY_BODY, "s")}, false) THEN
    RAISE EXCEPTION 'Post-condition failed: session_reaction_tally is not the generated body / STABLE SECURITY DEFINER / search_path=public / authenticated + service_role only (anon must not execute). Rolling back.';
  END IF;
  -- nothing else
  IF ${fmd5(GRD.sig)} IS DISTINCT FROM '${GRD.md5}' OR ${fmd5(COR.sig)} IS DISTINCT FROM '${COR.md5}'
     OR ${fmd5(ATT.sig)} IS DISTINCT FROM '${ATT.md5}' OR ${fmd5(ISO.sig)} IS DISTINCT FROM '${ISO.md5}' THEN
    RAISE EXCEPTION 'Post-condition failed: the guard / correct / attested_training / dept_iso_hours_for changed. Rolling back.';
  END IF;
  IF ${ALL_FN_MD5} IS DISTINCT FROM v_others THEN RAISE EXCEPTION 'Post-condition failed: another public function changed. Rolling back.'; END IF;
  IF ${FN_N} <> v_fn_n + 2 THEN RAISE EXCEPTION 'Post-condition failed: the function count is not +2. Rolling back.'; END IF;
  IF ${POL_MD5_OTHERS} IS DISTINCT FROM '${M.policies_md5}' OR ${POL_N} <> v_pol_n + 1 THEN
    RAISE EXCEPTION 'Post-condition failed: another policy changed, or the policy count is not +1. Rolling back.';
  END IF;
  IF ${REL_N} <> v_rel_n + 1 THEN RAISE EXCEPTION 'Post-condition failed: the relation count is not +1. Rolling back.'; END IF;
  IF ${TRG_MD5} IS DISTINCT FROM '${TRG_PIN}' OR ${CON_MD5} IS DISTINCT FROM '${CON_PIN}' THEN
    RAISE EXCEPTION 'Post-condition failed: a training_sessions / session_attendance trigger or constraint changed. Rolling back.';
  END IF;
  IF (SELECT count(*) FROM public.station_presence WHERE verified) <> v_ver THEN RAISE EXCEPTION 'Post-condition failed: verified presence changed. Rolling back.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------- state row
SELECT jsonb_build_object(
  'table_columns', ${NEW_COLS_SQL},
  'table_constraints', ${NEW_CON_SQL},
  'rls', (SELECT relrowsecurity FROM pg_class WHERE oid = '${T}'::regclass),
  'policies_on_table', (SELECT jsonb_agg(jsonb_build_object('name', policyname, 'cmd', cmd, 'roles', roles::text, 'qual', qual, 'check', with_check)) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'training_session_reactions'),
  'privileges', jsonb_build_object(
     'authenticated', (SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('authenticated', '${T}', p)),
     'anon', coalesce((SELECT string_agg(p, ',' ORDER BY p) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p WHERE has_table_privilege('anon', '${T}', p)), '(none)')),
  'rows', (SELECT count(*) FROM ${T}),
  'set_session_reaction', (SELECT jsonb_build_object('md5', md5(pg_get_functiondef(p.oid)), 'secdef', p.prosecdef, 'acl', p.proacl::text, 'anon_exec', has_function_privilege('anon', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.oid = '${SET_SIG}'::regprocedure),
  'session_reaction_tally', (SELECT jsonb_build_object('md5', md5(pg_get_functiondef(p.oid)), 'secdef', p.prosecdef, 'volatile', p.provolatile, 'acl', p.proacl::text, 'anon_exec', has_function_privilege('anon', p.oid, 'EXECUTE')) FROM pg_proc p WHERE p.oid = '${TALLY_SIG}'::regprocedure),
  'guard_md5', ${fmd5(GRD.sig)}, 'correct_md5', ${fmd5(COR.sig)}, 'attested_md5', ${fmd5(ATT.sig)}, 'iso_md5', ${fmd5(ISO.sig)},
  'fn_count', ${FN_N},
  'total_policies', ${POL_N},
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
`;

// ================================================================ RETEST
const AS = (email) => `PERFORM set_config('request.jwt.claims', json_build_object('email', ${email})::text, true); EXECUTE 'SET LOCAL ROLE authenticated';`;
const BACK = `EXECUTE 'RESET ROLE';`;
const OK = (id, msg) => `v_pass := v_pass + 1; rpt := rpt || 'PASS  ${id} ${q(msg)}' || chr(10);`;
const NO = (id, fmt, ...args) => `v_fail := v_fail + 1; rpt := rpt || format('FAIL  ${id} ${q(fmt)}%s'${args.map((a) => ", " + a).join("")}, chr(10));`;
const TRY = (call, like, counter = "v_n") => `BEGIN PERFORM ${call}; EXCEPTION WHEN OTHERS THEN IF SQLERRM LIKE '${like}' THEN ${counter} := ${counter} + 1; END IF; END;`;
const ELIG = (who, d) => `${who}.status = 'Active' AND ${who}.email IS NOT NULL AND (SELECT count(*) FROM public.members y WHERE lower(y.email) = lower(${who}.email)) = 1
           AND public.membership_window_allows(${who}.id, ${d})`;
out["sql/e1e3_sliceR_session_reactions_RETEST.sql"] = `-- =====================================================================
-- RETEST for e1e3_sliceR_session_reactions. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- Everything runs inside ONE sub-block ending in RAISE 'SENTINEL' (rolled back): synthetic sessions, a synthetic roll, Finalize,
-- votes, Correct, Reopen — NOTHING STAYS. The final RAISE is the report — the "ERROR" IS the report.
-- Acts as REAL people through the API path (JWT email claim, role authenticated): a real Department Admin whose department has
-- ≥ 4 other active members (unique emails, inside their membership window for the oldest synthetic date), and four of those
-- members (non-leaders first). Synthetic sessions + their rolls are written as the table owner, as in Slice T's RETEST.
--   S0  the slice is in place: the table, RLS on, exactly the one own-row SELECT policy, authenticated SELECT only, anon nothing,
--       both functions SECURITY DEFINER and not executable by anon
--   R1  a member votes 1: reads back their own row and nothing else
--   R2  re-vote -1: the same row changes (still one row for that member + session) — no duplicate
--   R3  THE ANONYMITY PROOF: 4 votes on session A; the real DA's raw SELECT returns 0 rows of anyone else's, while the tally
--       returns the counts (up 2, down 2)
--   R4  a 2-vote session returns NO tally row (≥ 3 enforced in the DB), while the 4-vote session in the same call does
--   R5  a member NOT on the roll → NOT_PRESENT, nothing written
--   R6  the window: a session dated 15 days ago → CLOSED; 14 days ago → accepted
--   R7  refusals: not finalized · value 0 · value 2 · NULL · an unknown session → refused by the RPC; value 0 written raw by the
--       owner → the CHECK
--   R8  no write path but the RPC: a member's raw INSERT / UPDATE / DELETE on the table → permission denied
--   R9  removed from the roll (via Correct) → their vote stops counting (up 2, down 1); remove one more → below 3 → NO row
--   R10 a non-leader calling the tally → NOT_ALLOWED
--   R11 a reopened session refuses new votes (NOT_FINALIZED) and keeps the existing ones
-- =====================================================================
DO $retest$
DECLARE
  rpt text := ''; v_pass int := 0; v_fail int := 0; v_skip int := 0;
  v_today date := (now() at time zone 'America/Chicago')::date;
  v_email text; v_me uuid; v_dept uuid; v_m uuid[]; v_e text[]; v_lead boolean[]; v_nl int;
  sA uuid; sB uuid; s14 uuid; s15 uuid; sN uuid; v_ok boolean; v_t text; v_n bigint; v_n2 bigint; v_n3 bigint; v_r jsonb; v_up int; v_down int;
BEGIN
  BEGIN
    SELECT lower(m.email), m.id, m.department_id INTO v_email, v_me, v_dept FROM public.members m
     WHERE m.access && array['Department Admin']::text[] AND ${ELIG("m", "v_today - 15")}
       AND (SELECT count(*) FROM public.members o WHERE o.department_id = m.department_id AND o.id <> m.id AND ${ELIG("o", "v_today - 15")}) >= 4
     ORDER BY m.department_id, m.id LIMIT 1;
    IF v_email IS NULL THEN RAISE EXCEPTION 'SKIPALL: no real Department Admin whose department has 4 other eligible active members'; END IF;
    SELECT array_agg(z.id ORDER BY z.ord), array_agg(z.em ORDER BY z.ord), array_agg(z.lead ORDER BY z.ord) INTO v_m, v_e, v_lead FROM (
      SELECT o.id, lower(o.email) AS em, (o.access && ${LEADERS}) AS lead,
             row_number() OVER (ORDER BY (o.access && ${LEADERS}), o.id) AS ord
        FROM public.members o WHERE o.department_id = v_dept AND o.id <> v_me AND ${ELIG("o", "v_today - 15")}) z WHERE z.ord <= 4;

    -- S0
    IF to_regclass('${T}') IS NOT NULL AND ${POLICY_OK}
       AND ${TBL_PRIVS}
       AND (SELECT prosecdef AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM pg_proc WHERE oid = '${SET_SIG}'::regprocedure)
       AND (SELECT prosecdef AND NOT has_function_privilege('anon', oid, 'EXECUTE') FROM pg_proc WHERE oid = '${TALLY_SIG}'::regprocedure) THEN
      ${OK("S0", "table + RLS on + exactly the one own-row SELECT policy; authenticated SELECT only, anon nothing; both RPCs SECURITY DEFINER, anon cannot execute")}
    ELSE ${NO("S0", "the slice is not in place as intended")} END IF;

    -- synthetic sessions + rolls (owner), finalized as the real DA (the membership-window trigger still runs — eligible members only)
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-R RETEST A', v_today - 1, '19:00') RETURNING id INTO sA;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-R RETEST B', v_today - 1, '19:00') RETURNING id INTO sB;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-R RETEST 14', v_today - 14, '19:00') RETURNING id INTO s14;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-R RETEST 15', v_today - 15, '19:00') RETURNING id INTO s15;
    INSERT INTO public.training_sessions (department_id, title, "date", start_time) VALUES (v_dept, 'SLICE-R RETEST N', v_today - 1, '19:00') RETURNING id INTO sN;
    BEGIN
      INSERT INTO public.session_attendance (department_id, session_id, member_id, checked_in_at) VALUES
        (v_dept, sA, v_me, now()), (v_dept, sA, v_m[1], now()), (v_dept, sA, v_m[2], now()), (v_dept, sA, v_m[3], now()),
        (v_dept, sB, v_m[1], now()), (v_dept, sB, v_m[2], now()),
        (v_dept, s14, v_m[1], now()), (v_dept, s15, v_m[1], now()), (v_dept, sN, v_m[1], now());
    EXCEPTION WHEN OTHERS THEN RAISE EXCEPTION 'SKIPALL: the synthetic roll was refused (%)', SQLERRM;
    END;
    ${AS("v_email")}
    PERFORM public.finalize_training_session(p_session_id => sA, p_duration_min => 60);
    PERFORM public.finalize_training_session(p_session_id => sB, p_duration_min => 60);
    PERFORM public.finalize_training_session(p_session_id => s14, p_duration_min => 60);
    PERFORM public.finalize_training_session(p_session_id => s15, p_duration_min => 60);
    ${BACK}

    -- R1
    ${AS("v_e[1]")}
    v_r := public.set_session_reaction(sA, 1);
    SELECT count(*) FILTER (WHERE member_id <> v_m[1]), count(*) FILTER (WHERE session_id = sA AND value = 1) INTO v_n, v_n2 FROM ${T};
    ${BACK}
    IF (v_r->>'value')::int = 1 AND v_n = 0 AND v_n2 = 1 THEN ${OK("R1", "a member votes 1 and reads back their own row — no one else's")}
    ELSE ${NO("R1", "vote/read-back: %s, others visible %s, own %s", "v_r", "v_n", "v_n2")} END IF;

    -- R2
    ${AS("v_e[1]")}
    PERFORM public.set_session_reaction(sA, -1);
    ${BACK}
    SELECT count(*), min(value) INTO v_n, v_up FROM ${T} WHERE session_id = sA AND member_id = v_m[1];
    IF v_n = 1 AND v_up = -1 THEN ${OK("R2", "re-vote -1 updates the same row (one row, value -1) — no duplicate")}
    ELSE ${NO("R2", "re-vote: %s rows, value %s", "v_n", "v_up")} END IF;

    -- R3 the anonymity proof
    ${AS("v_email")} PERFORM public.set_session_reaction(sA, 1); ${BACK}
    ${AS("v_e[2]")} PERFORM public.set_session_reaction(sA, 1); ${BACK}
    ${AS("v_e[3]")} PERFORM public.set_session_reaction(sA, -1); ${BACK}
    SELECT count(*) INTO v_n3 FROM ${T} WHERE session_id = sA;
    ${AS("v_email")}
    SELECT count(*) FILTER (WHERE member_id <> v_me), count(*) FILTER (WHERE member_id = v_me AND session_id = sA) INTO v_n, v_n2 FROM ${T};
    SELECT t.up, t.down INTO v_up, v_down FROM public.session_reaction_tally(ARRAY[sA]) t;
    ${BACK}
    IF v_n3 = 4 AND v_n = 0 AND v_n2 = 1 AND v_up = 2 AND v_down = 2 THEN
      ${OK("R3", "4 votes on session A: the real DA's raw SELECT returns 0 rows of anyone else's (only their own), while the tally returns up 2 · down 2")}
    ELSE ${NO("R3", "rows on A %s; DA sees %s others / %s own; tally up %s down %s", "v_n3", "v_n", "v_n2", "v_up", "v_down")} END IF;

    -- R4 the ≥ 3 threshold
    ${AS("v_e[1]")} PERFORM public.set_session_reaction(sB, 1); ${BACK}
    ${AS("v_e[2]")} PERFORM public.set_session_reaction(sB, -1); ${BACK}
    SELECT count(*) INTO v_n3 FROM ${T} WHERE session_id = sB;
    ${AS("v_email")}
    SELECT count(*) FILTER (WHERE t.session_id = sB), count(*) FILTER (WHERE t.session_id = sA) INTO v_n, v_n2 FROM public.session_reaction_tally(ARRAY[sA, sB]) t;
    ${BACK}
    IF v_n3 = 2 AND v_n = 0 AND v_n2 = 1 THEN ${OK("R4", "a 2-vote session returns NO tally row (≥ 3 enforced in the DB); the 4-vote session in the same call does")}
    ELSE ${NO("R4", "B has %s votes; tally rows B %s, A %s", "v_n3", "v_n", "v_n2")} END IF;

    -- R5 not on the roll
    v_t := NULL;
    ${AS("v_e[4]")}
    BEGIN PERFORM public.set_session_reaction(sA, 1); EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    ${BACK}
    IF v_t LIKE 'NOT_PRESENT%' AND NOT EXISTS (SELECT 1 FROM ${T} WHERE member_id = v_m[4] AND session_id = sA) THEN ${OK("R5", "a member not on the roll → NOT_PRESENT, nothing written")}
    ELSE ${NO("R5", "%s", "coalesce(v_t, 'accepted')")} END IF;

    -- R6 the 14-day window (America/Chicago)
    v_t := NULL;
    ${AS("v_e[1]")}
    BEGIN PERFORM public.set_session_reaction(s15, 1); EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    v_r := public.set_session_reaction(s14, 1);
    ${BACK}
    IF v_t LIKE 'CLOSED%' AND (v_r->>'value')::int = 1 AND NOT EXISTS (SELECT 1 FROM ${T} WHERE session_id = s15) THEN
      ${OK("R6", "a session dated 15 days ago → CLOSED; 14 days ago → accepted")}
    ELSE ${NO("R6", "15 days: %s; 14 days: %s", "coalesce(v_t, 'accepted')", "v_r")} END IF;

    -- R7 refusals
    v_n := 0;
    ${AS("v_e[1]")}
    ${TRY("public.set_session_reaction(sN, 1)", "NOT_FINALIZED%")}
    ${TRY("public.set_session_reaction(sA, 0)", "BAD_VALUE%")}
    ${TRY("public.set_session_reaction(sA, 2)", "BAD_VALUE%")}
    ${TRY("public.set_session_reaction(sA, NULL)", "BAD_VALUE%")}
    ${TRY("public.set_session_reaction(gen_random_uuid(), 1)", "NOT_FOUND%")}
    ${BACK}
    BEGIN INSERT INTO ${T} (department_id, session_id, member_id, value) VALUES (v_dept, sN, v_m[1], 0); EXCEPTION WHEN check_violation THEN v_n := v_n + 1; END;
    IF v_n = 6 THEN ${OK("R7", "refused: not finalized · value 0 · value 2 · NULL · unknown session (RPC); value 0 written raw → the CHECK")}
    ELSE ${NO("R7", "%s of 6 refused", "v_n")} END IF;

    -- R8 no write path but the RPC
    v_n := 0;
    ${AS("v_e[1]")}
    BEGIN INSERT INTO ${T} (department_id, session_id, member_id, value) VALUES (v_dept, sB, v_m[1], 1); EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; WHEN OTHERS THEN NULL; END;
    BEGIN UPDATE ${T} SET value = 1 WHERE member_id = v_m[1]; EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; WHEN OTHERS THEN NULL; END;
    BEGIN DELETE FROM ${T} WHERE member_id = v_m[1]; EXCEPTION WHEN insufficient_privilege THEN v_n := v_n + 1; WHEN OTHERS THEN NULL; END;
    ${BACK}
    IF v_n = 3 THEN ${OK("R8", "a member's raw INSERT / UPDATE / DELETE on the table → permission denied (the RPC is the only write path)")}
    ELSE ${NO("R8", "%s of 3 raw writes refused", "v_n")} END IF;

    -- R9 removed from the roll → stops counting (A: m1 -1, DA 1, m2 1, m3 -1)
    ${AS("v_email")}
    PERFORM public.correct_training_session(sA, '{}'::jsonb, '{}'::uuid[], ARRAY[v_m[3]], 'RETEST: remove from the roll');
    SELECT t.up, t.down INTO v_up, v_down FROM public.session_reaction_tally(ARRAY[sA]) t;
    PERFORM public.correct_training_session(sA, '{}'::jsonb, '{}'::uuid[], ARRAY[v_m[2]], 'RETEST: remove one more from the roll');
    SELECT count(*) INTO v_n FROM public.session_reaction_tally(ARRAY[sA]) t;
    ${BACK}
    SELECT count(*) INTO v_n2 FROM ${T} WHERE session_id = sA;
    IF v_up = 2 AND v_down = 1 AND v_n = 0 AND v_n2 = 4 THEN
      ${OK("R9", "removed from the roll via Correct → that vote stops counting (up 2 · down 1); one more removed → 2 counted → NO row (the votes themselves stay)")}
    ELSE ${NO("R9", "after one removal up %s down %s; after two %s rows; stored votes %s", "v_up", "v_down", "v_n", "v_n2")} END IF;

    -- R10 a non-leader cannot read the tally
    SELECT min(i) INTO v_nl FROM generate_subscripts(v_lead, 1) i WHERE NOT v_lead[i];
    IF v_nl IS NULL THEN
      v_skip := v_skip + 1; rpt := rpt || 'SKIP  R10 the four members picked are all leaders — the PGlite dry run carries this case' || chr(10);
    ELSE
      v_t := NULL;
      ${AS("v_e[v_nl]")}
      BEGIN PERFORM * FROM public.session_reaction_tally(ARRAY[sA]); EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
      ${BACK}
      IF v_t LIKE 'NOT_ALLOWED%' THEN ${OK("R10", "a non-leader calling the tally → NOT_ALLOWED")}
      ELSE ${NO("R10", "%s", "coalesce(v_t, 'returned rows')")} END IF;
    END IF;

    -- R11 reopened: new votes refused, existing ones kept
    v_t := NULL;
    ${AS("v_email")}
    PERFORM public.reopen_training_session(sB, 'RETEST: reopen to check reactions');
    ${BACK}
    ${AS("v_e[1]")}
    BEGIN PERFORM public.set_session_reaction(sB, 1); EXCEPTION WHEN OTHERS THEN v_t := SQLERRM; END;
    ${BACK}
    IF v_t LIKE 'NOT_FINALIZED%' AND (SELECT count(*) FROM ${T} WHERE session_id = sB) = 2 AND (SELECT value FROM ${T} WHERE session_id = sB AND member_id = v_m[1]) = 1 THEN
      ${OK("R11", "a reopened session refuses new votes (NOT_FINALIZED) and keeps the existing two")}
    ELSE ${NO("R11", "%s", "coalesce(v_t, 'accepted')")} END IF;

    PERFORM set_config('request.jwt.claims', '', true);
    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM LIKE 'SKIPALL:%' THEN v_skip := v_skip + 1; rpt := rpt || 'SKIP  ' || SQLERRM || chr(10);
    ELSIF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('FAIL  the RETEST block aborted: %s%s', SQLERRM, chr(10)); END IF;
  END;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, %s skipped', v_pass, v_fail, v_skip);
END
$retest$;
`;

// ================================================================ ROLLBACK
out["sql/e1e3_sliceR_session_reactions_ROLLBACK.sql"] = `-- =====================================================================
-- ROLLBACK for e1e3_sliceR_session_reactions — insurance, GENERATED from the same capture.
-- Refuses unless Slice R is applied, and REFUSES while the table holds ANY vote (they're real once the UI ships — dropping the
-- table would destroy them). Then: drop the two functions and the table (its policy and index go with it), and prove the rest
-- is untouched: every other function and policy byte-identical to just before, the training_sessions / session_attendance
-- triggers + constraints back on their pins, the ledger functions on theirs.
-- =====================================================================
DO $rollback$
DECLARE v_n bigint; v_others text; v_pol text;
BEGIN
  IF to_regclass('${T}') IS NULL OR to_regprocedure('${SET_SIG}') IS NULL OR to_regprocedure('${TALLY_SIG}') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK: Slice R is not applied. Refusing.';
  END IF;
  SELECT count(*) INTO v_n FROM ${T};
  IF v_n > 0 THEN RAISE EXCEPTION 'ROLLBACK: training_session_reactions holds % vote(s) — dropping it would lose them. Refusing.', v_n; END IF;
  v_others := ${ALL_FN_MD5};
  v_pol := ${POL_MD5_OTHERS};
  DROP FUNCTION ${SET_SIG};
  DROP FUNCTION ${TALLY_SIG};
  DROP TABLE ${T};
  IF to_regclass('${T}') IS NOT NULL OR EXISTS (SELECT 1 FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname IN ('set_session_reaction', 'session_reaction_tally'))
     OR ${ALL_FN_MD5} IS DISTINCT FROM v_others
     OR (SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename, policyname)) FROM pg_policies WHERE schemaname = 'public') IS DISTINCT FROM v_pol
     OR ${TRG_MD5} IS DISTINCT FROM '${TRG_PIN}' OR ${CON_MD5} IS DISTINCT FROM '${CON_PIN}'
     OR ${fmd5(ATT.sig)} IS DISTINCT FROM '${ATT.md5}' OR ${fmd5(ISO.sig)} IS DISTINCT FROM '${ISO.md5}' THEN
    RAISE EXCEPTION 'ROLLBACK post-condition: not back to the pre-Slice-R state. Rolling back.';
  END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
`;

// ================================================================ change list
out["docs/review/e1e3_sliceR_CHANGE_LIST.md"] = `# E1/E3 Slice R — change list (GENERATED by docs/review/e1e3_sliceR_build.mjs from the ${M.read_at.slice(0, 10)} live captures)

| object | before (live) | after |
|---|---|---|
| \`training_session_reactions\` | — | **new table**: \`id\`, \`department_id\`, \`session_id\`, \`member_id\`, \`value smallint\` (±1 CHECK), \`created_at\`, \`updated_at\`; \`UNIQUE (session_id, member_id)\`; FKs cascade (department, session, member) like \`session_attendance\`; index on \`member_id\` |
| its RLS | — | ON; **one** policy \`${POLICY.name}\`: SELECT TO authenticated USING \`member_id = my_member_id()\`. No INSERT/UPDATE/DELETE policy, no leadership read |
| its grants | (postgres default would be authenticated ALL) | authenticated **SELECT only**; anon + PUBLIC nothing; service_role ALL |
| \`set_session_reaction(uuid, integer)\` | — | **new**: SECURITY DEFINER, \`search_path=public\`; own member row, own department, finalized + not cancelled, on the roll, ≤ 14 days after the date (America/Chicago); upsert. EXECUTE authenticated + service_role |
| \`session_reaction_tally(uuid[])\` | — | **new**: STABLE SECURITY DEFINER; \`is_leader()\`; \`(session_id, up, down)\` counts only; voters still on the roll; nothing below 3 counted votes. EXECUTE authenticated + service_role |
| \`tg_training_session_lock_guard\` / \`correct_training_session\` | \`${GRD.md5}\` / \`${COR.md5}\` (post-Slice-T) | **unchanged** — pinned |
| \`attested_training\` / \`dept_iso_hours_for\` | \`${ATT.md5}\` / \`${ISO.md5}\` | **unchanged** — pinned; per-department output proven byte-identical |
| every other function, policy, trigger, constraint | ${M.counts.fns} functions · ${M.counts.policies} policies | unchanged; functions +2, policies +1, relations +1 |

Messages (for U2): \`NOT_ALLOWED\` · \`BAD_VALUE\` · \`NOT_FOUND\` · \`NOT_FINALIZED\` · \`CANCELLED\` · \`NOT_PRESENT\` · \`CLOSED\` (vote);
\`NOT_ALLOWED\` (tally). A tally call returns no row for a session below 3 counted votes — the UI shows "Not enough responses yet".
`;

// ---------------------------------------------------------------- write or check
const check = process.argv.includes("--check");
let bad = 0;
for (const [p, s] of Object.entries(out)) {
  if (check) { let cur = null; try { cur = readFileSync(join(root, p), "utf8"); } catch { /* missing */ } if (cur !== s) { console.log(`DIFFERS ${p}`); bad++; } else console.log(`same    ${p}`); }
  else { writeFileSync(join(root, p), s); console.log(`wrote   ${p} (${s.length} bytes)`); }
}
if (check && bad) process.exit(1);
