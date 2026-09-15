import { callerFrom, json, serviceClient } from "./_supabase.js";
import { siteUrl } from "./_stripe.js";
import { createCheckout, cregisConfigured, cryptoPlan } from "./_cregis.js";

/*
 * Start a crypto checkout for the signed-in account.
 *
 * The order row is written BEFORE the buyer is sent anywhere. If Cregis answers and the
 * write had not happened, a callback could arrive for an order we have no record of, and
 * somebody would have paid into a void. Recording first and marking the outcome after means
 * the worst case is a `failed` row an operator can see, not a silent loss.
 *
 * Price and days are server settings. A body that carried either would be a request to be
 * charged whatever the caller fancies, for as long as they fancy — and it would be granted.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });

  if (!cregisConfigured()) {
    return json(response, 503, { error: "Crypto payment is not set up yet. Email team@fincoursa.com and we will sort you out." });
  }
  const plan = cryptoPlan();
  if (!plan.ok) {
    // Configured enough to call Cregis but not enough to know what to charge. Refusing is
    // the only safe answer: a default price here would be a price nobody agreed.
    return json(response, 503, { error: "Crypto payment is not set up yet. Email team@fincoursa.com and we will sort you out." });
  }

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const user = await callerFrom(request, db);
  if (!user) return json(response, 401, { error: "Sign in first." });

  const { data: order, error: orderError } = await db
    .from("crypto_orders")
    .insert({ user_id: user.id, amount: plan.amount, currency: plan.currency, grants_days: plan.days })
    .select("id")
    .single();
  if (orderError || !order) {
    console.error("[crypto-checkout] could not record the order:", orderError?.message);
    return json(response, 500, { error: "Could not start that payment." });
  }

  try {
    const { checkoutUrl, cregisOrderId } = await createCheckout({
      orderId: order.id,
      email: user.email ?? "",
      amount: plan.amount,
      currency: plan.currency,
      siteUrl: siteUrl(request),
      remark: `Nexus RAMP · ${plan.days} days`,
    });

    await db.from("crypto_orders")
      .update({ cregis_order_id: cregisOrderId, checkout_url: checkoutUrl, updated_at: new Date().toISOString() })
      .eq("id", order.id);

    return json(response, 200, { url: checkoutUrl });
  } catch (error) {
    console.error("[crypto-checkout]", error?.message);
    await db.from("crypto_orders")
      .update({ status: "failed", note: String(error?.message ?? "").slice(0, 500), updated_at: new Date().toISOString() })
      .eq("id", order.id);
    /*
     * The buyer gets a plain sentence; the reason — which may name our relay — stays in the
     * log. A customer does not need our infrastructure's name to try again later.
     */
    return json(response, 502, { error: "Could not start that payment. Please try again, or pay by card." });
  }
}
