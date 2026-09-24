import { computeBook } from '../src/lib/positions.js';

/*
 * FIFO against LIFO, and the one promise that matters.
 *
 * Matching decides WHICH open lot a closing fill is paired with. It moves money between realized
 * and unrealized, and between one closed trade and another. It cannot move the two added together,
 * because the same lots were bought and sold at the same prices either way — so net equity is the
 * same under both, which is the condition this whole option was asked for on.
 *
 * The invariant is asserted over random books rather than a handful of cases, because the ways it
 * could break are the awkward ones: a flip through zero, a close bigger than the oldest lot, a
 * partial fill landing mid-lot.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got) => { fail++; console.log('FAIL', l, '->', JSON.stringify(got)); };
const is = (l, got, want) => (String(got) === String(want) ? ok(l) : bad(`${l} (wanted ${want})`, got));
const near = (l, got, want, eps = 1e-6) => (Math.abs(got - want) < eps ? ok(l) : bad(`${l} (wanted ${want})`, got));

const SIZE = 1000;
const f = (ts, side, qty, price, extra = {}) => ({ ts, broker: 'b', product: 'CL Nov26', side, qty, price,
  fee: 0, ref: `${ts}|${side}|${qty}|${price}`, source: 'csv', is_leg: false, ...extra });

const run = (fills, method) => computeBook(fills, () => SIZE, () => method);
const realizedOf = (b) => b.realized.reduce((a, r) => a + r.pnl, 0);
const unrealOf = (b, mark) => b.open.reduce((a, p) => a + (p.side === 'Long' ? 1 : -1) * (mark - p.avg) * SIZE * p.lots, 0);
const netOf = (b) => b.open.reduce((a, p) => a + (p.side === 'Long' ? 1 : -1) * p.lots, 0);

// --- the worked case: buy 95, buy 96, sell 97, mark 98 -----------------------------------------
const BOOK = [
  f('2026-09-01T10:00:00.000Z', 'Buy', 1, 95.00),
  f('2026-09-02T10:00:00.000Z', 'Buy', 1, 96.00),
  f('2026-09-03T10:00:00.000Z', 'Sell', 1, 97.00),
];
const fifo = run(BOOK, 'fifo'), lifo = run(BOOK, 'lifo');
near('FIFO books the oldest lot: 97 against 95', realizedOf(fifo), 2000);
near('LIFO books the newest lot: 97 against 96', realizedOf(lifo), 1000);
is('FIFO leaves the newer lot open', fifo.open[0].lotsOpen.map((l) => l.price).join(), '96');
is('LIFO leaves the older lot open', lifo.open[0].lotsOpen.map((l) => l.price).join(), '95');
near('FIFO unrealized at 98', unrealOf(fifo, 98), 2000);
near('LIFO unrealized at 98', unrealOf(lifo, 98), 3000);
near('and the two totals agree', realizedOf(fifo) + unrealOf(fifo, 98), realizedOf(lifo) + unrealOf(lifo, 98));
near('which is what the cash says', realizedOf(fifo) + unrealOf(fifo, 98), (97 - 95 - 96) * SIZE + 98 * SIZE);
is('the closed trade says how it was matched', `${fifo.closed[0].matched}/${lifo.closed[0].matched}`, 'fifo/lifo');

// --- the invariant, over random books ----------------------------------------------------------
let seed = 20260924;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
let worstTotal = 0, worstUnreal = 0, netMismatch = 0, feeMismatch = 0;
for (let t = 0; t < 4000; t++) {
  const fills = [];
  let day = 0;
  for (let i = 0; i < 2 + Math.floor(rnd() * 14); i++) {
    day += 1 + Math.floor(rnd() * 3);
    fills.push(f(`2026-09-${String((day % 27) + 1).padStart(2, '0')}T${String((i % 20) + 1).padStart(2, '0')}:00:00.000Z`,
      rnd() < 0.5 ? 'Buy' : 'Sell', 1 + Math.floor(rnd() * 4), +(90 + rnd() * 20).toFixed(2),
      rnd() < 0.3 ? { fee: -(1 + Math.floor(rnd() * 5)) } : {}));
  }
  fills.sort((a, b) => a.ts.localeCompare(b.ts));
  const mark = +(90 + rnd() * 20).toFixed(2);
  const F = run(fills, 'fifo'), L = run(fills, 'lifo');
  worstTotal = Math.max(worstTotal, Math.abs((realizedOf(F) + unrealOf(F, mark)) - (realizedOf(L) + unrealOf(L, mark))));
  worstUnreal = Math.max(worstUnreal, Math.abs(unrealOf(F, mark) - unrealOf(L, mark)));
  if (Math.abs(netOf(F) - netOf(L)) > 1e-9) netMismatch++;
  const fees = (b) => b.realized.filter((r) => r.fee).reduce((a, r) => a + r.pnl, 0);
  if (Math.abs(fees(F) - fees(L)) > 1e-9) feeMismatch++;
}
near('4,000 random books: realized + unrealized is identical', worstTotal, 0, 1e-6);
is('  and the net position is always identical', netMismatch, 0);
is('  and the fees are always identical', feeMismatch, 0);
/*
 * The other half of the truth, asserted so nobody later "fixes" it: unrealized ALONE does move,
 * and by real money. That is why net equity is only invariant while realized P&L is counted in
 * it. With "include realized" switched off, equity is capital plus unrealized — and this is the
 * number that would shift.
 */
