/*
 * Affiliates: the codes, the attribution window, and the arithmetic of what is owed.
 *
 * Pure. This is the file that decides how much money somebody is paid, so it is testable
 * without a database, a Stripe key or a network — and it is tested that way, in
 * scripts/affiliates-check.mjs.
 */

/** Same reasoning as the access codes: no 0/O and no 1/I/L, because these get typed. */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/**
 * An affiliate code, e.g. REF-7K4P.
 *
 * Shorter than an access code on purpose. This one goes in a link, a signature block and
 * occasionally a slide; an access code is worth money on its own and has to be hard to
 * guess. Guessing a referral code gains you nothing — the worst outcome is that somebody
 * else gets credited, which is why the prefix keeps the two visibly different.
 */
export function generateRefCode(rand = Math.random) {
  let out = "";
  for (let i = 0; i < 4; i += 1) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return `REF-${out}`;
}

/** What somebody typed, or what was in the link, tidied into what we stored. */
export function normaliseRef(input) {
  const bare = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!bare) return "";
  const rest = bare.startsWith("REF") ? bare.slice(3) : bare;
  return `REF-${rest.slice(0, 4)}`;
}

export const looksLikeRef = (v) => /^REF-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(v);

/**
 * How long a click keeps its claim.
 *
 * Ninety days is the usual affiliate window and it suits this product: a desk evaluating a
 * risk tool does not sign up the afternoon they first read about it. Too short and the
 * affiliate does the work and loses the credit; too long and a link clicked last spring
 * takes a sale that came from somewhere else entirely.
 */
export const REF_WINDOW_DAYS = 90;

/** Whether a stored click is still within its window. */
export function refStillValid(capturedAt, now = new Date()) {
  if (!capturedAt) return false;
  const at = new Date(capturedAt).getTime();
  if (!Number.isFinite(at)) return false;
  return now.getTime() - at <= REF_WINDOW_DAYS * 86400000;
}

/**
 * Whether this affiliate can be credited with a new referral at all.
 *
 * `paused` still attributes. That is deliberate: pausing is for a term being renegotiated
 * or a dispute being sorted out, and dropping attribution during it would destroy the
 * record that settles the argument. What pausing stops is EARNING — see rewardFor.
 */
export function canAttribute(affiliate) {
  if (!affiliate) return false;
  return affiliate.status === "active" || affiliate.status === "paused";
}

/**
 * Why no reward is due, or null if one is.
 *
 * Every one of these is a case that has actually cost somebody money in some affiliate
 * programme, so each is refused by name rather than by falling through to zero.
 */
export function rewardRefusal(affiliate, { referralStatus, buyerEmail, isFirstPayment } = {}) {
  if (!affiliate) return "no_affiliate";
  if (affiliate.status !== "active") return "not_active";

  // A signup that never pays is not a sale.
  if (referralStatus !== "converted") return "not_converted";

  /*
   * Signing up through your own link.
   *
   * Matched on email because that is the only thing the two sides have in common — the
   * affiliate is a person we pay, the buyer is an account. Case and surrounding spaces are
   * not a different person.
   */
  const mine = String(affiliate.email ?? "").trim().toLowerCase();
  const theirs = String(buyerEmail ?? "").trim().toLowerCase();
  if (mine && theirs && mine === theirs) return "self_referral";

  // A recurring deal earns on every payment; a first-payment deal earns once.
  if (affiliate.reward_scope !== "recurring" && isFirstPayment === false) return "not_first_payment";

  return null;
}

/**
 * Rounding, stated once.
 *
 * Down, always, and in minor units. A percentage of a payment rarely lands on a whole
 * cent, and rounding up means paying out fractionally more than was taken in — across
 * enough conversions that is a real number and it only ever runs one way. Rounding down
 * costs the affiliate a fraction of a cent and is the convention they will have seen
 * everywhere else.
 */
const floorMinor = (v) => (Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0);

/**
 * What is owed on one payment, or null if nothing is.
 *
 * `basisMinor` is what the customer actually paid, in minor units, as Stripe reports it —
 * so it is net of a discount they were given and inclusive of nothing we did not receive.
 * Commission on the list price of a discounted sale is commission on money that never
 * arrived.
 */
export function rewardFor(affiliate, payment = {}) {
  const refusal = rewardRefusal(affiliate, payment);
  if (refusal) return null;

  const rate = Number(affiliate.reward_value);
  if (!Number.isFinite(rate) || rate <= 0) return null;

  const basis = Number(payment.basisMinor);

  if (affiliate.reward_kind === "free_months") {
    // No cash, no currency. The unit is months and the ledger says so.
    return {
      kind: "free_months",
      rate,
      amount_minor: Math.max(0, Math.round(rate)),
      basis_minor: Number.isFinite(basis) ? basis : null,
      currency: null,
    };
  }

  if (affiliate.reward_kind === "fixed") {
    /*
     * A flat fee is capped at what was actually paid.
     *
     * A $50 fee on a $29 first month pays out more than came in. If that is genuinely the
     * deal it belongs in a spreadsheet somebody signed, not in an automatic payout.
     */
    const capped = Number.isFinite(basis) ? Math.min(floorMinor(rate), floorMinor(basis)) : floorMinor(rate);
    return {
      kind: "fixed",
      rate,
      amount_minor: capped,
      basis_minor: Number.isFinite(basis) ? basis : null,
      currency: payment.currency ?? null,
    };
  }

  // percent
  if (!Number.isFinite(basis) || basis <= 0) return null;
  // Capped at 100%: a rate typed as 200 is a typo, and it should not empty the account.
  const pct = Math.min(100, rate);
  return {
    kind: "percent",
    rate,
    amount_minor: floorMinor((basis * pct) / 100),
    basis_minor: basis,
    currency: payment.currency ?? null,
  };
}

/**
 * What this reward is FOR, which is what stops a retry paying it twice.
 *
 * A first-payment deal earns once per account, so the word 'first' is the whole key. A
 * recurring deal earns once per billing period, so the period end is. Keyed on the time
 * the webhook fired instead, Stripe's own redelivery would pay again an hour later.
 */
export function periodRef(affiliate, { periodEnd } = {}) {
  if (affiliate?.reward_scope !== "recurring") return "first";
  return periodEnd ? new Date(periodEnd).toISOString() : "first";
}

/** For the admin screen: owed, paid and lifetime, in one pass. */
export function tallyRewards(rewards = []) {
  const out = { owed: 0, paid: 0, void: 0, months: 0, count: 0 };
  for (const r of rewards) {
    if (r.status === "void") { out.void += 1; continue; }
    out.count += 1;
    if (r.kind === "free_months") { out.months += Number(r.amount_minor) || 0; continue; }
    const amount = Number(r.amount_minor) || 0;
    if (r.status === "paid") out.paid += amount; else out.owed += amount;
  }
  return out;
}

/** Terms in a sentence, for the admin table. */
export function describeTerms(affiliate) {
  if (!affiliate) return "—";
  const every = affiliate.reward_scope === "recurring" ? "every payment" : "first payment";
  const v = Number(affiliate.reward_value);
  if (affiliate.reward_kind === "percent") return `${v}% of ${every}`;
  if (affiliate.reward_kind === "free_months") return `${v} free month${v === 1 ? "" : "s"} per conversion`;
  return `${(v / 100).toFixed(2)} per conversion, ${every}`;
}
