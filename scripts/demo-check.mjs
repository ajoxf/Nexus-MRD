import Papa from "papaparse";
import { buildDemo, DEMO } from "../src/lib/demo.js";
import { readFinancialSummary, readOpenPositions, checkAccount, checkFamily, checkCarryOver, checkPositionsAgainstSummary, isFinancialSummary, isOpenPosition } from "../src/lib/orient.js";
import { readTradeConfirmations, isTradeConfirmation, uniqueTrades } from "../src/lib/spreadHistory.js";
import { matchFills } from "../src/lib/fillMatch.js";
import { instrumentOf } from "../src/lib/brokerFeed.js";

/*
 * The demo account (/demo) is generated from today's date, so it is a different set of files
 * every day. Every one of them has to pass the same checks a real Orient statement passes on the
 * Statements tab — a demo that shows "1 doesn't add up" to a broker is worse than no demo — and
 * the story it tells has to survive the calendar. So: a year of anchor dates, each checked.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; };
const bad = (l, got) => { fail++; console.log("FAIL", l, "->", JSON.stringify(got)); };
const is = (l, cond, got) => (cond ? ok(l) : bad(l, got));
const parse = (t) => Papa.parse(t || "", { skipEmptyLines: true }).data;

for (let n = 0; n < 366; n += 3) {
  const today = new Date(2026, 0, 1 + n);
  const tag = today.toDateString();
  const d = buildDemo(today);
  const days = [], tradeLists = [];
  let summaryProblems = 0, positionProblems = 0;
  for (const s of d.statements) {
    const fs = s.files.find((f) => isFinancialSummary(f.name));
    const r = readFinancialSummary(parse(fs.text));
    if (r.problems.length) { bad(`${tag} ${s.zip_name} reads`, r.problems); continue; }
    for (const a of r.accounts) summaryProblems += checkAccount(a).length;
    summaryProblems += checkFamily(r.accounts).length;
    const op = s.files.find((f) => isOpenPosition(f.name));
    if (op) {
      const lots = readOpenPositions(parse(op.text));
      if (lots.problems.length) bad(`${tag} open positions read`, lots.problems);
      else if (s.account === DEMO.group) positionProblems += checkPositionsAgainstSummary(lots.lots, r.accounts).length;
    }
    const tc = s.files.find((f) => isTradeConfirmation(f.name));
    if (tc) { const t = readTradeConfirmations(parse(tc.text)); if (t.problems.length) bad(`${tag} trade confirmation read`, t.problems); else tradeLists.push(t.trades); }
    days.push({ date: s.statement_date, accounts: r.accounts });
  }
  is(`${tag}: every Financial Summary adds up`, summaryProblems === 0, summaryProblems);
  is(`${tag}: open positions agree with the summary`, positionProblems === 0, positionProblems);
  const breaks = checkCarryOver(days);
  is(`${tag}: balances carry over day to day`, !breaks.length, breaks.slice(0, 2));
  const m = matchFills(d.fills, uniqueTrades(tradeLists));
  is(`${tag}: every Orient lot matches a fill`, m.missing.length === 0, m.missing.slice(0, 2));
  is(`${tag}: every fill matches an Orient lot`, m.extra.length === 0, m.extra.slice(0, 2));
  is(`${tag}: the last statement is the last weekday before today`, new Date(`${d.asOf}T12:00:00`) < today && (today - new Date(`${d.asOf}T12:00:00`)) / 86400000 <= 3.5, d.asOf);
  is(`${tag}: every product is one the app knows`, d.fills.every((f) => instrumentOf(f.product)), d.fills.find((f) => !instrumentOf(f.product))?.product);

  // The story: TNE / IM below 200% at some point, a drawdown, and three spreads still open.
  const group = d.statements.filter((s) => s.account === DEMO.group).reverse()
    .map((s) => readFinancialSummary(parse(s.files[0].text)).accounts.find((a) => a.no === DEMO.group));
  const minRatio = Math.min(...group.filter((a) => a.im > 0).map((a) => a.tne / a.im * 100));
  is(`${tag}: TNE / IM dips under 200%`, minRatio < 200 && minRatio > 120, minRatio);
  const net = new Map();
  for (const f of d.fills) if (!f.is_leg) net.set(f.product, (net.get(f.product) || 0) + (f.side === "Buy" ? f.qty : -f.qty));
  is(`${tag}: three spreads are open at the end`, [...net.values()].filter(Boolean).length === 3, [...net]);
}

console.log(fail ? `\n${pass} passed, ${fail} failed` : `all ${pass} passed`);
process.exit(fail ? 1 : 0);
