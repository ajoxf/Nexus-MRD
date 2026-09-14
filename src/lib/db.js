import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

// persistSession keeps you signed in across page reloads; without it every
// refresh would drop you back at the sign-in screen.
export const supabase = URL && KEY
  ? createClient(URL, KEY, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } })
  : null;
export const isRemote = !!supabase;

const CHUNK = 500;

// ---------- Supabase (database) ----------
// Each trader signs in and sees only their own rows. The queries below don't
// filter by user: the database's row-level security does that, so a mistake
// here can't widen what someone can reach.

// The signed-in account's id, needed where a row has to name its owner.
const myId = async () => {
  const { data, error } = await supabase.auth.getUser();
  if (error) throw error;
  if (!data?.user) throw new Error("You've been signed out. Please sign in again.");
  return data.user.id;
};

const remote = {
  /*
   * This account's subscription, or null if it has none.
   *
   * Readable only by its owner and writable only by the server — both enforced in Postgres
   * rather than here, so editing the client cannot grant anybody anything. A missing row is
   * a real answer ("nothing on this account"), not an error.
   */
  async loadSubscription() {
    const { data, error } = await supabase
      .from("subscriptions")
      .select("status, current_period_end, trial_started_at, cancel_at_period_end, provider")
      .maybeSingle();
    if (error) throw error;
    return data ?? null;
  },
  /*
   * Is the signed-in account an operator?
   *
   * Reads the caller's own row and nobody else's — the policy on that table allows exactly
   * that. This decides whether to SHOW the admin screens; every admin endpoint checks the
   * same table again on the server, so a client that lies about this gets a locked door
   * rather than a key.
   */
  async isAdmin() {
    const { data, error } = await supabase.from("admins").select("user_id").maybeSingle();
    if (error) return false;
    return !!data;
  },
  async getUser() {
    const { data } = await supabase.auth.getSession();
    const u = data?.session?.user;
    return u ? { id: u.id, email: u.email } : null;
  },
  async loadSettings() {
    const { data, error } = await supabase.from("settings").select("data").maybeSingle();
    if (error) throw error;
    return data?.data ?? null;
  },
  async saveSettings(obj) {
    const { error } = await supabase.from("settings").upsert({ user_id: await myId(), data: obj, updated_at: new Date().toISOString() });
    if (error) throw error;
  },
  async loadFills() {
    const all = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await supabase.from("fills").select("*").order("ts").range(from, from + 999);
      if (error) throw error;
      all.push(...data);
      if (data.length < 1000) break;
    }
    return all;
  },
  /*
   * Store fills, and let a re-import repair what an older one could not read.
   *
   * Returns { added, updated }: new fills stored, and existing fills refreshed.
   *
   * The second half matters more than it looks. A file imported before the app learned to
   * recover MT5 position tickets produced rows with no ticket, and re-importing it skipped
   * every row as a duplicate — so the fix could never reach anybody who had already
   * uploaded. The only way out was to delete a season's trading and start again, which is
   * not a thing to ask of somebody reconciling against a statement.
   *
   * So a row carrying information the stored one lacks is written over it. Same file, same
   * broker, same fill id, read better — the update is the same trade with more known about
   * it, never a different trade. Rows that add nothing new are still skipped, so the count
   * of genuinely new fills stays honest.
   */
  async addFills(rows) {
    const uid = await myId();
    const owned = rows.map((r) => ({ ...r, user_id: uid }));
    let added = 0;

    for (let i = 0; i < owned.length; i += CHUNK) {
      const { data, error } = await supabase
        .from("fills")
        .upsert(owned.slice(i, i + CHUNK), { onConflict: "user_id,broker,ref", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      added += data.length;
    }

    /*
     * Only rows that now carry a position ticket, and only when the file has more of them
     * than landed as new fills — i.e. some of them were skipped as duplicates.
     */
    const ticketed = owned.filter((r) => r.position);
    if (!ticketed.length || ticketed.length <= added) return { added, updated: 0 };

    let updated = 0;
    for (let i = 0; i < ticketed.length; i += CHUNK) {
      const { data, error } = await supabase
        .from("fills")
        .upsert(ticketed.slice(i, i + CHUNK), { onConflict: "user_id,broker,ref" })
        .select("id");
      // Never fatal: the fills are stored either way, and a ticket that did not take is a
      // re-import away rather than a reason to fail an import that otherwise worked.
      if (error) { console.error("[fills] could not refresh existing rows:", error.message); break; }
      updated += data.length;
    }
    // The rows that were new were refreshed too; only the repairs are worth reporting.
    return { added, updated: Math.max(0, updated - added) };
  },
  async deleteFill(id) {
    const { error } = await supabase.from("fills").delete().eq("id", id);
    if (error) throw error;
  },
  async deleteAllFills() {
    const { error } = await supabase.from("fills").delete().eq("user_id", await myId());
    if (error) throw error;
  },
  async deleteBrokerFills(broker) {
    const { error } = await supabase.from("fills").delete().eq("user_id", await myId()).eq("broker", broker);
    if (error) throw error;
  },
};

// ---------- Signing in and out ----------
// Nexus keeps its own accounts now. Signing up, signing in, resetting a password and
// holding a subscription all happen here — NordStar Pro is no longer in the path.
export const auth = isRemote
  ? {
      enabled: true,
      async signIn(email, password) {
        const { error } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
        if (error) throw error;
      },
      async signOut() { await supabase.auth.signOut(); },
      /*
       * Sign up, carrying the details they gave with them.
       *
       * They travel as user metadata because at this moment there is no session to
       * authenticate — the account is not confirmed and nobody is signed in. /api/profile
       * copies them into the CRM table on the first authenticated load, which is the only
       * thing that can write there.
       *
       * Metadata is user-writable, so it is trusted for a name and a number — theirs to
       * state — and for nothing else. It grants no access and decides nothing.
       */
      async signUp(email, password, details = {}) {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: {
            // Back to this site after confirming, where the gate decides what they hold.
            emailRedirectTo: window.location.origin,
            data: {
              first_name: (details.firstName ?? "").trim() || undefined,
              last_name: (details.lastName ?? "").trim() || undefined,
              whatsapp: (details.whatsapp ?? "").trim() || undefined,
            },
          },
        });
        if (error) throw error;
      },
      /*
       * Push the signed-in account's details into the CRM table.
       *
       * Fire and forget from the caller's point of view: a name that failed to sync is a
       * thing to fix later, never a reason to keep somebody out of their own book.
       */
      async syncProfile(body = {}) {
        const token = await this.accessToken();
        if (!token) return null;
        const r = await fetch("/api/profile", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(body),
        });
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || "Could not save your details.");
        return r.json();
      },
      async signInWithGoogle() {
        const { error } = await supabase.auth.signInWithOAuth({
          provider: "google",
          options: { redirectTo: window.location.origin },
        });
        if (error) throw error;
      },
      /*
       * The current session's access token, for calls to our own endpoints.
       *
       * Sent as a bearer token so a serverless function can ask Supabase who this is
       * before it writes anything. Nothing here is trusted on the client's word: the
       * subscription row is not writable from the browser at all.
       */
      async accessToken() {
        const { data } = await supabase.auth.getSession();
        return data?.session?.access_token ?? null;
      },
      // Sends a link back to this site, where onAuthChange reports "recovery".
      async sendReset(email) {
        const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), { redirectTo: window.location.origin });
        if (error) throw error;
      },
      async setPassword(password) {
        const { error } = await supabase.auth.updateUser({ password });
        if (error) throw error;
      },
      /*
       * Adopt a session handed over by the portal.
       *
       * The portal signs people in and redirects here with the session in the URL
       * fragment — the same shape Supabase's own sign-in redirects use. It has to be
       * claimed explicitly: `detectSessionInUrl` only reads the fragment under the
       * implicit flow, and this client is on the default PKCE flow, which looks for a
       * `code` in the query string instead. Measured, not assumed — without this the
       * handoff lands on the sign-in page with a perfectly good session in the address
       * bar and no idea what to do with it.
       *
       * Returns true when a session was adopted, so the caller knows to clear the URL.
       */
      async adoptSessionFromUrl() {
        if (typeof window === "undefined") return false;
        const hash = window.location.hash.replace(/^#/, "");
        if (!hash.includes("access_token")) return false;

        const params = new URLSearchParams(hash);
        const access_token = params.get("access_token");
        const refresh_token = params.get("refresh_token");
        if (!access_token || !refresh_token) return false;

        const { error } = await supabase.auth.setSession({ access_token, refresh_token });
        if (error) { console.error("[auth] portal handover refused", error.message); return false; }
        return true;
      },

      // Calls back with the current user (or null) whenever the session changes.
      onAuthChange(cb) {
        const { data } = supabase.auth.onAuthStateChange((event, session) => {
          cb(session?.user ? { id: session.user.id, email: session.user.email } : null, event);
        });
        return () => data.subscription.unsubscribe();
      },
    }
  : {
      enabled: false,
      onAuthChange: () => () => {},
      adoptSessionFromUrl: async () => false,
      accessToken: async () => null,
      syncProfile: async () => null,
      signOut: async () => {},
    };

