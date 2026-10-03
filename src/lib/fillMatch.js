import { isSpreadSymbol } from "./csv.js";

/*
 * RAMP's fills (imported from TT) against Orient's Trade Confirmations — every lot, both ways.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS COMPARED
 * ---------------------------------------------------------------------------
 * Legs. Orient confirms only legs; TT exports a spread as the spread plus its legs, and RAMP keeps
 * the legs (is_leg). So the spread rows are left out and every leg and outright is compared, one
 * lot at a time, on: sub-account, contract, buy/sell and price.
 *
 * ---------------------------------------------------------------------------
 * TIME
 * ---------------------------------------------------------------------------
 * TT's clock and Orient's are in different time zones, and neither file says which. So a lot is
 * looked for within a day either side, and the gap between the two clocks is read from the data:
 * lots with only one possible partner are matched first, the hours between their two times are
 * counted, and the commonest is the offset — which then decides between candidates for the rest.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS REPORTED
 * ---------------------------------------------------------------------------
 * Only where both sides have data: an Orient lot is "missing from RAMP" only on a day RAMP has TT
 * fills for that account; a RAMP lot is "not at Orient" only on a day an Orient statement for
 * that account is open. A RAMP lot not at Orient is the double-count case — the same fill stored
 * twice — or a fill on the wrong account.
 *
 * Reading only. Nothing here changes the book.
 */

// "CL Oct26" → { code: "CL", month: "202610" }
const MON = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };
export function contractOf(product) {
  const m = /^([A-Z0-9]{1,4})\s+([A-Za-z]{3})(\d{2})$/.exec(String(product || "").trim());
  return m && MON[m[2].toLowerCase()] ? { code: m[1], month: `20${m[3]}${MON[m[2].toLowerCase()]}` } : null;
}
// "1003050011-GHF" (TT) or "1-00305-001-1" → "1003050011"
export const accountOf = (s) => { const m = /^[\d-]+/.exec(String(s || "").trim()); return m ? m[0].replace(/-/g, "") : null; };

const pad = (n) => String(n).padStart(2, "0");
// A fill's wall-clock reading, as the TT export printed it (the importer read it in this zone).
const wall = (ts) => { const d = new Date(ts); return { date: `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`, min: d.getHours() * 60 + d.getMinutes() }; };
// Orient's "8/19/2026 18:15" → minutes, or null
const orientMin = (t) => { const m = /(\d{1,2}):(\d{2})/.exec(t || ""); return m ? +m[1] * 60 + +m[2] : null; };
const dayNo = (yyyymmdd) => Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8)) / 864e5;
const px = (v) => (+v).toFixed(6);

/*
 * fills: RAMP's fills. trades: uniqueTrades(...) from the Trade Confirmations. statementDays:
 * { account: Set(YYYYMMDD) } — days an Orient statement is open per account (so a day with no
 * trades still counts as covered).
 */
