# Can a TT feed replace manual import in Nexus RAMP?

*Feasibility assessment and decision memo — DRAFT 1, 2 Oct 2026. No code has changed.*

---

## How to read this

- **VERIFIED** means I checked it myself, against this repository or by running code. I say how.
- **UNVERIFIED** means it comes from search-engine summaries of TT's documentation. TT's own site
  (`library.tradingtechnologies.com`) is blocked from this session, so I could not read the primary
  page. Each one is on the list for Orient/TT in section 13. Do not build on any of them until
  that list comes back answered.
- **ASSUMED** means a reasonable default I picked so the memo could be written, with no source behind
  it. Each is flagged as a question for you.

What you told me, which this memo is built on:

| | |
|---|---|
| Who it is for | You alone, for now |
| Clearer | Orient (taken to be Orient Futures, Singapore) |
| FIX entitlement | Not sure — to be checked |
| How fast fills must appear | Within about 5 minutes |
| Prices | Live intraday, then the official settlement after the close; you can still type over them; stale prices must be obvious |
| Exchanges | ICE Futures Europe, CME Group, ICE US / others, Asian venues |
| Other venues | Some fills come from outside TT, so CSV import stays |
| History needed | Open positions plus about 90 days |
| New infrastructure | Only if clearly needed |

---

## 1. The decision, in one page

**Recommendation: REST now, FIX later — and fix the CSV importer's identity first.**

1. **Before any feed: fix two weaknesses in today's CSV import** (section 8.1). I found them while
   checking how duplicates are caught, and proved both with a script.
   - The same TT file can be stored **twice** if it is imported from a computer set to a different
     time zone, for example from London and then from Singapore.
   - Two genuine partial fills can be stored as **one** when they are on the same order, at the
     same price and in the same millisecond.

   Neither needs a feed to happen, and both break the "a fill is never stored twice — or lost" rule
   you set. Any feed built on today's identity inherits them. This is small work, but it has to be
   done carefully (section 8.4).
2. **Fills: poll TT's REST API (`ttledger`) every 1–5 minutes.** That meets your 5-minute
   requirement and runs inside what you already have: Supabase plus either a Vercel Pro cron or a
   Supabase scheduled function. It needs no always-on server and no FIX certification. The same
   route performs a one-off backfill of the last ~90 days (UNVERIFIED window).
3. **Marks: automate the settlement price first. Treat live intraday prices as a separate, later
   decision.** Live intraday prices are the one part that genuinely needs an always-on connection
   (FIX Market Data or a vendor feed). They also need **exchange data licences**, which cost
   money every month whichever technical route you choose. Settlement prices need neither.
4. **FIX Drop Copy only if** you later need fills within seconds, or once you are paying for an
   always-on market-data process anyway. At that point adding Drop Copy is cheap at the margin.
5. **"Connect it and your whole book appears" is not achievable. Do not promise it.**
   - The APIs reach back roughly 30 days (FIX Recovery) or 90 days (REST). Both are UNVERIFIED.
   - Fills from outside TT never appear through a TT feed.
   - Older history still comes in by CSV, once, and the two have to meet without duplicates.
     Section 8 is how.

**Rough size:**
- Identity fix with check scripts: 2–4 days.
- REST fill sync with backfill and its check script: 1–2 weeks.
- Settlement-price marks plus the staleness display: about 1 week, once a price source is chosen.
- Live intraday prices over FIX: 4–8 weeks of building, plus TT certification lead time, plus
  running a server indefinitely.

**Is this the right next thing?** The identity fix, yes: it protects the book you already have.
REST sync, probably: it removes the daily chore at low risk. Live FIX prices, not yet. Their cost
and operating burden is large compared with typing marks for a book you run alone, unless your
intraday stop discipline actually depends on them. Only you can judge that (question Y5).

---

## 2. The architecture question you asked me to answer first

You were right. **FIX cannot run in the current `/api` layer.**

- **VERIFIED:** `vercel.json` defines plain serverless functions and one daily cron
  (`0 9 * * *`, `/api/cron/reminders`).
- A FIX session is a long-lived connection with sequence numbers that must survive a restart.
  A serverless function lives for seconds and holds nothing between calls.

The three options:

