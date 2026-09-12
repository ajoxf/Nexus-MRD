// Options on futures.
//
// An option is not a future with a different name. Its price does not move one
// for one with the underlying, so the stress test ("crude moves 5% against me")
// cannot be answered by moving the premium 5%: it has to reprice the option at
// the new underlying price. That is what black76 below is for.
//
// Black-76 is the standard model for options on futures (Black's 1976 paper),
// and it is what exchanges and brokers quote against, so it is what we use.

// ---------- the normal distribution ----------
// The bell curve itself: how likely the underlying is to land right at x.
const pdf = (x) => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);

// The area under it up to x — the chance of landing at or below x. There is no
// exact formula, so this is Hart's rational approximation, which is good to
// about 15 decimal places: far beyond anything that matters for a premium.
export function cnd(x) {
  const z = Math.abs(x);
  let c;
  if (z > 37) c = 0;
  else {
    const e = Math.exp(-z * z / 2);
    if (z < 7.07106781186547) {
      let b = 3.52624965998911e-2 * z + 0.700383064443688;
      b = b * z + 6.37396220353165;
      b = b * z + 33.912866078383;
      b = b * z + 112.079291497871;
      b = b * z + 221.213596169931;
      b = b * z + 220.206867912376;
      let d = 8.83883476483184e-2 * z + 1.75566716318264;
      d = d * z + 16.064177579207;
      d = d * z + 86.7807322029461;
      d = d * z + 296.564248779674;
      d = d * z + 637.333633378831;
      d = d * z + 793.826512519948;
      d = d * z + 440.413735824752;
      c = e * b / d;
    } else {
      let b = z + 0.65;
      b = z + 4 / b;
      b = z + 3 / b;
      b = z + 2 / b;
      b = z + 1 / b;
      c = e / (b * 2.506628274631);
    }
  }
  return x > 0 ? 1 - c : c;
}

// ---------- Black-76 ----------
// F    the underlying futures price
// K    the strike
// T    years until the option expires
// vol  annual volatility, as a decimal (0.35 for 35%)
// r    the risk-free rate, as a decimal — it only discounts the premium, so at
//      today's horizons of weeks it barely moves the answer
// right "C" or "P"
//
// Returns the premium in the same units as F and K (dollars a barrel for crude),
// with the sensitivities a desk actually uses:
//   delta  how much the premium moves for a 1.00 move in the underlying
//   gamma  how much delta itself moves for that 1.00 — why an option's risk
//          is not a straight line, and why the stress test has to reprice
//   vega   premium change for one volatility point (1%)
//   theta  premium lost per day, all else equal
export function black76({ F, K, T, vol, r = 0, right = "C" }) {
  const call = String(right).toUpperCase().startsWith("C");
  const df = Math.exp(-r * T);

  // At expiry, or with no volatility left, an option is worth its intrinsic
  // value and nothing more. Guarding this also keeps the log and the division
  // below away from zero.
  if (!(T > 0) || !(vol > 0) || !(F > 0) || !(K > 0)) {
    const intrinsic = Math.max(0, call ? F - K : K - F);
    return { price: df * intrinsic, delta: intrinsic > 0 ? (call ? df : -df) : 0, gamma: 0, vega: 0, theta: 0 };
  }

  const sqrtT = Math.sqrt(T);
  const d1 = (Math.log(F / K) + (vol * vol / 2) * T) / (vol * sqrtT);
  const d2 = d1 - vol * sqrtT;

  const price = call
    ? df * (F * cnd(d1) - K * cnd(d2))
    : df * (K * cnd(-d2) - F * cnd(-d1));

  const delta = call ? df * cnd(d1) : -df * cnd(-d1);
  const gamma = (df * pdf(d1)) / (F * vol * sqrtT);
  const vega = F * df * pdf(d1) * sqrtT / 100;          // per volatility point
  const theta = (-(F * df * pdf(d1) * vol) / (2 * sqrtT)
    + r * df * (call ? F * cnd(d1) - K * cnd(d2) : K * cnd(-d2) - F * cnd(-d1))) / 365;

  return { price, delta, gamma, vega, theta };
}

// ---------- reading an instrument name ----------
// TT writes an option as product, expiry, then the right and strike joined:
//   NL5 W05Sep-26 C5500      Crude Oil Tuesday Week 5, 5500 call
//   LO Dec26 P7000           Crude Oil December, 7000 put
//   CL Dec26 C 95.00         the same thing with the strike spelled out
// The strike is returned exactly as written. Whether 5500 means 55.00 depends
// on the product, so the divisor is a setting rather than a guess made here.
const OPTION_RE = /^(.*?)[\s_]+(\S+)[\s_]+([CP])[\s_]*(\d+(?:\.\d+)?)$/i;

export function parseOptionSymbol(s) {
  const m = OPTION_RE.exec(String(s ?? "").trim());
  if (!m) return null;
  const [, underlying, expiry, right, strike] = m;
  if (!underlying.trim()) return null;
  return {
    underlying: underlying.trim(),
    expiry: expiry.trim(),
    right: right.toUpperCase() === "C" ? "Call" : "Put",
    strikeRaw: Number(strike),
    month: monthOf(expiry),
  };
}

export const isOptionSymbol = (s) => parseOptionSymbol(s) !== null;

// The month and year an expiry code refers to, where they can be read off it:
// "W05Sep-26" and "Dec26" both name one. The exact expiry DATE needs the
// exchange's calendar (a Tuesday weekly is not the same day as the monthly),
// so that stays a setting you fill in per product.
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
export function monthOf(expiry) {
  const m = /([A-Za-z]{3})[^A-Za-z0-9]?(\d{2}|\d{4})\s*$/.exec(String(expiry ?? ""));
  if (!m || !(m[1].toLowerCase() in MONTHS)) return null;
  const y = m[2].length === 2 ? 2000 + +m[2] : +m[2];
  return { month: MONTHS[m[1].toLowerCase()], year: y };
}

// Years between now and expiry, which is the T that black76 wants. Never
// negative: an expired option is worth its intrinsic value, not a nonsense one.
export const yearsTo = (expiryDate, from = new Date()) => {
  const ms = new Date(expiryDate) - from;
  return ms > 0 ? ms / (365 * 24 * 60 * 60 * 1000) : 0;
};
