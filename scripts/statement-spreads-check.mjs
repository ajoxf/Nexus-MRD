import { spreadsOf, spreadsFromLots } from '../src/lib/statementSpreads.js';

/*
 * Orient's legs paired back into spreads. The positions below are the trader's own, read off
 * the statements panel (Aug 21, 24, 25, 26); the expected spread prices are worked by hand.
 */
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
};
const MON = { '202610': 'Oct26', '202611': 'Nov26', '202612': 'Dec26' };
const p = (code, month, lots, avg, settle, upl, account = '1003050011') =>
  ({ account, code, month, label: `${code} ${MON[month]}`, kind: 'F', lots, avg, settle, upl });
const brief = (r) => ({
  spreads: r.spreads.map((s) => [s.label, s.lots, s.entry, s.settle, s.upl]),
  outrights: r.outrights.map((o) => [o.label, o.lots, o.upl]),
});
const total = (r) => +[...r.spreads, ...r.outrights].reduce((t, x) => t + x.upl, 0).toFixed(2);

// Aug 26: 3 Inter-Product and −4 Cracks.
const aug26 = [
  p('BZ', '202611', -3, 88.063333, 86.94, 3370), p('CL', '202611', 3, 81.226667, 80.85, -1130),
  p('CL', '202610', 4, 81.185, 82.23, 4180), p('HO', '202610', -4, 4.08915, 4.1453, -9433.2),
];
is('Aug 26: one Inter-Product and one Crack, priced as TT quotes them', brief(spreadsOf(aug26)), {
  spreads: [
    ['CL–BZ Nov26 Inter-Product', 3, -6.836666, -6.09, 2240],
    ['HO–CL Oct26 Crack', -4, 90.5593, 91.8726, -5253.2],
  ],
  outrights: [],
});
is('Aug 26: the spreads add back up to the statement', total(spreadsOf(aug26)), +(3370 - 1130 + 4180 - 9433.2).toFixed(2));

// Aug 21: CL Oct +7 against BZ −6 and HO −1 — one leg split two ways.
const aug21 = [p('BZ', '202610', -6, 91.291667, 94.39, -18590), p('CL', '202610', 7, 86.638571, 87.06, 2950), p('HO', '202610', -1, 4.41, 4.3848, 1058.4)];
is('Aug 21: 6 Inter-Product and 1 Crack out of CL +7', brief(spreadsOf(aug21)), {
  spreads: [
    ['CL–BZ Oct26 Inter-Product', 6, -4.653096, -7.33, -16061.43],
    ['HO–CL Oct26 Crack', -1, 98.581429, 97.1016, 1479.83],
  ],
  outrights: [],
});
is('Aug 21: nothing lost in the split', total(spreadsOf(aug21)), +(-18590 + 2950 + 1058.4).toFixed(2));

// Aug 24 and Aug 25.
const aug24 = [p('BZ', '202611', -6, 91.363333, 90.54, 4940), p('CL', '202611', 6, 83.743333, 83.3, -2660), p('CL', '202610', 1, 85.56, 85.01, -550), p('HO', '202610', -1, 4.31, 4.1734, 5737.2)];
is('Aug 24: 6 Inter-Product, −1 Crack', brief(spreadsOf(aug24)).spreads.map((s) => [s[0], s[1]]), [['CL–BZ Nov26 Inter-Product', 6], ['HO–CL Oct26 Crack', -1]]);
const aug25 = [p('BZ', '202611', -5, 90.676, 87.27, 17030), p('CL', '202611', 5, 83.192, 80.88, -11560)];
is('Aug 25: 5 Inter-Product', brief(spreadsOf(aug25)), { spreads: [['CL–BZ Nov26 Inter-Product', 5, -7.484, -6.39, 5470]], outrights: [] });

// Calendars, and the order the rules are tried in.
is('a calendar is near minus far, long when the near month is long',
   brief(spreadsOf([p('CL', '202610', 2, 85, 86, 2000), p('CL', '202611', -2, 84, 84.5, -1000)])),
   { spreads: [['CL Oct26–Nov26 Calendar', 2, 1, 1.5, 1000]], outrights: [] });
is('Inter-Product is tried before Calendar',
   brief(spreadsOf([p('CL', '202610', 2, 85, 86, 2000), p('BZ', '202610', -2, 88, 88, 0), p('CL', '202611', -2, 84, 84, 0)])).spreads.map((s) => s[0]),
   ['CL–BZ Oct26 Inter-Product']);
is('…and the leg it leaves is an outright',
   brief(spreadsOf([p('CL', '202610', 2, 85, 86, 2000), p('BZ', '202610', -2, 88, 88, 0), p('CL', '202611', -2, 84, 84, 0)])).outrights,
   [['CL Nov26', -2, 0]]);

// What must NOT pair.
is('two longs are two longs', brief(spreadsOf([p('CL', '202610', 2, 85, 86, 2000), p('BZ', '202610', 2, 88, 89, 2000)])).spreads, []);
is('different months are not an Inter-Product', brief(spreadsOf([p('CL', '202610', 2, 85, 86, 0), p('BZ', '202611', -2, 88, 88, 0)])).spreads, []);
is('legs in two accounts are not paired',
   brief(spreadsOf([p('CL', '202611', 3, 81, 80, 0, 'A'), p('BZ', '202611', -3, 88, 87, 0, 'B')])).spreads, []);
is('an unequal pair: the spread is the smaller side, the rest outright',
   brief(spreadsOf([p('CL', '202611', 5, 81, 80, -5000), p('BZ', '202611', -3, 88, 87, 3000)])),
   { spreads: [['CL–BZ Nov26 Inter-Product', 3, -7, -7, 0]], outrights: [['CL Nov26', 2, -2000]] });
