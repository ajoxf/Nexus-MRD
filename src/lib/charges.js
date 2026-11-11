/*
 * What the desk is actually charged, itemised, with the date of every charge.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST THE "FEE" COLUMN
 * ---------------------------------------------------------------------------
 * The daily Financial Summary has two charge columns, "Commission" and "Fee", and "Fee" is a
 * bucket: per-trade exchange and clearing fees sit in it alongside the monthly platform and
 * market-data bills. On 27 Oct 2026 "Fee" was -740.00 and not one cent of it was a trade — it
 * was TT Pro, TT MAP and two market-data feeds for September. Reading "Fee" as a cost of
 * trading would have been wrong by the whole amount.
 *
 * So the split is taken from the files that itemise, and checked against the summary:
 *
 *   Commission, exchange fee, NFA   Trade Confirmation.csv, per trade
 *                                   ("FinalComm", "Exchange Fee amount", "NFA amount")
 *   Platform, market data, MAP      Journal Record - <account> - <date>.csv, per journal entry
 *                                   (Journal Code, with Orient's own description and period)
 *   Everything else                 the residual: what the summary charged, less what the two
 *                                   files above explain. Shown as its own line, never spread
 *                                   across the others.
 *
 * The residual is the honest part. Orient only began including Journal Record files with the
 * 26 Oct 2026 statements, so an earlier monthly bill — 440.00 on 23 Sep 2026, on a day with no
 * trades at all — has no journal line to name it. It shows as an unidentified non-trade charge
 * on its date rather than being guessed into "platform".
 *
 * SIGNS. Orient writes charges negative, because its columns add straight into the balance.
 * This module reports COSTS: a positive number is money out. A negative cost is therefore a
 * credit, and there is a real one — commission on 21 Aug 2026 was +311.50 against -9.80 of
 * trade commission, a rebate. It is reported as a negative cost, not hidden.
 *
 * Reading only. Nothing here changes the book or the statements.
 */

import { readFinancialSummary, isFinancialSummary, plainAccount } from "./orient.js";
import { readTradeConfirmations, uniqueTrades } from "./spreadHistory.js";

