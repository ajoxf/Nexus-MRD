import { readFileSync } from 'node:fs';
import { tableFromRows, mappingFor, rowsToFills } from '../src/lib/csv.js';
import { resolveLeg, matchLegs, spreadValue, stressSpread, suggestSpreads, legKey } from '../src/lib/spreads.js';

/*
 * The customer's own WTI/Brent spread, legged across two MT5 accounts.
 *
 * Every figure the platform showed him is reproduced here first, so the fix can be checked
 * against what he actually saw rather than against itself. From his Scenarios screen, on a
 * 10% move: MT5-100030 long 0.12 USOILX6 at 93.44638 reads -$1,121; MT5-100031 short 0.12
 * BR.X26 at 101.87408 reads -$1,222. Both are correct for margin, and adding them together
 * as the economic risk of the trade is not.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got, want) => { fail++; console.log('FAIL', l, `-> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
const is = (l, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(l) : bad(l, got, want));
const near = (l, got, want, tol = 0.01) => (Math.abs(got - want) <= tol ? ok(l) : bad(l, got, want));

const SIZE = 1000, LOTS = 0.12, WTI = 93.44638, BRENT = 101.87408;
const MOVE = { v: 10, unit: '%' };

const wti = resolveLeg({ broker: 'MT5-100030', product: 'USOILX6.kp' }, { pos: +LOTS, size: SIZE, mark: WTI });
const brent = resolveLeg({ broker: 'MT5-100031', product: 'BR.X26.kp' }, { pos: -LOTS, size: SIZE, mark: BRENT });
const LEGS = [wti, brent];

// --- first, reproduce what he was shown ---
console.log('\n-- what the platform showed him --');
const noWiden = stressSpread(LEGS, MOVE, { v: 0, unit: 'pts' });
near('the WTI leg alone loses $1,121', LOTS * SIZE * WTI * 0.10, 1121.36);
near('the Brent leg alone loses $1,222', LOTS * SIZE * BRENT * 0.10, 1222.49);
near('added together, the old figure', noWiden.outright, 2343.85);

// --- and what it costs when the two legs are one trade ---
console.log('\n-- stressed as the spread it is --');
// Both legs move 10% the same way. Long WTI loses 1121.36, short Brent gains 1222.49 on a
// fall; on a rise the signs swap. The worse of the two is what is reported.
near('a correlated move nets to about $101', noWiden.correlatedLoss, 101.13);
is('with no widening, that is the whole loss', noWiden.loss, noWiden.correlatedLoss);
is('both directions are tried, the worse taken', noWiden.correlated <= 0, true);

// The spread itself: he is long the difference, currently -$8.43 (WTI under Brent).
near('the spread is priced where the legs put it', spreadValue(LEGS), -8.43);
// Size: 0.12 lots of 1000 at a ratio of 1 is 120 barrels, so a $2 move costs $240.
is('the matched size is 120', matchLegs(LEGS).matched, 120);
const widened = stressSpread(LEGS, MOVE, { v: 2, unit: 'pts' });
near('a $2.00 widening costs $240', widened.widening, 240);
near('the total is the correlated residue plus the widening', widened.loss, 101.13 + 240);
// Still far below what two independent positions implied.
is('and it is well under the old figure', widened.loss < noWiden.outright, true);

// A percentage widening is a percentage OF THE SPREAD, not of a leg price.
const pct = stressSpread(LEGS, MOVE, { v: 25, unit: '%' });
near('25% of a -$8.43 spread is $2.11 a barrel', pct.widening, 120 * 8.43 * 0.25, 0.5);

// --- half-legged: part spread, part naked ---
console.log('\n-- a spread that is only half on --');
const halfBrent = resolveLeg({ broker: 'MT5-100031', product: 'BR.X26.kp' }, { pos: -0.06, size: SIZE, mark: BRENT });
const half = [wti, halfBrent];
is('only the thinner leg is matched', matchLegs(half).matched, 60);
is('the rest is left as an outright position', matchLegs(half).residual.length, 1);
near('and that residual is 0.06 lots long WTI', matchLegs(half).residual[0].notional, 60);
const halfRes = stressSpread(half, MOVE, { v: 2, unit: 'pts' });
/*
 * Worked by hand. On a 10% fall the long 0.12 WTI loses 0.12*1000*9.344638 = $1,121.36 and
 * the short 0.06 Brent gains 0.06*1000*10.187408 = $611.24, netting a $510.11 loss; on a
 * rise the signs swap to the same size, so $510.11 is the worse direction either way.
 *
 * Read as the two halves: the naked 0.06 WTI loses its full $560.68, and the hedged 0.06
 * against 0.06 nets a $50.57 GAIN (the legs are at different price levels), leaving
 * 560.68 - 50.57 = $510.11. The hedged half offsets the naked one; it does not add to it.
 */
