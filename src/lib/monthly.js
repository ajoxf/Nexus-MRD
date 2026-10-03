import { plainAccount } from "./orient.js";
import { matchFills } from "./fillMatch.js";

/*
 * Orient's monthly statement — a password-protected PDF, read in the browser.
 *
 * The PDF's text comes out as positioned fragments. linesFromItems puts them back into the lines
 * a reader sees (same height = same line, left to right), and readMonthlyStatement picks out what
 * RAMP checks: the Financial Summary, the journal entries, the month's trades and fees, realised
 * P&L per contract, and the open positions at month end.
 *
 * Nothing here touches the book. It reads, and checkMonthly checks Orient's arithmetic and ties
 * the month to the daily statements.
 */

// Orient's PDFs use non-breaking hyphens and spaces ("1‑00305‑001‑1"); they are ordinary ones.
const clean = (s) => String(s ?? "").replace(/[‐-―−]/g, "-").replace(/[   ]/g, " ").replace(/\s+/g, " ").trim();

/*
 * pages: [[{ str, x, y }]] per page (pdf.js text items: x, y from the item's transform). Returns
 * lines top to bottom, page by page: { page, y, cells: [{ str, x }] , text }.
 */
export function linesFromItems(pages, tolerance = 3) {
  const out = [];
  pages.forEach((items, p) => {
    const sorted = items.map((i) => ({ str: clean(i.str), x: i.x, y: i.y })).filter((i) => i.str).sort((a, b) => b.y - a.y || a.x - b.x);
    let cur = null;
    for (const it of sorted) {
      if (!cur || Math.abs(cur.y - it.y) > tolerance) { cur = { page: p + 1, y: it.y, cells: [] }; out.push(cur); }
      cur.cells.push({ str: it.str, x: it.x });
    }
  });
  for (const l of out) { l.cells.sort((a, b) => a.x - b.x); l.text = l.cells.map((c) => c.str).join("  "); }
  return out;
}

const MONEY = /^\(?-?[\d,]*\.?\d+\)?$/;
export const money = (s) => {
  const t = clean(s);
  if (!MONEY.test(t)) return null;
  const v = +t.replace(/[(),]/g, "");
  return /^\(.*\)$/.test(t) ? -v : v;
};
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
// Orient's product names, as the monthly writes them, to the codes the daily files use.
export const PRODUCTS = [[/brent crude/i, "BZ"], [/light sweet crude|wti/i, "CL"], [/ny harbor ulsd|heating oil|ulsd/i, "HO"]];
const productOf = (text) => PRODUCTS.find(([re]) => re.test(text))?.[1] || null;
// "Oct 2026" → "202610"
const monthOf = (text) => { const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\s+(\d{4})\b/i.exec(text); return m ? `${m[2]}${String(MONTHS[m[1].toLowerCase()]).padStart(2, "0")}` : null; };

const SECTIONS = ["JOURNAL ENTRIES", "MONTHLY SUMMARY OF TRADES", "RECAP OF CONFIRMATION ACTIVITY", "F&O PURCHASE & SALES", "F&O OPEN POSITIONS", "FINANCIAL SUMMARY"];
// Repeated on every page; not part of any table.
const PAGE_FURNITURE = /^(Account Name\s*:|MONTHLY STATEMENT for|Account Number\s*:|Page \d+ of \d+)/;

// The Financial Summary's lines, by the name RAMP uses for each.
export const SUMMARY_LINES = {
  beginning: "Beginning Balance", cashMovement: "Cash Movement", commission: "Commission", exchangeFee: "Exchange Fee",
  miscFee: "Miscellaneous Fee", withholdingTax: "Withholding Tax", gst: "GST", interests: "Interests", premiums: "Premiums",
  foRealized: "F&O Realized P&L", fxRealized: "FX Realized P&L", fixedIncome: "Fixed Income Settlement Amount", cfdRealized: "Equity CFD Realized P&L",
  ending: "Ending Balance", foUnrealized: "F&O Unrealized Profit/Loss", lmeForward: "LME Forward Close Profit/Loss", fxForward: "FX Forward Profit/Loss",
  fxUnrealized: "FX Unrealized Profit/Loss", fxSwap: "FX Swap Profit/Loss", equityCash: "Equity Cash to be Settled", equityPosition: "Equity Position to be Settled",
  cfdUnrealized: "Equity CFD Unrealized P&L", totalEquity: "Total Equity", equityMarketValue: "Equity Market Value", nonCashCollateral: "Non- Cash Collateral",
  tne: "Total Net Equity", optionMarketValue: "Option Market Value", nlv: "Net Liquidating Value", im: "Initial Margin", mm: "Maintenance Margin",
  portfolioRisk: "Portfolio Risk Requirement", excess: "Margin Excess/Deficit",
};

