import { reconcile, tradeDate, contractKey } from '../src/lib/reconcile.js';
import { withCommission } from '../src/lib/positions.js';
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
};
const r2 = (x) => Math.round(x * 100) / 100;

// ---------- trading days ----------
eq('16:59 Chicago is still that day', tradeDate('2026-09-30T21:59:00Z'), '2026-09-30');
eq('17:00 Chicago starts the next day', tradeDate('2026-09-30T22:00:00Z'), '2026-10-01');
eq('a Dubai evening trade belongs to the next statement', tradeDate('2026-09-30T19:30:00Z'.replace('19:30', '22:30')), '2026-10-01');
eq('Sunday evening Chicago is Monday', tradeDate('2026-10-04T22:30:00Z'), '2026-10-05');
eq('winter time moves the boundary an hour', [tradeDate('2026-12-01T22:59:00Z'), tradeDate('2026-12-01T23:00:00Z')], ['2026-12-01', '2026-12-02']);
eq('contract keys ignore case and spacing', contractKey(' bz  Dec26 '), 'BZ DEC26');

// ---------- a made-up book and three days of made-up Orient statements ----------
// Two BZ/CL spreads, bought as CL − BZ, with their legs stored, as the TT import keeps them.
const spread = (id, ts, px, bz, cl) => [
  { ts, broker: 'orient', product: 'CL Dec26 - BZ Dec26 Inter-Product', side: 'Buy', qty: 1, price: px, fee: 0, ref: `${id}s`, order_id: id, is_leg: false },
  { ts, broker: 'orient', product: 'BZ Dec26', side: 'Sell', qty: 1, price: bz, fee: 0, ref: `${id}b`, order_id: id, is_leg: true },
  { ts, broker: 'orient', product: 'CL Dec26', side: 'Buy', qty: 1, price: cl, fee: 0, ref: `${id}c`, order_id: id, is_leg: true },
];
const account = { capital: 0, method: 'fifo', includeRealized: true, commission: 10, products: { 'CL Dec26 - BZ Dec26 Inter-Product': { size: 1000, margin: 2500 } } };
const fillsAll = [...spread('o1', '2026-09-25T14:00:00Z', -9.0, 70.1, 61.1), ...spread('o2', '2026-09-30T14:00:00Z', -9.2, 70.7, 61.5)];
// Commission as RAMP applies it: $10 a lot on the spread fill. Legs carry it too but are never booked.
const withComm = (fills) => withCommission(fills, { orient: account });
const cash = [{ id: 'd1', broker: 'orient', type: 'deposit', amount: 30000, ts: '2026-09-20T08:00:00Z' }];
const sizeOf = (p) => account.products[p]?.size || 1000;
const chargeTotal = () => 0;

const fs = (o) => {
  const a = { beginning: 0, cashAdj: 0, commission: 0, fee: 0, gst: 0, pl: 0, optPremium: 0, interest: 0, upl: 0, fxOpenUpl: 0, fxClosedPl: 0, foUpl: 0, collateral: 0, optValue: 0, im: 0, mm: 0, ...o };
  a.ending = r2(a.beginning + a.cashAdj + a.commission + a.fee + a.gst + a.pl + a.optPremium + a.interest);
  a.upl = a.foUpl; a.equity = r2(a.ending + a.upl); a.tne = r2(a.equity + a.collateral); a.nlv = a.tne; a.marketValue = a.tne; a.excess = r2(a.nlv - a.im);
  return [{ name: 'TEST', no: '200100', ccy: 'USD', ...a }];
};
const lot = (code, side, price, settle) => ({ account: '2001000011', group: '200100', code, month: '202612', kind: 'F', strike: null, side, qty: 1, price, settle,
  upl: r2((settle - price) * (side === 'B' ? 1 : -1) * 1000), expiry: '', exchange: 'XNYM', tradeDate: '', ccy: 'USD', tradeId: '' });
const lotsOct1 = [lot('BZ', 'S', 70.1, 71.0), lot('BZ', 'S', 70.7, 71.0), lot('CL', 'B', 61.1, 61.6), lot('CL', 'B', 61.5, 61.6)];
// Orient: $10 commission on the 25th (before the period), the second spread's $10 split into
// commission, fee and GST on the 30th, and a $5,000 deposit on 1 Oct that RAMP doesn't have.
const statements = [
  { date: '2026-09-29', accounts: fs({ beginning: 29990 }), lots: null },
  { date: '2026-09-30', accounts: fs({ beginning: 29990, commission: -8, fee: -1.5, gst: -0.5 }), lots: null },
  { date: '2026-10-01', accounts: fs({ beginning: 29980, cashAdj: 5000, foUpl: -600, im: 6618 }), lots: lotsOct1 },
];
const run = (over = {}) => reconcile({ statements, fills: withComm(fillsAll), cash, account, marks: { 'CL Dec26 - BZ Dec26 Inter-Product': -9.3 }, chargeTotal, sizeOf, ...over });

