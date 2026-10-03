import Papa from 'papaparse';
import { readTradeConfirmations, uniqueTrades, spreadBook, checkHistory, isTradeConfirmation } from '../src/lib/spreadHistory.js';

/*
 * Spreads rebuilt from trade confirmations.
 *
 * The trades below are shaped on the trader's own Aug 17–21 (the Aug 19 ones are his, prices and
 * all; the rest are made up in the same pattern; accounts and ids are made up). Orient's view of
 * the same trades is produced by orientLegs below — each contract closed first in first out on its
 * own, which is what Orient's statements show — so the test can prove both halves: the rebuilt
 * spreads are the trader's real ones, and the two views agree on what the trading made in total.
 */
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
};

// ---------- Orient's file ----------
const HEADER = 'SettlementDate,TradeEntryID,ExchangeOrderID,Client group account number,Client sub account number,TradeDate,ExchangeMIC,ClearingCode,ContractExpiry,ValueDate,CallPutFut,StrikePrice,TradePrice,BuySell,Amount,Premium,PremiumCcy,Remark,Trade Type,Execution Time,Expiry Date,FinalComm,FinalCommCcy,Exchange Fee amount,Exchange Fee CCY,NFA amount,NFA CCY';
let n = 0;
const row = (date, time, order, code, side, price, sub = '2-00100-001-1') =>
  `${date},TT${String(++n).padStart(8, '0')},${order},2-00100,${sub},${date},XNYM,${code},202610,${date},,,${price},${side},1,0,USD,,Spread,8/${date.slice(6)}/2026 ${time},9/22/2026,-0.35,USD,-1.5,USD,-0.01,USD`;
const read = (lines) => readTradeConfirmations(Papa.parse([HEADER, ...lines].join('\n'), { skipEmptyLines: true }).data);

const IP = (date, time, o, side, cl, bz) => [row(date, time, o, 'CL', side, cl), row(date, time, o, 'BZ', side === 'B' ? 'S' : 'B', bz)];
const CRACK = (date, time, o, side, ho, cl) => [row(date, time, o, 'HO', side, ho), row(date, time, o, 'CL', side === 'B' ? 'S' : 'B', cl)];
const days = {
  '20260817': [...IP('20260817', '09:15', '9000000000001', 'B', 82.9, 90.1)],
  '20260818': [
    ...IP('20260818', '10:01', '9000000000002', 'B', 84.33, 91.37),
    ...IP('20260818', '10:20', '9000000000003', 'B', 84.16, 91.16), ...IP('20260818', '10:21', '9000000000004', 'B', 84.16, 91.16),
    ...IP('20260818', '10:22', '9000000000005', 'B', 84.16, 91.16), ...IP('20260818', '10:23', '9000000000006', 'B', 84.17, 91.17),
    ...IP('20260818', '10:24', '9000000000007', 'B', 84.16, 91.16),
  ],
  '20260819': [
    ...CRACK('20260819', '13:12', '9000000000008', 'S', 4.31, 84.27), ...CRACK('20260819', '13:13', '9000000000009', 'S', 4.31, 84.23),
    ...IP('20260819', '18:15', '9000000000010', 'B', 84.83, 91.94),
  ],
  '20260820': [...IP('20260820', '11:00', '9000000000011', 'S', 86.0, 93.17)],
  '20260821': [
    ...IP('20260821', '09:30', '9000000000012', 'S', 86.2, 93.07),
    ...CRACK('20260821', '10:00', '9000000000013', 'B', 4.40, 86.3), ...CRACK('20260821', '10:01', '9000000000014', 'B', 4.40, 86.3),
    ...CRACK('20260821', '14:00', '9000000000015', 'S', 4.41, 86.51),
  ],
};
const SETTLE = { CL: 87.06, BZ: 94.39, HO: 4.3848 };
const MULT = { CL: 1000, BZ: 1000, HO: 42000 };

