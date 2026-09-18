/*
 * What the account looked like at every point, per broker.
 * -------------------------------------------------------
 * Two halves meet in the middle of this chart, and they are not the same
 * quality of number:
 *
 *   Behind the join — RECONSTRUCTED. Re-run your own fills up to that date and
 *   read the book off them. Lots and initial margin come out exact, because
 *   neither depends on a price RAMP would have had to remember. Equity does:
 *   open positions are carried at their entry price, since nobody recorded the
 *   price you were marking them at on the day. So reconstructed TNE is your
 *   funding plus realized money — it does not include the open profit or loss
 *   you were sitting on. It is honest about the past, not a substitute for it.
 *
 *   From the join forward — RECORDED. One row per broker per day, written from
 *   the live figures, so TNE is the real thing, unrealized included.
 *
 * The chart marks the join rather than smoothing it over, because the step at
 * that point is an artefact of the change in method, not something that
 * happened to the account.
 */

// Local calendar day, which is the day a trader means when they say "Tuesday".
export function dayKey(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  const p = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// The last instant of a local day, so a point labelled "3 March" includes
// everything that happened on the 3rd.
export function endOfDay(key) {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999);
}

export function addDays(key, k) {
  const [y, m, d] = key.split("-").map(Number);
  return dayKey(new Date(y, m - 1, d + k));
}

// Whole dollars and four-decimal lots. Snapshots are compared against what is
// already stored to decide whether to write, and float dust must not look like
// a change or the app would save itself in a circle.
const round0 = (v) => (isFinite(v) ? Math.round(v) : 0);
const round4 = (v) => (isFinite(v) ? Math.round(v * 1e4) / 1e4 : 0);

/*
 * One row per broker account, from the live portfolio.
 *
 * `prod` breaks the lot count down by product, because "19 lots" answers a smaller
 * question than "19 lots, of which 12 were the NG spread". Rows written before this
 * existed have no `prod` and are drawn as one unattributed block rather than dropped —
 * the total in them is still true.
 */
export function snapshotRows(pf, now = new Date()) {
  const d = dayKey(now);
  return pf.accounts.map((a) => {
    const prod = {};
    for (const r of a.rows) {
      const lots = Math.abs(r.lots);
      // A row with no product name would otherwise be filed under the string
      // "undefined" and drawn as a real segment with a real-looking label.
      if (lots && r.product) prod[r.product] = round4((prod[r.product] || 0) + lots);
    }
    return {
      d, b: a.id,
      tne: round0(a.TNE),
      im: round0(a.IM),
      lots: round4(a.rows.reduce((t, r) => t + Math.abs(r.lots), 0)),
      prod,
    };
  });
}

// Deep-compares `prod` too: a day where the same total moved between products is a
// different day, and must be written rather than recognised as unchanged.
const sameProd = (x, y) => {
  const a = x || {}, b = y || {};
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) if ((a[k] || 0) !== (b[k] || 0)) return false;
  return true;
};
const same = (x, y) =>
  x && y && x.tne === y.tne && x.im === y.im && x.lots === y.lots && sameProd(x.prod, y.prod);

/*
 * Puts today's rows into the history, replacing today's previous rows.
 *
 * Returns the ORIGINAL array when nothing changed. The caller writes history
 * into settings, settings recompute the portfolio, and the portfolio produces
 * these rows again — so an unchanged day has to be recognisable by identity,
 * or that loop never stops turning.
 */
export function mergeSnapshot(history, rows, keepDays = 800) {
  const old = Array.isArray(history) ? history : [];
  const d = rows[0]?.d;
  if (!d) return old;
  const todays = old.filter((r) => r.d === d);
  const unchanged = todays.length === rows.length
    && rows.every((r) => same(r, todays.find((t) => t.b === r.b)));
  if (unchanged) return old;

  const cutoff = addDays(d, -keepDays);
  return [...old.filter((r) => r.d !== d && r.d >= cutoff), ...rows].sort(
    (a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : String(a.b).localeCompare(String(b.b))),
  );
}

// The first day that was recorded live — everything before it has to be
// reconstructed, everything from it on was written down at the time.
export function joinDay(history) {
  const days = (history || []).map((r) => r.d).sort();
  return days.length ? days[0] : null;
}