| | What it is | Real cost | Fits your answers? |
|---|---|---|---|
| **(a) Own always-on FIX engine** | A small server running a FIX engine (QuickFIX/J, or a Node/Python FIX library). It turns messages into the existing fill shape and writes to Supabase. The app is untouched. | Server about £5–£50 a month. TT FIX entitlement and certification (cost UNVERIFIED — ask Orient). 4–8 weeks to build properly. **Someone must notice when it stops at 3am** (section 11). | Only needed for second-level fills or live prices. You chose 5 minutes, so not for fills. |
| **(b) Managed FIX bridge / vendor** | A vendor (OnixS, B2BITS, a FIX hosting firm) holds the session and hands you messages over HTTPS or a queue. | Typically hundreds to low thousands a month (ASSUMED — no quote obtained). You still certify with TT. Your book's data passes through a third party. | Hard to justify for one trader. |
| **(c) TT REST polling** | A scheduled job asks `ttledger` for "fills since X" every few minutes. | TT REST plan (free tier, UNVERIFIED: 3 requests/second, 10,000/day; polling once a minute uses about 1,440/day). Vercel Pro (about $20/month) **or** a free Supabase scheduled function. 1–2 weeks to build. No FIX certification. | **Yes.** It meets 5 minutes, adds no new infrastructure, and needs no TT certification. |

