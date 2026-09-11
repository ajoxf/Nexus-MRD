-- 0001 — Per-user accounts
--
-- Replaces the open "shared workspace" setup with real per-user ownership.
-- Before running: create the first account in Supabase → Authentication → Users
-- → Add user, using the email below. Nothing here creates accounts.
--
-- Safe to read top to bottom: it moves the existing rows first, then locks the
-- doors. It runs as one transaction, so a failure anywhere leaves the database
-- exactly as it was.

begin;

-- 1. Hand the existing shared-workspace rows to the first account.
--    Change the email here if the first trader is someone else.
do $$
declare
  owner_id uuid;
  ws       uuid := '00000000-0000-0000-0000-000000000000';
  n_set    int;
  n_fill   int;
begin
  select id into owner_id from auth.users where email = 'a0504879526@gmail.com';

  if owner_id is null then
    raise exception
      'No account found for that email. Create it in Authentication → Users first, then re-run.';
  end if;

  update public.settings set user_id = owner_id where user_id = ws;
  get diagnostics n_set = row_count;

  update public.fills set user_id = owner_id where user_id = ws;
  get diagnostics n_fill = row_count;

  raise notice 'Moved % settings row(s) and % fill(s) to %', n_set, n_fill, owner_id;

  -- Nothing may be left behind in the old workspace, or it would become unreachable.
  if exists (select 1 from public.settings where user_id = ws)
  or exists (select 1 from public.fills    where user_id = ws) then
    raise exception 'Shared-workspace rows remain after the move; aborting.';
  end if;
end $$;

-- 2. New rows belong to whoever is signed in.
alter table public.settings alter column user_id set default auth.uid();
alter table public.fills    alter column user_id set default auth.uid();

-- 3. Tie rows to real accounts, so removing a user removes their data with them.
alter table public.settings
  add constraint settings_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

alter table public.fills
  add constraint fills_user_id_fkey
  foreign key (user_id) references auth.users (id) on delete cascade;

-- 4. Each signed-in trader reads and writes only their own rows.
drop policy if exists "shared workspace" on public.settings;
drop policy if exists "shared workspace" on public.fills;

create policy "own settings" on public.settings
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

create policy "own fills" on public.fills
  for all to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

-- 5. Close the door on visitors who are not signed in.
--    The app keeps using the same publishable key; once a trader signs in,
--    their requests run as "authenticated", not "anon".
revoke all on public.settings from anon;
revoke all on public.fills    from anon;

commit;
