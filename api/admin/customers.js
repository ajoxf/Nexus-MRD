import { adminFrom, json, serviceClient } from "../_supabase.js";

/*
 * Every account and what it holds.
 *
 * Subscriptions only. Not one fill, not one position, not one figure from anybody's book —
 * that is a different question with a different answer, and it needs telling customers
 * before it is built rather than after. Running the business does not require reading
 * somebody's trades, so this does not.
 */
export default async function handler(request, response) {
  if (request.method !== "GET") return json(response, 405, { error: "Use GET." });

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const admin = await adminFrom(request, db);
  if (!admin) return json(response, 403, { error: "Not allowed." });

  const { data: page, error: usersError } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  if (usersError) return json(response, 500, { error: "Could not read the accounts." });

  const { data: subs, error: subsError } = await db
    .from("subscriptions")
    .select("user_id, status, current_period_end, trial_started_at, cancel_at_period_end, provider");
  if (subsError) return json(response, 500, { error: "Could not read the subscriptions." });

  const { data: crm } = await db
    .from("customers")
    .select("user_id, full_name, first_name, last_name, whatsapp, firm, phone, stage, notes");

  /*
   * Whether each account is actually using the product — counts and dates, never a fill.
   *
   * It is the difference between a trial going well and one going nowhere: somebody eleven
   * days into fourteen with nothing imported has not evaluated the product and is about to
   * leave, and no subscription row shows that. How much and how recently, never what: not a
   * price, not a size, not a product, not a position.
   */
  const { data: usageRows } = await db.rpc("admin_usage");
  const usage = new Map();
  if (Array.isArray(usageRows)) for (const row of usageRows) usage.set(row.user_id, row);

  const byUser = new Map((subs ?? []).map((s) => [s.user_id, s]));
  const byCrm = new Map((crm ?? []).map((c) => [c.user_id, c]));
  const customers = (page?.users ?? []).map((u) => ({
    id: u.id,
    email: u.email,
    createdAt: u.created_at,
    lastSignInAt: u.last_sign_in_at,
    // Null where an account has never been given anything, which is a real answer and not
    // a missing one: it is the ordinary state of somebody who just signed up.
    sub: byUser.get(u.id) ?? null,
    crm: byCrm.get(u.id) ?? null,
    usage: usage.get(u.id) ?? null,
    fills: Number(usage.get(u.id)?.fills ?? 0),
  }));

  customers.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  return json(response, 200, { customers });
}