/*
 * The days to reconstruct: from the first fill up to the day before recording
 * started (or up to today, if it never did).
 *
 * Capped at maxPoints by widening the step, so a book with three years of fills
 * does not run the whole position engine a thousand times to draw one line.
 */
export function reconstructionDays(fills, history, today = dayKey(new Date()), maxPoints = 180) {
  const stamps = (fills || []).filter((f) => !f.is_leg).map((f) => f.ts).filter(Boolean).sort();
  if (!stamps.length) return [];
  const first = dayKey(stamps[0]);
  const join = joinDay(history);
  // The join day itself is recorded, so reconstruction stops the day before it.
  const last = join ? addDays(join, -1) : today;
  if (last < first) return [];

  const span = Math.round((endOfDay(last) - endOfDay(first)) / 864e5) + 1;
  const step = Math.max(1, Math.ceil(span / maxPoints));
  const out = [];
  for (let k = 0; k < span; k += step) out.push(addDays(first, k));
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

/*
 * Folds reconstructed days and recorded snapshots into one line per broker.
 *
 * Every point carries `recorded`, so the chart can draw the two halves
 * differently and say which is which, and the join is returned alongside.
 */
export function buildSeries({ reconstructed, history, brokers }) {
  const byDay = new Map();
  const put = (d, b, v, recorded) => {
    if (!byDay.has(d)) byDay.set(d, new Map());
    byDay.get(d).set(b, { ...v, recorded });
  };
  for (const p of reconstructed || []) for (const [b, v] of Object.entries(p.byBroker)) put(p.d, b, v, false);
  for (const r of history || []) put(r.d, r.b, { tne: r.tne, im: r.im, lots: r.lots, prod: r.prod }, true);

  const days = [...byDay.keys()].sort();
  const lines = brokers.map((b) => ({
    id: b.id,
    name: b.name,
    points: days
      .filter((d) => byDay.get(d).has(b.id))
      .map((d) => ({ d, ...byDay.get(d).get(b.id) })),
  }));
  return { days, lines, join: joinDay(history) };
}

export const METRICS = [
  { key: "tne", label: "Total net equity", fmt: "money" },
  { key: "im", label: "Initial margin", fmt: "money" },
  { key: "ratio", label: "TNE / IM", fmt: "ratio" },
  /*
   * Realized money is not stored and does not need to be. It follows from the closed
   * trades, which are permanent — so unlike equity it reconstructs exactly for every day
   * there has ever been, and its line is solid the whole way across.
   */
  { key: "realized", label: "Realized P&L", fmt: "money" },
  // Both drawn as bars broken down by product rather than as lines. See MarginHistory.
  { key: "lots", label: "Lots held", fmt: "lots", stacked: true },
  /*
   * A different measurement from the one above, not a different view of it. Held is the
   * position at the close of a day; traded is what changed hands during it. A day can
   * show heavy volume and end flat, and on the held chart that day looks like nothing
   * happened.
   */
  { key: "traded", label: "Lots traded", fmt: "lots", stacked: true, fromFills: true },
];

// TNE/IM is not stored: it is the two stored numbers divided, and a flat
// account has no ratio at all rather than a very large one.
export function valueOf(point, metric) {
  if (metric !== "ratio") return point[metric];
  return point.im > 0 ? point.tne / point.im : null;
}

/*
 * Cumulative realized P&L per broker at the close of each day.
 *
 * Exact everywhere. A closed trade carries the money it made and the moment it closed,
 * and neither is ever restated, so there is nothing here to reconstruct approximately.
 */
export function realizedByDay(closed, days) {
  const out = new Map(days.map((d) => [d, {}]));
  const running = {};
  const sorted = [...(closed || [])].sort((a, b) => new Date(a.closeTs) - new Date(b.closeTs));
  let i = 0;
  for (const d of days) {
    const end = endOfDay(d).getTime();
    while (i < sorted.length && new Date(sorted[i].closeTs).getTime() <= end) {
      const t = sorted[i];
      const b = t.broker || "default";
      running[b] = (running[b] || 0) + t.pnl;
      i += 1;
    }
    out.set(d, { ...running });
  }
  return out;
}

/*
 * Winners and losers per day, by the day a trade CLOSED.
 *
 * A trade opened in March and closed in June is June's result: that is the day the money
 * was decided, and the day somebody reviewing a bad week would look for it.
 */
/*
 * Per day: how many trades won and lost, AND how much they won and lost.
 *
 * Both, because they are different questions and a chart drawn from one while captioned
 * with the other misleads. Twenty small losses and six large ones can be the same money;
 * counted, one day towers over the other. `won` and `lost` are positive magnitudes so a
 * chart can size a bar by either without minding signs; `net` is the signed money and is
 * net of commission, because the closed trades it sums already carry theirs.
 */
export function winLossByDay(closed) {
  const by = new Map();
  for (const t of closed || []) {
    if (!t.closeTs) continue;
    const d = dayKey(t.closeTs);
    const row = by.get(d) || { d, wins: 0, losses: 0, flat: 0, net: 0, won: 0, lost: 0 };
    if (t.pnl > 0) { row.wins += 1; row.won += t.pnl; }
    else if (t.pnl < 0) { row.losses += 1; row.lost += -t.pnl; }
    else row.flat += 1;
    row.net += t.pnl;
    by.set(d, row);
  }
  return [...by.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
}

/*
 * Lots transacted on each day, by product.
 *
 * The companion to lots held, and a different measurement. Held is a level — what was on
 * the book when the day ended, which is what margin is charged on and what you carried
 * overnight. Traded is a flow: how much changed hands. A desk that opens and closes inside
 * the session is flat every night and invisible on the held chart, however hard it worked.
 *
 * EVERY FILL COUNTS, both sides. Buying five and selling them again is ten lots traded,
 * which is what the exchange reports and what the broker bills commission on. It is not
 * "five, once", and the caption on the chart says so — the two readings differ by a factor
 * of two and somebody checking against a statement needs to know which one they are
 * looking at.
 *
 * Spread legs are skipped. The spread is the trade; counting its legs as well would book
 * the same volume twice, exactly as it would in the position engine.
 */
export function tradedByDay(fills, brokerIds = null) {
  const by = new Map();
  for (const f of fills || []) {
    if (f.is_leg || !f.ts) continue;
    const broker = f.broker || "default";
    if (brokerIds && !brokerIds.includes(broker)) continue;
    const lots = Math.abs(Number(f.qty) || 0);
    if (!lots || !f.product) continue;
    const d = dayKey(f.ts);
    const row = by.get(d) || { d, prod: {}, total: 0 };
    row.prod[f.product] = round4((row.prod[f.product] || 0) + lots);
    row.total = round4(row.total + lots);
    by.set(d, row);
  }
  return by;
}

/*
 * What each day was actually made of: the products traded, and what each one did.
 *
 * The daily row answers "what did the day make". This answers the question straight after
 * it — "made by what" — which is the one that changes tomorrow's trading. A day that nets
 * -$300 across twenty trades can be one product bleeding steadily and another carrying it,
 * and the daily row cannot tell those apart.
 *
 * Keyed by broker AND product. Two accounts trading the same symbol are two positions with
 * two margins that no broker will net, so merging them under one name would invent a
 * position the trader does not hold. The caller decides whether to print the broker.
 *
 * Ordered by what moved the needle: largest absolute P&L first, so the product that made or
 * cost the day is the first line read, not the alphabetically luckiest one. `lots` is the
 * size closed, which is what the round trips below it were worth — not lots traded, which
 * would count both sides.
 */
export function dayProducts(closed, realized) {
  const by = new Map();
  const at = (d, broker, product) => {
    const day = by.get(d) || new Map();
    const key = `${broker || "default"}|${product}`;
    const row = day.get(key) || {
      key, broker: broker || "default", product,
      trades: 0, lots: 0, wins: 0, losses: 0, flat: 0, net: 0, won: 0, lost: 0,
    };
    day.set(key, row);
    by.set(d, day);
    return row;
  };

  /*
   * MONEY FROM THE LEDGER, for the same reason the day above it takes its money there: a
   * partial close on a position still held is money with no finished trade behind it.
   *
   * This was missed when the day row moved and the products under it did not, so opening a
   * day showed parts that did not add up to it — a day of $2,982.50 breaking into one
   * product at -$1,000, with the other $3,995 nowhere. A breakdown that does not reconcile
   * with the thing it breaks down is worse than none.
   */
  for (const r of realized || []) {
    if (!r || !r.ts || !r.product) continue;
    at(dayKey(r.ts), r.broker, r.product).net += Number(r.pnl) || 0;
  }

  // Trades, lots, wins and losses are per-trade, so they come from the finished ones.
  for (const t of closed || []) {
    if (!t.closeTs) continue;
    const row = at(dayKey(t.closeTs), t.broker, t.product);
    row.trades += 1;
    row.lots = round4(row.lots + Math.abs(Number(t.qty) || 0));
    if (t.pnl > 0) { row.wins += 1; row.won += t.pnl; }
    else if (t.pnl < 0) { row.losses += 1; row.lost += -t.pnl; }
    else row.flat += 1;
  }

  const out = new Map();
  for (const [d, day] of by) {
    const rows = [...day.values()].map((r) => ({ ...r, net: round2(r.net), won: round2(r.won), lost: round2(r.lost) }));
    out.set(d, rows.sort((a, b) => Math.abs(b.net) - Math.abs(a.net) || a.product.localeCompare(b.product)));
  }
  return out;
}

/*
 * The daily table's rows, running total included.
 *
 * Shared by the screen and the CSV so the two cannot drift. A spreadsheet that disagrees
 * with the page it was exported from is worse than no export: the file is the one that
 * gets sent to an accountant, and nobody re-checks it against a screen they have closed.
 *
 * The running total accumulates in DATE order, always, whichever way the table happens to
 * be sorted at the time. It only means anything read forwards.
 */
export function dailyRows(closed, realized) {
  const money = moneyByDay(realized);
  const counts = new Map(winLossByDay(closed).map((r) => [r.d, r]));
  /*
   * Every day that has either. A day can have money and no finished trade — a partial close
   * on a position still held, or commission on a position just opened — and it has to appear
   * or the table quietly says nothing happened. A day can also have a trade finish with no
   * money of its own, when the P&L was booked on earlier days.
   */
  const days = [...new Set([...money.keys(), ...counts.keys()])].sort();
  let run = 0;
  return days.map((d) => {
    const c = counts.get(d) || { d, wins: 0, losses: 0, flat: 0, won: 0, lost: 0 };
    const net = money.has(d) ? money.get(d) : 0;
    run = round2(run + net);
    return { ...c, d, net, run, trades: c.wins + c.losses + c.flat };
  });
}

/** RFC4180 quoting: a product like "CL Nov26 - BZ, spread" must not become two columns. */
const csvCell = (v) => (/[",\n\r]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));

/*
 * The daily table as a CSV, days and the products under them.
 *
 * Always oldest first, whatever the screen is showing, because the Running column reads
 * down the file and is nonsense in any other order.
 *
 * One row per day, then one per product traded that day, told apart by the Scope column so
 * the file can be pivoted (filter Scope = Product) or read straight down. Product rows
 * carry no running total — a running total of one instrument among several is a figure
 * that looks meaningful and is not.
 *
 * `nameOf` turns a broker id into the name the trader knows it by.
 */
export function dailyCsv(closed, realized, nameOf = (id) => id) {
  const parts = dayProducts(closed, realized);
  const head = ["Date", "Scope", "Broker", "Product", "Trades", "Lots", "Won", "Lost", "Scratched", "P&L", "Running"];
  const out = [head.join(",")];
  for (const r of dailyRows(closed, realized)) {
    const on = parts.get(r.d) || [];
    const lots = round4(on.reduce((a, g) => a + g.lots, 0));
    out.push([r.d, "Day", "", "", r.trades, lots, r.wins, r.losses, r.flat, round2(r.net), round2(r.run)].map(csvCell).join(","));
    for (const g of on) {
      out.push([r.d, "Product", nameOf(g.broker), g.product, g.trades, g.lots, g.wins, g.losses, g.flat, round2(g.net), ""].map(csvCell).join(","));
    }
  }
  return out.join("\n");
}

/** Money to the cent. Exported figures are read as exact, so they are rounded like money. */
function round2(v) { return isFinite(v) ? Math.round(v * 100) / 100 : 0; }

/*
 * ---------------------------------------------------------------------------
 * REALIZED MONEY COMES FROM THE LEDGER, NOT FROM ROUND TRIPS
 * ---------------------------------------------------------------------------
 * computeBook keeps two tallies. `realized` has one entry per fill — every P&L booking and
 * every commission, the moment it happens. `closed` has one row per completed round trip.
 *
 * They are not the same money, and the difference is not small. Buy 5, sell 2 at a profit,
 * keep 3: the ledger says $3,995 and there is no closed trade at all, because nothing has
 * finished. Everything that summed `closed` therefore reported $0 for a day that made
 * $3,995 — the Closed tab's total, the Analysis strip, the daily table, the Positions
 * tiles — while the top bar, which sums the ledger, said $3,995. Two answers, both on
 * screen, to "what have I made".
 *
 * A second, quieter error rode along with it. A round trip closed by three fills over three
 * days books its whole P&L on the last of them, so the daily table put money on the wrong
 * day. The ledger books each piece on the day it was actually made.
 *
 * So: money from the ledger, always. Trade statistics — win rate, average win, profit
 * factor, streaks — stay on `closed`, because they are per-trade by nature and a trade that
 * has not finished has no result yet. The two answer different questions and now say so.
 */

/** Realized money per local day, from the ledger. Map of dayKey -> net. */
export function moneyByDay(realized) {
  const by = new Map();
  for (const r of realized || []) {
    if (!r || !r.ts) continue;
    const d = dayKey(r.ts);
    by.set(d, (by.get(d) || 0) + (Number(r.pnl) || 0));
  }
  for (const [d, v] of by) by.set(d, round2(v));
  return by;
}

/** Realized money per broker|product, from the ledger. Map of "broker|product" -> net. */
export function moneyByProduct(realized) {
  const by = new Map();
  for (const r of realized || []) {
    if (!r || !r.product) continue;
    const k = `${r.broker || "default"}|${r.product}`;
    by.set(k, (by.get(k) || 0) + (Number(r.pnl) || 0));
  }
  for (const [k, v] of by) by.set(k, round2(v));
  return by;
}

/** Ledger entries narrowed the way the screens narrow them. Dates are local calendar days. */
export function filterLedger(realized, { broker = "", product = "", from = "", to = "" } = {}) {
  return (realized || []).filter((r) => {
    if (!r || !r.ts) return false;
    if (broker && (r.broker || "default") !== broker) return false;
    if (product && r.product !== product) return false;
    if (from || to) {
      const d = dayKey(r.ts);
      if (from && d < from) return false;
      if (to && d > to) return false;
    }
    return true;
  });
}

/** The money in a set of ledger entries, to the cent. */
export const ledgerTotal = (entries) => round2((entries || []).reduce((a, r) => a + (Number(r.pnl) || 0), 0));

/*
 * ---------------------------------------------------------------------------
 * WHAT "TODAY" MEANS
 * ---------------------------------------------------------------------------
 * It used to be today's realized money PLUS the entire unrealized P&L of every open
 * position, however old. A position opened last week and sitting $3,000 down therefore
 * reported "Daily loss limit hit — stop trading today" on a day nothing was traded, and
 * would go on reporting it every day until it was closed. A winning open position hid a
 * genuinely bad day the same way. That figure drives a risk control, so it has to be the
 * day's result and nothing else.
 *
 * The day's result is the change in equity since the previous close, less any money paid
 * in or taken out today — a deposit is not a profit. The daily snapshot already records
 * each account's TNE, so the previous close is there to be read.
 *
 * Before there is a previous snapshot — a new account, or the first day — there is nothing
 * to measure the change against, so it falls back to realized money, which is always true
 * even if it is incomplete. Never a guess.
 */

/** The most recent recorded TNE for an account STRICTLY BEFORE `today`. Null if none. */
export function previousClose(history, brokerId, today) {
  let best = null;
  for (const r of history || []) {
    if (!r || r.b !== brokerId || !r.d || r.d >= today) continue;
    if (!best || r.d > best.d) best = r;
  }
  return best ? { d: best.d, tne: Number(best.tne) || 0 } : null;
}

/**
 * The day's P&L for one account.
 *
 * `cashToday` is deposits less withdrawals dated today: paying money in raises equity
 * without making a penny, so it comes straight back out.
 *
 * Returns { pnl, basis } — "change" when measured against a previous close, "realized"
 * when there is none to measure against, so the screen can say which it is.
 */
export function dayPnl({ tne, realizedToday, history, brokerId, today, cashToday = 0 }) {
  const prev = previousClose(history, brokerId, today);
  if (!prev) return { pnl: round2(realizedToday || 0), basis: "realized", since: null };
  return { pnl: round2((Number(tne) || 0) - prev.tne - (Number(cashToday) || 0)), basis: "change", since: prev.d };
}
