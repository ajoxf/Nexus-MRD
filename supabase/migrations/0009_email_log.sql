-- What Nexus has already emailed somebody. Applied to the live project on 2026-09-13.
--
-- The reminders run daily, which means without this the person three days from the end of a
-- trial is told so on day three, and again on day two, and again on day one. The unique key
-- is the whole mechanism: a send is attempted by inserting first, and the second attempt
-- collides and is skipped.
create table if not exists public.email_log (
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null,
  -- WHAT the email was about, not when it was sent. For a trial reminder it is that trial's
  -- end date — so a customer who trials, lapses and is later given a second trial gets a
  -- second reminder, because the thing being reminded about is a different thing. Keying on
  -- the date sent instead would silence that forever.
  ref text not null default '',
  sent_at timestamptz not null default now(),
  primary key (user_id, kind, ref)
);

create index if not exists email_log_sent_idx on public.email_log (sent_at desc);

alter table public.email_log enable row level security;
-- No policies: only the server writes or reads this. A list of what we have emailed somebody
-- is not theirs to query.

comment on table public.email_log is
  'One row per email Nexus has sent. The primary key is what stops a daily job repeating itself.';
