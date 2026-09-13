# Nexus RAMP — Privacy Policy (DRAFT)

> **This is a draft, not a published policy.** It is deliberately not wired into the
> site. Everything marked **[DECIDE]** is a commercial or legal choice that is not mine
> to make, and a policy published with invented retention periods is worse than no
> policy at all — it is a promise to customers that nobody checked.
>
> Everything *not* marked [DECIDE] is a statement of what the code actually does, taken
> from the live schema and the source rather than from a template. Those parts are
> accurate as of this commit. If the code changes, this has to change with it.
>
> Have a solicitor read the finished version before it goes up.

---

## Who we are

**[DECIDE] — the registered legal entity.** A privacy policy has to name the company that
is legally responsible, with its registered address and company number. The product says
"A Fincoursa product" on the sign-in page; I do not know the registered entity, its
address, or where it is incorporated. Nothing below can be finalised without it.

**[DECIDE] — a contact address for privacy requests.** This needs to be a monitored inbox.
`NEXUS_EMAIL_REPLY_TO` already exists in the configuration and may be the right one.

---

## What we collect, and why

We collect four distinct kinds of information, and they are held apart from each other on
purpose.

### 1. Your account

Your email address, and — if you sign in with Google — the fact that you used Google and
the account identifier it gives us. If you set a password, we never see it: it is hashed by
our authentication provider and is not readable by us or by anyone working here.

We need this to let you sign in and to tell you about your account. Without it there is no
account.

### 2. Your trading data

This is the substantial part, and the part that matters most.

When you upload fills, we store, for each one: the timestamp, the instrument, the side, the
quantity, the price, any fee, the broker it came from, your broker account identifier, the
order reference, and whether it forms part of a spread.

We also store your configuration: your broker accounts and their names, the capital assigned
to each, margin and contract-size settings, your risk limits, your price marks, your scenario
settings, and your funds ledger of deposits, withdrawals and charges.

We hold this **solely to provide the product to you** — to work out your positions, margin,
exposure and P&L, and to draw the charts. It is your book. We do not trade on it, we do not
aggregate it, and we do not sell it.

> **[DECIDE] — will you commit, in writing, to never using customer trade data for any
> purpose beyond running that customer's account?** No aggregate market analytics, no
> "market insight" product built from customer books, no model training. Stating this
> plainly is a real competitive advantage with professional desks, and it is the single
> sentence a compliance officer will look for. But it closes a door on a future product
> line, so it is a commercial decision, not a drafting one. **The paragraph above is
> written as though you have said yes.** If the answer is no, it must be rewritten, and
> rewritten honestly.

### 3. Your relationship with us

If you contact us or we record notes about your account — the firm you trade for, a phone
number, where you are in evaluating the product, and our own notes — we keep that to run
the business relationship.

These notes are for our internal use and can be unflattering in the ordinary way that sales
notes are. You have the right to ask for a copy. See "Your rights" below.

### 4. Your payments

If you subscribe, we record your subscription status, the dates, and the identifiers our
payment processor gives us.

**We never see or store your card details.** Payment happens on Stripe's own checkout page;
card numbers do not pass through Nexus at any point.

---

## What we do *not* do

Worth stating plainly, because it is unusual:

- **We run no analytics.** No Google Analytics, no Plausible, no PostHog, no Mixpanel.
- **We run no tracking pixels, advertising tags or session recording.** None. There is no
  third-party script on any page of this product.
- **We do not profile you or make automated decisions about you.**
- **We do not sell, rent or share your data with anyone for their own purposes.**
- **We serve our own fonts.** Loading fonts from a third party would send your IP address
  to them before you had signed in. We stopped doing that.
- **Our staff cannot read your trades.** This is not a promise about behaviour — it is how
  the software is built. The internal admin screens show subscription status and usage
  counts (how many fills, how recently) and have no route to a single fill, position, price
  or figure from anybody's book. Running the business does not require reading your trades,
  so the tooling to do it does not exist.

---

## Where your data is held

Your database sits in **London (UK)**, and the server-side code that reads it runs in
**London** too.

Some of the companies we rely on are based in the United States, and a limited amount of
data reaches them in the course of doing their job:

| Who | What they do | What they see | Where |
|---|---|---|---|
| Supabase | Database and sign-in | Everything stored, as our processor | London (UK) |
| Vercel | Hosting, and the code that reads the database | Everything stored, in transit | London (UK) |
| Stripe | Payments | Your name, email and payment details | US / global |
| Resend | Sending our emails | Your email address and the message | US |
| Google | Sign-in, only if you choose it | That you signed in | US / global |

