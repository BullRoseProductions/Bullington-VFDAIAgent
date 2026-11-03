// PGlite dry run for sql/pa_station_geofence_honesty.sql + its RETEST. Not part of the suite (no ^PASS lines);
// run by hand: PGLITE_DIR=<dir with @electric-sql/pglite> node docs/review/pa_station_geofence_dryrun_harness.mjs. Output recorded in pa_station_geofence_DRYRUN.txt.
import { readFileSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
const { PGlite } = await import(pathToFileURL(join(process.env.PGLITE_DIR, "node_modules/@electric-sql/pglite/dist/index.js")).href);
const R = new URL("../../sql/", import.meta.url);
const mig = readFileSync(new URL("pa_station_geofence_honesty.sql", R), "utf8");
const ret = readFileSync(new URL("pa_station_geofence_honesty_RETEST.sql", R), "utf8");
const A = "00000000-0000-0000-0000-00000000000a", B = "00000000-0000-0000-0000-00000000000b";
// The live shape this file was written against: stations (Phase A), is_project_admin (pa_department_radar.sql),
// and the six-column pa_department_stations (stations_pa_manage.sql), with its revoke applied.
const mock = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE SCHEMA auth;
CREATE FUNCTION auth.email() RETURNS text LANGUAGE sql STABLE AS $$ select (nullif(current_setting('request.jwt.claims', true), '')::json)->>'email' $$;
GRANT USAGE ON SCHEMA auth, public TO anon, authenticated;
CREATE TABLE departments (id uuid PRIMARY KEY, name text, geofence_enabled boolean DEFAULT false);
CREATE TABLE members (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid, email text, name text, access text[], status text DEFAULT 'Active');
CREATE TABLE stations (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), department_id uuid NOT NULL REFERENCES departments(id), name text NOT NULL, label text, address text,
  lat double precision, lng double precision, radius_m integer, geofence_enabled boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true,
  is_default boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX stations_one_default_per_department ON stations (department_id) WHERE is_default;
ALTER TABLE stations ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION is_project_admin() RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $$
  select exists (select 1 from members where lower(members.email) = lower(auth.email()) and members.access && array['Project Admin']::text[]) $$;
CREATE FUNCTION public.pa_department_stations(p_department_id uuid)
 RETURNS TABLE(station_id uuid, name text, label text, address text, is_default boolean, is_active boolean)
 LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
begin
  if not is_project_admin() then raise exception 'Not authorized'; end if;
  return query select s.id, s.name, s.label, s.address, s.is_default, s.is_active from stations s where s.department_id = p_department_id order by s.is_default desc, s.name;
end; $function$;
REVOKE EXECUTE ON FUNCTION public.pa_department_stations(uuid) FROM anon, public; GRANT EXECUTE ON FUNCTION public.pa_department_stations(uuid) TO authenticated;
INSERT INTO departments VALUES ('${A}','North Hood County', true),('${B}','Lipan', false);
INSERT INTO members (department_id,email,name,access) VALUES
 ('${A}','pa@x','The PA','{Member,Project Admin}'),('${A}','da@a','A DA','{Department Admin}'),('${A}','m1@a','A M1','{Member}'),
 ('${B}','da@b','B DA','{Department Admin}'),('${B}','m1@b','B M1','{Member}');
INSERT INTO stations (department_id,name,lat,lng,radius_m,geofence_enabled,is_default) VALUES ('${A}','Station 20',32.4,-97.8,400,false,true);
`;
const show = (e) => e.message.split("\n").filter((l) => /PASS|FAIL|SKIP|passed|—/.test(l)).join("\n");
const brief = (e) => e.message.split("\n").filter((l) => /FAIL|passed/.test(l)).join(" | ");
async function db0() { const d = new PGlite(); await d.exec(mock); return d; }

let d = await db0();
const res = await d.exec(mig);
console.log("state:", JSON.stringify(res.at(-1).rows));
try { await d.exec(mig); } catch (e) { console.log("re-run ->", e.message.split("\n")[0]); await d.exec("ROLLBACK"); }
try { await d.exec(ret); } catch (e) { console.log(show(e)); }
// Real Station 20 untouched by the RETEST (sentinel rollback)
console.log("Station 20 after RETEST:", JSON.stringify((await d.query("select geofence_enabled, lat, radius_m from stations where name='Station 20'")).rows));
// BEFORE the migration the RETEST must not pass (the function doesn't exist)
const dBefore = await db0(); try { await dBefore.exec(ret); } catch (e) { console.log("BEFORE the migration ->", e.message.split("\n")[0]); }

const sub = (a, b) => { if (!mig.includes(a)) throw new Error("anchor missing: " + a.slice(0, 60)); return mig.replace(a, () => b); };
const mutations = [
  ["M1 setter gate dropped", sub("  -- PA-only gate\n  if not is_project_admin() then\n    raise exception 'Not authorized';\n  end if;\n\n  select s.lat", "  select s.lat")],
  ["M2 pin rule dropped", sub("  if v_on and (v_lat is null or v_lng is null) then\n    raise exception 'Give this house a location before switching its fence on.';\n  end if;\n", "")],
  ["M3 pin rule reworded", sub("raise exception 'Give this house a location before switching its fence on.';", "raise exception 'No pin.';")],
  ["M4 setter also writes radius_m", sub("     set geofence_enabled = v_on\n", "     set geofence_enabled = v_on, radius_m = 150\n")],
  ["M5 setter writes the department master too", sub("  returning s.id into v_id;\n\n  return v_id;", "  returning s.id into v_id;\n  update departments set geofence_enabled = v_on where id = (select department_id from stations where id = p_station_id);\n  return v_id;")],
  ["M6 grants not re-applied after DROP", sub("REVOKE EXECUTE ON FUNCTION public.pa_department_stations(uuid)           FROM anon, public;\n", "")],
  ["M7 read omits geofence_enabled value (returns false)", sub("           s.lat, s.lng, s.radius_m, s.geofence_enabled\n", "           s.lat, s.lng, s.radius_m, false\n")],
  ["M8 not-found check dropped", sub("  if not found then\n    raise exception 'Station not found';\n  end if;\n\n  -- The DA editor's rule", "  -- The DA editor's rule")],
  ["M9 setter ignores p_enabled (always true)", sub("  v_on  boolean := coalesce(p_enabled, false);", "  v_on  boolean := true;")],
  ["M10 read gate dropped", sub("begin\n  -- PA-only gate\n  if not is_project_admin() then\n    raise exception 'Not authorized';\n  end if;\n\n  return query", "begin\n  return query")],
];
for (const [label, m] of mutations) {
  const x = await db0();
  try { await x.exec(m); try { await x.exec(ret); } catch (e) { console.log(label, "->", brief(e)); } }
  catch (e) { console.log(label, "-> migration refused:", e.message.split("\n")[0]); }
}
// Precondition: an unexpected live shape stops the file before the DROP
{ const x = await db0(); await x.exec("DROP FUNCTION pa_department_stations(uuid); CREATE FUNCTION pa_department_stations(p_department_id uuid) RETURNS TABLE(station_id uuid) LANGUAGE sql AS $$ select null::uuid $$;");
  try { await x.exec(mig); console.log("P1 unexpected shape -> APPLIED (bad)"); } catch (e) { await x.exec("ROLLBACK"); console.log("P1 unexpected live shape ->", e.message.split("\n")[0]); } }
