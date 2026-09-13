-- Affiliates, referrals and what they have earned.
--
-- Three tables rather than one, because they answer three different questions and they
-- stop being true at different times. Who the affiliate is barely changes. Who they sent
-- changes on every visit. What they are owed changes when money moves, and must never be
-- recalculated from the other two — a rate changed in March would otherwise silently
-- rewrite what somebody earned in January.

-- ---------------------------------------------------------------------------
-- The affiliate.
-- ---------------------------------------------------------------------------
create table if not exists public.affiliates (
  -- The code IS the identity, because it is the thing that appears in a link and gets
  -- typed, forwarded and printed. A separate surrogate id would add a join to every
  -- lookup that starts with "somebody arrived with ?ref=".
  code text primary key,
  name text not null,
  email text,

  -- active: links work and rewards accrue.
  -- paused: links still attribute, but nothing new is earned. For a dispute being sorted
  --         out — dropping the attribution would lose the trail that settles it.
  -- closed: over. Links no longer attribute at all.
  status text not null default 'active'
    check (status in ('active', 'paused', 'closed')),

  -- percent:     a share of the payment, in percent. reward_value 20 = 20%.
  -- fixed:       a flat amount per conversion, in the minor unit (cents/pence).
  -- free_months: months of access on the affiliate's OWN subscription. No cash moves.
  reward_kind text not null
    check (reward_kind in ('percent', 'fixed', 'free_months')),

  -- DELIBERATELY NO DEFAULT.
  --
  -- A commission rate is a commercial decision, and a column that quietly supplies 20
  -- because nobody typed a number is a contract nobody agreed to. Issuing an affiliate
  -- without a rate fails here, which is the correct outcome.
  reward_value numeric(12, 4) not null check (reward_value >= 0),

  -- first:     earned once, on the first payment that account makes.
  -- recurring: earned on every payment for as long as they keep paying.
  reward_scope text not null default 'first'
    check (reward_scope in ('first', 'recurring')),

  note text,
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id) on delete set null
);

-- ---------------------------------------------------------------------------
-- Who they sent.
-- ---------------------------------------------------------------------------
create table if not exists public.referrals (
  id uuid primary key default gen_random_uuid(),
  affiliate_code text not null references public.affiliates(code) on delete cascade,

  -- visited:   a link was opened. No account yet.
  -- signed_up: an account exists. Still worth nothing.
  -- converted: they paid. This is the only state that earns anything, because a signup
  --            that never pays is not a sale.
  status text not null default 'visited'
    check (status in ('visited', 'signed_up', 'converted')),

  -- Null until they sign up. The unique index below is what makes attribution FIRST TOUCH:
  -- one account belongs to one affiliate, permanently, and a later link cannot take it.
  user_id uuid references auth.users(id) on delete set null,
  email text,

  visited_at timestamptz not null default now(),
  signed_up_at timestamptz,
  converted_at timestamptz
);

-- One account, one affiliate. Partial so the many anonymous `visited` rows, which all have
-- a null user_id, do not collide with each other.
create unique index if not exists referrals_one_per_user_idx
  on public.referrals (user_id) where user_id is not null;

create index if not exists referrals_by_affiliate_idx
  on public.referrals (affiliate_code, status, visited_at desc);

-- ---------------------------------------------------------------------------
-- What they earned.
-- ---------------------------------------------------------------------------
create table if not exists public.affiliate_rewards (
  id uuid primary key default gen_random_uuid(),
  affiliate_code text not null references public.affiliates(code) on delete cascade,
  referral_id uuid references public.referrals(id) on delete set null,
  user_id uuid references auth.users(id) on delete set null,

  -- Copied from the affiliate AT THE MOMENT IT WAS EARNED, not read back through the join.
  -- A rate that changes later must not restate history; this is a ledger, not a view.
  kind text not null check (kind in ('percent', 'fixed', 'free_months')),
  rate numeric(12, 4) not null,

  -- Minor units, like Stripe. `basis` is what the customer paid, `amount` is the share.
  -- For free_months, amount is the count of months and currency is null: no cash moved.
  basis_minor bigint,
  amount_minor bigint not null,
  currency text,

  -- owed: earned, unpaid. paid: settled. void: reversed — a refund, a chargeback, a
  -- self-referral caught late. Nothing is ever deleted, because a deleted reward is an
  -- argument with no evidence.
  status text not null default 'owed' check (status in ('owed', 'paid', 'void')),

  -- WHAT this reward is for, and the reason a Stripe retry cannot pay twice. For a
  -- first-payment reward it is the word 'first'; for a recurring one it is that period's
  -- end date. Same lesson as email_log: claim by inserting, and let the key refuse the
  -- second attempt.
  period_ref text not null default 'first',

  note text,
  created_at timestamptz not null default now(),
  paid_at timestamptz
);

create unique index if not exists affiliate_rewards_once_idx
  on public.affiliate_rewards (affiliate_code, user_id, period_ref);

create index if not exists affiliate_rewards_owed_idx
  on public.affiliate_rewards (affiliate_code, status, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security: on, with no policies, on all three.
-- ---------------------------------------------------------------------------
-- A signed-in customer who could read `referrals` would learn which of their peers signed
-- up and when. One who could read `affiliate_rewards` would learn what everybody is paid.
-- One who could WRITE either could bill us for referrals that never happened. With RLS on
-- and no policy, all three tables are invisible and unwritable to every user without
-- exception; only the service role reaches them, which means only the server does.
alter table public.affiliates enable row level security;
alter table public.referrals enable row level security;
alter table public.affiliate_rewards enable row level security;

comment on table public.affiliates is
  'Nexus affiliates and their agreed terms. Server-only: no RLS policy grants any user access, deliberately.';
comment on table public.referrals is
  'Who each affiliate sent, and how far they got. One account is attributed to one affiliate, first touch wins.';
comment on table public.affiliate_rewards is
  'The commission ledger. Rate and basis are copied in at the moment of earning so a later rate change cannot rewrite history.';
