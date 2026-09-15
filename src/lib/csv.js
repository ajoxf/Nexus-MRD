import Papa from "papaparse";

export const FIELDS = [
  { key: "date", label: "Date / time", required: true, guess: /^(date|time|datetime|timestamp|open ?time|trade ?date|fill ?time|exec(ution)? ?time|trade ?time|deal ?time)$/i, loose: /date|time/i },
  { key: "time", label: "Time (own column)", required: false, guess: /^(time|fill ?time|exec(ution)? ?time|trade ?time)$/i },
  { key: "product", label: "Product / symbol", required: true, guess: /^(symbol|product|instrument|contract|ticker|market|commodity)$/i, loose: /symbol|product|instrument|contract|ticker/i },
  { key: "side", label: "Buy / sell", required: false, guess: /^(side|b\/s|buy\/sell|action|direction|type|bs)$/i, loose: /side|buy|action/i },
  { key: "qty", label: "Quantity / lots", required: true, guess: /^(qty|quantity|lots?|volume|filled|size|contracts|no\.? of lots)$/i, loose: /qty|quantity|lots?|volume/i },
  { key: "price", label: "Fill price", required: true, guess: /^(price|fill ?price|trade ?price|exec(ution)? ?price|avg ?price|px)$/i, loose: /price|px/i },
  { key: "ref", label: "Fill / deal ID", required: false, guess: /^(deal|fill[ _]?id|exec(ution)?[ _]?id|trade[ _]?id|deal[ _]?id|(tt)?order[ _]?id|id|ref|reference|trade ?no\.?)$/i, loose: /(fill|exec|trade|deal|order).?(id|no)/i },
  { key: "fee", label: "Commission / fees", required: false, guess: /^(commission|comm|fees?|charges|brokerage)$/i, loose: /commission|fee/i },
  { key: "swap", label: "Swap / rollover", required: false, guess: /^(swap|swaps|rollover|financing)$/i },
  { key: "broker", label: "Broker (multi-broker files)", required: false, guess: /^(broker|platform|portal ?account)$/i },
  { key: "account", label: "Broker account no.", required: false, guess: /^(account|acct|account ?(no|number|id)\.?|login)$/i },
  { key: "position", label: "Position ticket (MT5 hedging)", required: false, guess: /^(position([ _]?(ticket|id))?|pos[ _]?id|ticket)$/i },
  { key: "offset", label: "Server time offset (s)", required: false, guess: /^(server_?offset(_s)?|offset(_s)?|tz_?offset|gmt_?offset)$/i, loose: /offset/i },
  { key: "profit", label: "Broker P&L (checks contract size)", required: false, guess: /^(profit|p&l|pnl|realized ?p&?l)$/i },
];

// Reads a CSV. Broker reports (e.g. MT5) often have title lines and several sections before the real
// header row, so we look for the row that best matches known column names — preferring a "Deals" section.
// Tab-separated exports (TT's Fills grid saved as "Text (tab delimited)", or a file that has been
// through Excel) have no commas at all, and Papa then falls back to comma and reads each line as a
// single field. Naming the candidates explicitly makes it pick the tab.
export const DELIMITERS = [",", "\t", ";", "|"];

// Excel workbooks, including the old .xls format. The reader is a big library, so it is only
// fetched when someone actually picks a spreadsheet; CSV uploads never load it.
export const SPREADSHEET_RE = /\.(xlsx|xlsm|xlsb|xls|ods)$/i;

async function rowsFromSpreadsheet(file) {
  const XLSX = await import("@e965/xlsx");
  const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
  // raw:false gives the text as Excel displays it, so dates and times arrive
  // looking the way they do in the CSV and go through the same parsing.
  for (const name of wb.SheetNames) {
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, raw: false, defval: "" });
    if (aoa.some((r) => r.filter(Boolean).length > 1)) return aoa;   // first sheet with real rows
  }
  throw new Error("that workbook has no rows in it");
}

// Rows copied straight out of a grid (TT's Fills, Excel, Google Sheets) arrive tab-separated on the
// clipboard. Same table, same importer — only the source differs.
export function parsePastedText(text) {
  const t = String(text || "").trim();
  if (!t) throw new Error("nothing was pasted");
  return tableFromRows(Papa.parse(t, { header: false, skipEmptyLines: true, delimitersToGuess: DELIMITERS }).data);
}

export function parseCsvFile(file) {
  if (SPREADSHEET_RE.test(file.name || "")) return rowsFromSpreadsheet(file).then(tableFromRows);
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: false, skipEmptyLines: true, delimitersToGuess: DELIMITERS,
      complete: (res) => {
        try { resolve(tableFromRows(res.data)); } catch (e) { reject(e); }
      },
      error: reject,
    });
  });
}

