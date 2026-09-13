import { callerFrom, json, serviceClient } from "./_supabase.js";
import { siteUrl, stripeClient, stripeConfigured } from "./_stripe.js";

/*
 * Stripe's own billing portal: change a card, see invoices, cancel.
 *
 * Deliberately not rebuilt here. Card details, invoice history and cancellation are
 * Stripe's job, they do it better, and every one of those pages we do not write is a page
 * that cannot get card handling wrong.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });
  if (!stripeConfigured()) return json(response, 503, { error: "Card payment is not set up yet." });

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const user = await callerFrom(request, db);
  if (!user) return json(response, 401, { error: "Sign in first." });

  const { data: sub } = await db
    .from("subscriptions").select("provider_customer_id").eq("user_id", user.id).maybeSingle();
  if (!sub?.provider_customer_id) {
    return json(response, 400, { error: "There is no card on this account." });
  }

  try {
    const stripe = stripeClient();
    const session = await stripe.billingPortal.sessions.create({
      customer: sub.provider_customer_id,
      return_url: `${siteUrl(request)}/`,
    });
    return json(response, 200, { url: session.url });
  } catch (error) {
    console.error("[portal]", error?.message);
    return json(response, 500, { error: "Could not open billing. Please try again." });
  }
}
