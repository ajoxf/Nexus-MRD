/*
 * The demo account, at /demo.
 *
 * An invented trader at an invented group account (204418, "DEMO TRADING ACCOUNT"), with about
 * six weeks of TT fills and the Orient daily statements those fills would have produced: the
 * Financial Summary for the group and both sub-accounts, the Open Position file, the Trade
 * Confirmations and the Offset Records, in Orient's own layouts. Everything is generated here,
 * in the browser, from a fixed seed — no real account, trade or price is in it, and nothing is
 * read from or written to the database.
 *
 * The dates are relative to today, so the demo always ends with yesterday's statement. The
 * prices are a seeded random walk shaped into a story the risk screens can tell:
 *
 *   1. weeks 1–3   small spread trades, mostly right — the account makes money
 *   2. week 4      a short HO–CL crack goes against the trader, who sells more on the way up:
 *                  averaging down, TNE / IM under 200%, the day's loss limit, a drawdown
 *   3. weeks 5–6   the crack is cut, a deposit goes in, smaller size, some of it back
 *
 * and ends with three spreads open, the nearest leg expiring within the month.
 *
 * The statements are worked the way Orient works them: each leg matched first in, first out
 * against that contract's oldest open lot, commission and exchange fees per leg per lot, open
 * lots marked at the day's settlement. So every check on the Statements tab passes, and the
 * fills tie to the trade confirmations lot for lot — which is the point of showing it.
 */

export const DEMO = {
  group: "204418",
  groupDashed: "2-04418",
  name: "DEMO TRADING ACCOUNT",
  ttAccount: "2044180011-DMO",
};

const DAYS = 32;                     // statement days in the demo
const SIZE = { CL: 1000, BZ: 1000, HO: 42000 };
const FEES = { CL: 1.5, BZ: 0.77, HO: 1.6 };   // exchange fee per lot per side
const COMM = 0.35, NFA = 0.01;
const IM = { "Inter-Product": 3300, Crack: 4400, Calendar: 1100 };
const MM_OF_IM = 0.909;
const ORIENT_LEAD_HOURS = 4;         // Orient's clock runs ahead of TT's, as on the real files
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// ---------- small helpers ----------
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const f2 = (x) => (Math.round(x * 100) / 100).toFixed(2);
const pad = (n, w = 2) => String(n).padStart(w, "0");
const ymd = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const iso = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isWeekday = (d) => d.getDay() !== 0 && d.getDay() !== 6;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const monthKey = (y, m) => `${y}${pad(m + 1)}`;                  // m: 0-based
const monthName = (y, m) => `${MONTHS[m]}${String(y).slice(2)}`;

// The last weekday of a month, and the weekday n business days before a date.
function lastWeekday(y, m) { let d = new Date(y, m + 1, 0); while (!isWeekday(d)) d = addDays(d, -1); return d; }
function weekdaysBefore(d, n) { let x = new Date(d); while (n > 0) { x = addDays(x, -1); if (isWeekday(x)) n--; } return x; }

/*
 * Approximate last trading days, by the exchanges' rules on weekdays only (holidays ignored —
 * it is a demo): Brent, the last business day of the second month before delivery; WTI, three
 * business days before the 25th of the month before; heating oil, the last business day of the
 * month before.
 */
function lastTradingDay(code, y, m) {
  if (code === "BZ") return lastWeekday(y, m - 2);
  if (code === "HO") return lastWeekday(y, m - 1);
  let d25 = new Date(y, m - 1, 25);
  while (!isWeekday(d25)) d25 = addDays(d25, -1);
  return weekdaysBefore(d25, 3);
}

