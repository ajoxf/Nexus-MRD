import { createHash } from "node:crypto";

/*
 * Cregis crypto checkout: the protocol, and the client that speaks it.
 *
 * Ported from a working integration rather than written from the docs, so the hard-won
 * parts come with it. Each of the notes below is a bug that was silent until real money
 * was involved.
 *
 * WHAT ACTUALLY GRANTS ACCESS. The signed server-to-server callback, and nothing else. The
 * browser is sent to a success page, but that page cannot give anybody a subscription — it
 * is a screen, not an authority. Same rule as the Stripe webhook next door.
 */

/** Minutes a checkout stays payable. Cregis accepts 10-1440. */
export const CHECKOUT_VALID_MINUTES = 60;

/**
 * The Cregis signature.
 *
 * MD5 over the API key followed by every non-empty parameter — `sign` itself excluded — as
 * `keyvalue`, keys in ascending ASCII order. Objects are JSON, everything else is String().
 *
 * Getting this wrong is not subtle in one direction and invisible in the other: Cregis
 * rejects our outbound call loudly, but a verification we compute differently would reject
 * REAL callbacks quietly, and a paying customer would simply never be let in.
 */
export function cregisSign(params, apiKey) {
  const joined = Object.keys(params)
    .filter((k) => k !== "sign")
    .filter((k) => params[k] !== undefined && params[k] !== null && params[k] !== "")
    .sort()
    .map((k) => {
      const v = params[k];
      return `${k}${typeof v === "object" ? JSON.stringify(v) : String(v)}`;
    })
    .join("");
  return createHash("md5").update(`${apiKey}${joined}`, "utf8").digest("hex");
}

/**
 * Compare two signatures without leaking where they differ.
 *
 * A plain === returns as soon as two characters differ, and the time that takes is
 * measurable. On the one endpoint that hands out paid access, that is worth avoiding even
 * though the attack is impractical over the internet.
 */
export function signaturesMatch(expected, received) {
  if (typeof received !== "string" || expected.length !== received.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i += 1) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}

/**
 * Six random characters. NOT a timestamp.
 *
 * Cregis requires a 6-character nonce and rejects a 13-digit epoch outright — a mistake
 * that fails every checkout with an error that does not mention the nonce.
 */
export function cregisNonce(rand = Math.random) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 6; i += 1) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}

/**
 * Pull the order out of a callback.
 *
 * Cregis nests the order under `data` and keeps pid/nonce/timestamp/sign on the envelope.
 * Reading order_id off the envelope finds nothing, so no order ever matches, so a buyer who
 * paid is never let in — and nothing in the logs looks wrong. The flat read stays as a
 * fallback in case a future payload is envelope-shaped.
 */
export function unwrapCallbackOrder(payload) {
  const data = payload?.data && typeof payload.data === "object" ? payload.data : (payload ?? {});
  return {
    status: String(data.status ?? data.order_status ?? payload?.status ?? "").toLowerCase(),
    orderId: String(data.order_id ?? payload?.order_id ?? ""),
    cregisOrderId: String(data.cregis_id ?? data.trade_id ?? payload?.cregis_id ?? data.order_id ?? ""),
    paidAmount: data.paid_amount ?? data.actual_amount ?? null,
    currency: data.order_currency ?? data.currency ?? null,
  };
}

/*
 * `paid_over` is an OVERPAYMENT — they sent too much. That is a refund conversation, never
 * a reason to withhold what somebody has paid for. `paid_partial` is an underpayment and is
 * deliberately absent: it must not open the door.
 */
const PAID = new Set(["paid", "paid_over", "success", "succeeded", "completed", "confirmed"]);
export const isPaidStatus = (s) => PAID.has(String(s ?? "").toLowerCase());
export const isUnderpaid = (s) => String(s ?? "").toLowerCase() === "paid_partial";

/** Present, absent — never the value. */
const env = (k) => (process.env[k] || "").trim();

export function cregisConfig() {
  const projectId = env("CREGIS_PROJECT_ID");
  const apiKey = env("CREGIS_API_KEY");
  const baseUrl = env("CREGIS_BASE_URL").replace(/\/+$/, "");
  if (!projectId || !apiKey || !baseUrl) throw new Error("Crypto payment is not configured.");
  return { projectId, apiKey, baseUrl };
}

export const cregisConfigured = () =>
  Boolean(env("CREGIS_PROJECT_ID") && env("CREGIS_API_KEY") && env("CREGIS_BASE_URL"));

