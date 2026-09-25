/*
 * Contract expiry.
 *
 * Every expiry here was typed in by the trader. Nothing is derived from an exchange rule:
 * CME's WTI stops trading three business days before the 25th of the month before delivery,
 * Brent on the last business day of the second month before, and both bend around exchange
 * holidays. Those rules are knowable, but a date computed from a holiday calendar nobody has
 * checked would be a guess wearing the clothes of a fact — and it would be read by somebody
 * deciding whether to roll today or tomorrow. So the app holds what it was told, and says so.
 *
 * Dates are compared as CALENDAR days, not instants. "Expires on the 20th" is true all day on
 * the 20th wherever the trader is sitting, and an expiry must never move a day because a clock
 * crossed midnight in another time zone.
 */

// Whole days from a Y-M-D, counted at UTC noon so no daylight-saving shift can round it wrong.
const dayNumber = (y, m, d) => Math.floor(Date.UTC(y, m, d) / 86400000);

// "2026-10-20" -> {y, m, d}, or null for anything that is not a plain calendar date.
export function parseExpiry(value) {
  const s = String(value ?? "").trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [+m[1], +m[2], +m[3]];
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  // Reject a date that does not exist: new Date(2026, 1, 31) is quietly 3 March.
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  return { y, m: mo - 1, d };
}

// Calendar days from today to the expiry. 0 = expires today, negative = already gone.
export function daysUntil(value, now = new Date()) {
  const e = parseExpiry(value);
  if (!e) return null;
  return dayNumber(e.y, e.m, e.d) - dayNumber(now.getFullYear(), now.getMonth(), now.getDate());
}

/*
 * How loud to be about it. "soon" is the window in which a roll has to be decided rather than
 * noticed; it is a preference, not a fact, so it is a parameter.
 */
export function expiryState(value, now = new Date(), soonDays = 7) {
  const days = daysUntil(value, now);
  if (days === null) return null;
  const level = days < 0 ? "bad" : days === 0 ? "bad" : days <= soonDays ? "warn" : "ok";
  const label = days < 0 ? (days === -1 ? "1 day ago" : `${-days} days ago`)
    : days === 0 ? "today"
    : days === 1 ? "tomorrow"
    : `in ${days} days`;
  return { days, level, label, expired: days < 0, due: days <= soonDays };
}

// Short, unambiguous, and never locale-dependent: 20 Oct 26.
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatExpiry(value) {
  const e = parseExpiry(value);
  return e ? `${e.d} ${MONTHS[e.m]} ${String(e.y).slice(2)}` : "";
}

/*
 * A spread has two legs and two last trading days.
 *
 * CL Nov26-Jan27 stops being a spread when the Nov leg stops trading, whatever January is
 * doing; the HO-CL crack goes when whichever of heating oil or crude gets there first. So the
 * deadline that matters is the EARLIER of the two, and it is taken as the earlier of whatever
 * dates are present rather than trusting which box they were typed into — a trader filling in
 * a crack has no reason to know which leg the app considers "first".
 *
 * One date is an outright. Two is a spread. Neither is a contract nobody has dated yet.
 */
export function contractExpiry(spec) {
  const dates = [spec?.expiry, spec?.expiry2].filter((v) => parseExpiry(v));
  if (!dates.length) return null;
  const sorted = [...dates].sort();      // ISO dates sort correctly as text
  return { near: sorted[0], far: sorted.length > 1 ? sorted[sorted.length - 1] : null, both: sorted };
}

/*
 * The open positions whose contract is at or past its roll window, nearest first — what the
 * dashboard turns into a warning. A position with no expiry recorded is not "safe", it is
 * unknown, so it is left out rather than reported as fine.
 */
export function expiringRows(rows, now = new Date(), soonDays = 7) {
  return rows
    .map((r) => {
      const c = contractExpiry(r.spec);
      return { row: r, contract: c, state: c && expiryState(c.near, now, soonDays) };
    })
    .filter((x) => x.state && x.state.due)
    .sort((a, b) => a.state.days - b.state.days);
}