near('the naked half carries its full outright loss', halfRes.correlatedLoss, 560.68 - 50.57, 1);
near('and only the matched 60 pays the widening', halfRes.widening, 120);

// --- things that are not spreads ---
console.log('\n-- refusals --');
const twoLongs = [wti, resolveLeg({ broker: 'MT5-100031', product: 'BR.X26.kp' }, { pos: +LOTS, size: SIZE, mark: BRENT })];
is('two longs are not a spread', matchLegs(twoLongs).matched, 0);
near('so both are stressed outright, losing together', stressSpread(twoLongs, MOVE, { v: 2, unit: 'pts' }).correlatedLoss, 2343.85);
const flat = [resolveLeg({ broker: 'a', product: 'X' }, { pos: 0, size: SIZE, mark: 50 }), brent];
is('a leg that is closed leaves nothing matched', matchLegs(flat).matched, 0);

// --- a leg with no price is named, never guessed ---
const noPrice = [wti, resolveLeg({ broker: 'MT5-100031', product: 'BR.X26.kp' }, { pos: -LOTS, size: SIZE, mark: null })];
is('an unpriced leg makes the spread value unknown', spreadValue(noPrice), null);
is('and is reported by name', stressSpread(noPrice, MOVE, { v: 2, unit: 'pts' }).unpriced, ['BR.X26.kp']);
is('the answer is flagged incomplete', stressSpread(noPrice, MOVE, { v: 2, unit: 'pts' }).incomplete, true);
is('a percentage widening invents nothing from a missing price', stressSpread(noPrice, MOVE, { v: 25, unit: '%' }).widening, 0);

// --- ratios ---
console.log('\n-- hedge ratios --');
// Two of one against one of the other: the matched size is set by whichever runs out.
const twoToOne = [
  resolveLeg({ broker: 'a', product: 'X', ratio: 2 }, { pos: +0.20, size: SIZE, mark: 100 }),
  resolveLeg({ broker: 'b', product: 'Y', ratio: 1 }, { pos: -0.10, size: SIZE, mark: 100 }),
];
is('a 2:1 spread matches on the ratio, not the lots', matchLegs(twoToOne).matched, 100);
is('and nothing is left over', matchLegs(twoToOne).residual.length, 0);

// --- suggestions, from the customer's real fills ---
console.log('\n-- suggesting the pair from his own fills --');
const sheets = JSON.parse(readFileSync(new URL('./fixtures/mt5-hedge-report.json', import.meta.url), 'utf8'));
const fills = [];
for (const [acct, rows] of Object.entries(sheets)) {
  const t = tableFromRows(rows);
  fills.push(...rowsToFills(t.rows, mappingFor(t.headers, undefined, t.mt5).map, { dateFormat: 'auto', defaultBroker: acct, resolveBroker: () => null, spreadMode: 'spread' }).fills);
}
const found = suggestSpreads(fills);
is('his WTI/Brent pair is suggested', found.length > 0, true);
if (found.length) {
  is('across the two accounts', found[0].crossAccount, true);
  is('naming both legs', found[0].legs.map(legKey).sort().join(' / '), 'MT-100030|USOILX6.kp / MT5-100031|BR.X26.kp');
  is('and it is not a one-off', found[0].pairs >= 4, true);
}
// One coincidence must not become a suggestion.
is('a single coincidental pair is not suggested', suggestSpreads(fills.slice(0, 2), { minPairs: 2 }).length, 0);
is('no fills, no suggestions', suggestSpreads([]).length, 0);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
