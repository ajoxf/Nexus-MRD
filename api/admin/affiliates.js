import { generateRefCode, looksLikeRef, normaliseRef, tallyRewards } from "../../src/lib/affiliates.js";
import { adminFrom, json, serviceClient } from "../_supabase.js";

/*
 * The affiliate programme, from the operator's side.
 *
 * GET   — who the affiliates are, who they sent, and what they are owed.
 * POST  — issue a new one. Requires the terms in full; see the note on the rate below.
 * PATCH — pause or close somebody, or mark a reward paid.
 *
 * All three tables are unreadable to every signed-in user by policy, so this endpoint is
 * the only window onto them, and it asks who is knocking before it opens.
 */

const KINDS = new Set(["percent", "fixed", "free_months"]);
const SCOPES = new Set(["first", "recurring"]);
const STATUSES = new Set(["active", "paused", "closed"]);
const REWARD_STATUSES = new Set(["owed", "paid", "void"]);

export default async function handler(request, response) {
  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const admin = await adminFrom(request, db);
  if (!admin) return json(response, 403, { error: "Not allowed." });

  if (request.method === "GET") return list(db, response);
  if (request.method === "POST") return create(db, request, response, admin);
  if (request.method === "PATCH") return patch(db, request, response);
  return json(response, 405, { error: "Use GET, POST or PATCH." });
}

async function list(db, response) {
  const { data: affiliates, error } = await db
    .from("affiliates")
    .select("code, name, email, status, reward_kind, reward_value, reward_scope, note, created_at")
    .order("created_at", { ascending: false })
    .limit(500);
  if (error) return json(response, 500, { error: "Could not read the affiliates." });

  const { data: referrals } = await db
    .from("referrals")
    .select("id, affiliate_code, status, email, visited_at, signed_up_at, converted_at")
    .order("visited_at", { ascending: false })
    .limit(2000);

  const { data: rewards } = await db
    .from("affiliate_rewards")
    .select("id, affiliate_code, user_id, kind, rate, basis_minor, amount_minor, currency, status, period_ref, created_at, paid_at")
    .order("created_at", { ascending: false })
    .limit(2000);

  /*
   * Counted per affiliate in one pass rather than one query each. With a few dozen
   * affiliates either would do; this way the page does not get slower as the programme
   * works.
   */
  const counts = new Map();
  for (const r of referrals ?? []) {
    const c = counts.get(r.affiliate_code) ?? { visits: 0, signups: 0, conversions: 0 };
    if (r.status === "visited") c.visits += 1;
    if (r.status === "signed_up") c.signups += 1;
    if (r.status === "converted") c.conversions += 1;
    counts.set(r.affiliate_code, c);
  }

  const byAffiliate = new Map();
  for (const r of rewards ?? []) {
    if (!byAffiliate.has(r.affiliate_code)) byAffiliate.set(r.affiliate_code, []);
    byAffiliate.get(r.affiliate_code).push(r);
  }

  const rows = (affiliates ?? []).map((a) => ({
    ...a,
    counts: counts.get(a.code) ?? { visits: 0, signups: 0, conversions: 0 },
    tally: tallyRewards(byAffiliate.get(a.code) ?? []),
    // The currency of what is owed, when there is exactly one. Mixed currencies do not add
    // up and this refuses to pretend they do — the same rule the rest of Nexus follows.
    currency: oneCurrency(byAffiliate.get(a.code) ?? []),
  }));

  return json(response, 200, {
    affiliates: rows,
    rewards: (rewards ?? []).slice(0, 200),
    referrals: (referrals ?? []).filter((r) => r.status !== "visited").slice(0, 200),
  });
}

/** The single currency in a set of rewards, or null if there is more than one. */
function oneCurrency(rewards) {
  const seen = new Set(rewards.map((r) => r.currency).filter(Boolean));
  return seen.size === 1 ? [...seen][0] : null;
}

async function create(db, request, response, admin) {
  const body = request.body && typeof request.body === "object" ? request.body : {};

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return json(response, 400, { error: "An affiliate needs a name." });

  const kind = String(body.reward_kind ?? "");
  if (!KINDS.has(kind)) return json(response, 400, { error: "Choose a reward type." });

  const scope = String(body.reward_scope ?? "");
  if (!SCOPES.has(scope)) return json(response, 400, { error: "Choose first payment or every payment." });

  /*
   * The rate must be typed. There is no default here and none in the database either.
   *
   * A missing number is refused rather than filled in, because a column that quietly
   * supplies 20 because nobody typed anything is a contract nobody agreed to — and the
   * first anyone would know about it is when the invoice arrives. Zero is allowed and
   * empty is not: "no commission" is a decision somebody can make, and it looks different
   * from having forgotten.
   */
  if (body.reward_value === undefined || body.reward_value === null || body.reward_value === "") {
    return json(response, 400, { error: "A commission rate is required — there is no default." });
  }
  const value = Number(body.reward_value);
  if (!Number.isFinite(value) || value < 0) return json(response, 400, { error: "That rate is not a number." });
  if (kind === "percent" && value > 100) return json(response, 400, { error: "A percentage over 100 pays out more than came in." });

  /*
   * A code they chose, or one we make. Either way it is normalised to the one shape the
   * capture endpoint recognises, so a code typed here as "ref 7k4p" and one arriving in a
   * link as "REF-7K4P" are the same affiliate rather than two.
   */
  let code = body.code ? normaliseRef(body.code) : generateRefCode();
  if (!looksLikeRef(code)) return json(response, 400, { error: "That code is not a valid referral code." });

  const row = {
    code,
    name: name.slice(0, 200),
    email: typeof body.email === "string" && body.email.trim() ? body.email.trim().toLowerCase() : null,
    reward_kind: kind,
    reward_value: value,
    reward_scope: scope,
    note: typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null,
    created_by: admin.id,
  };

  const { error } = await db.from("affiliates").insert(row);
  if (error) {
    if (error.code === "23505") return json(response, 409, { error: "That code is already taken." });
    return json(response, 500, { error: "Could not create that affiliate." });
  }

  return json(response, 200, { ok: true, code });
}

async function patch(db, request, response) {
  const body = request.body && typeof request.body === "object" ? request.body : {};

  // Marking a reward paid, void or back to owed.
  if (body.rewardId) {
    const status = String(body.status ?? "");
    if (!REWARD_STATUSES.has(status)) return json(response, 400, { error: "That is not a reward status." });

    /*
     * paid_at is set when it is paid and cleared when it is not, in the same statement that
     * moves the status. Two fields that disagree — "owed", settled last March — is the kind
     * of thing nobody notices until they are arguing about it.
     */
    const { error } = await db
      .from("affiliate_rewards")
      .update({ status, paid_at: status === "paid" ? new Date().toISOString() : null })
      .eq("id", body.rewardId);
    if (error) return json(response, 500, { error: "Could not update that reward." });
    return json(response, 200, { ok: true });
  }

  // Pausing, closing or reactivating an affiliate.
  const code = normaliseRef(body.code);
  if (!looksLikeRef(code)) return json(response, 400, { error: "Which affiliate?" });

  const status = String(body.status ?? "");
  if (!STATUSES.has(status)) return json(response, 400, { error: "That is not an affiliate status." });

  const { error } = await db.from("affiliates").update({ status }).eq("code", code);
  if (error) return json(response, 500, { error: "Could not update that affiliate." });
  return json(response, 200, { ok: true });
}
