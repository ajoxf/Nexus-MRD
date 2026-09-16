import { dayKey, endOfDay, addDays, snapshotRows, mergeSnapshot, joinDay, reconstructionDays, buildSeries, valueOf, realizedByDay, winLossByDay, tradedByDay, dayProducts, dailyRows, dailyCsv }
  from '../src/lib/history.js';
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
};

eq('dayKey pads', dayKey(new Date(2026, 2, 3, 9, 5)), '2026-03-03');
eq('endOfDay is the last instant', endOfDay('2026-03-03').getHours()*100+endOfDay('2026-03-03').getMinutes(), 2359);
eq('addDays crosses a month', addDays('2026-02-27', 3), '2026-03-02');
eq('addDays goes back over a year', addDays('2026-01-02', -3), '2025-12-30');

const pf = { accounts: [
  { id: 'orient', TNE: 606970.4, IM: 18900, rows: [
    { lots: 3, product: 'CL Dec26 - CL Jan27 Calendar' },
    { lots: 6, product: 'NG Jan27 - NG Feb27 Calendar' },
    // Short, so it contributes its size rather than cancelling the long above it.
    { lots: -3, product: 'CL Dec26 - CL Jan27 Calendar' },
  ] },
  { id: 'mt5',    TNE: 150000,   IM: 0,     rows: [] },
]};
const rows = snapshotRows(pf, new Date(2026, 8, 12));
eq('snapshot rounds and sums absolute lots, broken down by product', rows,
   [{ d: '2026-09-12', b: 'orient', tne: 606970, im: 18900, lots: 12,
      prod: { 'CL Dec26 - CL Jan27 Calendar': 6, 'NG Jan27 - NG Feb27 Calendar': 6 } },
    { d: '2026-09-12', b: 'mt5',    tne: 150000, im: 0,     lots: 0, prod: {} }]);

eq('a row with no product name is not filed under "undefined"',
   snapshotRows({ accounts: [{ id: 'x', TNE: 1, IM: 0, rows: [{ lots: 5 }] }] }, new Date(2026, 8, 12))[0].prod,
   {});

// The same total moving between products is a different day and must be written.
const reshuffled = rows.map((r) => (r.b === 'orient'
  ? { ...r, prod: { 'CL Dec26 - CL Jan27 Calendar': 12 } } : r));
eq('a reshuffle at the same total still counts as a change',
   mergeSnapshot(mergeSnapshot([], rows), reshuffled).find((r) => r.b === 'orient').prod,
   { 'CL Dec26 - CL Jan27 Calendar': 12 });

// The loop guard: an unchanged day must come back as the very same array.
const h1 = mergeSnapshot([], rows);
eq('first merge stores both rows', h1.length, 2);
const h2 = mergeSnapshot(h1, rows);
eq('unchanged day returns the SAME array (no re-save loop)', h2 === h1, true);
const moved = rows.map(r => r.b === 'orient' ? { ...r, tne: 600000 } : r);
const h3 = mergeSnapshot(h1, moved);
eq('a changed figure does write', h3 === h1, false);
eq('today is replaced, not appended', h3.length, 2);
eq('replaced value', h3.find(r => r.b === 'orient').tne, 600000);

const older = [{ d: '2026-09-10', b: 'orient', tne: 1, im: 1, lots: 1 }];
const h4 = mergeSnapshot(older, rows);
eq('older days are kept', h4.length, 3);
eq('history stays in date order', h4.map(r => r.d), ['2026-09-10', '2026-09-12', '2026-09-12']);
eq('joinDay is the earliest recorded day', joinDay(h4), '2026-09-10');
const aged = [{ d: '2020-01-01', b: 'orient', tne: 1, im: 1, lots: 1 }];
eq('rows past the keep window are dropped', mergeSnapshot(aged, rows).length, 2);

const fills = [
  { ts: '2026-09-01T10:00:00Z', is_leg: false },
  { ts: '2026-09-04T10:00:00Z', is_leg: false },
  { ts: '2026-09-02T10:00:00Z', is_leg: true },   // a spread leg is not a trade
];
eq('reconstruction runs first fill → day before the record starts',
   reconstructionDays(fills, [{ d: '2026-09-04', b: 'a', tne: 0, im: 0, lots: 0 }], '2026-09-06'),
   ['2026-09-01', '2026-09-02', '2026-09-03']);
eq('with nothing recorded it runs to today',
   reconstructionDays(fills, [], '2026-09-03'), ['2026-09-01', '2026-09-02', '2026-09-03']);
eq('no fills, no reconstruction', reconstructionDays([], [], '2026-09-03'), []);
eq('record already covers everything', reconstructionDays(fills, [{ d: '2026-09-01', b: 'a' }], '2026-09-06'), []);

