-- =====================================================================
-- UNDO RECORD for cert_placeholder_null_DRAFT.sql (G1), applied on live 2026-10-21.
-- State row: placeholders_left 0 · nulled 21 · Indian Harbor Volunteer Fire Department · other_malformed 6.
-- These 21 Indian Harbor certs had exp = '0000-00' (an import placeholder) and now have exp = NULL.
-- DO NOT RUN unless the G1 fix must be reversed (it would bring back the false red EXPIRED badges).
-- Guarded: refuses unless all 21 still exist, are all Indian Harbor and all still null-dated.
-- =====================================================================
DO $undo$
DECLARE
  IDS constant uuid[] := array[
    '0f934ae1-4300-4aae-8c34-b11bb4425f38',
    '2671224e-da41-40f5-8c5f-60cd12e0445d',
    '3c2fe34a-1e06-4e25-9086-8527a694045d',
    '407ad955-0a12-4227-9435-74636f4a3fa5',
    '4197280c-b209-4853-8dc2-2c55212dcdb0',
    '485847e9-1dc4-47b7-9d22-4cedd973d794',
    '4d4daf7c-38a4-469b-b27e-1b7a2e52229b',
    '64ed9a5f-8b39-4abb-bad6-bb24de7d03ba',
    '66824fed-feb2-415e-b448-667c500e0424',
    '71c8bd10-adbe-4ef1-b2b5-5a58eba0c0b8',
    '73905508-ff88-4d6e-b3af-bc55344604b8',
    '89714bb3-5d64-4841-b7c8-4a7047ee1da6',
    '8ef76feb-ae5a-4f70-a12f-fb3ad9ae54c8',
    '9e28c38c-fd61-4f9d-825a-8ce7cd4e23c0',
    'a21f8871-50c3-4622-98ea-96680c924268',
    'a83e5bca-e965-4c4e-a596-90e9236d4bb4',
    'b2cd7185-1a73-41e0-82cc-e0ad12e2c42e',
    'bec58057-20b2-4037-9740-fb9bcc4d4627',
    'c1e6ed5f-1d98-4171-ba0c-ebc359b42900',
    'c4bdaa92-26d5-4a31-a476-3ab75ceb36d0',
    'fa15b93a-0b28-4583-ade0-c99be3facbd0'
  ]::uuid[];
  v_n int;
BEGIN
  IF (SELECT count(*) FROM public.certs c JOIN public.departments d ON d.id = c.department_id
       WHERE c.id = ANY (IDS) AND c.exp IS NULL AND d.name ILIKE 'Indian Harbor%') <> 21 THEN
    RAISE EXCEPTION 'Undo refused: the 21 certs are not all present, Indian Harbor and null-dated. Nothing changed.';
  END IF;
  UPDATE public.certs SET exp = '0000-00' WHERE id = ANY (IDS) AND exp IS NULL;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  IF v_n <> 21 THEN RAISE EXCEPTION 'Undo failed: touched % rows, not 21.', v_n; END IF;
END
$undo$;
