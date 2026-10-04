import { fundingFor, replayCsv, shortName, bankrollFor, drawdowns, addsToLosers, checkRules, replay, tradingDaysBetween, RISK_DEFAULTS } from '../src/lib/riskRules.js';

/*
 * The risk guardrails, worked by hand on a made-up account shaped like a real run: a good start,
 * margin creeping up, a losing short added to, a bad day, a margin call met with a deposit.
 */
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
};

// ---------- the account, day by day ----------
const c = (date, cash, equity, im, upl, excess = equity - im) => ({ date, cash, equity, im, upl, excess });
const closes = [
  c('2026-08-03', 100000, 100000, 0, 0),        // opened with 100k
  c('2026-08-04', 0, 104000, 20000, 0),          // +4k, margin 19%
  c('2026-08-05', 0, 110000, 50000, -1000),      // +6k (the peak), margin 45%
  c('2026-08-06', 0, 104500, 60000, -9000),      // −5.5k, margin 57%
  c('2026-08-07', 0, 92000, 95000, -21000),      // −12.5k: 16% off the peak, a deficit
  c('2026-08-10', 20000, 105000, 40000, -2000),  // a 20k deposit after the call; trading −7k
];

// ---------- bankroll and drawdown ----------
const b = bankrollFor(closes, '2026-08-10');
is('bankroll: the first statement\'s money, plus deposits since', [b.amount, b.from], [120000, 'first statement']);
is('…next month: equity at the last close of this one', bankrollFor(closes, '2026-09-01').amount, 105000);
const dd = drawdowns(closes);
is('drawdown is trading only: deposits are not gains', dd.map((x) => x.perf), [0, 4000, 10000, 4500, -8000, -15000]);
is('statements that start mid-life: the first equity is capital, not profit', drawdowns([{ date: '2026-08-03', equity: 50000, cash: 0 }, { date: '2026-08-04', equity: 51000, cash: 0 }]).map((x) => x.perf), [0, 1000]);
is('…measured from the peak, against the capital at the peak', [dd[4].peakDate, +dd[4].ddPct.toFixed(1)], ['2026-08-05', 16.4]);

// ---------- adding to a loser ----------
const f = (ts, side, price, product = 'Oct26 HO-CL Crack') => ({ ts, broker: 'o', product, side, qty: 1, price });
const crack = [f('2026-08-05T09:00:00Z', 'Sell', 90), f('2026-08-05T10:00:00Z', 'Sell', 90.05), f('2026-08-06T09:00:00Z', 'Sell', 92), f('2026-08-06T11:00:00Z', 'Sell', 93), f('2026-08-07T09:00:00Z', 'Buy', 95)];
const adds = addsToLosers(crack, { minLoss: 500 });
is('selling more of a short that is $500+ under water is averaging a loser; a 5-cent add is not', adds.map((x) => [x.ts.slice(0, 10), x.price, x.held, x.openLoss]), [['2026-08-06', 92, -2, 3950], ['2026-08-06', 93, -3, 6950]]);
is('buying back is not adding', addsToLosers([...crack, f('2026-08-07T10:00:00Z', 'Buy', 96)], { minLoss: 500 }).length, 2);
is('a long bought lower is the same thing', addsToLosers([f('2026-08-05T09:00:00Z', 'Buy', 80, 'CL Nov26'), f('2026-08-05T10:00:00Z', 'Buy', 79, 'CL Nov26')]).map((x) => x.openLoss), [1000]);
is('legs of a spread trade are not trades', addsToLosers([{ ...f('2026-08-05T09:00:00Z', 'Buy', 80, 'CL Nov26'), is_leg: true }, { ...f('2026-08-05T10:00:00Z', 'Buy', 79, 'CL Nov26'), is_leg: true }]).length, 0);

// ---------- the replay ----------
const r = replay(closes, crack);
const ids = (date) => r.days.find((d) => d.date === date).flags.map((x) => x.id);
is('5 Aug: TNE / IM 220% — above the 200% floor, nothing to say', ids('2026-08-05'), []);
is('6 Aug: margin 57%, adding to the losing short, 9k open loss, a 5.5k day, 5% off the peak', ids('2026-08-06'), ['margin', 'adds', 'bookloss', 'day', 'ddwarn']);
is('7 Aug: everything, and go flat', ids('2026-08-07'), ['margin', 'bookloss', 'day', 'ddflat', 'call']);
const d6 = r.days[3].checks;
is('each replay day carries every rule\'s figure and its limit', [d6.bankroll, d6.day.value, d6.day.limit, d6.open.value, d6.open.limit, d6.adds.count, d6.adds.limit], [100000, -5500, -4000, -9000, -6000, 2, 500]);
is('…and one line of what to do', [r.days[3].todo, r.days[4].todo], ['Stop adding to losing positions · No new trades today · Halve the book · Cut $7,750 of margin (or add $15,500)', 'Go flat — 16.4% below the peak']);
is('the replay as CSV, one row per close', [replayCsv(r).split('\n').length, replayCsv(r).split('\n')[0].split(',')[5]], [7, 'Day limit']);
is('10 Aug: a deposit after the call is flagged', r.days[5].flags.map((x) => x.id).includes('call'), true);
is('the first day each rule would have fired', r.first, { margin: '2026-08-06', adds: '2026-08-06', bookloss: '2026-08-06', day: '2026-08-06', ddwarn: '2026-08-06', ddflat: '2026-08-07', call: '2026-08-07' });
is('going flat on 7 Aug would have kept 7k of what followed', r.flat, { date: '2026-08-07', perf: -8000, endPerf: -15000, saved: 7000 });

