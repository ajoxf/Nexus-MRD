import { instrumentOf } from "./brokerFeed.js";

/*
 * Risk guardrails: the rules that stop a drawdown before it gets large.
 *
 * ---------------------------------------------------------------------------
 * WHY THESE RULES
 * ---------------------------------------------------------------------------
 * Replayed on the trader's own August–September statements, the losses came from four things:
 * margin running at 40–100% of equity, selling more of a losing crack as it rose, carrying on after
 * a 19% day, and depositing to meet margin calls at the same size. Each is caught by a rule that
 * needs nothing but what RAMP already has — the fills as they are pasted, and Orient's daily
 * equity, margin and open P/L. No price history: Orient's initial margin is the clearing house's
 * own estimate of the risk, so margin ÷ equity is the sizing measure.
 *
 * Amounts are measured against the month's bankroll (Orient's equity at the last statement of the
 * previous month, plus deposits less withdrawals since); drawdown against the peak, with deposits
 * and withdrawals taken out so moving money is neither a gain nor a loss. Thresholds are the
 * trader's (RISK_DEFAULTS until changed). Nothing here trades or changes anything.
 */

export const RISK_DEFAULTS = {
  marginPct: 30,      // initial margin ≤ this % of equity; above it no new positions, above 1.5× cut
  posLossPct: 3,      // one position's open loss over this % of bankroll: close it
  bookLossPct: 6,     // the book's open loss over this % of bankroll: halve it
  dayLossPct: 4,      // a day's loss over this % of bankroll: no new trades today
  ddWarnPct: 5,       // drawdown from the peak: caution, no new positions
  ddHalfPct: 10,      // drawdown from the peak: trade at half size
  ddFlatPct: 15,      // drawdown from the peak: go flat
  addLossPct: 0.5,    // adding to a position whose open loss is over this % of bankroll counts as averaging a loser
  expiryDays: 5,      // trading days before a leg expires to be out or rolled
};

const MONTH = (d) => d.slice(0, 7);
const pct = (x) => `${x.toFixed(0)}%`;
const usd = (x) => `$${Math.round(Math.abs(x)).toLocaleString("en-US")}`;
const sgn = (x) => `${x < 0 ? "−" : "+"}${usd(x)}`;
// "CL Nov26 - BZ Nov26 Inter-Product" → "CL–BZ Nov26", for tiles; anything else as it is.
export const shortName = (p) => String(p).replace(/^([A-Z]{1,3}) (\w{5}) - ([A-Z]{1,3}) \2 Inter-?Product$/i, "$1–$3 $2");
const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dmy = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d || "") ? `${+d.slice(8)} ${MON[+d.slice(5, 7) - 1]}` : d);

/*
 * closes: feed.closes [{ date, equity, cash }], oldest first. today: "YYYY-MM-DD".
 * Returns { amount, base, baseDate, from: "previous month" | "first statement", cash, high, perfNow }
 * or null with nothing to go on. Performance = equity less the month's deposits and withdrawals.
 */
export function bankrollFor(closes, today, liveEquity = null) {
  if (!closes?.length) return null;
  const month = MONTH(today);
  const before = closes.filter((c) => MONTH(c.date) < month);
  const inMonth = closes.filter((c) => MONTH(c.date) === month && c.date <= today);
  let base, baseDate, from, after;
  if (before.length) {
    const last = before[before.length - 1];
    base = last.equity; baseDate = last.date; from = "previous month"; after = inMonth;
  } else if (inMonth.length) {
    // The account's first statement: its deposits are the money it started with.
    base = inMonth[0].equity; baseDate = inMonth[0].date; from = "first statement"; after = inMonth.slice(1);
  } else return null;
  let cash = 0, high = base;
  for (const c of after) { cash += c.cash; high = Math.max(high, c.equity - cash); }
  const perfNow = (liveEquity ?? (after.length ? after[after.length - 1].equity : base)) - cash;
  high = Math.max(high, perfNow);
  return { amount: +(base + cash).toFixed(2), base, baseDate, from, cash: +cash.toFixed(2), high: +high.toFixed(2), perfNow: +perfNow.toFixed(2) };
}

