import { defaultSize } from "./contracts.js";
// Turns fills (across all broker accounts) into open positions, closed positions and realized P&L.
//
// Matching, per broker account:
//   "fifo"    – closing fills square off the OLDEST open lots first (futures brokers, e.g. Orient).
//   "lifo"    – closing fills square off the NEWEST open lots first.
//   "average" – closing fills book P&L against the average entry price (MT5 netting accounts).
//
// FIFO and LIFO differ only in WHICH open lot a closing fill is paired with. That moves money
// between realized and unrealized, and between one closed trade and another, but it can never
// move the two added together: the same fills are bought and sold at the same prices either
// way. Net equity is therefore identical under both — see scripts/matching-check.mjs, which
// proves it over random books rather than asserting it here.
//   Position tickets – if a closing fill names an open position ticket (MT5 hedging), it closes that
//   ticket at that ticket's price, whatever the method; each closed ticket is its own closed position.
// Going through zero closes the position; any remainder opens a new one at the fill price.
// Fees (commission, swap…) are signed P&L amounts on each fill (negative = cost), included in realized P&L.

const EPS = 1e-9;
const r9 = (x) => (Math.abs(x) < EPS ? 0 : x);

// Commission per lot, per side. Brokers like Orient bill it separately, so their fills carry no fee
// at all; MT5 puts the real figure on each deal. The rate is therefore only applied to fills that
// have no fee of their own, so a commission the broker already reported is never charged twice.
// A spread billed per leg costs twice the leg rate: set that on the product.
const cn = (v) => (v === "" || v === null || v === undefined || isNaN(+v) ? 0 : +v);
const cset = (v) => v !== "" && v !== null && v !== undefined && !isNaN(+v);

export const commissionOf = (broker, product) => {
  const over = broker?.products?.[product]?.comm;
  return cset(over) ? cn(over) : cn(broker?.commission);
};

export const withCommission = (fills, byId) =>
  fills.map((f) => {
    if (+f.fee) return f;
    const rate = commissionOf(byId[f.broker], f.product);
    return rate ? { ...f, fee: -Math.abs(rate) * cn(f.qty) } : f;
  });

