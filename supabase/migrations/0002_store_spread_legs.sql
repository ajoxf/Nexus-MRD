-- 0002 — Keep the legs of a spread trade
--
-- A TT spread order arrives as three rows: the spread itself plus its two legs.
-- Until now the legs were thrown away at import and only the spread was stored,
-- so there was no way to see what the legs actually filled at.
--
-- This keeps them, marked as legs so they never affect positions or P&L. Two new
-- columns, both optional, so every existing row stays exactly as it is.
--
-- Independent of 0001 (per-user accounts) — either can run without the other.

begin;

-- Which broker order this fill came from. TT calls it TTOrderID, and the spread
-- and its legs all share one, which is what links a leg to its spread.
alter table public.fills add column if not exists order_id text;

-- A leg is a component of a spread trade, kept for reference only. The position,
-- margin and P&L maths skip these rows: the spread is the trade.
alter table public.fills add column if not exists is_leg boolean not null default false;

-- Looking up "the legs of this order" is the only new query.
create index if not exists fills_user_order on public.fills (user_id, broker, order_id) where is_leg;

commit;
