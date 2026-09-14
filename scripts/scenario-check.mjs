import { runScenario, breakingMove } from '../src/lib/scenario.js';

/*
 * Sizing a trade on top of one you already hold.
 *
 * Worked from a real screen: Orient, CL Nov26 - BZ Nov26 Inter-Product, long 1 at -8.48, a 10%
 * move against, $2,500 margin per lot, contract size 1000, TNE $15,144. Every figure below is
 * arithmetic anybody can redo on paper:
 *
 *   move distance  = |-8.48| x 10%        = 0.848
 *   loss per lot   = 0.848 x 1000         = $848
 *   TNE after      = 15,144 - loss
 *   TNE/IM after   = TNE after / (2,500 x lots)
 */
const broker = { method: 'fixed', leverage: 100 };
const acc = { TNE: 15144, callR: 1, stopR: 0.5 };
const spec = { size: 1000, margin: 2500 };
const line = (plan, planLots) => [{ product: 'CL-BZ', spec, pos: 1, mark: -8.48, move: { v: 10, unit: '%' }, plan, planLots }];
const flat = (plan, planLots) => [{ product: 'CL-BZ', spec, pos: 0, mark: -8.48, move: { v: 10, unit: '%' }, plan, planLots }];

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got, want) => { fail++; console.log('FAIL', l, `-> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
const is = (l, got, want) => (got === want ? ok(l) : bad(l, got, want));
const near = (l, got, want) => (Math.abs(got - want) < 0.005 ? ok(l) : bad(l, got, want));

// --- the position as it stands ---
let r = runScenario(broker, acc, line(null, 0), 1);
near('holding 1: loss', r.loss, 848);
near('holding 1: margin', r.IM, 2500);
near('holding 1: TNE after', r.TNE, 14296);
near('holding 1: ratio after', r.ratio * 100, 571.84);
is('holding 1: nothing is planned', r.lines[0].planned, false);

// --- adding two, which is the whole point of this change ---
r = runScenario(broker, acc, line('long', 2), 1);
is('adding 2: stressed as 3 lots', r.lines[0].effPos, 3);
is('adding 2: reports what is being added', r.lines[0].adding, 2);
is('adding 2: marked as planned', r.lines[0].planned, true);
near('adding 2: loss trebles', r.loss, 2544);
near('adding 2: margin trebles', r.IM, 7500);
near('adding 2: TNE after', r.TNE, 12600);
near('adding 2: ratio after', r.ratio * 100, 168);
// Capacity is what is left ON TOP of the plan: 15,144 / (848 + 2,500) = 4.52 lots in total.
is('adding 2: one more lot still fits under 100%', r.lines[0].canBuy, 1);

// --- selling against the position ---
r = runScenario(broker, acc, line('short', 1), 1);
is('selling 1 of 1: leaves flat', r.lines[0].effPos, 0);
near('selling 1 of 1: no loss left to take', r.loss, 0);
near('selling 1 of 1: no margin left', r.IM, 0);

r = runScenario(broker, acc, line('short', 2), 1);
is('selling 2 of 1: flips to short 1', r.lines[0].effPos, -1);
/*
 * The direction that hurts flips with the position. Stressing a net short as though it were
 * still long would report a profit where there is a loss — the reason `dir` comes from the
 * combined position rather than the held one.
 */
near('selling 2 of 1: stressed price rises against the short', r.lines[0].stressed, -7.632);
near('selling 2 of 1: still loses on a 10% move', r.loss, 848);

// --- flat products keep behaving exactly as they did ---
r = runScenario(broker, acc, flat('long', 2), 1);
is('flat + plan long 2: stressed as 2 lots', r.lines[0].effPos, 2);
near('flat + plan long 2: loss', r.loss, 1696);
near('flat + plan long 2: ratio', r.ratio * 100, 268.96);

r = runScenario(broker, acc, flat(null, 0), 1);
is('flat, no plan: nothing stressed', r.lines[0].effPos, 0);
// `both` is internal; what a flat, unplanned product exposes is a stressed price for EACH side.
is('flat, no plan: a stressed price if long', typeof r.lines[0].stressedIfLong, 'number');
is('flat, no plan: a stressed price if short', typeof r.lines[0].stressedIfShort, 'number');
// Mark is -8.48, distance 0.848: a long is hurt by a fall, a short by a rise.
near('flat, no plan: stressed if long', r.lines[0].stressedIfLong, -9.328);
near('flat, no plan: stressed if short', r.lines[0].stressedIfShort, -7.632);
near('flat, no plan: no loss', r.loss, 0);

// --- lot arithmetic stays readable ---
r = runScenario(broker, acc, [{ product: 'X', spec, pos: 0.13, mark: 100, move: { v: 1, unit: '%' }, plan: 'long', planLots: 0.01 }], 1);
is('0.13 + 0.01 lots does not go floating-point ugly', r.lines[0].effPos, 0.14);

// --- the margin-call distance has to count the lots being considered ---
const bmHeld = breakingMove(broker, acc, line(null, 0), 1);
const bmAdding = breakingMove(broker, acc, line('long', 2), 1);
is('adding lots brings the margin call nearer', bmAdding < bmHeld, true);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
