/*
 * Flattening an open position.
 *
 * A book carries positions that are no longer risk: an expiry that was rolled to the next month,
 * a spread legged in two halves where one half was squared off elsewhere, a line left behind by a
 * broker statement that stops mid-story. They are not wrong — they really were opened, and the
 * fills that opened them are real — so deleting the fills would rewrite history to tidy a screen.
 *
 * Flattening writes the missing other side instead: one ordinary fill, opposite side, same size,
 * at a price the trader names. The position closes the way every other position closes, the round
 * trip lands in Closed trades with its P&L, and the fill sits in Fills where it can be deleted
 * again if it was a mistake. Nothing is hidden and nothing is invented.
 *
 * The price is the whole decision, so it is never guessed:
 *   "entry" closes at the position's own average, which books exactly nothing. This is the
 *           honest choice for a rollover or a bookkeeping leftover: the money was made or lost
 *           on the trade that replaced it, not here.
 *   "mark"  closes at the current price, which turns today's open P&L into realized P&L.
 *   a number closes where the trader says it closed.
 */

// One fill per open lot when the lots carry broker position tickets (a hedging account matches a
// close against its own ticket, so a single undifferentiated fill would close the wrong lots);
// otherwise one fill for the whole position, which is what FIFO and averaging accounts expect.
export function flattenPlan(rows, { at = "entry", price = null, when = new Date() } = {}) {
  const ts = (when instanceof Date ? when : new Date(when)).toISOString();
  return rows.map((r) => {
    // An empty box is not a price. +"" is 0 in JavaScript, and a silent flatten at zero on a
    // spread whose entry is -7.61 would book $7,610 a lot out of nowhere.
    const stated = price === "" || price === null || price === undefined ? NaN : +price;
    const exit = at === "mark" ? +r.mark : at === "price" ? stated : +r.avg;
    if (!isFinite(exit)) return null;
    const dir = r.side === "Long" ? 1 : -1;
    const size = +r.size || 1;
    const lots = +r.lots;
    const opposite = r.side === "Long" ? "Sell" : "Buy";
    const ticketed = (r.lotsOpen || []).filter((l) => l.id);
    const parts = ticketed.length === (r.lotsOpen || []).length && ticketed.length
      ? ticketed.map((l) => ({ qty: Math.abs(l.q), position: l.id }))
      : [{ qty: lots, position: null }];
    return {
      key: r.key, broker: r.broker, product: r.product, side: r.side, lots, size,
      exit, pnl: dir * (exit - r.avg) * size * lots,
      fills: parts.map((p, i) => ({
        ts, broker: r.broker, product: r.product, side: opposite, qty: p.qty, price: exit, fee: 0,
        // Distinct per position and per instant, so flattening twice by accident is two fills a
        // trader can see and delete — not one silently swallowed as a duplicate of the other.
        ref: `flat:${r.product}|${opposite}|${exit}|${ts}|${i}`,
        account: null, position: p.position, source: "flatten", order_id: null, is_leg: false,
      })),
    };
  }).filter(Boolean);
}

export const planFills = (plan) => plan.flatMap((p) => p.fills);
export const planPnl = (plan) => plan.reduce((a, p) => a + p.pnl, 0);
