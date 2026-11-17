/*
 * One file that holds everything, so a bad day is an inconvenience rather than a loss.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS IN IT
 * ---------------------------------------------------------------------------
 * Three things, which is all RAMP keeps:
 *
 *   settings     one object: brokers and their products, risk limits, marks, spreads,
 *                cash, the daily history and the display preferences
 *   fills        every fill, as imported
 *   statements   every broker statement opened, as the CSV text inside its zip
 *
 * The zip also carries readable copies — fills.csv and a folder of the statement CSVs —
 * but they are for a human with a spreadsheet. Restoring reads nexus-backup.json and
 * nothing else, so there is exactly one authoritative copy of every figure in the file
 * and no way for the two to disagree.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS NOT IN IT
 * ---------------------------------------------------------------------------
 * The original password-protected zips. RAMP never stores them — it keeps the CSV text it
 * read out of them (supabase/migrations/0013_statements.sql) and leaves the zips in the
 * trader's own mail. A restore therefore gives back every figure, not the original files.
 *
 * No password, of any kind. Not the statement passwords, which are never stored anywhere,
 * and not the account's. A backup is a file that gets copied to a laptop and a drive, and
 * a password in it would be a password in all three places.
 *
 * ---------------------------------------------------------------------------
 * RESTORING ADDS; IT NEVER DELETES
 * ---------------------------------------------------------------------------
 * Fills are unique on (user_id, broker, ref) and statements on (user_id, checksum), and
 * both are written with ignoreDuplicates, so restoring the same file twice changes nothing
 * the second time and restoring an old file alongside newer work keeps the newer work.
 * Nothing in a restore removes a row.
 *
 * Settings are the one exception and cannot be merged: it is a single object, and half of
 * last month's brokers mixed with half of this month's is a configuration nobody chose. So
 * restoring settings REPLACES them, and the caller has to ask for it deliberately.
 *
 * The identifiers a row carries in one account (its id, its user_id) are stripped, so a
 * backup restores into a new account as readily as the one it came from — which is the
 * case that matters, because "the account is gone" is why a backup exists.
 */

export const BACKUP_VERSION = 1;
export const BACKUP_FILE = "nexus-backup.json";
export const README_FILE = "README.txt";

// Written by the account, not kept from it: a restore must not carry one account's keys
// into another, and nothing downstream needs them.
const STRIP = ["id", "user_id", "created_at", "inserted_at"];
const without = (row, keys = STRIP) => {
  const out = {};
  for (const [k, v] of Object.entries(row || {})) if (!keys.includes(k)) out[k] = v;
  return out;
};

/*
 * The backup object. Plain data, no Blob and no DOM, so it can be built and checked
 * without a browser.
 */
export function buildBackup({ settings = null, fills = [], statements = [], label = "", now = new Date() } = {}) {
  const f = (fills || []).map((r) => without(r));
  const s = (statements || []).map((r) => without(r));
  return {
    format: "nexus-ramp-backup",
    version: BACKUP_VERSION,
    takenAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    label: String(label || ""),
    // Counts are written down as well as implied, so a truncated file is caught on reading
    // rather than restored as though it were whole.
    counts: { fills: f.length, statements: s.length, settings: settings ? 1 : 0 },
    settings: settings || null,
    fills: f,
    statements: s,
  };
}

/*
 * Read a backup back. Strict: anything wrong means `backup` is null and `problems` says
 * what, because a half-read backup restored over a working account is the one outcome
 * worse than having no backup at all.
 */
