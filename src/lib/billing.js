/*
 * Turning what Stripe says into what Nexus records.
 *
 * Pure, and deliberately so: this decides whether somebody keeps access when a card fails,
 * and that is not a rule anybody should have to set up a webhook to read.
 *
 * Stripe's vocabulary is not ours. It has seven subscription statuses and we have five,
 * and the mapping is a series of judgements about people rather than a lookup table.
 */

/**
 * Stripe status -> ours.
 *
 *   trialing            a Stripe-side trial. Ours are granted without a card, but a
 *                       checkout can carry one, so it has to be honoured.
 *   active              paid and current.
 *   past_due            a renewal failed and Stripe is retrying. THEY KEEP ACCESS. A bank
 *                       declining a card at 3am is not a reason to lock a desk out of its
 *                       own book mid-session; Stripe will retry for days and email them.
 *   unpaid              retries are exhausted. Now it stops.
 *   canceled            over.
 *   incomplete          a first payment that never completed — they never had access, so
 *                       this is "nothing", not "cancelled". The difference matters: one of
 *                       them can still be offered a trial.
 *   incomplete_expired  same, and Stripe has given up.
 *   paused              a deliberate hold. No access, but not a cancellation either.
 */
const MAP = {
  trialing: "trialing",
  active: "active",
  past_due: "past_due",
  unpaid: "canceled",
  canceled: "canceled",
  incomplete: "none",
  incomplete_expired: "none",
  paused: "canceled",
};

/**
 * An unknown status is treated as no access, never as access.
 *
 * If Stripe adds a status we have never seen, the safe failure is a customer who contacts
 * us because they cannot get in — not a customer who stopped paying six months ago and
 * nobody noticed.
 */
export function statusFromStripe(stripeStatus) {
  return MAP[stripeStatus] ?? "none";
}

/** Stripe counts in whole seconds; everything here is in milliseconds. */
export const fromStripeTime = (seconds) =>
  typeof seconds === "number" && Number.isFinite(seconds) ? new Date(seconds * 1000) : null;

/**
 * The subscription row a Stripe object implies.
 *
 * `current_period_end` is Stripe's, not ours, and that is the point: Stripe is the record
 * of what was paid for, so a renewal moving the date is Stripe telling us, never us
 * guessing. A missing period end leaves the column null, which every reader treats as
 * open-ended — correct here, because a subscription Stripe cannot date is one we should not
 * cut off on a date we invented.
 */
export function rowFromStripe(subscription) {
  const status = statusFromStripe(subscription?.status);
  const endsAt = fromStripeTime(subscription?.current_period_end);
  return {
    status,
    current_period_end: endsAt ? endsAt.toISOString() : null,
    cancel_at_period_end: Boolean(subscription?.cancel_at_period_end),
    provider: "stripe",
    provider_customer_id: typeof subscription?.customer === "string" ? subscription.customer : null,
    provider_subscription_id: typeof subscription?.id === "string" ? subscription.id : null,
  };
}

/**
 * Which webhook events change anything.
 *
 * Everything else Stripe sends is noise to us, and answering 200 to noise without acting on
 * it is correct: an event we ignore must not be retried forever, and an event we do not
 * understand must not be guessed at.
 */
export const HANDLED_EVENTS = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "invoice.payment_failed",
  "invoice.payment_succeeded",
]);
