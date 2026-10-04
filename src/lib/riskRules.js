import { instrumentOf } from "./brokerFeed.js";

/*
 * The cut rules: when the book must be made smaller, checked against the account as it stands.
 *
 * Everything is measured against the month's bankroll — Orient's equity at the last statement of
 * the previous month, plus deposits less withdrawals since — so the limits hold still through the
 * month instead of moving with every day's P/L. Thresholds are the trader's (RISK_DEFAULTS until
 * changed). Each rule says what it compared, whether it is met, and what to do; nothing here
 * trades or changes anything.
 */

export const RISK_DEFAULTS = {
  varPct: 4,          // 1-day 99% VaR limit, % of bankroll
  watchPct: 75,       // utilisation above this: no new risk
  hardPct: 125,       // utilisation above this: cut now
  dailyLossX: 1,      // a day's loss above this × the VaR limit: cut the book by half
  monthDdPct: 10,     // drawdown from the month's high: half size
  hardStopPct: 15,    // drawdown from the month's high: go flat
  noNewRatio: 150,    // TNE / IM below this: no new positions
  cutRatio: 120,      // TNE / IM below this: cut
  concentrationPct: 50, // one position's own VaR above this % of the limit
  expiryDays: 5,      // trading days before a leg's expiry to be out or rolled
};

const MONTH = (d) => d.slice(0, 7);

/*
 * closes: feed.closes [{ date, equity, cash }], oldest first. today: "YYYY-MM-DD".
 * Returns { amount, base, baseDate, from: "previous month" | "first statement", cash, high, perfNow }
 * or null with nothing to go on. Performance = equity less the month's deposits and withdrawals,
 * so money moved in or out is neither a gain nor a drawdown.
 */
export function bankrollFor(closes, today, liveEquity = null) {
  if (!closes?.length) return null;
  const month = MONTH(today);
  const before = closes.filter((c) => MONTH(c.date) < month);
  const inMonth = closes.filter((c) => MONTH(c.date) === month);
  let base, baseDate, from, after;
  if (before.length) {
    const last = before[before.length - 1];
    base = last.equity; baseDate = last.date; from = "previous month"; after = inMonth;
  } else if (inMonth.length) {
    base = inMonth[0].equity; baseDate = inMonth[0].date; from = "first statement"; after = inMonth.slice(1);
  } else return null;
  let cash = 0, high = base;
  for (const c of after) { cash += c.cash; high = Math.max(high, c.equity - cash); }
  const perfNow = (liveEquity ?? (after.length ? after[after.length - 1].equity : base)) - cash;
  high = Math.max(high, perfNow);
  return { amount: +(base + cash).toFixed(2), base, baseDate, from, cash: +cash.toFixed(2), high: +high.toFixed(2), perfNow: +perfNow.toFixed(2) };
}

/*
 * acc: { bankroll (bankrollFor), varResult (historicalVar), tne, im, todayPnl, positions: [{ product,
 *        lots (signed) }], expiries: Map "CODE|YYYYMM" → "YYYY-MM-DD", today }
 * limits: RISK_DEFAULTS merged with the trader's.
 * Returns { limit, utilisation, band, rules: [{ id, label, threshold, now, status: ok|watch|cut|na, action }] }.
 */