export function readBackup(text) {
  let b;
  try { b = typeof text === "string" ? JSON.parse(text) : text; }
  catch (e) { return { backup: null, problems: [`This file isn't readable as a backup: ${e.message}`] }; }
  if (!b || typeof b !== "object") return { backup: null, problems: ["This file isn't a RAMP backup."] };
  if (b.format !== "nexus-ramp-backup") return { backup: null, problems: ["This file isn't a RAMP backup — it has no RAMP backup marker in it."] };

  const problems = [];
  if (!Number.isInteger(b.version) || b.version < 1) problems.push("The backup does not say which version it is.");
  if (b.version > BACKUP_VERSION) problems.push(`This backup was written by a newer version of RAMP (backup version ${b.version}, this one reads ${BACKUP_VERSION}). Update RAMP, then restore it.`);
  for (const k of ["fills", "statements"]) if (!Array.isArray(b[k])) problems.push(`The backup's "${k}" is missing or is not a list.`);
  if (problems.length) return { backup: null, problems };

  // The counts it wrote down against what it actually carries.
  const c = b.counts || {};
  if (Number.isInteger(c.fills) && c.fills !== b.fills.length) problems.push(`The backup says it holds ${c.fills} fills but carries ${b.fills.length}. It looks incomplete, so nothing has been restored.`);
  if (Number.isInteger(c.statements) && c.statements !== b.statements.length) problems.push(`The backup says it holds ${c.statements} statements but carries ${b.statements.length}. It looks incomplete, so nothing has been restored.`);
  if (problems.length) return { backup: null, problems };

  return {
    backup: {
      ...b,
      settings: b.settings ?? null,
      fills: b.fills.map((r) => without(r)),
      statements: b.statements.map((r) => without(r)),
    },
    problems: [],
  };
}

// What a backup holds, for showing somebody before they act on it.
export function backupSummary(backup) {
  if (!backup) return null;
  const dates = backup.statements.map((s) => s.statement_date).filter(Boolean).sort();
  const times = backup.fills.map((f) => f.ts).filter(Boolean).sort();
  const brokers = [...new Set(backup.fills.map((f) => f.broker).filter(Boolean))].sort();
  return {
    takenAt: backup.takenAt || null,
    label: backup.label || "",
    fills: backup.fills.length,
    statements: backup.statements.length,
    settings: !!backup.settings,
    brokers,
    statementDates: dates.length ? { from: dates[0], to: dates[dates.length - 1] } : null,
    fillDates: times.length ? { from: String(times[0]).slice(0, 10), to: String(times[times.length - 1]).slice(0, 10) } : null,
  };
}

/*
 * What restoring this file would actually change, worked out against what is here now.
 *
 * Counted the same way the database counts: a fill is the same fill when its broker and ref
 * match, a statement when its checksum matches. So the figures shown before a restore are
 * the figures the restore produces, rather than an optimistic "N rows in file".
 */
export function restorePlan(backup, current = {}) {
  if (!backup) return null;
  const haveFills = new Set((current.fills || []).map((f) => `${f.broker}|${f.ref}`));
  const haveStmts = new Set((current.statements || []).map((s) => s.checksum));
  const newFills = backup.fills.filter((f) => !haveFills.has(`${f.broker}|${f.ref}`));
  const newStatements = backup.statements.filter((s) => !haveStmts.has(s.checksum));
  return {
    newFills: newFills.length,
    sameFills: backup.fills.length - newFills.length,
    newStatements: newStatements.length,
    sameStatements: backup.statements.length - newStatements.length,
    // Settings replace rather than merge, so whether they differ is worth knowing before.
    hasSettings: !!backup.settings,
    settingsDiffer: !!backup.settings && JSON.stringify(backup.settings) !== JSON.stringify(current.settings ?? null),
    nothingToDo: newFills.length === 0 && newStatements.length === 0,
  };
}

// A file name that sorts by date and says what it is.
export const backupName = (now = new Date(), label = "") =>
  `nexus-backup-${(now instanceof Date ? now : new Date(now)).toISOString().slice(0, 10)}${label ? `-${String(label).replace(/\W+/g, "-")}` : ""}.zip`;

/* ------------------------------------------------------------------ *
 * The readable copies. Not read back — see the header.
 * ------------------------------------------------------------------ */

