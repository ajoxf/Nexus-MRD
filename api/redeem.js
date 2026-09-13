import { codeRefusal, CODE_REFUSAL_COPY, looksLikeCode, normaliseCode, periodEndAfterRedeeming } from "../src/lib/codes.js";
import { callerFrom, json, serviceClient } from "./_supabase.js";

/*
 * Redeem an access code.
 *
 * The codes table has no row level security policy at all, so a customer cannot read it —
 * which matters more here than anywhere else, since a customer who could SELECT from it
 * would read every unredeemed code on the desk. This endpoint is handed ONE code and
 * answers yes or no. It never hands the list back, and it never says anything about a code
 * beyond whether this person may use it.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Codes are not available right now. This is on us." }); }

  const user = await callerFrom(request, db);
  if (!user) return json(response, 401, { error: "Sign in first." });

  const body = request.body && typeof request.body === "object" ? request.body : {};
  const code = normaliseCode(body.code);
  if (!looksLikeCode(code)) return json(response, 400, { error: CODE_REFUSAL_COPY.bad_shape });

  const { data: row, error: readError } = await db
    .from("redemption_codes")
    .select("code, grants_days, expires_at, redeemed_at")
    .eq("code", code)
    .maybeSingle();
  if (readError) return json(response, 500, { error: "Could not check that code." });

  const refusal = codeRefusal(row);
  if (refusal) return json(response, 400, { error: CODE_REFUSAL_COPY[refusal] });

  const { data: sub } = await db
    .from("subscriptions").select("current_period_end").eq("user_id", user.id).maybeSingle();
  const endsAt = periodEndAfterRedeeming(sub?.current_period_end, row.grants_days);

  /*
   * Claim the code FIRST, and only if it is still unclaimed.
   *
   * `.is("redeemed_at", null)` makes this a conditional write: two people racing the same
   * code — the same person double-clicking is the common case — and exactly one update
   * matches. Granting access first and marking the code after would hand out two
   * subscriptions for one code in that race, and the loser of it would never know.
   */
  const { data: claimed, error: claimError } = await db
    .from("redemption_codes")
    .update({
      redeemed_at: new Date().toISOString(),
      redeemed_by: user.id,
      redeemed_email: user.email ?? null,
    })
    .eq("code", code)
    .is("redeemed_at", null)
    .select("code");
  if (claimError) return json(response, 500, { error: "Could not use that code." });
  if (!claimed || claimed.length === 0) return json(response, 400, { error: CODE_REFUSAL_COPY.already_redeemed });

  const { error: grantError } = await db.from("subscriptions").upsert(
    {
      user_id: user.id,
      status: "active",
      current_period_end: endsAt.toISOString(),
      cancel_at_period_end: false,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  /*
   * If the grant fails after the code is claimed, give the code back rather than leaving
   * somebody holding a used code and no access. Worst case the code is briefly unusable;
   * the alternative is a customer who paid and has nothing.
   */
  if (grantError) {
    await db.from("redemption_codes")
      .update({ redeemed_at: null, redeemed_by: null, redeemed_email: null })
      .eq("code", code);
    return json(response, 500, { error: "Could not apply that code. Please try again." });
  }

  return json(response, 200, { ok: true, days: row.grants_days, endsAt: endsAt.toISOString() });
}
