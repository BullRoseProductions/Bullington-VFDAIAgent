// PGLITE_DIR=<dir with @electric-sql/pglite installed> node docs/review/ws3_dryrun_harness.mjs
// DRY RUN for sql/ws3_certproof_privacy_DRAFT.sql + its RETEST — NOT the live DB. Mock: storage.objects + storage.foldername
// (LIVE body) with the 6 LIVE storage policies verbatim (docs/review/ws3_LIVEDEFS.json), the LIVE gate/identity functions
// (is_leader, my_department_id, my_member_id, is_canmanage_ops, is_dept_admin — from docs/review/fe_b_db_LIVEDEFS.json,
// read the same day), Supabase-style grants. is_equipment_manager is a stub (only an INSERT policy uses it; unpinned).
// Runs: pins -> migration -> state row -> re-run (must refuse) -> RETEST -> drift refusals -> mutations (each must be
// refused by the migration or turn a RETEST line red). NOTE: PGlite runs as a superuser, so D3 (storage.objects
// ownership on Supabase) is NOT exercised here.
import { readFileSync } from "fs";
import { createRequire } from "module";
import { join } from "path";
import { fileURLToPath, pathToFileURL } from "url";
const root = fileURLToPath(new URL("../../", import.meta.url));
const req = createRequire(join(process.env.PGLITE_DIR || root, "package.json"));
const { PGlite } = await import(pathToFileURL(req.resolve("@electric-sql/pglite").replace(/index\.cjs$/, "index.js")).href);
const W = JSON.parse(readFileSync(join(root, "docs/review/ws3_LIVEDEFS.json"), "utf8"));
const F = JSON.parse(readFileSync(join(root, "docs/review/fe_b_db_LIVEDEFS.json"), "utf8"));
const MIG = readFileSync(join(root, "sql/ws3_certproof_privacy_DRAFT.sql"), "utf8");
const RET = readFileSync(join(root, "sql/ws3_certproof_privacy_RETEST.sql"), "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
const A1 = "00000000-0000-0000-0000-0000000000a1", A2 = "00000000-0000-0000-0000-0000000000a2", GONE = "00000000-0000-0000-0000-0000000000ff";
const B1 = "00000000-0000-0000-0000-0000000000b1";
const def = (k) => F.defs[k].def + ";\n";
const pol = W.storage_policies.map((p) => `CREATE POLICY "${p.name}" ON storage.objects FOR ${p.cmd} TO ${p.roles}${p.qual ? ` USING (${p.qual})` : ""}${p.check ? ` WITH CHECK (${p.check})` : ""};\n`).join("");

const schema = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth; CREATE SCHEMA storage;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public, storage TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION auth.email() TO anon, authenticated, service_role;
CREATE TABLE departments (id uuid PRIMARY KEY, name text NOT NULL);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id), name text NOT NULL,
  access text[] NOT NULL DEFAULT ARRAY['Member'::text], status text DEFAULT 'Active'::text, email text);
CREATE TABLE member_active_department (email text PRIMARY KEY, department_id uuid NOT NULL);
CREATE TABLE station_presence (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, verified boolean NOT NULL DEFAULT false);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text, name text, owner uuid, created_at timestamptz DEFAULT now());
GRANT ALL ON storage.objects TO anon, authenticated, service_role;
GRANT SELECT ON public.members, public.departments, public.member_active_department TO authenticated;
${W.foldername_def};
` + ["my_department_id()", "my_member_id()", "is_leader()", "is_canmanage_ops()", "is_dept_admin()"].map(def).join("") + `
CREATE FUNCTION public.is_equipment_manager() RETURNS boolean LANGUAGE sql STABLE AS $$ select false $$;   -- STUB
DO $$ DECLARE f regprocedure; BEGIN
  FOR f IN SELECT p.oid::regprocedure FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace LOOP
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC, anon', f); EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', f); END LOOP; END $$;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
${pol}
INSERT INTO departments VALUES ('${A}', 'Alpha (mock)'), ('${B}', 'Bravo (mock)');
INSERT INTO members (id, department_id, name, email, access) VALUES
  ('${A1}', '${A}', 'A owner 1', 'a1@a.test', '{Member}'), ('${A2}', '${A}', 'A owner 2', 'a2@a.test', '{Member}'),
  (gen_random_uuid(), '${A}', 'A DA', 'da@a.test', '{Department Admin}'), ('${B1}', '${B}', 'B owner', 'b1@b.test', '{Member}');
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('station-documents', '${A}/cert-proofs/${A1}/1-cpr.pdf'), ('station-documents', '${A}/cert-proofs/${A1}/2-emt.jpg'),
  ('station-documents', '${A}/cert-proofs/${A2}/3-dl.jpg'), ('station-documents', '${A}/cert-proofs/${GONE}/4-orphan.pdf'),
  ('station-documents', '${A}/plans/5-plan.pdf'), ('station-documents', '${A}/plans/6-plan.pdf'), ('station-documents', '${A}/7-sop.pdf'),
  ('station-documents', '${B}/cert-proofs/${B1}/8-ff1.pdf'), ('station-documents', '${B}/minutes/9-min.pdf');
