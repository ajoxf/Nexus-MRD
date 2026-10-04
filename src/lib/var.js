import { instrumentOf } from "./brokerFeed.js";

/*
 * Value at Risk by historical simulation.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT ANSWERS
 * ---------------------------------------------------------------------------
 * "If tomorrow moves like one of the days in the history, what does today's book make or lose?"
 * Every day in the price history is replayed on the positions held now: each position's value
 * changes by that day's move in its own legs' settlements (a CL–BZ spread by CL's move minus BZ's,
 * a crack by HO × 42 minus CL's). Sorting those day results gives:
 *
 *   var95   the loss exceeded on about 1 day in 20
 *   var99   the loss exceeded on about 1 day in 100
 *   worst   the worst day in the history, on today's book, and its date
 *
 * Spreads are why this is done from history rather than from a volatility per contract: CL and BZ
 * move together, and the history carries that without anyone having to estimate a correlation.
 *
 * ---------------------------------------------------------------------------
 * THE DATA
 * ---------------------------------------------------------------------------
 * history: Map "CODE|YYYYMM" → Map "YYYY-MM-DD" → settlement price. A day counts only when every
 * leg of every position has a settlement on it and on the day before it, so a gap in one contract
 * shortens the history rather than inventing a move. Positions with no history at all are
 * reported, not guessed.
 *
 * Reading only: nothing here changes the book.
 */

const legKey = (l) => `${l.code}|${l.month}`;

/*
 * positions: [{ product (TT name), lots (signed, + long), size (per lot) }]
 * Returns { days, from, to, var95, var99, worst: { pnl, date }, pnls: [{ date, pnl }],
 *           byPosition: [{ product, lots, var99, worstDay }], missing: [product], tooShort }
 * Losses are positive numbers (a VaR of 8,400 means a loss of $8,400).
 */
export function historicalVar(positions, history, { minDays = 20 } = {}) {
  const missing = [];
  const live = [];
  for (const p of positions || []) {
    if (!p.lots) continue;
    const ins = instrumentOf(p.product);
    if (!ins || ins.legs.some((l) => !history.has(legKey(l)))) { missing.push(p.product); continue; }
    live.push({ ...p, ins });
  }
  const empty = { days: 0, from: null, to: null, var95: null, var99: null, worst: null, pnls: [], byPosition: [], missing, tooShort: true };
  if (!live.length) return empty;

  // The dates every leg has, in order; each one after the first is a day's move.
  const legs = [...new Set(live.flatMap((p) => p.ins.legs.map(legKey)))];
  const dates = [...history.get(legs[0]).keys()].filter((d) => legs.every((k) => history.get(k).has(d))).sort();
  if (dates.length < 2) return { ...empty, days: 0 };

  const valueOn = (p, d) => p.ins.value(...p.ins.legs.map((l) => history.get(legKey(l)).get(d)));
  const pnls = [];
  const perPos = live.map(() => []);
  for (let i = 1; i < dates.length; i++) {
    let total = 0;
    live.forEach((p, j) => {
      const x = (valueOn(p, dates[i]) - valueOn(p, dates[i - 1])) * p.lots * p.size;
      perPos[j].push(x);
      total += x;
    });
    pnls.push({ date: dates[i], pnl: +total.toFixed(2) });
  }

  const days = pnls.length;
  return {
    days, from: dates[0], to: dates[dates.length - 1],
    var95: lossAt(pnls.map((x) => x.pnl), 0.05),
    var99: lossAt(pnls.map((x) => x.pnl), 0.01),
    worst: pnls.reduce((w, x) => (x.pnl < w.pnl ? x : w)),
    pnls,
    byPosition: live.map((p, j) => ({ product: p.product, lots: p.lots, var99: lossAt(perPos[j], 0.01), worstDay: +Math.min(...perPos[j]).toFixed(2) })),
    missing,
    tooShort: days < minDays,
  };
}

/*
 * The loss at a tail: of n day results sorted worst first, the k-th with k = ceil(alpha × n) —
 * the conservative choice (never interpolated towards the milder side). A gain is a loss of 0.
 */
export function lossAt(pnls, alpha) {
  if (!pnls.length) return null;
  const sorted = [...pnls].sort((a, b) => a - b);
  const k = Math.max(1, Math.ceil(alpha * sorted.length));
  return +Math.max(0, -sorted[k - 1]).toFixed(2);
}

/*
 * Settlements from the daily statements' open positions, to add to the history:
 * days: [{ date: "YYYY-MM-DD", lots: readOpenPositions(...).lots }]. A history already holding a
 * day keeps its own figure (the uploaded file is the record; the statements fill in after it).
 */
export function addSettles(history, days) {
  const out = new Map([...history].map(([k, m]) => [k, new Map(m)]));
  for (const d of days || []) for (const l of d.lots || []) {
    if (l.kind && l.kind !== "F") continue;
    const k = `${l.code}|${l.month}`;
    if (!out.has(k)) out.set(k, new Map());
    if (!out.get(k).has(d.date) && Number.isFinite(l.settle)) out.get(k).set(d.date, l.settle);
  }
  return out;
}