// 400 days of span, capped at 180 points, must still end exactly on the last day.
const long = [{ ts: new Date(2025, 0, 1).toISOString(), is_leg: false }];
const days = reconstructionDays(long, [], '2026-02-04', 180);
eq('long span is capped', days.length <= 181, true);
eq('and still ends on the last day', days[days.length - 1], '2026-02-04');
eq('and still starts on the first', days[0], '2025-01-01');

const built = buildSeries({
  reconstructed: [{ d: '2026-09-01', byBroker: { orient: { tne: 100, im: 50, lots: 2 } } }],
  history: [{ d: '2026-09-02', b: 'orient', tne: 120, im: 60, lots: 3 }],
  brokers: [{ id: 'orient', name: 'Orient' }, { id: 'mt5', name: 'MT5' }],
});
eq('both halves land on one axis', built.days, ['2026-09-01', '2026-09-02']);
eq('the join is the first recorded day', built.join, '2026-09-02');
eq('rebuilt points are flagged', built.lines[0].points.map(p => p.recorded), [false, true]);
eq('an account with no data draws nothing', built.lines[1].points.length, 0);
eq('ratio is derived, not stored', valueOf({ tne: 120, im: 60 }, 'ratio'), 2);
eq('a flat account has no ratio at all', valueOf({ tne: 120, im: 0 }, 'ratio'), null);


// ---- realized money, day by day ----
const closed = [
  { closeTs: '2026-09-01T10:00:00', broker: 'orient', pnl: 800, product: 'CL' },
  { closeTs: '2026-09-01T15:00:00', broker: 'orient', pnl: -300, product: 'NG' },
  { closeTs: '2026-09-03T11:00:00', broker: 'mt5', pnl: 250, product: 'CL' },
  { closeTs: '2026-09-04T09:00:00', broker: 'orient', pnl: 200, product: 'CL' },
];
const days4 = ['2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04'];
const r = realizedByDay(closed, days4);
eq('day one nets the two trades that closed on it', r.get('2026-09-01'), { orient: 500 });
eq('a quiet day carries the running total forward', r.get('2026-09-02'), { orient: 500 });
eq('a second broker appears only once it has closed something',
   r.get('2026-09-03'), { orient: 500, mt5: 250 });
eq('and the totals accumulate', r.get('2026-09-04'), { orient: 700, mt5: 250 });
eq('nothing closed, nothing claimed', realizedByDay([], days4).get('2026-09-04'), {});

// ---- winners and losers per day ----
const wl = winLossByDay([
  ...closed,
  { closeTs: '2026-09-04T12:00:00', broker: 'orient', pnl: 0, product: 'CL' },
]);
eq('one row per day that had a close', wl.map((x) => x.d), ['2026-09-01', '2026-09-03', '2026-09-04']);
eq('a day with one of each', wl[0], { d: '2026-09-01', wins: 1, losses: 1, flat: 0, net: 500, won: 800, lost: 300 });
eq('a scratch counts as neither a win nor a loss',
   wl[2], { d: '2026-09-04', wins: 1, losses: 0, flat: 1, net: 200, won: 200, lost: 0 });
eq('a trade with no close date is not a day', winLossByDay([{ pnl: 5 }]).length, 0);


// ---- lots traded per day ----
const F = (ts, qty, product, extra = {}) => ({ ts, qty, product, broker: 'orient', ...extra });
const tfills = [
  F('2026-09-01T09:00:00', 5, 'CL'),            // bought 5
  F('2026-09-01T15:00:00', 5, 'CL'),            // sold them again
  F('2026-09-01T16:00:00', 3, 'NG'),
  F('2026-09-02T09:00:00', 4, 'CL', { is_leg: true }),   // a spread leg: the spread is the trade
  F('2026-09-03T09:00:00', 2, 'CL', { broker: 'mt5' }),
];
const t = tradedByDay(tfills);
eq('a round turn counts both sides', t.get('2026-09-01').prod.CL, 10);
eq('and each product keeps its own tally', t.get('2026-09-01').prod.NG, 3);
eq('the day totals across products', t.get('2026-09-01').total, 13);
eq('a spread leg is not volume of its own', t.has('2026-09-02'), false);
eq('another broker still counts when no filter is given', t.get('2026-09-03').total, 2);
eq('scoping to one broker drops the others',
   [...tradedByDay(tfills, ['orient']).keys()], ['2026-09-01', '2026-09-03'].filter((d) => d !== '2026-09-03'));
eq('scoping to the other broker keeps only its day',
   [...tradedByDay(tfills, ['mt5']).keys()], ['2026-09-03']);
