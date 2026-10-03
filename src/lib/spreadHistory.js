import { plainAccount, subAccount, monthLabel } from "./orient.js";
import { RULES } from "./statementSpreads.js";

/*
 * The trader's spreads, rebuilt from the trades themselves.
 *
 * ---------------------------------------------------------------------------
 * WHY
 * ---------------------------------------------------------------------------
 * Orient closes each contract first-in-first-out on its own. A trader long CL–BZ Inter-Products
 * and short HO–CL Cracks has CL legs in both; closing a Crack sells CL, and Orient closes the
 * OLDEST CL lot — an Inter-Product's. After a few days the legs Orient still shows open come from
 * different trades, and any spread priced from them is one the trader never had (Aug 21: an
 * Inter-Product at −4.63 against real trades near −7.0). Orient's total is right; its split
 * between realised and unrealised, and between spreads, is a leg-by-leg one.
 *
 * ---------------------------------------------------------------------------
 * HOW
 * ---------------------------------------------------------------------------
 *   1. Every daily Trade Confirmation is read and each trade counted once — the sub-account's zip
 *      and the group's zip carry the same trades, under the same TradeEntryID.
 *   2. The legs of one spread trade share an ExchangeOrderID; a pair the rules recognise
 *      (statementSpreads.js) is one spread trade, at the price the legs imply.
 *   3. Spreads close against spreads of the same kind, first in first out. What no rule pairs
 *      is an outright, closed first in first out per contract.
 *
 * Checked against Orient two ways (checkHistory): the legs of the rebuilt book must be Orient's
 * open lots, contract by contract; and realised + unrealised must be Orient's realised +
 * unrealised. If either fails the history is incomplete or wrong, and the page says so rather
 * than showing it.
 *
 * Reading only. Nothing here touches the book.
 */

// One contract's worth in money per point of price: barrels for crude, gallons for heating oil.
export const MULTIPLIER = { CL: 1000, BZ: 1000, HO: 42000 };
const mult = (rule, a) => (rule.kind === "Calendar" ? MULTIPLIER[a.code] ?? null : 1000);

export const isTradeConfirmation = (name) => /^trade confirmation/i.test(String(name || "").trim());

const norm = (h) => String(h ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const PLAIN = /^-?\d+(\.\d+)?$/;
const r6 = (x) => (x === null || !isFinite(x) ? null : +x.toFixed(6));
const r2 = (x) => +(+x).toFixed(2);

const TC_COLUMNS = {
  tradeId: "TradeEntryID",
  orderId: "ExchangeOrderID",
  group: "Client group account number",
  sub: "Client sub account number",
  tradeDate: "TradeDate",
  code: "ClearingCode",
  month: "ContractExpiry",
  price: "TradePrice",
  side: "BuySell",
  qty: "Amount",
};
const TC_OPTIONAL = { time: "Execution Time", kind: "CallPutFut", comm: "FinalComm", fee: "Exchange Fee amount", nfa: "NFA amount" };

/*
 * Orient's "Trade Confirmation.csv": one row per leg fill, that day's trades. Read by column name,
 * strictly — anything in problems means nothing was read. Options are left out: the rules know
 * futures spreads only.
 */
export function readTradeConfirmations(rows) {
  const data = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim() !== ""));
  if (!data.length) return { trades: [], problems: ["The Trade Confirmation file is empty."] };
  const header = data[0].map(norm);
  const at = {}, missing = [];
  for (const [k, label] of Object.entries(TC_COLUMNS)) { const i = header.indexOf(norm(label)); if (i < 0) missing.push(label); else at[k] = i; }
  if (missing.length) return { trades: [], problems: [`The Trade Confirmation file has no ${missing.map((m) => `"${m}"`).join(", ")} column${missing.length === 1 ? "" : "s"}. Orient may have changed the layout.`] };
  for (const [k, label] of Object.entries(TC_OPTIONAL)) { const i = header.indexOf(norm(label)); if (i >= 0) at[k] = i; }

  const trades = [], problems = [];
  data.slice(1).forEach((r, idx) => {
    const cell = (k) => (at[k] === undefined ? "" : String(r[at[k]] ?? "").trim());
    const row = idx + 2;
    const num = (k) => { const v = cell(k); if (!PLAIN.test(v)) { problems.push(`Trade Confirmation row ${row}, "${TC_COLUMNS[k]}": "${v}" is not a plain number.`); return null; } return +v; };
    const side = cell("side").toUpperCase();
    if (side !== "B" && side !== "S") problems.push(`Trade Confirmation row ${row}, "BuySell": "${cell("side")}" is neither B nor S.`);
    const kind = (cell("kind") || "F").toUpperCase();
    const money = (k) => (PLAIN.test(cell(k)) ? +cell(k) : 0);
    trades.push({
      tradeId: cell("tradeId"), orderId: cell("orderId"), account: subAccount(cell("sub"), cell("group")), group: plainAccount(cell("group")),
      date: cell("tradeDate"), time: cell("time"), code: cell("code"), month: cell("month"), kind,
      side, price: num("price"), qty: num("qty"), fees: r2(money("comm") + money("fee") + money("nfa")),
    });
  });
  return problems.length ? { trades: [], problems } : { trades, problems };
}

