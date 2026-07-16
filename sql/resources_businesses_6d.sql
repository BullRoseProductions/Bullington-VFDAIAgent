-- =====================================================================
-- YOUR SIX - "Businesses who support us": extend resources (no new table, no RLS change).
--   is_business : marks a supporter business (vs a health/crisis resource)
--   address     : physical location; rendered as a tappable maps link
-- The sponsor tier REUSES is_national: local business = is_national false (dept-editable);
-- a future national/platform sponsor = is_national true (PA-seeded, LOCKED by the existing
-- RLS - undeletable/uneditable via the client, same mechanism as the crisis lines). No policy
-- change needed. Existing rows backfill to is_business=false. Idempotent.
-- =====================================================================
alter table public.resources
  add column if not exists is_business boolean not null default false,
  add column if not exists address     text;

-- VERIFY (run separately):
-- select column_name, data_type, column_default from information_schema.columns
-- where table_schema='public' and table_name='resources' and column_name in ('is_business','address');
--   expect: is_business (boolean, default false), address (text)
