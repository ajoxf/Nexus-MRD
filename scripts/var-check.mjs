import { historicalVar, lossAt, addSettles } from '../src/lib/var.js';

/*
 * Historical VaR on spreads, with numbers worked by hand. Made-up settlements.
 */
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
};

// ---------- the tail ----------
const hundred = [...Array(100)].map((_, i) => i - 50);   // -50 … 49
is('99%: the worst day of 100', lossAt(hundred, 0.01), 50);
is('95%: the 5th worst day of 100', lossAt(hundred, 0.05), 46);
is('a tail that is a gain is a loss of 0', lossAt([5, 6, 7], 0.05), 0);
is('nothing to read: no number', lossAt([], 0.01), null);

// ---------- spreads move less than their legs ----------
// CL and BZ Nov26 over five days: both fall $2 on day 3, so the spread barely moves.
const series = (o) => new Map(Object.entries(o));
const H = new Map([
  ['CL|202611', series({ '2026-09-01': 80, '2026-09-02': 80.5, '2026-09-03': 78.5, '2026-09-04': 78.6, '2026-09-07': 79 })],
  ['BZ|202611', series({ '2026-09-01': 88, '2026-09-02': 88.3, '2026-09-03': 86.4, '2026-09-04': 86.6, '2026-09-07': 86.8 })],
  ['HO|202611', series({ '2026-09-01': 2.5, '2026-09-02': 2.52, '2026-09-03': 2.45, '2026-09-04': 2.46, '2026-09-07': 2.5 })],
]);
const cl = historicalVar([{ product: 'CL Nov26', lots: 2, size: 1000 }], H, { minDays: 1 });
is('2 long CL: each day\'s P/L is the move × 2 × 1,000', cl.pnls.map((x) => x.pnl), [1000, -4000, 200, 800]);
is('…the worst day, and when', cl.worst, { date: '2026-09-03', pnl: -4000 });
const sp = historicalVar([{ product: 'CL Nov26 - BZ Nov26 Inter-Product', lots: 2, size: 1000 }], H, { minDays: 1 });
// spread = CL − BZ: -8, -7.8, -7.9, -8, -7.8 → moves +0.2, -0.1, -0.1, +0.2
is('2 long CL–BZ: the spread\'s own moves, far smaller than CL\'s', sp.pnls.map((x) => x.pnl), [400, -200, -200, 400]);
is('…and its VaR', [sp.var95, sp.var99, sp.days], [200, 200, 4]);
const ck = historicalVar([{ product: 'Nov26 HO-CL Crack', lots: -1, size: 1000 }], H, { minDays: 1 });
// crack = HO × 42 − CL: 25, 25.34, 24.4, 24.72, 26 → moves +0.34, -0.94, +0.32, +1.28; short 1 × 1,000
is('1 short crack, priced HO × 42 − CL', ck.pnls.map((x) => x.pnl), [-340, 940, -320, -1280]);

// The book together: day by day, not each position's worst added up.
const book = historicalVar([{ product: 'CL Nov26 - BZ Nov26 Inter-Product', lots: 2, size: 1000 }, { product: 'Nov26 HO-CL Crack', lots: -1, size: 1000 }], H, { minDays: 1 });
is('the book\'s days are the positions\' days added up', book.pnls.map((x) => x.pnl), [60, 740, -520, -880]);
is('…its worst day is 7 Sep, not the sum of each one\'s worst', [book.worst.date, book.var99], ['2026-09-07', 880]);
is('…with each position\'s own worst day alongside', book.byPosition.map((p) => [p.product, p.worstDay]), [['CL Nov26 - BZ Nov26 Inter-Product', -200], ['Nov26 HO-CL Crack', -1280]]);

// ---------- gaps ----------
const gappy = new Map([...H, ['BZ|202611', series({ '2026-09-01': 88, '2026-09-02': 88.3, '2026-09-04': 86.6, '2026-09-07': 86.8 })]]);
is('a day missing in one leg shortens the history; no move is invented', historicalVar([{ product: 'CL Nov26 - BZ Nov26 Inter-Product', lots: 1, size: 1000 }], gappy, { minDays: 1 }).pnls.map((x) => x.date), ['2026-09-02', '2026-09-04', '2026-09-07']);
const none = historicalVar([{ product: 'CL Dec26', lots: 1, size: 1000 }, { product: 'CL Nov26', lots: 1, size: 1000 }], H, { minDays: 1 });
is('a contract with no history is named, the rest still counted', [none.missing, none.days], [['CL Dec26'], 4]);
is('too few days is said, not hidden', historicalVar([{ product: 'CL Nov26', lots: 1, size: 1000 }], H).tooShort, true);

// ---------- the statements fill in after the file ----------
const more = addSettles(H, [{ date: '2026-09-08', lots: [{ code: 'CL', month: '202611', kind: 'F', settle: 79.4 }] }, { date: '2026-09-07', lots: [{ code: 'CL', month: '202611', kind: 'F', settle: 99 }] }]);
is('a statement adds a new day; the uploaded file keeps its own', [more.get('CL|202611').get('2026-09-08'), more.get('CL|202611').get('2026-09-07')], [79.4, 79]);
is('…and the history passed in is not changed', H.get('CL|202611').has('2026-09-08'), false);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
