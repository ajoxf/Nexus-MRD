/*
 * The affiliate arithmetic, checked against hand-worked numbers.
 *
 * This file decides how much money somebody is paid. Every expected figure below was
 * worked out by hand and the working is written next to it, so a change that alters a
 * payout has to argue with the arithmetic rather than just move a number.
 */
import {
  generateRefCode, normaliseRef, looksLikeRef, refStillValid, REF_WINDOW_DAYS,
  canAttribute, rewardRefusal, rewardFor, periodRef, tallyRewards, describeTerms,
} from "../src/lib/affiliates.js";

let pass = 0, fail = 0;
const ok = (name, got, want) => {
  const same = JSON.stringify(got) === JSON.stringify(want);
  if (same) { pass += 1; } else { fail += 1; console.error(`FAIL ${name}\n  got  ${JSON.stringify(got)}\n  want ${JSON.stringify(want)}`); }
};

// ---- codes -----------------------------------------------------------------
ok("code shape", looksLikeRef(generateRefCode(() => 0)), true);
ok("code has no confusable letters", /[01OIL]/.test(generateRefCode(() => 0.999)), false);
ok("lowercase typed in", normaliseRef("ref-7k4p"), "REF-7K4P");
ok("spaces and no dash", normaliseRef(" 7 K 4 P "), "REF-7K4P");
ok("already right", normaliseRef("REF-7K4P"), "REF-7K4P");
ok("empty stays empty", normaliseRef(""), "");
ok("a code with the wrong letters is refused", looksLikeRef("REF-0IL1"), false);

// ---- the window ------------------------------------------------------------
const now = new Date("2026-09-13T12:00:00Z");
const daysAgo = (n) => new Date(now.getTime() - n * 86400000).toISOString();
ok("window is 90 days", REF_WINDOW_DAYS, 90);
ok("clicked today", refStillValid(daysAgo(0), now), true);
ok("clicked 89 days ago", refStillValid(daysAgo(89), now), true);
ok("clicked 91 days ago", refStillValid(daysAgo(91), now), false);
ok("never clicked", refStillValid(null, now), false);
ok("nonsense date", refStillValid("not a date", now), false);

// ---- who may be credited ---------------------------------------------------
ok("active attributes", canAttribute({ status: "active" }), true);
// Paused keeps the trail; it is earning that stops.
ok("paused still attributes", canAttribute({ status: "paused" }), true);
ok("closed does not", canAttribute({ status: "closed" }), false);
ok("no affiliate does not", canAttribute(null), false);

// ---- refusals --------------------------------------------------------------
const base = { status: "active", email: "sam@intro.com", reward_kind: "percent", reward_value: 20, reward_scope: "first" };
ok("signed up but never paid", rewardRefusal(base, { referralStatus: "signed_up", isFirstPayment: true }), "not_converted");
ok("paused earns nothing", rewardRefusal({ ...base, status: "paused" }, { referralStatus: "converted", isFirstPayment: true }), "not_active");
ok("own link, same email", rewardRefusal(base, { referralStatus: "converted", buyerEmail: "SAM@Intro.com ", isFirstPayment: true }), "self_referral");
ok("first-payment deal, second month", rewardRefusal(base, { referralStatus: "converted", isFirstPayment: false }), "not_first_payment");
ok("recurring deal, second month", rewardRefusal({ ...base, reward_scope: "recurring" }, { referralStatus: "converted", isFirstPayment: false }), null);
ok("all clear", rewardRefusal(base, { referralStatus: "converted", buyerEmail: "desk@firm.com", isFirstPayment: true }), null);

// ---- the money -------------------------------------------------------------
const paid = { referralStatus: "converted", buyerEmail: "desk@firm.com", isFirstPayment: true, currency: "usd" };

// 20% of $349.00 = 34900 * 0.20 = 6980 cents = $69.80
ok("20% of $349", rewardFor(base, { ...paid, basisMinor: 34900 }),
  { kind: "percent", rate: 20, amount_minor: 6980, basis_minor: 34900, currency: "usd" });