is('no settlement price, no spread settlement', spreadsOf([p('CL', '202611', 1, 81, null, 0), p('BZ', '202611', -1, 88, 87, 0)]).spreads[0].settle, null);
is('no positions, nothing to show', spreadsOf([]), { spreads: [], outrights: [] });

// ---------- Paired by ExchangeOrderID ----------
/*
 * Aug 19 as Orient's Open Position file lists it, lot by lot: prices, sides and P/L are the
 * trader's; order ids and the account are made up. Each spread trade's two legs share one
 * exchange order id. Hand-worked: 8 Inter-Product at (CL − BZ) of each pair, 2 Cracks at
 * (HO × 42 − CL) of each pair.
 */
const L = (order, code, side, price, upl, settle) =>
  ({ account: '2001000011', orderId: order, code, month: '202610', kind: 'F', strike: null, side, qty: 1, price, settle, upl, expiry: '' });
const BZ = (o, px, upl) => L(o, 'BZ', 'S', px, upl, 91.62), CL = (o, px, upl) => L(o, 'CL', 'B', px, upl, 84.39), HO = (o, px, upl) => L(o, 'HO', 'S', px, upl, 4.3227);
const AUG19 = [
  BZ('9000000000001', 90.1, -1520), CL('9000000000001', 82.9, 1490),
  BZ('9000000000002', 91.37, -250), CL('9000000000002', 84.33, 60),
  BZ('9000000000003', 91.16, -460), CL('9000000000003', 84.16, 230),
  BZ('9000000000004', 91.16, -460), CL('9000000000004', 84.16, 230),
  BZ('9000000000005', 91.16, -460), CL('9000000000005', 84.16, 230),
  BZ('9000000000006', 91.17, -450), CL('9000000000006', 84.17, 220),
  BZ('9000000000007', 91.16, -460), CL('9000000000007', 84.16, 230),
  BZ('9000000000008', 91.94, 320), CL('9000000000008', 84.83, -440),
  HO('9000000000009', 4.31, -533.4), CL('9000000000009', 84.27, 120),
  HO('9000000000010', 4.31, -533.4), CL('9000000000010', 84.23, 160),
];
const show = (r) => ({ spreads: r.spreads.map((x) => [x.label, x.lots, x.entry, x.settle, x.upl, x.by]), outrights: r.outrights.map((o) => [o.label, o.lots, o.upl]) });
is('Aug 19 by order id: 8 Inter-Product and 2 Cracks, each at its own traded price', show(spreadsFromLots(AUG19)), {
  spreads: [
    ['CL–BZ Oct26 Inter-Product', 8, -7.04375, -7.23, -1490, 'order'],
    ['HO–CL Oct26 Crack', -2, 96.77, 97.1634, -786.8, 'order'],
  ],
  outrights: [],
});
is('Aug 19 by order id: adds back to the statement', +spreadsFromLots(AUG19).spreads.reduce((t, x) => t + x.upl, 0).toFixed(2), -2276.8);
is('…and differs from the rules, which can only use each leg\'s average (−7.0155)',
   spreadsOf([p('BZ', '202610', -8, 91.1525, 91.62, -3740), p('CL', '202610', 10, 84.137, 84.39, 2530), p('HO', '202610', -2, 4.31, 4.3227, -1066.8)]).spreads[0].entry, -7.0155);

// Fallbacks.
const noIds = AUG19.map((l) => ({ ...l, orderId: '' }));
is('no order ids: the rules pair them, and say so', spreadsFromLots(noIds).spreads.map((x) => [x.label, x.lots, x.by]),
   [['CL–BZ Oct26 Inter-Product', 8, 'rule'], ['HO–CL Oct26 Crack', -2, 'rule']]);
const excel = AUG19.map((l) => ({ ...l, orderId: '8.07E+12' }));
is('ids Excel has rounded (8.07E+12) are not trusted — they would all look like one order',
   spreadsFromLots(excel).spreads.map((x) => x.by), ['rule', 'rule']);
const mixed = [...AUG19.slice(0, 16), ...AUG19.slice(16).map((l) => ({ ...l, orderId: '' }))];
is('some with ids, some without: each paired the best way it can',
   spreadsFromLots(mixed).spreads.map((x) => [x.label, x.lots, x.by]),
   [['CL–BZ Oct26 Inter-Product', 8, 'order'], ['HO–CL Oct26 Crack', -2, 'rule']]);
const lone = [BZ('9000000000001', 90.1, -1520), CL('9000000000002', 84.33, 60)];
is('one leg per order (the rest of each closed): left to the rules', spreadsFromLots(lone).spreads.map((x) => [x.lots, x.by]), [[1, 'rule']]);
const sameWay = [L('9000000000011', 'CL', 'B', 84, 0, 84), L('9000000000011', 'BZ', 'B', 91, 0, 91)];
is('an order with both legs the same way is not a spread', [spreadsFromLots(sameWay).spreads, spreadsFromLots(sameWay).outrights.map((o) => [o.label, o.lots]).sort()], [[], [['BZ Oct26', 1], ['CL Oct26', 1]]]);
const both = [BZ('9000000000001', 90.1, 0), CL('9000000000001', 82.9, 0), L('9000000000012', 'BZ', 'B', 91, 0, 91), L('9000000000012', 'CL', 'S', 84, 0, 84)];
is('a long and a short of one spread stay two lines, not netted away', spreadsFromLots(both).spreads.map((x) => [x.lots, x.entry]), [[1, -7.2], [-1, -7]]);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
