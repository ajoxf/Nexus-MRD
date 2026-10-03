/*
 * Orient's daily Financial Summary — "Financial Summary - <account> - YYYYMMDD.csv", one of
 * the files in the daily statement zip.
 *
 * Read by column NAME, never by position, and strictly: a column that is missing, or a cell
 * that is not a plain number, stops the read and says which. These figures are a broker's
 * statement of equity and margin; a reader that guessed would be worse than one that fails.
 *
 * What the file holds, as Orient sends it:
 *   - one row per account per currency; the "Base:USD" row is the account's total in its
 *     base currency, and is the one read here
 *   - the main account (e.g. 100305) and its sub-accounts (1003050000, 1003050011), the main
 *     account being the sum of the subs
 *   - activity columns that add straight into the balance, so a fee or commission is
 *     negative — the ending-balance check below would fail otherwise
 *
 * Nothing here touches the book. It reads, and it checks Orient's own arithmetic.
 */

export const TOL = 0.01;   // currency rounding: a cent either way is a match

export const COLUMNS = {
  name: "Acct Name",
  no: "Acct No.",
  ccy: "CCY",
  beginning: "Beginning Balance",
  cashAdj: "Cash Adjustments",
  commission: "Commission",
  fee: "Fee",
  gst: "GST",
  pl: "Profit/Loss",
  optPremium: "Options Premium",
  interest: "Interest",
  ending: "Ending Balance",
  upl: "Total Unrealised Profit/loss (UPL)",
  fxOpenUpl: "FX Open Positions UPL",
  fxClosedPl: "FX Closed Positions Forward PL",
  foUpl: "F&O Open Position UPL",
  equity: "Total Equity",
  collateral: "Collateral MTM",
  tne: "Total net equity",
  optValue: "Net Option Value",
  nlv: "Net liquidating value",
  marketValue: "Account Market Value",
  im: "Total IM",
  mm: "Total MM",
  excess: "Margin Excess/Deficit",
};
const TEXT = new Set(["name", "no", "ccy"]);
export const NUMBERS = Object.keys(COLUMNS).filter((k) => !TEXT.has(k));

export const isFinancialSummary = (fileName) => /^financial summary\b/i.test(String(fileName || "").trim());

const norm = (h) => String(h ?? "").trim().replace(/\s+/g, " ").toLowerCase();
const PLAIN = /^-?\d+(\.\d+)?$/;

/**
 * rows: the CSV as an array of arrays (header first), e.g. from Papa.parse(text).data.
 * Returns { accounts, problems }. accounts holds the Base-currency row of each account with
 * every figure as a number. problems is empty when the file was read cleanly; anything in
 * it means the file was NOT read and accounts is empty.
 */
export function readFinancialSummary(rows) {
  const data = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim() !== ""));
  if (!data.length) return { accounts: [], problems: ["The Financial Summary is empty."] };

  const header = data[0].map(norm);
  const at = {};
  const missing = [];
  for (const [k, label] of Object.entries(COLUMNS)) {
    const i = header.indexOf(norm(label));
    if (i < 0) missing.push(label); else at[k] = i;
  }
  if (missing.length) return { accounts: [], problems: [`The Financial Summary has no ${missing.map((m) => `"${m}"`).join(", ")} column${missing.length === 1 ? "" : "s"}. Orient may have changed the layout.`] };

  const problems = [];
  const accounts = [];
  data.slice(1).forEach((r, idx) => {
    const ccy = String(r[at.ccy] ?? "").trim();
    if (!/^base:/i.test(ccy)) return;     // the per-currency lines repeat the base line
    const a = { name: String(r[at.name] ?? "").trim(), no: String(r[at.no] ?? "").trim(), ccy: ccy.slice(5).trim() };
    if (!a.no) problems.push(`Row ${idx + 2} has no account number.`);
    for (const k of NUMBERS) {
      const raw = String(r[at[k]] ?? "").trim();
      if (!PLAIN.test(raw)) { problems.push(`Row ${idx + 2}, "${COLUMNS[k]}": "${raw}" is not a plain number.`); continue; }
      a[k] = +raw;
    }
    accounts.push(a);
  });
  if (!accounts.length && !problems.length) problems.push('The Financial Summary has no "Base:" rows to read.');
  return problems.length ? { accounts: [], problems } : { accounts, problems };
}

