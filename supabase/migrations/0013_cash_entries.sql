-- 0013 — The cash ledger gets its own table
--
-- Deposits, withdrawals and charges have lived in settings.data->'cash': a list inside
-- one JSON value, saved whole by whichever browser tab saved last. Two things follow:
--
--   1. Nothing in the database stopped the same deposit being recorded twice. The only
--      check was in a screen component, and it did not cover entries typed by hand.
--   2. Two tabs open at once could overwrite each other, so a deposit could vanish, or a
--      deleted one come back, without anybody being told.
--
-- Here each entry is its own row, and every row carries a key that says where it came
-- from (see src/lib/cash.js). The database refuses a second row with the same key for the
-- same account — the same guarantee fills have had all along.
--
-- YOUR EXISTING LEDGER: copied into the new table, every entry keeping its id inside its
-- key, so running this twice still copies each entry once. settings.data->'cash' is NOT
-- changed or removed. It stays exactly as it is, as the backup.
--
-- BEFORE AND AFTER: run the check at the bottom of this file. The count and total per
-- account must match between the old list and the new table, to the cent.
--
-- ROLLBACK: 0013_cash_entries_rollback.sql, then redeploy the previous version of the app,
-- which reads settings.data->'cash' again. Entries recorded AFTER this migration exist only
-- in the new table — export them first if you roll back after using it.

begin;

create table if not exists public.cash_entries (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references auth.users (id) on delete cascade,
  broker      text not null,
  type        text not null check (type in ('deposit', 'withdrawal', 'charge')),
  amount      numeric not null,
  ts          timestamptz not null,
  note        text not null default '',
  category    text,                       -- charges: market data, platform, …
  recurring   text,                       -- 'monthly', or null for a one-off
  end_ts      timestamptz,                -- a monthly charge that has stopped
  source      text not null default 'manual',   -- manual | csv | statement | legacy
  ref         text,                       -- the broker's own reference, when it gives one
  source_key  text not null,              -- where it came from; see src/lib/cash.js
  -- accepted counts toward equity. proposed waits on the trader (statements). rejected is
  -- kept, not deleted, so the same entry is not offered again on the next upload.
  status      text not null default 'accepted' check (status in ('accepted', 'proposed', 'rejected')),
  created_at  timestamptz not null default now(),
  unique (user_id, broker, source_key)
);

create index if not exists cash_entries_user_ts on public.cash_entries (user_id, ts);

alter table public.cash_entries enable row level security;

drop policy if exists "own cash" on public.cash_entries;
create policy "own cash" on public.cash_entries
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Signed-in traders only, as with settings and fills (0001).
revoke all on public.cash_entries from anon;
grant select, insert, update, delete on public.cash_entries to authenticated;

-- Copy the existing ledgers. Only entries an old version of the app could have written:
-- anything without an id, account, known type or date is left behind in settings and
-- reported by the check below rather than guessed at.
insert into public.cash_entries
  (user_id, broker, type, amount, ts, note, category, recurring, end_ts, source, ref, source_key, status)
select
  s.user_id,
  e->>'broker',
  e->>'type',
  (e->>'amount')::numeric,
  (e->>'ts')::timestamptz,
  coalesce(e->>'note', ''),
  nullif(e->>'category', ''),
  nullif(e->>'recurring', ''),
  nullif(e->>'endTs', '')::timestamptz,
  coalesce(nullif(e->>'source', ''), 'manual'),
  nullif(e->>'ref', ''),
  'legacy:' || (e->>'id'),
  'accepted'
from public.settings s
cross join lateral jsonb_array_elements(
  case when jsonb_typeof(s.data->'cash') = 'array' then s.data->'cash' else '[]'::jsonb end
) e
where coalesce(e->>'id', '') <> ''
  and coalesce(e->>'broker', '') <> ''
  and e->>'type' in ('deposit', 'withdrawal', 'charge')
  and coalesce(e->>'ts', '') <> ''
  and (e->>'amount') ~ '^-?[0-9]+(\.[0-9]+)?$'
on conflict (user_id, broker, source_key) do nothing;

commit;

-- ---------------------------------------------------------------------------------------
-- THE CHECK. Run this on its own after the migration. Every line should say "match".
-- Anything else names the account and what differs.
--
-- with old as (
--   select s.user_id, e->>'broker' as broker, count(*) as n, sum((e->>'amount')::numeric) as total
--   from public.settings s
--   cross join lateral jsonb_array_elements(
--     case when jsonb_typeof(s.data->'cash') = 'array' then s.data->'cash' else '[]'::jsonb end) e
--   group by 1, 2
-- ), new as (
--   select user_id, broker, count(*) as n, sum(amount) as total
--   from public.cash_entries where source_key like 'legacy:%'
--   group by 1, 2
-- )
-- select user_id, coalesce(old.broker, new.broker) as account,
--        old.n as old_count, new.n as new_count, old.total as old_total, new.total as new_total,
--        case when old.n = new.n and old.total = new.total then 'match' else 'DIFFERENT' end as result
-- from old full join new using (user_id, broker)
-- order by result, user_id, account;
