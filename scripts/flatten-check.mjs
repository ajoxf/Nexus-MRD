import { flattenPlan, planFills, planPnl } from '../src/lib/flatten.js';
import { computeBook } from '../src/lib/positions.js';

/*
 * Flattening, checked the only way that matters: write the fills, run the book again, and see
 * what the trader would see. A plan that says "+$0" and then books a loss once the engine gets
 * hold of it is worse than no feature, because the number on the confirm screen is the one the
 * decision was made on.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got) => { fail++; console.log('FAIL', l, '->', JSON.stringify(got)); };
const near = (l, got, want, eps = 1e-6) => (Math.abs(got - want) < eps ? ok(`${l} (${got.toFixed(2)})`) : bad(`${l} (wanted ${want})`, got));
const is = (l, got, want) => (String(got) === String(want) ? ok(l) : bad(`${l} (wanted ${want})`, got));

const SIZE = 1000;
const fill = (ts, product, side, qty, price, extra = {}) =>
  ({ ts, broker: 'b1', product, side, qty, price, fee: 0, ref: `${ts}|${product}|${side}|${price}`, source: 'csv', is_leg: false, ...extra });

// A position row as the Positions tab hands it over.
const rowOf = (book, product, mark) => {
  const p = book.open.find((o) => o.product === product);
  return { ...p, key: `b1|${product}`, size: SIZE, mark };
};

// --- a long, bought twice, marked above entry -------------------------------------------------
const LONG = [
  fill('2026-08-24T12:00:00.000Z', 'CL Oct26', 'Buy', 2, 85.00),
  fill('2026-08-24T13:00:00.000Z', 'CL Oct26', 'Buy', 1, 86.00),
];
let book = computeBook(LONG, () => SIZE, () => 'fifo');
const long = rowOf(book, 'CL Oct26', 88.00);           // avg 85.3333, 3 lots, +$8,000 open
is('the position is what the test assumes', `${long.side} ${long.lots}`, 'Long 3');
near('open P&L at the mark', (long.mark - long.avg) * SIZE * long.lots, 8000);

const replay = (plan) => computeBook([...LONG, ...planFills(plan)], () => SIZE, () => 'fifo');

// at entry: nothing happens to the money
let plan = flattenPlan([long], { at: 'entry' });
near('flatten at entry books nothing', planPnl(plan), 0);
let after = replay(plan);
is('  and the position is gone', after.open.length, 0);
near('  and the book agrees', after.closed.reduce((a, c) => a + c.pnl, 0), 0);

// at the mark: today's open P&L becomes realized, to the cent
plan = flattenPlan([long], { at: 'mark' });
near('flatten at the mark books the open P&L', planPnl(plan), 8000);
after = replay(plan);
near('  and the book agrees', after.closed.reduce((a, c) => a + c.pnl, 0), 8000);
is('  and the position is gone', after.open.length, 0);

// at a stated price, below entry
plan = flattenPlan([long], { at: 'price', price: 84.00 });
near('flatten at a stated price', planPnl(plan), (84 - long.avg) * SIZE * 3);
after = replay(plan);
near('  and the book agrees', after.closed.reduce((a, c) => a + c.pnl, 0), (84 - long.avg) * SIZE * 3);

// --- a short closes the same way, with the sign the other way round ----------------------------
const SHORT = [fill('2026-08-24T12:00:00.000Z', 'BZ Oct26', 'Sell', 3, 93.00)];
book = computeBook(SHORT, () => SIZE, () => 'fifo');
const short = rowOf(book, 'BZ Oct26', 95.00);
is('the short is what the test assumes', `${short.side} ${short.lots}`, 'Short 3');
plan = flattenPlan([short], { at: 'mark' });
near('a short flattened above entry is a loss', planPnl(plan), -6000);
is('  the offsetting fill buys', plan[0].fills[0].side, 'Buy');
after = computeBook([...SHORT, ...planFills(plan)], () => SIZE, () => 'fifo');
near('  and the book agrees', after.closed.reduce((a, c) => a + c.pnl, 0), -6000);

// --- a negative spread price is a price like any other -----------------------------------------
const SPR = [fill('2026-08-24T12:00:00.000Z', 'CL Oct26 - BZ Oct26 Inter-Product', 'Buy', 3, -7.61)];
book = computeBook(SPR, () => SIZE, () => 'fifo');
const spr = rowOf(book, 'CL Oct26 - BZ Oct26 Inter-Product', -7.20);
plan = flattenPlan([spr], { at: 'mark' });
near('a spread widening from -7.61 to -7.20 is a gain', planPnl(plan), 0.41 * SIZE * 3, 1e-9);
after = computeBook([...SPR, ...planFills(plan)], () => SIZE, () => 'fifo');
near('  and the book agrees', after.closed.reduce((a, c) => a + c.pnl, 0), 0.41 * SIZE * 3, 1e-9);
plan = flattenPlan([spr], { at: 'entry' });
near('  flattened at its own entry it books nothing', planPnl(plan), 0);

// --- several positions at once -----------------------------------------------------------------
plan = flattenPlan([long, short, spr], { at: 'entry' });
is('three positions produce three plans', plan.length, 3);
near('and book nothing between them', planPnl(plan), 0);
after = computeBook([...LONG, ...SHORT, ...SPR, ...planFills(plan)], () => SIZE, () => 'fifo');
is('leaving the book flat', after.open.length, 0);

// --- fills are ordinary fills, and can be told apart -------------------------------------------
const f = planFills(flattenPlan([long], { at: 'entry' }))[0];
is('the fill is marked as a flatten', f.source, 'flatten');
is('it is not a leg', f.is_leg, false);
is('its reference says so', /^flat:/.test(f.ref), true);
is('two flattens at one instant are two fills, not one', new Set(planFills(flattenPlan([long, short], { at: 'entry' })).map((x) => x.ref)).size, 2);

// --- a hedging account closes each ticket by name ----------------------------------------------
const HEDGE = [
  fill('2026-08-24T12:00:00.000Z', 'CL Oct26', 'Buy', 1, 85.00, { position: 'T1' }),
  fill('2026-08-24T13:00:00.000Z', 'CL Oct26', 'Buy', 1, 86.00, { position: 'T2' }),
];
const hbook = computeBook(HEDGE, () => SIZE, () => 'ticket');
const hrow = rowOf(hbook, 'CL Oct26', 88.00);
const hplan = flattenPlan([hrow], { at: 'mark' });
is('a ticketed position flattens one fill per ticket', hplan[0].fills.length, 2);
is('  carrying the tickets', hplan[0].fills.map((x) => x.position).join(','), 'T1,T2');
const hafter = computeBook([...HEDGE, ...planFills(hplan)], () => SIZE, () => 'ticket');
is('  and the position is gone', hafter.open.length, 0);
near('  with the P&L intact', hafter.closed.reduce((a, c) => a + c.pnl, 0), 5000);

// --- a price that is not a price does nothing --------------------------------------------------
is('a blank price is refused', flattenPlan([long], { at: 'price', price: '' }).length, 0);
is('text is refused', flattenPlan([long], { at: 'price', price: 'abc' }).length, 0);
is('zero is a real price and is allowed', flattenPlan([long], { at: 'price', price: 0 }).length, 1);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
