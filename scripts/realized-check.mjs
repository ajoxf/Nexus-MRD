import { computeBook } from '../src/lib/positions.js';
import { dailyRows, dailyCsv, moneyByDay, moneyByProduct, filterLedger, ledgerTotal } from '../src/lib/history.js';

/*
 * REALIZED MONEY MUST BE THE SAME NUMBER EVERYWHERE.
 *
 * computeBook keeps two tallies: `realized`, one entry per fill, booked as it happens; and
 * `closed`, one row per finished round trip. Everything that summed `closed` was reporting
 * money that had not yet "finished" as zero.
 *
 * Buy 5, sell 2 at a profit, keep 3: the ledger says $3,995 and there is no closed trade at
 * all. The top bar said $3,995 while the Closed tab, the Analysis strip, the daily table and
 * the Positions tiles all said $0 — two answers on one screen to "what have I made".
 *
 * These pin the rule: money comes from the ledger, statistics come from round trips.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got, want) => { fail++; console.log('FAIL', l, `-> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
const near = (l, got, want) => (Math.abs(got - want) < 0.005 ? ok(l) : bad(l, got, want));
const is = (l, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(l) : bad(l, got, want));

const F = (o) => ({ broker: 'o', product: 'X', fee: 0, ...o });
const book = (fills, m = 'fifo') => computeBook(fills, () => 1000, () => m);

/*
 * The case that started it. Bought 5 at 100 on the 15th paying $12.50, sold 2 at 102 on the
 * 16th paying $5. Gross on the two sold is 2 x 1000 x 2 = $4,000, less $5 = $3,995 on the
 * 16th; the 15th cost $12.50. $3,982.50 in all, and nothing has finished.
 */
const PARTIAL = [
  F({ side: 'Buy', qty: 5, price: 100, fee: -12.5, ts: '2026-09-15T10:00:00Z', ref: 1 }),
  F({ side: 'Sell', qty: 2, price: 102, fee: -5, ts: '2026-09-16T10:00:00Z', ref: 2 }),
];

for (const method of ['fifo', 'average']) {
  console.log(`\n-- ${method} --`);
  const b = book(PARTIAL, method);
  near(`${method}: the ledger has the money`, ledgerTotal(b.realized), 3982.5);
  is(`${method}: and no round trip has finished`, b.closed.length, 0);
  near(`${method}: summing round trips would report nothing`, b.closed.reduce((a, c) => a + c.pnl, 0), 0);

  // The daily table must show both days, and the money on the day it was made.
  const rows = dailyRows(b.closed, b.realized);
  is(`${method}: both days appear`, rows.map((r) => r.d), ['2026-09-15', '2026-09-16']);
  near(`${method}: the 15th shows its commission`, rows[0].net, -12.5);
  near(`${method}: the 16th shows the $3,995 made`, rows[1].net, 3995);
  near(`${method}: the running total ends at the ledger`, rows[rows.length - 1].run, 3982.5);
  is(`${method}: and says no trade finished`, [rows[0].trades, rows[1].trades], [0, 0]);
}

console.log('\n-- money is booked on the day it was made --');
/*
 * A round trip closed by three fills over three days books its whole P&L on the last one in
 * `closed`. The ledger books each piece on its own day, which is where the money went.
 */
const SPREAD_OUT = [
  F({ side: 'Buy', qty: 3, price: 100, ts: '2026-09-10T10:00:00Z', ref: 1 }),
  F({ side: 'Sell', qty: 1, price: 101, ts: '2026-09-11T10:00:00Z', ref: 2 }),
  F({ side: 'Sell', qty: 1, price: 102, ts: '2026-09-12T10:00:00Z', ref: 3 }),
  F({ side: 'Sell', qty: 1, price: 103, ts: '2026-09-13T10:00:00Z', ref: 4 }),
];
const sb = book(SPREAD_OUT);
is('one round trip, closed on the 13th', [sb.closed.length, sb.closed[0].closeTs.slice(0, 10)], [1, '2026-09-13']);
near('worth $6,000 in total', sb.closed[0].pnl, 6000);
const spreadDays = dailyRows(sb.closed, sb.realized);
// Three days, not four: the 10th only opened the position, paying no commission, so it
// realized nothing and has no row — the same rule that keeps untraded days out of the table.
is('but the money lands on three days, not all on the last', spreadDays.map((r) => [r.d.slice(5), r.net]),
   [['09-11', 1000], ['09-12', 2000], ['09-13', 3000]]);
