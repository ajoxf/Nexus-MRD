/*
 * What Nexus sends, and what it says.
 *
 * Pure: subject and body out, no network. An email with the wrong date on it is worse than
 * one that never arrives — the second is a bug, the first is a customer planning around a
 * lie — so the wording is decided somewhere it can be read and tested without a mail server.
 *
 * Supabase already sends two of these: confirm your address, and reset your password. Those
 * are GoTrue's and are not duplicated here; point Supabase at Resend by SMTP and they arrive
 * from the same place as everything below.
 */

const NAVY = "#12233B";
const INK = "#16202E";
const DIM = "#5B6778";
const LINE = "#DCE1E8";
const ACCENT = "#1F4E8C";
const PAPER = "#EEF1F5";

const esc = (v) =>
  String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export const formatDay = (value) =>
  new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });

/*
 * Tables and inline styles, not flexbox and a stylesheet.
 *
 * Outlook renders with Word's engine and Gmail strips <style> blocks. Everything here is
 * the boring 2005 construction because it is the one that arrives looking the same in all
 * of them, and a broken invoice email is a support ticket from somebody already annoyed.
 */
function shell({ heading, body, action, footnote }) {
  const button = action
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:26px 0 0"><tr>
         <td bgcolor="${ACCENT}" style="border-radius:6px">
           <a href="${esc(action.href)}" style="display:inline-block;padding:13px 26px;font-family:'IBM Plex Sans',Segoe UI,Helvetica,Arial,sans-serif;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none">${esc(action.label)}</a>
         </td></tr></table>`
    : "";
  const foot = footnote
    ? `<p style="margin:22px 0 0;font-size:13px;line-height:1.6;color:${DIM}">${footnote}</p>`
    : "";

  return `<!doctype html><html><body style="margin:0;padding:0;background:${PAPER}">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAPER};padding:28px 12px">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border:1px solid ${LINE};border-radius:10px">
      <tr><td style="padding:26px 30px 0">
        <table role="presentation" cellpadding="0" cellspacing="0"><tr>
          <td width="38" style="padding-right:11px">
            <table role="presentation" cellpadding="0" cellspacing="0" width="38" height="38" style="background:${NAVY};border-radius:8px">
              <tr><td align="center" style="font-family:'IBM Plex Sans',Segoe UI,Helvetica,Arial,sans-serif;font-size:20px;font-weight:700;color:#ffffff">N</td></tr>
            </table>
          </td>
          <td style="font-family:'IBM Plex Sans',Segoe UI,Helvetica,Arial,sans-serif">
            <div style="font-size:16px;font-weight:600;color:${NAVY}">Nexus <span style="font-size:11px;letter-spacing:.2em;color:${ACCENT}">RAMP</span></div>
            <div style="font-size:11px;color:${DIM}">Risk and Margin Platform</div>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:22px 30px 30px;font-family:'IBM Plex Sans',Segoe UI,Helvetica,Arial,sans-serif">
        <h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;font-weight:600;color:${INK}">${esc(heading)}</h1>
        ${body}
        ${button}
        ${foot}
      </td></tr>
    </table>
    <p style="max-width:560px;margin:16px auto 0;font-family:'IBM Plex Sans',Segoe UI,Helvetica,Arial,sans-serif;font-size:11px;line-height:1.6;color:${DIM};text-align:center">
      Nexus RAMP reports on positions you import. It does not place orders, and nothing it shows is financial advice.
      Always check figures against your broker statement.<br>A Fincoursa product.
    </p>
  </td></tr>
</table></body></html>`;
}

const p = (text) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.65;color:${DIM}">${text}</p>`;

/**
 * Every email Nexus sends itself, keyed by what happened.
 *
 * The `kind` is also what gets written to the send log, so each one can be sent at most once
 * per thing it is about — see sendOnce.
 */