// ---------- the generator ----------
export function buildDemo(today = new Date()) {
  const rand = rng(4418);
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += rand(); return (s - 3) / Math.SQRT1_2 / 1.41; };

  // Statement days: the DAYS weekdays up to and including the last one before today.
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const days = [];
  for (let d = addDays(base, -1); days.length < DAYS; d = addDays(d, -1)) if (isWeekday(d)) days.unshift(new Date(d));

  // The front month: the first whose Brent leg still has three weeks to run, so the expiry list
  // has something to say without the demo opening on a roll.
  let fy = today.getFullYear(), fm = today.getMonth() + 2;
  while (true) {
    const y = fy + Math.floor(fm / 12), m = fm % 12;
    if ((lastTradingDay("BZ", y, m) - base) / 86400000 >= 15) { fy = y; fm = m; break; }
    fm++;
  }
  const nx = { y: fy + (fm === 11 ? 1 : 0), m: (fm + 1) % 12 };
  const M1 = monthName(fy, fm), M2 = monthName(nx.y, nx.m);
  const K1 = monthKey(fy, fm), K2 = monthKey(nx.y, nx.m);
  const P = {
    inter: `CL ${M1} - BZ ${M1} Inter-Product`,
    crack: `${M1} HO-CL Crack`,
    cal: `CL ${M1}-${M2} Calendar`,
  };
  const KIND = { [P.inter]: "Inter-Product", [P.crack]: "Crack", [P.cal]: "Calendar" };
  const expiry = {
    [`CL|${K1}`]: lastTradingDay("CL", fy, fm), [`BZ|${K1}`]: lastTradingDay("BZ", fy, fm),
    [`HO|${K1}`]: lastTradingDay("HO", fy, fm), [`CL|${K2}`]: lastTradingDay("CL", nx.y, nx.m),
  };

  // Daily settlements: CL outright, the CL–BZ spread, the crack, the calendar.
  const cl = [], inter = [], crack = [], cal = [];
  let c = 72.4, s = -3.4, k = 31.2, q = 0.42;
  for (let i = 0; i < DAYS; i++) {
    c += gauss() * 0.55;
    s += gauss() * 0.07;
    if (i >= 16 && i <= 21) k += 0.7 + gauss() * 0.12;           // the crack runs against the short
    else if (i > 21) k += -0.32 + gauss() * 0.15;
    else k += gauss() * 0.25;
    q += gauss() * 0.025;
    cl.push(r2(c)); inter.push(r2(s)); crack.push(r4(k)); cal.push(r2(q));
  }
  const settleOf = (i) => {
    const CL = cl[i], BZ = r2(CL - inter[i]), HO = r4((crack[i] + CL) / 42), CL2 = r2(CL - cal[i]);
    return { [`CL|${K1}`]: CL, [`BZ|${K1}`]: BZ, [`HO|${K1}`]: HO, [`CL|${K2}`]: CL2 };
  };

  // An intraday price for a product: the move from yesterday's settlement to today's, part done.
  const spreadPx = { [P.inter]: inter, [P.crack]: crack, [P.cal]: cal };
  const priceAt = (product, i, frac, edge = 0) => {
    const path = spreadPx[product];
    const prev = i > 0 ? path[i - 1] : path[0];
    const sd = product === P.crack ? 0.06 : 0.02;
    return prev + (path[i] - prev) * frac + gauss() * sd + edge;
  };
  const clAt = (i, frac) => r2((i > 0 ? cl[i - 1] : cl[0]) + (cl[i] - (i > 0 ? cl[i - 1] : cl[0])) * frac + gauss() * 0.08);

  // ---- the trader's orders ----
  const orders = [];   // { i, frac, product, side, qty }
  // good: a fill with the trader's usual edge — a little better than the middle of the market.
  const order = (i, frac, product, side, qty, good = false) => orders.push({ i, frac, product, side, qty, good });
  const flip = (side) => (side === "Buy" ? "Sell" : "Buy");

  // 1. Weeks 1–3: round trips in the direction of the day's move, now and then wrong.
  for (let i = 1; i <= 15; i++) {
    const prods = i % 3 === 0 ? [P.crack, P.cal] : [P.inter, P.crack];
    prods.forEach((p, j) => {
      const path = spreadPx[p];
      const up = path[i] >= path[i - 1];
      const right = rand() > 0.22;
      const side = (up === right) ? "Buy" : "Sell";
      const qty = p === P.cal ? 3 + Math.floor(rand() * 3) : 4 + Math.floor(rand() * 4);
      const open = 0.12 + j * 0.06 + rand() * 0.05;
      order(i, open, p, side, qty, right);
      if (i % 5 === 4 && j === 0) order(i + 1, 0.3 + rand() * 0.2, p, flip(side), qty, right);   // held overnight
      else order(i, 0.78 + rand() * 0.15, p, flip(side), qty, right);
    });
  }
  // 2. Week 4: short the crack, and keep selling as it rises.
  order(16, 0.25, P.crack, "Sell", 3);
  order(16, 0.4, P.inter, "Buy", 14);
  order(16, 0.55, P.cal, "Buy", 6);
  order(17, 0.35, P.crack, "Sell", 3);
  order(18, 0.3, P.crack, "Sell", 3);
  order(19, 0.4, P.crack, "Sell", 3);
  order(20, 0.6, P.crack, "Buy", 6);
  order(21, 0.45, P.crack, "Buy", 6);
  // 3. Weeks 5–6: out of the rest, smaller, mostly right again; three spreads left open.
  order(22, 0.5, P.inter, "Sell", 14);
  order(23, 0.3, P.cal, "Sell", 6);
  for (let i = 24; i <= 30; i++) {
    const p = i % 2 ? P.crack : P.inter;
    const path = spreadPx[p];
    const right = rand() > 0.2;
    const side = (path[i] >= path[i - 1]) === right ? "Buy" : "Sell";
    const qty = 2 + Math.floor(rand() * 3);
    order(i, 0.15 + rand() * 0.1, p, side, qty, right);
    order(i, 0.8 + rand() * 0.1, p, flip(side), qty, right);
  }
  order(27, 0.45, P.cal, "Buy", 2);
  order(29, 0.55, P.inter, "Buy", 4);
  order(30, 0.62, P.crack, "Sell", 3);
  orders.sort((a, b) => a.i - b.i || a.frac - b.frac);

  // ---- fills, and the Orient trades they become ----
  const fills = [];
  const trades = [];   // per leg: { i, tradeId, orderId, code, key, month, side: "B"|"S", price, qty, time, tradeDate }
  let tid = 95_812_000, oid = 8_067_700_000_000, fid = 1;
  const EDGE = { [P.inter]: 0.05, [P.crack]: 0.14, [P.cal]: 0.03 };
  const legsOf = (product, side, qty, i, frac, good) => {
    const sp = priceAt(product, i, frac, good ? (side === "Buy" ? -EDGE[product] : EDGE[product]) : 0);
    const CL = clAt(i, frac);
    const buy = side === "Buy";
    if (product === P.inter) {
      const BZ = r2(CL - sp);
      return { price: r2(CL - BZ), legs: [["CL", K1, buy, CL], ["BZ", K1, !buy, BZ]] };
    }
    if (product === P.crack) {
      const HO = r4((sp + CL) / 42);
      return { price: r4(HO * 42 - CL), legs: [["HO", K1, buy, HO], ["CL", K1, !buy, CL]] };
    }
    const CL2 = r2(CL - sp);
    return { price: r2(CL - CL2), legs: [["CL", K1, buy, CL], ["CL", K2, !buy, CL2]] };
  };
  for (const o of orders) {
    const day = days[o.i];
    // Orient's clock: 05:00–18:00 on the trade date; TT's is four hours behind it.
    const mins = Math.round(5 * 60 + o.frac * 13 * 60);
    const orientAt = new Date(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(mins / 60), mins % 60, Math.floor(rand() * 60));
    const ttUtc = new Date(Date.UTC(day.getFullYear(), day.getMonth(), day.getDate(), Math.floor(mins / 60) - ORIENT_LEAD_HOURS, mins % 60, orientAt.getSeconds()));
    const { price, legs } = legsOf(o.product, o.side, o.qty, o.i, o.frac, o.good);
    const orderId = String(oid += 1 + Math.floor(rand() * 9000));
    const ts = ttUtc.toISOString();
    const common = { ts, broker: "orient", account: DEMO.ttAccount, source: "csv", fee: 0, order_id: orderId };
    fills.push({ ...common, id: `demo-${fid}`, ref: `DMO${pad(fid++, 6)}`, product: o.product, side: o.side, qty: o.qty, price, is_leg: false });
    for (const [code, month, isBuy, px] of legs) {
      fills.push({ ...common, id: `demo-${fid}`, ref: `DMO${pad(fid++, 6)}`, product: `${code} ${monthName(+month.slice(0, 4), +month.slice(4) - 1)}`, side: isBuy ? "Buy" : "Sell", qty: o.qty, price: px, is_leg: true });
      trades.push({
        i: o.i, tradeId: `TT${tid += 1 + Math.floor(rand() * 40)}`, orderId, code, month, key: `${code}|${month}`,
        side: isBuy ? "B" : "S", price: px, qty: o.qty, tradeDate: ymd(day),
        time: `${iso(orientAt)} ${pad(orientAt.getHours())}:${pad(orientAt.getMinutes())}:${pad(orientAt.getSeconds())}`,
      });
    }
  }

  // ---- Orient's books, day by day ----
  const open = new Map();   // key → [{ tradeId, orderId, side, price, qty, tradeDate }]
  const book = new Map();   // the trader's spread positions, for margin: product → signed lots
  const cash = { 0: { "0000": 150000, "0011": 50000 }, 20: { "0011": 25000 } };
  let bal = { "0000": 0, "0011": 0 };
  const statements = [];
  const G = DEMO.group, GD = DEMO.groupDashed;
  const sub = (s) => `${G}${s}`;
  const FS_HEAD = "Acct Name,Acct No.,CCY,Exchange Rate,Balance Type,Beginning Balance,Cash Adjustments,Commission,Fee,GST,Profit/Loss,Options Premium,Interest,Ending Balance,Total Unrealised Profit/loss (UPL),FX Open Positions UPL,FX Closed Positions Forward PL,F&O Open Position UPL,Total Equity,Collateral MTM,Total net equity,Net Option Value,Net liquidating value,Account Market Value,Total IM,Total MM,Margin Excess/Deficit";
  const OP_HEAD = "SettlementDate,TradeEntryID,ExchangeOrderID,Client group account number,Client sub account number,TradeDate,ExchangeMIC,ClearingCode,ContractExpiryMonth,Expiry Date,ValueDate,CallPutFut,StrikePrice,TradePrice,BuySell,Amount,SettPrice,UnrealisedPL,Option value,TradePLCcy,Remark";
  const TC_HEAD = "SettlementDate,TradeEntryID,ExchangeOrderID,Client group account number,Client sub account number,TradeDate,ExchangeMIC,ClearingCode,ContractExpiry,ValueDate,CallPutFut,StrikePrice,TradePrice,BuySell,Amount,Premium,PremiumCcy,Remark,Trade Type,Execution Time,Expiry Date,FinalComm,FinalCommCcy,Exchange Fee amount,Exchange Fee CCY,NFA amount,NFA CCY";
  const OR_HEAD = "SettlementDate,Client group account number,Client sub account number,TradeDate,ExchangeMIC,ClearingCode,ContractExpiry,ValueDate,CallPutFut,StrikePrice,Quantity,BuyTradePrice,SellTradePrice,RealisedPL,TradePLCcy,BuyTradeEntryID,BuyExchangeOrderID,SellTradeEntryID,SellExchangeOrderID,Remark";
  const fsRow = (name, no, a) => {
    const vals = [a.beginning, a.cashAdj, a.commission, a.fee, 0, a.pl, 0, a.interest, a.ending, a.upl, 0, 0, a.upl, a.equity, 0, a.equity, 0, a.equity, a.equity, a.im, a.mm, a.equity - a.im].map(f2);
    return [`${name},${no},Base:USD,,,${vals.join(",")}`, `${name},${no},USD,1.00000000,,${vals.join(",")}`];
  };

  days.forEach((day, i) => {
    const D = ymd(day);
    const set = settleOf(i);
    const todays = trades.filter((t) => t.i === i);
    let pl = 0, comm = 0, fee = 0;
    const offsets = [];
    for (const t of todays) {
      comm -= COMM * t.qty;
      fee -= (FEES[t.code] + NFA) * t.qty;
      const q = open.get(t.key) || [];
      let left = t.qty;
      while (left > 0 && q.length && q[0].side !== t.side) {
        const lot = q[0];
        const n = Math.min(left, lot.qty);
        const [buy, sell] = t.side === "B" ? [t, lot] : [lot, t];
        const realised = r2((sell.price - buy.price) * n * SIZE[t.code]);
        pl += realised;
        offsets.push([D, GD, "0011", lot.tradeDate, "XNYM", t.code, t.month, lot.tradeDate, "F", "", n.toFixed(8), buy.price, sell.price, f2(realised), "USD", buy.tradeId, buy.orderId, sell.tradeId, sell.orderId, ""]);
        lot.qty -= n; left -= n;
        if (!lot.qty) q.shift();
      }
      if (left > 0) q.push({ tradeId: t.tradeId, orderId: t.orderId, side: t.side, price: t.price, qty: left, tradeDate: t.tradeDate });
      open.set(t.key, q);
    }
    for (const o of orders.filter((x) => x.i === i)) book.set(o.product, (book.get(o.product) || 0) + (o.side === "Buy" ? o.qty : -o.qty));

    // Open lots at the settlement.
    const opRows = [];
    let upl = 0;
    for (const [key, q] of open) for (const lot of q) {
      const [code, month] = key.split("|");
      const u = r2((set[key] - lot.price) * lot.qty * SIZE[code] * (lot.side === "B" ? 1 : -1));
      upl += u;
      opRows.push([D, lot.tradeId, lot.orderId, GD, "0011", lot.tradeDate, "XNYM", code, month, ymd(expiry[key]), lot.tradeDate, "F", "", lot.price, lot.side, lot.qty, set[key], f2(u), "", "USD", ""]);
    }
    upl = r2(upl);
    const im = r2([...book].reduce((t, [p, n]) => t + Math.abs(n) * IM[KIND[p]], 0));

    // The two sub-accounts and the group.
    const add = cash[i] || {};
    const acct = (s, isTrading) => {
      const a = { beginning: bal[s], cashAdj: add[s] || 0, commission: isTrading ? r2(comm) : 0, fee: isTrading ? r2(fee) : 0, pl: isTrading ? r2(pl) : 0, interest: 0 };
      a.ending = r2(a.beginning + a.cashAdj + a.commission + a.fee + a.pl + a.interest);
      a.upl = isTrading ? upl : 0;
      a.equity = r2(a.ending + a.upl);
      a.im = isTrading ? im : 0;
      a.mm = isTrading ? r2(im * MM_OF_IM) : 0;
      return a;
    };
    const s0 = acct("0000", false), s1 = acct("0011", true);
    const grp = {};
    for (const k2 of ["beginning", "cashAdj", "commission", "fee", "pl", "interest", "ending", "upl", "equity", "im", "mm"]) grp[k2] = r2(s0[k2] + s1[k2]);
    bal = { "0000": s0.ending, "0011": s1.ending };

    const n0 = `${DEMO.name}-0000`, n1 = `${DEMO.name}-0011`;
    const fsGroup = [FS_HEAD, ...fsRow(DEMO.name, G, grp), ...fsRow(n0, sub("0000"), s0), ...fsRow(n1, sub("0011"), s1)].join("\n") + "\n";
    const fs0 = [FS_HEAD, ...fsRow(n0, sub("0000"), s0)].join("\n") + "\n";
    const fs1 = [FS_HEAD, ...fsRow(n1, sub("0011"), s1)].join("\n") + "\n";
    const tcRows = (subLabel) => todays.map((t) => [D, t.tradeId, t.orderId, GD, subLabel, D, "XNYM", t.code, t.month, D, "", "", t.price, t.side, t.qty, "0.00", "USD", "", "Spread", t.time, iso(expiry[t.key]), f2(-COMM * t.qty), "USD", f2(-FEES[t.code] * t.qty), "USD", f2(-NFA * t.qty), "USD"].join(","));
    const csv = (head, rows, eol = "\n") => [head, ...rows].join(eol) + (eol === "\n" ? "\n" : "");
    const subDashed = `${GD}-001-1`;

    const groupFiles = [{ name: `Financial Summary - ${G} - ${D}.csv`, text: fsGroup }];
    const tradingFiles = [{ name: `Financial Summary - 0011 - ${D}.csv`, text: fs1 }];
    if (opRows.length) {
      groupFiles.push({ name: "Open Position.csv", text: csv(OP_HEAD, opRows.map((r) => r.join(",")), "\r\n") });
      tradingFiles.push({ name: "Open Position.csv", text: csv(OP_HEAD, opRows.map((r) => { const x = [...r]; x[4] = subDashed; return x.join(","); }), "\r\n") });
    }
    if (todays.length) {
      groupFiles.push({ name: "Trade Confirmation.csv", text: csv(TC_HEAD, tcRows("0011"), "\r\n") });
      tradingFiles.push({ name: "Trade Confirmation.csv", text: csv(TC_HEAD, tcRows(subDashed), "\r\n") });
    }
    if (offsets.length) {
      groupFiles.push({ name: "Offset Record.csv", text: csv(OR_HEAD, offsets.map((r) => r.join(","))) });
      tradingFiles.push({ name: "Offset Record.csv", text: csv(OR_HEAD, offsets.map((r) => { const x = [...r]; x[2] = subDashed; return x.join(","); })) });
    }
    statements.push(
      { checksum: `demo-${D}-group`, zip_name: `Client Group Daily Statement - ${D}.zip`, statement_date: iso(day), account: G, files: groupFiles },
      { checksum: `demo-${D}-0000`, zip_name: `Client Daily Statement - 0000 - ${D}.zip`, statement_date: iso(day), account: "0000", files: [{ name: `Financial Summary - 0000 - ${D}.csv`, text: fs0 }] },
      { checksum: `demo-${D}-0011`, zip_name: `Client Daily Statement - 0011 - ${D}.zip`, statement_date: iso(day), account: "0011", files: tradingFiles },
    );
  });

  const settings = {
    limits: { minRatio: 200, maxRiskPct: 2, dailyLossPct: 5, maxTrades: 10, includeRealized: true },
    brokers: [{
      id: "orient", name: "Orient", method: "fixed", leverage: 100, capital: 200000, callRatio: 100, stopRatio: 50, currency: "USD", match: "fifo",
      products: Object.fromEntries(Object.entries(KIND).map(([p, kind]) => [p, { size: 1000, margin: IM[kind] }])),
    }],
    marks: {}, view: "all",
    scenario: { target: "min", defV: 5, defUnit: "%", moves: {}, openOnly: true },
    spreads: [], prefs: { hideFigures: false }, cash: [], statement: {}, history: [],
  };
  return { statements: statements.reverse(), fills, settings, products: P, asOf: iso(days[days.length - 1]) };
}