const csvCell = (v) => {
  const s = v === null || v === undefined ? "" : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export function rowsToCsv(rows) {
  if (!rows?.length) return "";
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  return [cols.join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n");
}

export function readmeText(summary) {
  const s = summary || {};
  return [
    "RAMP backup",
    "===========",
    "",
    `Taken: ${s.takenAt || "unknown"}`,
    `Fills: ${s.fills ?? 0}${s.fillDates ? ` (${s.fillDates.from} to ${s.fillDates.to})` : ""}`,
    `Statements: ${s.statements ?? 0}${s.statementDates ? ` (${s.statementDates.from} to ${s.statementDates.to})` : ""}`,
    `Settings: ${s.settings ? "included" : "not included"}`,
    "",
    "To restore: open RAMP, go to Settings, and use 'Restore from backup'.",
    "Pick THIS ZIP FILE as it is — do not unzip it first.",
    "",
    `Everything RAMP reads is in ${BACKUP_FILE}. The other files here are readable`,
    "copies for a spreadsheet, and are ignored when restoring.",
    "",
    "Restoring adds; it never deletes. Fills and statements already present are left",
    "alone, so restoring an old backup cannot undo newer work. Settings are the one",
    "thing that replaces rather than merges, and RAMP asks before touching them.",
    "",
    "This file contains NO passwords — not the statement passwords, not your account",
    "password. It does contain your positions and balances, so keep it somewhere you",
    "would keep a broker statement.",
    "",
    "The original password-protected statement zips are not in here: RAMP keeps the",
    "figures it read out of them, not the files. Those stay in your mail.",
  ].join("\n");
}

/* ------------------------------------------------------------------ *
 * The zip itself. Needs a browser, so it is loaded only when used —
 * the same way statements.js loads it for reading.
 * ------------------------------------------------------------------ */

export async function backupZip(backup) {
  const { ZipWriter, BlobWriter, TextReader } = await import("@zip.js/zip.js");
  const summary = backupSummary(backup);
  const zip = new ZipWriter(new BlobWriter("application/zip"));
  const add = (name, text) => zip.add(name, new TextReader(text));

  await add(BACKUP_FILE, JSON.stringify(backup, null, 2));
  await add(README_FILE, readmeText(summary));
  if (backup.fills.length) await add("readable/fills.csv", rowsToCsv(backup.fills));

  // One folder per statement, named so two zips from the same day cannot collide.
  const used = new Set();
  for (const st of backup.statements) {
    let base = `readable/statements/${(st.zip_name || st.checksum || "statement").replace(/\.zip$/i, "").replace(/[\\/:*?"<>|]+/g, "_")}`;
    let folder = base, n = 2;
    while (used.has(folder)) folder = `${base} (${n++})`;
    used.add(folder);
    for (const f of st.files || []) {
      if (typeof f?.text !== "string") continue;
      await add(`${folder}/${String(f.name || "file.csv").replace(/[\\/:*?"<>|]+/g, "_")}`, f.text);
    }
  }
  return zip.close();
}

/*
 * Read a backup out of what the trader picked: the zip as downloaded, or the bare
 * nexus-backup.json for somebody who unzipped it first. Both work, because telling
 * somebody mid-emergency that they picked the wrong file helps nobody.
 */
export async function readBackupFile(file) {
  const name = String(file?.name || "");
  if (/\.json$/i.test(name)) return readBackup(await file.text());
  const { ZipReader, BlobReader, TextWriter } = await import("@zip.js/zip.js");
  let entries;
  try {
    const reader = new ZipReader(new BlobReader(file));
    entries = await reader.getEntries();
  } catch (e) {
    return { backup: null, problems: [`That file could not be opened as a backup zip: ${e.message}`] };
  }
  const entry = entries.find((e) => !e.directory && e.filename.split("/").pop() === BACKUP_FILE);
  if (!entry) return { backup: null, problems: [`That zip has no ${BACKUP_FILE} in it, so it isn't a RAMP backup.`] };
  return readBackup(await entry.getData(new TextWriter()));
}
