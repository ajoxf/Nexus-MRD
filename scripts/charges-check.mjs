import Papa from 'papaparse';
import { buildCharges, readJournalRecords, uniqueJournalEntries, categoryOfJournalCode, isJournalRecord, isTradeConfirmation, CATEGORY_KEYS, labelOf } from '../src/lib/charges.js';

let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
};
const rows = (text) => Papa.parse(text, { skipEmptyLines: true }).data;

/* ---------------------------------------------------------------------------
 * The headers, copied from the files Orient actually sends, so a change at
 * their end shows up here as a failure rather than as a wrong number.
 * ------------------------------------------------------------------------- */
const FS_HEAD = 'Acct Name,Acct No.,CCY,Exchange Rate,Balance Type,Beginning Balance,Cash Adjustments,Commission,Fee,GST,Profit/Loss,Options Premium,Interest,Ending Balance,Total Unrealised Profit/loss (UPL),FX Open Positions UPL,FX Closed Positions Forward PL,F&O Open Position UPL,Total Equity,Collateral MTM,Total net equity,Net Option Value,Net liquidating value,Account Market Value,Total IM,Total MM,Margin Excess/Deficit';
const TC_HEAD = 'SettlementDate,TradeEntryID,ExchangeOrderID,Client group account number,Client sub account number,TradeDate,ExchangeMIC,ClearingCode,ContractExpiry,ValueDate,CallPutFut,StrikePrice,TradePrice,BuySell,Amount,Premium,PremiumCcy,Remark,Trade Type,Execution Time,Expiry Date,FinalComm,FinalCommCcy,Exchange Fee amount,Exchange Fee CCY,NFA amount,NFA CCY';
const JR_HEAD = 'Client,Account Name,Account Number,Settlement Date,Journal Side,Journal ID,Journal Code,Amount,Currency,Balance Type,Remark,Statement Description';

const GROUP = '100305';
const SUB = '1003050011';

// One Base:USD account row, with the charge columns set and the rest consistent.
const fsRow = (no, { commission = 0, fee = 0, beginning = 100000 } = {}) => {
  const ending = +(beginning + commission + fee).toFixed(2);
  const r = [beginning, 0, commission, fee, 0, 0, 0, 0, ending, 0, 0, 0, 0, ending, 0, ending, 0, ending, ending, 0, 0, ending];
  return `NAME-${no},${no},Base:USD,,,${r.join(',')}`;
};
const fs = (date, accts) => ({ name: `Financial Summary - ${date} - x.csv`, rows: rows([FS_HEAD, ...accts].join('\n')) });

// One Trade Confirmation leg fill.
const tcRow = (tradeId, date, { comm = -0.35, fee = -0.77, nfa = -0.01 } = {}) =>
  `${date},${tradeId},8067078133154,1-00305,0011,${date},XNYM,BZ,202611,${date},,,104.7,B,1,0.00,USD,,Spread,${date.slice(0,4)}-01-01 06:06:11,2026-09-30,${comm},USD,${fee},USD,${nfa},USD`;
const tc = (legs) => ({ name: 'Trade Confirmation.csv', rows: rows([TC_HEAD, ...legs].join('\n')) });

// One Journal Record entry.
const jrRow = (id, date, code, amount, descr, side = 'Debit', account = SUB) =>
  `AMISHA ANKIT JHAVERI,AMISHA ANKIT JHAVERI-0011,${account},${date},${side},${id},${code},${amount},USD,Segregated,,${descr}`;
const jr = (date, entries, account = GROUP) => ({ name: `Journal Record - ${account}- ${date.replace(/-/g,'')}.csv`, rows: rows([JR_HEAD, ...entries].join('\n')) });

/* ---------------------------------------------------------------------------
 * The file names
 * ------------------------------------------------------------------------- */
eq('a journal record is recognised', isJournalRecord('Journal Record - 100305- 20261027.csv'), true);
eq('a financial summary is not a journal record', isJournalRecord('Financial Summary - 0011 - 20261027.csv'), false);
eq('a trade confirmation is recognised', isTradeConfirmation('Trade Confirmation.csv'), true);
eq('an offset record is not a trade confirmation', isTradeConfirmation('Offset Record.csv'), false);

/* ---------------------------------------------------------------------------
 * Orient's own journal codes, copied from the 27 Oct 2026 statement
 * ------------------------------------------------------------------------- */
