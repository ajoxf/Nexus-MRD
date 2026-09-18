import { computeBook } from '../src/lib/positions.js';
import { dailyRows, dailyCsv, dayProducts, moneyByDay, moneyByProduct, filterLedger, ledgerTotal } from '../src/lib/history.js';

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


console.log('\n-- every figure on a page must add up to every other figure on it --');
/*
 * The point of a breakdown is checking a total against its parts. When the day row moved to
 * the ledger and the products under it did not, opening a day showed $2,982.50 breaking
 * into one product at -$1,000 and the other $3,995 nowhere. A breakdown that does not
 * reconcile is worse than none: it makes the total look wrong when it is right.
 */
const MIX = [
  F({ product: 'X', side: 'Buy', qty: 5, price: 100, fee: -12.5, ts: '2026-09-16T09:00:00Z', ref: 1 }),
  F({ product: 'X', side: 'Sell', qty: 2, price: 102, fee: -5, ts: '2026-09-16T15:00:00Z', ref: 2 }),
  F({ product: 'Y', side: 'Buy', qty: 1, price: 50, ts: '2026-09-16T09:00:00Z', ref: 3 }),
  F({ product: 'Y', side: 'Sell', qty: 1, price: 49, ts: '2026-09-16T16:00:00Z', ref: 4 }),
];
const mb = book(MIX);
const mixRows = dailyRows(mb.closed, mb.realized);
const mixParts = dayProducts(mb.closed, mb.realized);
for (const r of mixRows) {
  const kids = mixParts.get(r.d) || [];
  near(`the products under ${r.d} add up to the day`, kids.reduce((a, g) => a + g.net, 0), r.net);
}
near('and the days add up to the ledger', mixRows.reduce((a, r) => a + r.net, 0), ledgerTotal(mb.realized));
near('which is also the per-product total', [...moneyByProduct(mb.realized).values()].reduce((a, v) => a + v, 0), ledgerTotal(mb.realized));

// A product with money but no finished trade must still get a row, or the parts go missing.
const day = mixParts.get('2026-09-16');
is('both products appear', day.map((g) => g.product).sort(), ['X', 'Y']);
const X = day.find((g) => g.product === 'X');
near('X carries its money', X.net, 3982.5);
is('while admitting no trade of its finished', [X.trades, X.wins, X.losses], [0, 0, 0]);
const Y = day.find((g) => g.product === 'Y');
near('Y carries its money', Y.net, -1000);
is('and its one finished loser', [Y.trades, Y.wins, Y.losses], [1, 0, 1]);

// The CSV is read in a spreadsheet, where somebody will total the column.
const mixCsv = dailyCsv(mb.closed, mb.realized, () => 'Orient').split('\n').filter(Boolean).slice(1).map((l) => l.split(','));
const dayCells = mixCsv.filter((c) => c[1] === 'Day'), prodCells = mixCsv.filter((c) => c[1] === 'Product');
near('the CSV day rows total the ledger', dayCells.reduce((a, c) => a + Number(c[9]), 0), ledgerTotal(mb.realized));
near('and so do its product rows', prodCells.reduce((a, c) => a + Number(c[9]), 0), ledgerTotal(mb.realized));


console.log('\n-- nothing is counted twice, on four thousand random books --');
/*
 * The strongest statement available about double counting, and it needs no fixtures.
 *
 * For a book that ends FLAT, three numbers arrived at independently must agree:
 *   the ledger (one entry per fill), the closed round trips (one row per finished trade),
 *   and raw cash — sell proceeds less buy cost plus fees, which no part of the engine
 *   touches. Count anything twice, or lose it, and they part company.
 *
 * Deterministic: the same seed every run, so a failure is reproducible rather than a
 * story about a random book nobody can find again.
 */
let seed = 12345;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const anyOf = (a) => a[Math.floor(rnd() * a.length)];
let worst = 0, flatBooks = 0;
for (let run = 0; run < 4000; run++) {
  const method = anyOf(['fifo', 'average']);
  const size = anyOf([1, 100, 1000]);
  const n = 2 + Math.floor(rnd() * 8);
  const rf = [];
  let pos = 0;
  for (let i = 0; i < n; i++) {
    const q = 1 + Math.floor(rnd() * 3);
    const side = pos > 0 && rnd() < 0.6 ? 'Sell' : pos < 0 && rnd() < 0.6 ? 'Buy' : anyOf(['Buy', 'Sell']);
    rf.push(F({ product: 'P', side, qty: q, price: +(50 + rnd() * 100).toFixed(2), fee: -+(rnd() * 5).toFixed(2),
      ts: new Date(Date.UTC(2026, 8, 1 + i, 10)).toISOString(), ref: `f${i}` }));
    pos += side === 'Buy' ? q : -q;
  }
  if (pos !== 0) rf.push(F({ product: 'P', side: pos > 0 ? 'Sell' : 'Buy', qty: Math.abs(pos),
    price: +(50 + rnd() * 100).toFixed(2), fee: -+(rnd() * 5).toFixed(2),
    ts: new Date(Date.UTC(2026, 8, 1 + n, 10)).toISOString(), ref: 'fz' }));
  const rb = computeBook(rf, () => size, () => method);
  if (rb.open.length) continue;
  flatBooks++;
  const led = rb.realized.reduce((a, r) => a + r.pnl, 0);
  const rounds = rb.closed.reduce((a, c) => a + c.pnl, 0);
  const cash = rf.reduce((a, f) => a + (f.side === 'Sell' ? 1 : -1) * f.qty * f.price * size + f.fee, 0);
  worst = Math.max(worst, Math.abs(led - rounds), Math.abs(led - cash));
}
is('four thousand books, all squared off', flatBooks, 4000);
ok(`ledger, round trips and raw cash never differ by more than ${worst.toExponential(1)}`);
if (worst > 0.005) bad('they must agree to the cent', worst, 0);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