const scoreHeader = (cells) => {
  const hs = cells.map((c) => String(c ?? "").trim()).filter(Boolean);
  return FIELDS.filter((f) => f.required || f.key === "side" || f.key === "ref").filter((f) => hs.some((h) => f.guess.test(h) || (f.loose && f.loose.test(h)))).length;
};

// TT's Fills grid (right-click → Select All → save) exports the rows with NO header line, so there
// is nothing to match column names against. The layout is fixed, though, and a row is unmistakable:
//   11Sep26 | 11:56:49.536 | CME | CL Nov26 | B | 1 | 95.29 | F | Direct | 1003050011-GHF | ...
// TT's own column names, in the order the Fills grid shows them.
const TT_FILLS_HEADERS = ["Date", "Time", "Exchange", "Contract", "B/S", "FillQty", "Price", "P/F", "Route", "Account", "Originator", "CurrentUser", "TTOrderID", "Column 14", "Column 15"];
const ttFillsRow = (r) =>
  r.length >= 13 &&
  // Date: TT writes 11Sep26, but a file opened and re-saved in Excel may hold 9/11/26.
  /^(\d{1,2}[A-Za-z]{3}\d{2,4}|\d{1,4}[\/.-]\d{1,2}[\/.-]\d{1,4})$/.test((r[0] || "").trim()) &&
  /^\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*(am|pm)?$/i.test((r[1] || "").trim()) && // 11:56:49.536
  /^[BS]$/i.test((r[4] || "").trim()) &&                       // B / S
  (r[5] || "") !== "" && !isNaN(Number(r[5])) &&               // FillQty
  (r[6] || "") !== "" && !isNaN(Number(r[6])) &&               // Price (spreads can be negative)
  /^[PF]$/i.test((r[7] || "").trim());                         // P/F: partial or full fill

// Every non-blank row must look like a fill: a file with a header line goes down the normal path.
const looksLikeTtFills = (rows) => {
  const body = rows.filter((r) => r.filter(Boolean).length > 1);
  return body.length > 0 && body.every(ttFillsRow);
};

// If a file holds no commas at all, Papa scores "one field per line" as perfectly consistent and
// picks the comma anyway, leaving every row as a single long string. Re-split those on whichever
// delimiter actually divides them.
function resplit(rows) {
  const singles = rows.filter((r) => r.length === 1 && r[0]);
  if (singles.length < rows.length * 0.9) return rows;         // genuinely parsed already
  for (const d of ["\t", ";", "|"]) {
    const counts = singles.map((r) => r[0].split(d).length);
    const tally = {};
    counts.forEach((n) => { tally[n] = (tally[n] || 0) + 1; });
    // Trailing junk lines have their own width, so look for the width most rows agree on.
    const [best, hits] = Object.entries(tally).sort((a, b) => b[1] - a[1])[0] || [];
    if (+best > 2 && hits >= counts.length * 0.8) {
      return rows.map((r) => (r.length === 1 && r[0] ? r[0].split(d) : r));
    }
  }
  return rows;
}

/*
 * MT5 "Trade History Report": giving every deal its position ticket.
 *
 * A hedging account does not net. Each position is its own ticket with its own entry, and the
 * broker matches a close against THAT ticket — so closing a lot opened at 95.532 for 95.485 is
 * a 47-cent loss, whatever else is open at a lower price. Match it any other way (running
 * average, oldest-first) and the P&L disagrees with the customer's statement, which for this
 * product is the whole ball game.
 *
 * The Deals sheet does not carry the position ticket. The rest of the report does, in two
 * halves, and between them every deal can be placed:
 *
 *   an OPENING deal — MT5 numbers a new position after the order that opened it, so the
 *                     ticket IS the Order. Verified against the report's own tables.
 *   a CLOSING deal  — the Positions section lists each closed position with the time and
 *                     price it closed at, which identifies the deal that closed it.
 *
 * With that column filled in, computeBook's existing per-ticket path does the matching and the
 * figures agree with the broker. Nothing here invents a number: it only says which trade each
 * deal belongs to.
 */

/** The rows of one titled section — a title row, a header row, then data until the next title. */
function sectionRows(rows, title) {
  const isTitle = (r) => r.filter(Boolean).length === 1;
  const at = rows.findIndex((r) => isTitle(r) && new RegExp(`^${title}$`, "i").test(r.find(Boolean) || ""));
  if (at < 0) return [];
  const out = [];
  for (let i = at + 2; i < rows.length; i++) {      // +2 skips the title and its header
    const r = rows[i];
    if (r.filter(Boolean).length <= 1) break;
    out.push(r);
  }
  return out;
}

/** Same number written two ways in two sections ("0.01" / "0.010") must key the same. */
const keyNum = (v) => {
  const x = Number(String(v ?? "").replace(/[\s,]/g, ""));
  return Number.isFinite(x) ? String(x) : String(v ?? "").trim();
};
const keyTime = (v) => String(v ?? "").trim();