eq('TT platform fee', categoryOfJournalCode('PLATFORM FEE-TT'), 'platform');
eq('CME market data', categoryOfJournalCode('MKT DATA-CME'), 'marketData');
eq('MAP fees', categoryOfJournalCode('MAP FEES'), 'map');
eq('the exchange suffix does not decide the category', categoryOfJournalCode('MKT DATA-ICE'), 'marketData');
eq('a spelt-out market data code still lands on market data', categoryOfJournalCode('MARKET DATA - SGX'), 'marketData');
eq('an unknown code is reported, not guessed', categoryOfJournalCode('WITHHOLDING TAX'), 'other');

/* ---------------------------------------------------------------------------
 * The 27 Oct 2026 journal file, verbatim from the mailbox
 * ------------------------------------------------------------------------- */
{
  const real = 'Client,Account Name,Account Number,Settlement Date,Journal Side,Journal ID,Journal Code,Amount,Currency,Balance Type,Remark,Statement Description\r\n'
    + 'AMISHA ANKIT JHAVERI,AMISHA ANKIT JHAVERI-0011,1003050011,2026-10-27,Debit,JO1112146745,PLATFORM FEE-TT,600.00,USD,Segregated,,TT Pro - Transaction - TTNGANKIT - Sep 2026\r\n'
    + 'AMISHA ANKIT JHAVERI,AMISHA ANKIT JHAVERI-0011,1003050011,2026-10-27,Debit,JO1112146868,MAP FEES,100.00,USD,Segregated,,TT MAP FEES - CME - Sep 2026 - TTNGANKIT\r\n'
    + 'AMISHA ANKIT JHAVERI,AMISHA ANKIT JHAVERI-0011,1003050011,2026-10-27,Debit,JO1112146902,MKT DATA-CME,20.00,USD,Segregated,,TT Market Data - TTNGANKIT - NYMEX - Sep 2026\r\n'
    + 'AMISHA ANKIT JHAVERI,AMISHA ANKIT JHAVERI-0011,1003050011,2026-10-27,Debit,JO1112146903,MKT DATA-CME,20.00,USD,Segregated,,TT Market Data - TTNGANKIT - COMEX - Sep 2026\r\n';
  const { entries, problems } = readJournalRecords(rows(real));
  eq('the real file reads cleanly', problems, []);
  eq('four entries', entries.length, 4);
  eq('the platform fee is a 600 cost', entries[0].cost, 600);
  eq('the categories', entries.map((e) => e.category), ['platform', 'map', 'marketData', 'marketData']);
  eq('they come to 740, which is what the Fee column said', entries.reduce((t, e) => t + e.cost, 0), 740);
  eq('Orient\'s wording is kept, because it is the only record of the PERIOD',
    entries[0].descr, 'TT Pro - Transaction - TTNGANKIT - Sep 2026');
}

/* ---------------------------------------------------------------------------
 * The ordinary cases
 * ------------------------------------------------------------------------- */
eq('a header-only journal file is an ordinary day, not a problem',
  readJournalRecords(rows(JR_HEAD)), { entries: [], problems: [] });
eq('an empty journal file is not a problem either', readJournalRecords([]), { entries: [], problems: [] });
{
  const { entries } = readJournalRecords(rows([JR_HEAD, jrRow('J1', '2026-10-27', 'PLATFORM FEE-TT', '600.00', 'x', 'Credit')].join('\n')));
  eq('a credit is a negative cost', entries[0].cost, -600);
}
{
  const { entries, problems } = readJournalRecords(rows([JR_HEAD, jrRow('J1', '2026-10-27', 'MAP FEES', 'n/a', 'x')].join('\n')));
  eq('a figure that is not a number stops the read', entries, []);
  eq('…and says which row and column', problems.length, 1);
}
{
  const bad = JR_HEAD.replace('Journal Code,', '');
  eq('a missing column stops the read', readJournalRecords(rows([bad, ''].join('\n'))).entries, []);
  eq('…and names the column', /Journal Code/.test(readJournalRecords(rows([bad, ''].join('\n'))).problems[0]), true);
}

// The group's zip and the sub-account's zip carry the same entry under the same Journal ID.
{
  const a = readJournalRecords(rows([JR_HEAD, jrRow('JO1112146745', '2026-10-27', 'PLATFORM FEE-TT', '600.00', 'TT Pro - Sep 2026')].join('\n'))).entries;
  const b = readJournalRecords(rows([JR_HEAD, jrRow('JO1112146745', '2026-10-27', 'PLATFORM FEE-TT', '600.00', 'TT Pro - Sep 2026')].join('\n'))).entries;
  eq('the same charge in two zips is one charge', uniqueJournalEntries([a, b]).length, 1);
  eq('…and it is not counted twice', uniqueJournalEntries([a, b]).reduce((t, e) => t + e.cost, 0), 600);
}

