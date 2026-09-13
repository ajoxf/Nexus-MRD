-- Who the customer is, and how to reach them about their account.
--
-- Three columns on the CRM table rather than a new one: this is the same fact about the
-- same person as the firm and the stage beside it, and it stops being true at the same
-- time. A separate table would be a join to answer "who is this".
--
-- It lands in `customers` and NOT in `subscriptions` for the reason 0005 already gives:
-- subscriptions gates access and is read on every sign-in, and an internal note one policy
-- mistake away from the person it is about is how that mistake becomes a disclosure.

alter table public.customers add column if not exists first_name text;
alter table public.customers add column if not exists last_name  text;

-- Optional, and optional in the form too. A phone number is personal data we have no need
-- for unless somebody actively wants updates that way, and a required field is how you end
-- up holding a thousand numbers you never had a reason to ask for.
alter table public.customers add column if not exists whatsapp text;

comment on column public.customers.whatsapp is
  'Optional WhatsApp number, given by the customer for account updates. Never required, and deleted with the account.';

-- full_name stays. It is what every admin screen already reads, and it is kept in step with
-- the two new columns by the server that writes them, so nothing has to be migrated twice.

-- RLS is untouched: still on, still with no policies, still reachable only by the server.
-- Adding a column does not change that, and this comment is here so nobody assumes it did.