// "8/19/2026 18:15" → minutes since midnight, for ordering within a day. Unknown sorts first.
const minutesOf = (t) => { const m = /(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : -1; };

/*
 * The trades from many statements, each counted once (same account, same TradeEntryID), in the
 * order they happened.
 */
export function uniqueTrades(lists) {
  const seen = new Set(), out = [];
  for (const list of lists) for (const t of list) {
    const k = `${t.account}|${t.tradeId}`;
    if (!t.tradeId || seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || minutesOf(a.time) - minutesOf(b.time) || a.tradeId.localeCompare(b.tradeId));
}

const legOf = (code, month) => ({ code, month, label: `${code} ${monthLabel(month)}` });

/*
 * The book as at a date (YYYYMMDD, inclusive): open spreads and outrights per account, with their
 * real entry prices, and P/L realised by closing spreads against spreads.
 */
export function spreadBook(trades, asOf) {
  const upTo = trades.filter((t) => t.kind === "F" && t.date <= asOf && t.price !== null && t.qty > 0);

  // 1. Each order: a spread trade if its legs are a pair the rules know, equal and opposite.
  const orders = new Map();
  for (const t of upTo) {
    // An id Excel has rounded (8.07E+12) is shared by every trade it touched: not an order id.
    const k = `${t.account}|${/^\d{6,}$/.test(t.orderId) ? t.orderId : `solo:${t.tradeId}`}`;
    if (!orders.has(k)) orders.set(k, []);
    orders.get(k).push(t);
  }
  const events = [];
  for (const list of orders.values()) {
    const legs = new Map();
    for (const t of list) {
      const k = `${t.code}|${t.month}`;
      const l = legs.get(k) || { ...legOf(t.code, t.month), lots: 0, cost: 0, gross: 0, first: t };
      l.lots += t.side === "B" ? t.qty : -t.qty; l.cost += t.price * t.qty; l.gross += t.qty;
      legs.set(k, l);
    }
    const ls = [...legs.values()].map((l) => ({ ...l, avg: l.cost / l.gross }));
    let paired = null;
    if (ls.length === 2 && ls[0].lots && Math.abs(ls[0].lots) === Math.abs(ls[1].lots) && Math.sign(ls[0].lots) !== Math.sign(ls[1].lots)) {
      for (const rule of RULES) for (const [a, b] of [[ls[0], ls[1]], [ls[1], ls[0]]]) if (!paired && rule.pair(a, b)) paired = { rule, a, b };
    }
    const account = list[0].account, at = list[0];
    if (paired) {
      const { rule, a, b } = paired;
      events.push({ at, account, key: `S|${account}|${rule.label(a, b)}`, kind: rule.kind, label: rule.label(a, b), sign: Math.sign(a.lots), qty: Math.abs(a.lots), price: rule.value(a.avg, b.avg), mult: mult(rule, a), legs: [a, b], rule });
    } else {
      // Not a spread the rules know: each leg is an outright trade.
      for (const t of list) events.push({ at: t, account, key: `O|${account}|${t.code}|${t.month}`, kind: "Outright", label: legOf(t.code, t.month).label, sign: t.side === "B" ? 1 : -1, qty: t.qty, price: t.price, mult: MULTIPLIER[t.code] ?? null, legs: [legOf(t.code, t.month)] });
    }
  }
  events.sort((x, y) => x.at.date.localeCompare(y.at.date) || minutesOf(x.at.time) - minutesOf(y.at.time) || x.at.tradeId.localeCompare(y.at.tradeId));

  // 2. First in, first out, within each spread kind and each outright contract.
  const books = new Map();
  const realised = {};
  for (const e of events) {
    const bk = books.get(e.key) || { ...e, open: [] };
    let q = e.qty;
    while (q > 0 && bk.open.length && bk.open[0].sign !== e.sign) {
      const h = bk.open[0], m = Math.min(q, h.qty);
      if (e.mult !== null) realised[e.account] = (realised[e.account] || 0) + h.sign * (e.price - h.price) * m * e.mult;
      h.qty -= m; q -= m;
      if (!h.qty) bk.open.shift();
    }
    if (q > 0) bk.open.push({ sign: e.sign, qty: q, price: e.price, date: e.at.date });
    books.set(e.key, bk);
  }

  const positions = [...books.values()].filter((bk) => bk.open.length).map((bk) => {
    const lots = bk.open.reduce((t, o) => t + o.sign * o.qty, 0);
    const gross = bk.open.reduce((t, o) => t + o.qty, 0);
    return {
      account: bk.account, kind: bk.kind, label: bk.label, lots,
      entry: r6(bk.open.reduce((t, o) => t + o.price * o.qty, 0) / gross),
      mult: bk.mult, legs: bk.legs.map((l, i) => ({ code: l.code, month: l.month, label: l.label, lots: i === 0 ? lots : -lots })),
      rule: bk.rule || null, since: bk.open[0].date,
    };
  });
  return { positions, realised: Object.fromEntries(Object.entries(realised).map(([k, v]) => [k, r2(v)])) };
}

/*
 * The book against Orient's own figures for that day.
 *
 * orientLots: readOpenPositions(...).lots for the day. orientRealised: { account: realised P/L
 * to date, from the daily Financial Summaries }. Returns the positions priced at Orient's
 * settlement, and whether the book can be trusted:
 *   legsMatch — every contract's net lots equal Orient's
 *   pnlGap    — (book realised + unrealised) − (Orient realised + unrealised), per account; 0
 *               when the two agree on what the trading has made in total
 */
export function checkHistory(book, orientLots, orientRealised = {}) {
  const settle = new Map(), orientNet = new Map(), orientUpl = {};
  for (const l of orientLots) {
    const k = `${l.account}|${l.code}|${l.month}`;
    settle.set(k, l.settle);
    orientNet.set(k, (orientNet.get(k) || 0) + (l.side === "B" ? l.qty : -l.qty));
    orientUpl[l.account] = (orientUpl[l.account] || 0) + l.upl;
  }
  const net = new Map();
  for (const p of book.positions) for (const l of p.legs) { const k = `${p.account}|${l.code}|${l.month}`; net.set(k, (net.get(k) || 0) + l.lots); }
  const keys = new Set([...net.keys(), ...orientNet.keys()]);
  const mismatches = [...keys].filter((k) => Math.abs((net.get(k) || 0) - (orientNet.get(k) || 0)) > 1e-9)
    .map((k) => ({ contract: k, book: net.get(k) || 0, orient: orientNet.get(k) || 0 }));

  const bookUpl = {};
  const positions = book.positions.map((p) => {
    const s = p.legs.map((l) => settle.get(`${p.account}|${l.code}|${l.month}`));
    const value = s.some((v) => v === undefined || v === null) ? null
      : p.kind === "Outright" ? s[0] : p.rule.value(s[0], s[1]);
    const upl = value === null || p.mult === null ? null : r2((value - p.entry) * p.lots * p.mult);
    if (upl !== null) bookUpl[p.account] = (bookUpl[p.account] || 0) + upl;
    return { ...p, settle: r6(value), upl };
  });
  const accounts = new Set([...Object.keys(bookUpl), ...Object.keys(orientUpl), ...Object.keys(book.realised)]);
  const pnlGap = {};
  for (const a of accounts) pnlGap[a] = r2((book.realised[a] || 0) + (bookUpl[a] || 0) - (orientRealised[a] || 0) - (orientUpl[a] || 0));
  const cents = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, r2(v)]));
  return { positions, legsMatch: !mismatches.length, mismatches, pnlGap, bookUpl: cents(bookUpl), orientUpl: cents(orientUpl) };
}
