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


/*
 * ---------------------------------------------------------------------------
 * NAMING THE PRICE THE NEW LOTS GO ON AT
 * ---------------------------------------------------------------------------
 * From the desk: long 2 CL-BZ entered at -8.35, marked -8.385, wanting 2 more at -8.65 on a
 * 10% move. Orient, $2,500 a lot, size 1000.
 *
 * Worked on paper:
 *   getting there   = 2 lots x 1000 x (-8.65 - -8.385)   = -$530   (the mark, NOT the entry:
 *                                                                   entry->mark is already in TNE)
 *   move distance   = |-8.65| x 10%                      = 0.865
 *   scenario loss   = 4 lots x 1000 x 0.865              = $3,460
 *   average after   = (2 x -8.35 + 2 x -8.65) / 4        = -8.50
 *   margin          = 4 x 2,500                          = $10,000
 *
 * Priced at the mark instead, the same plan reads $3,354 and no cost of getting there at
 * all — $636 cheaper than it is.
 */
const scaleIn = (planPrice) => [{ product: 'CL-BZ', spec, pos: 2, avg: -8.35, mark: -8.385, move: { v: 10, unit: '%' }, plan: 'long', planLots: 2, planPrice }];
const deskAcc = { TNE: 40000, callR: 1, stopR: 0.5 };

const atMark = runScenario(broker, deskAcc, scaleIn(''), 2);
near('priced at the mark, the plan loses $3,354', atMark.loss, 3354);
is('and nothing is charged for getting there', atMark.drift, 0);

const atLimit = runScenario(broker, deskAcc, scaleIn(-8.65), 2);
const L0 = atLimit.lines[0];
near('the limit re-prices the line to the fill', L0.ref, -8.65);
near('getting there costs $530 on the lots already held', L0.drift, -530);
near('measured from the mark, not the entry', L0.drift, 2 * 1000 * (-8.65 - -8.385));
near('the scenario is then stressed from -8.65', atLimit.loss, 3460);
near('stressed price follows the fill', L0.stressed, -9.515);
near('the average across all 4 lots', L0.avgAfter, -8.5);
near('margin is unchanged on a fixed-margin broker', atLimit.IM, 10000);

// The account is charged the journey BEFORE the stress, because by then it has happened.
near('equity starts from what the journey leaves', atLimit.startTNE, 40000 - 530);
near('and the scenario comes off that', atLimit.TNE, 40000 - 530 - 3460);
near('so the plan costs $3,990 from today, not $3,354', deskAcc.TNE - atLimit.TNE, 3990);
near('which is $636 more than pricing it at the mark', (deskAcc.TNE - atLimit.TNE) - (deskAcc.TNE - atMark.TNE), 636);
/*
 * Capacity is worked out from what the journey leaves, so it tightens. On a whole-lot
 * futures account the published Can buy is floored to a lot and both round to 2 here — so
 * the claim is checked on the unrounded figure it is floored from, which is where the
 * difference actually lives.
 */
is('capacity is worked out after the journey too', atLimit.lines[0].maxLong < atMark.lines[0].maxLong, true);
is('and never reports MORE room after paying to get there', atLimit.lines[0].canBuy <= atMark.lines[0].canBuy, true);

/*
 * A limit the market has to come UP to pays you on the way: long 2 at -8.385 adding at -8.20
 * means the position gained 0.185 before the second tranche filled. Charging that as a cost
 * would be as wrong as ignoring the loss in the case above.
 */
const up = runScenario(broker, deskAcc, scaleIn(-8.2), 2);
near('a favourable journey is credited, not charged', up.lines[0].drift, +370);
near('and the account starts above where it is today', up.startTNE, 40000 + 370);

// --- a fill price that is not one ---
is('an empty fill price falls back to the mark', runScenario(broker, deskAcc, scaleIn(''), 2).lines[0].fill, null);
is('so does a blank one', runScenario(broker, deskAcc, scaleIn(null), 2).lines[0].fill, null);
is('and rubbish is ignored rather than stressed', runScenario(broker, deskAcc, scaleIn('abc'), 2).lines[0].fill, null);
near('an ignored fill leaves the loss at the mark figure', runScenario(broker, deskAcc, scaleIn('abc'), 2).loss, 3354);
// Zero is a real price on a spread, so it must NOT be treated as "unset".
near('zero is a price, not a blank', runScenario(broker, deskAcc, scaleIn(0), 2).lines[0].ref, 0);

// --- a fill price with no lots behind it decides nothing ---
const noLots = [{ product: 'CL-BZ', spec, pos: 2, avg: -8.35, mark: -8.385, move: { v: 10, unit: '%' }, plan: 'long', planLots: 0, planPrice: -8.65 }];
is('a fill price with no lots planned is ignored', runScenario(broker, deskAcc, noLots, 2).lines[0].fill, null);
near('and the account is unchanged', runScenario(broker, deskAcc, noLots, 2).loss, 2 * 1000 * 0.8385);

// --- opening from flat: there is no position to travel ---
const fresh = [{ product: 'CL-BZ', spec, pos: 0, avg: 0, mark: -8.385, move: { v: 10, unit: '%' }, plan: 'long', planLots: 2, planPrice: -8.65 }];
is('opening from flat costs nothing to get there', runScenario(broker, deskAcc, fresh, 2).drift, 0);
near('but is still stressed from the price named', runScenario(broker, deskAcc, fresh, 2).loss, 2 * 1000 * 0.865);
near('and entered there', runScenario(broker, deskAcc, fresh, 2).lines[0].avgAfter, -8.65);

// --- a leverage account recalculates margin off the fill ---
const lev = { method: 'leverage', leverage: 100 };
const levSpec = { size: 1000, lev: 100 };
const levLine = (planPrice) => [{ product: 'USOIL', spec: levSpec, pos: 0.1, avg: 90, mark: 93, move: { v: 10, unit: '%' }, plan: 'long', planLots: 0.1, planPrice }];
const levAt = runScenario(lev, { TNE: 5000, callR: 1, stopR: 0.5 }, levLine(100), 2);
near('a leverage account travels to the fill as well', levAt.lines[0].drift, 0.1 * 1000 * (100 - 93));
// Margin at the stressed price: 0.2 lots x 1000 x (100 - 10) / 100
near('and takes margin at the stressed price from that fill', levAt.IM, 0.2 * 1000 * 90 / 100);

// --- the breaking move accounts for it too ---
const bmMark = breakingMove(broker, deskAcc, scaleIn(''), 1);
const bmFill = breakingMove(broker, deskAcc, scaleIn(-8.65), 1);
is('a plan that costs money to reach brings the margin call nearer', bmFill < bmMark, true);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
