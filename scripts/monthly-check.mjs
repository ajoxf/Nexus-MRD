import { linesFromItems, readMonthlyStatement, checkMonthly, tieToDaily, money } from '../src/lib/monthly.js';

/*
 * Orient's monthly statement, as the PDF's text comes out: positioned fragments. The layout —
 * columns, x positions, the description split over two lines, the abbreviations box that repeats
 * "GST" — is copied from a real August 2026 statement; the name and account are made up. The
 * figures are that statement's, and every one of Orient's own sums in it adds up.
 */
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
};

// One page's fragments: [y, [[text, x], …]] → pdf.js-like items, in a scrambled order as pdf.js gives them.
const page = (rows) => rows.flatMap(([y, cells]) => cells.map(([str, x]) => ({ str, x, y }))).reverse();
const furniture = (n) => [
  [1488, [['Account Name : TEST TRADER‑0011', 50], ['Statement Date : 31/08/2026', 972]]],
  [1477, [['MONTHLY STATEMENT for August‑2026', 429]]],
  [1471, [['Account Number : 2‑00100‑001‑1', 50], [`Page ${n} of 3`, 1074]]],
];
const PS_HEAD = [830, [['Trade Date', 52], ['Exchange', 136], ['Buy', 282], ['Sell', 363], ['Description', 391], ['C/P', 519], ['Strike', 650], ['Price', 752], ['Trading CCY', 787], ['Profit and Loss', 894], ['P&L CCY', 994], ['Remarks', 1046]]];
const OP_HEAD = [324, [['Trade Date', 52], ['Exchange', 135], ['Buy', 270], ['Sell', 346], ['Description', 374], ['C/P', 492], ['Strike', 636], ['Trade Price', 710], ['Trading CCY', 778], ['Unrealised P&L', 895], ['P&L CCY', 1000], ['Remarks', 1052]]];
const realisedBlock = (y, name, day, buy, sell, ex, pl) => [
  [y, [['17/08/26', 52], ['NYMEX', 136], ['1', 377], [name, 391], ['90.10', 752], ['USD', 787]]],
  [y - 13, [[day, 391]]],
  [y - 30, [['Total', 52], [String(buy), 290], [String(sell), 370], [ex, 391], [pl, 913], ['USD', 1015]]],
];
const pages = [
  page([...furniture(1),
    [1393, [['JOURNAL ENTRIES', 530]]],
    [1362, [['Date', 52], ['Trade Date', 172], ['Payment Type', 293], ['Description', 439], ['Reg', 750], ['CCY', 875], ['Amount', 1092]]],
    [1341, [['21/08/26', 52], ['21/08/26', 172], ['FO commission', 293], ['Overcharged comm NYMEX 42 lots TD 17Aug‑20Aug', 439], ['SEG', 750], ['USD', 875], ['321.30', 1101]]],
    [1323, [['24/08/26', 52], ['24/08/26', 172], ['BANK CHARGES', 293], ['Fee', 439], ['SEG', 750], ['USD', 875], ['(55.00)', 1100]]],
    [1305, [['24/08/26', 52], ['24/08/26', 172], ['Funds WD&Deposit', 293], ['Margin Withdrawal', 439], ['SEG', 750], ['USD', 875], ['(8,000.00)', 1085]]],
    [1252, [['MONTHLY SUMMARY OF TRADES BY EXCHANGE/CURRENCY', 399]]],
    [1221, [['Exchange', 52], ['Commodity', 169], ['Delivery', 255], ['Buy', 388], ['Sell', 467], ['CCY', 495], ['Exchange Fee', 617], ['Comm', 774], ['GST', 907], ['Remarks', 936], ['Trade Type', 1045]]],
    [1200, [['NYMEX', 52], ['BZ', 169], ['Aug‑26', 255], ['16', 396], ['16', 474], ['USD', 495], ['(24.64)', 652], ['(95.35)', 772], ['0.00', 905], ['Spread', 1045]]],
    [1182, [['NYMEX', 52], ['BZ', 169], ['Sep‑26', 255], ['21', 396], ['21', 474], ['USD', 495], ['(32.34)', 652], ['(14.70)', 772], ['0.00', 905], ['Spread', 1045]]],
    [1164, [['NYMEX', 52], ['CL', 169], ['Oct‑26', 255], ['21', 396], ['21', 474], ['USD', 495], ['(63.00)', 652], ['(14.70)', 772], ['0.00', 905], ['Spread', 1045]]],
    [1146, [['NYMEX', 52], ['CL', 169], ['Sep‑26', 255], ['42', 396], ['36', 474], ['USD', 495], ['(117.00)', 646], ['(187.95)', 766], ['0.00', 905], ['Spread', 1045]]],
    [1128, [['NYMEX', 52], ['HO', 169], ['Sep‑26', 255], ['20', 396], ['26', 474], ['USD', 495], ['(69.00)', 652], ['(92.60)', 772], ['0.00', 905], ['Spread', 1045]]],
    [1109, [['Total', 52], ['120', 389], ['120', 467]]],
    [861, [['F&O PURCHASE & SALES', 512]]],
    PS_HEAD,
    ...realisedBlock(800, 'Brent Crude Oil ‑ Last', 'Day Oct 2026', 16, 16, 'Ex‑28‑Aug‑26', '(18,600.00)'),
    ...realisedBlock(700, 'Brent Crude Oil ‑ Last', 'Day Nov 2026', 21, 21, 'Ex‑30‑Sep‑26', '21,860.00'),
    ...realisedBlock(600, 'Light Sweet Crude Oil', 'Oct 2026', 36, 36, 'Ex‑22‑Sep‑26', '15,670.00'),
    ...realisedBlock(500, 'Light Sweet Crude Oil', 'Nov 2026', 21, 21, 'Ex‑20‑Oct‑26', '(14,240.00)'),
    ...realisedBlock(400, 'NY Harbor ULSD Oct', '2026', 20, 20, 'Ex‑30‑Sep‑26', '21,512.40'),
  ]),
  page([...furniture(2),
    [355, [['F&O OPEN POSITIONS', 519]]],
    OP_HEAD,
    [303, [['26/08/26', 52], ['NYMEX', 135], ['6', 284], ['Light Sweet Crude Oil', 374], ['82.76', 743], ['USD', 778], ['17,990.00', 934], ['USD', 1022]]],
    [289, [['Oct 2026', 374]]],
    [113, [['Total', 52], ['6', 284], ['Ex‑22‑Sep‑26', 374], ['Settlement Price:', 574], ['85.76', 739], ['17,990.00', 924], ['USD', 1021]]],
  ]),
  page([...furniture(3),
    [1417, OP_HEAD[1]],
    [1395, [['Average Long:', 591], ['82.7616667', 708]]],
    [1376, [['26/08/26', 52], ['NYMEX', 135], ['6', 359], ['NY Harbor ULSD Oct', 374], ['4.1710', 737], ['USD', 778], ['(60,375.00)', 921], ['USD', 1022]]],
    [1363, [['2026', 374]]],
    [1300, [['Total', 52], ['6', 359], ['Ex‑30‑Sep‑26', 374], ['Settlement Price:', 574], ['4.4106', 733], ['(60,375.00)', 916], ['USD', 1021]]],
    [1290, [['Average Short:', 591], ['4.1710167', 708]]],
    [1280, [['Net', 52], ['(42,385.00)', 916], ['USD', 1021]]],
    [1200, [['FINANCIAL SUMMARY', 522]]],
    ...[
      ['Beginning Balance', '0.00'], ['Cash Movement', '(8,000.00)'], ['Commission', '(84.00)'], ['Exchange Fee', '(305.98)'], ['Miscellaneous Fee', '(57.40)'],
      ['Withholding Tax', '0.00'], ['GST', '0.00'], ['Interests', '0.00'], ['Premiums', '0.00'], ['F&O Realized P&L', '26,202.40'], ['FX Realized P&L', '0.00'],
      ['Fixed Income Settlement Amount', '0.00'], ['Equity CFD Realized P&L', '0.00'], ['Ending Balance', '17,755.02'], ['F&O Unrealized Profit/Loss', '(42,385.00)'],
      ['LME Forward Close Profit/Loss', '0.00'], ['FX Forward Profit/Loss', '0.00'], ['FX Unrealized Profit/Loss', '0.00'], ['FX Swap Profit/Loss', '0.00'],
      ['Equity Cash to be Settled', '0.00'], ['Equity Position to be Settled', '0.00'], ['Equity CFD Unrealized P&L', '0.00'], ['Total Equity', '(24,629.98)'],
      ['Equity Market Value', '0.00'], ['Non‑ Cash Collateral', '0.00'], ['Total Net Equity', '(24,629.98)'], ['Option Market Value', '0.00'],
      ['Net Liquidating Value', '(24,629.98)'], ['Initial Margin', '48,135.03'], ['Maintenance Margin', '43,759.12'], ['Portfolio Risk Requirement', '48,135.03'],
      ['Margin Excess/Deficit', '(72,765.01)'],
    ].map(([label, v], i) => [1180 - i * 18, [[label, 52], [v, 400], [v, 540]]]),
    [500, [['This statement is subject to the following:', 52]]],
    [480, [['GST', 640], ['Goods and Services Tax', 700], ['Sub Ac', 900], ['Sub Account', 960]]],
  ]),
];

