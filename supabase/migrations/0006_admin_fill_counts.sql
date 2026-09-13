-- How many fills each account has imported. A COUNT, never the fills.
-- Applied to the live project on 2026-09-13.
--
-- It is the difference between a trial going well and one going nowhere: somebody eleven
-- days into fourteen with nothing imported has not evaluated the product and is about to
-- leave, and no subscription row can tell you that. The number says whether they got
-- started. It says nothing about what they trade, at what price, or in what size.
create or replace function public.admin_fill_counts()
returns table (user_id uuid, n bigint)
language sql
stable
-- SECURITY DEFINER so it can see across every account's rows, which row level security
-- otherwise forbids. That makes the grant below load-bearing, not housekeeping.
security definer
set search_path = public
as $$
  select f.user_id, count(*)::bigint from public.fills f group by f.user_id;
$$;

-- A SECURITY DEFINER function bypasses row level security by design, so leaving it callable
-- by `authenticated` would hand every signed-in customer a census of the whole desk. Only
-- the service role — which means only the server — may call it.
revoke all on function public.admin_fill_counts() from public;
revoke all on function public.admin_fill_counts() from anon;
revoke all on function public.admin_fill_counts() from authenticated;
grant execute on function public.admin_fill_counts() to service_role;
