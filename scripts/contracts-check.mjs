import { defaultSize, sizeOf, DEFAULT_SIZE } from '../src/lib/contracts.js';
import { computeBook } from '../src/lib/positions.js';

/*
 * Contract size is the multiplier between a price move and money, so this file is really about
 * one question: does a lot of heating oil report 42,000 gallons of P&L, and does nothing else
 * accidentally become heating oil?
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got) => { fail++; console.log('FAIL', l, '->', JSON.stringify(got)); };
const is = (l, got, want) => (String(got) === String(want) ? ok(l) : bad(`${l} (wanted ${want})`, got));

// --- heating oil is 42,000 US gallons, however the month is written ---------------------------
for (const p of ['HO Oct26', 'HO Nov26', 'HO-Z26', 'HOZ26', 'HO.Oct26', 'ho oct26', 'HO'])
  is(`${p} is heating oil`, defaultSize(p), 42000);

// --- and nothing else is -----------------------------------------------------------------------
for (const p of ['HOUSE', 'HOLD', 'HOG Dec26', 'CL Oct26', 'BZ Nov26', 'CL Jan27', 'XAUUSD', 'USOILX6.kp', ''])
  is(`${p || '(blank)'} is not`, defaultSize(p), DEFAULT_SIZE);
is('null is not', defaultSize(null), DEFAULT_SIZE);
is('undefined is not', defaultSize(undefined), DEFAULT_SIZE);

/*
 * The crack is the trap. "Oct26 HO-CL Crack" is HO x 42 minus CL, quoted in dollars a barrel:
 * the 42 is already inside the price, so the contract is 1,000 and sizing it at 42,000 would
 * count the conversion twice. Same for every other spread built on barrels.
 */
for (const p of ['Oct26 HO-CL Crack', 'CL Nov26 - BZ Nov26 Inter-Product', 'CL Oct26 - BZ Oct26 Inter-Product',
                 'CL Nov26-Jan27 Calendar', 'CL Oct26-Dec26 Calendar', 'HO Oct26 - HO Nov26 Calendar'])
  is(`${p} stays at 1,000`, defaultSize(p), DEFAULT_SIZE);

// --- what the trader typed always wins ---------------------------------------------------------
is('a stated size beats the default', sizeOf({ size: 1000 }, 'HO Oct26'), 1000);
is('a stated size beats the default the other way', sizeOf({ size: 42000 }, 'CL Oct26'), 42000);
is('a blank size falls through', sizeOf({ size: '' }, 'HO Oct26'), 42000);
is('a missing spec falls through', sizeOf(undefined, 'HO Oct26'), 42000);
is('an empty spec falls through', sizeOf({}, 'HO Oct26'), 42000);
is('a zero size falls through rather than zeroing the P&L', sizeOf({ size: 0 }, 'HO Oct26'), 42000);
is('nonsense falls through', sizeOf({ size: 'abc' }, 'HO Oct26'), 42000);
is('a stated size on an unknown product still wins', sizeOf({ size: 100 }, 'XYZ'), 100);

/*
 * End to end: a cent on heating oil is $420 a lot, and the engine has to say so with nobody
 * having filled in a product list.
 */
const f = (ts, product, side, qty, price) =>
  ({ ts, broker: 'b1', product, side, qty, price, fee: 0, ref: `${ts}|${product}|${side}|${price}`, source: 'csv', is_leg: false });
const book = computeBook([
  f('2026-09-17T09:00:00.000Z', 'HO Oct26', 'Buy', 1, 5.0000),
  f('2026-09-17T10:00:00.000Z', 'HO Oct26', 'Sell', 1, 5.0100),
  f('2026-09-17T09:00:00.000Z', 'CL Oct26', 'Buy', 1, 100.00),
  f('2026-09-17T10:00:00.000Z', 'CL Oct26', 'Sell', 1, 101.00),
], {}, () => 'fifo');
const pnl = (p) => book.realized.filter((r) => r.product === p).reduce((a, r) => a + r.pnl, 0);
is('a cent on heating oil is $420', pnl('HO Oct26').toFixed(2), '420.00');
is('a dollar on crude is $1,000', pnl('CL Oct26').toFixed(2), '1000.00');

// A product list that names a size overrides it, product by product.
const book2 = computeBook([
  f('2026-09-17T09:00:00.000Z', 'HO Oct26', 'Buy', 1, 5.0000),
  f('2026-09-17T10:00:00.000Z', 'HO Oct26', 'Sell', 1, 5.0100),
], { 'HO Oct26': { size: 1000 } }, () => 'fifo');
is('a stated 1,000 on heating oil is honoured', book2.realized.reduce((a, r) => a + r.pnl, 0).toFixed(2), '10.00');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
