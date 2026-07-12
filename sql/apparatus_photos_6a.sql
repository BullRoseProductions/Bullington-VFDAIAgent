-- =====================================================================
-- VISUAL TRUCK-CHECK - Slice 6a (schema)
--
-- IMPORTANT: Slice 1 already pre-provisioned most of this. Already in place:
--   - Table public.apparatus_photos (id, department_id, apparatus_id FK ON
--     DELETE CASCADE, storage_path, angle_label [= the photo's label],
--     sort_order, uploaded_by, soft-delete deleted_at/deleted_by, created_at).
--   - RLS on apparatus_photos: "members read photos" (SELECT, dept-scoped) and
--     "ops manage photos" (FOR ALL, is_canmanage_ops() = DA/Officer). We KEEP
--     this write gate (leadership-ops; Board excluded) - a policy is enough for
--     a simple upload; no RPC needed.
--   - apparatus_check_items already has photo_id / marker_x / marker_y (unused).
--
-- This migration only closes the three gaps:
--   (1) rename the pre-provisioned marker_x/marker_y -> x_pct/y_pct, stored as
--       PERCENT 0-100 of the image (percentages, NOT pixels - so dots land
--       correctly on phone / tablet / desktop). Unambiguous column names.
--   (2) add the missing FK photo_id -> apparatus_photos(id) ON DELETE SET NULL
--       (photo_id was a bare uuid). Deleting a photo makes an item list-only
--       rather than deleting the item.
--   (3) 0-100 range checks on the percent columns.
--
-- An item with photo_id + x_pct/y_pct = photo-placed (a dot); an item with
-- photo_id NULL = list-only (backward compatible with existing text items).
-- Idempotent (guarded). Run VERIFICATION (bottom) after.
-- =====================================================================

-- (1) Rename to unambiguous percent columns. Guarded so a re-run is a no-op.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'apparatus_check_items' AND column_name = 'marker_x') THEN
    ALTER TABLE public.apparatus_check_items RENAME COLUMN marker_x TO x_pct;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'apparatus_check_items' AND column_name = 'marker_y') THEN
    ALTER TABLE public.apparatus_check_items RENAME COLUMN marker_y TO y_pct;
  END IF;
END $$;

COMMENT ON COLUMN public.apparatus_check_items.x_pct IS 'Dot X as PERCENT 0-100 of image width. NULL = list-only item.';
COMMENT ON COLUMN public.apparatus_check_items.y_pct IS 'Dot Y as PERCENT 0-100 of image height. NULL = list-only item.';

-- (2) Add the missing FK on photo_id (bare uuid -> real FK, ON DELETE SET NULL).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_schema = 'public' AND table_name = 'apparatus_check_items'
      AND constraint_name = 'apparatus_check_items_photo_id_fkey'
  ) THEN
    ALTER TABLE public.apparatus_check_items
      ADD CONSTRAINT apparatus_check_items_photo_id_fkey
      FOREIGN KEY (photo_id) REFERENCES public.apparatus_photos(id) ON DELETE SET NULL;
  END IF;
END $$;

-- (3) 0-100 range guards (nullable ok). Guarded.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_schema = 'public' AND table_name = 'apparatus_check_items' AND constraint_name = 'apparatus_check_items_x_pct_range') THEN
    ALTER TABLE public.apparatus_check_items
      ADD CONSTRAINT apparatus_check_items_x_pct_range CHECK (x_pct IS NULL OR (x_pct >= 0 AND x_pct <= 100));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints
                 WHERE table_schema = 'public' AND table_name = 'apparatus_check_items' AND constraint_name = 'apparatus_check_items_y_pct_range') THEN
    ALTER TABLE public.apparatus_check_items
      ADD CONSTRAINT apparatus_check_items_y_pct_range CHECK (y_pct IS NULL OR (y_pct >= 0 AND y_pct <= 100));
  END IF;
END $$;

-- =====================================================================
-- VERIFICATION (run separately; the editor shows the LAST grid)
-- =====================================================================

-- 1. Positioning columns renamed: x_pct/y_pct present, marker_x/marker_y GONE.
select column_name, data_type, is_nullable
from information_schema.columns
where table_name = 'apparatus_check_items'
  and column_name in ('photo_id', 'x_pct', 'y_pct', 'marker_x', 'marker_y')
order by column_name;
--   expect: photo_id (uuid), x_pct (real), y_pct (real); NO marker_x / marker_y rows.

-- 2. photo_id FK exists and is ON DELETE SET NULL, referencing apparatus_photos.
select con.conname, confrel.relname as references_table,
       case con.confdeltype when 'n' then 'SET NULL' when 'c' then 'CASCADE'
                            when 'a' then 'NO ACTION' when 'r' then 'RESTRICT'
                            else con.confdeltype::text end as on_delete
from pg_constraint con
join pg_class rel     on rel.oid     = con.conrelid
join pg_class confrel on confrel.oid = con.confrelid
where con.contype = 'f' and rel.relname = 'apparatus_check_items'
  and con.conname = 'apparatus_check_items_photo_id_fkey';
--   expect: 1 row | apparatus_photos | SET NULL

-- 3. apparatus_photos table + RLS already in place (from Slice 1). This is the
--    "did RLS take" confirmation the request asked for.
select (select relrowsecurity from pg_class where relname = 'apparatus_photos') as rls_enabled,
       p.policyname, p.cmd, p.roles, p.qual
from pg_policies p
where p.tablename = 'apparatus_photos'
order by p.policyname;
--   expect: rls_enabled = t ; two rows:
--     "members read photos" | SELECT | {authenticated} | (department_id = my_department_id())
--     "ops manage photos"   | ALL    | {authenticated} | (is_canmanage_ops() AND department_id = my_department_id())