// ---------- Browser storage (used until a database is connected) ----------
const LS_SETTINGS = "mrt:settings", LS_FILLS = "mrt:fills";
const readFills = () => JSON.parse(localStorage.getItem(LS_FILLS) || "[]");
const writeFills = (f) => localStorage.setItem(LS_FILLS, JSON.stringify(f));

const local = {
  /*
   * Browser-storage mode is the demo and the offline fallback. There is no subscription to
   * read and nobody to bill, so it grants an open-ended one rather than locking the desk
   * behind a payment screen that could not be completed anyway.
   */
  async loadSubscription() { return { status: "active", current_period_end: null, trial_started_at: null }; },
  // Nobody to administer in browser-storage mode: there is one account and it is this one.
  async isAdmin() { return false; },
  async getUser() { return { id: "local", email: "This browser" }; },
  async loadSettings() { return JSON.parse(localStorage.getItem(LS_SETTINGS) || "null"); },
  async saveSettings(obj) { localStorage.setItem(LS_SETTINGS, JSON.stringify(obj)); },
  async loadFills() { return readFills(); },
  async addFills(rows) {
    const cur = readFills();
    const rk = (f) => `${f.broker || "default"}|${f.ref}`;
    const byKey = new Map(cur.map((f) => [rk(f), f]));
    const fresh = [];
    let updated = 0;
    for (const r of rows) {
      const existing = byKey.get(rk(r));
      if (existing) {
        // Same repair as the database path: a re-import that can read more fills it in.
        if (r.position && !existing.position) { Object.assign(existing, r); updated += 1; }
        continue;
      }
      const row = { ...r, id: crypto.randomUUID(), created_at: new Date().toISOString() };
      byKey.set(rk(r), row);
      fresh.push(row);
    }
    writeFills([...cur, ...fresh]);
    return { added: fresh.length, updated };
  },
  async deleteFill(id) { writeFills(readFills().filter((f) => f.id !== id)); },
  async deleteAllFills() { writeFills([]); },
  async deleteBrokerFills(broker) { writeFills(readFills().filter((f) => (f.broker || "default") !== broker)); },
};

export const db = isRemote ? remote : local;
