/*
 * Fetching Orient's daily statements from Gmail, so they do not have to be downloaded by hand.
 *
 * READ ONLY, AND STRUCTURALLY SO. The only scope asked for is gmail.readonly, and there is
 * deliberately no function in this file that deletes, archives, labels, forwards or sends
 * anything. The trader's mailbox is theirs; RAMP reads three attachments a day out of it and
 * touches nothing else. Adding a write here would need a wider scope at the consent screen,
 * which is the point: the limit is enforced by Google, not by good intentions.
 *
 * EVERYTHING RUNS IN THE BROWSER. The access token lives in memory for the page and is never
 * sent to our server or stored. The zips go straight from Gmail into the same openStatementZip()
 * path a dragged-in file takes — still encrypted, still opened with a password the trader types.
 * No statement, and no password, passes through anything of ours.
 *
 * This file finds and fetches. It does not open, parse or save: statements.js already does that,
 * and a zip from Gmail is not a different kind of zip.
 */

// Read only. Nothing here needs more, and asking for more would be asking to be trusted with it.
export const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";

// Orient sends from several addresses — marketing, notices, the Phoenix portal's one-time codes.
// Only this one carries statements, and matching the exact address rather than "no-reply" keeps
// the other four out.
export const ORIENT_SENDER = "no-reply@mail.orientfutures.com.sg";

/*
 * What arrives, and what we take.
 *
 * Daily, three a day: the group statement and one per sub-account. The group's Financial Summary
 * holds a row for every account in the family — readFinancialSummary() returns them all, and
 * checkFamily() proves the main account is its sub-accounts added up — so the group file alone is
 * the whole day. Taking the per-account ones as well would be the same day's money twice.
 *
 * Monthly, four at month end: the group's statement, one per sub-account, and the group's GST
 * invoice. Those are PDFs inside their zips and openMonthlyPdf() reads them, so they are wanted
 * too, and they do not overlap the daily figures — they are a different statement, not a restatement.
 */
export const KINDS = {
  DAILY_GROUP: "daily-group",
  DAILY_ACCOUNT: "daily-account",
  MONTHLY_GROUP: "monthly-group",
  MONTHLY_ACCOUNT: "monthly-account",
  MONTHLY_GST: "monthly-gst",
};

// The default set. Daily: the group file only. Monthly: all of them.
export const WANTED = new Set([KINDS.DAILY_GROUP, KINDS.MONTHLY_GROUP, KINDS.MONTHLY_ACCOUNT, KINDS.MONTHLY_GST]);

/*
 * "Orient Futures International (Singapore) Pte. Ltd. - Client Daily Statement - 0011 - 20261110"
 *                                                       └── what ──────────────┘  └acct┘ └─date─┘
 *
 * Returns { kind, account, date } — account null on a group statement, date "YYYY-MM-DD".
 * Anything that is not a statement subject returns null, so an unexpected mail is passed over
 * rather than guessed at.
 *
 * Orient reissues corrections as "… 20260930 version 2". The suffix is ignored here: it is the
 * same account and the same date, and it is a different file, so the checksum tells the two apart
 * downstream. Rejecting it on the date would throw away the correction and keep the wrong figures.
 */
export function classifySubject(subject) {
  const s = String(subject || "");
  const date = subjectDate(s);
  if (!date) return null;

  const gst = /Group\s+Monthly\s+GST\s+Statement/i.test(s);
  const monthly = /Monthly\s+Statement/i.test(s);
  const daily = /Daily\s+Statement/i.test(s);
  const group = /Client\s+Group\s+/i.test(s);
  if (!gst && !monthly && !daily) return null;

  // " - 0011 - 20261110": the account sits between the last two dashes, before the date.
  const m = s.match(/ - (\w+) - \d{8}\b/);
  const account = m && !/^\d{8}$/.test(m[1]) ? m[1] : null;

  const kind = gst ? KINDS.MONTHLY_GST
    : monthly ? (group && !account ? KINDS.MONTHLY_GROUP : KINDS.MONTHLY_ACCOUNT)
    : (group && !account ? KINDS.DAILY_GROUP : KINDS.DAILY_ACCOUNT);

  return { kind, account, date };
}

/*
 * The last eight-digit run that is a real date wins — the same rule statements.js uses on the
 * zip's own name, so a subject and its attachment never disagree about which day they are.
 */
