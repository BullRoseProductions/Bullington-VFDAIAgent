// node docs/review/l3_build.mjs           — write the files
// node docs/review/l3_build.mjs --check   — regenerate in memory; exit 1 unless every file on disk is byte-identical
// L-3 — DROP the dead tables public.profiles + public._d2a_resync_backup. GENERATED from three read-only live captures (2026-10-31):
//   docs/review/l3_STEP0_LIVE.json   (sql/l3_STEP0_CAPTURE.sql)  — DDL, RLS/grants, stats, row counts, every reference scan
//   docs/review/l3_BACKUP_LIVE.json  (sql/l3_BACKUP_CAPTURE.sql) — every row of both tables + their content md5s
//   docs/review/l3_PINS_LIVE.json    (sql/l3_PINS_CAPTURE.sql)   — function / policy / trigger set hashes, the relation list
// Writes: sql/l3_backup_rows.sql (the backup — FIRST) · sql/l3_drop_dead_tables_DRAFT.sql · _RETEST.sql · _ROLLBACK.sql ·
//         docs/review/l3_CHANGE_LIST.md
// Applying is one of Ashlea's three reserved items: it waits on her naming L-3, not on a general go.
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { createHash } from "crypto";
const root = fileURLToPath(new URL("../../", import.meta.url));
const J = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));
const S0 = J("docs/review/l3_STEP0_LIVE.json"), B = J("docs/review/l3_BACKUP_LIVE.json"), P = J("docs/review/l3_PINS_LIVE.json");
const out = {};
const q = (s) => String(s).replace(/'/g, "''");
const lit = (v) => (v == null ? "NULL" : `'${q(v)}'`);
const must = (c, why) => { if (!c) throw new Error(`STOP — the capture does not show a dead table: ${why}`); };
const md5 = (s) => createHash("md5").update(s, "utf8").digest("hex");
const byC = ([a], [b]) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- STOP RULE: anything referencing either table → it comes off the list
const T = ["profiles", "_d2a_resync_backup"];
for (const k of ["ref_functions", "ref_function_snippets", "ref_policies", "ref_views", "ref_triggers_anywhere", "ref_rules", "ref_cron"]) must(S0[k] == null, `${k} is not empty: ${JSON.stringify(S0[k])}`);
for (const t of T) {
  const x = S0.tables[t];
  must(x, `${t} missing from the capture`);
  must(x.fks_in == null, `${t} has foreign keys pointing at it`);
  must(x.policies == null && x.triggers == null && x.publications == null, `${t} has a policy / trigger / publication`);
  must((x.dependents || []).every((d) => /^toast table /.test(d)), `${t} has dependents: ${JSON.stringify(x.dependents)}`);
  must(x.rls === true && x.reachable.anon.SELECT === false, `${t} is reachable`);
}
must(S0.rows.profiles === 0 && B.profiles_rows.length === 0, "profiles is not empty");
must(S0.rows._d2a_resync_backup === B.d2a_rows.length && B.d2a_rows.length === 5, "the _d2a row count moved between captures");

// ---------------------------------------------------------------- the captured DDL → the recreate text (ROLLBACK + RETEST R1)
const COLS = (t) => S0.tables[t].columns;
const colSig = (t) => COLS(t).map((c) => `${c.name}:${c.type}:${c.not_null ? "NO" : "YES"}:${c.default ?? ""}`).join(",");
const qualify = (def) => def.replace(/REFERENCES (members|departments)\(/g, "REFERENCES public.$1(");
const PRIV = { a: "INSERT", r: "SELECT", w: "UPDATE", d: "DELETE", D: "TRUNCATE", x: "REFERENCES", t: "TRIGGER" };
const grantees = (acl) => (acl.match(/(\w+)=(\w+)\//g) || []).map((g) => g.split(/[=/]/)).filter(([who]) => who !== "postgres").map(([who, p]) => ({ who, privs: [...p].filter((c) => PRIV[c]).map((c) => PRIV[c]) }));
const RECREATE = (t) => {
  const x = S0.tables[t];
  const cons = Object.entries(x.constraints).sort(([a], [b]) => (a === `${t}_pkey` ? -1 : b === `${t}_pkey` ? 1 : a < b ? -1 : 1));
  return [
    `  CREATE TABLE public.${t} (\n${x.columns.map((c) => `    ${c.name} ${c.type}${c.not_null ? " NOT NULL" : ""}${c.default ? ` DEFAULT ${c.default}` : ""}`).join(",\n")}\n  );`,
    ...cons.map(([n, d]) => `  ALTER TABLE public.${t} ADD CONSTRAINT ${n} ${qualify(d)};`),
    `  COMMENT ON TABLE public.${t} IS ${lit(x.comment)};`,
    `  ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY;`,
    `  REVOKE ALL ON TABLE public.${t} FROM PUBLIC, anon, authenticated, service_role;`,
    // a full set (live: arwdDxtm — PG17 adds MAINTAIN) is re-granted as ALL, so the ACL comes back as it was on live
    ...grantees(x.acl).map((g) => `  GRANT ${g.privs.length === 7 ? "ALL" : g.privs.join(", ")} ON TABLE public.${t} TO ${g.who};`),
  ].join("\n");
};
const INSERTS = () => [
  `  -- public.profiles: ${B.profiles_rows.length} rows at capture (md5 ${B.profiles_md5}) — nothing to insert.`,
  ...B.profiles_rows.map((r) => `  INSERT INTO public.profiles (id, department_id, member_id, access, email, created_at) VALUES (${lit(r.id)}, ${lit(r.department_id)}, ${lit(r.member_id)}, ${lit(r.access)}, ${lit(r.email)}, ${lit(r.created_at)});`),
  `  -- public._d2a_resync_backup: ${B.d2a_rows.length} rows at capture (md5 ${B.d2a_md5}); values as Postgres printed them (shortest exact float text).`,
  `  INSERT INTO public._d2a_resync_backup (station_id, lat, lng, radius_m, geofence_enabled, captured_at) VALUES\n${B.d2a_rows.map((r) =>
    `    (${lit(r.station_id)}, ${r.lat == null ? "NULL" : `${lit(r.lat)}::double precision`}, ${r.lng == null ? "NULL" : `${lit(r.lng)}::double precision`}, ${r.radius_m == null ? "NULL" : `${lit(r.radius_m)}::integer`}, ${r.geofence_enabled == null ? "NULL" : `${lit(r.geofence_enabled)}::boolean`}, ${lit(r.captured_at)}::timestamptz)`).join(",\n")};`,
].join("\n");

// ---------------------------------------------------------------- shared SQL pieces
const CONTENT_MD5 = { profiles: `(SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.id), '')) FROM public.profiles x)`,
  _d2a_resync_backup: `(SELECT md5(coalesce(string_agg(to_jsonb(x)::text, ',' ORDER BY x.station_id), '')) FROM public._d2a_resync_backup x)` };
const WANT_CONTENT = { profiles: B.profiles_md5, _d2a_resync_backup: B.d2a_md5 };
const COLS_SQL = (t) => `(SELECT string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || CASE WHEN a.attnotnull THEN 'NO' ELSE 'YES' END || ':' || coalesce(pg_get_expr(d.adbin, d.adrelid), ''), ',' ORDER BY a.attnum)
         FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum WHERE a.attrelid = 'public.${t}'::regclass AND a.attnum > 0 AND NOT a.attisdropped)`;
const CON_SQL = (t) => `(SELECT md5(string_agg(conname || '|' || pg_get_constraintdef(oid), ',' ORDER BY conname COLLATE "C")) FROM pg_constraint WHERE conrelid = 'public.${t}'::regclass AND contype <> 'n')`;
const CON_PIN = (t) => md5(Object.entries(S0.tables[t].constraints).sort(byC).map(([n, d]) => `${n}|${d}`).join(","));
const IDX_SQL = (t) => `(SELECT string_agg(pg_get_indexdef(indexrelid), ';' ORDER BY indexrelid::regclass::text COLLATE "C") FROM pg_index WHERE indrelid = 'public.${t}'::regclass)`;
const IDX_PIN = (t) => Object.entries(S0.tables[t].indexes).sort(byC).map(([, d]) => d).join(";");
const PRIVS_SQL = (t) => `(SELECT string_agg(rl.rolname || '=' || coalesce((SELECT string_agg(pv.priv, '+' ORDER BY pv.priv) FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) pv(priv)
           WHERE has_table_privilege(rl.rolname, 'public.${t}', pv.priv)), ''), ',' ORDER BY rl.rolname) FROM unnest(ARRAY['anon','authenticated','service_role']) rl(rolname))`;
const PRIVS_PIN = (t) => { const g = Object.fromEntries(grantees(S0.tables[t].acl).map((x) => [x.who, x.privs])); return ["anon", "authenticated", "service_role"].map((r) => `${r}=${(g[r] || []).sort().join("+")}`).join(","); };
const SHAPE_OK = (t) => `${COLS_SQL(t)} = '${q(colSig(t))}'
       AND ${CON_SQL(t)} = '${CON_PIN(t)}'
       AND ${IDX_SQL(t)} = '${q(IDX_PIN(t))}'
       AND obj_description('public.${t}'::regclass, 'pg_class') = '${q(S0.tables[t].comment)}'
       AND (SELECT relrowsecurity AND NOT relforcerowsecurity FROM pg_class WHERE oid = 'public.${t}'::regclass)
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = '${t}')
       AND NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.${t}'::regclass AND NOT tgisinternal)
       AND ${PRIVS_SQL(t)} = '${PRIVS_PIN(t)}'`;
const RE = "(\\mprofiles\\M|_d2a_resync_backup)";
// every reference the Step 0 scanned for — anywhere in the database. Each must be EMPTY, or the migration refuses NAMING it.
const REFS = [
  ["a function body (any schema)", `(SELECT string_agg(p.oid::regprocedure::text, ', ') FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname NOT IN ('pg_catalog', 'information_schema') AND p.prosrc ~ '${RE}')`],
  ["a policy expression", `(SELECT string_agg(schemaname || '.' || tablename || '.' || policyname, ', ') FROM pg_policies WHERE coalesce(qual, '') ~ '${RE}' OR coalesce(with_check, '') ~ '${RE}')`],
  ["a view / matview definition", `(SELECT string_agg(c.oid::regclass::text, ', ') FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relkind IN ('v', 'm') AND n.nspname NOT IN ('pg_catalog', 'information_schema') AND pg_get_viewdef(c.oid) ~ '${RE}')`],
  ["a rule", `(SELECT string_agg(schemaname || '.' || tablename || '.' || rulename, ', ') FROM pg_rules WHERE definition ~ '${RE}')`],
  ["a foreign key pointing at it", `(SELECT string_agg(conrelid::regclass::text || '.' || conname, ', ') FROM pg_constraint WHERE contype = 'f' AND confrelid IN ('public.profiles'::regclass, 'public._d2a_resync_backup'::regclass))`],
  ["a trigger / policy on it", `(SELECT string_agg(x, ', ') FROM (SELECT tgname::text AS x FROM pg_trigger WHERE tgrelid IN ('public.profiles'::regclass, 'public._d2a_resync_backup'::regclass) AND NOT tgisinternal
       UNION ALL SELECT policyname::text FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('profiles', '_d2a_resync_backup')) z)`],
  ["a publication", `(SELECT string_agg(pubname || ':' || tablename, ', ') FROM pg_publication_tables WHERE schemaname = 'public' AND tablename IN ('profiles', '_d2a_resync_backup'))`],
  ["a dependent object (pg_depend)", `(SELECT string_agg(DISTINCT pg_describe_object(dp.classid, dp.objid, dp.objsubid), ', ') FROM pg_depend dp JOIN pg_class c ON c.oid = dp.refobjid
       WHERE dp.refclassid = 'pg_class'::regclass AND c.oid IN ('public.profiles'::regclass, 'public._d2a_resync_backup'::regclass)
         AND NOT (dp.classid = 'pg_class'::regclass AND dp.objid = c.oid)
         AND NOT (dp.classid = 'pg_type'::regclass AND dp.objid IN (c.reltype, (SELECT typarray FROM pg_type WHERE oid = c.reltype)))
         AND NOT (dp.classid = 'pg_constraint'::regclass AND dp.objid IN (SELECT oid FROM pg_constraint WHERE conrelid = c.oid))
         AND NOT (dp.classid = 'pg_class'::regclass AND dp.objid IN (SELECT indexrelid FROM pg_index WHERE indrelid = c.oid))
         AND NOT (dp.classid = 'pg_class'::regclass AND dp.objid = c.reltoastrelid)
         AND NOT (dp.classid = 'pg_attrdef'::regclass AND dp.objid IN (SELECT oid FROM pg_attrdef WHERE adrelid = c.oid)))`],
];
const FN_SET = `(SELECT md5(string_agg(md5(pg_get_functiondef(p.oid)) || coalesce(p.proacl::text, ''), ',' ORDER BY p.oid::regprocedure::text COLLATE "C")) FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prokind = 'f')`;
const FN_N = `(SELECT count(*) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND prokind = 'f')`;
const POL_SET = `(SELECT md5(string_agg(tablename || '|' || policyname || '|' || cmd || '|' || roles::text || '|' || coalesce(qual, '') || '|' || coalesce(with_check, ''), ',' ORDER BY tablename COLLATE "C", policyname COLLATE "C")) FROM pg_policies WHERE schemaname = 'public')`;
const POL_N = `(SELECT count(*) FROM pg_policies WHERE schemaname = 'public')`;
const TRG_SET = `(SELECT md5(string_agg(c.relname || '.' || t.tgname || '|' || pg_get_triggerdef(t.oid), ',' ORDER BY c.relname COLLATE "C", t.tgname COLLATE "C")) FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal)`;
const REL_LIST = `(SELECT md5(string_agg(c.relname || ':' || c.relkind::text, ',' ORDER BY c.relname COLLATE "C")) FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm'))`;
const REL_N = `(SELECT count(*) FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind IN ('r', 'p', 'v', 'm'))`;
const REL_PIN = md5(P.relations.join(","));
const REL_AFTER_PIN = md5(P.relations.filter((r) => !/^(profiles|_d2a_resync_backup):/.test(r)).join(","));
// every OTHER public base table's rows: per-table md5 of its rows (as text), computed before and after in the same transaction
const OTHER_ROWS = (into) => `    ${into} := '{}'::jsonb;
    FOR r IN SELECT c.relname FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p')
               AND c.relname NOT IN ('profiles', '_d2a_resync_backup') ORDER BY c.relname COLLATE "C" LOOP
      EXECUTE format('SELECT md5(coalesce(string_agg(x::text, %L ORDER BY x::text COLLATE "C"), %L)) FROM public.%I x', E'\\n', '', r.relname) INTO v_t;
      ${into} := ${into} || jsonb_build_object(r.relname, v_t);
    END LOOP;`;

// ================================================================ the BACKUP (first)
out["sql/l3_backup_rows.sql"] = `-- =====================================================================
-- L-3 BACKUP — every row of public.profiles and public._d2a_resync_backup at capture (${B.read_at.slice(0, 16)} UTC), as INSERTs.
-- GENERATED by docs/review/l3_build.mjs from docs/review/l3_BACKUP_LIVE.json (sql/l3_BACKUP_CAPTURE.sql, read-only).
-- Committed BEFORE any drop, so the drop is reversible: re-create the tables (sql/l3_drop_dead_tables_ROLLBACK.sql does both — the
-- captured DDL, then exactly these rows) and the content md5s below must come back byte-identical.
--   profiles             ${B.profiles_rows.length} rows   md5 ${B.profiles_md5}
--   _d2a_resync_backup   ${B.d2a_rows.length} rows   md5 ${B.d2a_md5}   (D2a's rollback store for the 5 DEFAULT stations' pre-resync geo columns)
-- The DRAFT refuses to drop unless the live content md5s still equal these — the backup is the content being dropped.
-- Standalone use (tables already re-created, empty): run as-is, then the check at the bottom.
-- =====================================================================
BEGIN;
${INSERTS()}
COMMIT;

-- check (expect both true):
SELECT set_config('TimeZone', 'UTC', true) AS tz,
       ${CONTENT_MD5.profiles} = '${B.profiles_md5}' AS profiles_restored,
       ${CONTENT_MD5._d2a_resync_backup} = '${B.d2a_md5}' AS d2a_restored;
`;

// ================================================================ DRAFT
out["sql/l3_drop_dead_tables_DRAFT.sql"] = `-- =====================================================================
-- L-3 — DROP the two dead tables: public.profiles + public._d2a_resync_backup. DRAFT — NOT APPLIED.
-- ⚑ RESERVED ITEM: applying waits on Ashlea's explicit sign-off NAMING L-3 — not on a general go.
-- GENERATED by docs/review/l3_build.mjs from three read-only live captures (2026-10-31): l3_STEP0_LIVE.json, l3_BACKUP_LIVE.json,
-- l3_PINS_LIVE.json. Step 0 + evidence: claude/B4C_L3_DropDeadTables_Step0.md.
--
-- WHY THEY'RE DEAD (Step 0, live): zero references from any function (any schema), policy, view, rule, trigger (incl. auth.users),
-- publication, pg_cron job or pg_depend dependent; no FK points at either; zero client references (src/ api/ shared/).
--   profiles: 0 rows; 0 inserts/updates/deletes since stats reset 2026-05-22; RLS ON with NO policy → unreachable today.
--   _d2a_resync_backup: 5 rows, written once 2026-08-27 by sql/phaseD2a_per_station_fences.sql ("Not read by the app"); RLS on,
--     no grant to anon/authenticated.
--
-- THE BACKUP COMES FIRST: sql/l3_backup_rows.sql (every row, committed to the branch). The preflight below refuses unless the live
-- content still hashes to exactly what that file restores (profiles ${B.profiles_md5} · _d2a ${B.d2a_md5}).
-- The drops are plain DROP TABLE (RESTRICT, never CASCADE): any dependent the scans somehow missed aborts the whole thing.
--
-- PREFLIGHT (refuses, changes nothing): both tables present; ZERO references (each scan named in the refusal); each table's exact
-- columns + defaults, constraints, indexes, comment, RLS on + no policy/trigger, privileges; content md5s = the backup; the full
-- public function set (md5 of every definition + ACL, ${P.fn_count} functions), the full policy set (${P.policy_count}), the trigger set,
-- and the relation list (${P.relations.length}) = the capture.
-- IN-TRANSACTION PROOF (any miss → RAISE → rollback): relations −2 exactly (the list = before minus the two); function set,
-- policy set, trigger set unchanged; EVERY other public table's rows byte-identical (per-table md5 of every row, before = after);
-- auth.users count unchanged; verified presence unchanged.
-- Dry run: docs/review/l3_DRYRUN.txt. RETEST (after): sql/l3_drop_dead_tables_RETEST.sql. ROLLBACK: sql/l3_drop_dead_tables_ROLLBACK.sql.
-- =====================================================================
DO $migrate$
DECLARE
  r record; v_t text; v_rows_before jsonb; v_rows_after jsonb; v_auth bigint; v_ver bigint; v_rel_n bigint;
BEGIN
  PERFORM set_config('TimeZone', 'UTC', true);   -- the content md5s print timestamps; pin the zone (transaction-local)
  -- ---------------------------------------------------------------- 0. preflight
  IF to_regclass('public.profiles') IS NULL OR to_regclass('public._d2a_resync_backup') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.profiles or public._d2a_resync_backup is already gone — L-3 looks applied. Refusing.';
  END IF;
${REFS.map(([what, sql]) => `  v_t := ${sql};
  IF v_t IS NOT NULL THEN RAISE EXCEPTION 'PREFLIGHT: % references a table on the drop list (%) — it comes off the list. Refusing.', '${q(what)}', v_t; END IF;`).join("\n")}
${T.map((t) => `  IF NOT (${SHAPE_OK(t)}) THEN
    RAISE EXCEPTION 'PREFLIGHT: public.${t} is not the captured table (columns / constraints / indexes / comment / RLS / policies / triggers / privileges). Refusing.';
  END IF;
  IF ${CONTENT_MD5[t]} IS DISTINCT FROM '${WANT_CONTENT[t]}' THEN
    RAISE EXCEPTION 'PREFLIGHT: public.${t} no longer matches the committed backup (sql/l3_backup_rows.sql) — re-capture before dropping. Refusing.';
  END IF;`).join("\n")}
  IF ${FN_SET} IS DISTINCT FROM '${P.fn_set_md5}' OR ${FN_N} <> ${P.fn_count} THEN RAISE EXCEPTION 'PREFLIGHT: the public function set changed since the capture. Refusing.'; END IF;
  IF ${POL_SET} IS DISTINCT FROM '${P.policy_set_md5}' OR ${POL_N} <> ${P.policy_count} THEN RAISE EXCEPTION 'PREFLIGHT: the public policy set changed since the capture. Refusing.'; END IF;
  IF ${TRG_SET} IS DISTINCT FROM '${P.trigger_set_md5}' THEN RAISE EXCEPTION 'PREFLIGHT: the public trigger set changed since the capture. Refusing.'; END IF;
  IF ${REL_LIST} IS DISTINCT FROM '${REL_PIN}' THEN RAISE EXCEPTION 'PREFLIGHT: the public relation list changed since the capture. Refusing.'; END IF;
  v_rel_n := ${REL_N};
  SELECT count(*) INTO v_auth FROM auth.users;
  SELECT count(*) INTO v_ver FROM public.station_presence WHERE verified;
${OTHER_ROWS("v_rows_before")}

  -- ---------------------------------------------------------------- 1. the drops (RESTRICT — never CASCADE)
  DROP TABLE public.profiles;
  DROP TABLE public._d2a_resync_backup;

  -- ---------------------------------------------------------------- 2. post-conditions (in-transaction)
  IF to_regclass('public.profiles') IS NOT NULL OR to_regclass('public._d2a_resync_backup') IS NOT NULL THEN RAISE EXCEPTION 'Post-condition failed: a table is still there. Rolling back.'; END IF;
  IF ${REL_N} <> v_rel_n - 2 OR ${REL_LIST} IS DISTINCT FROM '${REL_AFTER_PIN}' THEN
    RAISE EXCEPTION 'Post-condition failed: the relations are not exactly the capture minus the two. Rolling back.';
  END IF;
  IF ${FN_SET} IS DISTINCT FROM '${P.fn_set_md5}' OR ${FN_N} <> ${P.fn_count} THEN RAISE EXCEPTION 'Post-condition failed: a function changed. Rolling back.'; END IF;
  IF ${POL_SET} IS DISTINCT FROM '${P.policy_set_md5}' OR ${POL_N} <> ${P.policy_count} THEN RAISE EXCEPTION 'Post-condition failed: a policy changed. Rolling back.'; END IF;
  IF ${TRG_SET} IS DISTINCT FROM '${P.trigger_set_md5}' THEN RAISE EXCEPTION 'Post-condition failed: a trigger changed. Rolling back.'; END IF;
${OTHER_ROWS("v_rows_after")}
  IF v_rows_after IS DISTINCT FROM v_rows_before THEN
    SELECT string_agg(k, ', ') INTO v_t FROM jsonb_object_keys(v_rows_before) k WHERE (v_rows_before->k) IS DISTINCT FROM (v_rows_after->k);
    RAISE EXCEPTION 'Post-condition failed: rows changed in % (or a table appeared / vanished). Rolling back.', coalesce(v_t, '(the table set)');
  END IF;
  IF (SELECT count(*) FROM auth.users) <> v_auth THEN RAISE EXCEPTION 'Post-condition failed: auth.users changed. Rolling back.'; END IF;
  IF (SELECT count(*) FROM public.station_presence WHERE verified) <> v_ver THEN RAISE EXCEPTION 'Post-condition failed: verified presence changed. Rolling back.'; END IF;
END
$migrate$;

NOTIFY pgrst, 'reload schema';

-- ---------------------------------------------------------------- state row
SELECT jsonb_build_object(
  'profiles_present', to_regclass('public.profiles') IS NOT NULL,
  'd2a_resync_backup_present', to_regclass('public._d2a_resync_backup') IS NOT NULL,
  'public_relations', ${REL_N},
  'relation_list_md5', ${REL_LIST},
  'fn_set_md5', ${FN_SET}, 'fn_count', ${FN_N},
  'policy_set_md5', ${POL_SET}, 'policy_count', ${POL_N},
  'trigger_set_md5', ${TRG_SET},
  'auth_users', (SELECT count(*) FROM auth.users),
  'verified_presence', (SELECT count(*) FROM public.station_presence WHERE verified)
) AS state;
`;

// ================================================================ the recreate (ROLLBACK, and RETEST R1 inside the SENTINEL)
const RECREATE_ALL = `${RECREATE("profiles")}\n${RECREATE("_d2a_resync_backup")}\n${INSERTS()}`;
const RESTORED_OK = T.map((t) => `(${SHAPE_OK(t)}
       AND ${CONTENT_MD5[t]} = '${WANT_CONTENT[t]}')`).join("\n     AND ");

// ================================================================ RETEST
out["sql/l3_drop_dead_tables_RETEST.sql"] = `-- =====================================================================
-- RETEST for l3_drop_dead_tables. READ-ONLY IN EFFECT — run AFTER the migration, separately. GENERATED with it.
-- One sub-block ending in RAISE 'SENTINEL' (rolled back) — the re-create in R1 never stays. The final RAISE is the report.
--   S0 both tables are gone; the relation list = the capture minus the two; the function / policy / trigger sets = the capture
--   R1 THE DROP IS REVERSIBLE: the ROLLBACK's re-create (the captured DDL + every backed-up row) runs, and the tables come back
--      exactly — columns + defaults, constraints (incl. profiles → auth.users / members / departments), indexes, comment, RLS on
--      with no policy, privileges — with content md5s byte-identical to the backup (profiles ${B.profiles_md5.slice(0, 8)} · _d2a ${B.d2a_md5.slice(0, 8)})
--   R2 …and are still unreachable from the API: anon / authenticated read nothing
-- =====================================================================
DO $retest$
DECLARE rpt text := ''; v_pass int := 0; v_fail int := 0;
BEGIN
  BEGIN
    PERFORM set_config('TimeZone', 'UTC', true);
    IF to_regclass('public.profiles') IS NULL AND to_regclass('public._d2a_resync_backup') IS NULL AND ${REL_LIST} = '${REL_AFTER_PIN}'
       AND ${FN_SET} = '${P.fn_set_md5}' AND ${POL_SET} = '${P.policy_set_md5}' AND ${TRG_SET} = '${P.trigger_set_md5}' THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  S0 both tables gone; relations = the capture minus the two; the function / policy / trigger sets unchanged' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  S0 the drop is not in place as intended' || chr(10); END IF;

    -- R1 — the ROLLBACK's re-create, verbatim (generated from the same capture), then the exact-shape + exact-content proof
${RECREATE_ALL.replace(/^/gm, "  ")}
    IF ${RESTORED_OK} THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  R1 reversible: the captured DDL + the backup re-create both tables exactly (shape, constraints, RLS, privileges) with content md5s = the backup' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  R1 the re-create does not reproduce the captured tables' || chr(10); END IF;

    -- R2 — the re-created tables are as unreachable as the originals (RLS on, no policy; _d2a with no grant)
    IF NOT has_table_privilege('anon', 'public.profiles', 'SELECT') AND NOT has_table_privilege('anon', 'public._d2a_resync_backup', 'SELECT')
       AND NOT has_table_privilege('authenticated', 'public._d2a_resync_backup', 'SELECT')
       AND NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('profiles', '_d2a_resync_backup')) THEN
      v_pass := v_pass + 1; rpt := rpt || 'PASS  R2 re-created, they are as unreachable as before: no anon grant, no policy (RLS denies authenticated on profiles), no grant on _d2a' || chr(10);
    ELSE v_fail := v_fail + 1; rpt := rpt || 'FAIL  R2 the re-created tables are reachable' || chr(10); END IF;

    RAISE EXCEPTION 'SENTINEL';
  EXCEPTION WHEN OTHERS THEN
    IF SQLERRM <> 'SENTINEL' THEN v_fail := v_fail + 1; rpt := rpt || format('FAIL  the RETEST block aborted: %s%s', SQLERRM, chr(10)); END IF;
  END;
  RAISE EXCEPTION '%', rpt || format('%s passed, %s failed, 0 skipped', v_pass, v_fail);
END
$retest$;
`;

// ================================================================ ROLLBACK
out["sql/l3_drop_dead_tables_ROLLBACK.sql"] = `-- =====================================================================
-- ROLLBACK for l3_drop_dead_tables — re-create both tables from the CAPTURED DDL and restore every backed-up row
-- (the same rows as sql/l3_backup_rows.sql), then prove shape + content are byte-identical to the capture. GENERATED.
-- Refuses unless both tables are absent.
-- =====================================================================
DO $rollback$
BEGIN
  PERFORM set_config('TimeZone', 'UTC', true);
  IF to_regclass('public.profiles') IS NOT NULL OR to_regclass('public._d2a_resync_backup') IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK: a table on the L-3 list still exists — nothing to restore. Refusing.';
  END IF;
${RECREATE_ALL}
  IF NOT (${RESTORED_OK}) OR ${REL_LIST} IS DISTINCT FROM '${REL_PIN}' THEN
    RAISE EXCEPTION 'ROLLBACK post-condition: the re-created tables are not exactly the captured ones. Rolling back.';
  END IF;
END
$rollback$;

NOTIFY pgrst, 'reload schema';
`;

// ================================================================ change list
out["docs/review/l3_CHANGE_LIST.md"] = `# L-3 — change list (GENERATED by docs/review/l3_build.mjs from the 2026-10-31 live captures)

| object | before (live) | after |
|---|---|---|
| \`public.profiles\` | 0 rows · RLS on, no policy · authenticated ALL (denied by RLS) · FKs → auth.users / members / departments | **dropped** (RESTRICT) |
| \`public._d2a_resync_backup\` | ${B.d2a_rows.length} rows (2026-08-27) · RLS on, no policy · service_role only | **dropped** (RESTRICT) |
| backup | — | \`sql/l3_backup_rows.sql\` — every row; content md5s ${B.profiles_md5.slice(0, 8)} / ${B.d2a_md5.slice(0, 8)} |
| public relations | ${P.relations.length} | ${P.relations.length - 2} |
| functions / policies / triggers | ${P.fn_count} (\`${P.fn_set_md5.slice(0, 8)}\`) / ${P.policy_count} (\`${P.policy_set_md5.slice(0, 8)}\`) / \`${P.trigger_set_md5.slice(0, 8)}\` | **unchanged** |
| every other table's rows · auth.users · verified | — | **unchanged** (proven in the transaction) |
`;

// ---------------------------------------------------------------- write or check
const check = process.argv.includes("--check");
let bad = 0;
for (const [p, s] of Object.entries(out)) {
  if (check) { let cur = null; try { cur = readFileSync(join(root, p), "utf8"); } catch { /* missing */ } if (cur !== s) { console.log(`DIFFERS ${p}`); bad++; } else console.log(`same    ${p}`); }
  else { writeFileSync(join(root, p), s); console.log(`wrote   ${p} (${s.length} bytes)`); }
}
if (check && bad) process.exit(1);
