import { adminFrom, json, serviceClient } from "../_supabase.js";

const STAGES = ["new", "trialing", "evaluating", "committed", "paying", "at_risk", "lapsed", "lost"];
const trim = (v, max) => (typeof v === "string" ? v.trim().slice(0, max) : null);

/*
 * Save the desk's own notes on a customer.
 *
 * Internal, and unreachable by the person they are about: the table has no row level
 * security policy at all, so only the service role touches it. "Chasing, gone quiet,
 * probably lost" is a note to yourself, and the way to guarantee a customer never reads it
 * is to give the browser no path to the row rather than to remember to filter it out.
 */
export default async function handler(request, response) {
  if (request.method !== "POST") return json(response, 405, { error: "Use POST." });

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const admin = await adminFrom(request, db);
  if (!admin) return json(response, 403, { error: "Not allowed." });

  const body = request.body && typeof request.body === "object" ? request.body : {};
  const userId = typeof body.userId === "string" ? body.userId : "";
  if (!userId) return json(response, 400, { error: "Say which account." });

  const stage = typeof body.stage === "string" && STAGES.includes(body.stage) ? body.stage : "new";

  const { error } = await db.from("customers").upsert(
    {
      user_id: userId,
      full_name: trim(body.fullName, 120),
      firm: trim(body.firm, 120),
      phone: trim(body.phone, 40),
      stage,
      // Capped rather than unbounded: a text box somebody can paste a novel into is a text
      // box somebody eventually pastes a novel into.
      notes: trim(body.notes, 4000),
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );
  if (error) return json(response, 500, { error: "Could not save that." });

  return json(response, 200, { ok: true });
}