/*
 * lines: linesFromItems(...). Returns { account, short, month, date, summary, journal, trades,
 * realised, open, openNet, problems }. Strict like the daily readers: a Financial Summary line
 * that is missing or not a number is a problem, and a statement with problems is not checked.
 */
export function readMonthlyStatement(lines) {
  const problems = [];
  const all = lines.map((l) => l.text).join("\n");
  const acct = /Account Number\s*:\s*([\d-]+)/.exec(all);
  const per = /MONTHLY STATEMENT for\s+([A-Za-z]+)-(\d{4})/.exec(all);
  const dt = /Statement Date\s*:\s*(\d{2})\/(\d{2})\/(\d{4})/.exec(all);
  const account = acct ? plainAccount(acct[1]) : null;
  const out = {
    // A sub-account goes by its last four digits (0011); the group by its own number (100305).
    account, short: account ? (account.length > 6 ? account.slice(-4) : account) : null,
    month: per ? `${per[2]}-${String(MONTHS[per[1].slice(0, 3).toLowerCase()] || 0).padStart(2, "0")}` : null,
    date: dt ? `${dt[3]}-${dt[2]}-${dt[1]}` : null,
    summary: {}, journal: [], trades: [], realised: [], open: [], openNet: null, deals: [], problems,
  };
  if (!account) problems.push("No account number found — is this an Orient monthly statement?");
  if (!out.date) problems.push("No statement date found.");

  let section = null, block = [], header = null, pending = [];
  // Each contract's trade lines come before its "Total" line, which names the contract.
  const settle = (status, code, month) => { for (const d of pending) out.deals.push({ ...d, status, code, month }); pending = []; };
  for (const l of lines) {
    const sec = SECTIONS.find((s) => l.text.startsWith(s));
    if (sec) { section = sec; block = []; pending = []; continue; }
    if (PAGE_FURNITURE.test(l.text)) continue;
    const c = l.cells.map((x) => x.str);
    if (/^(Date|Exchange|Trade Date)$/.test(c[0])) { header = l; continue; }
    /*
     * The description column only: "NY Harbor ULSD Oct" and "2026" are on two lines, with the
     * price and currency between them on the first. Taken by position under the header.
     */
    const dx = header?.cells.find((x) => x.str === "Description")?.x;
    const nx = header?.cells.find((x) => dx !== undefined && x.x > dx + 1)?.x;
    const desc = dx === undefined ? l.text : l.cells.filter((x) => x.x >= dx - 2 && (nx === undefined || x.x < nx - 2)).map((x) => x.str).join(" ");

    if (section === "JOURNAL ENTRIES" && /^\d{2}\/\d{2}\/\d{2}$/.test(c[0]) && money(c[c.length - 1]) !== null) {
      out.journal.push({ date: c[0], type: c[2] || "", description: c[3] || "", amount: money(c[c.length - 1]) });
    } else if (section === "MONTHLY SUMMARY OF TRADES" && c.length >= 9 && c[0] !== "Total" && money(c[3]) !== null) {
      out.trades.push({ exchange: c[0], code: c[1], delivery: c[2], buy: money(c[3]), sell: money(c[4]), exchangeFee: money(c[6]) ?? 0, comm: money(c[7]) ?? 0, gst: money(c[8]) ?? 0 });
    } else if (section === "F&O PURCHASE & SALES") {
      if (c[0] === "Total") {
        const text = block.join(" ");
        const v = c.map(money).filter((x, i) => x !== null && i >= 3);
        out.realised.push({ code: productOf(text), month: monthOf(text), buy: money(c[1]), sell: money(c[2]), pl: v.length ? v[v.length - 1] : null });
        settle("closed", productOf(text), monthOf(text));
        block = [];
      } else {
        const d = dealOf(l, header, "Price");
        if (d) pending.push(d);
        block.push(desc);
      }
    } else if (section === "F&O OPEN POSITIONS") {
      if (c[0] === "Total" && /Settlement Price/.test(l.text)) {
        const text = block.join(" ");
        const q = l.cells[1];
        // Long or short from which column the lots sit under.
        const bx = header?.cells.find((x) => x.str === "Buy")?.x, sx = header?.cells.find((x) => x.str === "Sell")?.x;
        const short = bx !== undefined && sx !== undefined ? Math.abs(q.x - sx) < Math.abs(q.x - bx) : false;
        const i = c.indexOf("Settlement Price:");
        out.open.push({ code: productOf(text), month: monthOf(text), lots: (short ? -1 : 1) * money(q.str), settle: money(c[i + 1]), upl: money(c[i + 2]), avg: null });
        settle("open", productOf(text), monthOf(text));
        block = [];
      } else if (/^Average (Long|Short):/.test(c[0]) && out.open.length && out.open[out.open.length - 1].avg === null) {
        out.open[out.open.length - 1].avg = money(c[1]);
      } else if (c[0] === "Net") {
        out.openNet = c.map(money).filter((x) => x !== null).pop() ?? null;
      } else {
        const d = dealOf(l, header, "Trade Price");
        if (d) pending.push(d);
        block.push(desc);
      }
    } else if (section === "FINANCIAL SUMMARY") {
      // The terms and abbreviations box below the summary repeats words like "GST": first one only.
      if (/^This statement is subject to/.test(l.text)) { section = null; continue; }
      const key = Object.keys(SUMMARY_LINES).find((k) => clean(SUMMARY_LINES[k]) === c[0]);
      if (key && out.summary[key] === undefined) { const v = money(c[c.length - 1]); if (v === null) problems.push(`Financial Summary, "${c[0]}": "${c[c.length - 1]}" is not a number.`); else out.summary[key] = v; }
    }
  }
  for (const [k, label] of Object.entries(SUMMARY_LINES)) if (out.summary[k] === undefined && !["lmeForward", "fxSwap"].includes(k)) problems.push(`The Financial Summary has no "${label}" line.`);
  return out;
}

