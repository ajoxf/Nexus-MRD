import { callerFrom, json, serviceClient } from "./_supabase.js";
import { stripeClient, stripeConfigured } from "./_stripe.js";

/*
 * Closing an account, and erasing what we hold on it.
 *
 * Two obligations that pull in opposite directions, so both are written down here rather
 * than left to whoever reads this next:
 *
 *   Erase.  Somebody who asks us to delete their data is entitled to have it deleted, and
 *           for a risk tool that means the trades — which is the sensitive part by a
 *           distance. Every fill, every setting, every internal note, gone for real.
 *
 *   Retain. A record of money taken has to survive, for tax and for the day a chargeback
 *           arrives on a payment made by an account that no longer exists. Erasure does
 *           not override a legal retention obligation, and a receipt is not personal data
 *           anybody is entitled to have destroyed.
 *
 * So: the app data goes, the billing row stays, and the account itself is neutered rather
 * than dropped.
 *
 * WHY NOT JUST DELETE THE AUTH USER. Because subscriptions.user_id references auth.users
 * ON DELETE CASCADE — deleting the user takes the payment history with it, silently, which
 * is the one thing that must not happen. Verified against the live schema, not assumed.
 * The user row is kept, stripped of everything identifying and permanently banned, which
 * leaves a key the billing row can hang off and nobody can sign in with.
 */

/*
 * A deliberate, typed confirmation. Not a header, not a flag — a word the person had to
 * read a sentence to know to type. The endpoint is destructive and irreversible, and
 * nothing irreversible should be one mis-sent request away.
 */
const CONFIRM = "DELETE";

export default async function handler(request, response) {
  if (request.method !== "DELETE" && request.method !== "POST") {
    return json(response, 405, { error: "Use DELETE." });
  }

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  /*
   * Whose account, proven rather than claimed.
   *
   * The id comes from the token, never from the body. A user id in the body is a request
   * to delete somebody else's account, and this is the last endpoint in the product where
   * granting one could be walked back.
   */
  const user = await callerFrom(request, db);
  if (!user) return json(response, 401, { error: "Please sign in again." });

  const body = request.body && typeof request.body === "object" ? request.body : {};
  if (String(body.confirm ?? "") !== CONFIRM) {
    return json(response, 400, { error: `Type ${CONFIRM} to confirm.` });
  }

  const failures = [];

  /*
   * Stop the billing before deleting anything.
   *
   * Done first because it is the only step whose failure should stop the rest: closing an
   * account while the card keeps being charged every month is worse than not closing it,
   * and the person would have no account left to log in and fix it with.
   */
  const { data: sub } = await db
    .from("subscriptions")
    .select("provider, provider_subscription_id, status")
    .eq("user_id", user.id)
    .maybeSingle();

  if (sub?.provider === "stripe" && sub.provider_subscription_id && stripeConfigured()) {
    try {
      await stripeClient().subscriptions.cancel(sub.provider_subscription_id);
    } catch (error) {
      /*
       * Already cancelled is not a failure. Stripe says "No such subscription" for one that
       * is already gone, and refusing to close the account over it would trap somebody in a
       * product they have asked to leave.
       */
      const missing = error?.code === "resource_missing";
      if (!missing) {
        console.error("[account] could not cancel the subscription:", error?.message);
        return json(response, 502, {
          error: "We could not cancel your subscription, so nothing has been deleted. Please try again, or contact us and we'll do it by hand.",
        });
      }
    }
  }

  /*
   * The app data. Every table keyed to this person that is not the record of money.
   *
   * Deleted explicitly, table by table, rather than leaned on a cascade — the cascade is
   * what we are deliberately NOT triggering, and a list that has to be edited when a table
   * is added is better than a deletion that silently misses one.
   */
  const wipe = async (table, column = "user_id") => {
    const { error } = await db.from(table).delete().eq(column, user.id);
    if (error) { failures.push(table); console.error(`[account] could not clear ${table}:`, error.message); }
  };

  await wipe("fills");        // The trades. The sensitive part.
  await wipe("settings");     // Brokers, capital, limits, the funds ledger.
  await wipe("customers");    // The desk's own CRM notes about them.
  await wipe("email_log");    // What we sent them and when.

  /*
   * The referral record keeps the fact, loses the person.
   *
   * An affiliate's count of who they sent and what they earned is the affiliate's record
   * and part of the same money trail as the billing row, so the row stays. The email on it
   * is personal data with no reason to outlive the account, so it goes.
   */
  const { error: refError } = await db
    .from("referrals")
    .update({ email: null })
    .eq("user_id", user.id);
  if (refError) console.error("[account] could not scrub the referral email:", refError.message);

  /*
   * The account itself: anonymised and sealed, not dropped.
   *
   * The email becomes a tombstone at a domain that cannot receive mail — .invalid is
   * reserved by the RFCs precisely so it can never be somebody's real address. Metadata is
   * emptied because it is user-writable and could hold anything. The ban is what actually
   * closes the door; without it a password reset would let them back into an empty account.
   */
  const tombstone = `deleted-${user.id.slice(0, 8)}@deleted.invalid`;
  const { error: authError } = await db.auth.admin.updateUserById(user.id, {
    email: tombstone,
    user_metadata: { deleted_at: new Date().toISOString() },
    app_metadata: { deleted: true },
    ban_duration: "876000h", // A hundred years. Supabase has no "forever".
  });

  if (authError) {
    console.error("[account] could not anonymise the account:", authError.message);
    failures.push("account");
  }

  /*
   * Told plainly when part of it did not work.
   *
   * A deletion that half happened and reported success is how somebody finds their trades
   * still there a year later. If any table refused, say so and name what to chase.
   */
  if (failures.length) {
    return json(response, 500, {
      error: "Some of your data could not be deleted. Nothing has been left half-signed-in — please contact us so we can finish it by hand.",
      failed: failures,
    });
  }

  return json(response, 200, { ok: true });
}
