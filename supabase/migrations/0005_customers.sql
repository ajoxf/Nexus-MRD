-- What Nexus knows about a customer, beyond their email and what they pay.
-- Applied to the live project on 2026-09-13.
--
-- Deliberately a separate table from subscriptions. That one is a fact about money and is
-- read by the app on every sign-in to decide who gets in; this is the desk's own notes on a
-- relationship and is read by nobody but an operator. Putting an internal note in the row
-- that gates access is how an internal note ends up one policy mistake away from the person
-- it is about.
create table if not exists public.customers (
  user_id uuid primary key references auth.users(id) on delete cascade,

  full_name text,
  firm text,
  phone text,

  -- Where they are with us, which is NOT the subscription status. Somebody can be paying
  -- and still be 'at_risk'; somebody can be trialing and already 'committed'. Two different
  -- questions, and collapsing them loses the one a person actually acts on.
  stage text not null default 'new'
    check (stage in ('new', 'trialing', 'evaluating', 'committed', 'paying', 'at_risk', 'lapsed', 'lost')),

  notes text,

  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

alter table public.customers enable row level security;

-- NO POLICIES AT ALL, and that is the point.
--
-- With row level security on and no policy, this table is invisible and unwritable to every
-- signed-in user without exception — only the service role reaches it, which means only the
-- server does. These are notes ABOUT a customer, written for the desk's own use. A customer
-- reading "chasing, gone quiet, probably lost" about themselves is a conversation nobody
-- wants to have, and the way to guarantee it cannot happen is to give the browser no path
-- to the row rather than to remember to filter it.

comment on table public.customers is
  'Internal CRM notes on a Nexus customer. Server-only: no RLS policy grants any user access.';