/*
 * One trade line of F&O PURCHASE & SALES or F&O OPEN POSITIONS: "17/08/26 NYMEX 1 Brent Crude Oil -
 * Last 89.23 0011 USD". Bought or sold from which column the lots sit under (the numbers are right-
 * aligned, so nearest header wins); the price from under its own header. The contract comes later,
 * from the block's Total line. Null for anything else.
 */
function dealOf(l, header, priceLabel) {
  const c = l.cells;
  const dm = /^(\d{2})\/(\d{2})\/(\d{2})$/.exec(c[0]?.str || "");
  if (!dm || !header) return null;
  const at = (label) => header.cells.find((x) => x.str === label)?.x;
  const bx = at("Buy"), sx = at("Sell"), dx = at("Description"), px = at(priceLabel), ax = at("Sub Ac"), ux = at("Unrealised P&L");
  if (bx === undefined || sx === undefined || px === undefined) return null;
  let buy = 0, sell = 0;
  for (const x of c.slice(1)) {
    if (dx !== undefined && x.x >= dx - 2) break;
    const q = money(x.str);
    if (q === null || !/^\d[\d,]*$/.test(x.str)) continue;
    if (Math.abs(x.x - bx) <= Math.abs(x.x - sx)) buy += q; else sell += q;
  }
  const nearest = (x0, test) => c.filter((x) => test(x)).sort((a, b) => Math.abs(a.x - x0) - Math.abs(b.x - x0))[0];
  const priceCell = nearest(px, (x) => x.x > (dx ?? 0) && /^\(?[\d,]*\.\d+\)?$/.test(x.str) && (ax === undefined || x.x < ax - 2));
  const sub = ax !== undefined ? nearest(ax, (x) => /^\d{4}$/.test(x.str) && Math.abs(x.x - ax) < 30) : null;
  const uplCell = ux !== undefined ? nearest(ux, (x) => x.x > (ax ?? px) + 2 && money(x.str) !== null && /\./.test(x.str)) : null;
  if (!priceCell || (!buy && !sell)) return null;
  return {
    date: `20${dm[3]}-${dm[2]}-${dm[1]}`, exchange: c[1]?.str || "", buy, sell, price: money(priceCell.str),
    sub: sub ? sub.str : null, upl: uplCell ? money(uplCell.str) : null,
  };
}

