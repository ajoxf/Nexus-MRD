import { computeBook } from "./positions.js";
import { isSpreadSymbol } from "./csv.js";
import { defaultSize } from "./contracts.js";
import { mainAccount, positionsOf } from "./orient.js";

/*
 * Orient's statements against RAMP's own book: the difference waterfall.
 *
 * One figure out of agreement says nothing about why. So the gap in net equity is broken
 * into the things that can cause it, each set against the same thing in RAMP over the same
 * days, and each with the place to put it right:
 *
 *   Orient's balance before the first statement loaded       vs RAMP's cash before that day
 *   + deposits and withdrawals in the period                 vs the Funds ledger
 *   + commission, fees and GST                               vs fill commission and charges
 *   + realized P/L                                           vs trades RAMP closed
 *   + interest, option premium (nothing in RAMP holds these)
 *   + days missing between statements
 *   = cash balance at the last statement
 *   + open P/L: Orient's, split into the positions that differ and the prices that differ
 *   = net equity
 *
 * By construction the lines add up from RAMP's net equity to Orient's. What is left over,
 * if anything, is printed as "unexplained" rather than spread across the lines — it means
 * this file has a bug, and it should be seen.
 *
 * READ-ONLY. Nothing here changes the book; it only says what differs.
 *
 * DAYS. Orient's statement day is the exchange's trading day. CME's day D runs from 17:00
 * Chicago on D−1 to 16:00 Chicago on D, so a fill is dated by moving it seven hours forward
 * and reading the date in Chicago (daylight saving included). A trade on a Dubai evening
 * belongs to the NEXT day's statement; reading dates by the trader's clock would put it in
 * the wrong one and report a difference that does not exist.
 */

export const TOL = 0.01;
const PRICE_TOL = 1e-6;
const near = (a, b, tol = TOL) => Math.abs(a - b) <= tol + 1e-9;
const sum = (arr, f) => arr.reduce((t, x) => t + f(x), 0);

const chicago = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" });
// "2026-10-01": the CME trading day a moment belongs to.
export const tradeDate = (ts) => chicago.format(new Date(new Date(ts).getTime() + 7 * 3600 * 1000));

// "BZ Dec26", "BZ DEC26", "bz  dec26" → "BZ DEC26". The key an Orient contract and a RAMP leg share.
export const contractKey = (s) => String(s || "").trim().toUpperCase().replace(/\s+/g, " ");

/**
 * statements: [{ date: "YYYY-MM-DD", accounts, lots }] — accounts from readFinancialSummary,
 *   lots from readOpenPositions (null when the day's zip had no Open Position file).
 * fills: RAMP's fills for this broker account, commission already applied (withCommission).
 * cash: the account's ACCEPTED Funds entries.
 * account: { capital, products, method, includeRealized } — the RAMP broker account.
 * marks: { [product]: price } — the prices typed on the Positions tab.
 * chargeTotal(entry, at): what a MONTHLY charge has cost up to a moment.
 * sizeOf(product): the contract size RAMP uses for a spread or outright product.
 */
