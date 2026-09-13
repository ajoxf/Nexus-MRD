import { canAttribute, periodRef, rewardFor } from "../src/lib/affiliates.js";

/*
 * Turning a payment into a commission.
 *
 * Lives beside the webhook rather than inside it because the webhook's job is already
 * stated — write down what Stripe said about money — and this is a second job that must
 * not be able to fail the first. Every path here returns quietly: a commission that could
 * not be worked out is a thing to look into on Monday, not a reason to make Stripe redeliver
 * a subscription update for three days.
 *
 * The arithmetic itself is not here. It is in src/lib/affiliates.js, which runs on plain
 * Node with no database and no Stripe key, and is checked there against 41 worked examples.
 */

/** Postgres' "you already have one of those". The unique index doing its job, not a fault. */
const DUPLICATE = "23505";

/**
 * Credit the affiliate who sent this customer, if one did and if anything is owed.
 *
 * Only ever called for a payment that actually succeeded. A subscription going active
 * because somebody redeemed a code is not a payment, and paying commission on it would be
 * paying a share of nothing.
 */
export async function creditReferral(db, { userId, invoice, subscription, buyerEmail }) {
  try {
    /*
     * Who sent them, decided once and never revisited.
     *
     * One row per account — the partial unique index on referrals guarantees it — so this
     * cannot quietly pick the more recent of two claims. First touch won at signup; by the
     * time money moves the question is already settled.
     */
    const { data: referral } = await db
      .from("referrals")
      .select("id, affiliate_code, status")
      .eq("user_id", userId)
      .maybeSingle();
    if (!referral) return { credited: false, reason: "no_referral" };

    const { data: affiliate } = await db
      .from("affiliates")
      .select("code, name, email, status, reward_kind, reward_value, reward_scope")
      .eq("code", referral.affiliate_code)
      .maybeSingle();
    if (!affiliate) return { credited: false, reason: "no_affiliate" };

    /*
     * Mark the conversion even when nothing is earned.
     *
     * A paused affiliate still gets the record that they sent somebody who paid — that is
     * the trail that settles the dispute the pause exists for. What pausing stops is the
     * money, and rewardFor below is what stops it.
     */
    if (referral.status !== "converted" && canAttribute(affiliate)) {
      await db
        .from("referrals")
        .update({ status: "converted", converted_at: new Date().toISOString() })
        .eq("id", referral.id);
    }

    /*
     * What the customer actually paid, as Stripe reports it.
     *
     * amount_paid, not amount_due and not the price on the plan: a discounted invoice and a
     * partially credited one both settle for less than the list price, and commission on
     * money that never arrived comes out of the desk's own pocket.
     */
    const basisMinor = Number(invoice?.amount_paid);
    const currency = typeof invoice?.currency === "string" ? invoice.currency.toUpperCase() : null;

    /*
     * Stripe's own word for "this is the first invoice of this subscription". Counting
     * invoices ourselves would call a re-subscription after a cancellation a first payment
     * and pay the finder's fee twice for one customer.
     */
    const isFirstPayment = invoice?.billing_reason === "subscription_create";

    const reward = rewardFor(affiliate, {
      referralStatus: "converted",
      buyerEmail,
      isFirstPayment,
      basisMinor,
      currency,
    });
    if (!reward) return { credited: false, reason: "nothing_owed" };

    /*
     * The period this reward is FOR, which is what a Stripe retry collides with.
     *
     * Stripe redelivers on its own schedule and an hour-old duplicate looks exactly like a
     * second month. The unique index on (affiliate_code, user_id, period_ref) refuses the
     * second insert; we claim by inserting and treat that refusal as success, the same way
     * the email log stops a daily job sending twice.
     */
    const periodEndUnix = Number.isFinite(subscription?.current_period_end)
      ? subscription.current_period_end
      : Number(invoice?.lines?.data?.[0]?.period?.end);

    const periodEnd = Number.isFinite(periodEndUnix) ? new Date(periodEndUnix * 1000).toISOString() : null;

    let period_ref = periodRef(affiliate, { periodEnd });

    /*
     * A recurring reward must never fall back to the word 'first'.
     *
     * periodRef says 'first' when it has no period end to key on, which is right for a
     * first-payment deal and quietly wrong for a recurring one: every month would claim the
     * same key, the unique index would refuse all but month one, and the affiliate would
     * simply stop being paid with nothing anywhere reporting a fault. Stripe's invoice id
     * is the safer key — distinct per month, identical across redeliveries of the same
     * invoice, which is exactly the two properties this needs.
     */
    if (affiliate.reward_scope === "recurring" && period_ref === "first" && invoice?.id) {
      period_ref = `invoice:${invoice.id}`;
    }

    const { error } = await db.from("affiliate_rewards").insert({
      affiliate_code: affiliate.code,
      referral_id: referral.id,
      user_id: userId,
      // Copied in, not joined to. A rate changed in March must not rewrite January.
      kind: reward.kind,
      rate: reward.rate,
      basis_minor: reward.basis_minor,
      amount_minor: reward.amount_minor,
      currency: reward.currency,
      period_ref,
    });

    if (error) {
      if (error.code === DUPLICATE) return { credited: false, reason: "already_credited" };
      console.error("[affiliates] could not record a reward:", error.message);
      return { credited: false, reason: "write_failed" };
    }

    return { credited: true, amount_minor: reward.amount_minor, code: affiliate.code };
  } catch (error) {
    // Never the webhook's problem. See the note at the top.
    console.error("[affiliates] credit failed:", error?.message);
    return { credited: false, reason: "threw" };
  }
}