const m = readMonthlyStatement(linesFromItems(pages));
is('reads cleanly', m.problems, []);
is('account, month and date', [m.account, m.short, m.month, m.date], ['2001000011', '0011', '2026-08', '2026-08-31']);
is('the Financial Summary, as Orient states it', [m.summary.beginning, m.summary.ending, m.summary.foRealized, m.summary.foUnrealized, m.summary.totalEquity, m.summary.im, m.summary.excess],
   [0, 17755.02, 26202.4, -42385, -24629.98, 48135.03, -72765.01]);
is('"GST" in the abbreviations box below does not overwrite the GST line', m.summary.gst, 0);
is('journal entries', m.journal.map((j) => [j.type, j.amount]), [['FO commission', 321.3], ['BANK CHARGES', -55], ['Funds WD&Deposit', -8000]]);
is('realised P&L per contract, the month read off the description', m.realised.map((r) => [r.code, r.month, r.pl]),
   [['BZ', '202610', -18600], ['BZ', '202611', 21860], ['CL', '202610', 15670], ['CL', '202611', -14240], ['HO', '202610', 21512.4]]);
is('open positions: long or short from the column, average from the line below',
   m.open.map((o) => [o.code, o.month, o.lots, o.avg, o.settle, o.upl]), [['CL', '202610', 6, 82.7616667, 85.76, 17990], ['HO', '202610', -6, 4.1710167, 4.4106, -60375]]);
