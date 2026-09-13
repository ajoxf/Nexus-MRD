import { callerFrom, json, serviceClient } from "./_supabase.js";
import { siteUrl, stripeClient, stripeConfigured } from "./_stripe.js";

/*
 * Start a Stripe checkout for the signed-in account.
 *
 * The price is a server setting, never taken from the request. A price id in the body is a
 * request to be charged whatever the caller fancies, and it would be granted.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });
  if (!stripeConfigured()) {
    return json(response, 503, { error: "Card payment is not set up yet. Email team@fincoursa.com and we will sort you out." });
  }

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const user = await callerFrom(request, db);
  if (!user) return json(response, 401, { error: "Sign in first." });

  const { data: sub } = await db
    .from("subscriptions").select("provider_customer_id").eq("user_id", user.id).maybeSingle();

  try {
    const stripe = stripeClient();
    const base = siteUrl(request);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription",
      line_items: [{ price: process.env.STRIPE_PRICE_ID, quantity: 1 }],
      /*
       * Reuse their Stripe customer where we have one, so a second subscription does not
       * create a second customer and split one desk's billing history across two records.
       */
      ...(sub?.provider_customer_id
        ? { customer: sub.provider_customer_id }
        : { customer_email: user.email ?? undefined }),
      /*
       * Who this is, carried through Stripe and back. The webhook arrives with no session
       * and no cookie — this is the only thread tying a payment to an account, and without
       * it a successful payment has nobody to grant.
       */
      client_reference_id: user.id,
      subscription_data: { metadata: { nexus_user_id: user.id } },
      metadata: { nexus_user_id: user.id },
      success_url: `${base}/?checkout=done`,
      cancel_url: `${base}/?checkout=cancelled`,
      allow_promotion_codes: true,
    });
    return json(response, 200, { url: session.url });
  } catch (error) {
    console.error("[checkout]", error?.message);
    return json(response, 500, { error: "Could not start checkout. Please try again." });
  }
}