{
  const r = run();
  const by = Object.fromEntries([...r.lines, ...r.openLines].map((l) => [l.key, r2(l.diff)]));
  eq('period and account', [r.account, r.from, r.to, r.days], ['200100', '2026-09-29', '2026-10-01', 3]);
  eq('opening balance agrees (the commission before the period is in both)', by.opening, 0);
  eq('the deposit RAMP is missing is the deposit line', by.deposits, 5000);
  eq('commission, fee and GST together match RAMP\'s commission', by.fees, 0);
  eq('the positions agree, so their P/L at settlement agrees', by.positions, 0);
  eq('the gap in prices is the price line: -9.30 typed, -9.40 settled, 2 lots', by.prices, -200);
  eq('no days missing', by.gaps, 0);
  eq('the lines explain the whole gap in net equity', [r2(r.tneLine.diff), r.unexplained], [4800, 0]);
  eq('positions leg by leg', r.positions.map((p) => [p.contract, p.orient.lots, p.ramp.lots, p.match]), [['BZ Dec26', -2, -2, true], ['CL Dec26', 2, 2, true]]);
  eq('margin: Orient\'s per-lot figure is offered, not applied', [r.im.ok, r.im.implied], [false, { product: 'CL Dec26 - BZ Dec26 Inter-Product', perLot: 3309, current: 2500, lots: 2 }]);
  eq('the account is not changed', account.products['CL Dec26 - BZ Dec26 Inter-Product'].margin, 2500);
}

// Prices typed at settlement: the price line disappears.
eq('settlement typed in: prices agree', r2(run({ marks: { 'CL Dec26 - BZ Dec26 Inter-Product': -9.4 } }).openLines.find((l) => l.key === 'prices').diff), 0);

// A fill missing from RAMP: positions, fees and the net equity gap all say so.
{
  const r = run({ fills: withComm(fillsAll.filter((f) => f.order_id !== 'o2')) });
  const by = Object.fromEntries([...r.lines, ...r.openLines].map((l) => [l.key, r2(l.diff)]));
  eq('a missing trade shows in positions', r.positions.map((p) => [p.contract, p.orient.lots, p.ramp.lots, p.match]), [['BZ Dec26', -2, -1, false], ['CL Dec26', 2, 1, false]]);
  eq('...and in fees: Orient charged for it, RAMP didn\'t', by.fees, -10);
  eq('...and still nothing unexplained', r.unexplained, 0);
}

// A trade done on a Dubai evening after the statement's close belongs to the next statement.
{
  const late = spread('o3', '2026-10-01T22:30:00Z', -9.5, 71.0, 61.5);
  const r = run({ fills: withComm([...fillsAll, ...late]) });
  eq('a trade after the close is not in this statement\'s positions', r.positions.map((p) => p.ramp.lots), [-2, 2]);
}

// A spread imported without its legs: said, not guessed.
{
  const r = run({ fills: withComm(fillsAll.filter((f) => !(f.order_id === 'o2' && f.is_leg))) });
  eq('a spread without legs is counted', r.legless, 1);
  eq('...and named in the fix', /without legs/.test(r.openLines.find((l) => l.key === 'positions').fix), true);
}

// A missing day between statements is its own line, not hidden in another.
{
  const r = reconcile({ statements: [statements[0], statements[2]], fills: withComm(fillsAll), cash, account, marks: {}, chargeTotal, sizeOf });
  const by = Object.fromEntries(r.lines.map((l) => [l.key, r2(l.diff)]));
  eq('the missing 30th shows as a gap of its $10', by.gaps, -10);
  eq('...and the lines still explain everything', r.unexplained, 0);
}

// Charges: a one-off counts from its own date, a monthly one month by month.
{
  const withCharges = [...cash,
    { id: 'c1', broker: 'orient', type: 'charge', amount: 25, ts: '2026-09-30T08:00:00Z', category: 'Exchange & clearing fees' },
    { id: 'c2', broker: 'orient', type: 'charge', amount: 99, ts: '2026-01-15T08:00:00Z', category: 'Other' }];
  const r = run({ cash: withCharges });
  const by = Object.fromEntries(r.lines.map((l) => [l.key, r2(l.diff)]));
  eq('a charge inside the period counts as a fee in it', by.fees, 25);
  eq('a charge from months ago counts before it', by.opening, 99);
}

eq('no statements, no comparison', reconcile({ statements: [], fills: [], account, chargeTotal, sizeOf }), null);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