is('the Net line', m.openNet, -42385);
is('every one of Orient\'s sums adds up', checkMonthly(m), []);
is('…including the commission refund: 405.30 charged − 321.30 refunded = 84.00', [m.trades.reduce((t, x) => t + x.comm, 0).toFixed(2), m.summary.commission], ['-405.30', -84]);

// A wrong figure is named.
const off = { ...m, summary: { ...m.summary, ending: 17000 } };
is('an ending balance that does not add up is named', checkMonthly(off).map((c) => c.label)[0].startsWith('Ending balance'), true);

// Against the daily statements.
const acct = (beginning, ending, pl) => [{ no: '2001000011', beginning, ending, pl }];
const lot = (code, side, qty) => ({ account: '2001000011', code, month: '202610', side, qty });
const dailies = [
  { date: '2026-08-14', accounts: acct(0, 0, 0), lots: [] },
  { date: '2026-08-21', accounts: acct(-50.94, 10000, 26202.4), lots: null },
  { date: '2026-08-21', accounts: acct(-50.94, 10000, 26202.4), lots: null }, // the group zip, same day
  { date: '2026-08-31', accounts: acct(10000, 17755.02, 0), lots: [...Array(6)].map(() => lot('CL', 'B', 1)).concat([...Array(6)].map(() => lot('HO', 'S', 1))) },
  { date: '2026-09-01', accounts: acct(17755.02, 17755.02, 999), lots: [] }, // next month: not counted
];
const t = tieToDaily(m, dailies);
is('ties to the daily statements: opening, closing, realised, positions', t.lines.map((l) => l.ok), [true, true, true, true]);
is('…each day counted once, the next month left out', t.lines[2].want, 26202.4);
const short = tieToDaily(m, dailies.map((d) => (d.date === '2026-08-31' ? { ...d, lots: d.lots.slice(1) } : d)));
is('a position that differs is named', short.lines[3].note, 'CL 202610: monthly 6, daily 5');
is('no daily statements open: says so', tieToDaily(m, []).missing.startsWith('No daily statements'), true);

is('money: brackets are negative', [money('(8,000.00)'), money('321.30'), money('USD'), money('0.00')], [-8000, 321.3, null, 0]);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