// ---------- the live check ----------
const acc = (o) => ({ closes: closes.slice(0, 3), equityNow: 110000, tne: 110000, im: 22000, todayPnl: 0, rows: [], allFills: [], fillsToday: [], expiries: new Map(), today: '2026-08-05', imPer: { 'Inter-Product': 2000, Crack: 5000, days: 9 }, ...o });
const st = (res, id) => res.rules.find((x) => x.id === id).status;
let res = checkRules(acc({}));
is('TNE / IM 500%: fine, with room to add 33k of margin before 200%', [st(res, 'margin'), Math.round(res.room)], ['ok', 33000]);
is('…shown as lots of each kind of spread', res.roomLots, { 'Inter-Product': 16, Crack: 6 });
is('TNE / IM 250%: above the 200% floor, fine', st(checkRules(acc({ im: 44000 })), 'margin'), 'ok');
is('TNE / IM 183% (under 200%): cut back to it', checkRules(acc({ im: 60000 })).rules.find((x) => x.id === 'margin').action, 'Cut back to TNE / IM 200% — $5,000 of margin too much (or add $10,000)');
const live = checkRules(acc({ allFills: crack.slice(0, 4), fillsToday: crack.slice(2, 4), today: '2026-08-06' }));
is('adding to a loser while the account is healthy: caution', st(live, 'adds'), 'watch');
is('…and in drawdown or under the floor: cut', st(checkRules(acc({ allFills: crack.slice(0, 4), fillsToday: crack.slice(2, 4), today: '2026-08-06', im: 60000 })), 'adds'), 'cut');
is('one position down over 3% of bankroll: close it', st(checkRules(acc({ rows: [{ product: 'Oct26 HO-CL Crack', lots: -3, upnl: -3500 }] })), 'posloss'), 'cut');
is('the book down over 6%: halve', st(checkRules(acc({ rows: [{ product: 'A', lots: 1, upnl: -2900 }, { product: 'B', lots: 1, upnl: -2900 }, { product: 'C', lots: 1, upnl: -2900 }] })), 'bookloss'), 'cut');
is('a day down over 4%: no new trades', st(checkRules(acc({ todayPnl: -4500 })), 'day'), 'cut');
const flat = checkRules(acc({ closes, equityNow: 92000, today: '2026-08-07' }));
is('16% off the peak: go flat', [flat.rules.find((x) => x.id === 'dd').action, flat.level.level, flat.level.title], ['Go flat, review, restart at reduced size', 'flat', 'Go flat']);
is('a deficit at the last close: cut to meet it', st(checkRules(acc({ closes: closes.slice(0, 5), today: '2026-08-07' })), 'call'), 'cut');
is('a call earlier this month: half size for the rest of it', st(checkRules(acc({ closes, today: '2026-08-10' })), 'call'), 'watch');
is('an outright in a leg of a held spread: cut; one on its own: watch', [
  st(checkRules(acc({ rows: [{ product: 'CL Nov26 - BZ Nov26 Inter-Product', lots: 5, upnl: 0 }, { product: 'CL Nov26', lots: -1, upnl: 0 }] })), 'legged'),
  st(checkRules(acc({ rows: [{ product: 'CL Dec26', lots: 2, upnl: 0 }] })), 'legged')], ['cut', 'watch']);