/*
 * Trading performance through the statements: equity less every deposit and withdrawal so far,
 * its running peak, and the drawdown from it as a % of the capital at the peak (peak performance
 * plus the money in the account).
 */
export function drawdowns(closes, liveEquity = null) {
  let cum = 0, peak = -Infinity, peakDate = null;
  const out = [];
  const step = (date, equity, cash) => {
    cum += cash;
    const perf = equity - cum;
    if (perf > peak) { peak = perf; peakDate = date; }
    const dd = peak - perf;
    const capital = peak + cum;
    out.push({ date, equity, perf: +perf.toFixed(2), peak: +peak.toFixed(2), peakDate, dd: +dd.toFixed(2), ddPct: capital > 0 ? dd / capital * 100 : 0, capital: +capital.toFixed(2) });
  };
  // The first statement's equity is the starting capital, however it got there (a deposit on the
  // day, or money already in the account before the statements begin): not a gain.
  (closes || []).forEach((c, i) => step(c.date, c.equity, i === 0 ? c.equity : c.cash));
  if (liveEquity !== null && out.length) step("now", liveEquity, 0);
  return out;
}

/*
 * Fills that add to a position already losing at the fill's own price — selling more of a short
 * above its average, buying more of a long below it — by more than minLoss dollars (so a scalper's
 * one-tick add isn't a "loser"). Average cost per product and account, in the order the fills
 * were made; a position that goes through zero starts again. Legs of a spread trade are skipped
 * (the spread row is the trade). sizeOf(fill) → contract size; minLoss: dollars, or (fill) → dollars.
 */
export function addsToLosers(fills, { sizeOf = () => 1000, minLoss = 0 } = {}) {
  const pos = new Map();
  const out = [];
  const sorted = [...(fills || [])].filter((f) => !f.is_leg).sort((a, b) => String(a.ts).localeCompare(String(b.ts)));
  for (const f of sorted) {
    const k = `${f.broker}|${f.product}`;
    const p = pos.get(k) || { lots: 0, avg: 0 };
    const q = (f.side === "Buy" ? 1 : -1) * Math.abs(+f.qty);
    const price = +f.price;
    if (p.lots && Math.sign(q) === Math.sign(p.lots)) {
      const openLoss = (p.lots > 0 ? p.avg - price : price - p.avg) * Math.abs(p.lots) * sizeOf(f);
      const floor = typeof minLoss === "function" ? minLoss(f) : minLoss;
      if (openLoss > Math.max(floor, 1e-9)) out.push({ ts: f.ts, broker: f.broker, product: f.product, side: f.side, qty: Math.abs(q), price, avg: +p.avg.toFixed(6), held: p.lots, openLoss: +openLoss.toFixed(2) });
      p.avg = (p.avg * Math.abs(p.lots) + price * Math.abs(q)) / (Math.abs(p.lots) + Math.abs(q));
      p.lots += q;
    } else if (p.lots && Math.abs(q) > Math.abs(p.lots)) {
      p.avg = price; p.lots += q;              // through zero: the rest opens at this price
    } else {
      if (!p.lots) p.avg = price;
      p.lots += q;
    }
    if (Math.abs(p.lots) < 1e-9) { p.lots = 0; p.avg = 0; }
    pos.set(k, p);
  }
  return out;
}

/*
 * The live check. acc: { closes (feed.closes), equityNow, tne, im, todayPnl, rows: [{ product,
 * lots (signed), upnl }], fillsToday: [fill], allFills: [fill], expiries: Map "CODE|YYYYMM" →
 * "YYYY-MM-DD", today, imPer (learned margin per spread kind) }.
 * Returns { bankroll, marginPct, room, roomLots, dd, rules: [{ id, label, threshold, now, status, action }] }.
 */
