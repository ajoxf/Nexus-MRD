import { bankrollFor, checkRules, tradingDaysBetween, RISK_DEFAULTS } from '../src/lib/riskRules.js';

/*
 * The month's bankroll and the cut rules, worked by hand. A made-up $1,000,000 account.
 */
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
};

// ---------- bankroll ----------
const closes = [
  { date: '2026-09-29', equity: 990000, cash: 0 },
  { date: '2026-09-30', equity: 1000000, cash: 0 },
  { date: '2026-10-01', equity: 1030000, cash: 0 },        // up 30k
  { date: '2026-10-02', equity: 1070000, cash: 50000 },    // a 50k deposit, down 10k
  { date: '2026-10-05', equity: 1040000, cash: 0 },        // down 30k
];
const b = bankrollFor(closes, '2026-10-06');
is('bankroll: equity at the last close of last month, plus this month\'s deposits', [b.amount, b.base, b.baseDate, b.from, b.cash], [1050000, 1000000, '2026-09-30', 'previous month', 50000]);
is('the month\'s high and where it stands now, deposits taken out', [b.high, b.perfNow], [1030000, 990000]);
is('live equity counts once given', bankrollFor(closes, '2026-10-06', 1060000).perfNow, 1010000);
is('no statement before the month: its first statement', bankrollFor(closes.slice(2), '2026-10-06').baseDate, '2026-10-01');
is('nothing to go on: no bankroll', bankrollFor([], '2026-10-06'), null);

// ---------- the rules ----------
const varOf = (v95, v99, byPosition = []) => ({ var95: v95, var99: v99, days: 250, tooShort: false, byPosition });
const acc = (o) => ({ bankroll: { amount: 1000000, high: 1000000, perfNow: 1000000 }, varResult: varOf(25000, 30000), tne: 1000000, im: 200000, todayPnl: 0, positions: [], expiries: new Map(), today: '2026-10-06', ...o });
const st = (r, id) => r.rules.find((x) => x.id === id).status;

let r = checkRules(acc({}));
is('a $40k limit (4% of $1M); $30k VaR is 75% used: normal', [r.limit, Math.round(r.utilisation), r.band], [40000, 75, 'ok']);
is('$35k: watch', checkRules(acc({ varResult: varOf(28000, 35000) })).band, 'watch');
is('$45k: over the limit, cut today', checkRules(acc({ varResult: varOf(30000, 45000) })).rules[0].action.startsWith('Cut back under the limit today'), true);
is('$55k: past 125%, cut now', checkRules(acc({ varResult: varOf(40000, 55000) })).rules[0].action.startsWith('Cut now'), true);
is('too little history: said, not scored', checkRules(acc({ varResult: { var99: 1000, days: 8, tooShort: true, byPosition: [] } })).band, 'na');

is('a $41k loss since the close is past a 1× VaR-limit day: cut by half', st(checkRules(acc({ todayPnl: -41000 })), 'day'), 'cut');
is('…$20k is fine', st(checkRules(acc({ todayPnl: -20000 })), 'day'), 'ok');

is('11% down from the month\'s high: half size', checkRules(acc({ bankroll: { amount: 1000000, high: 1000000, perfNow: 890000 } })).rules.find((x) => x.id === 'dd').action, 'Trade at half size for the rest of the month');
is('16% down: go flat', checkRules(acc({ bankroll: { amount: 1000000, high: 1000000, perfNow: 840000 } })).rules.find((x) => x.id === 'dd').action, 'Go flat, review, restart at reduced size');

is('excess $20k under a $25k 95% VaR: an ordinary bad day means a call — cut', st(checkRules(acc({ tne: 220000, im: 200000 })), 'cushion'), 'cut');
is('TNE / IM 140%: no new positions', st(checkRules(acc({ tne: 280000, im: 200000 })), 'ratio'), 'watch');
is('TNE / IM 110%: cut', st(checkRules(acc({ tne: 220000, im: 200000 })), 'ratio'), 'cut');

is('one position using more than half the limit is named', checkRules(acc({ varResult: varOf(25000, 30000, [{ product: 'Nov26 HO-CL Crack', var99: 22000 }]) })).rules.find((x) => x.id === 'conc').now, 'Nov26 HO-CL Crack $22,000');

const legged = checkRules(acc({ positions: [{ product: 'CL Nov26 - BZ Nov26 Inter-Product', lots: 5 }, { product: 'CL Nov26', lots: -1 }] }));
is('an outright in a leg of a held spread: cut', st(legged, 'legged'), 'cut');
is('an outright on its own: watch, not cut', st(checkRules(acc({ positions: [{ product: 'CL Dec26', lots: 2 }] })), 'legged'), 'watch');

const exp = new Map([['BZ|202612', '2026-10-09'], ['CL|202612', '2026-11-19']]);
is('a leg expiring in 3 trading days: roll or close', st(checkRules(acc({ positions: [{ product: 'CL Dec26 - BZ Dec26 Inter-Product', lots: 2 }], expiries: exp })), 'expiry'), 'cut');
is('trading days skip weekends', [tradingDaysBetween('2026-10-06', '2026-10-09'), tradingDaysBetween('2026-10-09', '2026-10-12')], [3, 1]);
is('the defaults are the agreed ones', [RISK_DEFAULTS.varPct, RISK_DEFAULTS.monthDdPct, RISK_DEFAULTS.hardStopPct, RISK_DEFAULTS.cutRatio], [4, 10, 15, 120]);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
