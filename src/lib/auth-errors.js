/*
 * Turning an authentication error into something a trader can act on.
 *
 * Supabase's messages are written for whoever is building the thing, not for whoever is
 * standing at the door at seven in the morning. "Error sending confirmation email" is
 * accurate and tells the person nothing: not whose fault it is, not whether their account
 * now exists, not whether typing it all again will help.
 *
 * Every line below answers those three questions, because the alternative is somebody
 * signing up four times and then emailing to ask which of the four accounts is theirs.
 *
 * Pure, and checked in scripts/auth-errors-check.mjs.
 */

/**
 * @returns {{ text: string, retry: boolean, ours: boolean }}
 *   text  — what to show.
 *   retry — whether trying the same thing again could work.
 *   ours  — whether this is our problem rather than theirs. Drives the tone: nobody should
 *           be told to check their details when the fault is at our end.
 */
export function authErrorCopy(message, mode = "in") {
  const m = String(message ?? "").trim();
  const lower = m.toLowerCase();

  /*
   * The email system is down, and the account was NOT created.
   *
   * Supabase rolls the sign-up back when the confirmation cannot be sent, which is the
   * single most important thing to tell somebody here: the address is still free, and
   * trying again later is not going to produce a duplicate.
   */
  if (/error sending|email address not authorized|smtp/i.test(lower)) {
    return {
      text: "We couldn't send the confirmation email, so your account has not been created — this is a problem at our end, not with anything you typed. Your details are still here; please try again in a few minutes.",
      retry: true,
      ours: true,
    };
  }

  // Too many emails, too fast. Supabase counts per project, so this can be somebody else.
  if (/rate limit|too many requests/i.test(lower)) {
    return {
      text: "Too many emails have gone out in the last hour, so this one was held back. Nothing is wrong with your details — please try again shortly.",
      retry: true,
      ours: true,
    };
  }

  // The exact wait is in the message and is worth keeping: "try later" invites a retry loop.
  const wait = m.match(/after (\d+) seconds?/i);
  if (wait) {
    return { text: `Please wait ${wait[1]} seconds and try again.`, retry: true, ours: true };
  }

  if (/invalid login credentials/i.test(lower)) {
    return { text: "That email and password don't match.", retry: true, ours: false };
  }

  if (/email not confirmed/i.test(lower)) {
    return {
      text: "This account still needs confirming. Open the link in the email we sent, or reset your password to get a fresh one.",
      retry: false,
      ours: false,
    };
  }

  if (/already registered|already exists|already been registered/i.test(lower)) {
    return {
      text: "There's already an account with that email. Sign in instead, or reset the password if you've forgotten it.",
      retry: false,
      ours: false,
    };
  }

  const short = m.match(/at least (\d+) characters?/i);
  if (short) {
    return { text: `That password is too short — it needs at least ${short[1]} characters.`, retry: true, ours: false };
  }

  if (/unable to validate email|invalid format/i.test(lower)) {
    return { text: "That email address doesn't look right. Check it and try again.", retry: true, ours: false };
  }

  if (/signups not allowed|signup is disabled/i.test(lower)) {
    return {
      text: "New accounts are closed at the moment. Email team@fincoursa.com and we'll sort you out.",
      retry: false,
      ours: true,
    };
  }

  /*
   * Anything unrecognised is passed through rather than replaced with a shrug.
   *
   * A message we have not seen before is still more use to the person reading it — and to
   * whoever they forward it to — than "something went wrong".
   */
  return { text: m || (mode === "up" ? "We couldn't create that account." : "We couldn't sign you in."), retry: true, ours: false };
}
