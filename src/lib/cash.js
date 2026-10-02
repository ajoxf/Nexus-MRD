/*
 * The cash ledger: deposits, withdrawals and charges, and what makes each one count once.
 *
 * Every entry carries a KEY, and the database refuses a second entry with the same key for
 * the same account (unique on user, broker, source_key — migration 0013). That is the hard
 * guarantee, and it lives in Postgres so no refactor of a screen can quietly remove it.
 *
 * The key says where the entry came from:
 *
 *   manual:<id>        typed by hand. Its own thing — typing the same deposit twice is the
 *                      trader's call, though they are warned (see classifyCash).
 *   deal:<ref>         an MT5 balance row carrying a deal number.
 *   csv:<content>|<n>  a file row with no reference: account, type, amount and minute, plus
 *                      which occurrence it was in the file. Re-reading the same file gives the
 *                      same keys; two genuine identical deposits in one file stay two.
 *   legacy:<id>        copied out of the old settings.cash list by the migration.
 *
 * A unique key cannot catch the same deposit arriving under two DIFFERENT keys — a deal
 * number this time and none last time, or a legacy copy of something now re-imported. So
 * classifyCash also matches on content, the same way fills are matched in classifyFills:
 * same account, type, amount to the cent and minute is the same entry. That is exactly the
 * rule the importer used before this file existed, so nothing it caught then is missed now.
 *
 * Anything looser — same account, type and amount a day or two apart — is a POSSIBLE match
 * and is never decided here. It is shown to the trader, who says whether it is the same
 * money. A fuzzy match that silently skipped would hide a real second deposit; one that
 * silently added would double-count. Only a person knows which.
 */

export const TYPES = ["deposit", "withdrawal", "charge"];

// Within this many days, same account, type and amount is worth asking about.
export const NEAR_DAYS = 3;

const cents = (a) => Math.round(Math.abs(+a || 0) * 100);
const minuteOf = (ts) => new Date(ts).toISOString().slice(0, 16);

/* Same account, type, amount to the cent and minute: the same entry, whatever its key. */
export const contentKey = (c) => `${c.broker}|${c.type}|${cents(c.amount)}|${minuteOf(c.ts)}`;

/*
 * Keys for entries read from a file. A deal number is the broker's own identity and wins;
 * otherwise the content, numbered by occurrence so repeats within one file are kept apart.
 */
export function fileKeys(entries) {
  const seen = {};
  return entries.map((c) => {
    if (c.ref) return `deal:${String(c.ref).trim()}`;
    const k = contentKey(c);
    seen[k] = (seen[k] || 0) + 1;
    return `csv:${k}|${seen[k]}`;
  });
}

/**
 * Sorts incoming entries against the ledger.
 *
 * status:
 *   "new"       not in the ledger — safe to add
 *   "stored"    already there, by key or by identical content — skip
 *   "file-dup"  the same deal number twice in this file — skip
 *   "possible"  same account, type and amount within NEAR_DAYS of an entry already there,
 *               but not identical. Not added unless the trader says so; `match` names the
 *               entry it resembles so they can judge.
 *
 * `existing` should be the WHOLE ledger, including entries not yet accepted or rejected
 * ones, so that something turned down once is not offered again.
 */
export function classifyCash(incoming, existing, { nearDays = NEAR_DAYS } = {}) {
  const keys = incoming.map((c) => c.key);
  const stored = new Set(existing.map((c) => `${c.broker}|${c.key}`));
  const available = {}, byContent = {};
  for (const c of existing) { const k = contentKey(c); available[k] = (available[k] || 0) + 1; (byContent[k] ||= []).push(c); }

  const seenKeys = new Set();
  const rows = incoming.map((c, i) => ({ ...c, key: keys[i], status: null, match: null }));

  // 1) the same key twice in this file, or a key already in the ledger
  for (const r of rows) {
    const k = `${r.broker}|${r.key}`;
    if (seenKeys.has(k)) { r.status = "file-dup"; continue; }
    seenKeys.add(k);
    if (stored.has(k)) { r.status = "stored"; const ck = contentKey(r); if (available[ck] > 0) available[ck]--; }
  }
  // 2) the same entry already there under a different key
  for (const r of rows) {
    if (r.status) continue;
    const ck = contentKey(r);
    if (available[ck] > 0) { r.status = "stored"; available[ck]--; r.match = byContent[ck][available[ck]]; }
  }
  // 3) close but not identical: ask, never decide.
  //    Two entries that BOTH carry the broker's own reference, and different ones, are two
  //    entries by the broker's say-so — the same fee charged on consecutive days, say — and
  //    asking about them would hold back real charges every day.
  const win = nearDays * 24 * 3600 * 1000;
  const used = new Set();
  for (const r of rows) {
    if (r.status) continue;
    const t = new Date(r.ts).getTime();
    const m = existing.find((x) => !used.has(x.id) && x.status !== "rejected" && x.broker === r.broker && x.type === r.type
      && !(r.ref && x.ref && String(r.ref).trim() !== String(x.ref).trim())
      && cents(x.amount) === cents(r.amount) && Math.abs(new Date(x.ts).getTime() - t) <= win);
    if (m) { used.add(m.id); r.status = "possible"; r.match = m; }
    else r.status = "new";
  }
  const count = (s) => rows.filter((r) => r.status === s).length;
  return { rows, counts: { new: count("new"), stored: count("stored"), fileDup: count("file-dup"), possible: count("possible") } };
}

/*
 * The browser-storage version of the database's unique key: adds only entries whose key
 * the ledger does not already hold for that account. Returns the new ledger and how many
 * went in, so the count reported to the trader is the count actually stored.
 */
export function addToLedger(ledger, entries, newId = () => crypto.randomUUID(), now = () => new Date().toISOString()) {
  const have = new Set(ledger.map((c) => `${c.broker}|${c.key}`));
  const fresh = [];
  for (const e of entries) {
    const k = `${e.broker}|${e.key}`;
    if (have.has(k)) continue;
    have.add(k);
    fresh.push({ status: "accepted", ...e, id: newId(), created_at: now() });
  }
  return { ledger: [...ledger, ...fresh], added: fresh.length };
}

/*
 * The old list in settings.cash, as ledger entries. Same arithmetic as the migration's SQL:
 * every entry keeps its id inside its key, so copying twice is still one copy.
 */
export const fromLegacy = (list) => (Array.isArray(list) ? list : []).map((c) => ({
  ...c,
  amount: +c.amount || 0,
  key: `legacy:${c.id}`,
  status: "accepted",
}));

// Equity counts accepted entries only. Proposed ones are waiting on the trader.
export const accepted = (ledger) => (ledger || []).filter((c) => (c.status || "accepted") === "accepted");

// ---------- database rows ----------
export const toRow = (c) => ({
  broker: c.broker,
  type: c.type,
  amount: +c.amount,
  ts: c.ts,
  note: c.note || "",
  category: c.category ?? null,
  recurring: c.recurring ?? null,
  end_ts: c.endTs ?? null,
  source: c.source || "manual",
  ref: c.ref || null,
  source_key: c.key,
  status: c.status || "accepted",
});

export const fromRow = (r) => {
  const c = {
    id: r.id, broker: r.broker, type: r.type, amount: +r.amount, ts: r.ts, note: r.note || "",
    source: r.source, key: r.source_key, status: r.status, created_at: r.created_at,
  };
  if (r.category) c.category = r.category;
  if (r.recurring) c.recurring = r.recurring;
  if (r.end_ts) c.endTs = r.end_ts;
  if (r.ref) c.ref = r.ref;
  return c;
};
