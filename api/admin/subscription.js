import { adminFrom, json, serviceClient } from "../_supabase.js";

const STATUSES = ["none", "trialing", "active", "past_due", "canceled"];

/*
 * Set what an account holds, by hand.
 *
 * The escape hatch every subscription business needs: a comp, a goodwill extension, a
 * customer whose card failed while they were on a plane. Stripe will write most rows from
 * now on; this is for the ones a person has to decide.
 *
 * `trial_started_at` is never cleared here, only ever set. Undoing it has to be deliberate
 * enough to require the SQL editor, because "clear the trial flag" is one careless click
 * from an unlimited free product.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const admin = await adminFrom(request, db);
  if (!admin) return json(response, 403, { error: "Not allowed." });

  const body = request.body && typeof request.body === "object" ? request.body : {};
  const userId = typeof body.userId === "string" ? body.userId : "";
  const status = typeof body.status === "string" ? body.status : "";
  if (!userId || !STATUSES.includes(status)) {
    return json(response, 400, { error: "Say which account, and one of: " + STATUSES.join(", ") });
  }

  /*
   * An empty end date means open-ended — a comp that does not lapse — and that is a real
   * choice an operator makes rather than a field they forgot to fill in. It is recorded as
   * null, and every reader of this column has to treat null as "does not expire".
   */
  let endsAt = null;
  if (body.currentPeriodEnd) {
    const parsed = new Date(body.currentPeriodEnd);
    if (Number.isNaN(parsed.getTime())) return json(response, 400, { error: "That end date is not a date." });
    endsAt = parsed.toISOString();
  }

  const { data: existing } = await db
    .from("subscriptions").select("trial_started_at").eq("user_id", userId).maybeSingle();

  const { error } = await db.from("subscriptions").upsert(
    {
      user_id: userId,
      status,
      current_period_end: endsAt,
      trial_started_at: existing?.trial_started_at ?? (status === "trialing" ? new Date().toISOString() : null),
      cancel_at_period_end: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) return json(response, 500, { error: "Could not save that." });

  return json(response, 200, { ok: true });
}
