import { computeBook } from '../src/lib/positions.js';
import { winLossByDay } from '../src/lib/history.js';

/*
 * Commission has to land in exactly one place, and the same place twice over.
 *
 * The book keeps two tallies of realized money: a ledger entry per fill, which the top bar's
 * "Today" is worked out from, and a per-closed-trade figure, which the Closed page, the
 * Analysis strip and the daily table are worked out from. They are different code paths over
 * the same fills, so they can drift — and when they do, the app shows a trader two different
 * answers to "what did I make today" and neither is obviously the wrong one.
 *
 * They drifted. A fill that ADDED to an open position had its commission pushed to the
 * ledger and to the cycle, but the lot it opened was created with a fee of zero — so every
 * figure derived from closed trades was short by exactly that fee. A two-lot scale-in at $5
 * a side read $385 where the money was $380.
 *
 * Fees are stored NEGATIVE, as a cost. That is the app's convention throughout.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got, want) => { fail++; console.log('FAIL', l, `-> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
const near = (l, got, want) => (Math.abs(got - want) < 0.005 ? ok(l) : bad(l, got, want));
const is = (l, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(l) : bad(l, got, want));

const SIZE = 1000, FEE = -5;
const f = (side, price, ts, ref, qty = 1) => ({ broker: 'o', product: 'X', side, qty, price, fee: FEE, ts, ref });
const book = (fills, method = 'fifo') => computeBook(fills, () => SIZE, () => method);
const ledger = (b) => +b.realized.reduce((a, r) => a + r.pnl, 0).toFixed(2);
const trades = (b) => +b.closed.reduce((a, c) => a + c.pnl, 0).toFixed(2);
const feesOn = (b) => +b.closed.reduce((a, c) => a + c.fees, 0).toFixed(2);

/*
 * The case that was wrong: scale in, then out. Buy 1, buy 1, sell 1, sell 1.
 *   gross = (8.4 - 8.1) x 1000 + (8.4 - 8.3) x 1000 = 300 + 100 = 400
 *   fees  = 4 fills x $5                            = $20
 *   net   = $380
 */
const scaleIn = book([
  f('Buy', -8.4, '2026-10-25T09:00:00Z', 'o0'), f('Buy', -8.4, '2026-10-25T09:01:00Z', 'o1'),
  f('Sell', -8.1, '2026-10-25T15:00:00Z', 'c0'), f('Sell', -8.3, '2026-10-25T15:01:00Z', 'c1'),
]);
near('scaling in: the ledger has the money', ledger(scaleIn), 380);
near('scaling in: the closed trades agree with it', trades(scaleIn), 380);
near('scaling in: every fill\'s commission reached a trade', feesOn(scaleIn), 4 * FEE);
is('scaling in: two round trips', scaleIn.closed.length, 2);
is('scaling in: each carries both its sides\' commission', scaleIn.closed.map((c) => c.fees), [-10, -10]);

// And the daily table, which is what a trader reads, must show that same number.
is('the daily figure is the ledger figure', winLossByDay(scaleIn.closed).map((r) => [r.d, +r.net.toFixed(2)]), [['2026-10-25', 380]]);

// --- the same, three deep, so it is not a coincidence of two ---
const deep = book([
  f('Buy', 100, '2026-10-25T09:00:00Z', 'a'), f('Buy', 100, '2026-10-25T09:01:00Z', 'b'), f('Buy', 100, '2026-10-25T09:02:00Z', 'c'),
  f('Sell', 101, '2026-10-25T15:00:00Z', 'd', 3),
]);
near('three lots in, one fill out: ledger', ledger(deep), 3 * 1000 - 20);
near('three lots in, one fill out: trades agree', trades(deep), ledger(deep));
near('and all four commissions are attributed', feesOn(deep), 4 * FEE);

// --- a plain one-in-one-out was always right, and still is ---
const simple = book([f('Buy', 100, '2026-10-25T09:00:00Z', 'a'), f('Sell', 101, '2026-10-25T15:00:00Z', 'b')]);
near('one in, one out: ledger', ledger(simple), 1000 - 10);
near('one in, one out: trades agree', trades(simple), ledger(simple));

// --- average-price accounts (MT5) reach the same total by a different path ---
const avg = book([
  f('Buy', 100, '2026-10-25T09:00:00Z', 'a'), f('Buy', 102, '2026-10-25T09:01:00Z', 'b'),
  f('Sell', 103, '2026-10-25T15:00:00Z', 'c', 2),
], 'average');
near('average matching: ledger', ledger(avg), (103 - 101) * 2 * SIZE - 15);
near('average matching: trades agree', trades(avg), ledger(avg));

// --- a position still open books its commission to the ledger, and closes nothing ---
const open = book([f('Buy', 100, '2026-10-25T09:00:00Z', 'a'), f('Buy', 100, '2026-10-25T09:01:00Z', 'b')]);
near('an open position still pays commission', ledger(open), 2 * FEE);
is('but closes no trade', open.closed.length, 0);
is('so the daily table shows no day at all', winLossByDay(open.closed), []);

// --- flipping through zero ---
const flip = book([
  f('Buy', 100, '2026-10-25T09:00:00Z', 'a'), f('Buy', 100, '2026-10-25T09:01:00Z', 'b'),
  f('Sell', 101, '2026-10-25T15:00:00Z', 'c', 4),
]);
near('flipping long to short: ledger', ledger(flip), 2 * 1000 - 15);
near('flipping long to short: trades agree', trades(flip), ledger(flip));

// --- no commission at all, so a zero never hides a mismatch ---
const free = book([
  { broker: 'o', product: 'X', side: 'Buy', qty: 1, price: 100, fee: 0, ts: '2026-10-25T09:00:00Z', ref: 'a' },
  { broker: 'o', product: 'X', side: 'Buy', qty: 1, price: 100, fee: 0, ts: '2026-10-25T09:01:00Z', ref: 'b' },
  { broker: 'o', product: 'X', side: 'Sell', qty: 2, price: 101, fee: 0, ts: '2026-10-25T15:00:00Z', ref: 'c' },
]);
near('with no commission the two still agree', trades(free), ledger(free));
near('and that is the gross', trades(free), 2000);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
