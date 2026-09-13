import { accessState } from "../../src/lib/access.js";
import { emailConfigured, sendOnce } from "../_email.js";
import { json, serviceClient } from "../_supabase.js";

/*
 * The daily round: trials about to end, and trials that just did.
 *
 * Run by Vercel Cron (see vercel.json). Cron requests carry a secret Vercel sets, checked
 * below — this endpoint grants nothing, but an open URL that emails every customer is a
 * button anybody on the internet could press.
 */
const REMIND_AT = [3, 1];

export default async function handler(request, response) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const given = (request.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (given !== secret) return json(response, 401, { error: "Not allowed." });
  }

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }
  if (!emailConfigured()) return json(response, 200, { skipped: "email not configured" });

  const now = new Date();
  const horizon = new Date(now.getTime() + 4 * 86400000);

  /*
   * Only trials, and only ones with an end date. An open-ended grant has nothing to remind
   * anybody about, and a paid subscription that renews is Stripe's business, not ours.
   */
  const { data: subs, error } = await db
    .from("subscriptions")
    .select("user_id, status, current_period_end, trial_started_at")
    .eq("status", "trialing")
    .not("current_period_end", "is", null)
    .lt("current_period_end", horizon.toISOString());
  if (error) return json(response, 500, { error: "Could not read subscriptions." });

  const site = (process.env.SITE_URL || "https://nexus-funds.vercel.app").replace(/\/+$/, "");
  const { data: usageRows } = await db.rpc("admin_usage");
  const imported = new Set((usageRows ?? []).filter((r) => Number(r.fills) > 0).map((r) => r.user_id));

  let ending = 0, ended = 0;
  for (const sub of subs ?? []) {
    const { data: userData } = await db.auth.admin.getUserById(sub.user_id);
    const to = userData?.user?.email;
    if (!to) continue;

    const endsAt = new Date(sub.current_period_end);
    const state = accessState(sub, now);

    if (state === "trial_over") {
      /*
       * Note the status is NOT changed here. A trial that has run out is already refused by
       * the access check on its date, and rewriting rows in a mailing job is how a mailing
       * job ends up deciding who has access.
       */
      const r = await sendOnce(db, {
        userId: sub.user_id, to, kind: "trial_ended",
        ref: sub.current_period_end,
        data: { url: `${site}/` },
      });
      if (r.ok && !r.alreadySent) ended += 1;
      continue;
    }

    // Whole days, rounded up: with 26 hours left you have "2 days", which is what a person
    // would say and what their calendar agrees with.
    const daysLeft = Math.ceil((endsAt.getTime() - now.getTime()) / 86400000);
    if (!REMIND_AT.includes(daysLeft)) continue;

    const r = await sendOnce(db, {
      userId: sub.user_id, to, kind: `trial_ending_${daysLeft}`,
      ref: sub.current_period_end,
      data: { daysLeft, endsAt, url: `${site}/`, imported: imported.has(sub.user_id) },
    });
    if (r.ok && !r.alreadySent) ending += 1;
  }

  return json(response, 200, { ok: true, checked: subs?.length ?? 0, ending, ended });
}