export function checkRules(acc, limits = RISK_DEFAULTS) {
  const L = { ...RISK_DEFAULTS, ...limits };
  const br = acc.bankroll;
  const v = acc.varResult;
  const limit = br ? +(br.amount * L.varPct / 100).toFixed(2) : null;
  const hasVar = v && v.var99 !== null && !v.tooShort;
  const util = limit && hasVar ? v.var99 / limit * 100 : null;
  const band = util === null ? "na" : util > L.hardPct ? "cut" : util > 100 ? "cut" : util > L.watchPct ? "watch" : "ok";
  const ratio = acc.im > 0 ? acc.tne / acc.im * 100 : null;
  const excess = acc.tne - acc.im;
  const dd = br ? br.high - br.perfNow : null;
  const ddPct = br && br.amount > 0 ? dd / br.amount * 100 : null;
  const rules = [];
  const add = (id, label, threshold, now, status, action) => rules.push({ id, label, threshold, now, status, action });
  const money = (x) => (x === null || x === undefined ? "—" : `$${Math.round(x).toLocaleString("en-US")}`);

  add("var", "VaR within the limit", `99% VaR ≤ ${money(limit)} (${L.varPct}% of bankroll)`,
    hasVar ? `${money(v.var99)} · ${util.toFixed(0)}% used` : v?.tooShort ? `${v.days} days of prices — too few` : "no price history",
    band, band === "cut" && util > L.hardPct ? "Cut now, starting with the position that adds most to VaR"
      : band === "cut" ? "Cut back under the limit today, ideally to " + money(limit * L.watchPct / 100)
      : band === "watch" ? "No new risk — only trades that reduce VaR" : band === "ok" ? "Trade freely" : "Load more price history to measure it");

  const dayLimit = limit !== null ? limit * L.dailyLossX : null;
  const dayLoss = Math.max(0, -(acc.todayPnl || 0));
  add("day", "Daily loss", `Loss ≤ ${money(dayLimit)} since the last close`, `${acc.todayPnl < 0 ? "−" : "+"}${money(Math.abs(acc.todayPnl || 0))}`,
    dayLimit === null ? "na" : dayLoss > dayLimit ? "cut" : dayLoss > dayLimit * 0.75 ? "watch" : "ok",
    dayLimit !== null && dayLoss > dayLimit ? "Cut the book by half; no new trades until tomorrow" : "—");

  add("dd", "Drawdown this month", `≤ ${L.monthDdPct}% half size · ≤ ${L.hardStopPct}% go flat`,
    ddPct === null ? "—" : `${money(dd)} · ${ddPct.toFixed(1)}% from the month's high`,
    ddPct === null ? "na" : ddPct > L.hardStopPct ? "cut" : ddPct > L.monthDdPct ? "cut" : ddPct > L.monthDdPct * 0.75 ? "watch" : "ok",
    ddPct === null ? "—" : ddPct > L.hardStopPct ? "Go flat, review, restart at reduced size" : ddPct > L.monthDdPct ? "Trade at half size for the rest of the month" : "—");

  const cushionNeed = hasVar ? v.var95 : null;
  add("cushion", "Margin cushion", "Margin excess ≥ 1-day 95% VaR", hasVar ? `excess ${money(excess)} vs VaR ${money(cushionNeed)}` : `excess ${money(excess)}`,
    !hasVar ? "na" : excess < cushionNeed ? "cut" : excess < v.var99 ? "watch" : "ok",
    hasVar && excess < cushionNeed ? `Cut until the excess covers the 99% VaR (${money(v.var99)}) — an ordinary bad day would otherwise mean a margin call` : "—");

  add("ratio", "TNE / IM", `≥ ${L.noNewRatio}% to add · ≥ ${L.cutRatio}% to hold`, ratio === null ? "no margin used" : `${ratio.toFixed(0)}%`,
    ratio === null ? "ok" : ratio < L.cutRatio ? "cut" : ratio < L.noNewRatio ? "watch" : "ok",
    ratio !== null && ratio < L.cutRatio ? "Cut" : ratio !== null && ratio < L.noNewRatio ? "No new positions" : "—");

  if (hasVar && limit) {
    const big = v.byPosition.filter((p) => p.var99 > limit * L.concentrationPct / 100);
    add("conc", "Concentration", `No position's own VaR > ${L.concentrationPct}% of the limit (${money(limit * L.concentrationPct / 100)})`,
      big.length ? big.map((p) => `${p.product} ${money(p.var99)}`).join(" · ") : "none",
      big.length ? "watch" : "ok", big.length ? "Reduce the largest position" : "—");
  }

  // Outrights held next to spreads look like a spread closed or opened one leg at a time.
  const pos = acc.positions || [];
  const kinds = pos.map((p) => ({ ...p, kind: instrumentOf(p.product)?.kind || null }));
  const outr = kinds.filter((p) => p.kind === "Outright" && p.lots);
  const spreadLegs = new Set(kinds.filter((p) => p.kind && p.kind !== "Outright" && p.lots).flatMap((p) => instrumentOf(p.product).legs.map((l) => `${l.code}|${l.month}`)));
  const legged = outr.filter((p) => instrumentOf(p.product).legs.some((l) => spreadLegs.has(`${l.code}|${l.month}`)));
  add("legged", "Legged outrights", "No outright left open in a contract that is a leg of a spread you hold",
    outr.length ? outr.map((p) => `${p.product} ${p.lots > 0 ? "+" : ""}${p.lots}${legged.includes(p) ? " (a spread's leg)" : ""}`).join(" · ") : "none",
    legged.length ? "cut" : outr.length ? "watch" : "ok",
    legged.length ? "Complete the spread or flatten the leg now; never carry it overnight"
      : outr.length ? "An outright uses several times a spread's VaR — make sure it is meant" : "—");

  const soon = [];
  for (const p of kinds) {
    const ins = instrumentOf(p.product);
    for (const l of ins?.legs || []) {
      const exp = acc.expiries?.get(`${l.code}|${l.month}`);
      if (!exp) continue;
      const days = tradingDaysBetween(acc.today, exp);
      if (days <= L.expiryDays) soon.push(`${p.product} (${l.code} expires ${exp}, ${days} trading day${days === 1 ? "" : "s"})`);
    }
  }
  add("expiry", "Expiry", `Out or rolled ${L.expiryDays} trading days before a leg expires`, soon.length ? [...new Set(soon)].join(" · ") : "nothing close",
    soon.length ? "cut" : "ok", soon.length ? "Roll or close before liquidity goes" : "—");

  return { limit, utilisation: util, band, excess, ratio, rules };
}

// Weekdays after `from` up to and including `to` (negative when `to` is past).
export function tradingDaysBetween(from, to) {
  const a = new Date(`${from}T12:00:00Z`), b = new Date(`${to}T12:00:00Z`);
  const sign = b >= a ? 1 : -1;
  let n = 0;
  for (let d = new Date(a); sign > 0 ? d < b : d > b; d.setUTCDate(d.getUTCDate() + sign)) {
    const next = new Date(d); next.setUTCDate(next.getUTCDate() + sign);
    if (![0, 6].includes(next.getUTCDay())) n += sign;
  }
  return n;
}
