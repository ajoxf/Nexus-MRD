import { instrumentOf, settleOf, buildFeed, learnMargin, countsOf } from '../src/lib/brokerFeed.js';

/*
 * What the statements give the book: the latest close, settlement prices, deposits and
 * withdrawals, and what a spread costs in margin. Made-up accounts and figures, in Orient's shapes.
 */
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
};

// ---------- TT's product names ----------
const brief = (p) => { const i = instrumentOf(p); return i && [i.kind, i.legs.map((l) => `${l.code} ${l.month}`)]; };
is('an Inter-Product, as TT names it', brief('CL Nov26 - BZ Nov26 Inter-Product'), ['Inter-Product', ['CL 202611', 'BZ 202611']]);
is('a Crack', brief('Oct26 HO-CL Crack'), ['Crack', ['HO 202610', 'CL 202610']]);
is('a Calendar', brief('CL Oct26-Dec26 Calendar'), ['Calendar', ['CL 202610', 'CL 202612']]);
is('an outright', brief('HO Oct26'), ['Outright', ['HO 202610']]);
is('anything else is left alone', [instrumentOf('USOILX6'), instrumentOf('')], [null, null]);

// Spread settlements from leg settlements, the way TT quotes them.
const settles = new Map([['CL|202610', 87.06], ['BZ|202610', 94.39], ['HO|202610', 4.3848], ['CL|202612', 80.5]]);
is('Inter-Product settles at CL − BZ', settleOf('CL Oct26 - BZ Oct26 Inter-Product', settles), -7.33);
is('Crack settles at HO × 42 − CL', settleOf('Oct26 HO-CL Crack', settles), 97.1016);
is('Calendar settles at near − far', settleOf('CL Oct26-Dec26 Calendar', settles), 6.56);
is('no settlement for a leg: none for the spread', settleOf('CL Nov26 - BZ Nov26 Inter-Product', settles), null);

// ---------- The feed ----------
const a = (no, o) => ({ no, beginning: 0, cashAdj: 0, ending: 0, equity: 0, tne: 0, im: 0, excess: 0, pl: 0, ...o });
const lot = (code, month, side, qty, settle, orderId) => ({ account: '2001000011', code, month, kind: 'F', side, qty, price: settle, settle, upl: 0, orderId, tradeId: `T${code}${orderId}${side}` });
const days = [
  // The group's zip and the sub-accounts' zips, same day: the group row repeats its sub-accounts.
  { date: '2026-09-01', accounts: [a('200100', { cashAdj: 70050, ending: 70050, equity: 70050, tne: 70050 }), a('2001000000', { cashAdj: 70050, ending: 70050, equity: 70050, tne: 70050 }), a('2001000011')], lots: [] },
  { date: '2026-09-01', accounts: [a('2001000000', { cashAdj: 70050, ending: 70050, equity: 70050, tne: 70050 })], lots: null },
  { date: '2026-09-02', accounts: [a('2001000011', { cashAdj: -8000, ending: -8000, equity: -9000, tne: -9000, im: 5000 }), a('2001000000', { ending: 70050, equity: 70050, tne: 70050 })],
    lots: [lot('CL', '202610', 'B', 1, 87, '900001'), lot('BZ', '202610', 'S', 1, 94, '900001')] },
];
const f = buildFeed(days, '200100');
is('the latest close, from the sub-accounts when the group zip is missing', [f.date, f.anchor.ending, f.anchor.equity, f.anchor.im], ['2026-09-02', 62050, 61050, 5000]);
is('deposits and withdrawals, once each, from the sub-accounts', f.cash, [{ date: '2026-09-01', account: '2001000000', amount: 70050 }, { date: '2026-09-02', account: '2001000011', amount: -8000 }]);
is('the settlement prices at the close', [...f.settles.entries()], [['CL|202610', 87], ['BZ|202610', 94]]);
is('another group\'s statements are not read', buildFeed(days, '300300'), null);

// ---------- What a spread costs in margin ----------
// Orient's IM on each day = 2,000 per Inter-Product + 3,000 per Crack.
const ip = (n, o) => [...Array(n)].flatMap((_, i) => [lot('CL', '202611', 'B', 1, 80, `${o}${i}1`), lot('BZ', '202611', 'S', 1, 87, `${o}${i}1`)]);
const cr = (n, o) => [...Array(n)].flatMap((_, i) => [lot('HO', '202610', 'S', 1, 4.4, `${o}${i}2`), lot('CL', '202610', 'B', 1, 87, `${o}${i}2`)]);
const day = (nIp, nCr, o) => ({ fig: { im: 2000 * nIp + 3000 * nCr }, lots: [...ip(nIp, o), ...cr(nCr, o)] });
is('positions counted by kind of spread', countsOf([...ip(2, '91'), ...cr(1, '92')]), { 'Inter-Product': 2, Crack: 1, Calendar: 0, Outright: 0 });
is('margin per spread learned from the statements', learnMargin([day(2, 1, '911'), day(5, 2, '922'), day(1, 3, '933')]), { 'Inter-Product': 2000, Crack: 3000, days: 3 });
is('two kinds always held together: each falls back to IM per lot', learnMargin([day(1, 1, '941'), day(2, 2, '942')]), { 'Inter-Product': 2500, Crack: 2500, days: 2 });
is('nothing open on any day: nothing to learn', learnMargin([{ fig: { im: 0 }, lots: [] }]), null);

// ---------- Orient's sums: how the money got from the first statement to the last close ----------
const g = (date, o) => ({ date, accounts: [a('200100', o)], lots: null });
const chain = [
  g('2026-09-01', { beginning: 0, cashAdj: 70050, ending: 70050, equity: 70050 }),
  g('2026-09-02', { beginning: 70050, commission: -32, fee: -4.58, pl: 170, ending: 70183.42, equity: 70213.42 }),
  g('2026-09-03', { beginning: 70183.42, cashAdj: -8000, gst: -1.2, interest: -0.54, pl: -14880, ending: 47301.68, equity: 47301.68 }),
];
const sums = buildFeed(chain, '200100').sums;
is('deposits, P/L and charges add up to the last ending balance', [sums.cash, sums.pl, sums.charges, sums.upl, sums.unexplained], [62050, -14710, -38.32, 0, 0]);
is('…and open P/L is the last equity less the last ending balance', buildFeed(chain.slice(0, 2), '200100').sums.upl, 30);
is('a day missing from the chain shows as unexplained', buildFeed([chain[0], chain[2]], '200100').sums.unexplained, 133.42);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