export function checkRules(acc, limits = RISK_DEFAULTS) {
  const L = { ...RISK_DEFAULTS, ...cleanLimits(limits) };
  const br = bankrollFor(acc.closes, acc.today, acc.equityNow);
  const B = br?.amount || 0;
  const rules = [];
  const add = (id, label, threshold, now, status, action) => rules.push({ id, label, threshold, now, status, action });

  // 1. Size: margin as a share of equity.
  const marginPct = acc.tne > 0 ? acc.im / acc.tne * 100 : acc.im > 0 ? Infinity : 0;
  const room = Math.max(0, acc.tne * L.marginPct / 100 - acc.im);
  const roomLots = acc.imPer ? Object.fromEntries(Object.entries(acc.imPer).filter(([k, v]) => k !== "days" && v > 0).map(([k, v]) => [k, Math.floor(room / v)])) : null;
  /*
   * Funding: what would have to be added to the account to hold today's size within the margin
   * cap, and — the bare minimum — to cover the margin itself (a call clears at excess ≥ 0).
   * Shown next to the cut so both ways back are in dollars; the rules still say cut, not fund.
   */
  const funding = fundingFor(acc.im, acc.tne, L.marginPct, acc.minRatio);
  add("margin", "Size: margin ÷ equity", `≤ ${L.marginPct}% of equity`, isFinite(marginPct) ? `${pct(marginPct)} (${usd(acc.im)} of ${usd(acc.tne)})` : "margin with no equity",
    marginPct > L.marginPct * 1.5 ? "cut" : marginPct > L.marginPct ? "watch" : "ok",
    marginPct > L.marginPct * 1.5 ? `Cut back to ${L.marginPct}% — ${usd(acc.im - acc.tne * L.marginPct / 100)} of margin too much (or ${usd(funding.toCap)} more equity to hold this size)`
      : marginPct > L.marginPct ? "No new positions until margin is back under the limit" : `Room to add ${usd(room)} of margin`);

  // 2. Adding to a loser, in the fills since the last statement.
  const adds = addsToLosers(acc.allFills || [], { sizeOf: acc.sizeOf, minLoss: B * L.addLossPct / 100 }).filter((x) => (acc.fillsToday || []).some((f) => f.ts === x.ts && f.product === x.product));
  add("adds", "No adding to a loser", `No fill that adds to a position already losing over ${usd(B * L.addLossPct / 100)}`,
    adds.length ? adds.map((x) => `${x.side === "Buy" ? "bought" : "sold"} ${x.qty} ${x.product} at ${x.price} — ${x.held > 0 ? "long" : "short"} ${Math.abs(x.held)} from ${+x.avg.toFixed(4)}, ${usd(x.openLoss)} down`).join(" · ") : "none since the last statement",
    adds.length ? "cut" : "ok", adds.length ? "Stop adding. Hold or cut what you have; don't average a loser" : "—");

  // 3. Open loss: each position, and the book.
  const posLimit = B * L.posLossPct / 100, bookLimit = B * L.bookLossPct / 100;
  const bad = (acc.rows || []).filter((r) => r.upnl < -posLimit && posLimit > 0);
  add("posloss", "Open loss: one position", `≤ ${usd(posLimit)} (${L.posLossPct}% of bankroll)`,
    bad.length ? bad.map((r) => `${r.product} ${sgn(r.upnl)}`).join(" · ") : "none over",
    bad.length ? "cut" : "ok", bad.length ? `Close ${bad.map((r) => r.product).join(", ")}` : "—");
  const book = (acc.rows || []).reduce((t, r) => t + r.upnl, 0);
  add("bookloss", "Open loss: the book", `≤ ${usd(bookLimit)} (${L.bookLossPct}% of bankroll)`, sgn(book),
    bookLimit > 0 && book < -bookLimit ? "cut" : bookLimit > 0 && book < -bookLimit * 0.75 ? "watch" : "ok",
    bookLimit > 0 && book < -bookLimit ? "Halve the book" : "—");

  // 4. The day.
  const dayLimit = B * L.dayLossPct / 100;
  add("day", "Day's loss", `≤ ${usd(dayLimit)} (${L.dayLossPct}% of bankroll) since the last close`, sgn(acc.todayPnl || 0),
    dayLimit > 0 && -acc.todayPnl > dayLimit ? "cut" : dayLimit > 0 && -acc.todayPnl > dayLimit * 0.75 ? "watch" : "ok",
    dayLimit > 0 && -acc.todayPnl > dayLimit ? "No new trades today" : "—");

  // 5. Drawdown from the peak.
  const dds = drawdowns(acc.closes, acc.equityNow);
  const dd = dds[dds.length - 1] || null;
  add("dd", "Drawdown from the peak", `${L.ddWarnPct}% caution · ${L.ddHalfPct}% half size · ${L.ddFlatPct}% go flat (deposits taken out)`,
    dd ? `${usd(dd.dd)} · ${dd.ddPct.toFixed(1)}% below the peak of ${dd.peakDate === "now" ? "today" : dmy(dd.peakDate)}` : "—",
    !dd ? "na" : dd.ddPct >= L.ddFlatPct ? "flat" : dd.ddPct >= L.ddHalfPct ? "cut" : dd.ddPct >= L.ddWarnPct - 1e-9 ? "watch" : "ok",
    !dd ? "—" : dd.ddPct >= L.ddFlatPct ? "Go flat, review, restart at reduced size" : dd.ddPct >= L.ddHalfPct ? `Trade at half size until back within ${L.ddHalfPct}% of the peak`
      : dd.ddPct >= L.ddWarnPct ? "No new positions; cut losers first" : "—");

  /*
   * The drawdown budget: how much more can be lost, from here, before each step — the number to
   * keep in mind while a position runs against you. Today's room is the day's loss limit less what
   * the day has already lost.
   */
  const budget = dd ? {
    peak: dd.peak, peakDate: dd.peakDate, now: dd.perf, dd: dd.dd, ddPct: dd.ddPct, capital: dd.capital,
    toWarn: +(dd.capital * L.ddWarnPct / 100 - dd.dd).toFixed(2),
    toHalf: +(dd.capital * L.ddHalfPct / 100 - dd.dd).toFixed(2),
    toFlat: +(dd.capital * L.ddFlatPct / 100 - dd.dd).toFixed(2),
    today: +(dayLimit - Math.max(0, -(acc.todayPnl || 0))).toFixed(2),
  } : null;

  // 6. Margin calls: never funded to keep the same size.
  const month = (acc.closes || []).filter((c) => MONTH(c.date) === MONTH(acc.today));
  const last = (acc.closes || [])[(acc.closes || []).length - 1];
  const deficitDay = month.find((c) => c.excess < 0);
  add("call", "Margin call", "Margin excess never below zero; a call is met by cutting, not by depositing",
    last && last.excess < 0 ? `deficit ${usd(last.excess)} at the last close` : deficitDay ? `deficit on ${dmy(deficitDay.date)} this month` : "none this month",
    last && last.excess < 0 ? "cut" : deficitDay ? "watch" : "ok",
    last && last.excess < 0 ? "Cut to meet it" : deficitDay ? "Half size for the rest of the month" : "—");

  // 7. A spread's leg left on its own.
  const kinds = (acc.rows || []).map((p) => ({ ...p, kind: instrumentOf(p.product)?.kind || null }));
  const outr = kinds.filter((p) => p.kind === "Outright" && p.lots);
  const spreadLegs = new Set(kinds.filter((p) => p.kind && p.kind !== "Outright" && p.lots).flatMap((p) => instrumentOf(p.product).legs.map((l) => `${l.code}|${l.month}`)));
  const legged = outr.filter((p) => instrumentOf(p.product).legs.some((l) => spreadLegs.has(`${l.code}|${l.month}`)));
  add("legged", "Legged outrights", "No outright left open in a leg of a spread you hold",
    outr.length ? outr.map((p) => `${p.product} ${p.lots > 0 ? "+" : ""}${p.lots}${legged.includes(p) ? " (a spread's leg)" : ""}`).join(" · ") : "none",
    legged.length ? "cut" : outr.length ? "watch" : "ok",
    legged.length ? "Complete the spread or flatten the leg now; never carry it overnight" : outr.length ? "An outright carries several times a spread's risk — make sure it is meant" : "—");

  // 8. Expiry.
  const soon = [];
  for (const p of kinds) for (const l of instrumentOf(p.product)?.legs || []) {
    const exp = acc.expiries?.get(`${l.code}|${l.month}`);
    if (!exp) continue;
    const days = tradingDaysBetween(acc.today, exp);
    if (days <= L.expiryDays) soon.push(`${p.product} (${l.code} expires ${dmy(exp)}, ${days} trading day${days === 1 ? "" : "s"})`);
  }
  add("expiry", "Expiry", `Out or rolled ${L.expiryDays} trading days before a leg expires`, soon.length ? [...new Set(soon)].join(" · ") : "nothing close",
    soon.length ? "cut" : "ok", soon.length ? "Roll or close before liquidity goes" : "—");

  // Each position: its share of the risk, and the price at which its loss reaches the limit.
  const positions = (acc.rows || []).filter((r) => r.lots).map((r) => {
    const lossPct = B > 0 ? -r.upnl / B * 100 : 0;
    const perPoint = (r.size || 0) * Math.abs(r.lots);
    // Long: exit below the average; short: above. The loss at the exit is the 3% limit.
    const exit = perPoint > 0 && r.avg !== undefined ? +(r.avg - Math.sign(r.lots) * posLimit / perPoint).toFixed(4) : null;
    const status = r.upnl < -posLimit ? "cut" : r.upnl < -posLimit * 0.66 ? "watch" : "ok";
    return { ...r, lossPct, exit, status,
      action: status === "cut" ? "Close it" : status === "watch" ? `Exit at ${exit} if it gets there — don't add` : `Stop at ${exit}` };
  });

  /*
   * The numbers behind each rule, for its card: the figure now, the limit it is held to, how much
   * of the limit is used (%), and one line of context. unit: usd | pct | count.
   */
  const card = (id, c) => { const r = rules.find((x) => x.id === id); if (r) r.card = { ...c, used: c.used === undefined || c.used === null || !isFinite(c.used) ? null : c.used }; };
  const worstPos = (acc.rows || []).reduce((w, r) => (!w || r.upnl < w.upnl ? r : w), null);
  card("margin", { value: isFinite(marginPct) ? marginPct : null, limit: L.marginPct, unit: "pct", used: marginPct / L.marginPct * 100, caption: funding.toCap > 0 ? `or add ${usd(funding.toCap)} to hold this size` : `${usd(acc.im)} margin on ${usd(acc.tne)} equity` });
  card("adds", { value: adds.length, limit: 0, unit: "count", used: adds.length ? 200 : 0, caption: adds.length ? `${adds[adds.length - 1].product} at ${adds[adds.length - 1].price}, ${usd(adds[adds.length - 1].openLoss)} down` : "None since the last statement" });
  card("posloss", { value: worstPos && worstPos.upnl < 0 ? -worstPos.upnl : 0, limit: posLimit, unit: "usd", used: worstPos && posLimit > 0 ? Math.max(0, -worstPos.upnl) / posLimit * 100 : 0, caption: worstPos && worstPos.upnl < 0 ? `Worst: ${shortName(worstPos.product)}` : "No position losing" });
  card("bookloss", { value: Math.max(0, -book), limit: bookLimit, unit: "usd", used: bookLimit > 0 ? Math.max(0, -book) / bookLimit * 100 : 0, caption: `Open P/L ${sgn(book)}` });
  card("day", { value: Math.max(0, -(acc.todayPnl || 0)), limit: dayLimit, unit: "usd", used: dayLimit > 0 ? Math.max(0, -(acc.todayPnl || 0)) / dayLimit * 100 : 0, caption: budget ? (budget.today > 0 ? `${usd(budget.today)} of room left today` : "Today's limit passed") : `Since the last close ${sgn(acc.todayPnl || 0)}` });
  card("dd", { value: dd ? dd.ddPct : null, limit: L.ddFlatPct, unit: "pct", used: dd ? dd.ddPct / L.ddFlatPct * 100 : null, caption: budget ? (budget.toFlat > 0 ? `${usd(budget.dd)} below the peak · ${usd(budget.toFlat)} more to go flat` : `${usd(budget.dd)} below the peak`) : "—" });
  card("call", { value: last ? last.excess : null, limit: 0, unit: "usd", used: last && last.excess < 0 ? 200 : 0, caption: "Margin excess at the last close" });
  card("legged", { value: legged.length || outr.length, limit: 0, unit: "count", used: legged.length ? 200 : outr.length ? 80 : 0, caption: outr.length ? outr.map((p) => p.product).join(", ") : "None" });
  card("expiry", { value: soon.length, limit: 0, unit: "count", used: soon.length ? 200 : 0, caption: soon.length ? soon[0] : "Nothing within " + L.expiryDays + " trading days" });

  // A few words to act on, for the tile (the full sentence stays in `action`).
  const short = (id, text) => { const r = rules.find((x) => x.id === id); if (r && r.card && r.status !== "ok" && r.status !== "na") r.card.short = text; };
  const st = (id) => rules.find((x) => x.id === id)?.status;
  short("margin", st("margin") === "cut" ? `Cut ${usd(acc.im - acc.tne * L.marginPct / 100)} of margin` : "No new positions");
  short("adds", "Stop adding");
  short("posloss", bad.length ? `Close ${bad.map((r) => shortName(r.product)).join(", ")}` : "Watch it");
  short("bookloss", st("bookloss") === "cut" ? "Halve the book" : "Watch it");
  short("day", st("day") === "cut" ? "No new trades today" : "Slow down");
  short("dd", st("dd") === "flat" ? "Go flat" : st("dd") === "cut" ? "Half size" : "No new positions");
  short("call", st("call") === "cut" ? "Cut to meet the call" : "Half size this month");
  short("legged", legged.length ? "Complete or flatten the leg" : "Check it's meant");
  short("expiry", "Roll or close");

  const posRules = positions.filter((p) => p.status !== "ok").map((p) => ({ status: p.status, label: p.product, action: p.action }));
  return { bankroll: br, marginPct, room, roomLots, funding, dd, budget, positions, level: levelOf([...rules, ...posRules]), rules };
}

