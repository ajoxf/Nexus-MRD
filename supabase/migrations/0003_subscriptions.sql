-- Nexus RAMP's own subscription record.
--
-- Applied to the live project on 2026-09-13. Kept here because this folder is the record
-- of what the schema is, and a table that exists only in the dashboard is a table the next
-- person cannot recreate.
--
-- Until now "do you hold this product" lived in NordStar Pro's database, and a Nexus
-- customer therefore had an account in two systems that had to be kept in step. That is
-- what produced the generated passwords, the handover button and the two-passwords-for-one
-- -email problem. This is where that answer moves to, so Nexus can stand on its own.

create table if not exists public.subscriptions (
  user_id uuid primary key references auth.users(id) on delete cascade,

  -- trialing: inside a free trial. active: paid and current. past_due: payment failed but
  -- not yet cut off. canceled: over. none: an account with nothing on it, which is the
  -- ordinary state of somebody who has just signed up.
  status text not null default 'none'
    check (status in ('none', 'trialing', 'active', 'past_due', 'canceled')),

  -- When the current period runs out. Null means open-ended: a comp, granted by hand, that
  -- does not lapse. Null is NOT "expired" and the access check must never read it that way.
  current_period_end timestamptz,

  -- Set the first time a trial is granted and never cleared. One trial per account is
  -- judged on this having a value, not on the status, so an expired trial still counts and
  -- nobody renews a free fortnight by waiting.
  trial_started_at timestamptz,

  cancel_at_period_end boolean not null default false,

  provider text check (provider in ('stripe', 'cregis')),
  provider_customer_id text,
  provider_subscription_id text,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists subscriptions_status_period_idx
  on public.subscriptions (status, current_period_end);

alter table public.subscriptions enable row level security;

-- A person may READ their own subscription and nothing else.
--
-- There is deliberately no insert, update or delete policy for signed-in users. With row
-- level security on and no write policy, every write from the browser is refused — so a
-- customer cannot grant themselves a subscription, extend their own trial, or move their
-- period end, however the client is edited. Writes happen only from the server with the
-- service role key, which bypasses row level security by design.
drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription"
  on public.subscriptions for select
  to authenticated
  using (auth.uid() = user_id);

comment on table public.subscriptions is
  'Nexus RAMP subscription state. Readable by its owner; written only by the server.';