eq('a fill with no product is not counted', tradedByDay([F('2026-09-05T09:00:00', 5, undefined)]).size, 0);
eq('a zero-quantity fill is not a trade', tradedByDay([F('2026-09-05T09:00:00', 0, 'CL')]).size, 0);
eq('a sell recorded as a negative quantity still counts its size',
   tradedByDay([F('2026-09-05T09:00:00', -4, 'CL')]).get('2026-09-05').total, 4);


/*
 * Money alongside the counts. A chart sized by one and captioned with the other misleads,
 * so both have to be right and both have to reconcile: won less lost IS net, always.
 */
const money = winLossByDay([
  { closeTs: '2026-09-10T12:00:00Z', pnl: 1000 },
  { closeTs: '2026-09-10T13:00:00Z', pnl: -250 },
  { closeTs: '2026-09-10T14:00:00Z', pnl: -50 },
  { closeTs: '2026-09-10T15:00:00Z', pnl: 0 },
])[0];
eq('winnings are summed', money.won, 1000);
eq('losses are summed as a positive magnitude', money.lost, 300);
eq('won less lost is the net', money.won - money.lost, money.net);
eq('a scratch adds to neither', [money.wins, money.losses, money.flat], [1, 2, 1]);
// Twenty small losses and six big ones: the count says one day was far worse, the money says
// they were the same. This is the reason the chart needs to be able to show either.
// 20 x $200 = $4,000 against 6 x $1,000 = $6,000: three times the trades, less of the money.
const many = winLossByDay(Array.from({ length: 20 }, () => ({ closeTs: '2026-09-11T12:00:00Z', pnl: -200 })))[0];
const few = winLossByDay(Array.from({ length: 6 }, () => ({ closeTs: '2026-09-12T12:00:00Z', pnl: -1000 })))[0];
eq('more trades does not mean more money lost', [many.losses > few.losses, many.lost < few.lost], [true, true]);


/*
 * --- what a day was made of ---
 *
 * Aug 24 on the reported book: 20 trades, 6 won, 12 lost, and a net of -$300. Nearly flat
 * on the day, and made of one product paying for another — which the daily row alone
 * cannot show and is the reason the row opens.
 */
const mixed = dayProducts([
  { closeTs: '2026-08-24T12:00:00Z', broker: 'o', product: 'CL', qty: 2, pnl: -5000 },
  { closeTs: '2026-08-24T13:00:00Z', broker: 'o', product: 'CL', qty: 1, pnl: -1200 },
  { closeTs: '2026-08-24T14:00:00Z', broker: 'o', product: 'HO', qty: 3, pnl: 5900 },
  { closeTs: '2026-08-24T15:00:00Z', broker: 'o', product: 'HO', qty: 1, pnl: 0 },
]).get('2026-08-24');
// CL lost $6,200 and HO made $5,900, so CL is the bigger mover and leads — ordering is by
// the size of the move, not by its sign and not by the name.
eq('a day breaks into its products', mixed.map((r) => r.product), ['CL', 'HO']);
eq('biggest mover first, whichever way it moved', mixed[0].product, 'CL');
eq('the products net to the day', mixed.reduce((a, r) => a + r.net, 0), -300);
eq('lots closed are summed', mixed.map((r) => r.lots), [3, 4]);
eq('wins and losses are counted per product', mixed.map((r) => [r.wins, r.losses, r.flat]), [[0, 2, 0], [1, 0, 1]]);
eq('and the trade counts add up to the day', mixed.reduce((a, r) => a + r.trades, 0), 4);

// A losing product can be the biggest mover; ordering is by size, not by sign.
const worst = dayProducts([
  { closeTs: '2026-08-25T12:00:00Z', broker: 'o', product: 'A', qty: 1, pnl: 100 },
  { closeTs: '2026-08-25T13:00:00Z', broker: 'o', product: 'B', qty: 1, pnl: -9000 },
]).get('2026-08-25');
eq('the biggest loser leads when it is the biggest move', worst[0].product, 'B');

/*
 * Two accounts, one symbol. Never merged: they are two positions carrying two margins that
 * no broker will net, so one line would name a position the trader does not hold.
 */
const twoAccounts = dayProducts([
  { closeTs: '2026-08-26T12:00:00Z', broker: 'mt5-a', product: 'USOIL', qty: 1, pnl: 500 },
  { closeTs: '2026-08-26T13:00:00Z', broker: 'mt5-b', product: 'USOIL', qty: 1, pnl: -200 },
]).get('2026-08-26');
eq('the same symbol in two accounts stays two lines', twoAccounts.length, 2);
eq('each naming its account', twoAccounts.map((r) => r.broker).sort(), ['mt5-a', 'mt5-b']);

