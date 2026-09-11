-- Rollback for 0001 — puts the shared workspace back.
--
-- Only needed if something goes wrong and you want the app working again
-- immediately. It reopens the database to anyone with the publishable key,
-- so treat it as a way back to a known state, not a place to stay.

begin;

-- 1. Reopen access.
drop policy if exists "own settings" on public.settings;
drop policy if exists "own fills"    on public.fills;

create policy "shared workspace" on public.settings for all using (true) with check (true);
create policy "shared workspace" on public.fills    for all using (true) with check (true);

grant select, insert, update, delete on public.settings to anon;
grant select, insert, update, delete on public.fills    to anon;

-- 2. Detach from real accounts (the FK would block the move back).
alter table public.settings drop constraint if exists settings_user_id_fkey;
alter table public.fills    drop constraint if exists fills_user_id_fkey;

-- 3. Return the rows to the shared workspace.
update public.settings set user_id = '00000000-0000-0000-0000-000000000000';
update public.fills    set user_id = '00000000-0000-0000-0000-000000000000';

alter table public.settings alter column user_id set default '00000000-0000-0000-0000-000000000000'::uuid;
alter table public.fills    alter column user_id set default '00000000-0000-0000-0000-000000000000'::uuid;

commit;