const near = (a, b) => Math.abs(a - b) <= TOL + 1e-9;
const sum = (a, keys) => keys.reduce((t, k) => t + a[k], 0);

/*
 * Orient's own arithmetic, row by row. Each check names itself, so a failure says what
 * did not add up rather than just that something didn't.
 */
export const CHECKS = [
  ["Ending balance = beginning + cash adjustments + commission + fee + GST + P/L + options premium + interest",
    (a) => [a.ending, a.beginning + sum(a, ["cashAdj", "commission", "fee", "gst", "pl", "optPremium", "interest"])]],
  ["Unrealised P/L = FX open + FX closed forward + F&O open",
    (a) => [a.upl, sum(a, ["fxOpenUpl", "fxClosedPl", "foUpl"])]],
  ["Total equity = ending balance + unrealised P/L", (a) => [a.equity, a.ending + a.upl]],
  ["Total net equity = total equity + collateral", (a) => [a.tne, a.equity + a.collateral]],
  ["Net liquidating value = total net equity + net option value", (a) => [a.nlv, a.tne + a.optValue]],
  ["Margin excess = net liquidating value − total IM", (a) => [a.excess, a.nlv - a.im]],
];

export function checkAccount(a) {
  return CHECKS.map(([label, f]) => { const [got, want] = f(a); return { label, got, want, ok: near(got, want) }; })
    .filter((c) => !c.ok);
}

/*
 * The main account is the one whose number starts every other account's number. Returns
 * null when the file holds accounts that are not one family.
 */
export function mainAccount(accounts) {
  if (!accounts.length) return null;
  const m = [...accounts].sort((x, y) => x.no.length - y.no.length)[0];
  return accounts.every((a) => a === m || a.no.startsWith(m.no)) ? m : null;
}

// The main account should be its sub-accounts added up, figure by figure.
export function checkFamily(accounts) {
  const m = mainAccount(accounts);
  if (!m) return [];
  const subs = accounts.filter((a) => a !== m);
  if (!subs.length) return [];
  return NUMBERS.filter((k) => !near(m[k], subs.reduce((t, s) => t + s[k], 0)))
    .map((k) => ({ label: `${COLUMNS[k]}: main account is not the sum of its sub-accounts`, got: m[k], want: subs.reduce((t, s) => t + s[k], 0) }));
}

/*
 * Day to day: each day's beginning balance should be the previous day's ending balance, account
 * by account. days: [{ date: "YYYY-MM-DD", accounts }]. A break means a missing statement in
 * between, or something moved that the statement didn't show.
 *
 * Compared DAY to day, not statement to statement. Orient sends a zip per sub-account and one
 * for the group, all dated the same day and holding the same sub-account, so "the statement
 * before this one" was often the same day — whose closing balance is not this one's opening, and
 * the check cried "missing day" over two statements that agreed. Worse, when the statement just
 * before didn't hold the account at all, a real break across days went unchecked.
 *
 * So each day is first reduced to one balance per account, then each account is compared with
 * the latest earlier day that has it. Two statements for one day and account that disagree are
 * reported as that ({ sameDay: true }) — they should be the same figures from two files.
 */
export function checkCarryOver(days) {
  const byDate = new Map();
  const breaks = [];
  for (const d of days) {
    if (!d.date || !d.accounts?.length) continue;
    if (!byDate.has(d.date)) byDate.set(d.date, new Map());
    const day = byDate.get(d.date);
    for (const a of d.accounts) {
      const seen = day.get(a.no);
      if (!seen) { day.set(a.no, a); continue; }
      if (!near(seen.beginning, a.beginning) || !near(seen.ending, a.ending)) {
        breaks.push({ date: d.date, no: a.no, sameDay: true, beginning: a.beginning, ending: a.ending, otherBeginning: seen.beginning, otherEnding: seen.ending });
      }
    }
  }
  const dates = [...byDate.keys()].sort();
  for (let i = 1; i < dates.length; i++) {
    for (const [no, a] of byDate.get(dates[i])) {
      const j = dates.slice(0, i).findLastIndex((dt) => byDate.get(dt).has(no));
      if (j < 0) continue;
      const p = byDate.get(dates[j]).get(no);
      if (!near(a.beginning, p.ending)) breaks.push({ date: dates[i], prevDate: dates[j], no, beginning: a.beginning, prevEnding: p.ending });
    }
  }
  return breaks;
}

