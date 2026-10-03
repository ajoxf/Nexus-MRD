-- 0013 — Keep the broker statements a trader opens
--
-- Until now a statement zip was opened in the browser and gone on refresh. Tying statements to
-- fills, and to each other day after day, needs them kept. What is kept is the CSV files' text —
-- Financial Summary, Open Position, Trade Confirmation, Offset Record — unlocked, so the page
-- re-reads them on every visit and a better reader later applies to old statements too. PDFs are
-- not kept: they repeat the CSVs, and they stay in the trader's own copy of the zip.
--
-- Additive: a new table, nothing else touched. Rollback: 0013_statements_rollback.sql.

begin;

create table if not exists public.statements (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null default auth.uid() references auth.users (id) on delete cascade,
  -- SHA-256 of the zip exactly as the broker sent it. The same zip opened twice, from any
  -- device, is one statement: the unique key below is what makes that so.
  checksum       text not null,
  zip_name       text not null,
  statement_date date,
  account        text,
  -- [{ "name": "Financial Summary - 0011 - 20260819.csv", "text": "…" }, …] — CSVs only.
  files          jsonb not null default '[]'::jsonb,
  created_at     timestamptz not null default now(),
  unique (user_id, checksum)
);

create index if not exists statements_user_date on public.statements (user_id, statement_date desc);

-- Each trader reads, adds and deletes only their own. No update: a statement is what the
-- broker sent; a correction from the broker arrives as a different zip.
alter table public.statements enable row level security;

drop policy if exists "own statements: read" on public.statements;
create policy "own statements: read" on public.statements
  for select using (auth.uid() = user_id);

drop policy if exists "own statements: add" on public.statements;
create policy "own statements: add" on public.statements
  for insert with check (auth.uid() = user_id);

drop policy if exists "own statements: delete" on public.statements;
create policy "own statements: delete" on public.statements
  for delete using (auth.uid() = user_id);

comment on table public.statements is
  'Broker statement zips a trader has opened: the CSV files'' text, one row per zip (unique by checksum). PDFs are not stored.';

commit;
