# Adding a new broker

Before the first upload from a broker you have not used before, work through
this. The importer can tell what shape a file is — where the columns are, what
separates them, which column is the price. It cannot tell what the numbers
*mean*. A layout it doesn't understand shows you an error; a convention it has
guessed wrong imports cleanly and is quietly wrong for months.

Ask the broker, or read it off a statement you have already reconciled by hand.

## 1. Get the right report

Brokers issue several, and they are not interchangeable.

- **Fills / deals / executions** — one row per execution. This is what we want.
- **Orders** — one row per order, usually at an average price. Importing these
  instead of fills changes your entry prices and breaks FIFO matching.
- **Positions / open trades** — a snapshot, not a history. Not importable.

Some statements hold all three as sections of one file. Confirm which section
you are pointing at. Importing Orders *and* Deals counts every trade twice.

## 2. Settle these before uploading

| Question | Why it matters |
|---|---|
| Contract size per product | Never stated in the file. A wrong multiplier scales every P&L number by a constant factor. |
| Price units — points, dollars, cents per gallon | Changes P&L by 100x in either direction. |
| Are spread prices negative? | A back-month-over-front spread often prints as a negative number. |
| Time zone of the timestamps | Exchange time, platform local time, or server time? An hour's error rolls fills into the wrong session and computes the daily loss limit against the wrong day. |
| Date order — DMY or MDY | `09/11/26` is ambiguous up to the 12th of any month. Set it explicitly; don't let it guess. |
| Does the file list spreads, legs, or both? | If both are present and both are imported, every spread trade counts twice. |
| Is there a unique fill or deal ID? | Duplicate detection rests on it. Without one the importer falls back to time + product + side + quantity + price, and two genuine identical fills in the same second collapse into one. |
| Commission — per lot per side, or round turn? | Halves or doubles your cost per trade. |
| Is commission already inside the P&L column? | Otherwise it gets deducted twice. |
| Which column holds the account number? | So a multi-account file splits to the right accounts. |
| What do the non-trade rows mean? | Deposits, withdrawals, charges, rollovers, corrections — decide which belong in the funds ledger. |

## 3. Test on one day before loading the history

1. Export a single day you have already checked against the broker's statement.
2. Import it, then compare, in this order:
   - the **number of fills** against the statement's own count;
   - the **average entry price** on one position, to five decimals;
   - the **realised P&L** on one closed trade, against the broker's figure;
   - the **commission total** for the day.
3. If any of those disagree, it is a convention above, not a bug. Find which one.
4. Only once the day reconciles, load the full history.

If a test import goes wrong, delete the broker's fills and start again — the
app takes a backup before any delete, and re-importing the same file adds
nothing, because duplicates are skipped.

## 4. Map the broker's P&L column if it has one

Where the statement carries its own realised P&L per trade, map it during
import. The importer compares it against what your contract size implies and
tells you when they disagree — the fastest check there is that item 1 above is
right.

## Formats already understood

- **TT (Trading Technologies) Fills grid** — right-click the Fills window →
  Select All → save. Exports with **no header row**; the importer recognises
  the layout by shape. Also accepts the same rows pasted from the clipboard.
- **MT5 reports** — HTML-derived exports with title lines and a Deals section;
  server-time offsets are applied where the file carries an offset column;
  balance rows become funds-ledger entries.
- **Orient** — fills export.

These are separate templates and must stay separate. MT5's conventions do not
apply to TT's files and vice versa.