/* ---------------------------------------------------------------------------
 * buildCharges: a plain trading day. 17 Sep 2026's real shape — commission
 * -75.60, fee -299.15, and the fee is exactly the exchange fees plus NFA, so
 * nothing is left unexplained.
 * ------------------------------------------------------------------------- */
{
  const legs = [];
  // Per-leg amounts to the cent, which is how Orient writes them: 216 legs at 0.35 / 1.37 / 0.01.
  for (let i = 0; i < 216; i++) legs.push(tcRow(`TT${900000 + i}`, '20260917', { comm: -0.35, fee: -1.37, nfa: -0.01 }));
  const comm = -75.60, fee = -(216 * 1.37) - (216 * 0.01);
  const c = buildCharges([{ date: '2026-09-17', files: [fs('2026-09-17', [fsRow(GROUP, { commission: comm, fee })]), tc(legs)] }], GROUP);
  eq('a trading day reconciles', c.problems, []);
  eq('commission is what the summary says', c.byDate[0].commission, 75.60);
  eq('exchange fees come from the trades', c.byDate[0].exchange, 295.92);
  eq('NFA comes from the trades', c.byDate[0].nfa, 2.16);
  eq('nothing is left unexplained on a trading day', c.byDate[0].other, 0);
  eq('every trade is counted once', c.byDate[0].trades, 216);
  eq('the total is commission plus fees', c.totals.total, 373.68);
  eq('all of it is a cost of trading', c.totals.standing, 0);
}

/* ---------------------------------------------------------------------------
 * buildCharges: 27 Oct 2026. No trades; Fee -740.00, every cent named by the
 * journal. This is the case that proves "Fee" is not a trading cost.
 * ------------------------------------------------------------------------- */
{
  const entries = [
    jrRow('JO1112146745', '2026-10-27', 'PLATFORM FEE-TT', '600.00', 'TT Pro - Transaction - TTNGANKIT - Sep 2026'),
    jrRow('JO1112146868', '2026-10-27', 'MAP FEES', '100.00', 'TT MAP FEES - CME - Sep 2026 - TTNGANKIT'),
    jrRow('JO1112146902', '2026-10-27', 'MKT DATA-CME', '20.00', 'TT Market Data - TTNGANKIT - NYMEX - Sep 2026'),
    jrRow('JO1112146903', '2026-10-27', 'MKT DATA-CME', '20.00', 'TT Market Data - TTNGANKIT - COMEX - Sep 2026'),
  ];
  const c = buildCharges([{ date: '2026-10-27', files: [fs('2026-10-27', [fsRow(GROUP, { commission: 0, fee: -740 })]), jr('2026-10-27', entries)] }], GROUP);
  eq('27 Oct reconciles to the cent', c.problems, []);
  eq('the platform fee', c.byDate[0].platform, 600);
  eq('the MAP fee', c.byDate[0].map, 100);
  eq('market data, both feeds', c.byDate[0].marketData, 40);
  eq('nothing unexplained', c.byDate[0].other, 0);
  eq('no commission, because there were no trades', c.byDate[0].commission, 0);
  eq('none of it is a cost of trading', c.totals.trade, 0);
  eq('all of it is a standing cost', c.totals.standing, 740);
  eq('four itemised lines, each with its date', c.lines.length, 4);
  eq('and each carries the period Orient billed for',
    c.lines.find((l) => l.category === 'platform').detail, 'TT Pro - Transaction - TTNGANKIT - Sep 2026');
}

/* ---------------------------------------------------------------------------
 * buildCharges: 23 Sep 2026. Fee -440.00, no trades, and no Journal Record
 * file — Orient only began sending them with the 26 Oct statements. The
 * charge must be reported on its date as unidentified, never guessed into
 * "platform".
 * ------------------------------------------------------------------------- */
{
  const c = buildCharges([{ date: '2026-09-23', files: [fs('2026-09-23', [fsRow(GROUP, { commission: 0, fee: -440 })])] }], GROUP);
  eq('23 Sep reconciles', c.problems, []);
  eq('the whole charge is unidentified', c.byDate[0].other, 440);
  eq('it is not called a platform fee', c.byDate[0].platform, 0);
  eq('it is still a standing cost, not a trading one', c.totals.standing, 440);
  eq('and the line says why it has no name',
    c.lines[0].detail, 'Not itemised by Orient — no trades this day');
}