/**
 * Adds a "Position" column to a parsed MT5 deals table. Returns the new headers, or null when
 * this is not an MT5 deals table and nothing should change.
 */
export function mt5Positions(rows, headers, body) {
  const has = (name) => headers.some((h) => h.toLowerCase() === name);
  // Direction (in/out) with an Order column is the MT5 deals table and nothing else.
  if (!has("direction") || !has("order") || !has("deal")) return null;

  /*
   * Closed positions, keyed by the close they were matched to. Column positions rather than
   * names: this section has Time and Price TWICE — opened, then closed — and a lookup by name
   * would silently take the opening one and map every close to the wrong ticket.
   */
  const POS_TICKET = 1, POS_SYMBOL = 2, POS_VOLUME = 4, POS_CLOSE_TIME = 8, POS_CLOSE_PRICE = 9;
  const closedBy = new Map();
  for (const r of sectionRows(rows, "Positions")) {
    const ticket = String(r[POS_TICKET] ?? "").trim();
    if (!ticket) continue;
    closedBy.set(
      [String(r[POS_SYMBOL] ?? "").trim(), keyNum(r[POS_VOLUME]), keyTime(r[POS_CLOSE_TIME]), keyNum(r[POS_CLOSE_PRICE])].join("|"),
      ticket,
    );
  }

  let filled = 0;
  for (const row of body) {
    const dir = String(row.Direction ?? "").trim().toLowerCase();
    if (dir === "in") {
      // The opening order's ticket becomes the position's ticket.
      const order = String(row.Order ?? "").trim();
      if (order) { row.Position = order; filled += 1; }
    } else if (dir === "out") {
      const k = [String(row.Symbol ?? "").trim(), keyNum(row.Volume), keyTime(row.Time), keyNum(row.Price)].join("|");
      const ticket = closedBy.get(k);
      /*
       * Left blank when the close cannot be placed — a partial close, or a report whose
       * Positions section was trimmed by a date filter. Blank falls back to the account's
       * normal matching rather than guessing at a ticket, because a close attached to the
       * WRONG position is worse than one attached to none.
       */
      if (ticket) { row.Position = ticket; filled += 1; }
      else row.Position = "";
    } else {
      row.Position = "";
    }
  }

  if (!filled) return null;
  return { headers: [...headers, "Position"], matched: filled };
}

export function tableFromRows(raw) {
  const rows = resplit(raw.map((r) => r.map((c) => String(c ?? "")))).map((r) => r.map((c) => String(c ?? "").trim()));
  if (looksLikeTtFills(rows)) {
    const body = rows.filter((r) => r.filter(Boolean).length > 1);
    return {
      headers: TT_FILLS_HEADERS,
      rows: body.map((r) => Object.fromEntries(TT_FILLS_HEADERS.map((h, j) => [h, r[j] ?? ""]))),
      headerLine: 0,          // no header line in the file
      layout: "TT Fills (no header row)",
    };
  }
  let dealsAt = rows.findIndex((r) => r.filter(Boolean).length === 1 && /^deals$/i.test(r.find(Boolean) || ""));
  let best = -1, bestScore = 0;
  const from = dealsAt >= 0 ? dealsAt + 1 : 0;
  for (let i = from; i < Math.min(rows.length, from + 60); i++) {
    const sc = scoreHeader(rows[i]);
    if (sc > bestScore) { best = i; bestScore = sc; }
    if (sc >= 5) break;
  }
  if (best < 0 || bestScore < 3) throw new Error("couldn't find a header row with date, symbol, quantity and price columns");
  // de-duplicate blank/repeated header names
  const seen = {};
  const headers = rows[best].map((h, i) => {
    let name = h || `Column ${i + 1}`;
    if (seen[name]) name = `${name} (${++seen[name]})`; else seen[name] = 1;
    return name;
  });
  const body = [];
  for (let i = best + 1; i < rows.length; i++) {
    const r = rows[i];
    const filled = r.filter(Boolean).length;
    if (filled === 0) continue;
    if (filled === 1 && body.length) break; // next section title (e.g. "Open Positions") ends the table
    const obj = {};
    headers.forEach((h, j) => { obj[h] = r[j] ?? ""; });
    body.push(obj);
  }
  /*
   * An MT5 report gets its position tickets filled in before anybody sees the mapping screen,
   * so the Position column is simply there to be mapped like any other — and guessMapping
   * picks it up on its own.
   */
  const mt5 = mt5Positions(rows, headers, body);
  if (mt5) return { headers: mt5.headers, rows: body, headerLine: best + 1, layout: "MT5 report · position tickets recovered", mt5: mt5.matched };

  return { headers, rows: body, headerLine: best + 1 };
}