/**
 * What a crypto payment buys, as a server setting.
 *
 * Amount and days live here and never in the request body, for the same reason
 * STRIPE_PRICE_ID does: a price sent from a browser is a request to be charged whatever the
 * caller fancies, and it would be granted.
 */
export function cryptoPlan() {
  const amount = env("CREGIS_PRICE_AMOUNT");
  const days = Math.round(Number(env("CREGIS_GRANT_DAYS")));
  return {
    amount,
    currency: env("CREGIS_PRICE_CURRENCY") || "USDT",
    days: Number.isFinite(days) && days > 0 ? days : 0,
    ok: Boolean(amount) && Number.isFinite(days) && days > 0,
  };
}

/** A stalled checkout is worse than a failed one: the buyer watches a spinner either way. */
const OUTBOUND_TIMEOUT_MS = 20000;

/**
 * Create a hosted checkout and return the URL to send the buyer to.
 *
 * OUTBOUND IP. Cregis allowlists the address that calls its API and will not turn that
 * check off. Vercel functions have no stable outbound address, so a direct call from here
 * is rejected with "E0001 — The IP is not added to the whitelist". CREGIS_RELAY_URL points
 * at a small relay on fixed-IP hosting whose address IS allowlisted; unset, the call goes
 * direct, which is right for a machine that is already allowlisted.
 */
export async function createCheckout({ orderId, email, amount, currency, siteUrl, remark }) {
  const { projectId, apiKey, baseUrl } = cregisConfig();

  const params = {
    pid: Number(projectId),
    nonce: cregisNonce(),
    timestamp: Date.now(),
    order_id: orderId,
    order_amount: amount,
    order_currency: currency,
    // Cregis caps payer_id at 32 characters and plenty of real addresses are longer. The
    // email travels in payer_email, which has no such limit.
    payer_id: orderId.slice(0, 32),
    payer_email: email,
    valid_time: CHECKOUT_VALID_MINUTES,
    remark: remark || "Nexus RAMP access",
    // The browser lands on success_url, but access is granted ONLY by the signed callback.
    success_url: `${siteUrl}/?paid=1`,
    cancel_url: `${siteUrl}/`,
    callback_url: `${siteUrl}/api/cregis-webhook`,
  };
  params.sign = cregisSign(params, apiKey);

  const relayUrl = env("CREGIS_RELAY_URL");
  const relaySecret = env("CREGIS_RELAY_SECRET");
  if (relayUrl && !relaySecret) {
    // Louder than sending an unauthenticated request the relay refuses with a 401 that
    // reads exactly like a Cregis credential problem.
    throw new Error("CREGIS_RELAY_URL is set but CREGIS_RELAY_SECRET is not. Set both or neither.");
  }

  let response;
  try {
    response = relayUrl
      ? await fetch(relayUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Relay-Secret": relaySecret, "X-Relay-Path": "/api/v2/checkout" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
        })
      : await fetch(`${baseUrl}/api/v2/checkout`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(OUTBOUND_TIMEOUT_MS),
        });
  } catch (error) {
    /*
     * Name the hop that failed. "Cregis is down" sends an operator to the Cregis dashboard
     * and their credentials; an unreachable relay is a different problem with a different
     * fix, and from the buyer's error message the two look identical.
     */
    throw new Error(relayUrl
      ? `The crypto payment relay could not be reached (${error?.message}). That is the relay, not Cregis — check it is up before touching any Cregis credential.`
      : `Cregis could not be reached (${error?.message}).`);
  }

  const raw = await response.json().catch(() => null);

  if (relayUrl && (!raw || response.status === 401 || response.status === 403)) {
    throw new Error(`The crypto payment relay returned HTTP ${response.status}${raw ? "" : " with a non-JSON body"}. That is the relay, not Cregis${response.status === 401 || response.status === 403 ? " — usually CREGIS_RELAY_SECRET not matching what the relay expects." : "."}`);
  }
  if (!response.ok || !raw) throw new Error(`Cregis checkout failed with HTTP ${response.status}.`);

  // Cregis signals success with code "00000" and wraps the payload in `data`.
  const code = String(raw.code ?? "");
  if (code && code !== "00000") throw new Error(`Cregis rejected the checkout (code ${code}): ${String(raw.msg ?? "")}`);

  const data = raw.data ?? raw;
  const checkoutUrl = String(data.checkout_url ?? data.payment_url ?? "");
  if (!checkoutUrl) throw new Error("Cregis did not return a checkout URL.");

  return { checkoutUrl, cregisOrderId: String(data.cregis_id ?? data.order_id ?? orderId) };
}