> **[DECIDE] — transfer safeguards.** Stripe and Resend involve transferring personal data
> outside the UK. This normally relies on the UK International Data Transfer Agreement or
> the UK Addendum to the EU Standard Contractual Clauses. Both providers offer these, but
> **somebody has to actually sign or accept them** in each provider's dashboard, and the
> policy should then name the mechanism. This is a real task, not a paragraph.

---

## How long we keep it

> **[DECIDE] — every number in this section.** These are the placeholders I would suggest,
> but retention periods are a commitment to customers and a compliance question, and
> inventing them would be exactly the wrong thing to do. The current *actual* answer for
> trade data is "indefinitely", which is a decision made by not making one.

- **Your trading data:** kept while your account is open. **[DECIDE — suggested: deleted
  within 90 days of your account closing, unless you delete it sooner yourself.]**
- **Your account:** kept while open. On deletion, see below.
- **Our notes about you:** **[DECIDE — suggested: deleted with your account.]**
- **Payment records:** retained after account closure because tax law requires it.
  **[DECIDE — suggested: 6 years, which is the usual UK figure. Confirm with your
  accountant.]**
- **Email log:** we record which type of message we sent you and when, but never its
  content. Deleted with your account.

---

## Deleting your account

You can delete your account yourself, from **Settings → Close your account**. You do not
have to email anyone or wait for us.

**Deleted immediately and permanently:** every fill, every broker account, your limits,
prices, scenario settings and funds ledger, our internal notes about you, and the record of
which emails we sent you. Your sign-in is disabled and your email address is removed from
our systems.

**Kept:** the record of payments you have made. We are required to hold this for tax
purposes, and it is what lets us answer your bank if a charge is ever disputed. It contains
what you paid and when — **no trades, and nothing from your book.**

**If you are subscribed, we cancel your subscription before deleting anything.** If that
cancellation fails, we stop and delete nothing, rather than close an account that is still
being billed.

We cannot undo this and we cannot recover your data afterwards. The product offers you a
CSV backup of your fills before it proceeds, and writes it before anything is deleted.

---

## Your rights

If you are in the UK or EU you have the right to ask us for a copy of your data, to correct
it, to delete it, to restrict or object to how we use it, and to receive it in a portable
form. You can also complain to the Information Commissioner's Office (or your local
regulator).

Most of these you can act on yourself: your trading data is downloadable as CSV from inside
the product at any time, and deletion is a button rather than a request.

**[DECIDE] — response process.** The law gives you one month to respond to a request. There
is currently no defined process for receiving one, logging it, or answering it within that
window. This is worth an hour of thought before the first request arrives rather than after.

---

## Cookies

We set no advertising or analytics cookies, because we run no advertising or analytics.

To keep you signed in, we store a session token in your browser's local storage. It is
strictly necessary to use the product — without it you would be signed out on every page
load — and it is never sent to anyone but us.

---

## Security

Access to your data is enforced by the database itself, not only by the application. Each
account can read its own rows and no others, and the tables holding our internal records
are unreadable and unwritable by any signed-in user, by policy in the database rather than
by a check in the code that somebody could forget to write.

Administrator access is verified on the server against a separate table of operators. It is
never based on anything your browser tells us.

Payments are handled entirely by Stripe. We hold no card data.

> **[DECIDE] — breach notification.** A personal data breach has to be reported to the ICO
> within 72 hours of becoming aware of it. There is currently no alerting that would tell
> you a breach had happened, so "becoming aware" is undefined. Worth resolving before
> selling to desks whose own compliance teams will ask.

---

## Who is responsible for what

> **[DECIDE] — the controller/processor split, and it shapes this whole document.**
>
> For your **account and billing** (email, payment records, our notes), Nexus is the
> **controller** — it is our data about our customer, and we decide what happens to it.
>
> For the **trade data you upload**, Nexus is arguably a **processor**. Those fills describe
> a firm's positions; the firm decides what happens to them and we hold them on instruction.
>
> This dual role is normal for a B2B tool, and stating it clearly is reassuring rather than
> complicated. But it determines who answers a regulator, who owns a deletion request that
> arrives from a trader at a firm rather than from the firm, and what the data processing
> agreement says. **It has to be settled before the DPA is written, not after.**

---

## Changes

If we change this policy we will say so, and say what changed.

**[DECIDE] — notification method.** Email to all users, or a notice in the product.

---

## Still to write

Two documents this policy does not replace, listed here so they do not get forgotten:

1. **Terms of service** — your liability, uptime commitments, what happens on cancellation.
   Protects you rather than the customer.
2. **Data processing agreement** — the one that blocks sales. A professional desk's
   compliance team will ask for a DPA before they let you touch their trade data.
   In practice this is the real blocker to selling properly, more than this policy is.