/*
 * The one line a trader reads first: the worst status among the rules, as an instruction.
 *   flat    Go flat now
 *   cut     Reduce now — what each rule says
 *   watch   Caution — no new positions
 *   ok      Normal
 */
export function levelOf(rules) {
  const level = levelOnly(rules);
  // Every warning, worst first: what the banner flashes when a price is typed.
  const rank = { flat: 0, cut: 1, watch: 2 };
  level.all = rules.filter((r) => r.status in rank).sort((a, b) => rank[a.status] - rank[b.status])
    .map((r) => ({ status: r.status, text: `${r.label}: ${r.action}` }));
  return level;
}

function levelOnly(rules) {
  const has = (s) => rules.filter((r) => r.status === s);
  if (has("flat").length) return { level: "flat", title: "Go flat", actions: has("flat").map((r) => `${r.label}: ${r.action}`) };
  if (has("cut").length) return { level: "cut", title: "Reduce now", actions: has("cut").map((r) => `${r.label}: ${r.action}`) };
  if (has("watch").length) return { level: "watch", title: "Caution — no new positions", actions: has("watch").map((r) => `${r.label}: ${r.action}`) };
  return { level: "ok", title: "Normal — within every limit", actions: [] };
}

/*
 * The rules replayed on the statements, day by day: what each would have said at each close.
 * closes: feed.closes; fills: all the account's fills (for adding to losers, by fill date).
 * Returns { days: [{ date, equity, perf, day, marginPct, upl, excess, ddPct, flags: [{ id, level, text }] }],
 *           first: { id → date }, flat: { date, perf, endPerf, saved } | null }.
 */
