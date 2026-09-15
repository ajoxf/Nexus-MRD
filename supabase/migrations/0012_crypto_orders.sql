-- Crypto checkouts, and what became of them.
--
-- A separate table from `subscriptions` on purpose. That one is the answer to "what does
-- this account hold right now" and is read on every sign-in; this is the trail of attempts
-- to buy — most of which are abandoned, some underpaid, a few paid twice. Mixing the two
-- would put a hundred dead checkouts in front of the row that decides access.
--
-- Crypto is not Stripe. There is no subscription object at the processor and nothing
-- renews: somebody pays once and buys a fixed number of days. So the row records what was
-- asked for, and the callback records what arrived.

create table if not exists public.crypto_orders (
  -- Our own id, sent to Cregis as order_id and echoed back on the callback. It is what ties
  -- a payment to an account, so it is generated here and never taken from a request body.
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,

  -- What we asked for, copied in at the moment of asking. The price is a server setting and
  -- can change; a row must keep what THIS buyer was quoted, or a later price rise silently
  -- rewrites what somebody agreed to pay.
  amount text not null,
  currency text not null,
  grants_days integer not null check (grants_days > 0),

  -- pending:    created, buyer sent to the hosted page.
  -- paid:       the signed callback said the money arrived. The only status that grants.
  -- underpaid:  they sent too little. Deliberately its own state, not a failure — somebody
  --             is out of pocket and it needs a person, not a retry.
  -- expired:    the checkout window closed unpaid.
  -- failed:     Cregis or the relay refused before the buyer ever saw a page.
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'underpaid', 'expired', 'failed')),

  -- What Cregis calls it, for looking the payment up in their dashboard.
  cregis_order_id text,
  checkout_url text,

  -- What actually arrived, which is not always what was asked for.
  paid_amount text,
  paid_at timestamptz,

  -- The callback as received, kept verbatim. When a payment is disputed months later this
  -- is the only record of what the processor actually said, and a summary of it is not
  -- evidence. Server-only, like the rest of this table.
  callback jsonb,

  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One Cregis order maps to one row. Cregis retries its callback, and a retry must land on
-- the same row rather than granting a second helping of access.
create unique index if not exists crypto_orders_cregis_id_idx
  on public.crypto_orders (cregis_order_id) where cregis_order_id is not null;

create index if not exists crypto_orders_by_user_idx
  on public.crypto_orders (user_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Row level security: on, with no policies.
-- ---------------------------------------------------------------------------
-- A customer who could UPDATE this table could mark their own order paid, and the webhook
-- would have nothing left to verify. A customer who could read it would see every other
-- buyer's payments. With RLS on and no policy the table is invisible and unwritable to
-- every signed-in user; only the service role reaches it, which means only the server.
alter table public.crypto_orders enable row level security;

comment on table public.crypto_orders is
  'Cregis crypto checkouts and their outcome. Server-only: no RLS policy grants any user access, deliberately.';
