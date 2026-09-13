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
  // returns number of new fills stored (duplicates are skipped)
  async addFills(rows) {
    const uid = await myId();
    let added = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { data, error } = await supabase
        .from("fills")
        .upsert(rows.slice(i, i + CHUNK).map((r) => ({ ...r, user_id: uid })), { onConflict: "user_id,broker,ref", ignoreDuplicates: true })
        .select("id");
      if (error) throw error;
      added += data.length;
    }
    return added;
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
      async signUp(email, password) {
        const { error } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          // Back to this site after confirming, where the gate decides what they hold.
          options: { emailRedirectTo: window.location.origin },
        });
        if (error) throw error;
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
  async getUser() { return { id: "local", email: "This browser" }; },
  async loadSettings() { return JSON.parse(localStorage.getItem(LS_SETTINGS) || "null"); },
  async saveSettings(obj) { localStorage.setItem(LS_SETTINGS, JSON.stringify(obj)); },
  async loadFills() { return readFills(); },
  async addFills(rows) {
    const cur = readFills();
    const rk = (f) => `${f.broker || "default"}|${f.ref}`;
    const refs = new Set(cur.map(rk));
    const fresh = [];
    for (const r of rows) {
      if (refs.has(rk(r))) continue;
      refs.add(rk(r));
      fresh.push({ ...r, id: crypto.randomUUID(), created_at: new Date().toISOString() });
    }
    writeFills([...cur, ...fresh]);
    return fresh.length;
  },
  async deleteFill(id) { writeFills(readFills().filter((f) => f.id !== id)); },
  async deleteAllFills() { writeFills([]); },
  async deleteBrokerFills(broker) { writeFills(readFills().filter((f) => (f.broker || "default") !== broker)); },
};

export const db = isRemote ? remote : local;
