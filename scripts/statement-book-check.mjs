import { feedsFor, pnlAt } from '../src/lib/statementBook.js';
import { computeBook } from '../src/lib/positions.js';
import { settleOf } from '../src/lib/brokerFeed.js';

/*
 * The book on the broker's statements. Made-up group 200100 (sub-account 0011), shaped like Orient's
 * files, and TT fills as RAMP stores them. The promise checked: equity is Orient's at the close plus
 * what changed since — exactly Orient's with nothing new, and moved by exactly the new P/L after.
 */
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
};

const FSH = 'Acct Name,Acct No.,CCY,Exchange Rate,Balance Type,Beginning Balance,Cash Adjustments,Commission,Fee,GST,Profit/Loss,Options Premium,Interest,Ending Balance,Total Unrealised Profit/loss (UPL),FX Open Positions UPL,FX Closed Positions Forward PL,F&O Open Position UPL,Total Equity,Collateral MTM,Total net equity,Net Option Value,Net liquidating value,Account Market Value,Total IM,Total MM,Margin Excess/Deficit';
const fsRow = (no, cashAdj, ending, upl, im) => { const te = +(ending + upl).toFixed(2); return ['T', no, 'Base:USD', 1, 'x', 0, cashAdj, 0, 0, 0, 0, 0, 0, ending, upl, 0, 0, upl, te, 0, te, 0, te, 0, im, im, +(te - im).toFixed(2)].join(','); };
const OPH = 'SettlementDate,TradeEntryID,ExchangeOrderID,Client group account number,Client sub account number,TradeDate,ExchangeMIC,ClearingCode,ContractExpiryMonth,Expiry Date,ValueDate,CallPutFut,StrikePrice,TradePrice,BuySell,Amount,SettPrice,UnrealisedPL,Option value,TradePLCcy,Remark';
const opRow = (id, order, code, side, px, settle, upl) => `20260910,${id},${order},2-00100,2-00100-001-1,20260910,XNYM,${code},202611,20261020,20260910,F,,${px},${side},1,${settle},${upl},,USD,`;
const TCH = 'SettlementDate,TradeEntryID,ExchangeOrderID,Client group account number,Client sub account number,TradeDate,ExchangeMIC,ClearingCode,ContractExpiry,ValueDate,CallPutFut,StrikePrice,TradePrice,BuySell,Amount,Premium,PremiumCcy,Remark,Trade Type,Execution Time,Expiry Date,FinalComm,FinalCommCcy,Exchange Fee amount,Exchange Fee CCY,NFA amount,NFA CCY';
const tcRow = (id, order, code, side, px) => `20260910,${id},${order},2-00100,2-00100-001-1,20260910,XNYM,${code},202611,20260910,,,${px},${side},1,0,USD,,Spread,9/10/2026 10:00,10/20/2026,-0.35,USD,-1.5,USD,-0.01,USD`;

// 10 Sep: bought one CL–BZ Nov26 Inter-Product at -8.00 (CL 92, BZ 100). Settled at -7.50 (CL 92.5, BZ 100).
// Orient: ending 10,000 cash (deposit), unrealised +500, IM 2,000 → equity 10,500.
const rows = [{
  zip_name: 'Client Daily Statement - 0011 - 20260910.zip', statement_date: '2026-09-10', account: '0011',
  files: [
    { name: 'Financial Summary - 0011 - 20260910.csv', text: [FSH, fsRow('200100', 10000, 10000, 500, 2000), fsRow('2001000011', 10000, 10000, 500, 2000)].join('\n') },
    { name: 'Open Position.csv', text: [OPH, opRow('TT1', '900001', 'CL', 'B', 92, 92.5, 500), opRow('TT2', '900001', 'BZ', 'S', 100, 100, 0)].join('\n') },
    { name: 'Trade Confirmation.csv', text: [TCH, tcRow('TT1', '900001', 'CL', 'B', 92), tcRow('TT2', '900001', 'BZ', 'S', 100)].join('\n') },
  ],
}];
const at = (d, h, m) => new Date(Date.UTC(2026, 8, d, h, m)).toISOString();
const ttFill = (ts, product, side, price, extra = {}) => ({ ts, product, side, qty: 1, price, broker: 'orient', account: '2001000011-GHF', ref: `${product}${ts}${side}`, is_leg: false, ...extra });
const spreadTrade = (ts, side, cl, bz) => [
  ttFill(ts, 'CL Nov26 - BZ Nov26 Inter-Product', side, +(cl - bz).toFixed(2)),
  ttFill(ts, 'CL Nov26', side, cl, { is_leg: true }),
  ttFill(ts, 'BZ Nov26', side === 'Buy' ? 'Sell' : 'Buy', bz, { is_leg: true }),
];
const fillsToClose = spreadTrade(at(10, 10, 0), 'Buy', 92, 100);
const brokers = [{ id: 'orient' }, { id: 'mt5' }];

const feeds = feedsFor(rows, [...fillsToClose, { ...fillsToClose[0], broker: 'mt5', account: null, ref: 'other' }], brokers);
is('the RAMP account whose TT fills carry 2001000011 is fed by group 200100; the other is not', Object.keys(feeds), ['orient']);
const f = feeds.orient;
is('as at the latest statement: equity and IM', [f.date, f.anchor.equity, f.anchor.im], ['2026-09-10', 10500, 2000]);
is('the statement ends at the last fill Orient booked', f.cutoff, fillsToClose[0].ts);
is('the spread is priced at settlement from its legs', settleOf('CL Nov26 - BZ Nov26 Inter-Product', f.settles), -7.5);

// Equity = Orient's equity at the close + (P/L now − P/L at the close).
const size = () => 1000;
const equity = (fills, priceOf) => {
  const now = computeBook(fills, size, () => 'fifo');
  const close = computeBook(fills.filter((x) => x.ts <= f.cutoff), size, () => 'fifo');
  return +(f.anchor.equity + pnlAt(now, priceOf, size) - pnlAt(close, (p) => settleOf(p.product, f.settles) ?? p.avg, size)).toFixed(2);
};
const atSettle = (p) => settleOf(p.product, f.settles);
is('nothing new, prices at settlement: exactly Orient\'s equity', equity(fillsToClose, atSettle), 10500);
is('the spread moves from -7.50 to -7.20: +$300', equity(fillsToClose, () => -7.2), 10800);
const more = [...fillsToClose, ...spreadTrade(at(11, 9, 0), 'Buy', 93, 101)];
is('a second spread bought since, at -8.00, marked at -7.50: +$500 more', equity(more, atSettle), 11000);
const closed = [...fillsToClose, ...spreadTrade(at(11, 9, 0), 'Sell', 93, 100.6)];
is('the spread sold since at -7.60: -$100 against settlement, realised', equity(closed, atSettle), 10400);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