export function guessMapping(headers) {
  const map = {}, used = new Set();
  const pick = (f, re) => headers.find((x) => !used.has(x) && re.test(x));
  for (const f of FIELDS) { const h = pick(f, f.guess); if (h) { map[f.key] = h; used.add(h); } }
  for (const f of FIELDS) { if (!map[f.key] && f.loose) { const h = pick(f, f.loose); if (h) { map[f.key] = h; used.add(h); } } }
  // A lone "Time" column that holds the full timestamp is the date column.
  if (!map.date && map.time) { map.date = map.time; delete map.time; }
  if (map.time && map.time === map.date) delete map.time;
  return map;
}

const num = (v) => {
  if (v === undefined || v === null) return NaN;
  const s = String(v).replace(/[$,\s]/g, "").replace(/^\((.*)\)$/, "-$1");
  return s === "" ? NaN : Number(s);
};

function parseSide(v) {
  const s = String(v ?? "").trim().toLowerCase();
  if (/^(b|buy|bot|bought|long|bto|btc|1|\+1)$/.test(s) || s.startsWith("buy")) return "Buy";
  if (/^(s|sell|sld|sold|short|sto|stc|-1|ss)$/.test(s) || s.startsWith("sell")) return "Sell";
  return null;
}
// Rows that aren't trades (MT5 balance/credit rows, totals, etc.) are skipped quietly.
const NON_TRADE = /^(balance|credit|deposit|withdraw(al)?|charge|bonus|correction|commission|interest|dividend|tax|total|summary)/i;

// dateFormat: "auto" | "DMY" | "MDY"
export function parseDate(dateStr, timeStr, dateFormat = "auto") {
  let s = String(dateStr ?? "").trim();
  if (timeStr) s += " " + String(timeStr).trim();
  if (!s) return null;
  // Epoch timestamps: 10 digits = seconds, 13 = milliseconds (e.g. MT5 "time_msc")
  if (/^\d{10}(\.\d+)?$/.test(s)) return new Date(+s * 1000);
  if (/^\d{13}$/.test(s)) return new Date(+s);
  // ISO timestamps with a zone (e.g. Nexus backups: 2026-09-11T03:29:55.955Z)
  if (/^\d{4}-\d{2}-\d{2}T[\d:.]+(Z|[+-]\d{2}:?\d{2})$/i.test(s)) { const d = new Date(s); return isNaN(d) ? null : d; }
  const MON = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const timeOf = (rest) => {
    const t = (rest || "").trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?\s*(am|pm)?/i);
    if (!t) return [0, 0, 0, 0];
    let hh = +t[1];
    if (t[5]) { const pm = /pm/i.test(t[5]); if (pm && hh < 12) hh += 12; if (!pm && hh === 12) hh = 0; }
    return [hh, +t[2], t[3] ? +t[3] : 0, t[4] ? +String(t[4]).slice(0, 3).padEnd(3, "0") : 0];
  };
  // Month names: 11Sep26 (TT / Orient), 11-Sep-2026, 11 Sep 2026
  let mn = s.match(/^(\d{1,2})[ \-\/]?([A-Za-z]{3})[a-z]*[ \-\/]?(\d{2}|\d{4})(?:[ T,]+(.*))?$/);
  if (mn && MON[mn[2].toLowerCase()]) {
    const y = mn[3].length === 2 ? 2000 + +mn[3] : +mn[3];
    const d = new Date(y, MON[mn[2].toLowerCase()] - 1, +mn[1], ...timeOf(mn[4]));
    return isNaN(d) ? null : d;
  }
  // Year first: 2026-09-11, 2026.09.11 (MT5), 2026/09/11
  let m = s.match(/^(\d{4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})(?:[ T](.*))?$/);
  if (m) {
    const d = new Date(+m[1], +m[2] - 1, +m[3], ...timeOf(m[4]));
    return isNaN(d) ? null : d;
  }
  m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})(.*)$/);
  if (m) {
    let [, a, b, y, rest] = m;
    a = +a; b = +b; y = +y < 100 ? 2000 + +y : +y;
    let day, mon;
    if (dateFormat === "DMY") { day = a; mon = b; }
    else if (dateFormat === "MDY") { mon = a; day = b; }
    else if (a > 12) { day = a; mon = b; }
    else if (b > 12) { mon = a; day = b; }
    else { mon = a; day = b; }
    const d = new Date(y, mon - 1, day, ...timeOf(rest));
    return isNaN(d) ? null : d;
  }
  const d = new Date(s);
  return isNaN(d) ? null : d;
}

