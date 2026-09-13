import { adminFrom, json, serviceClient } from "../_supabase.js";
import { stripeClient, stripeConfigured } from "../_stripe.js";

/*
 * Money in, and whether the machinery that collects it is actually switched on.
 *
 * Two questions that look like one. "No payments" can mean nobody has paid, or it can mean
 * the keys were never set and nobody COULD pay — and those call for very different
 * mornings. This endpoint answers both, and says which it is.
 *
 * It reports the presence of each secret and never its value. A boolean cannot be stolen.
 */

/** Present, absent — never the value. */
const has = (name) => Boolean(process.env[name]);

/*
 * Live or test, read from the key's own prefix.
 *
 * Not a secret — it is the first eight characters of a key Stripe prints in its own
 * dashboard — and worth surfacing loudly, because a desk that thinks it is taking money
 * while pointed at a test key finds out at the end of the month.
 */
function stripeMode() {
  const key = process.env.STRIPE_SECRET_KEY || "";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  return key ? "unknown" : null;
}

/** A yearly plan stated per month, so one number can be compared with another. */
function monthlyMinor(amount, interval, count = 1) {
  const a = Number(amount);
  if (!Number.isFinite(a)) return null;
  const per = Math.max(1, Number(count) || 1);
  if (interval === "year") return Math.round(a / (12 * per));
  if (interval === "week") return Math.round((a * 52) / (12 * per));
  if (interval === "day") return Math.round((a * 365) / (12 * per));
  return Math.round(a / per);
}

export default async function handler(request, response) {
  if (request.method !== "GET") return json(response, 405, { error: "Use GET." });

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const admin = await adminFrom(request, db);
  if (!admin) return json(response, 403, { error: "Not allowed." });

  /*
   * What is configured. Reported whether or not Stripe answers, because when it does not
   * answer this is the part that explains why.
   */
  const config = {
    stripe: {
      configured: stripeConfigured(),
      mode: stripeMode(),
      secretKey: has("STRIPE_SECRET_KEY"),
      priceId: has("STRIPE_PRICE_ID"),
      // Not needed to take a payment, but without it no payment is ever WRITTEN DOWN:
      // the webhook refuses every unsigned delivery, so subscriptions silently never update.
      webhookSecret: has("STRIPE_WEBHOOK_SECRET"),
    },
    email: {
      configured: has("RESEND_API_KEY") && has("NEXUS_EMAIL_FROM"),
      apiKey: has("RESEND_API_KEY"),
      from: has("NEXUS_EMAIL_FROM"),
      replyTo: has("NEXUS_EMAIL_REPLY_TO"),
    },
    database: { configured: true }, // We are talking to it; that is the proof.
  };

  // What our own records say, which is true even when Stripe cannot be reached.
  const { data: subs } = await db
    .from("subscriptions")
    .select("user_id, status, provider, provider_customer_id, provider_subscription_id, current_period_end, cancel_at_period_end, updated_at");

  const counts = { active: 0, trialing: 0, past_due: 0, canceled: 0, other: 0, onStripe: 0 };
  for (const s of subs ?? []) {
    if (counts[s.status] === undefined) counts.other += 1; else counts[s.status] += 1;
    if (s.provider === "stripe" && s.provider_subscription_id) counts.onStripe += 1;
  }

  if (!config.stripe.configured) {
    /*
     * Stripe is off. Everything above is still true and still worth showing — the point of
     * this screen is to say WHY there is nothing here, not to render an empty table.
     */
    return json(response, 200, { config, counts, price: null, payments: [], totals: null });
  }

  /*
   * Stripe's own record, which outranks ours.
   *
   * Ours is written by the webhook, so if the webhook secret is missing or wrong, ours is
   * stale and Stripe's is right. Showing both is how that gets noticed.
   */
  let price = null;
  let payments = [];
  let totals = null;
  let stripeError = null;

  try {
    const stripe = stripeClient();

    const p = await stripe.prices.retrieve(process.env.STRIPE_PRICE_ID, { expand: ["product"] });
    price = {
      amount_minor: p.unit_amount ?? null,
      currency: (p.currency || "").toUpperCase() || null,
      interval: p.recurring?.interval ?? null,
      intervalCount: p.recurring?.interval_count ?? 1,
      product: typeof p.product === "object" ? p.product?.name ?? null : null,
      live: p.livemode,
    };

    // Recent invoices, newest first. Paid and unpaid both — an unpaid one is the more
    // interesting row.
    const invoices = await stripe.invoices.list({ limit: 25, expand: ["data.customer"] });
    payments = (invoices.data ?? []).map((inv) => ({
      id: inv.id,
      number: inv.number ?? null,
      created: inv.created ? new Date(inv.created * 1000).toISOString() : null,
      email: inv.customer_email ?? (typeof inv.customer === "object" ? inv.customer?.email ?? null : null),
      amount_due_minor: inv.amount_due ?? null,
      amount_paid_minor: inv.amount_paid ?? null,
      currency: (inv.currency || "").toUpperCase() || null,
      status: inv.status ?? null,
      // subscription_create on the first invoice of a subscription; subscription_cycle on a renewal.
      reason: inv.billing_reason ?? null,
      url: inv.hosted_invoice_url ?? null,
    }));

    const collected = payments.reduce((a, r) => a + (Number(r.amount_paid_minor) || 0), 0);
    const currencies = new Set(payments.map((r) => r.currency).filter(Boolean));

    totals = {
      // Recurring revenue from what WE hold, priced at the plan: active subscriptions times
      // the plan's monthly equivalent. Not a forecast, and it says so on the screen.
      mrr_minor: price.amount_minor != null
        ? monthlyMinor(price.amount_minor, price.interval, price.intervalCount) * counts.active
        : null,
      mrrCurrency: price.currency,
      // Only stated when everything shown is in one currency. Adding euros to dollars at
      // today's rate would make this disagree with every invoice it came from.
      collected_minor: currencies.size === 1 ? collected : null,
      collectedCurrency: currencies.size === 1 ? [...currencies][0] : null,
      mixedCurrencies: currencies.size > 1,
      shown: payments.length,
    };
  } catch (error) {
    /*
     * A 200 with the reason attached, not a 500.
     *
     * Everything above this point is real and useful. Throwing it away because Stripe was
     * slow would replace a screen that explains itself with one that says nothing.
     */
    console.error("[admin/payments] Stripe:", error?.message);
    stripeError = error?.message === "Stripe is not configured."
      ? "Stripe is not configured."
      : "Could not reach Stripe. The figures below come from our own records.";
  }

  return json(response, 200, { config, counts, price, payments, totals, stripeError });
}