INSERT INTO station_presence (department_id, verified) VALUES ('${A}', true), ('${B}', true);
`;
const firstLine = (e) => String(e.message || e).split("\n")[0];
const report = (e) => String(e.message || e).split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
async function fresh() { const db = new PGlite(); await db.exec(schema); return db; }
const log = (s) => console.log(s);

{ const db = await fresh();
  const pins = Object.fromEntries([...MIG.matchAll(/'((?:public|storage)\.[a-z_]+\([^']*\))',\s+'([0-9a-f]{32})'/g)].map((m) => [m[1], m[2]]));
  let ok = 0; const bad = [];
  for (const [sig, md5] of Object.entries(pins)) { const r = await db.query(`select md5(pg_get_functiondef(to_regprocedure($1))) m`, [sig]); if (r.rows[0].m === md5) ok++; else bad.push(sig); }
  log(`pins: ${ok}/${Object.keys(pins).length} mock bodies md5-equal to the live pins ${bad.length ? JSON.stringify(bad) : ""}`);
  if (bad.length) process.exitCode = 1;
  await db.close(); }

{ const db = await fresh();
  // BEFORE: the leak the audit found, reproduced in the mock
  await db.exec(`SELECT set_config('request.jwt.claims', '{"email":"a2@a.test"}', false); SET ROLE authenticated;`);
  const before = (await db.query(`SELECT count(*)::int n FROM storage.objects WHERE (storage.foldername(name))[2] = 'cert-proofs' AND (storage.foldername(name))[3] <> '${A2}'`)).rows[0].n;
  await db.exec(`RESET ROLE;`);
  log(`before: member a2 can read ${before} cert-proof file(s) that aren't theirs (the M-4 leak, reproduced)`);
  await db.exec(MIG);
  const st = await db.query(MIG.slice(MIG.indexOf("SELECT jsonb_build_object(")));
  log("migration: applied. state row: " + JSON.stringify(st.rows[0].state));
  await db.exec(`SELECT set_config('request.jwt.claims', '{"email":"a2@a.test"}', false); SET ROLE authenticated;`);
  const after = (await db.query(`SELECT count(*) FILTER (WHERE (storage.foldername(name))[2] = 'cert-proofs')::int cp, count(*)::int alln FROM storage.objects`)).rows[0];
  await db.exec(`RESET ROLE;`);
  log(`after: member a2 reads ${after.cp} cert-proof file(s) (own only) of ${after.alln} visible objects`);
  try { await db.exec(MIG); log("FAIL re-run was NOT refused"); process.exitCode = 1; } catch (e) { log("re-run: refused -> " + firstLine(e)); }
  try { await db.exec(RET); log("FAIL RETEST did not end in its report"); } catch (e) { log("RETEST:\n" + report(e)); }
  await db.close(); }

for (const [label, sql] of [
  ["is_leader() drifted", `CREATE OR REPLACE FUNCTION public.is_leader() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$ select true $$;`],
  ["the read policy drifted", `ALTER POLICY station_docs_read_own_dept ON storage.objects USING (true);`],
]) { const db = await fresh(); await db.exec(sql);
  try { await db.exec(MIG); log(`FAIL drift "${label}" NOT refused`); process.exitCode = 1; } catch (e) { log(`drift "${label}": refused -> ${firstLine(e)}`); }
  await db.close(); }

