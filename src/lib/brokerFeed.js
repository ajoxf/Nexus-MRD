import { RULES } from "./statementSpreads.js";
import { spreadsFromLots } from "./statementSpreads.js";

/*
 * What the broker's statements say, for the book to run on.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * The trader pastes fills; everything else should come from the broker, not be typed: cash,
 * deposits and withdrawals, prices, margin. Orient's daily statements carry all of it. This reads
 * them into one feed per account group:
 *
 *   anchor   the latest statement's equity, cash, IM — what Orient says at the last close
 *   settles  every contract's settlement price at that close
 *   cash     every deposit and withdrawal ("Cash Adjustments"), per sub-account, per day
 *   imPer    what one spread of each kind has cost in initial margin, learned from how Orient's
 *            IM moved with the positions across the statements — used only to estimate the IM of
 *            what has been traded since the last statement, until the next one arrives
 *
 * The book then works out live equity as Orient's equity at the close plus what has changed since
 * (the price move on what was open, and the P/L on fills pasted since) — so with no new trades and
 * prices at settlement it shows exactly Orient's figure, and every morning's statement resets it.
 *
 * Reading only. Nothing here changes the book or the statements.
 */

const MON = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
const ym = (s) => { const m = /^([A-Za-z]{3})(\d{2})$/.exec(s); return m && MON[m[1].toLowerCase()] ? `20${m[2]}${MON[m[1].toLowerCase()]}` : null; };
const leg = (code, mon) => { const month = ym(mon); return month ? { code, month } : null; };
const ruleOf = (kind) => RULES.find((r) => r.kind === kind);

/*
 * A TT product name → what it is and how it is priced from its legs.
 *   "CL Oct26"                             outright
 *   "CL Nov26 - BZ Nov26 Inter-Product"    CL − BZ
 *   "Oct26 HO-CL Crack"                    HO × 42 − CL
 *   "CL Oct26-Dec26 Calendar"              near − far
 * Null for anything else (it keeps a typed price, as before).
 */
export function instrumentOf(product) {
  const p = String(product || "").trim();
  let m;
  if ((m = /^([A-Z]{1,3})\s+([A-Za-z]{3}\d{2})\s*-\s*([A-Z]{1,3})\s+([A-Za-z]{3}\d{2})\s+Inter-?Product$/i.exec(p))) {
    const a = leg(m[1], m[2]), b = leg(m[3], m[4]);
    return a && b ? { kind: "Inter-Product", legs: [a, b], value: ruleOf("Inter-Product").value } : null;
  }
  if ((m = /^([A-Za-z]{3}\d{2})\s+([A-Z]{1,3})-([A-Z]{1,3})\s+Crack$/i.exec(p))) {
    const a = leg(m[2], m[1]), b = leg(m[3], m[1]);
    return a && b && a.code === "HO" ? { kind: "Crack", legs: [a, b], value: ruleOf("Crack").value } : null;
  }
  if ((m = /^([A-Z]{1,3})\s+([A-Za-z]{3}\d{2})\s*-\s*([A-Za-z]{3}\d{2})\s+Calendar$/i.exec(p))) {
    const a = leg(m[1], m[2]), b = leg(m[1], m[3]);
    return a && b ? { kind: "Calendar", legs: [a, b], value: ruleOf("Calendar").value } : null;
  }
  if ((m = /^([A-Z]{1,3})\s+([A-Za-z]{3}\d{2})$/.exec(p))) {
    const a = leg(m[1], m[2]);
    return a ? { kind: "Outright", legs: [a], value: (x) => x } : null;
  }
  return null;
}

// A product's settlement, priced from its legs' settlements; null when a leg has none.
export function settleOf(product, settles) {
  const ins = instrumentOf(product);
  if (!ins) return null;
  const px = ins.legs.map((l) => settles.get(`${l.code}|${l.month}`));
  if (px.some((v) => v === undefined || v === null)) return null;
  return +ins.value(...px).toFixed(6);
}

/*
 * days: the daily statements, read — [{ date: "YYYY-MM-DD", accounts: readFinancialSummary(...).accounts,
 * lots: readOpenPositions(...).lots | null }], any order, the sub-accounts' and the group's zips mixed.
 * group: the group's account number ("100305").
 */
