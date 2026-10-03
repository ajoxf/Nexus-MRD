import { positionsOf } from "./orient.js";

/*
 * Orient's open positions, regrouped as the spreads they are.
 *
 * First by Orient's own record: the legs of one spread trade share an ExchangeOrderID
 * (spreadsFromLots, below), which gives each spread its exact traded price. Legs that cannot be
 * paired that way fall back to the fixed rules here.
 *
 * Orient's statement lists legs only: BZ Nov26 −3, CL Nov26 +3, CL Oct26 +4, HO Oct26 −4. The
 * trader holds 3 CL–BZ Inter-Product and −4 HO–CL Cracks. This pairs the legs back up by fixed
 * rules, tried in order, and shows each spread at the price it trades at:
 *
 *   1. CL–BZ Inter-Product   CL with BZ of the same month          CL − BZ
 *   2. HO–CL Crack           HO with CL of the same month          HO × 42 − CL   ($/bbl)
 *   3. Calendar              one product, two months               near − far
 *
 * All 1:1 in lots. A spread is long when its first leg is long. Whatever no rule pairs is shown
 * as an outright. The rules read the statement alone, so they never depend on the fills being
 * complete — and they can split a leg two ways (CL +7 against BZ −6 and HO −1 is 6 Inter-Product
 * and 1 Crack), in which case both spreads are priced off that leg's one average.
 *
 * P/L is Orient's own per leg, shared out by lots; it is not recalculated, so the spreads add
 * back up to the statement exactly.
 *
 * Reading only. Nothing here touches the book.
 */

const RULES = [
  {
    kind: "Inter-Product",
    pair: (a, b) => a.code === "CL" && b.code === "BZ" && a.month === b.month,
    value: (a, b) => a - b,
    label: (a) => `CL–BZ ${a.label.split(" ")[1]} Inter-Product`,
  },
  {
    kind: "Crack",
    pair: (a, b) => a.code === "HO" && b.code === "CL" && a.month === b.month,
    value: (a, b) => a * 42 - b,
    label: (a) => `HO–CL ${a.label.split(" ")[1]} Crack`,
  },
  {
    kind: "Calendar",
    pair: (a, b) => a.code === b.code && String(a.month) < String(b.month),
    value: (a, b) => a - b,
    label: (a, b) => `${a.code} ${a.label.split(" ")[1]}–${b.label.split(" ")[1]} Calendar`,
  },
];

const r6 = (x) => (x === null || !isFinite(x) ? null : +x.toFixed(6));
const r2 = (x) => +x.toFixed(2);

/*
 * positions: positionsOf(lots). Returns { spreads, outrights }, per account:
 *   spreads:   { account, kind, label, lots, entry, settle, upl, legs: [{ label, lots }] }
 *   outrights: { account, label, lots, avg, settle, upl }
 */
export function spreadsOf(positions) {
  // Futures only; options and anything odd stay as they are.
  const legs = positions.filter((p) => p.kind === "F" && p.lots).map((p) => ({ ...p, left: p.lots }));
  const share = (p, n) => (p.upl * Math.abs(n)) / Math.abs(p.lots);
  const spreads = [];

  for (const rule of RULES) {
    // Near months first, so a calendar pairs neighbours before it reaches further out.
    const ordered = [...legs].sort((x, y) => String(x.month).localeCompare(String(y.month)));
    for (const a of ordered) {
      for (const b of ordered) {
        if (a === b || a.account !== b.account || !rule.pair(a, b)) continue;
        if (!a.left || !b.left || Math.sign(a.left) === Math.sign(b.left)) continue;
        const n = Math.min(Math.abs(a.left), Math.abs(b.left));
        const lots = Math.sign(a.left) * n;
        spreads.push({
          account: a.account,
          kind: rule.kind,
          label: rule.label(a, b),
          lots,
          entry: r6(rule.value(a.avg, b.avg)),
          settle: a.settle === null || b.settle === null ? null : r6(rule.value(a.settle, b.settle)),
          upl: r2(share(a, n) + share(b, n)),
          legs: [{ label: a.label, lots }, { label: b.label, lots: -lots }],
        });
        a.left -= lots;
        b.left += lots;
      }
    }
  }
  const outrights = legs.filter((p) => p.left).map((p) => ({ account: p.account, label: p.label, lots: p.left, avg: p.avg, settle: p.settle, upl: r2(share(p, p.left)) }));
  return { spreads, outrights };
}

/*
 * Pair by ExchangeOrderID first, then by rule.
 *
 * lots: readOpenPositions(...).lots. Lots sharing an exchange order id, in one account, two
 * contracts, equal and opposite, and a pair one of the rules recognises, are one spread trade,
 * priced from those two lots' own prices — not from the leg's average across every trade. Same
 * spread from several orders is gathered into one line at the lot-weighted price. Everything
 * else (no id, an id Excel has rounded to 8.07E+12, an odd shape) is paired by rule and marked
 * by: "rule", so the screen can say which is which.
 */
const ORDER_ID = /^\d{6,}$/;
export function spreadsFromLots(lots) {
  const groups = new Map();
  const loose = [];
  for (const l of lots) {
    if (l.kind !== "F" || !ORDER_ID.test(l.orderId || "")) { loose.push(l); continue; }
    const k = `${l.account}|${l.orderId}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(l);
  }
  const byOrder = new Map();
  for (const g of groups.values()) {
    const legs = positionsOf(g);
    const pick = () => {
      if (legs.length !== 2 || !legs[0].lots || Math.abs(legs[0].lots) !== Math.abs(legs[1].lots) || Math.sign(legs[0].lots) === Math.sign(legs[1].lots)) return null;
      for (const rule of RULES) for (const [a, b] of [[legs[0], legs[1]], [legs[1], legs[0]]]) if (rule.pair(a, b)) return { rule, a, b };
      return null;
    };
    const m = pick();
    if (!m) { loose.push(...g); continue; }
    const { rule, a, b } = m;
    const label = rule.label(a, b);
    const key = `${a.account}|${label}|${Math.sign(a.lots)}`; // long and short kept apart: netting them would hide both
    const sp = byOrder.get(key) || { account: a.account, kind: rule.kind, label, lots: 0, cost: 0, settles: new Set(), upl: 0, by: "order", legs: [{ label: a.label, lots: 0 }, { label: b.label, lots: 0 }] };
    const n = Math.abs(a.lots);
    sp.lots += a.lots;
    sp.cost += rule.value(a.avg, b.avg) * n;
    sp.settles.add(a.settle === null || b.settle === null ? null : r6(rule.value(a.settle, b.settle)));
    sp.upl += a.upl + b.upl;
    sp.legs[0].lots += a.lots;
    sp.legs[1].lots += b.lots;
    byOrder.set(key, sp);
  }
  const ordered = [...byOrder.values()].map(({ cost, settles, ...sp }) => ({
    ...sp,
    entry: r6(cost / Math.abs(sp.lots)),
    settle: settles.size === 1 ? [...settles][0] : null,
    upl: r2(sp.upl),
  }));
  const rest = spreadsOf(positionsOf(loose));
  return { spreads: [...ordered, ...rest.spreads.map((sp) => ({ ...sp, by: "rule" }))], outrights: rest.outrights };
}
