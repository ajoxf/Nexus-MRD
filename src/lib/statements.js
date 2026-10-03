/*
 * Reading the daily statement zips a broker sends — Orient's arrive as
 * "Client Group Daily Statement - YYYYMMDD.zip", password protected, holding a PDF and CSVs.
 *
 * EVERYTHING HERE RUNS IN THE BROWSER. The zip is opened on the trader's own machine, with a
 * password they type, which is held in memory for the page and never sent, stored or logged.
 * No statement, and nothing read from one, leaves the browser.
 *
 * Orient protects the zip with the older PKWare "ZipCrypto" scheme, not AES. JSZip cannot
 * open that; @zip.js/zip.js can, without the Web Crypto API. It is loaded only when a
 * statement is opened, so it adds nothing to the app for anybody who never uploads one.
 *
 * This file only opens and lists. Nothing read here reaches the book: no figure is posted
 * to the ledger, the marks or the equity tally.
 */

// "… - 20261001.zip" → "2026-10-01". The last eight-digit run that is a real date wins.
export function statementDate(name) {
  const runs = String(name || "").match(/(?<!\d)\d{8}(?!\d)/g) || [];
  for (const r of runs.reverse()) {
    const y = +r.slice(0, 4), m = +r.slice(4, 6), d = +r.slice(6, 8);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (y >= 2000 && y <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) return `${r.slice(0, 4)}-${r.slice(4, 6)}-${r.slice(6, 8)}`;
  }
  return null;
}

// "Financial Summary - 100305 - 20261001.csv" → "100305". The account sits between dashes.
export function statementAccount(names) {
  for (const n of names || []) {
    const m = String(n).match(/ - (\w+) - \d{8}\b/);
    if (m && !/^\d{8}$/.test(m[1])) return m[1];
  }
  return null;
}

export const kindOf = (name) => (/\.csv$/i.test(name) ? "csv" : /\.pdf$/i.test(name) ? "pdf" : "other");

// A fingerprint of the exact file, so the same zip loaded twice is recognised as such.
export async function checksum(buf) {
  const h = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/*
 * The error a caller can act on. NEEDS_PASSWORD and BAD_PASSWORD are normal, expected
 * outcomes — ask again — not failures.
 */
const fail = (code, message) => Object.assign(new Error(message), { code });

/**
 * Opens one statement zip. Returns { date, account, checksum, files: [{ name, kind, text?, blob? }] }.
 * CSVs come back as text; PDFs and anything else as a Blob the trader can open.
 */
export async function openStatementZip(file, password = "") {
  const { ZipReader, BlobReader, BlobWriter, TextWriter, configure } = await import("@zip.js/zip.js");
  configure({ useWebWorkers: false });

  const buf = await file.arrayBuffer();
  const sum = await checksum(buf);
  const reader = new ZipReader(new BlobReader(new Blob([buf])), password ? { password } : {});
  let entries;
  try { entries = (await reader.getEntries()).filter((e) => !e.directory); }
  catch (e) { await reader.close().catch(() => {}); throw fail("NOT_A_ZIP", `${file.name} could not be read as a zip file.`); }

  if (entries.some((e) => e.encrypted) && !password) { await reader.close(); throw fail("NEEDS_PASSWORD", "This statement is password protected."); }

  const files = [];
  try {
    for (const e of entries) {
      const name = e.filename.split("/").pop();
      const kind = kindOf(name);
      if (kind === "csv") files.push({ name, kind, text: await e.getData(new TextWriter()) });
      else files.push({ name, kind, blob: await e.getData(new BlobWriter(kind === "pdf" ? "application/pdf" : "application/octet-stream")) });
    }
  } catch (e) {
    /*
     * ZipCrypto checks a password against one byte, so about one wrong password in 256 gets
     * past that check and fails later on the file's checksum instead. Either way it is the
     * password, not the file, and the trader is asked again.
     */
    if (/password|signature|crc/i.test(e?.message || "")) throw fail("BAD_PASSWORD", "That password didn't open it.");
    throw fail("UNREADABLE", `${file.name} could not be opened: ${e?.message || "unknown error"}.`);
  } finally {
    await reader.close().catch(() => {});
  }

  const names = files.map((f) => f.name);
  return {
    zipName: file.name,
    date: statementDate(file.name) || names.map(statementDate).find(Boolean) || null,
    account: statementAccount(names),
    checksum: sum,
    files,
  };
}

/*
 * Adds freshly opened statements to the ones already loaded. The same file twice (same
 * checksum) is one statement. Newest first.
 */
export function mergeStatements(have, opened) {
  const seen = new Set(have.map((s) => s.checksum));
  const added = [], repeated = [];
  for (const s of opened) {
    if (seen.has(s.checksum)) { repeated.push(s); continue; }
    seen.add(s.checksum);
    added.push(s);
  }
  const all = [...have, ...added].sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || a.zipName.localeCompare(b.zipName));
  return { all, added, repeated };
}

/*
 * Every file under whatever was dropped: loose files, a folder per day, or one folder
 * holding all of them. Brokers' statements tend to be saved a folder per day, and asking
 * for 45 separate drops would be asking a lot.
 *
 * Works on the browser's FileSystemEntry API (DataTransferItem.webkitGetAsEntry). A
 * directory reader hands back entries in batches, so it is read until it returns none.
 */
export async function filesFromEntries(entries) {
  const out = [];
  const walk = async (entry) => {
    if (!entry) return;
    if (entry.isFile) { out.push(await new Promise((res, rej) => entry.file(res, rej))); return; }
    if (!entry.isDirectory) return;
    const reader = entry.createReader();
    for (;;) {
      const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
      if (!batch.length) break;
      for (const e of batch) await walk(e);
    }
  };
  for (const e of entries) await walk(e);
  return out;
}

/*
 * A statement as it is kept (supabase/migrations/0013_statements.sql), and back again.
 *
 * Only the CSV files are kept, as text: the page re-reads them on every visit, so a better
 * reader later applies to old statements too. PDFs are not kept — they repeat the CSVs, and the
 * trader still has the zip. A kept statement comes back marked stored, so the page can say its
 * PDFs aren't here.
 */
export const toStored = (st) => ({
  checksum: st.checksum,
  zip_name: st.zipName,
  statement_date: st.date || null,
  account: st.account || null,
  files: st.files.filter((f) => f.kind === "csv").map((f) => ({ name: f.name, text: f.text })),
});
export const fromStored = (row) => ({
  zipName: row.zip_name,
  date: row.statement_date || null,
  account: row.account || null,
  checksum: row.checksum,
  files: (row.files || []).map((f) => ({ name: f.name, kind: "csv", text: f.text })),
  stored: true,
});
