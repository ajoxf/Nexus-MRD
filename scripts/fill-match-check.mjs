import { matchFills, contractOf, accountOf } from '../src/lib/fillMatch.js';

/*
 * RAMP's TT fills against Orient's Trade Confirmations. Made-up fills and trades, shaped like
 * the trader's: TT's account is "<sub-account>-GHF", spreads come as the spread plus its legs,
 * and Orient's clock runs 7 hours ahead of the TT export's.
 */
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
};

// A TT fill as RAMP stores it. The clock reading is made in this process's zone, as the importer reads it.
let n = 0;
const tt = (day, hh, mm, product, side, price, extra = {}) =>
  ({ ts: new Date(2026, 8, day, hh, mm).toISOString(), product, side, qty: 1, price, account: '2001000011-GHF', ref: `r${++n}`, is_leg: false, ...extra });
const ttSpread = (day, hh, mm, side, cl, bz) => [
  tt(day, hh, mm, `CL Nov26 - BZ Nov26 Inter-Product`, side, +(cl - bz).toFixed(2)),
  tt(day, hh, mm, 'CL Nov26', side, cl, { is_leg: true }),
  tt(day, hh, mm, 'BZ Nov26', side === 'Buy' ? 'Sell' : 'Buy', bz, { is_leg: true }),
];
// An Orient Trade Confirmation lot, its time 7 hours after TT's.
let m = 0;
const or = (day, hh, mm, code, side, price, month = '202611') => {
  const t = new Date(Date.UTC(2026, 8, day, hh + 7, mm));
  return { tradeId: `TT${++m}`, orderId: '', account: '2001000011', date: `202609${String(t.getUTCDate()).padStart(2, '0')}`,
    time: `9/${t.getUTCDate()}/2026 ${t.getUTCHours()}:${String(t.getUTCMinutes()).padStart(2, '0')}`, code, month, kind: 'F', side, price, qty: 1 };
};
const orSpread = (day, hh, mm, side, cl, bz) => [or(day, hh, mm, 'CL', side, cl), or(day, hh, mm, 'BZ', side === 'B' ? 'S' : 'B', bz)];

is('TT contract names', [contractOf('CL Nov26'), contractOf('HO Oct26'), contractOf('CL Nov26 - BZ Nov26 Inter-Product')], [{ code: 'CL', month: '202611' }, { code: 'HO', month: '202610' }, null]);
is('TT account "<sub-account>-GHF" is the sub-account', [accountOf('1003050011-GHF'), accountOf('1-00305-001-1')], ['1003050011', '1003050011']);

const fills = [
  ...ttSpread(4, 9, 50, 'Buy', 87.77, 95.30),
  ...ttSpread(4, 13, 44, 'Sell', 86.39, 93.76),
  ...ttSpread(4, 15, 7, 'Buy', 87.63, 95.13),
  tt(8, 8, 29, 'CL Oct26', 'Buy', 91.28), // an outright
];
const trades = [
  ...orSpread(4, 9, 50, 'B', 87.77, 95.30),
  ...orSpread(4, 13, 44, 'S', 86.39, 93.76),
  ...orSpread(4, 15, 7, 'B', 87.63, 95.13),
  or(8, 8, 29, 'CL', 'B', 91.28, '202610'),
];
const days = { '2001000011': new Set(['20260903', '20260904', '20260907', '20260908', '20260909']) };

const r = matchFills(fills, trades, days);
is('every lot matched, legs against legs; spread rows left out', [r.matched, r.missing.length, r.extra.length], [7, 0, 0]);
is('the clock gap is read from the data: Orient is 7 hours ahead of TT', r.offsetHours, 7);

// A fill stored twice is the double count this exists to catch.
const twice = matchFills([...fills, { ...fills[1], ref: 'dup' }], trades, days);
is('a TT fill stored twice: one is "not at Orient"', twice.extra.map((x) => [x.contract, x.side, x.price, x.ref]), [['CL 202611', 'B', 87.77, 'dup']]);

// A fill Orient booked that RAMP never got.
const lost = matchFills(fills.filter((f) => f.ref !== 'r2'), trades, days);
is('an Orient lot with no TT fill: "missing from RAMP"', lost.missing.map((x) => [x.date, x.contract, x.side, x.price]), [['20260904', 'CL 202611', 'B', 87.77]]);

// Only where both sides have data.
const early = [...trades, or(2, 10, 0, 'CL', 'B', 85.0)];
is('an Orient trade before the TT fills begin is not called missing', matchFills(fills, early, days).missing, []);
const late = [...fills, tt(9, 20, 59, 'CL Nov26', 'Sell', 93.31, { is_leg: true })];
is('a TT fill whose Orient day has no statement open is not called extra', matchFills(late, trades, days).extra, []);
is('…and is, once that day is open', matchFills(late, trades, { '2001000011': new Set([...days['2001000011'], '20260910']) }).extra.length, 1);

// Same contract, same price, twice in a day: the clock decides which is which.
const same = [tt(4, 10, 0, 'HO Oct26', 'Sell', 4.5), tt(4, 16, 0, 'HO Oct26', 'Sell', 4.5)];
const sameOr = [or(4, 16, 0, 'HO', 'S', 4.5, '202610'), or(4, 10, 0, 'HO', 'S', 4.5, '202610')];
const sr = matchFills([...fills, ...same], [...trades, ...sameOr], days);
is('two identical lots in a day pair up by time, not by order', sr.extra.length + sr.missing.length, 0);

// Per day.
is('per Orient trade date: lots, matched, missing, extra', lost.days.map((d) => [d.date, d.orient, d.matched, d.missing, d.extra]), [['20260904', 6, 5, 1, 0], ['20260908', 1, 1, 0, 0]]);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