// Converts table rows to fills for one account. Returns { fills, errors, ignored, feesArePositiveCosts }.
// Spread instruments as named by TT/CME and similar platforms
export const isSpreadSymbol = (s) => /( - |inter-?product|crack|calendar|\bspread\b|\bvs\.?\b|\bspr\b)/i.test(String(s));

// spreadMode: "spread" keep spread fills and drop their legs (default), "legs" the reverse, "all" keep both.
export function rowsToFills(rows, map, { dateFormat = "auto", defaultBroker = "default", resolveBroker = () => null, feeMode = "auto", spreadMode = "spread" } = {}) {
  const fills = [], errors = [], seen = {}, cash = [];
  let ignored = 0;
  // Fees: MT5 shows costs as negatives; many futures statements show them as positive amounts.
  const feeVals = [];
  if (map.fee) rows.forEach((r) => { const v = num(r[map.fee]); if (v) feeVals.push(v); });
  const positiveCosts = feeMode === "cost" || (feeMode === "auto" && feeVals.length > 0 && feeVals.every((v) => v > 0));
  // Broker epoch times are the server's clock. One offset for the whole file (median, to the minute)
  // converts to real time without reordering fills that are seconds apart.
  let offsetMs = 0;
  if (map.offset) {
    const offs = rows.map((r) => num(r[map.offset])).filter((v) => isFinite(v)).sort((a, b) => a - b);
    if (offs.length) offsetMs = Math.round(offs[Math.floor(offs.length / 2)] / 60) * 60 * 1000;
  }

  rows.forEach((row, i) => {
    const line = i + 2;
    const rawSide = map.side ? String(row[map.side] ?? "").trim() : "";
    const product = String(row[map.product] ?? "").trim();
    if ((rawSide && NON_TRADE.test(rawSide)) || (!product && !num(row[map.qty]))) {
      ignored++;
      // MT5 "balance" rows are deposits (+) and withdrawals (-); the amount is in the Profit column
      if (/^(balance|deposit|withdraw)/i.test(rawSide) && map.profit) {
        const amt = num(row[map.profit]);
        let d0 = parseDate(row[map.date], map.time ? row[map.time] : "", dateFormat);
        if (d0 && offsetMs && /^\d{10,13}(\.\d+)?$/.test(String(row[map.date] ?? "").trim())) d0 = new Date(d0.getTime() - offsetMs);
        const rb = map.broker ? String(row[map.broker] ?? "").trim() : "";
        const comment = Object.entries(row).find(([k]) => /^comment$/i.test(k))?.[1] || "";
        if (amt && d0) cash.push({ ts: d0.toISOString(), broker: rb ? resolveBroker(rb) || rb : defaultBroker, type: amt > 0 ? "deposit" : "withdrawal", amount: Math.abs(amt), note: String(comment || "From MT5 report").trim(), ref: map.ref ? String(row[map.ref] ?? "").trim() : "" });
      }
      return;
    }

    let d = parseDate(row[map.date], map.time ? row[map.time] : "", dateFormat);
    if (d && offsetMs && /^\d{10,13}(\.\d+)?$/.test(String(row[map.date] ?? "").trim())) d = new Date(d.getTime() - offsetMs);
    let qty = num(String(row[map.qty] ?? "").split("/")[0]); // MT5 order reports show "1 / 1"
    const price = num(row[map.price]);
    let side = rawSide ? parseSide(rawSide) : null;
    if (!side && !map.side && !isNaN(qty) && qty !== 0) side = qty > 0 ? "Buy" : "Sell";
    qty = Math.abs(qty);

    const problems = [];
    if (!d) problems.push("date not recognised");
    if (!product) problems.push("no product");
    if (!side) problems.push(rawSide ? `"${rawSide}" isn't buy or sell` : "buy/sell missing");
    if (!(qty > 0)) problems.push("quantity missing");
    if (isNaN(price)) problems.push("price missing");
    if (problems.length) { errors.push(`Line ${line}: ${problems.join(", ")}`); return; }

    let fee = 0;
    if (map.fee) { const v = num(row[map.fee]) || 0; fee += positiveCosts ? -Math.abs(v) : v; }
    if (map.swap) fee += num(row[map.swap]) || 0;

    const rawBroker = map.broker ? String(row[map.broker] ?? "").trim() : "";
    const broker = rawBroker ? resolveBroker(rawBroker) || rawBroker : defaultBroker;
    const ts = d.toISOString();
    let ref = map.ref ? String(row[map.ref] ?? "").trim() : "";
    const orderId = ref;
    // Order IDs are shared by a spread and its legs (and by partial fills), so a fill is identified by
    // ID + symbol + side + price + time. Rows identical on all of these are true duplicates.
    if (ref) ref = `${ref}|${product}|${side}|${price}|${d.getTime()}`;
    if (!ref) {
      const key = `${broker}|${ts}|${product}|${side}|${qty}|${price}`;
      seen[key] = (seen[key] || 0) + 1;
      ref = `fp:${key}|${seen[key]}`;
    }
    const account = map.account ? String(row[map.account] ?? "").trim() || null : null;
    const position = map.position ? String(row[map.position] ?? "").trim() || null : null;
    const f = { ts, broker, product, side, qty, price, fee: +fee.toFixed(6), ref, account, position, source: "csv", order_id: orderId || null, is_leg: false, _order: orderId };
    if (map.profit) { const pv = num(row[map.profit]); if (isFinite(pv)) f._profit = pv; }
    fills.push(f);
  });
  // Spread orders: an order ID holding a spread fill and its leg fills is one trade shown several ways.
  // The side that isn't the trade is kept as a leg (is_leg) rather than thrown away, so the fills that
  // made up a spread can still be looked at. Legs are skipped by every position, margin and P&L sum.
  let legsSkipped = 0, spreadsSkipped = 0, spreadOrders = 0;
  if (map.ref && spreadMode !== "all") {
    const byOrder = {};
    fills.forEach((f) => { if (f._order) (byOrder[f._order] ||= []).push(f); });
    for (const list of Object.values(byOrder)) {
      const sp = list.filter((f) => isSpreadSymbol(f.product)), legs = list.filter((f) => !isSpreadSymbol(f.product));
      if (!sp.length || !legs.length) continue;
      spreadOrders++;
      (spreadMode === "spread" ? legs : sp).forEach((f) => { f.is_leg = true; });
    }
    fills.forEach((f) => { if (f.is_leg) { if (isSpreadSymbol(f.product)) spreadsSkipped++; else legsSkipped++; } });
  }
  fills.forEach((f) => delete f._order);
  return { fills, errors, ignored, nonTrade: ignored, feesArePositiveCosts: positiveCosts, offsetMs, legsSkipped, spreadsSkipped, spreadOrders, cash };
}