export function reconcile({ statements, fills, cash = [], account, marks = {}, chargeTotal, sizeOf }) {
  const days = [...statements].filter((s) => s.date && s.accounts?.length).sort((a, b) => a.date.localeCompare(b.date));
  if (!days.length) return null;
  const first = days[0], last = days[days.length - 1];
  const mainOf = (d) => mainAccount(d.accounts);
  const m0 = mainOf(first), mN = mainOf(last);
  if (!m0 || !mN) return { error: "The statements don't name one main account." };
  if (m0.no !== mN.no) return { error: `The statements are for different accounts (${m0.no} and ${mN.no}).` };

  const inWindow = (ts) => { const d = tradeDate(ts); return d >= first.date && d <= last.date; };
  const before = (ts) => tradeDate(ts) < first.date;
  const upTo = (ts) => tradeDate(ts) <= last.date;

  // ---------- RAMP, as of the last statement's close ----------
  const fillsToDate = fills.filter((f) => upTo(f.ts));
  const book = computeBook(fillsToDate, (_b, p) => sizeOf(p), () => account.method || "fifo");
  const realizedIn = (pred) => book.realized.filter((r) => pred(r.ts));

  const moves = cash.filter((c) => c.type === "deposit" || c.type === "withdrawal");
  const fromLedger = moves.length > 0;
  const netMoves = (pred) => sum(moves.filter((c) => pred(c.ts)), (c) => (c.type === "deposit" ? 1 : -1) * +c.amount);
  const base = (pred) => (fromLedger ? netMoves(pred) : (+account.capital || 0));
  const countsRealized = fromLedger || account.includeRealized !== false;
  // Charges (market data, platform…) that had accrued by a moment. A monthly charge accrues
  // month by month (chargeTotal); a one-off counts from its own date and not before.
  const charges = (atTs) => sum(cash.filter((c) => c.type === "charge"), (c) =>
    c.recurring === "monthly" ? chargeTotal(c, atTs) : new Date(c.ts) <= atTs ? +c.amount : 0);
  // The end of a trading day, as a moment: 16:00 Chicago on that day is safely inside it,
  // and nothing in the ledger is timed more finely than a day.
  const closeOf = (date) => new Date(`${date}T21:00:00Z`);
  const dayBefore = (date) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };

  const rampCashBefore = base(before) + (countsRealized ? sum(realizedIn(before), (r) => r.pnl) : 0) - charges(closeOf(dayBefore(first.date)));
  const rampDeposits = fromLedger ? netMoves(inWindow) : 0;
  const rampFees = sum(realizedIn(inWindow).filter((r) => r.fee), (r) => r.pnl) - (charges(closeOf(last.date)) - charges(closeOf(dayBefore(first.date))));
  const rampRealized = countsRealized ? sum(realizedIn(inWindow).filter((r) => !r.fee), (r) => r.pnl) : 0;
  const rampCash = rampCashBefore + rampDeposits + rampFees + rampRealized;

  // ---------- Orient, over the same days ----------
  const flows = (k) => sum(days, (d) => mainOf(d)[k]);
  const oDeposits = flows("cashAdj");
  const oFees = flows("commission") + flows("fee") + flows("gst");
  const oRealized = flows("pl");
  const oOther = flows("optPremium") + flows("interest");
  // If every day were loaded, ending = beginning + flows. What isn't is the days not loaded.
  const oGaps = mN.ending - (m0.beginning + oDeposits + oFees + oRealized + oOther);

  // ---------- Open positions: legs against Orient's lots ----------
  const lots = last.lots || [];
  const oPositions = positionsOf(lots.filter((l) => l.account.startsWith(mN.no)));
  const settleOf = new Map(oPositions.map((p) => [contractKey(p.label), p]));
  // Orient's own contract size per product code, read back from its P/L.
  const orientSize = new Map(oPositions.filter((p) => p.size).map((p) => [p.code, p.size]));
  const legSize = (product) => orientSize.get(contractKey(product).split(" ")[0]) || defaultSize(product);

  // A spread is booked as the spread; its legs are kept beside it. Orient lists legs, so legs
  // are what is compared — the stored legs of spreads, plus outright futures as they are.
  const isSpread = (f) => !f.is_leg && isSpreadSymbol(f.product);
  const legOrders = new Set(fillsToDate.filter((f) => f.is_leg && f.order_id).map((f) => f.order_id));
  const legFills = fillsToDate.filter((f) => f.is_leg || !isSpread(f)).map((f) => ({ ...f, is_leg: false }));
  const legBook = computeBook(legFills, (_b, p) => legSize(p), () => account.method || "fifo");
  const openSpreads = book.open.filter((p) => isSpreadSymbol(p.product));
  // Spreads still open whose fills came without legs: their legs cannot be compared.
  const legless = fillsToDate.filter((f) => isSpread(f) && !(f.order_id && legOrders.has(f.order_id)))
    .filter((f) => openSpreads.some((p) => p.product === f.product));

  const rampLegs = new Map(legBook.open.map((p) => [contractKey(p.product), { lots: (p.side === "Long" ? 1 : -1) * p.lots, avg: p.avg, product: p.product }]));
  const keys = [...new Set([...settleOf.keys(), ...rampLegs.keys()])].sort();
  const positions = keys.map((k) => {
    const o = settleOf.get(k), r = rampLegs.get(k);
    const oLots = o ? o.lots : 0, rLots = r ? r.lots : 0;
    const lotsMatch = oLots === rLots;
    const avgMatch = !o || !r || Math.abs(o.avg - r.avg) <= 1e-4;
    return {
      contract: o?.label || r.product, orient: o ? { lots: o.lots, avg: o.avg, settle: o.settle, upl: o.upl } : null,
      ramp: r ? { lots: r.lots, avg: +r.avg.toFixed(6) } : null, match: lotsMatch && avgMatch, lotsMatch, avgMatch,
    };
  });

  // RAMP's open legs valued at Orient's settlement prices. A leg Orient doesn't hold has no
  // settlement price in the file; it is counted under "positions", which is where it differs.
  const rampAtSettle = sum([...rampLegs.entries()], ([k, r]) => {
    const o = settleOf.get(k);
    return o && o.settle !== null ? (o.settle - r.avg) * r.lots * legSize(r.product) : 0;
  });
  // RAMP's open spreads and outrights valued at the prices typed on the Positions tab — what
  // RAMP's own open P/L would read.
  const rampAtMarks = sum(book.open, (p) => {
    const mark = marks[p.product] !== undefined && marks[p.product] !== "" && isFinite(+marks[p.product]) ? +marks[p.product] : p.avg;
    return (p.side === "Long" ? 1 : -1) * (mark - p.avg) * sizeOf(p.product) * p.lots;
  });
  const unmarked = book.open.filter((p) => !(marks[p.product] !== undefined && marks[p.product] !== "" && isFinite(+marks[p.product]))).map((p) => p.product);

  // ---------- Margin ----------
  const rampIM = sum(book.open, (p) => (+account.products?.[p.product]?.margin || 0) * p.lots);
  const products = [...new Set(book.open.map((p) => p.product))];
  let impliedMargin = null;
  if (products.length === 1 && !near(mN.im, rampIM)) {
    const lotsOpen = sum(book.open, (p) => p.lots);
    impliedMargin = { product: products[0], perLot: lotsOpen ? mN.im / lotsOpen : null, current: +account.products?.[products[0]]?.margin || 0, lots: lotsOpen };
  }

  // ---------- The waterfall ----------
  const rampTNE = rampCash + rampAtMarks;
  const oFX = mN.upl - mN.foUpl;           // FX unrealised: nothing in RAMP holds it
  const line = (key, label, orient, ramp, fix) => ({ key, label, orient, ramp, diff: orient - ramp, ok: near(orient, ramp), fix });
  const lines = [
    line("opening", `Balance before ${first.date}`, m0.beginning, rampCashBefore,
      "Differences from before the first statement loaded. Load earlier statements to see which day they come from."),
    line("deposits", "Deposits and withdrawals", oDeposits, rampDeposits,
      fromLedger ? "Record the missing deposit or withdrawal in Funds above." : "RAMP is using the Capital in Settings, not a ledger. Record your deposits in Funds above."),
    line("fees", "Commission, fees and GST", oFees, rampFees,
      "Set Orient's commission per lot in Settings, or record the charge in Funds above."),
    line("realized", "Realized P/L", oRealized, rampRealized,
      "A missing or duplicated fill. Compare the Fills tab for these days with Orient's confirmations."),
    line("other", "Interest and option premium", oOther, 0, "Orient items with no place in RAMP yet. Record them as a charge in Funds if they matter."),
    line("gaps", "Days missing between statements", oGaps, 0, "Load the statements for the missing days; the day-to-day check above names them."),
  ];
  const cashLine = line("cash", `Cash balance at ${last.date}`, mN.ending, rampCash, null);
  const openLines = [
    line("positions", "Open positions", mN.foUpl, rampAtSettle,
      legless.length ? `${legless.length} spread fill${legless.length === 1 ? " was" : "s were"} imported without legs, so their positions can't be compared. Re-import that file.` : "Compare the positions below; a missing or extra fill is the usual cause."),
    { ...line("prices", "Your prices vs Orient's settlement", rampAtSettle, rampAtMarks,
      unmarked.length ? `No price typed for ${unmarked.join(", ")}: RAMP values it at its entry. Type Orient's settlement on the Positions tab.` : "Type Orient's settlement prices on the Positions tab."),
      orientLabel: "RAMP at Orient's settlement", rampLabel: "RAMP at your prices" },
    line("fx", "FX unrealised P/L", oFX, 0, "Orient's FX positions; RAMP doesn't hold these."),
    line("collateral", "Collateral", mN.collateral, 0, "Non-cash collateral at Orient; RAMP doesn't hold this."),
  ];
  // prices: orient side is "at settlement", ramp side "at your prices" — diff is what the
  // prices move. Its orient figure is RAMP's own valuation, so it is relabelled for display.
  const tneLine = line("tne", `Net equity at ${last.date}`, mN.tne, rampTNE, null);
  const explained = sum([...lines, ...openLines], (l) => l.diff);
  const unexplained = +(tneLine.diff - explained).toFixed(6);

  return {
    account: mN.no, ccy: mN.ccy, from: first.date, to: last.date, days: days.length,
    lines, cashLine, openLines, tneLine, unexplained,
    im: { orient: mN.im, ramp: rampIM, ok: near(mN.im, rampIM), implied: impliedMargin },
    positions, positionsMatch: positions.every((p) => p.match), legless: legless.length,
    noPositionsFile: !last.lots,
  };
}