const near = (a, b) => Math.abs(a - b) <= 0.01 + 1e-9;
const sum = (xs) => +xs.reduce((t, x) => t + (x || 0), 0).toFixed(2);

/*
 * Orient's own arithmetic, line by line, like checkAccount does for a day. Each check names
 * itself; returns only the ones that fail.
 */
export function checkMonthly(m) {
  const s = m.summary, z = (k) => s[k] || 0;
  const checks = [
    ["Ending balance = beginning + cash movement + commission + fees + tax + interest + premiums + realised P&L",
      s.ending, sum(["beginning", "cashMovement", "commission", "exchangeFee", "miscFee", "withholdingTax", "gst", "interests", "premiums", "foRealized", "fxRealized", "fixedIncome", "cfdRealized"].map(z))],
    ["Total equity = ending balance + unrealised P&L",
      s.totalEquity, sum(["ending", "foUnrealized", "lmeForward", "fxForward", "fxUnrealized", "fxSwap", "equityCash", "equityPosition", "cfdUnrealized"].map(z))],
    ["Total net equity = total equity + equity market value + non-cash collateral", s.tne, sum(["totalEquity", "equityMarketValue", "nonCashCollateral"].map(z))],
    ["Net liquidating value = total net equity + option market value", s.nlv, sum(["tne", "optionMarketValue"].map(z))],
    ["Margin excess = net liquidating value − initial margin", s.excess, sum([z("nlv"), -z("im")])],
    ["F&O realised P&L = the contracts' realised P&L in Purchase & Sales", s.foRealized, sum(m.realised.map((r) => r.pl))],
    ["F&O unrealised P&L = the open positions' P&L", s.foUnrealized, sum(m.open.map((o) => o.upl))],
    ...(m.openNet === null ? [] : [["F&O unrealised P&L = the open positions' Net line", s.foUnrealized, m.openNet]]),
    ["Exchange fee = the month's trades' exchange fees", s.exchangeFee, sum(m.trades.map((t) => t.exchangeFee))],
    ["Commission = the month's trades' commission + commission adjustments in the journal",
      s.commission, sum([...m.trades.map((t) => t.comm), ...m.journal.filter((j) => /commission/i.test(j.type)).map((j) => j.amount)])],
    ["Cash movement = deposits and withdrawals in the journal", s.cashMovement, sum(m.journal.filter((j) => /funds|deposit|withdraw/i.test(`${j.type} ${j.description}`)).map((j) => j.amount))],
    // Every trade line read: each contract's lines add up to its Total line.
    ...(m.realised || []).flatMap((r) => {
      const ds = (m.deals || []).filter((d) => d.status === "closed" && d.code === r.code && d.month === r.month);
      return [[`${r.code} ${r.month} bought: the trade lines add up to the Total`, r.buy, sum(ds.map((d) => d.buy))],
        [`${r.code} ${r.month} sold: the trade lines add up to the Total`, r.sell, sum(ds.map((d) => d.sell))]];
    }),
    ...(m.open || []).map((o) => [`${o.code} ${o.month} open: the trade lines add up to the Total`, o.lots,
      sum((m.deals || []).filter((d) => d.status === "open" && d.code === o.code && d.month === o.month).map((d) => d.buy - d.sell))]),
  ];
  return checks.filter(([, got, want]) => got === undefined || !near(got, want)).map(([label, got, want]) => ({ label, got, want }));
}

/*
 * The month against the daily statements for the same account.
 *
 * dailies: [{ date: "YYYY-MM-DD", accounts: readFinancialSummary(...).accounts, lots: readOpenPositions(...).lots | null }].
 * Each day is used once. Returns one line per tie, ok or not, with what each side says, so the
 * page can show what was compared — and says when the daily statements needed aren't open.
 */
