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
  // Drawn as bars broken down by product rather than as a line. See MarginHistory.
  { key: "lots", label: "Lots held", fmt: "lots", stacked: true },
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
export function winLossByDay(closed) {
  const by = new Map();
  for (const t of closed || []) {
    if (!t.closeTs) continue;
    const d = dayKey(t.closeTs);
    const row = by.get(d) || { d, wins: 0, losses: 0, flat: 0, net: 0 };
    if (t.pnl > 0) row.wins += 1;
    else if (t.pnl < 0) row.losses += 1;
    else row.flat += 1;
    row.net += t.pnl;
    by.set(d, row);
  }
  return [...by.values()].sort((a, b) => (a.d < b.d ? -1 : 1));
}