/*
 * Orient's "Open Position.csv": one row per open lot (not per net position), with the trade
 * price, the day's settlement price and the unrealised P/L Orient worked out from them.
 *
 * Its account numbers are written with dashes ("1-00305-001-1") where the Financial Summary
 * has none ("1003050011"); taking the dashes out makes them the same number.
 *
 * Two things here check Orient against itself:
 *   - each lot's P/L is (settlement − trade price) × lots × contract size, so the contract
 *     size Orient used can be read back out, and must agree across lots of a product
 *   - the lots' P/L, added up per account, is the Financial Summary's F&O Open Position UPL
 */
export const POSITION_COLUMNS = {
  settlementDate: "SettlementDate",
  tradeId: "TradeEntryID",
  group: "Client group account number",
  sub: "Client sub account number",
  tradeDate: "TradeDate",
  exchange: "ExchangeMIC",
  code: "ClearingCode",
  month: "ContractExpiryMonth",
  expiry: "Expiry Date",
  kind: "CallPutFut",
  strike: "StrikePrice",
  price: "TradePrice",
  side: "BuySell",
  qty: "Amount",
  settle: "SettPrice",
  upl: "UnrealisedPL",
  ccy: "TradePLCcy",
};

export const isOpenPosition = (fileName) => /^open position/i.test(String(fileName || "").trim());
export const plainAccount = (s) => String(s ?? "").replace(/-/g, "").trim();

/*
 * The sub-account a lot sits in, as the Financial Summary numbers it.
 *
 * A sub-account's own statement writes it in full ("1-00305-001-1" → 1003050011). The GROUP
 * statement writes only its short code — "0011", which Excel shows as 11 — and read as an
 * account number that matched nothing, so every group row with positions reported its own
 * figures as not adding up. The short code is the full number's last four digits, so it is
 * joined to the group's. Anything else is left as it is, so a real mismatch still shows.
 */
export const subAccount = (sub, group) => {
  const s = plainAccount(sub), g = plainAccount(group);
  return /^\d{1,4}$/.test(s) && /^\d+$/.test(g) ? g + s.padStart(4, "0") : s;
};
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
// 202612 → "Dec26"
export const monthLabel = (yyyymm) => { const m = /^(\d{4})(\d{2})$/.exec(String(yyyymm || "")); return m && +m[2] >= 1 && +m[2] <= 12 ? `${MONTHS[+m[2] - 1]}${m[1].slice(2)}` : String(yyyymm || ""); };

/**
 * rows: the CSV as arrays, header first. Returns { lots, problems }, strictly as
 * readFinancialSummary does: anything in problems means nothing was read. A file with the
 * header and no rows is a real answer — no open positions — not a problem.
 */
export function readOpenPositions(rows) {
  const data = (rows || []).filter((r) => Array.isArray(r) && r.some((c) => String(c ?? "").trim() !== ""));
  if (!data.length) return { lots: [], problems: ["The Open Position file is empty."] };
  const header = data[0].map(norm);
  const at = {}, missing = [];
  for (const [k, label] of Object.entries(POSITION_COLUMNS)) {
    const i = header.indexOf(norm(label));
    if (i < 0) missing.push(label); else at[k] = i;
  }
  if (missing.length) return { lots: [], problems: [`The Open Position file has no ${missing.map((m) => `"${m}"`).join(", ")} column${missing.length === 1 ? "" : "s"}. Orient may have changed the layout.`] };

  const problems = [], lots = [];
  data.slice(1).forEach((r, idx) => {
    const cell = (k) => String(r[at[k]] ?? "").trim();
    const row = idx + 2;
    const num = (k, optional = false) => {
      const raw = cell(k);
      if (optional && raw === "") return null;
      if (!PLAIN.test(raw)) { problems.push(`Open Position row ${row}, "${POSITION_COLUMNS[k]}": "${raw}" is not a plain number.`); return null; }
      return +raw;
    };
    const side = cell("side").toUpperCase();
    if (side !== "B" && side !== "S") problems.push(`Open Position row ${row}, "BuySell": "${cell("side")}" is neither B nor S.`);
    const lot = {
      tradeId: cell("tradeId"), account: subAccount(cell("sub"), cell("group")), group: plainAccount(cell("group")),
      code: cell("code"), month: cell("month"), expiry: cell("expiry"), kind: cell("kind").toUpperCase(), exchange: cell("exchange"),
      tradeDate: cell("tradeDate"), ccy: cell("ccy"),
      side, strike: num("strike", true), price: num("price"), qty: num("qty"), settle: num("settle"), upl: num("upl"),
    };
    if (lot.qty !== null && !(lot.qty > 0)) problems.push(`Open Position row ${row}, "Amount": a lot count has to be above zero.`);
    lots.push(lot);
  });
  return problems.length ? { lots: [], problems } : { lots, problems };
}

