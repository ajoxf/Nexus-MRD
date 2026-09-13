import { HANDLED_EVENTS, rowFromStripe } from "../src/lib/billing.js";
import { json, serviceClient } from "./_supabase.js";
import { rawBody, stripeClient } from "./_stripe.js";

/*
 * Vercel parses JSON bodies for you. Stripe signs the exact bytes it sent, and a
 * parsed-then-restringified body differs from the original by a space or a key order — so
 * with the parser on, every signature check fails, on the one route where a failed check
 * looks exactly like an attack.
 */
export const config = { api: { bodyParser: false } };

/*
 * What Stripe tells us about money, written into the subscription row.
 *
 * This endpoint is public — it has to be, Stripe calls it — so the signature IS the
 * authentication. Nothing here trusts the body until that check passes, and a body that
 * fails it is refused rather than interpreted.
 *
 * Every write is an upsert of the same derived state, so a duplicate delivery lands on the
 * same row with the same values. Stripe retries, and retries must be boring.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });

  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) return json(response, 503, { error: "Not configured." });

  let event;
  try {
    const stripe = stripeClient();
    const body = await rawBody(request);
    event = stripe.webhooks.constructEvent(body, request.headers["stripe-signature"], secret);
  } catch (error) {
    // Deliberately terse. An unsigned caller learns nothing about why.
    console.error("[stripe-webhook] signature check failed:", error?.message);
    return json(response, 400, { error: "Bad signature." });
  }

  /*
   * 200 to everything we do not act on.
   *
   * Stripe retries a non-200 for days. An event we deliberately ignore is handled — saying
   * so stops a retry storm over something that was never a problem.
   */
  if (!HANDLED_EVENTS.has(event.type)) return json(response, 200, { ignored: event.type });

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Not configured." }); }

  try {
    const stripe = stripeClient();
    const object = event.data.object;

    /*
     * Which account this is about, in the order the answer is most trustworthy: the id we
     * put on the subscription ourselves, then the one on the checkout session, then — for
     * events carrying neither — the Stripe customer we recorded last time.
     */
    const subscriptionId =
      object.object === "subscription" ? object.id
      : typeof object.subscription === "string" ? object.subscription
      : null;

    const subscription = subscriptionId
      ? await stripe.subscriptions.retrieve(subscriptionId)
      : null;

    let userId =
      subscription?.metadata?.nexus_user_id ||
      object.metadata?.nexus_user_id ||
      object.client_reference_id ||
      null;

    const customerId =
      typeof subscription?.customer === "string" ? subscription.customer
      : typeof object.customer === "string" ? object.customer
      : null;

    if (!userId && customerId) {
      const { data } = await db
        .from("subscriptions").select("user_id").eq("provider_customer_id", customerId).maybeSingle();
      userId = data?.user_id ?? null;
    }

    /*
     * No account to write to is not an error to retry.
     *
     * A payment in the Stripe dashboard that no Nexus account matches is a real thing that
     * happens — a test charge, a customer created by hand — and asking Stripe to redeliver
     * it for three days will not conjure one. It is logged loudly and accepted.
     */
    if (!userId) {
      console.error("[stripe-webhook] no Nexus account for", event.type, customerId ?? "(no customer)");
      return json(response, 200, { ignored: "no matching account" });
    }

    if (!subscription) {
      // An invoice event with no subscription behind it — a one-off charge. Nothing to set.
      return json(response, 200, { ignored: "no subscription" });
    }

    const row = rowFromStripe(subscription);
    const { error } = await db.from("subscriptions").upsert(
      { user_id: userId, ...row, updated_at: new Date().toISOString() },
      { onConflict: "user_id" },
    );
    if (error) {
      // A 500 here IS what we want: Stripe retries, and a write we could not make is
      // exactly the case worth retrying.
      console.error("[stripe-webhook] write failed", error.message);
      return json(response, 500, { error: "Could not record that." });
    }

    return json(response, 200, { ok: true, status: row.status });
  } catch (error) {
    console.error("[stripe-webhook]", event.type, error?.message);
    return json(response, 500, { error: "Could not process that." });
  }
}
