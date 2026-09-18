import { rowsToFills, legBelongsTo, isSpreadSymbol, classifyFills } from '../src/lib/csv.js';
import { computeBook } from '../src/lib/positions.js';

/*
 * A spread trade arrives from TT three times over: the spread itself, and its two legs, all
 * under one order id at one instant. The spread IS the trade; counting its legs as well
 * books the same risk and the same money twice.
 *
 * Leg detection used to require the Ref column to be mapped. With it missing — a saved
 * layout from before it existed, or an export without one — every leg came in as an
 * outright product and was counted. On the sample file that is six products where there are
 * two, three open positions where there is one, and exactly DOUBLE the realized P&L.
 *
 * The fallback groups by account and exact millisecond, and will only call something a leg
 * when its root symbol is named in the spread. That strictness is the point: wrongly
 * calling a real trade a leg HIDES it, which is the same error pointing the other way.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got, want) => { fail++; console.log('FAIL', l, `-> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
const is = (l, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(l) : bad(l, got, want));
const near = (l, got, want) => (Math.abs(got - want) < 0.005 ? ok(l) : bad(l, got, want));

const MAP = { date: 'd', time: 't', product: 'p', side: 's', qty: 'q', price: 'x', ref: 'r' };
const NOREF = { date: 'd', time: 't', product: 'p', side: 's', qty: 'x' && 'q', price: 'x' };
const row = (d, t, p, s, q, x, r) => ({ d, t, p, s, q, x, r });
const parse = (rows, map) => rowsToFills(rows, map, { dateFormat: 'auto', defaultBroker: 'o', resolveBroker: () => null, spreadMode: 'spread' });
const counted = (res) => [...new Set(res.fills.filter((f) => !f.is_leg).map((f) => f.product))].sort();

// One spread order: the spread plus its two legs, same instant.
const ORDER = [
  row('10Sep26', '09:15:02.114', 'CL Nov26', 'S', 1, 97.78, 'A1'),
  row('10Sep26', '09:15:02.114', 'BZ Nov26', 'B', 1, 107.08, 'A1'),
  row('10Sep26', '09:15:02.114', 'CL Nov26 - BZ Nov26 Inter-Product', 'S', 1, -9.30, 'A1'),
];

console.log('-- with the order id, as it always worked --');
is('only the spread counts', counted(parse(ORDER, MAP)), ['CL Nov26 - BZ Nov26 Inter-Product']);
is('and both legs are set aside', parse(ORDER, MAP).legsSkipped, 2);

console.log('\n-- without it, which used to double everything --');
is('the same one product counts', counted(parse(ORDER, NOREF)), ['CL Nov26 - BZ Nov26 Inter-Product']);
is('both legs still set aside', parse(ORDER, NOREF).legsSkipped, 2);
is('and it says it matched them on time', parse(ORDER, NOREF).legsByTime, 2);

console.log('\n-- the money, which is the point --');
const ROUND = [...ORDER,
  row('11Sep26', '07:29:55.955', 'CL Nov26', 'B', 1, 97.50, 'A2'),
  row('11Sep26', '07:29:55.955', 'BZ Nov26', 'S', 1, 106.90, 'A2'),
  row('11Sep26', '07:29:55.955', 'CL Nov26 - BZ Nov26 Inter-Product', 'B', 1, -9.40, 'A2'),
];
const money = (map) => {
  const { fills } = parse(ROUND, map);
  return computeBook(fills, () => 1000, () => 'fifo').realized.reduce((a, r) => a + r.pnl, 0);
};
// Sold the spread at -9.30, bought it back at -9.40: +0.10 x 1000 = $100.
near('with the order id', money(MAP), 100);
near('without it, the same $100 and not $200', money(NOREF), 100);

console.log('\n-- a crack, where the leg is not named the way the spread is --');
const CRACK = [
  row('10Sep26', '14:40:51.380', 'Oct26 HO-CL Crack', 'B', 1, 110.00),
  row('10Sep26', '14:40:51.380', 'CL Oct26', 'S', 1, 98.80),
  row('10Sep26', '14:40:51.380', 'HO Oct26', 'B', 1, 4.9714),
];
is('both legs are recognised by their root symbol', counted(parse(CRACK, NOREF)), ['Oct26 HO-CL Crack']);

console.log('\n-- REFUSALS: a real trade must never be hidden --');
// Same millisecond, but nothing to do with the spread.
const STRANGER = [
  row('10Sep26', '09:15:02.114', 'CL Nov26 - BZ Nov26 Inter-Product', 'S', 1, -9.30),
  row('10Sep26', '09:15:02.114', 'GC Dec26', 'B', 1, 2400),
];
is('an unrelated symbol at the same instant is kept', counted(parse(STRANGER, NOREF)),
   ['CL Nov26 - BZ Nov26 Inter-Product', 'GC Dec26']);
// A second apart is a different trade.
const LATER = [
  row('10Sep26', '09:15:02.114', 'CL Nov26 - BZ Nov26 Inter-Product', 'S', 1, -9.30),
  row('10Sep26', '09:15:03.114', 'CL Nov26', 'S', 1, 97.78),
];
is('a leg one second later is not claimed', counted(parse(LATER, NOREF)),
   ['CL Nov26', 'CL Nov26 - BZ Nov26 Inter-Product']);
// Two outrights with no spread among them.
const OUTRIGHTS = [
  row('10Sep26', '09:15:02.114', 'CL Nov26', 'S', 1, 97.78),
  row('10Sep26', '09:15:02.114', 'BZ Nov26', 'B', 1, 107.08),
];
is('two outrights at one instant are both kept', counted(parse(OUTRIGHTS, NOREF)), ['BZ Nov26', 'CL Nov26']);
// A different account at the same instant.
const OTHERACC = [
  { ...row('10Sep26', '09:15:02.114', 'CL Nov26 - BZ Nov26 Inter-Product', 'S', 1, -9.30), acct: 'A' },
  { ...row('10Sep26', '09:15:02.114', 'CL Nov26', 'S', 1, 97.78), acct: 'B' },
];
is('a leg in another account is not claimed', counted(rowsToFills(OTHERACC, { ...NOREF, broker: 'acct' },
   { dateFormat: 'auto', defaultBroker: 'o', resolveBroker: () => null, spreadMode: 'spread' })),
   ['CL Nov26', 'CL Nov26 - BZ Nov26 Inter-Product']);

console.log('\n-- the naming test on its own --');
is('CL Oct26 belongs to the CL/BZ inter-product', legBelongsTo('CL Oct26', 'CL Oct26 - BZ Oct26 Inter-Product'), true);
is('BZ Oct26 too', legBelongsTo('BZ Oct26', 'CL Oct26 - BZ Oct26 Inter-Product'), true);
is('CL Oct26 belongs to the HO-CL crack', legBelongsTo('CL Oct26', 'Oct26 HO-CL Crack'), true);
is('HO Oct26 too', legBelongsTo('HO Oct26', 'Oct26 HO-CL Crack'), true);
is('GC Dec26 belongs to neither', legBelongsTo('GC Dec26', 'Oct26 HO-CL Crack'), false);
is('NG Dec26 is not a CL/BZ leg', legBelongsTo('NG Dec26', 'CL Oct26 - BZ Oct26 Inter-Product'), false);
is('an empty name claims nothing', legBelongsTo('', 'CL - BZ'), false);
is('and neither does an undefined one', legBelongsTo(undefined, 'CL - BZ'), false);

console.log('\n-- the spread names themselves --');
['CL Nov26 - BZ Nov26 Inter-Product', 'Oct26 HO-CL Crack', 'CL Oct26-Dec26 Calendar'].forEach((p) =>
  is(`${p} reads as a spread`, isSpreadSymbol(p), true));
['CL Oct26', 'BZ Oct26', 'HO Oct26', 'GC Dec26'].forEach((p) =>
  is(`${p} reads as an outright`, isSpreadSymbol(p), false));


console.log('\n-- PARTIAL FILLS: an order that fills in pieces --');
/*
 * An order for several lots often fills as several one-lot rows, at the same instant and
 * the same price, under one order id. Those rows are identical on id, symbol, side, price
 * and time — and every one after the first was called a file duplicate and silently
 * dropped, because only rows marked "new" are imported. The lots never arrived. Somebody
 * who uploaded everything would find part of a day missing, with nothing to say why.
 */