// 15% of $99.99 = 9999 * 0.15 = 1499.85 -> floors to 1499 cents = $14.99, not $15.00.
ok("15% of $99.99 rounds down", rewardFor({ ...base, reward_value: 15 }, { ...paid, basisMinor: 9999 }),
  { kind: "percent", rate: 15, amount_minor: 1499, basis_minor: 9999, currency: "usd" });

// A rate typed as 200 must not pay out twice what came in. Capped at 100%.
ok("200% is capped at the whole payment", rewardFor({ ...base, reward_value: 200 }, { ...paid, basisMinor: 34900 }),
  { kind: "percent", rate: 200, amount_minor: 34900, basis_minor: 34900, currency: "usd" });

// Commission is on what was actually paid. A $349 plan sold with a 50% coupon pays $174.50,
// and 20% of that is 3490 cents = $34.90 — not $69.80.
ok("discounted sale pays commission on the discounted amount", rewardFor(base, { ...paid, basisMinor: 17450 }),
  { kind: "percent", rate: 20, amount_minor: 3490, basis_minor: 17450, currency: "usd" });

// A free first month is a payment of zero. Twenty percent of nothing is nothing, and there
// is no reward row to write.
ok("a zero payment earns nothing", rewardFor(base, { ...paid, basisMinor: 0 }), null);

const fixed = { ...base, reward_kind: "fixed", reward_value: 5000 };   // $50.00 flat
ok("flat $50 on a $349 sale", rewardFor(fixed, { ...paid, basisMinor: 34900 }),
  { kind: "fixed", rate: 5000, amount_minor: 5000, basis_minor: 34900, currency: "usd" });
// $50 flat on a $29 sale would pay out more than came in. Capped at the payment.
ok("flat fee cannot exceed the payment", rewardFor(fixed, { ...paid, basisMinor: 2900 }),
  { kind: "fixed", rate: 5000, amount_minor: 2900, basis_minor: 2900, currency: "usd" });

const months = { ...base, reward_kind: "free_months", reward_value: 1 };
ok("a free month carries no currency", rewardFor(months, { ...paid, basisMinor: 34900 }),
  { kind: "free_months", rate: 1, amount_minor: 1, basis_minor: 34900, currency: null });

ok("a rate of zero earns nothing", rewardFor({ ...base, reward_value: 0 }, { ...paid, basisMinor: 34900 }), null);
ok("a refused conversion earns nothing", rewardFor(base, { ...paid, referralStatus: "signed_up", basisMinor: 34900 }), null);

// ---- what a reward is for --------------------------------------------------
ok("first-payment deals key on the word", periodRef(base, { periodEnd: "2026-10-13T00:00:00Z" }), "first");
ok("recurring deals key on the period", periodRef({ ...base, reward_scope: "recurring" }, { periodEnd: "2026-10-13T00:00:00Z" }), "2026-10-13T00:00:00.000Z");
ok("recurring with no period falls back", periodRef({ ...base, reward_scope: "recurring" }, {}), "first");

// ---- the tally -------------------------------------------------------------
// 6980 + 3490 owed = 10470; 5000 paid; one void ignored; one free month counted apart.
ok("tally", tallyRewards([
  { status: "owed", kind: "percent", amount_minor: 6980 },
  { status: "owed", kind: "percent", amount_minor: 3490 },
  { status: "paid", kind: "fixed", amount_minor: 5000 },
  { status: "void", kind: "percent", amount_minor: 9999 },
  { status: "owed", kind: "free_months", amount_minor: 1 },
]), { owed: 10470, paid: 5000, void: 1, months: 1, count: 4 });

// ---- the sentence ----------------------------------------------------------
ok("percent in words", describeTerms(base), "20% of first payment");
ok("recurring percent in words", describeTerms({ ...base, reward_scope: "recurring" }), "20% of every payment");
ok("one free month, singular", describeTerms(months), "1 free month per conversion");
ok("flat fee in words", describeTerms(fixed), "50.00 per conversion, first payment");

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
