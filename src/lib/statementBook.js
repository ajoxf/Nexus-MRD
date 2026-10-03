import Papa from "papaparse";
import { readFinancialSummary, readOpenPositions, isFinancialSummary, isOpenPosition, mainAccount } from "./orient.js";
import { readTradeConfirmations, isTradeConfirmation, uniqueTrades } from "./spreadHistory.js";
import { matchFills, accountOf } from "./fillMatch.js";
import { buildFeed } from "./brokerFeed.js";

/*
 * The saved statements, turned into a feed for each RAMP account they belong to.
 *
 * A RAMP account is fed by an Orient group when its fills carry that group's sub-accounts — TT's
 * "1003050011-GHF" is group 100305's sub-account 0011. No setting to make: the fills say it.
 *
 * Besides the feed (brokerFeed.js), each gets the moment its latest statement ends: the time of
 * the last of the account's fills that Orient booked on or before that statement's date. Fills
 * after it are "since the statement" — what the book adds to Orient's close.
 *
 * rows: the saved statements as db.loadStatements returns them. Returns { [brokerId]: feed }.
 */
const parse = (text) => Papa.parse(text || "", { skipEmptyLines: true }).data;

export function feedsFor(rows, fills, brokers) {
  const days = [], tradeLists = [];
  for (const r of rows || []) {
    if (!/daily/i.test(r.zip_name || "")) continue;
    const files = r.files || [];
    const fs = files.find((f) => isFinancialSummary(f.name));
    const op = files.find((f) => isOpenPosition(f.name));
    const tc = files.find((f) => isTradeConfirmation(f.name));
    const accounts = fs ? readFinancialSummary(parse(fs.text)).accounts : [];
    const lots = op ? readOpenPositions(parse(op.text)) : null;
    if (r.statement_date && accounts.length) days.push({ date: r.statement_date, accounts, lots: lots && !lots.problems.length ? lots.lots : null });
    if (tc) { const t = readTradeConfirmations(parse(tc.text)); if (!t.problems.length) tradeLists.push(t.trades); }
  }
  if (!days.length) return {};
  // The groups: each day's main account (the one every other account number starts with).
  const groups = [...new Set(days.map((d) => mainAccount(d.accounts)?.no).filter((g) => g && g.length <= 6))];
  const trades = uniqueTrades(tradeLists);
  const out = {};
  for (const b of brokers || []) {
    const mine = (fills || []).filter((f) => f.broker === b.id);
    const group = groups.find((g) => mine.some((f) => (accountOf(f.account) || "").startsWith(g)));
    if (!group) continue;
    const feed = buildFeed(days, group);
    if (!feed) continue;
    // Where the latest statement ends, from the fills Orient booked up to its date.
    const D = feed.date.replaceAll("-", "");
    const { pairs } = matchFills(mine, trades.filter((t) => t.account.startsWith(group)));
    const booked = pairs.filter((p) => p.date <= D).map((p) => p.ts).sort();
    feed.cutoff = booked.length ? booked[booked.length - 1] : `${feed.date}T23:59:59.999Z`;
    feed.closeTs = `${feed.date}T23:59:59.999Z`;
    out[b.id] = feed;
  }
  return out;
}

/*
 * P/L "since the close": what an account has made on everything — realised and open, at the given
 * prices — counted the same way at the latest close and now. Their difference is what has changed
 * since Orient's statement, whatever way each side splits realised from unrealised.
 */
export const pnlAt = (book, priceOf, sizeFn) =>
  book.realized.reduce((t, r) => t + r.pnl, 0) +
  book.open.reduce((t, p) => t + (p.side === "Long" ? 1 : -1) * (priceOf(p) - p.avg) * sizeFn(p.broker, p.product) * p.lots, 0);

/*
 * Your fills' own P/L at Orient's close, to set against Orient's: realised, and open at the
 * statement's settlement prices. Before commission and fees (those are Orient's figures, shown on
 * their own), so the two should agree to the cent when every fill is in RAMP and matched the way
 * Orient matches (first in, first out). unpriced: open positions with no settlement to price them.
 */
export function fillsPlAt(book, priceOf, sizeFn) {
  const realised = book.realized.reduce((t, r) => t + r.pnl, 0);
  let open = 0, unpriced = 0;
  for (const p of book.open) {
    const px = priceOf(p);
    if (px === null || px === undefined) { unpriced++; continue; }
    open += (p.side === "Long" ? 1 : -1) * (px - p.avg) * sizeFn(p.broker, p.product) * p.lots;
  }
  return { realised: +realised.toFixed(2), open: +open.toFixed(2), unpriced };
}
