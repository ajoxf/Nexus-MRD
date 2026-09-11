// Scenario analysis for one broker account.
// Every position is moved AGAINST its direction by that product's scenario move (% of price or price points).
// Margin: fixed-per-lot brokers keep the same margin; leverage brokers (MT5) recalculate margin at the stressed price.

const num = (v) => (v === "" || v === null || v === undefined || isNaN(+v) ? 0 : +v);

// Price distance of the move for one lot at price m
export const moveDist = (m, mv) => (mv.unit === "%" ? Math.abs(m) * num(mv.v) / 100 : num(mv.v));

// Margin per lot at a given price
export const imPerLot = (broker, spec, price) =>
  broker.method === "leverage"
    ? (Math.abs(price) * (num(spec.size) || 1000)) / (num(spec.lev) || num(broker.leverage) || 1)
    : num(spec.margin);

/**
 * products: [{ product, spec, pos (signed lots, + long), mark (current price or null), move: {v, unit} }]
 * acc: { TNE, callR, stopR }
 * target: ratio to stay above (e.g. 2 for 200%)
 */
export function runScenario(broker, acc, products, target, scale = 1) {
  const lines = products.map((p) => {
    const size = num(p.spec.size) || 1000;
    const mv = { ...p.move, v: num(p.move.v) * scale };
    const hasPrice = p.mark !== null && isFinite(p.mark);
    const needsPrice = mv.unit === "%" || broker.method === "leverage";
    const dist = hasPrice || mv.unit === "pts" ? moveDist(hasPrice ? p.mark : 0, mv) : NaN;
    const dir = Math.sign(p.pos);
    const stressed = hasPrice && dir ? p.mark - dir * dist : null;
    const loss = dir ? Math.abs(p.pos) * size * dist : 0;
    const im = dir ? Math.abs(p.pos) * imPerLot(broker, p.spec, stressed ?? p.mark ?? 0) : 0;
    return { ...p, size, mv, dist, stressed, loss, im, hasPrice, needsPrice };
  });
  const loss = lines.reduce((a, l) => a + (isFinite(l.loss) ? l.loss : 0), 0);
  const IM = lines.reduce((a, l) => a + l.im, 0);
  const TNE = acc.TNE - loss;
  const ratio = IM > 0 ? TNE / IM : Infinity;

  // Capacity: the account ratio after trading this product depends only on the new net size |p'|,
  // because trading at the current price doesn't change equity. Solve for the largest |p'| that keeps
  //   (TNE_now − loss_others − |p'|·L1) / (IM_others + |p'|·I1) ≥ target
  const withCap = lines.map((l) => {
    if (l.needsPrice && !l.hasPrice) return { ...l, canBuy: null, canSell: null, reason: "price" };
    const others = lines.filter((x) => x !== l);
    const lossO = others.reduce((a, x) => a + (isFinite(x.loss) ? x.loss : 0), 0);
    const imO = others.reduce((a, x) => a + x.im, 0);
    const head = acc.TNE - lossO - target * imO;
    const L1 = l.size * l.dist;
    const side = (d) => {
      const sp = l.hasPrice ? l.mark - d * l.dist : 0;
      const I1 = imPerLot(broker, l.spec, sp);
      const denom = L1 + target * I1;
      if (denom <= 0) return Infinity;
      return head / denom; // may be negative: account fails the scenario even without this product
    };
    const maxLong = side(1), maxShort = side(-1);
    const floor2 = (x) => (isFinite(x) ? Math.floor(x * 100) / 100 : x);
    const canBuy = floor2(maxLong - l.pos);   // from a short, buying first reduces it
    const canSell = floor2(maxShort + l.pos); // from a long, selling first reduces it
    // If the current position itself is too big: lots to cut
    const maxHere = l.pos > 0 ? maxLong : l.pos < 0 ? maxShort : Infinity;
    const cut = Math.abs(l.pos) > maxHere ? Math.ceil((Math.abs(l.pos) - Math.max(0, maxHere)) * 100) / 100 : 0;
    return { ...l, canBuy, canSell, cut, maxLong, maxShort };
  });

  return { lines: withCap, loss, IM, TNE, ratio };
}

// Smallest uniform % move against every open position that pushes the account to `level` (e.g. callR).
export function breakingMove(broker, acc, products, level) {
  const open = products.filter((p) => p.pos && p.mark !== null && isFinite(p.mark));
  if (!open.length) return null;
  const at = (u) => runScenario(broker, acc, open.map((p) => ({ ...p, move: { v: u, unit: "%" } })), level).ratio;
  if (at(0) <= level) return 0;
  let lo = 0, hi = 100;
  if (at(hi) > level) return Infinity; // even a 100% move doesn't get there
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (at(mid) > level) lo = mid; else hi = mid; }
  return hi;
}
