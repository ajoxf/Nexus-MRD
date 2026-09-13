-- Access codes for Nexus RAMP. Applied to the live project on 2026-09-13.
--
-- A code is a PROMISE of access, not access itself: the period it grants starts when it is
-- redeemed, not when it is issued. That is why a code has its own expiry separate from the
-- days it grants — an unbounded code is an open-ended liability sitting in somebody's inbox,
-- and a leaked or forwarded one should eventually stop working.
create table if not exists public.redemption_codes (
  code text primary key,
  grants_days integer not null check (grants_days between 1 and 3650),
  -- Null is "never expires" — a deliberate choice for a specific code, never a field
  -- somebody forgot to fill in.
  expires_at timestamptz,
  -- The note is for a code handed over in a meeting; the email for one sent to somebody.
  -- Kept apart because a note written into an email column is a code issued to nobody.
  issued_to_email text,
  note text,
  -- Filled in at redemption and never cleared. A code is single use, and `redeemed_at`
  -- having a value is the whole of that rule.
  redeemed_by uuid references auth.users(id) on delete set null,
  redeemed_email text,
  redeemed_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

create index if not exists redemption_codes_open_idx
  on public.redemption_codes (redeemed_at, expires_at);

alter table public.redemption_codes enable row level security;

-- NO POLICIES AT ALL, and this one matters more than most.
--
-- A signed-in customer who could SELECT from this table would read every unredeemed code on
-- the desk and help themselves. With row level security on and no policy, the table is
-- invisible and unwritable to every user without exception; only the service role reaches
-- it, which means only the server does. Redemption goes through an endpoint that is handed
-- one code and answers yes or no — it never hands the list back.

comment on table public.redemption_codes is
  'Nexus access codes. Server-only: no RLS policy grants any user access, deliberately.';