const norm = (h) => String(h ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const PLAIN = /^-?\d+(\.\d+)?$/;
const r2 = (x) => +(+x).toFixed(2);
// A cent either way is a match, as everywhere else that checks Orient's arithmetic.
export const TOL = 0.01;

export const isJournalRecord = (fileName) => /^journal record\b/i.test(String(fileName || "").trim());
export const isTradeConfirmation = (fileName) => /^trade confirmation\b/i.test(String(fileName || "").trim());

export const JOURNAL_COLUMNS = {
  account: "Account Number",
  settle: "Settlement Date",
  side: "Journal Side",
  id: "Journal ID",
  code: "Journal Code",
  amount: "Amount",
  ccy: "Currency",
  descr: "Statement Description",
};

/*
 * The categories, in the order they are shown. `trade` marks a charge that scales with trading;
 * the rest are standing costs, which is the distinction that matters when reading the total.
 */
export const CATEGORIES = [
  { key: "commission", label: "Broker commission", trade: true },
  { key: "exchange", label: "Exchange & clearing fees", trade: true },
  { key: "nfa", label: "NFA fees", trade: true },
  { key: "platform", label: "Platform fee", trade: false },
  { key: "marketData", label: "Market data", trade: false },
  { key: "map", label: "MAP fees", trade: false },
  { key: "other", label: "Other charges", trade: false },
];
export const CATEGORY_KEYS = CATEGORIES.map((c) => c.key);
export const labelOf = (key) => CATEGORIES.find((c) => c.key === key)?.label || key;

/*
 * A Journal Code → one of the categories above.
 *
 * Matched on Orient's own codes ("PLATFORM FEE-TT", "MKT DATA-CME", "MAP FEES"). The exchange
 * suffix is deliberately not part of the match: a market-data feed is market data whether it
 * says CME, ICE or SGX. Anything unrecognised becomes "other" and keeps its description, so a
 * new kind of charge is reported rather than silently dropped.
 */
export function categoryOfJournalCode(code) {
  const c = norm(code);
  if (/platform\s*fee/.test(c)) return "platform";
  if (/(mkt|market)\s*data/.test(c)) return "marketData";
  if (/\bmap\b/.test(c)) return "map";
  if (/commission|brokerage/.test(c)) return "commission";
  if (/exchange|clearing/.test(c)) return "exchange";
  return "other";
}

/*
 * Orient's "Journal Record - <account> - <date>.csv": non-trade money in and out. Read by column
 * NAME and strictly, as every other statement reader here is — anything in `problems` means
 * nothing was read.
 *
 * The file is usually just a header, which is not a problem: a day with no journal entries is an
 * ordinary day. `entries` is then empty and `problems` is too.
 */
export function readJournalRecords(rows) {
  const data = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim() !== ""));
  if (!data.length) return { entries: [], problems: [] };

  const header = data[0].map(norm);
  const at = {}, missing = [];
  for (const [k, label] of Object.entries(JOURNAL_COLUMNS)) {
    const i = header.indexOf(norm(label));
    if (i < 0) missing.push(label); else at[k] = i;
  }
  if (missing.length) {
    return { entries: [], problems: [`The Journal Record file has no ${missing.map((m) => `"${m}"`).join(", ")} column${missing.length === 1 ? "" : "s"}. Orient may have changed the layout.`] };
  }

  const entries = [], problems = [];
  data.slice(1).forEach((r, idx) => {
    const cell = (k) => String(r[at[k]] ?? "").trim();
    const row = idx + 2;
    const raw = cell("amount");
    if (!PLAIN.test(raw)) { problems.push(`Journal Record row ${row}, "Amount": "${raw}" is not a plain number.`); return; }
    const side = cell("side");
    const s = norm(side);
    if (s !== "debit" && s !== "credit") { problems.push(`Journal Record row ${row}, "Journal Side": "${side}" is neither Debit nor Credit.`); return; }
    const code = cell("code");
    // A debit is money out of the account, so a debit is a cost. Orient writes the Amount
    // unsigned here and puts the direction in its own column, unlike the summary columns.
    const cost = r2(s === "debit" ? +raw : -(+raw));
    entries.push({
      id: cell("id"), account: plainAccount(cell("account")), date: cell("settle"),
      code, category: categoryOfJournalCode(code), cost, ccy: cell("ccy"), descr: cell("descr"),
    });
  });
  return problems.length ? { entries: [], problems } : { entries, problems };
}

/*
 * Every journal entry across many statements, counted once.
 *
 * The group's zip and each sub-account's zip carry the same entries under the same Journal ID,
 * so the id is what makes one charge one charge. An entry with no id falls back to everything
 * that identifies it, so it is still not counted twice.
 */
