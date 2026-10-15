-- =====================================================================
-- One-off data cleanup — APPLIED 2026-10-13 by hand (result: closed_at 2026-10-13 15:44:33Z,
-- orphans_still_open = 0). Kept as the record of what was changed. Do NOT re-run.
--
-- Lipan Volunteer Fire Department: custody period 1f48e56a… ("Radios · SN 1234", Roger Gaines,
-- issued 2026-08-20) was open with equipment_id NULL — the unit had been deleted from the registry
-- while issued (equipment_custody.equipment_id is ON DELETE SET NULL). No RPC can close such a
-- period (they all key on equipment_id), so it showed on his My Equipment forever.
-- CLOSED, not deleted: the custody history still shows he held it, with the reason in the note.
-- No photos or issues referenced it. Only this one orphan existed.
-- =====================================================================
begin;

do $fix$
declare
  v_n int;
begin
  update public.equipment_custody
     set closed_at         = now(),
         close_action      = 'manager_recovery',
         closed_by_name    = 'Admin cleanup',
         note              = concat_ws(' · ', nullif(note, ''),
                               'Closed 2026-10-13 by admin cleanup: the unit (Radios · SN 1234) was deleted from the registry while issued, leaving this period open with no unit to return or recover.')
   where id = '1f48e56a-dbc7-49ac-9689-7573bcdf4d2b'
     and closed_at is null
     and equipment_id is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'Expected to close exactly 1 orphaned period, matched %. Nothing changed.', v_n;
  end if;
end
$fix$;

commit;