// Orient fills export (TT): what you get from the Fills grid with right-click → Select All → save
// as CSV. 15 columns and NO header row; one order ID per trade, and a spread order appears as the
// spread fill plus its two leg fills under that same ID. Account and IDs here are placeholders.
export const ORIENT_TEMPLATE_CSV = [
  "10Sep26,09:15:02.114 ,CME,CL Nov26,S,1,97.78,F,Direct,YOUR-ACCOUNT,TRADER,TRADER,0001-sample-order-a,,",
  "10Sep26,09:15:02.114 ,CME,BZ Nov26,B,1,107.08,F,Direct,YOUR-ACCOUNT,TRADER,TRADER,0001-sample-order-a,,",
  "10Sep26,09:15:02.114 ,CME,CL Nov26 - BZ Nov26 Inter-Product,S,1,-9.30,F,Direct,YOUR-ACCOUNT,TRADER,TRADER,0001-sample-order-a,,",
  "10Sep26,14:40:51.380 ,CME,Oct26 HO-CL Crack,B,1,110.00,F,Direct,YOUR-ACCOUNT,TRADER,TRADER,0002-sample-order-b,,",
  "10Sep26,14:40:51.380 ,CME,CL Oct26,S,1,98.80,F,Direct,YOUR-ACCOUNT,TRADER,TRADER,0002-sample-order-b,,",
  "10Sep26,14:40:51.380 ,CME,HO Oct26,B,1,4.9714,F,Direct,YOUR-ACCOUNT,TRADER,TRADER,0002-sample-order-b,,",
  "11Sep26,07:29:55.955 ,CME,CL Nov26,B,1,97.50,F,Direct,YOUR-ACCOUNT,TRADER,TRADER,0003-sample-order-c,,",
  "11Sep26,07:29:55.955 ,CME,BZ Nov26,S,1,106.90,F,Direct,YOUR-ACCOUNT,TRADER,TRADER,0003-sample-order-c,,",
  "11Sep26,07:29:55.955 ,CME,CL Nov26 - BZ Nov26 Inter-Product,B,1,-9.40,F,Direct,YOUR-ACCOUNT,TRADER,TRADER,0003-sample-order-c,,",
].join("\r\n") + "\r\n";

export const TEMPLATE_CSV =
  "Date,Time,Symbol,Side,Qty,Price,Fill ID,Commission\n" +
  "2026-09-10,09:15:02,BZ_CL,Buy,3,4.25,F1001,6.00\n" +
  "2026-09-10,10:02:47,BZ_CL,Buy,2,4.31,F1002,4.00\n" +
  "2026-09-10,14:30:10,BZ_CL,Sell,5,4.40,F1003,10.00\n" +
  "2026-09-11,08:05:33,CL_CL,Sell,2,0.62,F1004,4.00\n" +
  "2026-09-11,09:41:05,HO_CL,Buy,1,31.80,F1005,2.00\n" +
  "2026-09-11,10:12:19,HO_CL,Buy,2,31.50,F1006,4.00\n";

