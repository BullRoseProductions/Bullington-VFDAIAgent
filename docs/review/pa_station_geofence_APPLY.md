# PA geofence honesty: SQL apply record

- **Applied:** 2026-11-02, Supabase SQL editor (project `ifeptqnlucmvhlvadcpj`), on Ashlea's go with gate PASS @951fb0a.
- **File:** `sql/pa_station_geofence_honesty.sql`. The editor text was SHA-256 checked before Run: `0359c8d213f76b6517e7d1efd5856a511dcb05288484627cf459a0c10ab366d4`, an exact match.
- **Run:** the editor's destructive-operation prompt (for the `DROP FUNCTION`) was confirmed. The preconditions passed (the live `pa_department_stations` had the expected six-column shape), the in-transaction post-conditions passed, and it committed.

## State check (the file's closing SELECT)
| fn | definer | vol | anon_exec | auth_exec | returns |
|---|---|---|---|---|---|
| `pa_department_stations(p_department_id uuid)` | true | s | false | true | `TABLE(station_id uuid, name text, label text, address text, is_default boolean, is_active boolean, lat double precision, lng double precision, radius_m integer, geofence_enabled boolean)` |
| `pa_set_station_geofence(p_station_id uuid, p_enabled boolean)` | true | v | false | true | `uuid` |

## Live RETEST
`sql/pa_station_geofence_honesty_RETEST.sql`, editor text SHA-256 checked (`717fc7cc…128529d`, exact match). Fixtures were inserted in Indian Harbor Volunteer Fire Department and rolled back by the sentinel.

**8 passed, 0 failed, 0 skipped**: G0, N1, R1, E1, E2, E3, E4, E5.

## After (read-only)
- **Fixture stations left:** 0.
- **North Hood:** Station 20 `geofence_enabled=false`, department master `true`. This is unchanged: the apply set no switch. Turning Station 20 on is a separate in-app step (PA card or DA station editor) on Ashlea's say-so.