**VERIFIED (via search summaries of Vercel's own limits; Vercel docs not opened directly):** on the
Hobby plan, a cron that runs more than once a day fails at deploy. Pro allows one every minute.
Check which plan you are on (question Y1). A Supabase scheduled Edge Function is the alternative
if you would rather not upgrade Vercel.

**UNVERIFIED but important:** TT states that `ttledger` and `ttmonitor` are **"not intended to be
used as a real-time feed since there may be delays"** and points real-time users to FIX or the
.NET SDK. TT does not say how long the delay is. Ask (question T4). If it turns out to be longer
than 5 minutes, option (c) stops fitting your requirement.

---

## 3. TT's three FIX session types

All UNVERIFIED (search summaries). The "Where from" column is the summary's source page.

| Session | What it gives RAMP | Where from |
|---|---|---|
| **Order Routing** | Sending orders. RAMP must **not** use this — a risk tool should not be able to trade. | TT FIX overview |
| **Drop Copy** | A copy of every order event and fill: `ExecutionReport (8)`, `OrderCancelReject (9)`, `TradeCaptureReport (AE)`. Listen-only. | "TT FIX Drop Copy overview"; "Drop Copy message flows" |
| **Security Definition / Market Data** | Contract details (`SecurityDefinition`) and prices: `MarketDataRequest (V)` → `MarketDataSnapshotFullRefresh (W)`. Settlement is `MDEntryType (269) = 6`. | "Market Data Request (V)" page |

- **Version:** a *subset* of FIX 4.2 (Errata 20010501) and FIX 4.4. Not the full spec.
  UNVERIFIED — it was repeated consistently across summaries.
- **Getting one:** a TT **company administrator** creates the FIX session in TT User Setup. With
  Orient as your clearer that administrator is probably Orient, not you (UNVERIFIED).
- **Connection:** encrypted TCP (SSL / Stunnel), authenticated with SenderCompID (tag 49) and a
  password (tag 96). Client certificates are not used. Whether an IP allowlist is required is not
  stated in what I could reach.
- **Certification:** mandatory for applications connecting to TT FIX services, in five steps:
  Connectivity, Setup, Develop, Certify, TT Review. A UAT (test) environment exists.
  Lead time: not found.
- **Cost:** not found. Ask Orient (question T1).

---

## 4. Field by field: where each thing RAMP needs would come from

RAMP's fill shape:
`{ ts, broker, product, side, qty, price, fee, ref, account, position, source, is_leg, order_id }`.

FIX tags are standard FIX. **Whether TT populates each one is UNVERIFIED.**

| RAMP needs | FIX Drop Copy | TT REST `ttledger` | Notes |
|---|---|---|---|
| Stable unique fill id → `ref` | `ExecID (17)`. For grouped fills, `FillExecID (1363)`; for legs, the leg fill id in `LegFillsGrp`. | the fill's id field (name UNVERIFIED) | **Whether the REST id equals the FIX `ExecID` is the single most important open question** (T5). Section 8. |
| Order id → `order_id` | `OrderID (37)` | order id field | VERIFIED: today's CSV uses TT's `TTOrderID` column for this. Whether FIX tag 37 *is* that same id: UNVERIFIED (T6). |
| Timestamp → `ts` | `TransactTime (60)`, UTC | timestamp, UTC (assumed) | **Feeds give UTC; the CSV does not** — section 8.1. |
| Product → `product` | `Symbol (55)` + `SecurityID (48)` + maturity | instrument id → look up | **No FIX field gives the text RAMP uses today ("CL Nov26").** A translation from TT instrument → RAMP product name is needed. If it is wrong, the product falls outside your broker product settings, and margin is calculated without its config. |
| Side → `side` | `Side (54)`: 1 = Buy, 2 = Sell | side | Straightforward. |
| Quantity → `qty` | `LastQty (32)` (this fill), **not** `CumQty (14)` | fill quantity | Taking `CumQty` by mistake double-counts partial fills. Covered by the check script. |
| Price → `price` | `LastPx (31)` | fill price | Spreads can be negative — already handled. |
| Fee → `fee` | `Commission (12)` / `MiscFeesGrp`, often **empty** at fill time | probably absent | **ASSUMED: clearer commissions arrive on the statement, not the fill.** RAMP already has a per-broker commission rate; keep using it for feed fills. |
| Account → `account` | `Account (1)` | account id | |
| Broker → `broker` | *none* | *none* | RAMP's own label. The sync is told "this TT login = this RAMP broker". |
| Spread or leg → `is_leg` | `MultiLegReportingType (442)`: 1 = outright, 2 = leg, 3 = spread summary | possibly similar | Section 6. A cleaner signal than today's name-matching. |
| Position ticket → `position` | n/a | n/a | MT5 only. Not relevant to TT. |
| Contract size | `ContractMultiplier (231)` in `SecurityDefinition` | instrument endpoint (pdsapi) | Can fill in `settings.brokers[].products[].size`. Treat it as a **suggestion you confirm** — section 4.1. |
| Expiry / last trading day | `MaturityDate (541)` / `MaturityMonthYear (200)`; per leg in `SecurityDefinition` legs | instrument endpoint | Gives `expiry` and `expiry2` for a spread. "Maturity" is not always the last trading day. Confirm per product. |
| **Initial margin per lot** | **No FIX source** | **No source** | From the exchange margin files (CME SPAN, ICE IRM) or from Orient's margin schedule. Orient may charge **more** than the exchange. **Keep this manual.** |
| Capital, call level, stop-out, commission rate | **No source** | **No source** | Your terms with Orient. Stays manual, by design. |
| **Current price (mark)** | Market Data session: `269 = 0/1/2/6` (bid/ask/trade/settlement) | **No market data in REST** (UNVERIFIED) | Section 5. |

### 4.1 A rule for anything a feed fills into settings

Contract size and expiry change your margin numbers. Anything a feed proposes for them should
appear as **"TT says 1,000 — you have 1,000 ✓"** or **"TT says 42,000 — you have 1,000 ✗"**. It
should never be written over what you typed. You keep control of the commercial and data
decisions, as your brief asks.

---

## 5. What should a "mark" be for a margin tool?

You chose live intraday plus settlement. Here is the case for how they should work together, rather
than just a list of options.

**Settlement is the price that matters for money.** Orient calculates your variation margin and
margin calls on the exchange settlement price. A RAMP margin figure built on anything else will not
reconcile to Orient's statement. So **after the settlement is published, the mark is the
settlement, full stop.**

**During the day, a mark is an estimate of where you could get out.** For commodity spreads:

- **Last trade is the worst choice for spreads.** Deferred and inter-commodity spreads can go
  untraded for hours, so the last trade may be an hour old while the legs have moved.
- **The mid-price of the spread's own exchange book** is the best estimate *when both sides are
  quoted and the gap is tight*.
- **When the spread book is empty or wide**, the next-best estimate is built from the legs. The
  mid of leg 1 minus the mid of leg 2, with the right ratio, is how the market itself prices an
  illiquid spread.

So the rule I propose is:

1. **Settlement**, if today's settlement has been published.
2. Otherwise, the **spread book mid**, if both sides are quoted and the gap is within a limit you
   set per product.
3. Otherwise, the **mid built from the legs**.
4. Otherwise, the **last value you typed**, clearly labelled.

Every mark is shown with its **source and age**.

**Your hand-typed mark always wins** while you choose to keep it, and it is labelled as yours.

**What this means for cost and infrastructure:**
- Steps 2–3 need live bid/ask: an always-on process (FIX Market Data) **and exchange real-time data
  licences** for every exchange you trade. Those are monthly fees per exchange, charged whatever
  the technology. Professional rates are commonly over $100 a month per exchange group (ASSUMED —
  get Orient's actual pass-through fees).
- **Settlement alone needs neither.** It is published once a day, can be fetched by the existing
  cron, and is often free or cheap for end-of-day use.
- Possible sources for settlement: the exchanges' own end-of-day files (CME publishes settlements;
  ICE's Report Center needs an account — licence terms UNVERIFIED), or TT's `ttmonitor`
  start-of-day records. Those are reported as "priced at settlement" (UNVERIFIED), which would give
  settlement for **products you hold**, from a connection you would already have.

---

## 6. Spreads — the part most likely to double-count

**Today (VERIFIED, from reading `src/lib/csv.js`):**
- A TT export shows a spread order as three rows sharing one `TTOrderID`: the spread and its two
  legs.
- `isSpreadSymbol` uses the product **name** (" - ", "Inter-Product", "Crack", "Calendar", …) to
  decide which row is the trade.
- The other rows are kept with `is_leg = true`. The position, P&L and margin maths skip them
  (VERIFIED: `src/lib/positions.js` filters `!f.is_leg`).

**Over FIX (UNVERIFIED):**
- TT normally sends one `ExecutionReport` per fill event, with the details in two repeating groups:
  `FillsGrp` (one entry per price level filled) and `LegFillsGrp` (one entry per leg fill).
- The session setting **"Send FillsGrp as Individual Execution Reports"** instead sends a separate
  `ExecutionReport` for each entry, covering outright, leg and spread summary fills, in both FIX
  4.2 and 4.4.
- `MultiLegReportingType (442)` says what each report is: **3 = the spread (the trade), 2 = a leg,
  1 = an outright.**

What that means:
- **Use 442, not the product name, to set `is_leg` on feed fills.** 442 = 2 → `is_leg = true`. It
  is an explicit statement from TT, not a guess from a name, so it is cleaner than today's
  signal.
- **Pick the "Individual Execution Reports" setting ON**, so every fill and every leg arrives as
  its own message with its own id. Then one message is one row and nothing has to be unpacked.
  With it OFF, one message carries several fills, and the program must create several rows from
  it. Getting that wrong either loses fills or doubles them.
- **REST probably reports legs too.** How `ttledger` marks spread versus leg is UNVERIFIED (T7).

**The trap — your own synthetic spreads.** If you trade spreads through **TT Autospreader** (a
synthetic spread TT works by trading the legs) rather than an exchange-listed spread:
- The exchange only ever sees **two outright fills**.
- 442 may say 1 (outright) for each.
- TT's Fills grid may also show a synthetic spread row.

Whether to store the spread or the legs then needs a different rule from exchange spreads. If the
wrong side is marked `is_leg`, risk is counted twice or not at all. **Question Y2: do you use
Autospreader?**

---

## 7. History — what you can actually get back

| Route | How far back | Status |
|---|---|---|
| **FIX Recovery Service** (`RecoveryRequest (U2)` or a flag on `Logon (A)`) | **720 hours (~30 days)** for users with fewer than 250 accounts; **168 hours (~7 days)** above that. Replays `ExecutionReport (8)` and `OrderCancelReject (9)` for a time range and market. | UNVERIFIED (search summary). The figures match what you found. |
| `CustomTag 18002=Y` | "Only messages not previously sent" | Not found in what I could reach — UNVERIFIED |
| **TT REST `ttledger`** | **~90 days in production; ~15 days in UAT** | UNVERIFIED (search summary). Matches what you found. |
| REST rate limits | Free: 3 requests/second, 10,000/day; Low: 5/s; Medium: 10/s; High: 25/s, 75,000/day. **POSTs at most one per 10 seconds.** | UNVERIFIED (search summary) |
| Anything older than ~90 days | **No API route found** | Matches what you found |
| Fills from outside TT | Never through a TT feed | VERIFIED by logic |

**Your answer (open positions plus ~90 days) is within what REST can reach, if the 90 days holds.**

Tight edge:
- An **open position opened more than 90 days ago** cannot be rebuilt from REST alone.
- It needs either CSV for its opening fills, or a **start-of-day position record**. That is a
  single "you held 3 lots at X" line, which `ttmonitor` may provide (UNVERIFIED).
- RAMP has no concept of an opening-balance fill today. Adding one is a design decision (Y3).

**First-load path, honestly stated:**
1. You import your older CSV history once, as today.
2. RAMP backfills from REST for the last ~90 days.
3. Where the two overlap, section 8 decides what is a duplicate.
4. From then on, polling keeps it current.
5. Non-TT brokers stay on CSV.

---

## 8. Never storing a fill twice — the identity scheme

### 8.1 What I found in today's import (VERIFIED by running code)

From `src/lib/csv.js`, for a TT Fills export, `ref` is built as:

```
<TTOrderID>|<Contract>|<B/S>|<Price>|<time in milliseconds>
```

TT's grid has no per-fill id column in the layout RAMP reads, so the **order** id plus the details
stand in for one.

I fed two TT rows into the real parser (a throw-away script, deleted afterwards — nothing committed):

```
== TZ=Europe/London
ref column: TTOrderID | equal refs for two partial fills: true
  ORD-1|CL Nov26|Sell|97.78|1789028102114  qty=1
  ORD-1|CL Nov26|Sell|97.78|1789028102114  qty=2
== TZ=Asia/Singapore
ref column: TTOrderID | equal refs for two partial fills: true
  ORD-1|CL Nov26|Sell|97.78|1789002902114  qty=1
  ORD-1|CL Nov26|Sell|97.78|1789002902114  qty=2
```

**Finding A — the ref depends on the computer's time zone.**
- The grid's "09:15:02.114" carries no time zone, so it is read in **whatever time zone the
  browser is set to**.
- The same file gives one ref in London and another in Singapore. The numbers above differ by
  exactly 7 hours.
- Importing the same file from two machines, or from a laptop that changed time zone while you
  travelled, stores **every fill twice**. The database cannot catch it, because the refs really
  are different.
- It may also bite across the BST/GMT change. I have not tested that.

**Finding B — two partial fills can collapse into one.**
- Quantity is not part of the ref.
- If one order fills twice at the same price in the same millisecond (one order filling against two
  resting orders), both rows get the same ref.
- The upsert with `ignoreDuplicates` then **silently drops the second fill**.
- I have not checked whether TT's grid actually prints such pairs as separate rows. If it does,
  your stored position would be short by the dropped quantity (question Y4 — please look for one
  in a real export).

**Why this matters for a feed:** a feed gives UTC times and real fill ids. **No FIX or REST fill
will ever produce the same `ref` as a CSV row for the same trade.** If the feed and the CSV both
cover a day, `unique (user_id, broker, ref)` lets both in. Your position doubles.

### 8.2 The one identity across all five routes

| Route | Identity it can carry |
|---|---|
| Live FIX Drop Copy | `ExecID (17)` / `FillExecID (1363)` / leg exec id |
| FIX Recovery replay | The same ExecIDs (UNVERIFIED — see below) |
| REST backfill | TT's fill id (UNVERIFIED whether it equals the FIX ExecID) |
| CSV upload | **No exec id in today's layout** — only TTOrderID |
| Pasted rows | Same as CSV |

**Proposal:**

- **Primary identity: TT's per-fill execution id**, stored in `ref` as `tt:<exec id>` for feed
  routes.
  - FIX **must** keep `ExecID` the same across a **resend** (`PossDupFlag 43 = Y` re-sends the same
    message).
  - A **recovery replay** should repeat the original ExecIDs. This is UNVERIFIED, but it is the
    whole point of a recovery service. Ask it explicitly (T8).
  - A **reconnect** does not create new fills, so it creates no new ExecIDs.
  - It is **unique per fill, not per message**, provided the "Individual Execution Reports"
    setting is ON. With it OFF, the per-fill id is `FillExecID (1363)` inside the group, not
    `ExecID`.
- **Busts and corrections (UNVERIFIED for TT; standard FIX):**
  - A bust arrives as `ExecType (150) = H` with `ExecRefID (19)` pointing at the original ExecID.
    The original must be **removed or voided**, not ignored.
  - A correction (`ExecType = G`) has a **new** ExecID and refers back to the old one.
  - RAMP has no way to handle either today. The sync must handle both, including a bust that
    arrives *before* the fill it cancels during a replay. In that case it remembers the bust and
    applies it when the fill turns up.
- **Make the CSV carry the same id where possible.** TT's Fills grid has optional columns. If an
  exec-id / fill-id column can be added to the export layout, CSV rows can use `tt:<exec id>` too,
  and the database constraint catches cross-route duplicates. **Question Y6 — can you add one?**
- **Backstop for rows without an exec id (old CSVs, other layouts): a "same-trade fingerprint".**
  - Fingerprint = account + `TTOrderID` + product + side + price + quantity + time **in UTC to the
    second**.
  - Before a feed fill is stored, the sync looks for an existing row with the same fingerprint
    from a different route.
  - If one exists, the fill is **matched, not added**. The existing row gains the exec id, which
    makes the match permanent.
  - Matching is done **by count** (a "multiset"): if CSV holds two identical rows and the feed
    sends two, that is two fills, not four and not one. This is what keeps Finding B from
    reappearing.
- **The seam rule.** For each TT account, RAMP records a **cut-over time**: the moment the feed
  takes over.
  - CSV rows for that account *after* the cut-over are rejected at import with a clear message.
  - Feed fills *before* it go through the fingerprint backstop.
  - So the overlap window is the only place matching has to work, and it is bounded.

### 8.3 Does the key need `account`?

**No, provided the primary id is TT's exec id.** TT ids are unique across accounts (ASSUMED,
because they are system-generated UUIDs), so `(user_id, broker, ref)` stays sound.

Two cases where it would break:
- **Two RAMP "brokers" fed by one TT login.** The sync must map each TT account to exactly one
  RAMP broker.
- **Fingerprint keys.** These do need the account in them, and the proposal includes it.

### 8.4 Changing how `ref` is calculated is itself dangerous

If Finding A is fixed by calculating `ref` differently (for example, reading TT times in a fixed
time zone per broker), every *old* file re-imported later produces new refs that do not match the
stored ones. That causes exactly the double-count we are trying to prevent.

So the fix must:
- recognise **both** the old and the new ref for a row, or
- carry out a one-time migration that rewrites stored refs, after you have seen a dry run.

This is why I sized the identity fix as its own careful piece of work.

### 8.5 The check script (after you approve this design)

`scripts/fill-identity-check.mjs`, in the existing plain-Node style. It will prove at least:

1. The same fill via CSV and via a feed message is stored **once**.
2. The same feed fill delivered three ways (live, resend with `PossDupFlag`, recovery replay) is
   stored **once**.
3. Two genuine partial fills (same order, price and millisecond) are stored **twice**, and a
   re-import of the same file adds nothing.
4. The same CSV parsed in London and in Singapore time produces the **same** ref.
5. A spread with two legs arriving as three messages counts as **one** position.
6. A bust removes the original. A bust that arrives before its fill still ends with nothing stored.
7. `CumQty` is never used as the fill quantity.

I will send you its output.

---

## 9. Stale data and recovery — what you should see

A risk tool that quietly shows yesterday's price as if it were live is dangerous. Proposal:

- **Every mark carries its source and its age**: "Settle 02 Oct", "Live mid 14:32:05",
  "Typed by you 09:10". **No unlabelled numbers.**
- **A status line for each feed**, always visible on the Dashboard:
  - Green: "Fills synced with TT at 14:31".
  - Amber: last successful sync more than 15 minutes ago.
  - Red: more than 60 minutes, or the last attempt failed. "Fills may be missing since 13:20 — last
    TT sync failed: <reason>."
- **Prices go grey and show their age** once older than a limit you set for each product during
  market hours (for example, 2 minutes live / 1 day settlement). Margin and P&L figures built on
  stale prices show a **"based on stale prices"** marker. They do not just carry on looking normal.
- **Nothing falls back silently.** If live prices stop, RAMP does not quietly switch to settlement
  or to your typed mark and carry on looking live. It shows the switch.
- **On reconnect:**
  - FIX's own resend fills short gaps.
  - The Recovery Service (~30 days, UNVERIFIED) fills longer ones.
  - For REST, every poll asks "since the last fill I have, minus a safety overlap". A missed poll
    simply means the next poll fetches more. The overlap is safe *only because* the identity in
    section 8 makes repeats harmless.
- **A daily reconciliation:** RAMP's position per contract compared with TT's own (`ttmonitor`) or
  Orient's statement. Any difference shows as a red line. This is the backstop for everything
  above.

---

## 10. Who holds the credentials

Just you, for now. That keeps this simple and safe:

- **One TT REST application key and secret** (and later one FIX login), created for your Orient TT
  account, **read-only / drop-copy only.** They must not be able to place orders. Ask Orient to
  issue them that way.
- Held **only as server-side secrets** (Vercel environment variables or Supabase Vault). They
  never go into the browser, the `settings` table, the repository or this chat.
- The sync writes to Supabase with server privileges, **scoped in code to your user id**. If that
  code had a bug it could write to another user's rows. So the check script includes a test that a
  sync run for user A cannot write user B's fills.
- **Later, for other users** (not now): one TT key per user. Each user's TT administrator has to
  create keys for them, which is real friction for onboarding. Keys would be stored encrypted per
  user and never readable back. Each user's broker must agree. That is a separate security design,
  not a flag to switch on.

---

## 11. Cost and operating burden

| | REST polling (recommended) | FIX (later, if ever) |
|---|---|---|
| TT side | REST plan (free tier may be enough — UNVERIFIED); key from Orient | FIX entitlement + certification; Orient/TT fees UNVERIFIED |
| Hosting | £0 (Supabase scheduled function) or Vercel Pro ~$20/month | Always-on server £5–£50/month, plus monitoring |
| Exchange data | Settlement: little or none | Live prices: exchange licence fees per exchange per month |
| What breaks at 3am | A poll fails; the next one catches up. The status line turns amber/red. | The process dies or the sequence numbers get out of step. **Nothing updates until someone restarts it**, and you only know if alerting is set up. |
| Who notices | You, from the status line; optionally an email when red for more than an hour (the existing Resend email set-up can send it) | You, unless you pay for monitoring |

---

## 12. Recommendation and phases

Each phase lives on this branch, behind its own check scripts. Nothing is merged until you are
comfortable.

1. **Phase 0 — identity fix** (2–4 days):
   - fix Findings A and B, compatibly with refs already stored;
   - `fill-identity-check.mjs`;
   - a dry-run report of what it would change in your stored fills, before it changes anything.
2. **Phase 1 — REST fill sync** (1–2 weeks):
   - 90-day backfill, polling every 1–5 minutes, the seam rule;
   - bust handling, the status line, the daily reconciliation line.
3. **Phase 2 — settlement marks** (about 1 week, after the source is chosen):
   - the mark rules from section 5, steps 1 and 4;
   - stale labelling.
4. **Phase 3 — live intraday marks** (decide later): only if worth the exchange fees and the
   always-on server. Drop Copy can be added at the same time cheaply.

---

## 13. What I could not verify — questions for Orient / TT support

Send these as written:

- **T1.** What does Orient charge (and TT pass through) for (a) TT REST API access, (b) a TT FIX
  Drop Copy session, (c) a TT FIX Market Data session? What is the lead time?
- **T2.** Who is the TT company administrator for my account? Can they issue a **read-only** REST
  key and a drop-copy-only FIX session for it?
- **T3.** Is my account on the TT REST free tier (3 requests/second, 10,000/day)? Is anything
  higher available?
- **T4.** What is the typical and worst-case delay between a fill and its appearance in `ttledger`
  `GET /fills`?
- **T5.** Is the fill id returned by `ttledger` the **same value** as FIX `ExecID (17)` /
  `FillExecID (1363)` for the same fill?
- **T6.** Is FIX `OrderID (37)` the same value as `TTOrderID` in the Fills grid export?
- **T7.** How does `ttledger` mark a spread summary fill versus its leg fills?
- **T8.** Does the FIX Recovery Service replay fills with their **original** ExecIDs? Confirm the
  720-hour / 250-account limits and what `18002=Y` does.
- **T9.** Confirm `ttledger` retention: 90 days production, 15 days UAT?
- **T10.** How are busts and corrections reported over Drop Copy and in `ttledger`?
- **T11.** Does `ttmonitor` give start-of-day positions with settlement prices for my account?
- **T12.** Are my Asian-venue fills (SGX / DCE / SHFE / INE) routed through TT? If so, do they
  appear in Drop Copy and `ttledger` like CME and ICE fills?
- **T13.** Does TT FIX support `RequestForPositions (AN)` / `PositionReport (AP)`? Nothing I could
  reach confirms it.

## 14. Questions for you

- **Y1.** Which Vercel plan is the project on? (Vercel dashboard → your team → Settings → Billing.)
- **Y2.** Do you trade spreads through TT **Autospreader**, exchange-listed spreads, or both?
- **Y3.** For a position opened more than 90 days ago, would you accept an "opening balance" line
  in RAMP ("held 3 lots at 4.25 as of <date>") instead of its original fills?
- **Y4.** In a real TT export, can you find two rows with the same TTOrderID, price **and**
  time-to-the-millisecond? If so, Finding B is affecting you today.
- **Y5.** Do you place intraday stops off RAMP's marks, or watch them in TT? This decides whether
  live intraday marks are worth their cost.
- **Y6.** In TT's Fills grid, is there a column such as "Exec ID", "Fill ID" or "Exchange Fill ID"
  you can add to your export? (Right-click the column headers → column chooser.)
- **Y7.** Which time zone is your TT Fills grid set to display?

---

## Sources

The primary TT pages were blocked. These are the pages the search summaries cited, listed so you
or Orient can open them:

- [FIX Recovery Service](https://library.tradingtechnologies.com/tt-fix/recovery/fix-recovery-overview.html)
- [Recovery Request (U2)](https://library.tradingtechnologies.com/tt-fix/recovery/Msg_RecoveryRequest_U2.html)
- [TT FIX Drop Copy overview](https://library.tradingtechnologies.com/tt-fix/drop-copy/fix-drop-copy-overview.html)
- [Drop Copy message flows](https://library.tradingtechnologies.com/tt-fix/drop-copy/dc-message-flows.html)
- [Creating a TT FIX Drop Copy session](https://library.tradingtechnologies.com/tt-fix/drop-copy/creating-a-fix-drop-copy-session.html)
- [Configuring client connectivity](https://library.tradingtechnologies.com/tt-fix/drop-copy/configuring-client-connectivity.html)
- [TT FIX Certification](https://library.tradingtechnologies.com/tt-fix/general/Certification.html)
- [LegFillsGrp component](https://library.tradingtechnologies.com/tt-fix/tt-fix-general/fix-message-structure/component-legfillsgrp/)
- [Market Data Request (V)](https://library.tradingtechnologies.com/tt-fix/tt-fix-gateway/price-gateway-messages/market-data-request-v/)
- [TT REST — Before you begin (rate limits)](https://library.tradingtechnologies.com/tt-rest/v2/gs-before.html)
- [ttledger](https://library.tradingtechnologies.com/tt-rest/v2_uat/ttledger.html) ·
  [ttmonitor](https://library.tradingtechnologies.com/tt-rest/v2/ttmonitor.html)
- [TT .NET SDK FAQ (retention)](https://library.tradingtechnologies.com/apis/tt-net-sdk/appendix-tt-net-sdk/frequently-asked-questions-3/)
- [Orient Futures Singapore + TT, Chinese markets](https://tradingtechnologies.com/news-releases/orient-futures-singapore-and-trading-technologies-contract-to-provide-connectivity-to-chinese-derivatives-markets-via-the-tt-platform/)
- Vercel cron limits (secondary): [crontap.com summary](https://crontap.com/blog/vercel-cron-hourly-limit-and-how-to-beat-it)

What I checked in the repo: `src/lib/csv.js` (`rowsToFills`, `isSpreadSymbol`,
`TT_FILLS_HEADERS`), `src/lib/db.js` (`addFills`), `src/lib/positions.js`, `supabase/schema.sql`,
`supabase/migrations/0002_store_spread_legs.sql`, `vercel.json`.
