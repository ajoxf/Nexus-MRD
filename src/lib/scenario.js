// Scenario analysis for one broker account.
// Every position is moved AGAINST its direction by that product's scenario move (% of price or price points).
// Margin: fixed-per-lot brokers keep the same margin; leverage brokers (MT5) recalculate margin at the stressed price.

const num = (v) => (v === "" || v === null || v === undefined || isNaN(+v) ? 0 : +v);
/** Lot arithmetic, kept off the floating-point cliff. */
const round9 = (x) => (Math.abs(x) < 1e-9 ? 0 : +(+x).toFixed(9));

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
    // A held position sets the direction. Flat, the trader can name the side they are
    // considering (p.plan) and how many lots (p.planLots); with neither, both directions
    // are reported. A plan with lots on it is stressed as though it were already on, so
    // the row and the account answer "what would this trade look like".
    const planSign = p.plan === "long" ? 1 : p.plan === "short" ? -1 : 0;

    /*
     * Lots being considered, ON TOP of whatever is already held.
     *
     * This used to apply only to a flat product, which answered "what could I put on?" but
     * never "what does adding two more do to me?" — and the second is the question somebody
     * actually has, because they ask it while already in the trade. The account tile said how
     * many lots COULD be added; it would not price the ones you meant.
     *
     * Added lots are stressed as though they were already on, entered at the current mark. So
     * they cost margin and they lose in the scenario, but they book no instant profit — buying
     * at the price you are marked at does not make you money.
     */
    const planLots = planSign && num(p.planLots) > 0 ? num(p.planLots) : 0;
    const adding = planSign * planLots;
    // Rounded, or 0.13 + 0.01 lots arrives as 0.14000000000000001 and prints like it.
    const effPos = round9(p.pos + adding);
    const planned = adding !== 0;

    /*
     * Direction comes from the COMBINED position, not the held one. Selling two against a long
     * one leaves you short one, and the move that hurts is then the other way — stressing it as
     * a long would report a profit where there is a loss.
     */
    const dir = Math.sign(effPos) || planSign;
    const stressed = hasPrice && dir ? p.mark - dir * dist : null;
    const both = hasPrice && isFinite(dist) && !dir;
    const stressedIfLong = both ? p.mark - dist : null;
    const stressedIfShort = both ? p.mark + dist : null;
    const loss = effPos ? Math.abs(effPos) * size * dist : 0;
    const im = effPos ? Math.abs(effPos) * imPerLot(broker, p.spec, stressed ?? p.mark ?? 0) : 0;
    // `adding` is carried so the screen can say "adding 2 -> Long 3" rather than just "Long 3",
    // which on its own reads like a position the trader already has.
    return { ...p, size, mv, dist, stressed, stressedIfLong, stressedIfShort, dir, effPos, adding, planned, loss, im, hasPrice, needsPrice };
  });
  const loss = lines.reduce((a, l) => a + (isFinite(l.loss) ? l.loss : 0), 0);
  const IM = lines.reduce((a, l) => a + l.im, 0);
  const TNE = acc.TNE - loss;
  const ratio = IM > 0 ? TNE / IM : Infinity;

  // Capacity: the account ratio after trading this product depends only on the new net size |p'|,
  // because trading at the current price doesn't change equity. Solve for the largest |p'| that keeps
  //   (TNE_now − loss_others − |p'|·L1) / (IM_others + |p'|·I1) ≥ target
  // Lots you can actually trade: whole lots on a futures account, hundredths on a leverage account.
  const step = broker.method === "leverage" ? 100 : 1;
  const floorTo = (x) => (isFinite(x) ? Math.floor(x * step) / step : x);

  const withCap = lines.map((l) => {
    if (l.needsPrice && !l.hasPrice) return { ...l, canBuy: null, canSell: null, reason: "price" };
    // With no margin per lot the product costs nothing to hold, so any capacity worked out
    // from it would be nonsense — and far too generous. Say so instead of printing a number.
    if (broker.method !== "leverage" && !num(l.spec.margin)) return { ...l, canBuy: null, canSell: null, reason: "margin" };
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
    const canBuy = floorTo(maxLong - l.effPos);   // from a short, buying first reduces it
    const canSell = floorTo(maxShort + l.effPos); // from a long, selling first reduces it
    // If the position (or the planned one) is too big: lots to cut
    const maxHere = l.effPos > 0 ? maxLong : l.effPos < 0 ? maxShort : Infinity;
    const cut = Math.abs(l.effPos) > maxHere ? Math.ceil((Math.abs(l.effPos) - Math.max(0, maxHere)) * step) / step : 0;
    return { ...l, canBuy, canSell, cut, maxLong, maxShort };
  });

  return { lines: withCap, loss, IM, TNE, ratio };
}

// Smallest uniform % move against every open position that pushes the account to `level` (e.g. callR).
export function breakingMove(broker, acc, products, level) {
  // A planned trade counts: the whole point of sizing one is to see where it would
  // put the margin call and the stop-out.
  const held = (p) => p.pos || ((p.plan === "long" || p.plan === "short") && num(p.planLots) > 0);
  const on = products.filter(held);
  if (!on.length) return null;                    // genuinely nothing on
  // This walks the move in %, which needs a price to move from. A position priced in points
  // still costs money and still takes margin, so saying "no open positions" here would be a lie.
  const open = on.filter((p) => p.mark !== null && isFinite(p.mark));
  if (!open.length) return NaN;                   // something is on, but there is no price to stress
  const at = (u) => runScenario(broker, acc, open.map((p) => ({ ...p, move: { v: u, unit: "%" } })), level).ratio;
  if (at(0) <= level) return 0;
  let lo = 0, hi = 100;
  if (at(hi) > level) return Infinity; // even a 100% move doesn't get there
  for (let i = 0; i < 50; i++) { const mid = (lo + hi) / 2; if (at(mid) > level) lo = mid; else hi = mid; }
  return hi;
}