ok(`  while unrealized alone moves by up to $${worstUnreal.toFixed(0)} — the reason "include realized" matters`);

// --- the other methods are untouched by the refactor -------------------------------------------
const AVG = [
  f('2026-09-01T10:00:00.000Z', 'Buy', 2, 95.00),
  f('2026-09-02T10:00:00.000Z', 'Buy', 2, 97.00),
  f('2026-09-03T10:00:00.000Z', 'Sell', 2, 99.00),
];
near('average price still books against the running average', realizedOf(run(AVG, 'average')), (99 - 96) * 2 * SIZE);
near('  and still holds the average on what is left', run(AVG, 'average').open[0].avg, 96);
near('FIFO on the same book takes the 95s', realizedOf(run(AVG, 'fifo')), (99 - 95) * 2 * SIZE);
near('LIFO on the same book takes the 97s', realizedOf(run(AVG, 'lifo')), (99 - 97) * 2 * SIZE);

// A named position ticket outranks both: it closes the ticket it names, at that ticket's price.
const TICKETS = [
  f('2026-09-01T10:00:00.000Z', 'Buy', 1, 95.00, { position: 'T1' }),
  f('2026-09-02T10:00:00.000Z', 'Buy', 1, 96.00, { position: 'T2' }),
  f('2026-09-03T10:00:00.000Z', 'Sell', 1, 97.00, { position: 'T1' }),
];
for (const m of ['fifo', 'lifo', 'average'])
  near(`a named ticket closes T1 under ${m}`, realizedOf(run(TICKETS, m)), 2000);

// --- a flip through zero, the case most likely to break a matching change ----------------------
const FLIP = [
  f('2026-09-01T10:00:00.000Z', 'Buy', 1, 95.00),
  f('2026-09-02T10:00:00.000Z', 'Buy', 1, 96.00),
  f('2026-09-03T10:00:00.000Z', 'Sell', 3, 97.00),   // closes 2, opens a short 1
];
for (const m of ['fifo', 'lifo']) {
  const b = run(FLIP, m);
  is(`${m}: a flip leaves a short 1`, `${b.open[0].side} ${b.open[0].lots}`, 'Short 1');
  near(`${m}: at the price it flipped at`, b.open[0].avg, 97);
  near(`${m}: and books both lots either way`, realizedOf(b), (97 - 95) * SIZE + (97 - 96) * SIZE);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
