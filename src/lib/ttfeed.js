/*
 * TT fills arriving by feed (FIX Drop Copy, or a recovery replay of it), turned into the same fill
 * shape the CSV import produces, so both go through one duplicate check.
 *
 * Not wired into the app. Nothing calls this yet: it exists so scripts/fill-identity-check.mjs can
 * prove that a fill arriving by feed AND by CSV is stored once, before any feed is built.
 *
 * Tag numbers are standard FIX 4.2/4.4. How TT fills each one is UNVERIFIED — TT's documentation
 * could not be reached — see docs/fix-feasibility.md, section 13, before trusting any of it.
 */

// FIX side (54): 1 = Buy, 2 = Sell. Anything else (sell short, cross, …) is not a fill RAMP can place.
const SIDE = { 1: "Buy", 2: "Sell" };

// TransactTime (60) is UTC: 20260910-08:15:02.114 (milliseconds optional).
export function fixTime(s) {
  const m = String(s ?? "").match(/^(\d{4})(\d{2})(\d{2})-(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?/);
  if (!m) return null;
  return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +(m[7] || "0").padEnd(3, "0")));
}

/*
 * One Execution Report (8) → what it means for the book.
 *
 *   { kind: "fill", fill }          a new execution
 *   { kind: "bust", ref }           the execution with this ref never happened — remove it
 *   { kind: "correct", ref, fill }  replace that execution with this one
 *   { kind: "ignore", why }         an order event, not a fill
 *
 * msg is keyed by tag number: { 17: "E1", 31: "97.78", ... }.
 * productName(msg) turns TT's instrument into RAMP's product name ("CL Nov26"); RAMP's names come
 * from the TT Fills grid, so the feed must produce the same text or the trade looks like a
 * different product.
 *
 * The fill's identity is its ExecID (17), as "tt:<ExecID>". That assumes the session sends each
 * fill as its own report ("Send FillsGrp as Individual Execution Reports" ON) — with it off, one
 * report carries several fills and ExecID is not per fill.
 */
export function fromExecutionReport(msg, { broker, productName = (m) => m[55] } = {}) {
  const t = (n) => (msg[n] === undefined ? undefined : String(msg[n]).trim());
  const execType = t(150);
  // FIX 4.2 reports trades as ExecType 1/2 (partial / full); 4.4 as F. H is a bust, G a correction.
  const isTrade = execType === "F" || execType === "1" || execType === "2";
  if (execType === "H") return { kind: "bust", ref: `tt:${t(19)}` };
  if (!isTrade && execType !== "G") return { kind: "ignore", why: `ExecType ${execType}` };

  const ts = fixTime(t(60));
  const side = SIDE[t(54)];
  // LastQty (32) is THIS fill. CumQty (14) is the order's running total — summing that double-counts.
  const qty = Math.abs(Number(t(32)));
  const price = Number(t(31));
  const product = productName(msg);
  if (!t(17) || !ts || !side || !(qty > 0) || !Number.isFinite(price) || !product) {
    return { kind: "ignore", why: "incomplete fill report" };
  }
  const fill = {
    ts: ts.toISOString(),
    broker,
    product: String(product).trim(),
    side,
    qty,
    price,
    fee: 0, // clearer commission is not on the fill; RAMP's per-broker commission rate applies
    ref: `tt:${t(17)}`,
    account: t(1) || null,
    position: null,
    source: "tt-fix",
    order_id: t(37) || null,
    // MultiLegReportingType (442): 1 outright, 2 leg of a spread, 3 the spread itself.
    is_leg: t(442) === "2",
  };
  if (execType === "G") return { kind: "correct", ref: `tt:${t(19)}`, fill };
  return { kind: "fill", fill };
}

/*
 * A batch of feed events against what is stored.
 *
 * Returns the fills to add and the stored refs to remove. A bust that arrives before the fill it
 * cancels (it can, in a replay) is remembered in `voided`, so the fill is refused when it turns up.
 * classify is csv.js's classifyFills — the same duplicate check the CSV import uses.
 */
export function planFeed(events, stored, classify, voided = new Set()) {
  const v = new Set(voided);
  const remove = new Set();
  const fills = [];
  for (const e of events) {
    if (e.kind === "bust" || e.kind === "correct") { v.add(e.ref); remove.add(e.ref); }
    if (e.kind === "fill" || e.kind === "correct") fills.push(e.fill);
  }
  const live = fills.filter((f) => !v.has(f.ref));
  const keep = stored.filter((f) => !remove.has(f.ref));
  const add = classify(live, keep).rows.filter((r) => r.status === "new").map(({ key, status, matchTs, ...f }) => f);
  return { add, remove: [...remove].filter((r) => stored.some((f) => f.ref === r)), voided: v };
}