export function uniqueJournalEntries(lists) {
  const seen = new Set(), out = [];
  for (const list of lists || []) for (const e of list || []) {
    const k = e.id ? `id|${e.id}` : `x|${e.account}|${e.date}|${e.code}|${e.cost}|${e.descr}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out.sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.code).localeCompare(String(b.code)) || String(a.descr).localeCompare(String(b.descr)));
}

// "20261027" or "2026-10-27" → "2026-10-27". Anything else is returned as given.
const isoDate = (s) => {
  const t = String(s ?? "").trim();
  const m = /^(\d{4})-?(\d{2})-?(\d{2})$/.exec(t);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : t;
};

/*
 * days: the statements, read —
 *   [{ date: "YYYY-MM-DD", files: [{ name, rows }] }]
 * where rows is the CSV as an array of arrays (Papa.parse(text).data), any order, the group's
 * zips and the sub-accounts' mixed. group: the group's account number ("100305").
 *
 * Returns { byDate, totals, lines, journal, problems, days, dates }:
 *   byDate   one row per date that had a charge: a cost per category, plus what the summary
 *            said and what is left unexplained
 *   totals   the same categories summed over every date
 *   lines    every individual charge with its date — the itemised list, journal entries named
 *            by Orient's own description, trade charges rolled up per day per category
 *   journal  the named non-trade charges on their own, newest first
 *   problems anything that stopped a file being read, and any day whose categories do not add
 *            back to Orient's own Commission and Fee to the cent
 */
export function buildCharges(days, group) {
  const g = plainAccount(group);
  const mine = (days || []).filter((d) => d && d.date);
  const problems = [];

  // --- the summary's own daily totals, which everything is checked against -------------------
  // The group's row when the group's zip is open, else its sub-accounts added up. Taking both
  // would be the same money twice: the group row IS the subs' sum.
  const summary = new Map();
  for (const date of [...new Set(mine.map((d) => d.date))]) {
    const subs = new Map();
    let groupRow = null;
    for (const d of mine.filter((x) => x.date === date)) {
      for (const f of d.files || []) {
        if (!isFinancialSummary(f.name)) continue;
        const { accounts, problems: p } = readFinancialSummary(f.rows);
        if (p.length) { problems.push(`${f.name}: ${p[0]}`); continue; }
        for (const a of accounts) {
          if (a.no === g) groupRow = groupRow || a;
          else if (a.no.startsWith(g) && !subs.has(a.no)) subs.set(a.no, a);
        }
      }
    }
    const add = (k) => r2([...subs.values()].reduce((t, a) => t + (a[k] || 0), 0));
    const row = groupRow ? { commission: r2(groupRow.commission || 0), fee: r2(groupRow.fee || 0) }
      : subs.size ? { commission: add("commission"), fee: add("fee") } : null;
    if (row) summary.set(date, row);
  }

  // --- the per-trade charges ------------------------------------------------------------------
  const tcLists = [];
  for (const d of mine) for (const f of d.files || []) {
    if (!isTradeConfirmation(f.name)) continue;
    const { trades, problems: p } = readTradeConfirmations(f.rows);
    if (p.length) { problems.push(`${f.name} (${d.date}): ${p[0]}`); continue; }
    tcLists.push(trades.filter((t) => t.group === g || String(t.account).startsWith(g)));
  }
  const trades = uniqueTrades(tcLists);

  // --- the named non-trade charges ------------------------------------------------------------
  const jLists = [];
  for (const d of mine) for (const f of d.files || []) {
    if (!isJournalRecord(f.name)) continue;
    const { entries, problems: p } = readJournalRecords(f.rows);
    if (p.length) { problems.push(`${f.name}: ${p[0]}`); continue; }
    jLists.push(entries.filter((e) => !e.account || e.account.startsWith(g)));
  }
  const journal = uniqueJournalEntries(jLists);

  // --- assemble, date by date -----------------------------------------------------------------
  const blank = () => Object.fromEntries(CATEGORY_KEYS.map((k) => [k, 0]));
  const rows = new Map();
  const touch = (date) => {
    if (!rows.has(date)) rows.set(date, { date, ...blank(), tradeCommission: 0, trades: 0, named: [] });
    return rows.get(date);
  };

  // Trade charges, by the date the statement covers. Orient writes them negative; a cost is positive.
  for (const t of trades) {
    const date = isoDate(t.date);
    const row = touch(date);
    row.commission = r2(row.commission - (t.comm || 0));
    row.tradeCommission = r2(row.tradeCommission - (t.comm || 0));
    row.exchange = r2(row.exchange - (t.exchFee || 0));
    row.nfa = r2(row.nfa - (t.nfa || 0));
    row.trades += 1;
  }

  // Named non-trade charges, by their settlement date.
  for (const e of journal) {
    const row = touch(isoDate(e.date));
    row[e.category] = r2((row[e.category] || 0) + e.cost);
    row.named.push(e);
  }

  // Orient's own totals, and the residual. The summary is the authority on what was charged:
  // where the itemised files explain less than it says, the difference is a real charge whose
  // name we do not have, and it is shown as one.
  for (const [date, s] of summary) {
    const row = touch(date);
    row.summaryCommission = r2(-s.commission);
    row.summaryFee = r2(-s.fee);
    // Commission is stated directly by the summary, so trust it and show any gap against the
    // trades for what it is: an adjustment or rebate posted outside the trade file.
    row.commissionAdjustment = r2(row.summaryCommission - row.tradeCommission);
    row.commission = row.summaryCommission;
    // The Fee bucket, less everything named in it.
    const namedFee = r2(row.exchange + row.nfa + row.platform + row.marketData + row.map);
    row.other = r2(row.other + r2(row.summaryFee - namedFee));
  }

  // A date with trades or journal entries but no summary cannot be reconciled; say so once.
  for (const row of rows.values()) {
    if (row.summaryFee === undefined) {
      row.summaryCommission = row.commission;
      row.summaryFee = r2(row.exchange + row.nfa + row.platform + row.marketData + row.map + row.other);
      row.commissionAdjustment = 0;
      row.unreconciled = true;
      problems.push(`${row.date}: charges found but no Financial Summary for the group, so they are not checked against Orient's own totals.`);
    }
    row.total = r2(CATEGORY_KEYS.reduce((t, k) => t + (row[k] || 0), 0));
    // The check: the categories must add back to what Orient charged, to the cent.
    const want = r2(row.summaryCommission + row.summaryFee);
    if (Math.abs(row.total - want) > TOL) {
      problems.push(`${row.date}: the itemised charges come to ${row.total.toFixed(2)} but Orient's Commission and Fee come to ${want.toFixed(2)}.`);
    }
  }

  const byDate = [...rows.values()]
    .filter((r) => CATEGORY_KEYS.some((k) => Math.abs(r[k] || 0) > 0.0049))
    .sort((a, b) => a.date.localeCompare(b.date));

  const totals = blank();
  for (const r of byDate) for (const k of CATEGORY_KEYS) totals[k] = r2(totals[k] + (r[k] || 0));
  totals.total = r2(CATEGORY_KEYS.reduce((t, k) => t + totals[k], 0));
  totals.trade = r2(CATEGORIES.filter((c) => c.trade).reduce((t, c) => t + totals[c.key], 0));
  totals.standing = r2(totals.total - totals.trade);

  /*
   * The itemised list. A journal entry is one line, with Orient's own wording — that is where
   * "TT Pro - Transaction - Sep 2026" comes from, and it is the only place the PERIOD a charge
   * covers is written down, which is not its date: September's platform fee was taken on 27 Oct.
   * Trade charges are one line per day per category; naming 216 individual exchange fees would
   * bury the thing being looked for.
   */
  const lines = [];
  for (const r of byDate) {
    for (const e of r.named) {
      lines.push({ date: r.date, category: e.category, label: labelOf(e.category), detail: e.descr || e.code, code: e.code, cost: e.cost, kind: "journal" });
    }
    const namedIn = new Set(r.named.map((e) => e.category));
    if (Math.abs(r.tradeCommission) > 0.0049) lines.push({ date: r.date, category: "commission", label: labelOf("commission"), detail: `${r.trades} trade${r.trades === 1 ? "" : "s"}`, cost: r.tradeCommission, kind: "trade" });
    if (Math.abs(r.commissionAdjustment || 0) > 0.0049) lines.push({ date: r.date, category: "commission", label: labelOf("commission"), detail: r.commissionAdjustment < 0 ? "Commission credit or rebate" : "Commission adjustment", cost: r.commissionAdjustment, kind: "adjustment" });
    if (!namedIn.has("exchange") && Math.abs(r.exchange) > 0.0049) lines.push({ date: r.date, category: "exchange", label: labelOf("exchange"), detail: `${r.trades} trade${r.trades === 1 ? "" : "s"}`, cost: r.exchange, kind: "trade" });
    if (!namedIn.has("nfa") && Math.abs(r.nfa) > 0.0049) lines.push({ date: r.date, category: "nfa", label: labelOf("nfa"), detail: `${r.trades} trade${r.trades === 1 ? "" : "s"}`, cost: r.nfa, kind: "trade" });
    if (!namedIn.has("other") && Math.abs(r.other) > 0.0049) lines.push({ date: r.date, category: "other", label: labelOf("other"), detail: r.trades ? "Not itemised by Orient" : "Not itemised by Orient — no trades this day", cost: r.other, kind: "residual" });
  }
  lines.sort((a, b) => b.date.localeCompare(a.date) || Math.abs(b.cost) - Math.abs(a.cost));

  return {
    byDate, totals, lines,
    journal: [...journal].reverse(),
    problems,
    days: byDate.length,
    dates: byDate.length ? { from: byDate[0].date, to: byDate[byDate.length - 1].date } : null,
  };
}