// Shape of an MT5 "Deals" export (History → Report, saved as CSV).
export const MT5_TEMPLATE_CSV =
  "Trade History Report\n" +
  "Deals\n" +
  "Time,Deal,Symbol,Type,Direction,Volume,Price,Order,Commission,Fee,Swap,Profit,Balance,Comment\n" +
  "2026.09.10 08:00:00,1000,,balance,,,,,0.00,0.00,0.00,50000.00,50000.00,Deposit\n" +
  "2026.09.10 09:30:11,1001,XBRUSD,buy,in,1.00,67.25,2001,-7.00,0.00,0.00,0.00,49993.00,\n" +
  "2026.09.10 13:05:40,1002,XBRUSD,buy,in,0.50,66.90,2002,-3.50,0.00,0.00,0.00,49989.50,\n" +
  "2026.09.11 07:15:02,1003,XBRUSD,sell,out,1.50,67.60,2003,-10.50,0.00,-4.20,0.00,49974.80,\n" +
  "2026.09.11 09:02:55,1004,XTIUSD,sell,in,2.00,63.80,2004,-14.00,0.00,0.00,0.00,49960.80,\n";

// ---------- duplicate detection ----------
// A fill's "content key": same product, side, quantity and price at the same second.
export const contentKey = (f) => {
  const t = Math.floor(new Date(f.ts).getTime() / 1000);
  return `${f.broker || "default"}|${String(f.product).trim().toUpperCase()}|${f.side}|${+(+f.qty).toFixed(8)}|${+(+f.price).toFixed(8)}|${t}`;
};
const isBrokerRef = (ref) => ref && !/^(fp|m):/.test(ref);

/**
 * Classifies incoming CSV fills against what's already stored.
 * status: "new" | "stored" (already in the portal) | "file-dup" (repeated in this file) | "manual" (matches a manually recorded trade)
 * Identical fills are counted, not collapsed: if the portal holds 2 identical fills and the file has 3, one is new.
 */