export function replay(closes, fills, limits = RISK_DEFAULTS, sizeOf = () => 1000, minRatio = null) {
  const L = { ...RISK_DEFAULTS, ...cleanLimits(limits) };
  const dds = drawdowns(closes);
  const bankAt = (date) => bankrollFor(closes, date)?.amount || 0;
  const adds = addsToLosers(fills, { sizeOf, minLoss: (f) => bankAt(String(f.ts).slice(0, 10)) * L.addLossPct / 100 });
  const days = [];
  const first = {};
  let prevPerf = null, depositAfterCall = false, callSeen = false;
  (closes || []).forEach((c, i) => {
    const br = bankrollFor(closes, c.date);
    const B = br?.amount || 0;
    const d = dds[i];
    const day = prevPerf === null ? 0 : d.perf - prevPerf;
    prevPerf = d.perf;
    const marginPct = c.equity > 0 ? c.im / c.equity * 100 : c.im > 0 ? Infinity : 0;
    const flags = [];
    const flag = (id, level, text) => { flags.push({ id, level, text }); if (!first[id]) first[id] = c.date; };
    if (marginPct > L.marginPct * 1.5) flag("margin", "cut", `Margin ${pct(marginPct)} of equity — cut to ${L.marginPct}%`);
    else if (marginPct > L.marginPct) flag("margin", "watch", `Margin ${pct(marginPct)} of equity — no new positions`);
    const todays = adds.filter((x) => String(x.ts).slice(0, 10) === c.date);
    if (todays.length) flag("adds", "cut", `Added to a loser ${todays.length}×: ${[...new Set(todays.map((x) => x.product))].join(", ")} at ${todays.map((x) => x.price).join(", ")} (up to ${usd(Math.max(...todays.map((x) => x.openLoss)))} down)`);
    if (B > 0 && c.upl < -B * L.bookLossPct / 100) flag("bookloss", "cut", `Open loss ${usd(c.upl)} — over ${L.bookLossPct}% of bankroll: halve`);
    if (B > 0 && day < -B * L.dayLossPct / 100) flag("day", "cut", `Day ${sgn(day)} — over ${L.dayLossPct}% of bankroll: no new trades`);
    if (d.ddPct >= L.ddFlatPct) flag("ddflat", "cut", `${d.ddPct.toFixed(1)}% below the peak — go flat`);
    else if (d.ddPct >= L.ddHalfPct) flag("dd", "cut", `${d.ddPct.toFixed(1)}% below the peak — half size`);
    else if (d.ddPct >= L.ddWarnPct - 1e-9) flag("ddwarn", "watch", `${d.ddPct.toFixed(1)}% below the peak — caution, no new positions`);
    if (c.excess < 0) { flag("call", "cut", `Margin deficit ${usd(c.excess)} — cut to meet it`); callSeen = true; }
    else if (callSeen && c.cash > 0) { flag("call", "cut", `Deposit ${usd(c.cash)} after a margin call — size should have been cut, not funded`); depositAfterCall = true; }
    // Every rule's figure, its limit that day, and what it said — for the replay table and the CSV.
    const st = (bad, warn) => (bad ? "cut" : warn ? "watch" : "ok");
    const dayLimit = B * L.dayLossPct / 100, openLimit = B * L.bookLossPct / 100, addLimit = B * L.addLossPct / 100;
    const checks = {
      bankroll: B,
      margin: { value: marginPct, limit: L.marginPct, cutAt: L.marginPct * 1.5, status: st(marginPct > L.marginPct * 1.5, marginPct > L.marginPct),
        over: +Math.max(0, c.im - c.equity * L.marginPct / 100).toFixed(2), ...fundingFor(c.im, c.equity, L.marginPct, minRatio) },
      day: { value: +day.toFixed(2), limit: +(-dayLimit).toFixed(2), status: st(B > 0 && day < -dayLimit, B > 0 && day < -dayLimit * 0.75) },
      open: { value: c.upl, limit: +(-openLimit).toFixed(2), status: st(B > 0 && c.upl < -openLimit, B > 0 && c.upl < -openLimit * 0.75) },
      dd: { value: d.ddPct, amount: d.dd, warn: L.ddWarnPct, half: L.ddHalfPct, flat: L.ddFlatPct,
        status: d.ddPct >= L.ddFlatPct ? "flat" : d.ddPct >= L.ddHalfPct ? "cut" : d.ddPct >= L.ddWarnPct - 1e-9 ? "watch" : "ok" },
      adds: { count: todays.length, maxLoss: todays.length ? Math.max(...todays.map((x) => x.openLoss)) : 0, limit: +addLimit.toFixed(2),
        list: todays.map((x) => ({ product: x.product, side: x.side, price: x.price, held: x.held, avg: x.avg, openLoss: x.openLoss })), status: todays.length ? "cut" : "ok" },
      excess: { value: c.excess, deposit: c.cash > 0 ? c.cash : 0, status: c.excess < 0 || (callSeen && c.cash > 0 && c.excess >= 0) ? "cut" : "ok" },
    };
    const rank = { ok: 0, watch: 1, cut: 2, flat: 3 };
    const worst = Object.values(checks).filter((x) => x && x.status).reduce((w, x) => (rank[x.status] > rank[w] ? x.status : w), "ok");
    const flatWhy = checks.dd.status === "flat" ? `${d.ddPct.toFixed(1)}% below the peak` : "";
    const todo = worst === "flat" ? `Go flat — ${flatWhy}` : worst === "ok" ? "" : [
      checks.adds.count && "Stop adding to losers",
      checks.day.status === "cut" && "No new trades today",
      checks.open.status === "cut" && "Halve the book",
      checks.dd.status === "cut" && "Half size",
      checks.margin.status === "cut" && `Cut ${usd(checks.margin.over)} of margin (or add ${usd(checks.margin.toCap)})`,
      checks.excess.status === "cut" && (c.excess < 0 ? "Cut to meet the margin call" : "Don't fund a call — cut size"),
      worst === "watch" && "No new positions",
    ].filter(Boolean).join(" · ");
    days.push({ date: c.date, equity: c.equity, perf: d.perf, day: +day.toFixed(2), marginPct, upl: c.upl, excess: c.excess, im: c.im, ddPct: d.ddPct, flags, checks, level: worst, todo });
  });
  const flatDay = first.ddflat ? days.find((x) => x.date === first.ddflat) : null;
  const end = days[days.length - 1];
  return {
    days, first, depositAfterCall,
    flat: flatDay && end ? { date: flatDay.date, perf: flatDay.perf, endPerf: end.perf, saved: +(flatDay.perf - end.perf).toFixed(2) } : null,
  };
}

