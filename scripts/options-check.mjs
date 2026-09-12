// Checks the option maths without a browser:  node scripts/options-check.mjs
// Every figure here is verified against something independent — published
// values of the normal distribution, put-call parity, and the price curve's
// own slope — rather than against numbers this code produced earlier.
import { black76, cnd, parseOptionSymbol, monthOf } from '../src/lib/options.js';
let fails = 0;
const ok = (name, got, want, tol) => {
  const pass = Math.abs(got - want) <= tol;
  if (!pass) fails++;
  console.log(pass ? 'PASS' : 'FAIL', name.padEnd(46), 'got', got.toPrecision(10), 'want', String(want));
};

// --- 1. the cumulative normal against values you can look up ---
ok('N(0) = 0.5', cnd(0), 0.5, 1e-14);
ok('N(1.96) = 0.9750021049', cnd(1.96), 0.9750021048517795, 1e-13);
ok('N(-1) = 0.1586552539', cnd(-1), 0.15865525393145705, 1e-13);
ok('N(-3) = 0.001349898', cnd(-3), 0.0013498980316301, 1e-13);
ok('N(8) = 1', cnd(8), 1, 1e-14);
ok('symmetry N(x)+N(-x) = 1', cnd(0.7) + cnd(-0.7), 1, 1e-14);

// --- 2. put-call parity: C - P must equal e^-rT (F - K), exactly ---
const P = { F: 78.4, K: 80, T: 0.0904, vol: 0.34, r: 0.045 };
const c = black76({ ...P, right: 'C' }), p = black76({ ...P, right: 'P' });
ok('parity C - P = e^-rT (F - K)', c.price - p.price, Math.exp(-P.r * P.T) * (P.F - P.K), 1e-12);
ok('parity delta_C - delta_P = e^-rT', c.delta - p.delta, Math.exp(-P.r * P.T), 1e-12);
ok('call and put share one gamma', c.gamma, p.gamma, 1e-14);

// --- 3. delta and gamma against the price curve itself ---
const h = 1e-4, px = (F, right) => black76({ ...P, F, right }).price;
ok('delta = dPrice/dF (call)', c.delta, (px(P.F + h, 'C') - px(P.F - h, 'C')) / (2 * h), 1e-7);
ok('delta = dPrice/dF (put)',  p.delta, (px(P.F + h, 'P') - px(P.F - h, 'P')) / (2 * h), 1e-7);
ok('gamma = d2Price/dF2', c.gamma, (px(P.F + h, 'C') - 2 * px(P.F, 'C') + px(P.F - h, 'C')) / (h * h), 1e-4);
const pv = (v) => black76({ ...P, vol: v, right: 'C' }).price;
ok('vega = dPrice/dVol per point', c.vega, (pv(P.vol + h) - pv(P.vol - h)) / (2 * h) / 100, 1e-7);

// --- 4. the limits a trader would sanity-check ---
ok('no vol, in the money -> intrinsic', black76({ F: 90, K: 80, T: 0.5, vol: 0, r: 0, right: 'C' }).price, 10, 1e-12);
ok('no vol, out of the money -> nil',   black76({ F: 70, K: 80, T: 0.5, vol: 0, r: 0, right: 'C' }).price, 0, 1e-12);
ok('at expiry -> intrinsic',            black76({ F: 70, K: 80, T: 0, vol: 0.4, r: 0, right: 'P' }).price, 10, 1e-12);
ok('deep out of the money -> nil',      black76({ F: 30, K: 80, T: 0.08, vol: 0.3, r: 0, right: 'C' }).price, 0, 1e-9);
ok('call delta between 0 and 1',        (c.delta > 0 && c.delta < 1) ? 1 : 0, 1, 0);
ok('put delta between -1 and 0',        (p.delta < 0 && p.delta > -1) ? 1 : 0, 1, 0);
ok('at the money call delta ~ 0.5',     black76({ F: 80, K: 80, T: .1, vol: .3, r: 0, right: 'C' }).delta, 0.5, 0.02);
ok('time decay is a loss',              black76({ ...P, right: 'C' }).theta < 0 ? 1 : 0, 1, 0);

// --- 5. one worked example, checked by hand below ---
const w = black76({ F: 100, K: 100, T: 1, vol: 0.2, r: 0, right: 'C' });
// At the money, r=0: d1 = vol/2 = 0.1, d2 = -0.1, price = 100(N(.1) - N(-.1))
const byHand = 100 * (cnd(0.1) - cnd(-0.1));
ok('worked example matches hand value', w.price, byHand, 1e-12);
console.log('     at-the-money 1y 20% vol on 100 =', w.price.toFixed(4), '(rule of thumb: 0.4 x vol x F =', (0.4 * 0.2 * 100).toFixed(2) + ')');

// --- 6. reading TT instrument names ---
const names = [
  ['NL5 W05Sep-26 C5500', 'NL5', 'W05Sep-26', 'Call', 5500],
  ['NL5 W05Sep-26 P5750', 'NL5', 'W05Sep-26', 'Put', 5750],
  ['LO Dec26 C7000',      'LO',  'Dec26',     'Call', 7000],
  ['CL Dec26 C 95.00',    'CL',  'Dec26',     'Call', 95],
];
for (const [s, u, e, r, k] of names) {
  const o = parseOptionSymbol(s);
  const good = o && o.underlying === u && o.expiry === e && o.right === r && o.strikeRaw === k;
  if (!good) fails++;
  console.log(good ? 'PASS' : 'FAIL', 'parse'.padEnd(46), s, '->', JSON.stringify(o));
}
for (const s of ['CL Oct26 - BZ Nov26 Inter-Product', 'Oct26 HO-CL Crack', 'CL Oct26-Dec26 Calendar', 'CL Nov26', 'BZ Oct26']) {
  const o = parseOptionSymbol(s);
  if (o) { fails++; console.log('FAIL', 'must NOT look like an option:', s, JSON.stringify(o)); }
  else console.log('PASS', 'not an option'.padEnd(46), s);
}
const m = monthOf('W05Sep-26');
console.log((m && m.month === 8 && m.year === 2026) ? 'PASS' : 'FAIL', 'month from W05Sep-26'.padEnd(46), JSON.stringify(m));
if (!(m && m.month === 8 && m.year === 2026)) fails++;

console.log(fails ? `\n${fails} FAILED` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