export function classifyFills(incoming, existing, { manualWindowMin = 15 } = {}) {
  const rk = (f) => `${f.broker || "default"}|${f.ref}`;
  const storedRefs = new Set(existing.map(rk));
  const available = {};
  for (const f of existing) { const k = contentKey(f); available[k] = (available[k] || 0) + 1; }

  const seenRefs = new Set();
  const rows = incoming.map((f) => ({ ...f, key: contentKey(f), status: null }));

  // 1) repeated broker fill IDs inside the file, and IDs already stored
  for (const r of rows) {
    if (isBrokerRef(r.ref)) {
      if (seenRefs.has(rk(r))) { r.status = "file-dup"; continue; }
      seenRefs.add(rk(r));
    }
    if (storedRefs.has(rk(r))) { r.status = "stored"; if (available[r.key] > 0) available[r.key]--; }
  }
  // 2) same trade already stored under a different ID / format
  for (const r of rows) {
    if (r.status) continue;
    if (available[r.key] > 0) { r.status = "stored"; available[r.key]--; }
  }
  // 3) trades recorded by hand on the ticket (time differs; match on product/side/qty/price nearby in time)
  const manual = existing.filter((f) => f.source === "manual").map((f) => ({ ...f, used: false }));
  const win = manualWindowMin * 60 * 1000;
  for (const r of rows) {
    if (r.status) continue;
    const t = new Date(r.ts).getTime();
    const m = manual.find((x) => !x.used && (x.broker || "default") === (r.broker || "default") && x.product.toUpperCase() === r.product.toUpperCase() && x.side === r.side
      && Math.abs(+x.qty - +r.qty) < 1e-9 && Math.abs(+x.price - +r.price) < 1e-9 && Math.abs(new Date(x.ts).getTime() - t) <= win);
    if (m) { m.used = true; r.status = "manual"; r.matchTs = m.ts; }
    else r.status = "new";
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  return { rows, counts: { new: count("new"), stored: count("stored"), fileDup: count("file-dup"), manual: count("manual") } };
}

export const TEMPLATE_MT5 = MT5_TEMPLATE_CSV;

// Estimates contract size per broker|product from the broker's own P&L on closing deals:
// size = broker profit / (price move × lots). Replays positions with size 1 using average cost.
export function estimateSizes(fills) {
  const by = {};
  [...fills].sort((a, b) => new Date(a.ts) - new Date(b.ts)).forEach((f) => { (by[`${f.broker}|${f.product}`] ||= []).push(f); });
  const out = {};
  for (const [k, list] of Object.entries(by)) {
    const ratios = [];
    const openPx = {}; // position ticket -> [price, side]
    let pos = 0, avg = 0;
    for (const f of list) {
      const q = f.side === "Buy" ? +f.qty : -f.qty, price = +f.price;
      const t = f.position && openPx[f.position];
      if (t && t[1] !== f.side) {
        // closes a specific ticket
        const pnl1 = (t[1] === "Buy" ? 1 : -1) * (price - t[0]) * Math.abs(q);
        if (f._profit && Math.abs(pnl1) > 1e-12) ratios.push(f._profit / pnl1);
        continue;
      }
      if (f.position && !openPx[f.position]) { openPx[f.position] = [price, f.side]; continue; }
      if (pos === 0 || Math.sign(q) === Math.sign(pos)) {
        avg = pos === 0 ? price : (Math.abs(pos) * avg + Math.abs(q) * price) / (Math.abs(pos) + Math.abs(q));
        pos += q;
      } else {
        const closeQty = Math.min(Math.abs(q), Math.abs(pos));
        const pnl1 = Math.sign(pos) * (price - avg) * closeQty;
        if (f._profit && Math.abs(pnl1) > 1e-12) ratios.push(f._profit / pnl1);
        pos += Math.sign(q) * closeQty;
        if (Math.abs(pos) < 1e-9) pos = 0;
      }
    }
    const good = ratios.filter((r) => r > 0 && isFinite(r)).sort((a, b) => a - b);
    if (good.length) {
      const med = good[Math.floor(good.length / 2)];
      const mag = Math.pow(10, Math.floor(Math.log10(med)) - 1);
      out[k] = { size: Math.round(med / mag) * mag, samples: good.length };
    }
  }
  return out;
}

/**
 * Turn a proposed column mapping into one that can safely be used.
 *
 * Pure, and separated from the endpoint that calls it, because this is the check standing
 * between a suggestion and somebody's margin figures — so it runs on plain Node against
 * worked examples in scripts/mapping-check.mjs rather than only in production.
 *
 * A schema-validated answer is well FORMED, not true. "Price" is a perfectly valid string
 * whether or not this file has a column called Price. Three things are enforced here that
 * no schema can:
 *
 *   - every header must actually exist in the file. A mapping pointing at a column that is
 *     not there yields empty fills rather than an error, and empty fills are how a book
 *     goes quietly wrong.
 *   - one column cannot fill two fields. Mapping the same column to both qty and price
 *     produces a plausible-looking import that is nonsense.
 *   - anything dropped is counted and reported, never silently swallowed.
 */
export function sanitiseMapping(proposed, headers) {
  const known = new Set((headers ?? []).filter((h) => typeof h === "string"));
  const map = {};
  const claimed = new Set();
  const dropped = [];

  for (const field of FIELDS) {
    const h = proposed?.[field.key];
    if (typeof h !== "string" || !h) continue;
    if (!known.has(h)) { dropped.push({ key: field.key, header: h, why: "absent" }); continue; }
    // First field to claim a column keeps it: FIELDS is in the order a statement is read,
    // so the earlier field is the likelier owner.
    if (claimed.has(h)) { dropped.push({ key: field.key, header: h, why: "taken" }); continue; }
    claimed.add(h);
    map[field.key] = h;
  }

  const dateFormat = ["auto", "DMY", "MDY"].includes(proposed?.dateFormat) ? proposed.dateFormat : "auto";
  const confidence = ["high", "medium", "low"].includes(proposed?.confidence) ? proposed.confidence : "low";

  return { map, dateFormat, confidence, dropped };
}

/*
 * Which column layout to use for a file: the broker's saved one, or a fresh guess.
 *
 * A saved layout is kept when every column it names is still in the file — a broker whose
 * statements have a stable shape should not need re-mapping every time.
 *
 * With one exception, and it is the reason this is a function rather than two lines in the
 * component. When the reader has recovered MT5 position tickets it adds a `Position`
 * column of its own, and that column always wins. The saved layout was written before the
 * app could read tickets, so it cannot have an opinion about a column that did not exist;
 * what it does have is `position` pointed at MT5's Comment field, which holds strings like
 * "LADDER0004-130a" and, on a close, the literal word "CLOSE". A close whose ticket is
 * "CLOSE" matches no open lot, so every trade falls through to average matching and the
 * book shows no closed trades at all. The tickets were in the file; the saved layout was
 * aiming past them.
 *
 * Overruling it is safe because this is not a column the trader chose. It is one we derive.
 */
export function mappingFor(headers, savedMap, mt5 = 0) {
  const cols = headers ?? [];
  const usedSaved = Boolean(savedMap) && Object.values(savedMap).every((h) => cols.includes(h));
  const map = usedSaved ? { ...savedMap } : guessMapping(cols);
  if (mt5 > 0 && cols.includes("Position")) map.position = "Position";
  return { map, usedSaved };
}
