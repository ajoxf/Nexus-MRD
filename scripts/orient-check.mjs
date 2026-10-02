import Papa from 'papaparse';
import { readFinancialSummary, checkAccount, checkFamily, mainAccount, checkCarryOver, isFinancialSummary, COLUMNS, readOpenPositions, positionsOf, impliedSize, checkPositionsAgainstSummary, plainAccount, monthLabel, isOpenPosition } from '../src/lib/orient.js';
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
};

// Orient's header, exactly as the file has it. The figures below are made up.
const HEADER = 'Acct Name,Acct No.,CCY,Exchange Rate,Balance Type,Beginning Balance,Cash Adjustments,Commission,Fee,GST,Profit/Loss,Options Premium,Interest,Ending Balance,Total Unrealised Profit/loss (UPL),FX Open Positions UPL,FX Closed Positions Forward PL,F&O Open Position UPL,Total Equity,Collateral MTM,Total net equity,Net Option Value,Net liquidating value,Account Market Value,Total IM,Total MM,Margin Excess/Deficit';

// An account whose figures add up the way Orient's do.
const acct = (name, no, { beginning = 0, cashAdj = 0, commission = 0, fee = 0, gst = 0, pl = 0, foUpl = 0, im = 0, mm = 0 } = {}) => {
  const ending = +(beginning + cashAdj + commission + fee + gst + pl).toFixed(2);
  const equity = +(ending + foUpl).toFixed(2);
  const r = [beginning, cashAdj, commission, fee, gst, pl, 0, 0, ending, foUpl, 0, 0, foUpl, equity, 0, equity, 0, equity, equity, im, mm, +(equity - im).toFixed(2)];
  return [`${name},${no},Base:USD,,,${r.join(',')}`, `${name},${no},USD,1,,${r.join(',')}`];
};
const csv = (...accts) => [HEADER, ...accts.flat()].join('\n');
const read = (text) => readFinancialSummary(Papa.parse(text, { skipEmptyLines: true }).data);

const cashSub = { beginning: 50000 };
const futSub = { beginning: -20000, commission: -12.5, fee: -3.2, gst: -0.25, pl: 640, foUpl: -1500, im: 4200, mm: 3800 };
const total = Object.fromEntries(Object.keys({ ...cashSub, ...futSub }).map((k) => [k, +((cashSub[k] || 0) + (futSub[k] || 0)).toFixed(2)]));
const day1 = csv(acct('TEST TRADER', '200100', total), acct('TEST TRADER-0000', '2001000000', cashSub), acct('TEST TRADER-0011', '2001000011', futSub));

const r = read(day1);
eq('reads cleanly', r.problems, []);
eq('one row per account: the Base line, not the repeated USD line', r.accounts.map((a) => a.no), ['200100', '2001000000', '2001000011']);
eq('base currency is read from "Base:USD"', r.accounts[0].ccy, 'USD');
eq('ten-digit account numbers stay text, not 1E+09', typeof r.accounts[1].no, 'string');
eq('figures are numbers', [r.accounts[2].commission, r.accounts[2].im], [-12.5, 4200]);
eq('a fee is negative and the ending balance still adds up', r.accounts.map(checkAccount).flat(), []);
eq('the main account is the one the others start with', mainAccount(r.accounts).no, '200100');
eq('main = sum of sub-accounts', checkFamily(r.accounts), []);

// Orient's arithmetic going wrong is reported, by name.
{
  const bad = { ...r.accounts[2], tne: r.accounts[2].tne + 1 };
  eq('a total that does not add up is named', checkAccount(bad).map((c) => c.label),
     ['Total net equity = total equity + collateral', 'Net liquidating value = total net equity + net option value']);
  eq('a cent of rounding is not a failure', checkAccount({ ...r.accounts[2], ending: r.accounts[2].ending + 0.01, equity: r.accounts[2].equity + 0.01, tne: r.accounts[2].tne + 0.01, nlv: r.accounts[2].nlv + 0.01, marketValue: r.accounts[2].marketValue, excess: r.accounts[2].excess + 0.01 }), []);
  const fam = [r.accounts[0], r.accounts[1], { ...r.accounts[2], im: 0 }];
  eq('a main account that is not the sum of its subs is named', checkFamily(fam).map((c) => c.label), ['Total IM: main account is not the sum of its sub-accounts']);
}

// Fails loudly rather than guessing.
eq('a missing column stops the read and is named', read(day1.replace('Total IM,', 'Initial Margin,')).problems,
   ['The Financial Summary has no "Total IM" column. Orient may have changed the layout.']);
eq('nothing is read when a column is missing', read(day1.replace('Total IM,', 'Initial Margin,')).accounts, []);
eq('a number with a thousands separator is refused, not misread', read(day1.replace(',50000,', ',"50,000",')).problems.length > 0, true);
eq('a blank figure is refused, not taken as zero', read(day1.replace(',4200,', ',,')).problems[0], 'Row 2, "Total IM": "" is not a plain number.');
eq('columns are found by name, whatever their order', read(day1.split('\n').map((l) => { const c = Papa.parse(l).data[0]; [c[0], c[1]] = [c[1], c[0]]; return Papa.unparse([c]); }).join('\n')).accounts.map((a) => a.no), ['200100', '2001000000', '2001000011']);
eq('a name containing a comma is still one column', read(day1.replaceAll('TEST TRADER-0000,', '"TRADER, TEST-0000",')).accounts[1].name, 'TRADER, TEST-0000');
eq('an empty file says so', read('').problems, ['The Financial Summary is empty.']);
eq('header but no Base rows says so', read(HEADER).problems, ['The Financial Summary has no "Base:" rows to read.']);