export function tieToDaily(m, dailies) {
  const days = new Map();
  for (const d of dailies) {
    if (!d.date || !d.date.startsWith(m.month) || d.date > m.date) continue;
    const a = (d.accounts || []).find((x) => x.no === m.account);
    if (a && !days.has(d.date)) days.set(d.date, { date: d.date, a, lots: d.lots });
    else if (a && d.lots && !days.get(d.date).lots) days.get(d.date).lots = d.lots;
  }
  const list = [...days.values()].sort((x, y) => x.date.localeCompare(y.date));
  if (!list.length) return { lines: [], missing: `No daily statements for ${m.month} are open for this account.` };
  const first = list[0], last = list[list.length - 1];
  const line = (label, got, want, note) => ({ label, got, want, ok: near(got, want), note });
  const lines = [
    line(`Opening balance = the first daily statement's (${first.date})`, m.summary.beginning, first.a.beginning),
    line(`Closing balance = the last daily statement's (${last.date})`, m.summary.ending, last.a.ending, last.date === m.date ? null : `the last daily statement open is ${last.date}, not ${m.date}`),
    line(`Realised P&L = the daily statements' added up (${list.length} days)`, m.summary.foRealized, sum(list.map((d) => d.a.pl))),
  ];
  if (last.lots) {
    const net = new Map();
    for (const l of last.lots.filter((x) => x.account === m.account)) { const k = `${l.code} ${l.month}`; net.set(k, (net.get(k) || 0) + (l.side === "B" ? l.qty : -l.qty)); }
    const mine = new Map(m.open.map((o) => [`${o.code} ${o.month}`, o.lots]));
    const keys = [...new Set([...net.keys(), ...mine.keys()])].sort();
    const diff = keys.filter((k) => (net.get(k) || 0) !== (mine.get(k) || 0));
    lines.push({ label: `Open positions = the last daily statement's (${last.date})`, ok: !diff.length, got: null, want: null,
      note: diff.length ? diff.map((k) => `${k}: monthly ${mine.get(k) || 0}, daily ${net.get(k) || 0}`).join("; ") : null });
  }
  const missing = list.length < 15 ? `Only ${list.length} daily statement${list.length === 1 ? "" : "s"} for ${m.month} are open — realised P&L only ties when every trading day is.` : null;
  return { lines, missing };
}

// Lines as kept (page, y, cells) back into lines as read (with their text).
export const restoreLines = (kept) => (kept || []).map((l) => ({ ...l, text: l.cells.map((c) => c.str).join("  ") }));

/*
 * Orient's monthly GST statement — a TAX INVOICE for the group: every fee charged, day by day, per
 * sub-account. Not a statement of account, so it is read and checked on its own:
 *   - its fee types, added up per sub-account, against that sub-account's monthly statement
 *     (Commission, Exchange Fee, and NFA + bank charges as Miscellaneous Fee)
 *   - each day's fees against that day's daily statement
 * Amounts on the invoice are charges as positive numbers; a refund is in brackets. Here they are
 * turned round to the statements' sign: a charge is negative.
 */
export const isGstInvoice = (lines) => lines.some((l) => /^TAX INVOICE$/.test(l.text.trim()));

