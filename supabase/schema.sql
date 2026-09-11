-- Margin & Risk Tracker — database schema
-- Run once in Supabase: Dashboard → SQL Editor → New query → paste → Run.

-- One row per trader: account settings, broker terms, product specs, current prices and stops.
create table if not exists public.settings (
  user_id    uuid primary key default auth.uid() references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Every execution (fill). Positions, averages and closed trades are calculated from these.
create table if not exists public.fills (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references auth.users (id) on delete cascade,
  broker     text not null default 'default',   -- which broker account the fill belongs to
  ts         timestamptz not null,
  product    text not null,
  side       text not null check (side in ('Buy', 'Sell')),
  qty        numeric not null check (qty > 0),
  price      numeric not null,
  account    text,                              -- optional: broker's own account/sub-account number
  fee        numeric not null default 0,      -- commission/swap as P&L impact (negative = cost)
  ref        text not null,              -- fill ID from the broker, or a fingerprint; stops duplicate uploads
  source     text default 'manual',      -- 'csv' or 'manual'
  created_at timestamptz not null default now(),
  unique (user_id, broker, ref)
);

create index if not exists fills_user_broker_ts on public.fills (user_id, broker, ts);

-- Row-level security: each trader can only read and write their own rows.
alter table public.settings enable row level security;
alter table public.fills    enable row level security;

drop policy if exists "own settings" on public.settings;
create policy "own settings" on public.settings
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "own fills" on public.fills;
create policy "own fills" on public.fills
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