export function subjectDate(text) {
  const runs = String(text || "").match(/(?<!\d)\d{8}(?!\d)/g) || [];
  for (const r of runs.reverse()) {
    const y = +r.slice(0, 4), m = +r.slice(4, 6), d = +r.slice(6, 8);
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (y >= 2000 && y <= 2100 && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d) {
      return `${r.slice(0, 4)}-${r.slice(4, 6)}-${r.slice(6, 8)}`;
    }
  }
  return null;
}

/*
 * The Gmail search. Narrow on purpose: one sender, must carry an attachment.
 *
 * `since` is a "YYYY-MM-DD" and becomes Gmail's after:YYYY/MM/DD, which is inclusive of that day.
 * Note it filters on the day the MAIL ARRIVED, and a statement arrives the morning after the day
 * it covers — so a caller wanting everything since a statement date should ask for the day before
 * at the earliest. Callers that just want "everything" pass nothing.
 */
export function statementQuery({ since } = {}) {
  const parts = [`from:${ORIENT_SENDER}`, "has:attachment"];
  if (since) parts.push(`after:${String(since).replace(/-/g, "/")}`);
  return parts.join(" ");
}

// A zip, and not one of the other things a broker attaches.
export const isStatementAttachment = (name) => /\.zip$/i.test(String(name || ""));

/*
 * Which of the messages found are worth fetching, newest first.
 *
 * `have` is the set of checksums already stored. It cannot be used here — a checksum is of the
 * file, and the file has not been downloaded yet — so this only narrows by kind and date, and the
 * real duplicate check stays where it belongs, on the bytes, in mergeStatements(). What this does
 * save is downloading a hundred megabytes to discard it.
 */
export function wantedMessages(messages, { wanted = WANTED, since = null } = {}) {
  return (messages || [])
    .map((m) => ({ ...m, meta: classifySubject(m.subject) }))
    .filter((m) => m.meta && wanted.has(m.meta.kind))
    .filter((m) => !since || m.meta.date >= since)
    .sort((a, b) => (a.meta.date < b.meta.date ? 1 : a.meta.date > b.meta.date ? -1 : 0));
}

/* ------------------------------------------------------------------ *
 * The calls. Thin on purpose: everything above is testable without a
 * network, and these are the only three lines that need one.
 * ------------------------------------------------------------------ */

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

async function get(token, path) {
  const r = await fetch(`${API}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (r.status === 401 || r.status === 403) {
    throw Object.assign(new Error("Gmail turned the request down. Connect Gmail again."), { code: "GMAIL_AUTH" });
  }
  if (!r.ok) throw Object.assign(new Error(`Gmail said ${r.status}.`), { code: "GMAIL_HTTP", status: r.status });
  return r.json();
}

// Message ids matching the query. Paged: Orient sends three a day, so a year is over a thousand.
export async function listMessageIds(token, query, { max = 500 } = {}) {
  const ids = [];
  let pageToken = null;
  do {
    const q = new URLSearchParams({ q: query, maxResults: "100" });
    if (pageToken) q.set("pageToken", pageToken);
    const page = await get(token, `/messages?${q}`);
    for (const m of page.messages || []) ids.push(m.id);
    pageToken = page.nextPageToken || null;
  } while (pageToken && ids.length < max);
  return ids.slice(0, max);
}

// Subject and attachment list only — metadata, not bodies. Nothing of the email's text is read.
export async function messageHeads(token, ids) {
  const out = [];
  for (const id of ids) {
    const m = await get(token, `/messages/${id}?format=metadata&metadataHeaders=Subject`);
    const subject = (m.payload?.headers || []).find((h) => h.name === "Subject")?.value || "";
    const parts = [];
    const walk = (p) => {
      if (!p) return;
      if (p.filename && p.body?.attachmentId && isStatementAttachment(p.filename)) {
        parts.push({ filename: p.filename, attachmentId: p.body.attachmentId });
      }
      (p.parts || []).forEach(walk);
    };
    walk(m.payload);
    if (parts.length) out.push({ id, subject, attachments: parts });
  }
  return out;
}

// Gmail returns attachments base64url-encoded. Comes back as a File so it is the same thing the
// drop zone produces, and openStatementZip() cannot tell the difference.
export async function fetchAttachment(token, messageId, att) {
  const a = await get(token, `/messages/${messageId}/attachments/${att.attachmentId}`);
  const b64 = String(a.data || "").replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], att.filename, { type: "application/zip" });
}