// sizeOf: (broker, product) => contract size | methodOf: (broker) => "fifo" | "average"
export function computeBook(fills, sizeOf = {}, methodOf = () => "average") {
  const sizeFn = typeof sizeOf === "function" ? sizeOf : (_b, p) => +sizeOf[p]?.size || defaultSize(p);
  // Legs of a spread trade are kept for reference only — the spread is the trade, so counting
  // its legs too would book the same risk twice.
  const sorted = [...fills].filter((f) => !f.is_leg).sort(
    (a, b) => new Date(a.ts) - new Date(b.ts) || String(a.created_at || "").localeCompare(String(b.created_at || ""))
  );
  const state = {};
  const closed = [];
  const realized = [];

  // openOrders / closeOrders are the broker order ids behind a trade, so the legs of a
  // spread can be looked up again once it is closed.
  const newLot = (f, q, price, fee) => ({ id: f.position || null, q, price, q0: Math.abs(q), ts: f.ts, exitQty: 0, exitVal: 0, pnl: fee, fees: fee, fills: 1, openOrders: f.order_id ? [f.order_id] : [], closeOrders: [] });
  const note = (arr, id) => { if (id && !arr.includes(id)) arr.push(id); };
  const lotsAvg = (lots, fallback) => {
    const tq = lots.reduce((a, l) => a + Math.abs(l.q), 0);
    return tq ? lots.reduce((a, l) => a + Math.abs(l.q) * l.price, 0) / tq : fallback;
  };
  const startCycle = (st, f, price, q, fee) => {
    st.pos = q; st.avg = price; st.lots = [newLot(f, q, price, fee)];
    st.cycle = {
      broker: st.broker, product: f.product, side: q > 0 ? "Long" : "Short", openTs: f.ts,
      entryQty: Math.abs(q), entryVal: Math.abs(q) * price,
      exitQty: 0, exitVal: 0, pnl: fee, fees: fee, fills: 1, maxQty: Math.abs(q), ticketed: false,
      openOrders: f.order_id ? [f.order_id] : [], closeOrders: [],
    };
  };
  const closeCycle = (st, ts) => {
    const c = st.cycle;
    if (!c.ticketed) closed.push({ ...c, closeTs: ts, qty: c.entryQty, avgEntry: c.entryVal / c.entryQty, avgExit: c.exitVal / c.exitQty });
    st.cycle = null; st.lots = [];
  };

  for (const f of sorted) {
    const broker = f.broker || "default";
    const size = +sizeFn(broker, f.product) || defaultSize(f.product);
    const method = methodOf(broker);
    // FIFO and LIFO both match lot by lot and differ only in which end of the queue they take
    // from; "average" keeps no lot identity at all and books against the running average.
    const lotted = method === "fifo" || method === "lifo";
    const newestFirst = method === "lifo";
    const price = +f.price;
    const q = f.side === "Buy" ? +f.qty : -f.qty;
    const fee = +f.fee || 0;
    const st = (state[`${broker}|${f.product}`] ||= { broker, product: f.product, pos: 0, avg: 0, cycle: null, lots: [] });
    if (fee) realized.push({ ts: f.ts, broker, product: f.product, pnl: fee, fee: true });

    if (st.pos === 0) { startCycle(st, f, price, q, fee); continue; }

    const c = st.cycle;
    c.fills++; c.pnl += fee; c.fees += fee;

    // 1) Closing a named position ticket (MT5 hedging)
    const lot = f.position ? st.lots.find((l) => l.id === f.position && Math.sign(l.q) !== Math.sign(q)) : null;
    if (lot) {
      const closeQty = Math.min(Math.abs(q), Math.abs(lot.q));
      const d = Math.sign(lot.q);
      const pnl = d * (price - lot.price) * closeQty * size;
      realized.push({ ts: f.ts, broker, product: f.product, pnl });
      c.pnl += pnl; c.exitQty += closeQty; c.exitVal += closeQty * price; note(c.closeOrders, f.order_id); c.ticketed = true;
      lot.pnl += pnl + fee; lot.fees += fee; lot.exitQty += closeQty; lot.exitVal += closeQty * price; lot.fills++;
      note(lot.closeOrders, f.order_id); note(c.closeOrders, f.order_id);
      lot.q = r9(lot.q - d * closeQty);
      if (lot.q === 0) {
        closed.push({ broker, product: f.product, side: d > 0 ? "Long" : "Short", openTs: lot.ts, closeTs: f.ts, qty: lot.q0, maxQty: lot.q0,
          avgEntry: lot.price, avgExit: lot.exitVal / lot.exitQty, pnl: lot.pnl, fees: lot.fees, fills: lot.fills, ticket: lot.id,
          openOrders: lot.openOrders, closeOrders: lot.closeOrders });
      }
      st.lots = st.lots.filter((l) => l.q !== 0);
      st.pos = r9(st.pos - d * closeQty);
      st.avg = lotsAvg(st.lots, st.avg);
      if (st.pos === 0) closeCycle(st, f.ts);
      continue;
    }

    // 2) Adding to the position
    if (Math.sign(q) === Math.sign(st.pos)) {
      /*
       * The commission on THIS fill belongs to the lot it opens.
       *
       * It used to be passed as 0, so a fill that added to a position paid a commission that
       * reached the realized ledger and the cycle but never any closed trade — and every
       * figure worked out from `closed` was short by exactly that fee. On a scale-in of two
       * lots at $5 a side it read $385 where the money was $380, and the Closed page
       * disagreed with the top bar about the same day. The realized ledger was right
       * throughout; it is the per-trade attribution that dropped it.
       *
       * Nothing is double counted: the ledger entry above is per fill and independent of
       * lots, and on this path the cycle is never itself pushed as a closed trade.
       */
      st.lots.push(newLot(f, q, price, fee));
      note(c.openOrders, f.order_id);
      st.pos = r9(st.pos + q);
      st.avg = lotted || f.position ? lotsAvg(st.lots, price) : (Math.abs(st.pos - q) * st.avg + Math.abs(q) * price) / Math.abs(st.pos);
      c.entryQty += Math.abs(q); c.entryVal += Math.abs(q) * price;
      c.maxQty = Math.max(c.maxQty, Math.abs(st.pos));
      continue;
    }

    // 3) Reducing / closing / flipping
    const closeQty = Math.min(Math.abs(q), Math.abs(st.pos));
    const d = Math.sign(st.pos);
    let pnl = 0, left = closeQty;
    let feeLeft = fee;
    // st.lots is held oldest-first. FIFO walks it as it stands; LIFO walks a reversed copy,
    // which is the same lot objects in the other order, so the mutations below still land on
    // the real lots.
    for (const l of (newestFirst ? [...st.lots].reverse() : st.lots)) {
      if (left <= EPS) break;
      const take = Math.min(left, Math.abs(l.q));
      if (lotted) {
        const lp = d * (price - l.price) * take * size;
        pnl += lp;
        l.pnl += lp + feeLeft; l.fees += feeLeft; feeLeft = 0; l.exitQty += take; l.exitVal += take * price; l.fills++;
        note(l.closeOrders, f.order_id);
      }
      l.q = r9(l.q - d * take); left = r9(left - take);
      if (lotted && l.q === 0) {
        // Lot matched: each squared-off lot is its own closed trade (entry lot vs the fills that closed it)
        closed.push({ broker, product: f.product, side: d > 0 ? "Long" : "Short", openTs: l.ts, closeTs: f.ts, qty: l.q0, maxQty: l.q0,
          avgEntry: l.price, avgExit: l.exitVal / l.exitQty, pnl: l.pnl, fees: l.fees, fills: l.fills, matched: method,
          openOrders: l.openOrders, closeOrders: l.closeOrders });
      }
    }
    if (lotted) c.ticketed = true; // closed trades already recorded per lot
    if (!lotted) pnl = d * (price - st.avg) * closeQty * size;
    st.lots = st.lots.filter((l) => l.q !== 0);
    realized.push({ ts: f.ts, broker, product: f.product, pnl });
    c.pnl += pnl; c.exitQty += closeQty; c.exitVal += closeQty * price;
    st.pos = r9(st.pos - d * closeQty);
    if (lotted) st.avg = lotsAvg(st.lots, st.avg);
    if (st.pos === 0) {
      closeCycle(st, f.ts);
      const remaining = r9(Math.abs(q) - closeQty);
      if (remaining > 0) startCycle(st, f, price, Math.sign(q) * remaining, 0);
    }
  }

  const open = Object.values(state)
    .filter((st) => st.pos !== 0)
    .map((st) => ({
      broker: st.broker, product: st.product, side: st.pos > 0 ? "Long" : "Short", lots: Math.abs(st.pos), avg: st.avg,
      openTs: st.cycle.openTs, fills: st.cycle.fills, realizedSoFar: st.cycle.pnl, fees: st.cycle.fees,
      lotsOpen: st.lots.map((l) => ({ q: l.q, price: l.price, ts: l.ts, id: l.id })),
    }))
    .sort((a, b) => a.broker.localeCompare(b.broker) || a.product.localeCompare(b.product));

  closed.sort((a, b) => new Date(b.closeTs) - new Date(a.closeTs));
  return { open, closed, realized };
}