export const EMAILS = {
  trial_started: ({ days, endsAt, url }) => ({
    subject: `Your ${days}-day Nexus RAMP trial has started`,
    html: shell({
      heading: `You're in — ${days} days, starting now`,
      body:
        p(`Your trial runs until <strong style="color:${INK}">${esc(formatDay(endsAt))}</strong>. No card, and nothing to cancel: it stops on its own.`) +
        p(`The fastest way to know whether this is for you is to import a real day of fills and look at your own book. Everything else follows from that.`),
      action: { href: url, label: "Import your fills" },
      footnote: `Anything you import is yours and stays yours. If the trial ends without you subscribing, nothing is deleted.`,
    }),
  }),

  trial_ending: ({ daysLeft, endsAt, url, imported }) => ({
    subject: daysLeft === 1 ? "Your Nexus RAMP trial ends tomorrow" : `${daysLeft} days left on your Nexus RAMP trial`,
    html: shell({
      heading: daysLeft === 1 ? "Your trial ends tomorrow" : `${daysLeft} days left`,
      body:
        p(`Your trial runs until <strong style="color:${INK}">${esc(formatDay(endsAt))}</strong>.`) +
        // Somebody who never imported anything has not evaluated the product, and telling
        // them "your trial is ending" is useless. Tell them what is actually missing.
        (imported
          ? p(`Your book stays exactly as it is either way — subscribing just keeps the door open.`)
          : p(`You haven't imported any fills yet, so there is nothing in here to judge us on. It takes about two minutes with a broker CSV, and it is worth doing before you decide.`)),
      action: { href: url, label: imported ? "Keep your access" : "Import your fills" },
    }),
  }),

  trial_ended: ({ url }) => ({
    subject: "Your Nexus RAMP trial has ended",
    html: shell({
      heading: "Your trial has ended",
      body:
        p(`Your data is untouched and waiting — every fill, every broker setting, every scenario. Nothing has been deleted and nothing will be.`) +
        p(`Subscribe and you pick up exactly where you left off.`),
      action: { href: url, label: "Subscribe" },
      footnote: `If Nexus RAMP wasn't right for you, we'd genuinely like to know why. Just reply to this email.`,
    }),
  }),

  subscribed: ({ endsAt, url }) => ({
    subject: "Your Nexus RAMP subscription is active",
    html: shell({
      heading: "You're subscribed",
      body:
        p(`Thank you. Your access runs to <strong style="color:${INK}">${esc(formatDay(endsAt))}</strong> and renews automatically.`) +
        p(`Cards, invoices and cancelling are all in your billing page — no need to email anyone.`),
      action: { href: url, label: "Open Nexus RAMP" },
    }),
  }),

  payment_failed: ({ url }) => ({
    subject: "Your card was declined — Nexus RAMP",
    html: shell({
      heading: "We couldn't take this month's payment",
      body:
        // The first line, because it is the thing they are worried about.
        p(`<strong style="color:${INK}">You still have access.</strong> Nothing has been cut off and nothing has been deleted.`) +
        p(`Your bank declined the renewal. We'll try again over the next few days — usually it goes through on its own. If it doesn't, updating the card takes a moment.`),
      action: { href: url, label: "Update your card" },
    }),
  }),

  code_issued: ({ code, grantsDays, expiresAt, url }) => ({
    subject: "Your Nexus RAMP access code",
    html: shell({
      heading: "Here's your access code",
      body:
        p(`Sign in, then enter this code to add <strong style="color:${INK}">${esc(grantsDays)} days</strong> of access.`) +
        `<p style="margin:0 0 12px;font-family:'IBM Plex Mono',Consolas,monospace;font-size:22px;letter-spacing:.12em;color:${INK}">${esc(code)}</p>` +
        (expiresAt
          ? p(`Redeem it by <strong style="color:${INK}">${esc(formatDay(expiresAt))}</strong>.`)
          : p(`It doesn't expire, but it can only be used once.`)),
      action: { href: url, label: "Redeem your code" },
    }),
  }),
};

/**
 * Build one, or null if we don't know that kind — never a half-written email.
 *
 * `trial_ending_3` and `trial_ending_1` are the same letter with a different number in it,
 * and they are separate kinds only so the send log can tell them apart: one reminder at
 * three days and another at one is two emails, and a single kind would make the second look
 * already-sent.
 */
export function buildEmail(kind, data) {
  const base = kind.startsWith("trial_ending_") ? "trial_ending" : kind;
  const make = EMAILS[base];
  return make ? make(data) : null;
}
