import { generateCode, CODE_VALIDITY_DAYS } from "../../src/lib/codes.js";
import { adminFrom, json, serviceClient } from "../_supabase.js";

/*
 * List and issue access codes.
 *
 * Only an operator sees this. The codes table is unreadable to every signed-in user by
 * policy, so this endpoint is the only window onto it and it checks who is asking first.
 */
export default async function handler(request, response) {
  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const admin = await adminFrom(request, db);
  if (!admin) return json(response, 403, { error: "Not allowed." });

  if (request.method === "GET") {
    const { data, error } = await db
      .from("redemption_codes")
      .select("code, grants_days, expires_at, issued_to_email, note, redeemed_at, redeemed_email, created_at")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) return json(response, 500, { error: "Could not read the codes." });
    return json(response, 200, { codes: data ?? [] });
  }

  if (request.method !== "POST") return json(response, 405, { error: "Use GET or POST." });

  const body = request.body && typeof request.body === "object" ? request.body : {};
  const count = Math.min(50, Math.max(1, Math.round(Number(body.count) || 1)));
  const grantsDays = Math.min(3650, Math.max(1, Math.round(Number(body.grantsDays) || 365)));
  const validityDays = body.validityDays === null ? null
    : Math.min(3650, Math.max(1, Math.round(Number(body.validityDays) || CODE_VALIDITY_DAYS)));

  const expiresAt = validityDays === null
    ? null
    : new Date(Date.now() + validityDays * 86400000).toISOString();

  /*
   * Generated here and inserted in one statement, so a clash with an existing code fails
   * the whole batch rather than silently issuing fewer than asked for. With 31^8 codes a
   * clash is not going to happen; being told if it does costs nothing.
   */
  const rows = Array.from({ length: count }, () => ({
    code: generateCode(),
    grants_days: grantsDays,
    expires_at: expiresAt,
    issued_to_email: typeof body.email === "string" && body.email.trim() ? body.email.trim() : null,
    note: typeof body.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null,
    created_by: admin.id,
  }));

  const { data, error } = await db.from("redemption_codes").insert(rows).select("code");
  if (error) return json(response, 500, { error: "Could not issue those codes." });

  return json(response, 200, { ok: true, codes: (data ?? []).map((r) => r.code) });
}