/*
 * The contract size Orient used for a lot, read back from its own P/L. Null when the
 * settlement equals the trade price, since a zero move says nothing about size.
 */
export function impliedSize(lot) {
  const move = (lot.settle - lot.price) * (lot.side === "B" ? 1 : -1) * lot.qty;
  return Math.abs(move) < 1e-12 ? null : +(lot.upl / move).toFixed(6);
}

/*
 * Lots gathered into positions: one per account and contract, signed (long +, short −),
 * with the average trade price, the settlement price and the P/L, as the PDF shows them.
 */
export function positionsOf(lots) {
  const by = new Map();
  for (const l of lots) {
    const key = [l.account, l.code, l.month, l.kind, l.strike ?? ""].join("|");
    const p = by.get(key) || { account: l.account, code: l.code, month: l.month, label: `${l.code} ${monthLabel(l.month)}${l.kind === "F" ? "" : ` ${l.kind}${l.strike ?? ""}`}`, expiry: l.expiry, kind: l.kind, strike: l.strike, lots: 0, cost: 0, gross: 0, settles: new Set(), upl: 0, sizes: [] };
    const signed = l.side === "B" ? l.qty : -l.qty;
    p.lots += signed; p.gross += l.qty; p.cost += l.price * l.qty; p.upl += l.upl; p.settles.add(l.settle);
    const s = impliedSize(l); if (s !== null) p.sizes.push(s);
    by.set(key, p);
  }
  return [...by.values()].map((p) => ({
    account: p.account, code: p.code, month: p.month, label: p.label, expiry: p.expiry, kind: p.kind, strike: p.strike,
    lots: p.lots, avg: +(p.cost / p.gross).toFixed(6), settle: p.settles.size === 1 ? [...p.settles][0] : null,
    upl: +p.upl.toFixed(2), size: p.sizes.length && p.sizes.every((s) => Math.abs(s - p.sizes[0]) <= 1e-6 * Math.abs(p.sizes[0])) ? +p.sizes[0].toFixed(6) : null,
    sizeMismatch: p.sizes.length > 1 && !p.sizes.every((s) => Math.abs(s - p.sizes[0]) <= 1e-6 * Math.abs(p.sizes[0])),
    settleMismatch: p.settles.size > 1,
  }));
}

/*
 * The two files against each other: per account in the Financial Summary, its open
 * positions' P/L should be its F&O Open Position UPL. The main account is checked through
 * its sub-accounts' lots, since the lots name the sub-account they sit in.
 */
export function checkPositionsAgainstSummary(lots, accounts) {
  const failed = [];
  const main = mainAccount(accounts);
  for (const a of accounts) {
    const mine = lots.filter((l) => l.account === a.no || (a === main && accounts.length > 1 && l.account.startsWith(a.no)) || (accounts.length === 1 && l.group === a.no));
    const total = mine.reduce((t, l) => t + l.upl, 0);
    if (!near(total, a.foUpl)) failed.push({ label: `${a.no}: "F&O Open Position UPL" is not what the open positions add up to`, got: a.foUpl, want: total });
  }
  for (const p of positionsOf(lots)) {
    if (p.sizeMismatch) failed.push({ label: `${p.label} (${p.account}): lots imply different contract sizes`, got: NaN, want: NaN });
    if (p.settleMismatch) failed.push({ label: `${p.label} (${p.account}): lots show different settlement prices`, got: NaN, want: NaN });
  }
  return failed;
}
