/*
 * Nexus access codes.
 *
 * Pure: generating, formatting and judging a code needs no database, so none of it is
 * anywhere a database is required to test it.
 */

/**
 * Deliberately excludes 0/O and 1/I/L.
 *
 * Codes get read off a phone screen, out of an email, or across a desk, and typed by hand.
 * Those pairs are the usual source of "my code doesn't work", and every one of those is a
 * customer who bought something and cannot use it yet.
 */
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

const block = (n, rand) => {
  let out = "";
  for (let i = 0; i < n; i += 1) out += ALPHABET[Math.floor(rand() * ALPHABET.length)];
  return out;
};

/** e.g. NXS-4KFP-9TQX */
export function generateCode(rand = Math.random) {
  return `NXS-${block(4, rand)}-${block(4, rand)}`;
}

/**
 * Tidies what somebody typed into what we stored.
 *
 * Case, spaces and missing dashes are all things a person does when copying a code by hand,
 * and none of them mean they typed the wrong code. Refusing those is refusing a customer
 * over punctuation.
 */
export function normaliseCode(input) {
  const bare = String(input ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!bare.startsWith("NXS")) return bare ? `NXS-${bare.slice(0, 4)}-${bare.slice(4, 8)}` : "";
  const rest = bare.slice(3);
  return `NXS-${rest.slice(0, 4)}-${rest.slice(4, 8)}`;
}

/** Whether a code is even the right shape, before any lookup. */
export const looksLikeCode = (v) => /^NXS-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/.test(v);

/**
 * How long a code stays redeemable if nobody chooses.
 *
 * Long enough that a customer who bought one does not lose it to a holiday, short enough
 * that a forwarded code stops working. A default, not a rule — a launch offer and a code
 * handed to one person in a meeting are not the same promise.
 */
export const CODE_VALIDITY_DAYS = 30;

/** Why a code cannot be used, or null if it can. */
export function codeRefusal(row, now = new Date()) {
  if (!row) return "not_found";
  if (row.redeemed_at) return "already_redeemed";
  if (row.expires_at && new Date(row.expires_at).getTime() <= now.getTime()) return "expired";
  return null;
}

export const CODE_REFUSAL_COPY = {
  not_found: "We don't recognise that code. Check it and try again.",
  already_redeemed: "That code has already been used.",
  expired: "That code has expired. Get in touch and we'll sort you out.",
  bad_shape: "That doesn't look like a Nexus code. They look like NXS-4KFP-9TQX.",
};

/**
 * When access should run to after redeeming.
 *
 * From whichever is later: now, or whatever they already had. Somebody who redeems a code
 * with a week of trial left should end up with the code's days ON TOP, not instead of —
 * taking days off a customer for redeeming early is a bug they would be right to complain
 * about, and it teaches them to sit on codes.
 */
export function periodEndAfterRedeeming(current, grantsDays, now = new Date()) {
  const from = current && new Date(current).getTime() > now.getTime() ? new Date(current) : now;
  return new Date(from.getTime() + grantsDays * 86400000);
}
