-- Who may run Nexus. Applied to the live project on 2026-09-13.
--
-- A table rather than a flag on the user, because Supabase's user_metadata is writable by
-- the user themselves — `supabase.auth.updateUser({ data: { is_admin: true } })` from the
-- browser console would be a self-service promotion. app_metadata is safe from that, but a
-- table says who the admins are in one place you can read at a glance, and it is obvious to
-- everybody that nothing outside the server writes it.
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  note text,
  created_at timestamptz not null default now()
);

alter table public.admins enable row level security;

-- A person may see whether THEY are an admin, and nothing else: enough for the app to
-- decide whether to show the admin screens, and it discloses nobody else. The server checks
-- this same table with the service role before any admin action, so hiding the tab is a
-- convenience and never the control.
drop policy if exists "see whether I am an admin" on public.admins;
create policy "see whether I am an admin"
  on public.admins for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert, update or delete policy, deliberately. Admins are made from the SQL editor.

comment on table public.admins is
  'Nexus operators. Self-readable only; written only by the server or the SQL editor.';
