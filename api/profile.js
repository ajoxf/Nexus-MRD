import { callerFrom, json, serviceClient } from "./_supabase.js";

/*
 * The name and number somebody gave when they signed up, written where only the server
 * can reach it.
 *
 * It has to come through here rather than straight from the browser, because `customers`
 * has row level security on with no policies at all — no signed-in user can write to it,
 * deliberately, since that is the table holding the desk's own notes about them.
 *
 * WHY IT ARRIVES IN USER METADATA. At sign-up there is no session yet: the account is not
 * confirmed and there is nobody to authenticate. The details ride along on the sign-up call
 * as user metadata, and this endpoint copies them across on the first authenticated load.
 *
 * That is safe HERE and would not be everywhere. raw_user_meta_data is user-writable —
 * anybody can put anything in it via updateUser — so it is trusted for a name and a phone
 * number, which are theirs to state, and for nothing else. It decides no access. Admin is
 * still checked against the admins table, as it always was.
 */

const clean = (v, max = 120) => {
  if (typeof v !== "string") return null;
  const t = v.trim().replace(/\s+/g, " ");
  return t ? t.slice(0, max) : null;
};

/*
 * A phone number as somebody would type it, kept as they typed it.
 *
 * Digits, spaces, brackets, dashes and a leading +. Not reformatted into some canonical
 * shape: a number rewritten into a form its owner does not recognise is a number they
 * cannot check, and we are not the ones who have to dial it.
 */
const cleanPhone = (v) => {
  if (typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  if (!/^\+?[\d\s()\-.]{6,24}$/.test(t)) return null;
  return t.slice(0, 24);
};

export default async function handler(request, response) {
  if (request.method !== "POST" && request.method !== "GET") {
    return json(response, 405, { error: "Use GET or POST." });
  }

  let db;
  try { db = serviceClient(); } catch { return json(response, 503, { error: "Server is not configured." }); }

  const user = await callerFrom(request, db);
  if (!user) return json(response, 401, { error: "Sign in first." });

  const { data: existing } = await db
    .from("customers")
    .select("user_id, first_name, last_name, whatsapp, full_name")
    .eq("user_id", user.id)
    .maybeSingle();

  if (request.method === "GET") {
    return json(response, 200, {
      first_name: existing?.first_name ?? null,
      last_name: existing?.last_name ?? null,
      whatsapp: existing?.whatsapp ?? null,
    });
  }

  const body = request.body && typeof request.body === "object" ? request.body : {};
  const meta = user.user_metadata ?? {};

  /*
   * The body wins, then what was stated at sign-up, then what is already stored.
   *
   * The body is for somebody editing their details later. The metadata is the sign-up
   * itself. Existing last, so a sync that runs on every load cannot blank a name somebody
   * has since corrected.
   */
  const first = clean(body.first_name) ?? clean(meta.first_name) ?? existing?.first_name ?? null;
  const last = clean(body.last_name) ?? clean(meta.last_name) ?? existing?.last_name ?? null;

  /*
   * An explicitly empty string means "remove it", which is different from not mentioning it.
   * Somebody taking their number back out is a request to honour, not a field to ignore.
   */
  const whatsapp = body.whatsapp === ""
    ? null
    : cleanPhone(body.whatsapp) ?? cleanPhone(meta.whatsapp) ?? existing?.whatsapp ?? null;

  // Kept in step so every admin screen that already reads full_name keeps working.
  const full = [first, last].filter(Boolean).join(" ") || existing?.full_name || null;

  if (body.whatsapp !== undefined && body.whatsapp !== "" && cleanPhone(body.whatsapp) === null) {
    return json(response, 400, { error: "That does not look like a phone number." });
  }

  const { error } = await db.from("customers").upsert(
    { user_id: user.id, first_name: first, last_name: last, whatsapp, full_name: full, updated_at: new Date().toISOString() },
    { onConflict: "user_id" },
  );
  if (error) {
    console.error("[profile] could not save:", error.message);
    return json(response, 500, { error: "Could not save your details." });
  }

  return json(response, 200, { ok: true, first_name: first, last_name: last, whatsapp });
}