is('a leg expiring within 5 trading days: roll or close', st(checkRules(acc({ rows: [{ product: 'CL Dec26 - BZ Dec26 Inter-Product', lots: 2, upnl: 0 }], expiries: new Map([['BZ|202612', '2026-08-10']]) })), 'expiry'), 'cut');
is('an empty limit box falls back to the default', checkRules(acc({ im: 44000 }), { ratioPct: '' }).rules.find((x) => x.id === 'margin').threshold, '≥ 200%');
// ---------- what it would take to hold the size ----------
// 48,135 of margin on 45,420 of equity (31 Aug): at a 30% cap it needs 160,450 of equity.
is('funding: equity to hold this size at the cap, and to cover the margin', fundingFor(48135, 45420, 30), { needAtCap: 160450, toCap: 115030, toCall: 2715 });
is('…and to reach a 200% TNE / IM minimum: margin × 2 less equity', fundingFor(48135, 45420, 30, 200).toMin, 50850);
is('within the cap: nothing to add', fundingFor(10000, 50000, 30), { needAtCap: 33333.33, toCap: 0, toCall: 0 });
is('under the floor: cut, or add the equity — both in dollars', checkRules(acc({ im: 60000 })).rules.find((x) => x.id === 'margin').card.caption, 'or add $10,000 to hold this size');
is('the replay carries it per day', [r.days[4].checks.margin.over, r.days[4].checks.margin.toCap, r.days[4].checks.margin.toCall], [49000, 98000, 3000]);
is('trading days skip weekends', [tradingDaysBetween('2026-10-06', '2026-10-09'), tradingDaysBetween('2026-10-09', '2026-10-12')], [3, 1]);
is('the defaults', [RISK_DEFAULTS.ratioPct, RISK_DEFAULTS.posLossPct, RISK_DEFAULTS.bookLossPct, RISK_DEFAULTS.dayLossPct, RISK_DEFAULTS.ddHalfPct, RISK_DEFAULTS.ddFlatPct], [200, 3, 6, 4, 10, 15]);

// ---------- VaR, the level, and each position's exit ----------
const pos = checkRules(acc({ rows: [{ product: 'CL Nov26 - BZ Nov26 Inter-Product', lots: 2, size: 1000, avg: -8, upnl: -1000 }, { product: 'Oct26 HO-CL Crack', lots: -1, size: 1000, avg: 90, upnl: -2600 }] })).positions;
// bankroll 100k: 3% = 3,000. Long 2 at -8: exit 3,000 / 2,000 = 1.50 lower; short 1 at 90: 3.00 higher.
is('each position\'s exit: where its loss reaches 3% of bankroll', pos.map((p) => [p.exit, p.status]), [[-9.5, 'ok'], [93, 'watch']]);
is('a position on watch makes the headline caution, not normal', checkRules(acc({ rows: [{ product: 'Oct26 HO-CL Crack', lots: -1, size: 1000, avg: 90, upnl: -2600 }] })).level.actions, ["Oct26 HO-CL Crack: Exit at 93 if it gets there — don't add"]);
is('…and what to do', pos.map((p) => p.action), ['Stop at -9.5', "Exit at 93 if it gets there — don't add"]);

// ---------- the drawdown budget ----------
// Peak trading P/L +10k on 5 Aug with 100k in: capital at the peak 110k. Now 104.5k equity: 5.5k down.
const bud = checkRules(acc({ closes: closes.slice(0, 4), equityNow: 104500, today: '2026-08-06', todayPnl: -1500 }));
is('5% below the peak is caution', [bud.rules.find((x) => x.id === 'dd').status, +bud.budget.ddPct.toFixed(1)], ['watch', 5]);
is('how much more can go before half size and before flat, and today\'s room', [bud.budget.toHalf, bud.budget.toFlat, bud.budget.today], [5500, 11000, 2500]);
is('the replay warns at 5% too', replay(closes.slice(0, 4), []).days[3].flags.map((x) => x.id).includes('ddwarn'), true);

is('spread names shortened, as TT and as paired from Orient\'s legs', [shortName('CL Nov26 - BZ Nov26 Inter-Product'), shortName('CL–BZ Nov26 Inter-Product'), shortName('Oct26 HO-CL Crack')], ['CL–BZ Nov26', 'CL–BZ Nov26', 'Oct26 HO-CL Crack']);

// ---------- a roll is not averaging down ----------
// Long 6 CL–BZ Oct at -7.05, now -7.70 ($3,900 down). Buying Oct while selling Nov keeps the CL–BZ total
// the same: not flagged. Buying Oct alone grows it: flagged. Selling Oct and buying Nov: a roll, not flagged.
const sp = (ts, side, product, price, qty = 1) => ({ ts, broker: 'o', product, side, qty, price });
const OCT = 'CL Oct26 - BZ Oct26 Inter-Product', NOV = 'CL Nov26 - BZ Nov26 Inter-Product';
const start = [sp('2026-08-18T09:00:00Z', 'Buy', OCT, -7.05, 6)];
is('buy Oct + sell Nov together: the CL–BZ total does not grow — not averaging down', addsToLosers([...start, sp('2026-08-24T07:00:00Z', 'Sell', NOV, -7.68), sp('2026-08-24T07:01:00Z', 'Buy', OCT, -7.70)], { minLoss: 500 }).length, 0);
is('buy Oct alone while the total is down: averaging down', addsToLosers([...start, sp('2026-08-24T07:00:00Z', 'Buy', OCT, -7.70)], { minLoss: 500 }).map((x) => [x.held, x.openLoss, x.months]), [[6, 3900, 1]]);
is('roll: sell Oct, buy Nov — not averaging down', addsToLosers([...start, sp('2026-08-24T08:50:00Z', 'Sell', OCT, -7.57, 6), sp('2026-08-24T08:51:00Z', 'Buy', NOV, -7.62, 6)], { minLoss: 500 }).length, 0);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