near('and still totals $6,000', spreadDays[spreadDays.length - 1].run, 6000);

console.log('\n-- a flat book is unchanged, which is how it was ever right --');
const FLAT = [
  F({ side: 'Buy', qty: 2, price: 100, fee: -5, ts: '2026-09-15T10:00:00Z', ref: 1 }),
  F({ side: 'Sell', qty: 2, price: 102, fee: -5, ts: '2026-09-16T10:00:00Z', ref: 2 }),
];
for (const method of ['fifo', 'average']) {
  const b = book(FLAT, method);
  near(`${method}: ledger and round trips agree when nothing is open`, ledgerTotal(b.realized), b.closed.reduce((a, c) => a + c.pnl, 0));
  near(`${method}: at $3,990`, ledgerTotal(b.realized), 3990);
}

console.log('\n-- per product --');
const TWO = [
  F({ side: 'Buy', qty: 2, price: 100, ts: '2026-09-15T10:00:00Z', ref: 1 }),
  F({ side: 'Sell', qty: 1, price: 105, ts: '2026-09-16T10:00:00Z', ref: 2 }),
  F({ product: 'Y', side: 'Buy', qty: 1, price: 50, ts: '2026-09-15T10:00:00Z', ref: 3 }),
  F({ product: 'Y', side: 'Sell', qty: 1, price: 49, ts: '2026-09-16T10:00:00Z', ref: 4 }),
];
const tb = book(TWO);
const byProd = moneyByProduct(tb.realized);
near('X made $5,000 with nothing finished', byProd.get('o|X'), 5000);
near('Y lost $1,000 on a finished trade', byProd.get('o|Y'), -1000);
near('and the two are the whole ledger', byProd.get('o|X') + byProd.get('o|Y'), ledgerTotal(tb.realized));

console.log('\n-- narrowing the ledger the way the screens do --');
near('by broker', ledgerTotal(filterLedger(tb.realized, { broker: 'o' })), ledgerTotal(tb.realized));
near('by a broker that traded nothing', ledgerTotal(filterLedger(tb.realized, { broker: 'nope' })), 0);
near('by product', ledgerTotal(filterLedger(tb.realized, { product: 'Y' })), -1000);
near('by date, one day', ledgerTotal(filterLedger(tb.realized, { from: '2026-09-16', to: '2026-09-16' })), 4000);
near('by date, before anything', ledgerTotal(filterLedger(tb.realized, { to: '2026-09-14' })), 0);
is('an entry with no timestamp is not counted', filterLedger([{ pnl: 5 }], { from: '2026-01-01' }).length, 0);

console.log('\n-- the CSV carries the same money --');
const csv = dailyCsv(tb.closed, tb.realized, () => 'Orient');
const lines = csv.split('\n').filter(Boolean);
const dayLines = lines.slice(1).filter((l) => l.split(',')[1] === 'Day');
near('the day rows total the ledger', dayLines.reduce((a, l) => a + Number(l.split(',')[9]), 0), ledgerTotal(tb.realized));
near('and the last running total is it too', Number(dayLines[dayLines.length - 1].split(',')[10]), ledgerTotal(tb.realized));

console.log('\n-- nothing to report --');
is('an empty book has no days', dailyRows([], []), []);
is('no ledger, no money', ledgerTotal([]), 0);
is('undefined is the same as empty', [...moneyByDay(undefined)], []);
is('a commission-only day still appears', dailyRows([], [{ ts: '2026-09-16T10:00:00Z', broker: 'o', product: 'X', pnl: -5, fee: true }]).map((r) => [r.d, r.net, r.trades]), [['2026-09-16', -5, 0]]);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
