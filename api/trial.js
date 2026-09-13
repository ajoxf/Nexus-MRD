import { canStartTrial } from "../src/lib/access.js";
import { callerFrom, json, serviceClient } from "./_supabase.js";

/** How long a Nexus trial runs. One place, so the row and the copy cannot disagree. */
export const TRIAL_DAYS = 14;

/*
 * Start a free trial.
 *
 * The browser cannot write the subscription row — there is no insert or update policy for
 * signed-in users, so Postgres refuses it however the client is edited. This endpoint is
 * the only way one gets written, which means every rule about who may have a trial is
 * enforced in exactly one place that a customer cannot reach.
 *
 * Nothing is taken from the request body. Who you are comes from your access token, and
 * what you get is fixed here — so there is no length, no end date and no user id for a
 * caller to supply, and therefore none to tamper with.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });

  let db;
  try {
    db = serviceClient();
  } catch {
    // Configuration, not the customer. Say so rather than implying they did something wrong.
    return json(response, 503, { error: "Trials are not available right now. This is on us." });
  }

  const user = await callerFrom(request, db);
  if (!user) return json(response, 401, { error: "Sign in first." });

  const result = await grantTrial(db, user.id);
  return json(response, result.status, result.body);
}

/**
 * The decision and the write, with the database handed in.
 *
 * Split from the handler so it can be tested against a stub instead of against a live
 * project — the rules about who may have a trial are the part worth testing, and they
 * should not need a network to prove.
 */
export async function grantTrial(db, userId, now = new Date()) {
  const { data: existing, error: readError } = await db
    .from("subscriptions")
    .select("status, current_period_end, trial_started_at")
    .eq("user_id", userId)
    .maybeSingle();
  if (readError) return { status: 500, body: { error: "Could not check your account." } };

  /*
   * Read before writing, so a refusal cannot leave half a trial behind — and judged on
   * whether a trial was EVER started, not on whether one is running. An expired trial still
   * counts, or the same account renews a free fortnight every month by waiting.
   */
  if (!canStartTrial(existing)) {
    return {
      status: 409,
      body: {
        error: existing?.trial_started_at
          ? "This account has already had a trial. Get in touch and we will sort you out."
          : "This account already has a subscription.",
      },
    };
  }

  const endsAt = new Date(now.getTime() + TRIAL_DAYS * 86400000);

  const { error: writeError } = await db.from("subscriptions").upsert(
    {
      user_id: userId,
      status: "trialing",
      current_period_end: endsAt.toISOString(),
      trial_started_at: now.toISOString(),
      cancel_at_period_end: false,
      updated_at: now.toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (writeError) return { status: 500, body: { error: "Could not start your trial." } };

  return { status: 200, body: { ok: true, days: TRIAL_DAYS, endsAt: endsAt.toISOString() } };
}
