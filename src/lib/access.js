/*
 * Who may open the desk.
 *
 * Nexus RAMP decides this for itself now. It used to be NordStar Pro's answer, carried
 * across by provisioning an account here for anybody entitled there — which is what made a
 * customer hold two logins that had to be kept in step, and produced every symptom of that:
 * a generated password nobody was shown, a handover button, and two passwords for one
 * address. One subscription row, read here, replaces all of it.
 *
 * Pure on purpose: the row goes in, an answer comes out, and it can be tested without a
 * database or a browser. The row itself is only ever written by the server — the browser
 * can read its own and nothing else, enforced in Postgres rather than here.
 */

/** Statuses that get you in, subject to the period still running. */
const LIVE = ["trialing", "active", "past_due"];

/*
 * `past_due` is deliberately in that list.
 *
 * It means a payment failed and nobody has been cut off yet. Locking somebody out of their
 * own book the hour a card expires is the wrong response to a bank declining a renewal —
 * they get told, and they get a window. Cutting off is what `canceled` is for.
 */

/**
 * A null period end means OPEN-ENDED, not expired.
 *
 * The most expensive way to get this wrong: a hand-granted account with no end date is
 * every comp, every founder account and every internal one. Reading null as a missing date
 * would cut all of them off at once, and they are exactly the accounts nobody is watching.
 */
export function accessState(sub, now = new Date()) {
  if (!sub || !sub.status || sub.status === "none") return "none";
  if (sub.status === "canceled") return "canceled";
  if (!LIVE.includes(sub.status)) return "none";

  const ends = sub.current_period_end ? new Date(sub.current_period_end) : null;
  if (ends && ends.getTime() <= now.getTime()) {
    // The period ran out. What that means to the person depends on what they had.
    return sub.status === "trialing" ? "trial_over" : "lapsed";
  }
  return sub.status === "trialing" ? "trialing" : "active";
}

export const hasAccess = (sub, now = new Date()) =>
  ["trialing", "active"].includes(accessState(sub, now));

/**
 * May this account start a free trial?
 *
 * Judged on whether one has EVER been started, not on whether one is running. An expired
 * trial still counts, or the same account renews a free fortnight every month by waiting.
 * Somebody who has paid is refused too, and that reads correctly: they do not need one.
 */
export function canStartTrial(sub) {
  if (!sub) return true;
  if (sub.trial_started_at) return false;
  return ["none", "canceled"].includes(sub.status ?? "none");
}

/** Whole days left, rounded up, or null where nothing is running out. */
export function daysLeft(sub, now = new Date()) {
  if (!sub?.current_period_end) return null;
  if (!hasAccess(sub, now)) return null;
  const ms = new Date(sub.current_period_end).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86400000));
}

/** What to tell somebody who cannot get in, in their terms rather than ours. */
export const LOCKED_COPY = {
  none: {
    title: "Your desk is ready",
    body: "This account has no subscription on it yet. Start a free trial and import your first fills — nothing is charged and there is nothing to cancel.",
  },
  trial_over: {
    title: "Your trial has ended",
    body: "Your data is untouched and waiting. Subscribe and you pick up exactly where you left off.",
  },
  lapsed: {
    title: "Your subscription has run out",
    body: "Your book is safe — nothing has been deleted. Renew and everything comes straight back.",
  },
  canceled: {
    title: "Your subscription was cancelled",
    body: "Your book is safe — nothing has been deleted. Subscribe again and it all comes back.",
  },
};