export function buildFeed(days, group) {
  const mine = days.filter((d) => d.date && (d.accounts || []).some((a) => a.no === group || a.no.startsWith(group)));
  if (!mine.length) return null;
  const dates = [...new Set(mine.map((d) => d.date))].sort();

  // Per day: the group's figures (its own row, or its sub-accounts added up), and its open lots.
  const perDay = dates.map((date) => {
    const today = mine.filter((d) => d.date === date);
    const subs = new Map();
    let groupRow = null;
    for (const d of today) for (const a of d.accounts) {
      if (a.no === group) groupRow = groupRow || a;
      else if (a.no.startsWith(group) && !subs.has(a.no)) subs.set(a.no, a);
    }
    const add = (k) => [...subs.values()].reduce((t, a) => t + (a[k] || 0), 0);
    const fig = groupRow || (subs.size ? Object.fromEntries(FIGS.map((k) => [k, add(k)])) : null);
    // Lots once: a sub-account's own file, else the group's (which lists every sub-account's).
    const lotFiles = today.filter((d) => d.lots);
    const seen = new Set(), lots = [];
    for (const d of lotFiles) for (const l of d.lots) {
      const k = `${l.account}|${l.tradeId}|${l.code}|${l.month}|${l.side}|${l.price}`;
      if (!l.account.startsWith(group) || seen.has(k)) continue;
      seen.add(k); lots.push(l);
    }
    return { date, fig, subs: [...subs.values()], lots, hasLots: lotFiles.length > 0 };
  }).filter((d) => d.fig);
  if (!perDay.length) return null;

  // Deposits and withdrawals: Cash Adjustments, sub-account by sub-account (the group's row is
  // their sum, so it is not counted again).
  const cash = [];
  const seenCash = new Set();
  for (const d of perDay) for (const a of d.subs) {
    if (!a.cashAdj || seenCash.has(`${a.no}|${d.date}`)) continue;
    seenCash.add(`${a.no}|${d.date}`);
    cash.push({ date: d.date, account: a.no, amount: +a.cashAdj.toFixed(2) });
  }

  const last = perDay[perDay.length - 1];

  // Orient's own sums from the first statement to the last: how the money got from the first
  // beginning balance to the last close. A day missing from the chain shows up as "unexplained".
  const tot = (k) => +perDay.reduce((t, d) => t + (d.fig[k] || 0), 0).toFixed(2);
  const charges = +(tot("commission") + tot("fee") + tot("gst") + tot("interest") + tot("optPremium")).toFixed(2);
  const opening = perDay[0].fig.beginning || 0;
  const sums = {
    opening, cash: tot("cashAdj"), pl: tot("pl"), charges,
    commission: tot("commission"), fee: tot("fee"), gst: tot("gst"), interest: tot("interest"),
    upl: +((last.fig.equity || 0) - (last.fig.ending || 0)).toFixed(2),
  };
  sums.unexplained = +((last.fig.ending || 0) - (opening + sums.cash + sums.pl + charges)).toFixed(2);
  const settles = new Map();
  for (const l of last.lots) settles.set(`${l.code}|${l.month}`, l.settle);

  return {
    group,
    date: last.date,
    anchor: { ending: last.fig.ending, equity: last.fig.equity, tne: last.fig.tne, im: last.fig.im, excess: last.fig.excess },
    settles,
    lots: last.lots,
    cash,
    sums,
    // Each day's close, for the month's bankroll and drawdown; each day's settlements, for VaR.
    closes: perDay.map((d) => ({ date: d.date, equity: d.fig.equity || 0, tne: d.fig.tne || 0, cash: d.fig.cashAdj || 0, im: d.fig.im || 0, upl: d.fig.upl || 0, excess: d.fig.excess || 0 })),
    settleDays: perDay.filter((d) => d.hasLots).map((d) => ({ date: d.date, lots: d.lots })),
    imPer: learnMargin(perDay.filter((d) => d.hasLots)),
    days: perDay.length,
  };
}

const FIGS = ["beginning", "cashAdj", "commission", "fee", "gst", "pl", "optPremium", "interest", "ending", "upl", "equity", "tne", "im", "excess"];
const KINDS = ["Inter-Product", "Crack", "Calendar", "Outright"];

// A day's positions counted by kind of spread (lots, unsigned), from Orient's legs paired by order id.
export function countsOf(lots) {
  const c = Object.fromEntries(KINDS.map((k) => [k, 0]));
  const { spreads, outrights } = spreadsFromLots(lots.filter((l) => l.kind === "F"));
  for (const s of spreads) c[s.kind] += Math.abs(s.lots);
  for (const o of outrights) c.Outright += Math.abs(o.lots);
  return c;
}

/*
 * What one lot of each kind costs in initial margin, from the statements: Orient's IM each day
 * against the spreads open that day, fitted by least squares without an intercept. Kinds never
 * held are left out; a kind the fit can't separate (always held in step with another) falls back
 * to the day-weighted average of IM per lot. Null when there is nothing to learn from.
 */
export function learnMargin(perDay) {
  const rows = perDay.map((d) => ({ y: d.fig.im, x: countsOf(d.lots) })).filter((r) => Object.values(r.x).some((v) => v > 0));
  if (!rows.length) return null;
  const used = KINDS.filter((k) => rows.some((r) => r.x[k] > 0));
  // Normal equations (XᵀX) b = Xᵀy, solved by Gaussian elimination.
  const n = used.length;
  const A = used.map((a) => used.map((b) => rows.reduce((t, r) => t + r.x[a] * r.x[b], 0)));
  const v = used.map((a) => rows.reduce((t, r) => t + r.x[a] * r.y, 0));
  const solve = () => {
    const M = A.map((row, i) => [...row, v[i]]);
    for (let i = 0; i < n; i++) {
      let p = i; for (let j = i + 1; j < n; j++) if (Math.abs(M[j][i]) > Math.abs(M[p][i])) p = j;
      if (Math.abs(M[p][i]) < 1e-9) return null;
      [M[i], M[p]] = [M[p], M[i]];
      for (let j = 0; j < n; j++) if (j !== i) { const f = M[j][i] / M[i][i]; for (let k = i; k <= n; k++) M[j][k] -= f * M[i][k]; }
    }
    return M.map((row, i) => row[n] / row[i]);
  };
  const b = solve();
  const totalLots = rows.reduce((t, r) => t + Object.values(r.x).reduce((s, x) => s + x, 0), 0);
  const avg = rows.reduce((t, r) => t + r.y, 0) / totalLots;
  const out = {};
  used.forEach((k, i) => { out[k] = b && b[i] > 0 ? +b[i].toFixed(2) : +avg.toFixed(2); });
  out.days = rows.length;
  return out;
}

export { KINDS };