export function matchFills(fills, trades, statementDays = {}) {
  // One entry per lot, both sides.
  const ramp = [];
  for (const f of fills) {
    if (isSpreadSymbol(f.product)) continue;
    const c = contractOf(f.product), account = accountOf(f.account);
    if (!c || !account) continue;
    const w = wall(f.ts);
    for (let i = 0; i < Math.round(+f.qty); i++) ramp.push({ account, ...c, side: f.side === "Buy" ? "B" : "S", price: px(f.price), date: w.date, min: w.min, fill: f, used: false });
  }
  const orient = [];
  for (const t of trades) {
    if (t.kind !== "F") continue;
    for (let i = 0; i < Math.round(t.qty); i++) orient.push({ account: t.account, code: t.code, month: t.month, side: t.side, price: px(t.price), date: t.date, min: orientMin(t.time), trade: t, match: null });
  }
  const key = (x) => `${x.account}|${x.code}|${x.month}|${x.side}|${x.price}`;
  const pool = new Map();
  for (const r of ramp) { if (!pool.has(key(r))) pool.set(key(r), []); pool.get(key(r)).push(r); }
  const near = (o) => (pool.get(key(o)) || []).filter((r) => !r.used && Math.abs(dayNo(r.date) - dayNo(o.date)) <= 1);
  // Minutes from RAMP's clock to Orient's for a pair (Orient − RAMP).
  const gap = (o, r) => (o.min === null ? null : (dayNo(o.date) - dayNo(r.date)) * 1440 + o.min - r.min);

  // 1. Pairs with only one candidate on each side fix the offset between the two clocks.
  const hours = new Map();
  for (const o of orient) {
    const c = near(o);
    if (c.length === 1 && orient.filter((x) => key(x) === key(o) && Math.abs(dayNo(x.date) - dayNo(o.date)) <= 1).length === 1) {
      const g = gap(o, c[0]);
      if (g !== null) { const h = Math.round(g / 60); hours.set(h, (hours.get(h) || 0) + 1); }
    }
  }
  const offsetHours = hours.size ? [...hours.entries()].sort((a, b) => b[1] - a[1])[0][0] : null;

  // 2. Every lot: the candidate whose time, moved by the offset, is closest.
  const ordered = [...orient].sort((a, b) => a.date.localeCompare(b.date) || (a.min ?? 0) - (b.min ?? 0));
  for (const o of ordered) {
    const c = near(o);
    if (!c.length) continue;
    const score = (r) => { const g = gap(o, r); return g === null || offsetHours === null ? Math.abs(dayNo(r.date) - dayNo(o.date)) * 1440 : Math.abs(g - offsetHours * 60); };
    const best = c.sort((a, b) => score(a) - score(b))[0];
    best.used = true;
    o.match = best;
  }

  // 3. What didn't match, only where the other side has data.
  // RAMP covers the span of days its fills for that account run over; nothing either side of it.
  const span = new Map();
  for (const r of ramp) { const s = span.get(r.account) || { from: r.date, to: r.date }; if (r.date < s.from) s.from = r.date; if (r.date > s.to) s.to = r.date; span.set(r.account, s); }
  const rampCovers = (acct, date) => { const s = span.get(acct); return !!s && date >= s.from && date <= s.to; };
  /*
   * Orient covers a RAMP lot's day only if the statement for the Orient trade date it would fall
   * on is open: exact once the clock offset is known; without it, the day itself and the weekdays
   * either side must all be open.
   */
  const orientCovers = (r) => {
    const days = statementDays[r.account];
    if (!days) return false;
    if (offsetHours !== null) {
      const at = r.min + offsetHours * 60;
      return days.has(dateAt(r.date, Math.floor(at / 1440)));
    }
    return [-1, 0, 1].map((d) => dateAt(r.date, d)).filter((d) => d === r.date || ![0, 6].includes(new Date(`${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}T12:00:00Z`).getUTCDay())).every((d) => days.has(d));
  };
  const missing = orient.filter((o) => !o.match && rampCovers(o.account, o.date));
  const extra = ramp.filter((r) => !r.used && orientCovers(r));

  // Per Orient trade date.
  const days = new Map();
  const day = (acct, date) => { const k = `${acct}|${date}`; if (!days.has(k)) days.set(k, { account: acct, date, orient: 0, matched: 0, missing: 0, extra: 0 }); return days.get(k); };
  for (const o of orient) if (rampCovers(o.account, o.date)) { const d = day(o.account, o.date); d.orient++; if (o.match) d.matched++; else d.missing++; }
  for (const r of extra) day(r.account, offsetHours === null ? r.date : dateAt(r.date, Math.floor((r.min + offsetHours * 60) / 1440))).extra++;
  return {
    offsetHours,
    matched: orient.filter((o) => o.match).length,
    missing: missing.map((o) => ({ account: o.account, date: o.date, time: o.trade.time, contract: `${o.code} ${o.month}`, side: o.side, price: +o.price, tradeId: o.trade.tradeId })),
    extra: extra.map((r) => ({ account: r.account, date: r.date, ts: r.fill.ts, contract: `${r.code} ${r.month}`, side: r.side, price: +r.price, product: r.fill.product, ref: r.fill.ref })),
    days: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}

const dateAt = (yyyymmdd, delta) => {
  const d = new Date(Date.UTC(+yyyymmdd.slice(0, 4), +yyyymmdd.slice(4, 6) - 1, +yyyymmdd.slice(6, 8) + delta));
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
};
