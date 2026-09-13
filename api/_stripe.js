import Stripe from "stripe";

/*
 * The Stripe client. Server only — the secret key can charge cards.
 *
 * No VITE_ prefix, for the same reason as the Supabase service key: Vite embeds anything so
 * prefixed into the JavaScript it ships to browsers.
 */
export function stripeClient() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error("Stripe is not configured.");
  return new Stripe(key);
}

export const stripeConfigured = () =>
  Boolean(process.env.STRIPE_SECRET_KEY && process.env.STRIPE_PRICE_ID);

/**
 * Where Stripe sends people back to.
 *
 * Taken from the request rather than configured, so preview deployments return to
 * themselves instead of bouncing somebody from a preview into production mid-checkout.
 */
export function siteUrl(request) {
  const configured = process.env.SITE_URL;
  if (configured) return configured.replace(/\/+$/, "");
  const host = request.headers["x-forwarded-host"] || request.headers.host;
  const proto = request.headers["x-forwarded-proto"] || "https";
  return `${proto}://${host}`;
}

/**
 * The raw bytes of the request, unparsed.
 *
 * Stripe signs the exact body it sent. Vercel's Node runtime parses JSON for you, and a
 * parsed-then-restringified body differs from the original by a space or a key order — so
 * every signature check fails, on a route where a failed check is indistinguishable from an
 * attack. Hence `bodyParser: false` on the webhook and this reading the stream by hand.
 */
export async function rawBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}
