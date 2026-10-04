import { bankrollFor, drawdowns, addsToLosers, checkRules, replay, tradingDaysBetween, RISK_DEFAULTS } from '../src/lib/riskRules.js';

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
is('5 Aug: margin 45% of equity — no new positions', ids('2026-08-05'), ['margin']);
is('6 Aug: margin 57%, adding to the losing short, 9k open loss, a 5.5k day, 5% off the peak', ids('2026-08-06'), ['margin', 'adds', 'bookloss', 'day', 'ddwarn']);
is('7 Aug: everything, and go flat', ids('2026-08-07'), ['margin', 'bookloss', 'day', 'ddflat', 'call']);
is('10 Aug: a deposit after the call is flagged', r.days[5].flags.map((x) => x.id).includes('call'), true);
is('the first day each rule would have fired', r.first, { margin: '2026-08-05', adds: '2026-08-06', bookloss: '2026-08-06', day: '2026-08-06', ddwarn: '2026-08-06', ddflat: '2026-08-07', call: '2026-08-07' });
is('going flat on 7 Aug would have kept 7k of what followed', r.flat, { date: '2026-08-07', perf: -8000, endPerf: -15000, saved: 7000 });

// ---------- the live check ----------
const acc = (o) => ({ closes: closes.slice(0, 3), equityNow: 110000, tne: 110000, im: 22000, todayPnl: 0, rows: [], allFills: [], fillsToday: [], expiries: new Map(), today: '2026-08-05', imPer: { 'Inter-Product': 2000, Crack: 5000, days: 9 }, ...o });
const st = (res, id) => res.rules.find((x) => x.id === id).status;
let res = checkRules(acc({}));
is('margin 20%: fine, with room to add worth 11k of margin', [st(res, 'margin'), res.room], ['ok', 11000]);
is('…shown as lots of each kind of spread', res.roomLots, { 'Inter-Product': 5, Crack: 2 });
is('margin 40%: no new positions', st(checkRules(acc({ im: 44000 })), 'margin'), 'watch');
is('margin 50%: cut back to 30%', checkRules(acc({ im: 55000 })).rules.find((x) => x.id === 'margin').action, 'Cut back to 30% — $22,000 of margin too much');
const live = checkRules(acc({ allFills: crack.slice(0, 4), fillsToday: crack.slice(2, 4), today: '2026-08-06' }));
is('adding to a loser today: cut', st(live, 'adds'), 'cut');
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
is('an empty limit box falls back to the default', checkRules(acc({ im: 44000 }), { marginPct: '' }).rules.find((x) => x.id === 'margin').threshold, '≤ 30% of equity');
is('trading days skip weekends', [tradingDaysBetween('2026-10-06', '2026-10-09'), tradingDaysBetween('2026-10-09', '2026-10-12')], [3, 1]);
is('the defaults', [RISK_DEFAULTS.marginPct, RISK_DEFAULTS.posLossPct, RISK_DEFAULTS.bookLossPct, RISK_DEFAULTS.dayLossPct, RISK_DEFAULTS.ddHalfPct, RISK_DEFAULTS.ddFlatPct], [30, 3, 6, 4, 10, 15]);

// ---------- VaR, the level, and each position's exit ----------
const withVar = (v99) => acc({ var: { method: 'margin', var99: v99, var95: v99 * 0.7, byPosition: [{ product: 'CL Nov26 - BZ Nov26 Inter-Product', var99: v99 }] } });
is('VaR limit 4% of a 100k bankroll; 3k is 75%: fine', [checkRules(withVar(3000)).rules[0].status, Math.round(checkRules(withVar(3000)).varUsed)], ['ok', 75]);
is('VaR at 80% of the limit: no new risk, and the level says caution', [checkRules(withVar(3520)).rules[0].status, checkRules(withVar(3520)).level.title], ['watch', 'Caution — no new positions']);
is('VaR past the limit: cut the excess', checkRules(withVar(5000)).rules[0].action, 'Cut $1,000 of VaR today, largest position first');
is('VaR past 125% of the limit: go flat', checkRules(withVar(6000)).level.level, 'flat');
is('every warning is listed, worst first, not only the worst level', checkRules(acc({ im: 44000, todayPnl: -4500, var: { method: 'margin', var99: 6000, var95: 4000, byPosition: [] } })).level.all.map((x) => x.status), ['flat', 'cut', 'watch']);
is('the method is said', checkRules(withVar(3000)).rules[0].now, "$3,000 · 75% of the limit (estimated from Orient's margin)");
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

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
