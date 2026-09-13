import { canAttribute, looksLikeRef, normaliseRef, refStillValid } from "../src/lib/affiliates.js";
import { callerFrom, json, serviceClient } from "./_supabase.js";

/*
 * Where a referral link lands, and where it is claimed.
 *
 * Two jobs, one endpoint, told apart by whether the caller is signed in:
 *
 *   no token  — somebody opened a link. Record the visit, say whether the code is real.
 *   token     — that somebody now has an account. Attach it, permanently.
 *
 * Public by necessity: the first half happens before anybody has signed in, so there is
 * nobody to authenticate. That is safe because of what it cannot do. It cannot read an
 * affiliate's email or terms, it cannot say what anybody has earned, and it cannot move
 * money. Guessing a code gains you nothing — the worst outcome is that somebody else gets
 * credited for a signup, which is why the affiliate tables are unreadable from the browser
 * and every rate lives behind the admin check instead.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const body = request.body && typeof request.body === "object" ? request.body : {};
  const code = normaliseRef(body.code);

  /*
   * A malformed code is not an error worth a red box.
   *
   * Links get truncated by email clients and mangled by chat apps. The person who clicked
   * did nothing wrong and is about to sign up anyway; they should see the product, not a
   * complaint about a query string.
   */
  if (!looksLikeRef(code)) return json(response, 200, { known: false });

  const { data: affiliate, error } = await db
    .from("affiliates")
    .select("code, name, status")
    .eq("code", code)
    .maybeSingle();

  if (error) {
    console.error("[ref] could not read the affiliate:", error.message);
    return json(response, 200, { known: false });
  }
  // Unknown and closed are the same answer from out here: this link credits nobody.
  if (!affiliate || !canAttribute(affiliate)) return json(response, 200, { known: false });

  const caller = await callerFrom(request, db);

  // ---- Half one: a visit, by somebody with no account yet. ----
  if (!caller) {
    const { error: visitError } = await db
      .from("referrals")
      .insert({ affiliate_code: affiliate.code, status: "visited" });
    if (visitError) console.error("[ref] could not record a visit:", visitError.message);
    // The name, because "Referred by Cameron" is worth showing. Never the email or terms.
    return json(response, 200, { known: true, name: affiliate.name });
  }

  // ---- Half two: the claim. ----

  /*
   * The window is measured from the click, not from now.
   *
   * The browser tells us when it captured the code, and a click older than the window has
   * expired however recently the account was made. Trusting the browser's clock here is
   * deliberate and bounded: the worst a tampered timestamp does is credit an affiliate for
   * a sale slightly outside the window, and the alternative — recording nothing until
   * signup — loses the click entirely for everybody who takes a week to decide.
   */
  if (body.capturedAt && !refStillValid(body.capturedAt)) {
    return json(response, 200, { known: true, claimed: false, reason: "expired" });
  }

  /*
   * First touch wins, and it wins here rather than in a policy.
   *
   * If this account already belongs to an affiliate, that is the end of it: a second link
   * clicked later cannot take a customer off the person who actually found them. The
   * partial unique index on referrals enforces the same rule underneath, so two requests
   * racing each other end the same way as two arriving in order.
   */
  const { data: existing } = await db
    .from("referrals")
    .select("id, affiliate_code")
    .eq("user_id", caller.id)
    .maybeSingle();

  if (existing) {
    return json(response, 200, {
      known: true,
      claimed: existing.affiliate_code === affiliate.code,
      reason: "already_attributed",
    });
  }

  const { error: claimError } = await db.from("referrals").insert({
    affiliate_code: affiliate.code,
    status: "signed_up",
    user_id: caller.id,
    email: caller.email ?? null,
    signed_up_at: new Date().toISOString(),
  });

  if (claimError) {
    // The index refusing a racing duplicate is the rule working, not a failure.
    if (claimError.code === "23505") return json(response, 200, { known: true, claimed: false, reason: "already_attributed" });
    console.error("[ref] could not claim a referral:", claimError.message);
    return json(response, 500, { error: "Could not record that." });
  }

  return json(response, 200, { known: true, claimed: true, name: affiliate.name });
}