export function readGstInvoice(lines) {
  const all = lines.map((l) => l.text).join("\n");
  const acct = /Account Number\s*:\s+(\d+)/.exec(all);
  const per = /Statement Period\s*:\s+([A-Za-z]{3})-(\d{2})/.exec(all);
  const dt = /Date\s*:\s+(\d{2})-(\d{2})-(\d{2})/.exec(all);
  const inv = /Invoice Number\s*:\s+(.+)$/m.exec(all);
  const out = {
    account: acct ? acct[1] : null,
    month: per ? `20${per[2]}-${String(MONTHS[per[1].toLowerCase()]).padStart(2, "0")}` : null,
    date: dt ? `20${dt[3]}-${dt[2]}-${dt[1]}` : null,
    invoice: inv ? inv[1].trim() : null,
    fees: [], problems: [],
  };
  let sub = null, date = null, type = null, inSummary = false;
  out.summaryTotal = 0;
  for (const l of lines) {
    const c = l.cells.map((x) => x.str);
    // The SUMMARY box at the top: original amounts per product/exchange, added up.
    if (/^SUMMARY$/.test(l.text.trim())) { inSummary = true; continue; }
    if (inSummary && !/^ACCOUNT NUMBER/.test(l.text)) {
      const i = c.findIndex((x) => /^[A-Z]{3}$/.test(x) && x !== "FUT");
      if (i >= 0 && money(c[i + 1]) !== null) out.summaryTotal += money(c[i + 1]);
      continue;
    }
    inSummary = false;
    const a = /^ACCOUNT NUMBER\s*:\s*([\d-]+)/.exec(l.text);
    if (a) { sub = plainAccount(a[1]); date = null; type = null; continue; }
    if (!sub || c.length < 6) continue;
    const rate = money(c[c.length - 1]), orig = money(c[c.length - 5]), ccy = c[c.length - 6];
    if (rate === null || orig === null || !/^[A-Z]{3}$/.test(ccy)) continue;
    if (/^\d{2}\/\d{2}\/\d{2}$/.test(c[0])) date = c[0];
    const named = c.find((x) => /^(Commission|Exchange Fee|NFA|BANK CHARGES|GST|Interest)/i.test(x));
    if (named) type = named;
    if (!date || !type) { out.problems.push(`GST statement: a fee line with no date or description ("${l.text}").`); continue; }
    const [d, mo, y] = date.split("/");
    out.fees.push({ account: sub, date: `20${y}-${mo}-${d}`, type, ccy, amount: -orig });
  }
  if (!out.account) out.problems.push("No account number found on the GST statement.");
  if (!out.fees.length) out.problems.push("No fee lines found on the GST statement.");
  return out;
}

// Fees by kind, as the monthly statement's Financial Summary splits them.
const feeKind = (type) => (/^commission/i.test(type) ? "commission" : /^exchange fee/i.test(type) ? "exchangeFee" : "miscFee");

/*
 * The GST statement against the monthly statements (one per sub-account, same month) and the
 * daily statements. dailies as for tieToDaily. Returns lines like tieToDaily's.
 */
export function tieGst(g, monthlies, dailies) {
  const lines = [];
  const byAcct = new Map();
  for (const f of g.fees) {
    const t = byAcct.get(f.account) || { commission: 0, exchangeFee: 0, miscFee: 0 };
    t[feeKind(f.type)] += f.amount;
    byAcct.set(f.account, t);
  }
  for (const [acct, t] of byAcct) {
    const m = monthlies.find((x) => x.account === acct && x.month === g.month);
    if (!m) { lines.push({ label: `${acct.slice(-4)}: no monthly statement for ${g.month} open to compare`, ok: false, got: null, want: null, missing: true }); continue; }
    for (const [k, label] of [["commission", "Commission"], ["exchangeFee", "Exchange fee"], ["miscFee", "NFA + bank charges = Miscellaneous fee"]]) {
      lines.push({ label: `${acct.slice(-4)}: ${label} = the monthly statement's`, got: sum([t[k]]), want: m.summary[k], ok: near(t[k], m.summary[k]) });
    }
  }
  // Day by day: commission, and exchange fee + NFA, against the daily Financial Summary.
  const days = new Map();
  for (const f of g.fees) {
    const k = `${f.account}|${f.date}`;
    const d = days.get(k) || { account: f.account, date: f.date, commission: 0, fee: 0 };
    if (feeKind(f.type) === "commission") d.commission += f.amount; else if (!/bank/i.test(f.type)) d.fee += f.amount;
    days.set(k, d);
  }
  let compared = 0;
  const bad = [];
  for (const d of days.values()) {
    const daily = dailies.find((x) => x.date === d.date && (x.accounts || []).some((a) => a.no === d.account));
    if (!daily) continue;
    const a = daily.accounts.find((x) => x.no === d.account);
    compared++;
    if (!near(d.commission, a.commission) || !near(d.fee, a.fee)) bad.push(`${d.date} ${d.account.slice(-4)}: invoice commission ${sum([d.commission])} / fees ${sum([d.fee])}, daily ${a.commission} / ${a.fee}`);
  }
  if (compared) lines.push({ label: `Each day's fees = that day's daily statement (${compared} day${compared === 1 ? "" : "s"})`, ok: !bad.length, got: null, want: null, note: bad.join("; ") || null });
  return { lines, missing: compared < days.size ? `${days.size - compared} of the invoice's ${days.size} days have no daily statement open.` : null };
}

