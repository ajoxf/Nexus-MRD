-- Whether an account is actually using the product, and how hard.
-- Applied to the live project on 2026-09-13. Supersedes admin_fill_counts (0006).
--
-- Still COUNTS AND DATES, never a fill. Not a price, not a size, not a product, not a
-- position. How much and how recently, never what.
create or replace function public.admin_usage()
returns table (
  user_id uuid, fills bigint, brokers bigint, products bigint,
  first_fill timestamptz, last_fill timestamptz, last_import timestamptz
)
language sql stable security definer set search_path = public
as $$
  select f.user_id, count(*)::bigint, count(distinct f.broker)::bigint,
         count(distinct f.product)::bigint, min(f.ts), max(f.ts),
         -- When they last put data IN, which is not the last trade date: somebody importing
         -- a year of history today is active, and their last fill could be in March.
         max(f.created_at)
  from public.fills f group by f.user_id;
$$;

-- SECURITY DEFINER bypasses row level security by design, so leaving this callable by
-- `authenticated` would hand every signed-in customer a census of the whole desk.
revoke all on function public.admin_usage() from public;
revoke all on function public.admin_usage() from anon;
revoke all on function public.admin_usage() from authenticated;
grant execute on function public.admin_usage() to service_role;
