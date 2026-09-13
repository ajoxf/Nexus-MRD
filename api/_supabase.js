import { createClient } from "@supabase/supabase-js";

/*
 * The server's Supabase client, and the only thing that may write a subscription.
 *
 * The service role key bypasses row level security entirely, which is exactly why it lives
 * here and never in the browser bundle: the name has no VITE_ prefix, so Vite cannot embed
 * it even by accident. If this ever appears in dist/, the key is public and must be rotated.
 */
export function serviceClient() {
  const url = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Server is not configured.");
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

/**
 * Who is calling, proven rather than claimed.
 *
 * The browser sends its access token; this asks Supabase whose it is. Never trust a user id
 * sent in the body — that is a request to act as somebody else, and it would be granted.
 */
export async function callerFrom(request, db) {
  const header = request.headers.authorization || request.headers.Authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token) return null;
  const { data, error } = await db.auth.getUser(token);
  if (error || !data?.user) return null;
  return data.user;
}

export const json = (res, status, body) => res.status(status).json(body);

/**
 * The caller, if they are an operator. Null otherwise.
 *
 * Checked against the admins table with the service role, never against anything the
 * browser said. Hiding the admin screens in the client is a courtesy so customers are not
 * shown a door they cannot open; THIS is the lock, and it is on the server side of it.
 */
export async function adminFrom(request, db) {
  const user = await callerFrom(request, db);
  if (!user) return null;
  const { data, error } = await db
    .from("admins")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();
  if (error || !data) return null;
  return user;
}