// Day to day: today's beginning is yesterday's ending.
{
  const d1 = r.accounts;
  const d2 = d1.map((a) => ({ ...a, beginning: a.ending }));
  eq('balances that carry over show no break', checkCarryOver([{ date: '2026-10-02', accounts: d2 }, { date: '2026-10-01', accounts: d1 }]), []);
  const d3 = d1.map((a) => (a.no === '2001000000' ? { ...a, beginning: a.ending + 500 } : { ...a, beginning: a.ending }));
  eq('a break names the day, the account and the two figures', checkCarryOver([{ date: '2026-10-01', accounts: d1 }, { date: '2026-10-02', accounts: d3 }]),
     [{ date: '2026-10-02', prevDate: '2026-10-01', no: '2001000000', beginning: 50500, prevEnding: 50000 }]);
}

// ---------- Open Position.csv ----------
// Orient's header, exactly as the file has it; made-up lots. One row per lot, account numbers
// with dashes, and an order id that Excel would turn into 8.0674E+12 if it ever got the chance.
const POS_HEADER = 'SettlementDate,TradeEntryID,ExchangeOrderID,Client group account number,Client sub account number,TradeDate,ExchangeMIC,ClearingCode,ContractExpiryMonth,Expiry Date,ValueDate,CallPutFut,StrikePrice,TradePrice,BuySell,Amount,SettPrice,UnrealisedPL,Option value,TradePLCcy,Remark';
const lot = (id, code, month, expiry, side, qty, price, settle) => {
  const upl = +((settle - price) * (side === 'B' ? 1 : -1) * qty * 1000).toFixed(2);
  return `20261001,TT${id},8067430000001,2-00100,2-00100-001-1,20260925,XNYM,${code},${month},${expiry},20260925,F,,${price},${side},${qty},${settle},${upl},,USD,`;
};
const posCsv = [POS_HEADER,
  lot(1, 'BZ', 202612, 20261030, 'S', 1, 70.10, 71.00),
  lot(2, 'BZ', 202612, 20261030, 'S', 1, 70.70, 71.00),
  lot(3, 'CL', 202612, 20261120, 'B', 1, 66.20, 66.50),
  lot(4, 'CL', 202612, 20261120, 'B', 1, 66.40, 66.50)].join('\n');
const readPos = (text) => readOpenPositions(Papa.parse(text, { skipEmptyLines: true }).data);
{
  const { lots, problems } = readPos(posCsv);
  eq('open positions read cleanly', problems, []);
  eq('one entry per lot', lots.length, 4);
  eq('dashes come out of account numbers', [lots[0].account, lots[0].group, plainAccount('1-00305-001-1')], ['2001000011', '200100', '1003050011']);
  eq('the contract size Orient used is read back from its own P/L', impliedSize(lots[0]), 1000);
  const ps = positionsOf(lots);
  eq('lots gather into signed positions, as the PDF shows them', ps.map((p) => [p.label, p.lots, p.avg, p.settle, p.upl, p.size]),
     [['BZ Dec26', -2, 70.4, 71, -1200, 1000], ['CL Dec26', 2, 66.3, 66.5, 400, 1000]]);
  eq('month labels', [monthLabel(202612), monthLabel('202701'), monthLabel('x')], ['Dec26', 'Jan27', 'x']);

  // The two files against each other. Futures sub-account carries the lots; the cash one none.
  const summary = read(csv(
    acct('TEST TRADER', '200100', { beginning: 30000, foUpl: -800, im: 4200 }),
    acct('TEST TRADER-0000', '2001000000', { beginning: 50000 }),
    acct('TEST TRADER-0011', '2001000011', { beginning: -20000, foUpl: -800, im: 4200 }))).accounts;
  eq('positions\' P/L matches the Financial Summary, for every account', checkPositionsAgainstSummary(lots, summary), []);
  const off = summary.map((a) => (a.no === '2001000011' ? { ...a, foUpl: -900 } : a));
  eq('a mismatch names the account', checkPositionsAgainstSummary(lots, off).map((c) => c.label), ['2001000011: "F&O Open Position UPL" is not what the open positions add up to']);
  const bent = lots.map((l, i) => (i === 1 ? { ...l, upl: l.upl * 2 } : l));
  eq('lots that imply different contract sizes are flagged', checkPositionsAgainstSummary(bent, summary).some((c) => /different contract sizes/.test(c.label)), true);
}
eq('no open positions is an answer, not a problem', readPos(POS_HEADER), { lots: [], problems: [] });
eq('a missing column stops the read', readPos(posCsv.replace('SettPrice,', 'Settle,')).problems, ['The Open Position file has no "SettPrice" column. Orient may have changed the layout.']);
eq('a side that is neither B nor S is refused', readPos(posCsv.replace(',70.1,S,', ',70.1,X,')).problems, ['Open Position row 2, "BuySell": "X" is neither B nor S.']);
eq('finds the Open Position file', ['Open Position.csv', 'Financial Summary - 1 - 20261001.csv'].filter(isOpenPosition), ['Open Position.csv']);

eq('finds the Financial Summary among the zip\'s files', ['Open Position.csv', 'Financial Summary - 100305 - 20261001.csv', 'x.pdf'].filter(isFinancialSummary), ['Financial Summary - 100305 - 20261001.csv']);
eq('every Orient column is expected', Object.keys(COLUMNS).length, 25);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
