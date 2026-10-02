# One duplicate rule for everything that enters the book

Double-counting is the failure this product exists to prevent. A fill counted twice doubles
the position; a deposit counted twice makes equity, and every margin ratio built on it, wrong.

## The rule

Every record carries a **key** that says where it came from, and **the database refuses a
second record with the same key for the same account**. Uniqueness lives in Postgres, not in
screen code, because screens get refactored and constraints don't.

A key cannot catch the same thing arriving under **two different keys** (a deal number this
time, none last time; typed by hand, then on a statement). So every route also compares
**content**:

| Match | What happens |
|---|---|
| Same key | Skipped. Database guarantee. |
| Identical content (fills: product, side, qty, price, second · cash: account, type, amount to the cent, minute) | Skipped, and the trader is told which stored record it matched. |
| Close but not identical (cash: same account, type, amount within 3 days) | **Never decided in code.** Shown to the trader, who says whether it is the same money. |
| Both carry the broker's own reference, and they differ | Different records, by the broker's say-so. Never held back. |

Identical records are counted, not collapsed: two genuine identical deposits in one file stay
two, and re-reading that file adds neither again.

## Where it stands

| Route | Writes to | Key | Status |
|---|---|---|---|
| CSV / Excel / pasted TT rows | fills | `(user, broker, ref)` unique + content match | Existing |
| Flatten button | fills | unique `flat:` ref per click, on purpose | Existing |
| MT5 balance rows in a report | cash | `deal:<n>`, or `csv:<content>\|<occurrence>` | **0013** |
| Deposit / withdrawal / charge typed by hand | cash | `manual:<id>` + warning on content match | **0013** |
| Orient statement | cash (proposed, not posted) | broker reference, else account + date + type + amount | Next, after the statement layout |
| TT REST backfill, FIX drop copy, FIX replay | fills | must produce the **same ref** as the CSV route for the same fill | Not built. A FIX ExecID is a different string from the CSV ref, so today's constraint would not catch the overlap. |

`marks` (keyed by account and product), `statement` (keyed by account) and `history` (replaced
per day by `mergeSnapshot`) are overwritten rather than appended, so re-writing them is
naturally idempotent.

## The cash ledger (migration 0013)

The ledger moved out of the `settings` JSON into `public.cash_entries`, unique on
`(user_id, broker, source_key)`. This also ends a quieter problem: settings are saved whole,
last write wins, so two tabs could overwrite each other and a deposit could vanish.

Statuses: **accepted** counts toward equity; **proposed** waits on the trader (statements);
**rejected** is kept so the same entry is not offered again.

### Running it

1. Supabase → SQL Editor → paste `supabase/migrations/0013_cash_entries.sql` → Run.
2. Run the check at the bottom of that file. Every line must say `match`. A `DIFFERENT` line
   names an account whose old list held something the migration would not guess at.
3. Deploy. The old list in `settings.data->'cash'` is never changed; it stays as the backup.
   It is safe to run step 1 again just before deploying, to pick up anything recorded in the
   meantime: each entry is copied once however many times it runs.

Until step 1 has run, the app shows the old ledger read-only, with a banner, rather than
failing to load.

### Rolling back

Run `0013_cash_entries_rollback.sql` and redeploy the previous version, which reads the old
list again. Entries recorded after 0013 exist only in the new table; export them first.

## Proof

`node scripts/cash-check.mjs`: the same statement twice leaves the ledger unchanged; an
overlapping statement adds only what is new; a migrated entry is recognised when re-imported
under a new key; a near match is put to the trader and not added; a rejected entry is not
offered again; the migration's copy keeps count and total to the cent.

The SQL was also run against a local Postgres 16: run twice copies once, the unique key
refuses a repeat, row-level security keeps each trader to their own rows, and the rollback
leaves the old list intact.