const PARTIAL = [
  row('17Aug26', '09:15:02.114', 'CL Nov26 - BZ Nov26 Inter-Product', 'B', 1, -8.20, 'ORD1'),
  row('17Aug26', '09:15:02.114', 'CL Nov26 - BZ Nov26 Inter-Product', 'B', 1, -8.20, 'ORD1'),
  row('17Aug26', '09:15:02.114', 'CL Nov26 - BZ Nov26 Inter-Product', 'B', 1, -8.20, 'ORD1'),
];
const pf3 = parse(PARTIAL, MAP).fills;
is('all three pieces survive the read', pf3.length, 3);
is('each with its own reference', new Set(pf3.map((f) => f.ref)).size, 3);
is('the first keeps the plain one it always had', pf3[0].ref.includes('#'), false);
is('so a fill already stored still matches itself', pf3.slice(1).every((f) => f.ref.includes('#')), true);
const fresh = classifyFills(pf3, []);
is('a fresh import takes all three', fresh.counts, { new: 3, stored: 0, fileDup: 0, manual: 0 });
const again = classifyFills(pf3, pf3);
is('re-importing recognises all three', again.counts, { new: 0, stored: 3, fileDup: 0, manual: 0 });
is('and duplicates none of them', again.rows.filter((r) => r.status === 'new').length, 0);
// The lots must reach the book, which is the whole point.
is('three lots land in the position, not one',
   computeBook(pf3, () => 1000, () => 'fifo').open[0].lots, 3);

// A genuine re-read of the same file after a partial import still lines up.
const half = classifyFills(pf3, [pf3[0]]);
is('with only the first stored, the other two are new', half.counts, { new: 2, stored: 1, fileDup: 0, manual: 0 });

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