// --- nothing to break on ---
eq('no closed trades, no days', dayProducts([]).size, 0);
eq('undefined is the same as none', dayProducts(undefined).size, 0);
eq('a trade with no close date belongs to no day', dayProducts([{ product: 'X', qty: 1, pnl: 5 }]).size, 0);
// A sell stored as a negative quantity is still size, exactly as tradedByDay treats it.
eq('a negative quantity still counts as size',
  dayProducts([{ closeTs: '2026-08-27T12:00:00Z', broker: 'o', product: 'X', qty: -2, pnl: 5 }]).get('2026-08-27')[0].lots, 2);

// --- it must agree with the daily row it opens from, on the same trades ---
const sameTrades = [
  { closeTs: '2026-08-28T12:00:00Z', broker: 'o', product: 'A', qty: 1, pnl: 700 },
  { closeTs: '2026-08-28T13:00:00Z', broker: 'o', product: 'B', qty: 2, pnl: -250 },
  { closeTs: '2026-08-28T14:00:00Z', broker: 'o', product: 'A', qty: 1, pnl: 0 },
];
const dayRow = winLossByDay(sameTrades)[0];
const parts = dayProducts(sameTrades).get('2026-08-28');
eq('the parts net to the whole', parts.reduce((a, r) => a + r.net, 0), dayRow.net);
eq('the wins agree', parts.reduce((a, r) => a + r.wins, 0), dayRow.wins);
eq('the losses agree', parts.reduce((a, r) => a + r.losses, 0), dayRow.losses);
eq('the scratches agree', parts.reduce((a, r) => a + r.flat, 0), dayRow.flat);


/*
 * --- the daily table, and the CSV of it ---
 *
 * The file is the one that gets sent to an accountant, and nobody re-checks it against a
 * screen they have closed. So it has to be the same numbers, in an order that makes the
 * running total mean something, with nothing lost to a comma in a product name.
 */
const bookTrades = [
  { closeTs: '2026-08-24T12:00:00Z', broker: 'o', product: 'CL', qty: 2, pnl: -5000 },
  { closeTs: '2026-08-24T13:00:00Z', broker: 'o', product: 'HO', qty: 3, pnl: 4700 },
  { closeTs: '2026-08-24T14:00:00Z', broker: 'o', product: 'HO', qty: 1, pnl: 0 },
  { closeTs: '2026-08-25T12:00:00Z', broker: 'm', product: 'CL, spread', qty: 1, pnl: 120.005 },
];
const daily = dailyRows(bookTrades);
eq('one row per trading day', daily.map((r) => r.d), ['2026-08-24', '2026-08-25']);
eq('trades counts scratches too', daily[0].trades, 3);
eq('the running total accumulates in date order', daily.map((r) => Math.round(r.run * 100) / 100), [-300, -179.99]);
eq('and the last running total is the book', Math.round(daily[1].run * 100) / 100,
   Math.round(bookTrades.reduce((a, t) => a + t.pnl, 0) * 100) / 100);

const csv = dailyCsv(bookTrades, (id) => (id === 'o' ? 'Orient' : 'MT5'));
const lines = csv.split('\n');
eq('a header, two days and three product rows', lines.length, 1 + 2 + 3);
eq('the header names every column', lines[0],
   'Date,Scope,Broker,Product,Trades,Lots,Won,Lost,Scratched,P&L,Running');
eq('day rows are marked as such', lines[1].split(',')[1], 'Day');
eq('a day names no product', lines[1].split(',').slice(2, 4), ['', '']);
eq('the day carries its running total', lines[1].split(',')[10], '-300');
eq('product rows name their broker', lines[2].split(',')[2], 'Orient');
eq('a product carries no running total', lines[2].split(',')[10], '');

// A comma in a product name must not become a column break.
const spreadLine = lines.find((l) => l.includes('spread'));
eq('a product with a comma is quoted', spreadLine.includes('"CL, spread"'), true);
eq('so the row still has eleven columns', spreadLine.match(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/g).length, 10);

// Money is rounded like money, not left at floating-point length.
eq('P&L is rounded to the cent', lines[lines.length - 1].split(',').slice(-2)[0], '120.01');

// Oldest first regardless, because Running only reads forwards.
eq('the file is chronological', [lines[1].split(',')[0], lines[4].split(',')[0]], ['2026-08-24', '2026-08-25']);

// The parts must still net to the day, in the file as on the screen.
const dayNet = Number(lines[1].split(',')[9]);
const prodNet = [lines[2], lines[3]].reduce((a, l) => a + Number(l.split(',')[9]), 0);
eq('the product rows net to their day', prodNet, dayNet);

// Nothing to export is a header and nothing else, not a crash.
eq('an empty book is just the header', dailyCsv([]).split('\n').length, 1);
eq('and no rows', dailyRows([]), []);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
