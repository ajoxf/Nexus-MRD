import { buildEmail } from "../src/lib/emails.js";

/*
 * Sending, via Resend.
 *
 * Deliberately never throws at a caller. Every send here happens alongside something that
 * matters more — granting a trial, recording a payment — and an email provider having a bad
 * afternoon must not fail the grant. A customer with access and no welcome email has a
 * minor annoyance; a customer with an email and no access has a support ticket.
 */
const FROM = process.env.NEXUS_EMAIL_FROM || "Nexus RAMP <nexus@fincoursa.com>";
const REPLY_TO = process.env.NEXUS_EMAIL_REPLY_TO || "team@fincoursa.com";

export const emailConfigured = () => Boolean(process.env.RESEND_API_KEY);

async function send(to, { subject, html }) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return { ok: false, skipped: true };
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: FROM, to: [to], reply_to: REPLY_TO, subject, html }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.error("[email] refused", response.status, detail.slice(0, 300));
      return { ok: false };
    }
    return { ok: true };
  } catch (error) {
    console.error("[email]", error?.message);
    return { ok: false };
  }
}

/**
 * Send one, at most once per thing it is about.
 *
 * The log row is written FIRST, and only if it does not exist. Two jobs racing the same
 * reminder — an overlapping cron, a retry — and exactly one insert succeeds, so exactly one
 * email goes out. Sending first and recording after is how somebody gets the same message
 * three times, and they only have to receive it twice to stop reading them.
 *
 * `ref` is what the email is ABOUT, not when it was sent: a trial's end date, an invoice.
 * Keyed on the date instead, a second trial a year later would be silently skipped.
 */
export async function sendOnce(db, { userId, to, kind, ref = "", data }) {
  const message = buildEmail(kind, data);
  if (!message) {
    console.error("[email] unknown kind", kind);
    return { ok: false };
  }

  const { error } = await db.from("email_log").insert({ user_id: userId, kind, ref });
  if (error) {
    // A duplicate key here is the normal, expected outcome: it means this one already went.
    if (error.code === "23505") return { ok: true, alreadySent: true };
    console.error("[email] could not claim", kind, error.message);
    return { ok: false };
  }

  const result = await send(to, message);
  /*
   * Give the claim back if the send failed, so tomorrow's run tries again. The alternative
   * is a log row saying we told somebody their trial was ending when we did not.
   */
  if (!result.ok && !result.skipped) {
    await db.from("email_log").delete().eq("user_id", userId).eq("kind", kind).eq("ref", ref);
  }
  return result;
}

/** For mail with no account behind it — a code sent to somebody who has not signed up. */
export async function sendTo(to, kind, data) {
  const message = buildEmail(kind, data);
  if (!message) return { ok: false };
  return send(to, message);
}