const MUT = [
  ["M1 carve-out not applied (read stays department-wide)", (s) => s.replace(`AND (storage.foldername(name))[2] IS DISTINCT FROM 'cert-proofs') $p$;`, `AND true) $p$;`)],
  ["M2 owner can't read their own (leaders only)", (s) => s.replace(`AND ((storage.foldername(name))[3] = (public.my_member_id())::text OR public.is_leader())`, `AND public.is_leader()`)],
  ["M3 leaders narrowed to is_canmanage_ops (Board + PA lose it)", (s) => s.replace(`OR public.is_leader())) $p$;`, `OR public.is_canmanage_ops())) $p$;`)],
  ["M4 owner-or-leader read without the department check", (s) => s.replace(`AND (storage.foldername(name))[1] = (public.my_department_id())::text
                       AND (storage.foldername(name))[2] = 'cert-proofs'`, `AND (storage.foldername(name))[2] = 'cert-proofs'`)],
  ["M5 any member reads any proof (owner check dropped)", (s) => s.replace(`AND ((storage.foldername(name))[3] = (public.my_member_id())::text OR public.is_leader())`, ``)],
  ["M6 another storage policy touched", (s) => s.replace(`  -- ---------------------------------------------------------------- 2. post-conditions`, `  EXECUTE 'ALTER POLICY station_docs_delete_leadership ON storage.objects USING (true)';\n  -- ---------------------------------------------------------------- 2. post-conditions`)],
];
log("mutations:");
for (const [label, fn] of MUT) {
  const m = fn(MIG); if (m === MIG) { log(`   ${label}: MUTATION DID NOT APPLY (harness bug)`); process.exitCode = 1; continue; }
  const db = await fresh();
  try { await db.exec(m); } catch (e) { log(`   ${label}: migration REFUSED -> ${firstLine(e)}`); await db.close(); continue; }
  try { await db.exec(RET); } catch (e) {
    const r = report(e); const fails = r.split("\n").filter((l) => /FAIL/.test(l));
    log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 3).map((l) => "      " + l.trim()).join("\n")}\n      ${r.split("\n").pop()}`);
    if (!fails.length) process.exitCode = 1;
  }
  await db.close();
}

// POST-APPLY drift: the migration is applied correctly, then the live state is corrupted (as a later hand edit would);
// the RETEST alone must go red — proves it doesn't lean on the migration's own post-conditions.
const DRIFT = [
  ["D1 read policy re-widened to the whole department", `ALTER POLICY station_docs_read_own_dept ON storage.objects USING (bucket_id = 'station-documents' AND (storage.foldername(name))[1] = (public.my_department_id())::text);`],
  ["D2 owner-or-leader loses the owner arm", `ALTER POLICY cert_proofs_read_owner_or_leader ON storage.objects USING (bucket_id = 'station-documents' AND (storage.foldername(name))[1] = (public.my_department_id())::text AND (storage.foldername(name))[2] = 'cert-proofs' AND public.is_leader());`],
  ["D3 leaders narrowed to DA/Officer", `ALTER POLICY cert_proofs_read_owner_or_leader ON storage.objects USING (bucket_id = 'station-documents' AND (storage.foldername(name))[1] = (public.my_department_id())::text AND (storage.foldername(name))[2] = 'cert-proofs' AND ((storage.foldername(name))[3] = (public.my_member_id())::text OR public.is_canmanage_ops()));`],
  ["D4 department check dropped", `ALTER POLICY cert_proofs_read_owner_or_leader ON storage.objects USING (bucket_id = 'station-documents' AND (storage.foldername(name))[2] = 'cert-proofs' AND ((storage.foldername(name))[3] = (public.my_member_id())::text OR public.is_leader()));`],
  ["D5 any authenticated member reads every proof", `ALTER POLICY cert_proofs_read_owner_or_leader ON storage.objects USING (bucket_id = 'station-documents' AND (storage.foldername(name))[1] = (public.my_department_id())::text AND (storage.foldername(name))[2] = 'cert-proofs');`],
  ["D6 anon handed a read", `CREATE POLICY anon_read ON storage.objects FOR SELECT TO anon USING (true);`],
];
log("post-apply drift (RETEST alone must catch):");
for (const [label, sql] of DRIFT) {
  const db = await fresh(); await db.exec(MIG); await db.exec(sql);
  try { await db.exec(RET); } catch (e) {
    const r = report(e); const fails = r.split("\n").filter((l) => /FAIL/.test(l));
    log(`   ${label}:${fails.length ? "" : "  !! NOT CAUGHT"}\n${fails.slice(0, 2).map((l) => "      " + l.trim()).join("\n")}\n      ${r.split("\n").pop()}`);
    if (!fails.length) process.exitCode = 1;
  }
  await db.close();
}