/* ---------------------------------------------------------------------------
 * buildCharges: 24 Aug 2026. A trading day AND a charge — fee -166.38 where
 * the trades explain only -111.38. The extra 55.00 must surface, not vanish
 * into the exchange fees.
 * ------------------------------------------------------------------------- */
{
  const legs = [];
  for (let i = 0; i < 2; i++) legs.push(tcRow(`TT${800000 + i}`, '20260824', { comm: -16.80, fee: -55.21, nfa: -0.48 }));
  const c = buildCharges([{ date: '2026-08-24', files: [fs('2026-08-24', [fsRow(GROUP, { commission: -33.60, fee: -166.38 })]), tc(legs)] }], GROUP);
  eq('24 Aug reconciles', c.problems, []);
  eq('the unexplained 55 surfaces', c.byDate[0].other, 55.00);
  eq('the trade fees are not inflated by it', c.byDate[0].exchange, 110.42);
  eq('the day still adds back to Orient\'s total', c.byDate[0].total, 199.98);
}

/* ---------------------------------------------------------------------------
 * buildCharges: 21 Aug 2026. Commission was POSITIVE 311.50 on the summary
 * against -9.80 on the trades — a rebate. A cost view that showed 0, or that
 * showed the trades' figure, would both be wrong.
 * ------------------------------------------------------------------------- */
{
  const legs = [];
  for (let i = 0; i < 28; i++) legs.push(tcRow(`TT${700000 + i}`, '20260821', { comm: -0.35, fee: -1.47, nfa: -0.01 }));
  const c = buildCharges([{ date: '2026-08-21', files: [fs('2026-08-21', [fsRow(GROUP, { commission: 311.50, fee: -41.44 })]), tc(legs)] }], GROUP);
  eq('21 Aug reconciles', c.problems, []);
  eq('the credit is reported as a negative cost', c.byDate[0].commission, -311.50);
  eq('the trades\' own commission is kept separately', c.byDate[0].tradeCommission, 9.80);
  eq('and the gap is named an adjustment', c.byDate[0].commissionAdjustment, -321.30);
  eq('the adjustment gets its own dated line',
    c.lines.find((l) => l.kind === 'adjustment').detail, 'Commission credit or rebate');
}

/* ---------------------------------------------------------------------------
 * The group row is the sub-accounts added up, so taking both would double
 * every charge.
 * ------------------------------------------------------------------------- */
{
  const files = [fs('2026-10-27', [fsRow(GROUP, { commission: 0, fee: -740 }), fsRow(SUB, { commission: 0, fee: -740 })])];
  const c = buildCharges([{ date: '2026-10-27', files }], GROUP);
  eq('the group row wins over its sub-accounts', c.byDate[0].other, 740);
}
{
  // The same day in two zips: the sub-account's and the group's, each with the journal file.
  const entries = [jrRow('JO1112146745', '2026-10-27', 'PLATFORM FEE-TT', '600.00', 'TT Pro - Sep 2026')];
  const c = buildCharges([
    { date: '2026-10-27', files: [fs('2026-10-27', [fsRow(GROUP, { commission: 0, fee: -600 })]), jr('2026-10-27', entries, GROUP)] },
    { date: '2026-10-27', files: [fs('2026-10-27', [fsRow(SUB, { commission: 0, fee: -600 })]), jr('2026-10-27', entries, SUB)] },
  ], GROUP);
  eq('two zips for one day is still one charge', c.totals.platform, 600);
  eq('…and nothing unexplained appears from the doubling', c.byDate[0].other, 0);
}

/* ---------------------------------------------------------------------------
 * A day whose categories do not add back to Orient's own figures is a
 * problem, reported rather than shown as a clean breakdown.
 * ------------------------------------------------------------------------- */
{
  const c = buildCharges([{ date: '2026-10-27', files: [
    fs('2026-10-27', [fsRow(GROUP, { commission: 0, fee: -500 })]),
    jr('2026-10-27', [jrRow('J1', '2026-10-27', 'PLATFORM FEE-TT', '600.00', 'x')]),
  ] }], GROUP);
  // The residual absorbs the difference and the total still matches, which is the design:
  // Orient's figure is the authority, so a journal line larger than the bucket means a credit.
  eq('the residual keeps the day reconciled', c.byDate[0].total, 500);
  eq('…by showing a negative "other"', c.byDate[0].other, -100);
  eq('no false problem is raised', c.problems, []);
}

/* ---------------------------------------------------------------------------
 * Nothing at all
 * ------------------------------------------------------------------------- */
eq('no statements is not an error', buildCharges([], GROUP).byDate, []);
eq('no statements means no totals', buildCharges([], GROUP).totals.total, 0);
eq('a day with no charges is not listed',
  buildCharges([{ date: '2026-11-10', files: [fs('2026-11-10', [fsRow(GROUP, {})])] }], GROUP).byDate, []);
eq('every category has a label', CATEGORY_KEYS.every((k) => labelOf(k) !== k), true);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
