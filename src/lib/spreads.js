/*
 * Spreads: one trade held as two or more legs, often in two different accounts.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * A trader long 0.12 WTI in one MT5 account and short 0.12 Brent in another is not
 * carrying two directional oil bets. He is carrying one spread. Stressed as two
 * independent positions — which is what the per-account scenario does, correctly, for
 * margin — a 10% oil move reads as a $2,344 loss. But oil does not move 10% in WTI while
 * Brent sits still: if both move together the spread's P&L is about $101. The platform was
 * overstating the economic risk by more than twenty times, and that number fed the
 * headline ratio, the room-to-call figure and every capacity calculation on the page.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS DOES *NOT* TOUCH
 * ---------------------------------------------------------------------------
 * Margin. Each broker account is margined on its own and can be stopped out on its own —
 * being hedged in account B will not stop account A being liquidated, and no broker will
 * accept "but I was flat across the group" as an argument. So the per-account margin
 * scenario stays exactly as it is. This module answers a different question that sits on
 * top of it: what can this spread actually cost me.
 *
 * ---------------------------------------------------------------------------
 * HOW A SPREAD IS STRESSED
 * ---------------------------------------------------------------------------
 * Two moves, added together, because they are two different things that can happen:
 *
 *   1. A CORRELATED move. Every leg's price moves the same way by the scenario move. On a
 *      matched spread the legs very nearly cancel and what is left is the small residue
 *      from the two legs being at different price levels — the $101 above. On a leg that
 *      is only half hedged, it is the full outright loss on the unhedged part, which is
 *      exactly right: that part IS an outright position.
 *
 *      Both directions are tried and the worse is taken. A trader does not get to choose
 *      which way the market goes.
 *
 *   2. The SPREAD moving against you. WTI and Brent do not move in lockstep, and the whole
 *      trade is a bet on the difference. So the differential gets its own move, in dollars
 *      or as a percentage of where the spread is now, and it costs the spread's size.
 *
 * Only the MATCHED part of the spread is exposed to (2). If the legs do not line up — long
 * 0.12 against short 0.06 — then 0.06 is a spread and 0.06 is a naked long, and the naked
 * part has no differential to widen. It is already carrying its full outright risk under
 * (1), which is the honest place for it.
 */

const num = (v) => (v === "" || v === null || v === undefined || isNaN(+v) ? 0 : +v);
const round2 = (x) => (isFinite(x) ? +(+x).toFixed(2) : x);
/** Notional arithmetic on hundredths of a lot, kept off the floating-point cliff. */
const round9 = (x) => (Math.abs(x) < 1e-9 ? 0 : +(+x).toFixed(9));

export const legKey = (leg) => `${leg.broker}|${leg.product}`;

/**
 * A leg, resolved against the book.
 *
 * `pos` is signed lots (+ long). `size` is the contract size, `mark` the current price.
 * `ratio` is the hedge ratio — how many of this leg make one unit of the spread. It
 * defaults to 1, which is what a barrel-for-barrel oil spread is.
 */
export function resolveLeg(leg, { pos = 0, size = 1000, mark = null } = {}) {
  const ratio = num(leg.ratio) > 0 ? num(leg.ratio) : 1;
  const notional = round9(pos * (num(size) || 1000));
  return {
    ...leg,
    key: legKey(leg),
    ratio,
    pos,
    size: num(size) || 1000,
    mark: mark === null || mark === undefined || !isFinite(mark) ? null : +mark,
    notional,
    // Units of the spread this leg is worth: 0.12 lots of 1000 at a ratio of 1 is 120.
    units: Math.abs(notional) / ratio,
    sign: Math.sign(pos),
  };
}

/**
 * How much of the spread is actually on, and what is left over naked.
 *
 * The matched size is the smallest leg once ratios are taken out — you cannot have more
 * spread on than your thinnest leg supports. Everything above that, on any leg, is an
 * outright position wearing the spread's name.
 */
export function matchLegs(legs) {
  const live = legs.filter((l) => l.pos !== 0);
  // A spread needs at least two legs actually on, and they cannot all be the same way
  // round — two longs are two longs, whatever they are called.
  const sides = new Set(live.map((l) => l.sign));
  if (live.length < 2 || sides.size < 2) return { matched: 0, residual: legs.map((l) => ({ leg: l, notional: l.notional })).filter((r) => r.notional !== 0) };

  const matched = Math.min(...live.map((l) => l.units));
  const residual = live
    .map((l) => ({ leg: l, notional: round9(l.sign * (l.units - matched) * l.ratio) }))
    .filter((r) => r.notional !== 0);
  return { matched, residual };
}

/** Where the spread is priced right now: the signed sum of the legs, ratio-weighted. */
export function spreadValue(legs) {
  const priced = legs.filter((l) => l.mark !== null);
  if (priced.length < legs.length || !legs.length) return null;
  return round2(legs.reduce((a, l) => a + (l.sign || 1) * l.ratio * l.mark, 0));
}

/**
 * Stress one spread.
 *
 * `move` is the correlated move applied to every leg, {v, unit} with unit "%" or "pts" —
 * the same shape the per-product scenario already uses, so a spread and a position are
 * stressed by the same numbers.
 *
 * `widen` is how far the differential itself can go against you, {v, unit}. As a
 * percentage it is a percentage of the spread's current value, because that is what a
 * trader means by "the spread moves 20%".
 *
 * Returns the loss as a POSITIVE number of dollars, split into its two parts so the screen
 * can show which one is doing the damage — on a well matched spread it is nearly all
 * widening, and that is the useful thing to know.
 */
