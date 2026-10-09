-- ROLLBACK for sql/onboarding_signoff.sql. Restores direct writes and drops the
-- RPC + the member read policy. Leaves checked_by/checked_at in place (dropping
-- them destroys who-signed history); drop them by hand only if that's intended.
begin;
drop policy if exists "member reads own onboarding_progress" on public.onboarding_progress;
grant insert, update on public.onboarding_progress to authenticated;
drop function if exists public.set_onboarding_item(uuid, uuid, boolean);
notify pgrst, 'reload schema';
commit;