// The invoice against itself: its summary box = its fee lines.
export function checkGst(g) {
  const lines = -sum(g.fees.map((f) => f.amount));
  return near(g.summaryTotal, lines) ? [] : [{ label: "The invoice's summary total = its fee lines added up", got: sum([g.summaryTotal]), want: lines }];
}

/*
 * The group's monthly statement against its sub-accounts' for the same month, line by line —
 * the group is their sum. statements: readMonthlyStatement results. Returns per month:
 * { month, group, subs, failed: [{ label, got, want }] } for each month with a group statement.
 */
export function checkMonthlyFamily(statements) {
  const out = [];
  for (const g of statements.filter((x) => x.account && x.account.length <= 6)) {
    const subs = statements.filter((x) => x.month === g.month && x.account !== g.account && x.account?.startsWith(g.account));
    if (!subs.length) { out.push({ month: g.month, group: g.account, subs: [], failed: [] }); continue; }
    const failed = Object.entries(SUMMARY_LINES)
      .filter(([k]) => g.summary[k] !== undefined)
      .map(([k, label]) => ({ label: `${label}: group is not the sum of its sub-accounts`, got: g.summary[k], want: sum(subs.map((x) => x.summary[k])) }))
      .filter((c) => !near(c.got, c.want));
    out.push({ month: g.month, group: g.account, subs: subs.map((x) => x.account), failed });
  }
  return out;
}

/*
 * The month's trade lines against the trader's TT fills, lot by lot, the same way the daily Trade
 * Confirmations are matched (account, contract, side, price, day). Only trades dated in the month:
 * a position still open at month end may have been opened earlier. The whole month counts as
 * covered by the statement, so a TT fill in it that Orient doesn't list is "extra".
 * Returns { lines: [deal + { lots, matched }], lots, matched, extra: [...] }.
 */
export function dealsAgainstFills(m, fills) {
  const inMonth = (m.deals || []).filter((d) => m.month && d.date.startsWith(m.month));
  const accountOf = (d) => (m.account && m.account.length > 6 ? m.account : d.sub && m.account ? `${m.account}${d.sub}` : null);
  const trades = [];
  inMonth.forEach((d, i) => {
    const base = { orderId: "", account: accountOf(d), date: d.date.replaceAll("-", ""), time: "", code: d.code, month: d.month, kind: "F", price: d.price };
    if (d.buy) trades.push({ ...base, tradeId: `${i}|B`, side: "B", qty: d.buy });
    if (d.sell) trades.push({ ...base, tradeId: `${i}|S`, side: "S", qty: d.sell });
  });
  const accounts = [...new Set(trades.map((t) => t.account).filter(Boolean))];
  const [y, mo] = (m.month || "0-0").split("-").map(Number);
  const dates = new Set([...Array(new Date(Date.UTC(y, mo, 0)).getUTCDate())].map((_, i) => `${y}${String(mo).padStart(2, "0")}${String(i + 1).padStart(2, "0")}`));
  const r = matchFills(fills || [], trades.filter((t) => t.account), Object.fromEntries(accounts.map((a) => [a, dates])));
  const missingBy = new Map();
  for (const x of r.missing) missingBy.set(x.tradeId, (missingBy.get(x.tradeId) || 0) + 1);
  // Lots before the first TT fill aren't called missing: nothing to compare them with.
  const covered = new Set(r.days.map((x) => `${x.account}|${x.date}`));
  const lines = inMonth.map((d, i) => {
    const lots = d.buy + d.sell;
    const compared = covered.has(`${accountOf(d)}|${d.date.replaceAll("-", "")}`);
    const miss = (missingBy.get(`${i}|B`) || 0) + (missingBy.get(`${i}|S`) || 0);
    return { ...d, account: accountOf(d), lots, compared, matched: compared ? lots - miss : null };
  });
  const compared = lines.filter((l) => l.compared);
  return { lines, lots: compared.reduce((t, l) => t + l.lots, 0), matched: compared.reduce((t, l) => t + l.matched, 0), extra: r.extra };
}