// Orient's view: each contract first in first out on its own. Returns its open lots and its realised P/L.
function orientLegs(trades, settle) {
  const q = {}, lots = [];
  let realised = 0;
  for (const t of trades) {
    const k = t.code, s = t.side === 'B' ? 1 : -1;
    (q[k] ||= []);
    let left = t.qty;
    while (left && q[k].length && q[k][0].s !== s) { const h = q[k][0], m = Math.min(left, h.qty); realised += h.s * (t.price - h.price) * m * MULT[k]; h.qty -= m; left -= m; if (!h.qty) q[k].shift(); }
    if (left) q[k].push({ s, qty: left, price: t.price });
  }
  for (const [code, list] of Object.entries(q)) for (const o of list) {
    lots.push({ account: '2001000011', code, month: '202610', side: o.s > 0 ? 'B' : 'S', qty: o.qty, price: o.price, settle: settle[code], upl: +(o.s * (settle[code] - o.price) * o.qty * MULT[code]).toFixed(2) });
  }
  return { lots, realised: +realised.toFixed(2) };
}

{
  const r = read(days['20260819']);
  is('a Trade Confirmation reads cleanly', [r.problems, r.trades.length], [[], 6]);
  is('the short sub-account code is joined to the group, as in Open Position', r.trades[0].account, '2001000011');
  is('fees per leg: commission + exchange fee + NFA', r.trades[0].fees, -1.86);
  is('file name is recognised', [isTradeConfirmation('Trade Confirmation.csv'), isTradeConfirmation('Open Position.csv')], [true, false]);
  is('a missing column stops the read', read(['x']).problems.length > 0 && readTradeConfirmations(Papa.parse('TradeEntryID\nx', { skipEmptyLines: true }).data).problems[0].includes('ExchangeOrderID'), true);
}

// The same trades arrive in the sub-account's zip AND the group's zip.
const lists = [];
for (const lines of Object.values(days)) { const t = read(lines).trades; lists.push(t, t.map((x) => ({ ...x }))); }
const trades = uniqueTrades(lists);
is('each trade counted once, though two zips carry it', trades.length, Object.values(days).flat().length);

const book = spreadBook(trades, '20260821');
const show = (ps) => ps.map((p) => [p.label, p.lots, p.entry]).sort();
is('Aug 21, rebuilt: 6 Inter-Product at the prices traded, 1 short Crack at 98.71',
   show(book.positions), [['CL–BZ Oct26 Inter-Product', 6, -7.018333], ['HO–CL Oct26 Crack', -1, 98.71]]);

const orient = orientLegs(trades, SETTLE);
const chk = checkHistory(book, orient.lots, { '2001000011': orient.realised });
is('the rebuilt legs are exactly the lots Orient shows open', [chk.legsMatch, chk.mismatches], [true, []]);
is('…and the two agree to the cent on what the trading has made in total', chk.pnlGap, { '2001000011': 0 });
is('…while splitting it differently: Orient books leg gains as realised, so its open legs carry more loss',
   // By hand: spreads −1,870 + 1,608.40 = −261.60. Orient's legs: BZ −18,590 + CL 17,090 + HO 1,058.40 = −441.60.
   [chk.bookUpl['2001000011'], chk.orientUpl['2001000011'], chk.bookUpl['2001000011'] > chk.orientUpl['2001000011']], [-261.6, -441.6, true]);
is('the spreads are priced at Orient\'s settlement', chk.positions.map((p) => [p.label, p.settle, p.upl]).sort(),
   [['CL–BZ Oct26 Inter-Product', -7.33, -1870], ['HO–CL Oct26 Crack', 97.1016, 1608.4]]);

// What the book looked like on earlier days.
is('Aug 19, before any closes: 8 Inter-Product, 2 Cracks', show(spreadBook(trades, '20260819').positions),
   [['CL–BZ Oct26 Inter-Product', 8, -7.04375], ['HO–CL Oct26 Crack', -2, 96.77]]);
is('Aug 17: the first trade only', show(spreadBook(trades, '20260817').positions), [['CL–BZ Oct26 Inter-Product', 1, -7.2]]);