// Limits as typed: an empty or non-numeric box falls back to the default.
function cleanLimits(limits) {
  const out = {};
  for (const [k, v] of Object.entries(limits || {})) if (v !== "" && v !== null && isFinite(+v)) out[k] = +v;
  return out;
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

// The replay as CSV: one row per close, every rule's figure next to its limit.
export function replayCsv(rp) {
  const head = ["Close", "Equity", "Bankroll", "Trading P/L to date", "Day", "Day limit", "Margin % of equity", "Margin cap %", "Margin over the cap", "Add to hold size at cap", "Add to reach minimum TNE/IM", "Add to cover margin", "Open P/L", "Open loss limit",
    "Below peak %", "Below peak $", "Caution %", "Half size %", "Go flat %", "Adds to losers", "Biggest add loss", "Add threshold",
    "Margin excess", "Deposit", "Level", "What to do"];
  const r2 = (x) => (x === null || x === undefined || !isFinite(x) ? "" : (+x).toFixed(2));
  const q = (x) => `"${String(x ?? "").replace(/"/g, '""')}"`;
  const rows = rp.days.map((d) => {
    const k = d.checks;
    return [d.date, r2(d.equity), r2(k.bankroll), r2(d.perf), r2(d.day), r2(k.day.limit), r2(k.margin.value), r2(k.margin.limit), r2(k.margin.over), r2(k.margin.toCap), r2(k.margin.toMin), r2(k.margin.toCall), r2(d.upl), r2(k.open.limit),
      r2(k.dd.value), r2(k.dd.amount), k.dd.warn, k.dd.half, k.dd.flat, k.adds.count, r2(k.adds.maxLoss), r2(k.adds.limit),
      r2(k.excess.value), r2(k.excess.deposit), d.level, q(d.todo)].join(",");
  });
  return [head.join(","), ...rows].join("\n");
}

/*
 * Equity needed to carry `im` of margin: at the cap (margin = cap% of equity) and at the bare
 * minimum (equity = margin, excess 0). Returns what would have to be added to `equity`.
 */
export function fundingFor(im, equity, capPct, minRatio = null) {
  const atCap = capPct > 0 ? im / (capPct / 100) : Infinity;
  const out = { needAtCap: +atCap.toFixed(2), toCap: +Math.max(0, atCap - equity).toFixed(2), toCall: +Math.max(0, im - equity).toFixed(2) };
  // The trader's own minimum TNE / IM (e.g. 200%): equity = margin × ratio.
  if (minRatio > 0) out.toMin = +Math.max(0, im * minRatio / 100 - equity).toFixed(2);
  return out;
}
