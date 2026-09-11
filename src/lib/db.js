import { createClient } from "@supabase/supabase-js";

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const supabase = URL && KEY ? createClient(URL, KEY, { auth: { persistSession: false } }) : null;
export const isRemote = !!supabase;

const CHUNK = 500;

// ---------- Supabase (database) ----------
// One shared workspace: no login. Everyone with the link reads and writes the same rows.
const WS = "00000000-0000-0000-0000-000000000000";

const remote = {
  async getUser() { return { id: WS, email: "Shared workspace" }; },
  async loadSettings() {
    const { data, error } = await supabase.from("settings").select("data").eq("user_id", WS).maybeSingle();
    if (error) throw error;
    return data?.data ?? null;
  },
  async saveSettings(obj) {
    const { error } = await supabase.from("settings").upsert({ user_id: WS, data: obj, updated_at: new Date().toISOString() });
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
    let added = 0;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { data, error } = await supabase
        .from("fills")
        .upsert(rows.slice(i, i + CHUNK).map((r) => ({ ...r, user_id: WS })), { onConflict: "user_id,broker,ref", ignoreDuplicates: true })
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
    const { error } = await supabase.from("fills").delete().eq("user_id", WS);
    if (error) throw error;
  },
  async deleteBrokerFills(broker) {
    const { error } = await supabase.from("fills").delete().eq("user_id", WS).eq("broker", broker);
    if (error) throw error;
  },
};

// ---------- Browser storage (used until a database is connected) ----------
const LS_SETTINGS = "mrt:settings", LS_FILLS = "mrt:fills";
const readFills = () => JSON.parse(localStorage.getItem(LS_FILLS) || "[]");
const writeFills = (f) => localStorage.setItem(LS_FILLS, JSON.stringify(f));

const local = {
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