// History that starts too late cannot be trusted, and says so.
const late = uniqueTrades([read(days['20260821']).trades]);
const lateChk = checkHistory(spreadBook(late, '20260821'), orient.lots, { '2001000011': orient.realised });
is('history missing its start: the legs do not match, so it is not shown', lateChk.legsMatch, false);

// An order whose legs the rules don't know is two outrights, not a spread.
const odd = read([row('20260822', '09:00', '9000000000099', 'CL', 'B', 86), row('20260822', '09:00', '9000000000099', 'CL', 'S', 86.5)]).trades;
is('one contract bought and sold in one order is not a spread', spreadBook(odd, '20260822').positions, []);
const lone = read([row('20260822', '09:00', '9000000000098', 'HO', 'S', 4.4)]).trades;
is('a single leg is an outright', spreadBook(lone, '20260822').positions.map((p) => [p.kind, p.label, p.lots, p.entry]), [['Outright', 'HO Oct26', -1, 4.4]]);
{
  // Excel rounds every order id to 8.07E+12: two unrelated trades must not become one "order".
  const mangled = read([row('20260822', '09:00', '8.07E+12', 'HO', 'S', 4.4), row('20260822', '15:00', '8.07E+12', 'CL', 'B', 86)]).trades;
  is('Excel-rounded ids do not pair unrelated trades into a spread', spreadBook(mangled, '20260822').positions.map((p) => p.kind).sort(), ['Outright', 'Outright']);
}

// ---------- Closed with legs, not as a spread ----------
/*
 * A spread closed by trading its legs on separate orders (BZ Oct26 expiring) arrives as two
 * outright trades. They must close the spread, at the price the two legs imply — not sit beside it
 * as an open spread plus two outrights that cancel, with the spread's P/L lost. Shaped on Aug 25:
 * +3 Inter-Product at -7.6133, closed with CL sold at 85.6267 and BZ bought at 93.2967:
 * (-7.67 - -7.6133) x 3 x 1,000 = -$170.
 */
{
  const open = [...IP('20260820', '09:00', '9000000000101', 'B', 85.70, 93.30), ...IP('20260820', '09:01', '9000000000102', 'B', 85.60, 93.22), ...IP('20260820', '09:02', '9000000000103', 'B', 85.65, 93.27)];
  const legged = [
    row('20260825', '10:00', '9000000000201', 'CL', 'S', 85.6267), row('20260825', '10:00', '9000000000202', 'CL', 'S', 85.6267), row('20260825', '10:00', '9000000000203', 'CL', 'S', 85.6267),
    row('20260825', '10:05', '9000000000301', 'BZ', 'B', 93.2967), row('20260825', '10:05', '9000000000302', 'BZ', 'B', 93.2967), row('20260825', '10:05', '9000000000303', 'BZ', 'B', 93.2967),
  ];
  const tr = uniqueTrades([read([...open, ...legged]).trades]);
  const bk = spreadBook(tr, '20260825');
  is('a spread closed with legs is closed: nothing left open', bk.positions, []);
  is('…and its P/L is realised at the price the legs imply', bk.realised, { '2001000011': -170 });

  // The other way round: opened with legs, closed as a spread.
  const legsFirst = [row('20260820', '09:00', '9000000000401', 'CL', 'B', 85.0), row('20260820', '09:05', '9000000000402', 'BZ', 'S', 92.5)];
  const closeAsSpread = IP('20260825', '10:00', '9000000000403', 'S', 86.0, 93.0);
  const bk2 = spreadBook(uniqueTrades([read([...legsFirst, ...closeAsSpread]).trades]), '20260825');
  is('opened with legs, closed as a spread: nothing left open', bk2.positions, []);
  is('…P/L realised: (86 - 93) - (85 - 92.5) = +0.5 x 1,000', bk2.realised, { '2001000011': 500 });

  // Legs that only partly offset close only that much.
  const bk3 = spreadBook(uniqueTrades([read([...open, legged[0], legged[3]]).trades]), '20260825');
  is('one lot of each leg closes one spread, two stay open', bk3.positions.map((p) => [p.kind, p.lots]), [['Inter-Product', 2]]);
}

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
