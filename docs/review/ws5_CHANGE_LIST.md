# WS-5 — the exact change list (generated from the live capture, 2026-10-28)

## Part 1 · `sql/ws5_public_rls_DRAFT.sql`

### Anon loses every privilege on 56 relations + 1 sequence (REVOKE ALL … FROM anon)

| relation | anon held (MAINTAIN also, on PG17) |
|---|---|
| `action_items` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `ai_feedback` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `ai_outputs` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `announcements` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `apparatus` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `apparatus_check_items` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `apparatus_check_results` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `apparatus_checks` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `apparatus_maintenance` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `apparatus_photos` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `apparatus_service_periods` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `cert_submissions` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `cert_types` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `certs` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `content_calendar` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `departments` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `documents` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `drill_plans` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `duties` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `duty_log` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `equipment` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `equipment_custody` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `equipment_handoff` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `equipment_handoff_items` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `equipment_issue_batch` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `equipment_issues` | REFERENCES,SELECT,TRIGGER,TRUNCATE |
| `equipment_manager` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `equipment_photos` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `equipment_type` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `events` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `funding_events` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `fundraiser_log` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `maintenance` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `meetings` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `member_devices` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `member_notes` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `member_private` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `members` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `members_view` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `notification_prefs` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `notifications` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `onboarding_items` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `onboarding_progress` | DELETE,REFERENCES,SELECT,TRIGGER,TRUNCATE |
| `post_categories` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `profiles` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `push_subscriptions` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `recruitment_events` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `resources` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `session_attendance` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `session_plans` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `standard_cert_types` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `station_log` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `station_presence` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `training_officer` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `training_plans` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `training_sessions` | DELETE,INSERT,REFERENCES,SELECT,TRIGGER,TRUNCATE,UPDATE |
| `training_session_audit_seq_seq` (sequence) | SELECT,UPDATE,USAGE |

**446 ACL privilege entries** in all (live, MAINTAIN included). authenticated's and service_role's privileges: **unchanged** (pinned md5 `34269436…` / `62597aae…`).

### The 19 {public} policies → TO authenticated (ALTER POLICY … TO — the predicate is not re-entered)

| table | policy | cmd | USING | WITH CHECK |
|---|---|---|---|---|
| `action_items` | leaders can read action_items | SELECT | `(is_leader() AND (department_id = my_department_id()))` | — |
| `ai_feedback` | leaders can read ai_feedback | SELECT | `(is_leader() AND (department_id = my_department_id()))` | — |
| `ai_outputs` | dept reads ai_outputs | SELECT | `(department_id = my_department_id())` | — |
| `certs` | Leaders read all certs | SELECT | `(is_leader() AND (department_id = my_department_id()))` | — |
| `content_calendar` | authenticated can read content_calendar | SELECT | `(department_id = my_department_id())` | — |
| `documents` | authenticated can read documents | SELECT | `(department_id = my_department_id())` | — |
| `duties` | authenticated can read duties | SELECT | `(department_id = my_department_id())` | — |
| `equipment` | da or manager manage equipment | ALL | `((is_dept_admin() OR is_equipment_manager()) AND (department_id = my_department_id()))` | `((is_dept_admin() OR is_equipment_manager()) AND (department_id = my_department_id()))` |
| `equipment` | members read equipment | SELECT | `(department_id = my_department_id())` | — |
| `equipment_photos` | da or manager manage equipment photos | ALL | `((is_dept_admin() OR is_equipment_manager()) AND (department_id = my_department_id()))` | `((is_dept_admin() OR is_equipment_manager()) AND (department_id = my_department_id()))` |
| `equipment_photos` | members read equipment photos | SELECT | `(department_id = my_department_id())` | — |
| `equipment_type` | da or manager manage equipment types | ALL | `((is_dept_admin() OR is_equipment_manager()) AND (department_id = my_department_id()))` | `((is_dept_admin() OR is_equipment_manager()) AND (department_id = my_department_id()))` |
| `equipment_type` | members read equipment types | SELECT | `(department_id = my_department_id())` | — |
| `events` | authenticated can read events | SELECT | `(department_id = my_department_id())` | — |
| `maintenance` | authenticated can read maintenance | SELECT | `(department_id = my_department_id())` | — |
| `meetings` | leaders can read meetings | SELECT | `(is_leader() AND (department_id = my_department_id()))` | — |
| `members` | leaders read members base table | SELECT | `(is_leader() AND (department_id = my_department_id()))` | — |
| `onboarding_progress` | leaders can read onboarding_progress | SELECT | `(is_leader() AND (department_id = my_department_id()))` | — |
| `training_sessions` | authenticated can read training_sessions | SELECT | `(department_id = my_department_id())` | — |

### Default privileges (F-3, forward-only)

- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public REVOKE ALL ON TABLES FROM anon` — new tables stop granting anon
- `… IN SCHEMA public REVOKE ALL ON SEQUENCES FROM anon`
- `… IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM anon`
- `ALTER DEFAULT PRIVILEGES FOR ROLE postgres REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` — **global** (Postgres can't revoke PUBLIC's built-in default per schema); affects only functions postgres creates from now on, in any schema. Existing function grants are not touched.
- Not changed: the `supabase_admin` defaults (the platform's), and postgres's defaults in the `storage` schema (out of scope; noted).

## Part 2 · `sql/ws5_storage_policy_DRAFT.sql` (S-1)

| table | policy | cmd | roles | WITH CHECK |
|---|---|---|---|---|
| `storage.objects` | equipment photos upload da or manager | INSERT | {public} → {authenticated} | `((bucket_id = 'station-documents'::text) AND ((storage.foldername(name))[1] = (my_department_id())::text) AND ((storage.foldername(name))[2] = 'equipment'::text) AND (is_dept_admin() OR is_equipment_manager()))` |

storage.objects is owned by `supabase_storage_admin`; the SQL editor altered storage policies for WS-3. Fallback: the dashboard (same single change).