export function stressSpread(legs, move, widen, scale = 1) {
  const value = spreadValue(legs);
  const unpriced = legs.filter((l) => l.pos !== 0 && l.mark === null).map((l) => l.product);
  const { matched, residual } = matchLegs(legs);

  // (1) Correlated: every leg the same way, worst of the two directions.
  const mv = { unit: move?.unit === "pts" ? "pts" : "%", v: num(move?.v) * scale };
  const pnlAt = (d) =>
    legs.reduce((a, l) => {
      if (!l.pos) return a;
      if (mv.unit === "%" && l.mark === null) return a;  // no price, no percentage of it
      const dist = mv.unit === "%" ? Math.abs(l.mark) * mv.v / 100 : mv.v;
      return a + l.notional * d * dist;
    }, 0);
  const correlated = Math.min(pnlAt(1), pnlAt(-1));

  // (2) The differential, on the matched part only.
  const wUnit = widen?.unit === "%" ? "%" : "pts";
  const wRaw = num(widen?.v) * scale;
  // A percentage widening needs a spread value to be a percentage OF. With the legs
  // unpriced there is nothing to take a percentage of, so it contributes nothing rather
  // than a number invented from zero.
  const wDist = wUnit === "%" ? (value === null ? NaN : Math.abs(value) * wRaw / 100) : wRaw;
  const widening = isFinite(wDist) ? matched * Math.abs(wDist) : 0;

  const loss = round2(Math.max(0, -correlated) + widening);

  /*
   * What the platform would have said without any of this: each leg moved against ITSELF,
   * so both legs lose at once. Carried through so the screen can show the two side by
   * side — the gap between them is the whole point of the feature.
   */
  const outright = round2(
    legs.reduce((a, l) => {
      if (!l.pos) return a;
      if (mv.unit === "%" && l.mark === null) return a;
      const dist = mv.unit === "%" ? Math.abs(l.mark) * mv.v / 100 : mv.v;
      return a + Math.abs(l.notional) * dist;
    }, 0),
  );

  return {
    value,
    matched,
    residual,
    correlated: round2(correlated),
    correlatedLoss: round2(Math.max(0, -correlated)),
    widening: round2(widening),
    loss,
    outright,
    // Named rather than silently dropped: a leg with no price is a hole in the answer.
    unpriced,
    incomplete: unpriced.length > 0 || matched === 0,
  };
}

/*
 * ---------------------------------------------------------------------------
 * FINDING SPREADS THE TRADER IS ALREADY TRADING
 * ---------------------------------------------------------------------------
 * Suggestions only. Nothing is ever paired without the trader saying so, because a wrong
 * pairing does not look wrong — it quietly halves a risk figure, and the first time anyone
 * finds out is when the loss is real.
 *
 * What a legged spread looks like in the fills: two fills, opposite sides, different
 * products, within the same minute or so, and it happens again and again. One coincidence
 * is a coincidence; the fourth is a strategy.
 */
const MINUTE = 60_000;

export function suggestSpreads(fills, { windowMs = 90_000, minPairs = 2 } = {}) {
  const trades = fills
    .filter((f) => f.product && f.qty && f.ts)
    .map((f) => ({ ...f, t: new Date(f.ts).getTime(), s: /^s/i.test(String(f.side)) ? -1 : 1 }))
    .filter((f) => isFinite(f.t))
    .sort((a, b) => a.t - b.t);

  const pairs = new Map();
  for (let i = 0; i < trades.length; i++) {
    for (let j = i + 1; j < trades.length && trades[j].t - trades[i].t <= windowMs; j++) {
      const a = trades[i], b = trades[j];
      if (a.product === b.product) continue;      // same instrument is a roll, not a spread
      if (a.s === b.s) continue;                  // both the same way is not a spread
      // Stable key so A/B and B/A are the same suggestion.
      const legs = [
        { broker: a.broker || "default", product: a.product },
        { broker: b.broker || "default", product: b.product },
      ].sort((x, y) => legKey(x).localeCompare(legKey(y)));
      const key = legs.map(legKey).join(" / ");
      const rec = pairs.get(key) || { key, legs, pairs: 0, crossAccount: legs[0].broker !== legs[1].broker, lastTs: null, sameMinute: 0 };
      rec.pairs += 1;
      if (Math.abs(a.t - b.t) < MINUTE) rec.sameMinute += 1;
      rec.lastTs = new Date(Math.max(a.t, b.t)).toISOString();
      pairs.set(key, rec);
    }
  }

  return [...pairs.values()]
    .filter((p) => p.pairs >= minPairs)
    // Legged across two accounts first — those are the ones the per-account view gets most
    // wrong, so they are the ones worth showing at the top.
    .sort((a, b) => Number(b.crossAccount) - Number(a.crossAccount) || b.pairs - a.pairs)
    .map((p) => ({ ...p, name: p.legs.map((l) => l.product).join(" / ") }));
}

/** A spread as stored in settings, with the defaults an older saved one would lack. */
export function normaliseSpread(sp) {
  return {
    id: sp.id,
    name: sp.name || (sp.legs || []).map((l) => l.product).join(" / "),
    legs: (sp.legs || []).map((l) => ({ broker: l.broker, product: l.product, ratio: num(l.ratio) > 0 ? num(l.ratio) : 1 })),
    widen: { v: num(sp.widen?.v), unit: sp.widen?.unit === "%" ? "%" : "pts" },
  };
}
