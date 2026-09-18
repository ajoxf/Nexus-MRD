import { isSpreadSymbol } from "./csv.js";

/*
 * What one lot is, when nobody has said.
 *
 * Contract size is the multiplier between a price move and money, so a wrong one is not a
 * rounding error — it is the whole P&L out by a factor. The app's long-standing fallback was
 * 1,000, which is right for a crude barrel and for every spread quoted in dollars a barrel, and
 * that covers CL, BZ and the Inter-Product, Calendar and Crack spreads built on them.
 *
 * Heating oil is the exception a crude desk trips over. NYMEX HO is 42,000 US gallons quoted in
 * dollars a GALLON, so a cent is $420 a lot, not $10. An HO outright booked at 1,000 reports
 * one forty-second of its real P&L, and nothing on screen looks wrong: the prices are right,
 * the lots are right, only the money is small.
 *
 * The crack is deliberately NOT in here. "Oct26 HO-CL Crack" is HO×42 minus CL, quoted in
 * dollars a barrel at 1,000 a point — the 42 is already inside the price. Sizing the crack at
 * 42,000 would count that conversion twice. Every spread symbol therefore keeps 1,000.
 *
 * Anything a trader has typed into a broker's product list always wins over this. These are the
 * defaults for products nobody has got round to filling in.
 */
export const DEFAULT_SIZE = 1000;

// Outright months whose quoted unit is not the barrel. Matched on the leading symbol, so every
// delivery month is covered without naming them one at a time: HO Oct26, HO Nov26, HO-Z26.
const OUTRIGHTS = [
  // HO followed by a separator (HO Oct26, HO-Z26), or straight into a futures month code
  // (HOZ26). Not merely "HO" followed by any letter, or HOUSE would be heating oil.
  { match: /^HO(?:$|[\s._/-]+|(?=[FGHJKMNQUVXZ]\d))/i, size: 42000 },   // NYMEX heating oil / ULSD, 42,000 US gallons
];

export function defaultSize(product) {
  const s = String(product ?? "").trim();
  if (!s) return DEFAULT_SIZE;
  // A spread is quoted in its own unit, which for every spread this desk trades is the barrel.
  if (isSpreadSymbol(s)) return DEFAULT_SIZE;
  for (const r of OUTRIGHTS) if (r.match.test(s)) return r.size;
  return DEFAULT_SIZE;
}

// The size to use for a product, given whatever the broker's product list holds for it.
export const sizeOf = (spec, product) => {
  const set = spec && spec.size;
  const n = set === "" || set === null || set === undefined ? NaN : +set;
  return isFinite(n) && n !== 0 ? n : defaultSize(product);
};
