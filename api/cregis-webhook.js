import { periodEndAfterRedeeming } from "../src/lib/codes.js";
import { json, serviceClient } from "./_supabase.js";
import { cregisConfig, cregisSign, isPaidStatus, isUnderpaid, signaturesMatch, unwrapCallbackOrder } from "./_cregis.js";
import { sendOnce } from "./_email.js";

/*
 * Where a crypto payment becomes access.
 *
 * This endpoint is public — Cregis has to be able to reach it — so THE SIGNATURE IS THE
 * AUTHENTICATION. Nothing below is trusted until it verifies, and a payload that fails is
 * refused rather than interpreted. Without that check anyone who learned this URL could
 * post themselves a subscription, which is the whole reason the browser is never allowed to
 * grant one either.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });

  let apiKey;
  try { ({ apiKey } = cregisConfig()); } catch { return json(response, 503, { error: "Not configured." }); }

  const payload = request.body && typeof request.body === "object" ? request.body : null;
  if (!payload) return json(response, 400, { error: "Bad payload." });

  const received = typeof payload.sign === "string" ? payload.sign.toLowerCase() : "";
  if (!received || !signaturesMatch(cregisSign(payload, apiKey), received)) {
    // Deliberately terse. An unsigned caller learns nothing about why.
    console.error("[cregis-webhook] signature check failed");
    return json(response, 400, { error: "Bad signature." });
  }

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Not configured." }); }

  const { status, orderId, cregisOrderId, paidAmount } = unwrapCallbackOrder(payload);
  if (!orderId) {
    console.error("[cregis-webhook] callback carried no order id");
    return json(response, 200, { ignored: "no order id" });
  }

  const { data: order } = await db
    .from("crypto_orders")
    .select("id, user_id, status, grants_days, amount, currency, cregis_order_id")
    .eq("id", orderId)
    .maybeSingle();

  /*
   * A signed callback for an order we do not have is not a retryable error.
   *
   * It is a real thing that happens — a test order from the Cregis dashboard, an order
   * created against a different deployment. Asking Cregis to redeliver it for days will not
   * conjure the row. Logged loudly and accepted.
   */
  if (!order) {
    console.error("[cregis-webhook] no order for", orderId);
    return json(response, 200, { ignored: "unknown order" });
  }

  /*
   * Already paid: say yes and change nothing.
   *
   * Cregis retries, and a retry must not extend somebody's access a second time. The order
   * row is the idempotency record — checking it here is what makes a redelivery boring.
   */
  if (order.status === "paid") return json(response, 200, { ok: true, already: true });

  const now = new Date().toISOString();

  if (isUnderpaid(status)) {
    /*
     * They sent too little. Not access, and not a failure either — somebody is out of
     * pocket and a person has to decide what to do. It gets its own state so it shows up in
     * the admin rather than dying in a log.
     */
    await db.from("crypto_orders").update({
      status: "underpaid", paid_amount: paidAmount == null ? null : String(paidAmount),
      callback: payload, updated_at: now,
    }).eq("id", order.id);
    return json(response, 200, { ok: true, status: "underpaid" });
  }

  if (!isPaidStatus(status)) {
    // Still pending, or cancelled. Record what was said and wait for the one that matters.
    await db.from("crypto_orders").update({ callback: payload, updated_at: now }).eq("id", order.id);
    return json(response, 200, { ok: true, status: status || "pending" });
  }

  // ---- Paid. ----

  const { data: sub } = await db
    .from("subscriptions").select("current_period_end").eq("user_id", order.user_id).maybeSingle();

  /*
   * Days go ON TOP of whatever is left, not instead of it — the same rule as a redemption
   * code, and the same function, so the two can never drift apart. Taking time off somebody
   * for paying early is a bug they would be right to complain about.
   */
  const endsAt = periodEndAfterRedeeming(sub?.current_period_end, order.grants_days);

  /*
   * Mark the order paid FIRST, and only if it is still unpaid.
   *
   * `.eq("status", ...)` makes this a conditional write, so two deliveries racing each other
   * — which is exactly what a retry is — leave only one winner. Granting access first and
   * marking the order after would hand out two months for one payment in that race.
   */
  const { data: claimed, error: claimError } = await db
    .from("crypto_orders")
    .update({
      status: "paid", paid_at: now, callback: payload,
      paid_amount: paidAmount == null ? null : String(paidAmount),
      cregis_order_id: order.cregis_order_id ?? cregisOrderId ?? null,
      updated_at: now,
    })
    .eq("id", order.id)
    .neq("status", "paid")
    .select("id");

  if (claimError) {
    // A 500 here IS what we want: Cregis retries, and a write we could not make is exactly
    // the case worth retrying.
    console.error("[cregis-webhook] could not mark the order paid:", claimError.message);
    return json(response, 500, { error: "Could not record that." });
  }
  if (!claimed || claimed.length === 0) return json(response, 200, { ok: true, already: true });

  const { error: grantError } = await db.from("subscriptions").upsert({
    user_id: order.user_id,
    status: "active",
    provider: "cregis",
    current_period_end: endsAt.toISOString(),
    cancel_at_period_end: false,
    updated_at: now,
  }, { onConflict: "user_id" });

  if (grantError) {
    /*
     * Put the order back so the retry can try again. Leaving it 'paid' with no access is
     * the one outcome with no way out: the money is taken, the door is shut, and every
     * redelivery short-circuits on the already-paid check above.
     */
    console.error("[cregis-webhook] grant failed, releasing the order:", grantError.message);
    await db.from("crypto_orders").update({ status: "pending", paid_at: null, updated_at: now }).eq("id", order.id);
    return json(response, 500, { error: "Could not grant access." });
  }

  const { data: who } = await db.auth.admin.getUserById(order.user_id);
  const to = who?.user?.email;
  if (to) {
    // Keyed on the order, so a redelivery cannot send a second receipt.
    await sendOnce(db, {
      userId: order.user_id, to, kind: "subscribed", ref: `cregis:${order.id}`,
      data: { endsAt: endsAt.toISOString(), url: `${(process.env.SITE_URL || "").replace(/\/+$/, "")}/` },
    }).catch(() => {});
  }

  return json(response, 200, { ok: true, status: "paid" });
}
