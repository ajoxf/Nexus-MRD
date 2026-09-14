import React, { useState, useEffect, useMemo, useRef, useCallback, createContext, useContext } from "react";
import { db, isRemote, auth } from "./lib/db.js";
import { computeBook, withCommission } from "./lib/positions.js";
import { runScenario, breakingMove } from "./lib/scenario.js";
import { isOptionSymbol } from "./lib/options.js";
import { accessState, hasAccess, canStartTrial, daysLeft, LOCKED_COPY } from "./lib/access.js";
import { normaliseCode, looksLikeCode, CODE_REFUSAL_COPY } from "./lib/codes.js";
import { normaliseRef, looksLikeRef, refStillValid, describeTerms } from "./lib/affiliates.js";
import { authErrorCopy } from "./lib/auth-errors.js";
import { reconstructionDays, buildSeries, snapshotRows, mergeSnapshot, endOfDay, dayKey, METRICS, valueOf, realizedByDay, winLossByDay, tradedByDay } from "./lib/history.js";
import { FIELDS, parseCsvFile, parsePastedText, guessMapping, rowsToFills, classifyFills, estimateSizes, ORIENT_TEMPLATE_CSV, MT5_TEMPLATE_CSV } from "./lib/csv.js";

// ---------- defaults ----------
const ORIENT_PRODUCTS = {
  BZ_CL: { size: 1000, margin: 2500, lev: "", note: "Brent/WTI spread" },
  HO_CL: { size: 1000, margin: 35700, lev: "", note: "Heating oil crack" },
  CL_CL: { size: 1000, margin: 3483, lev: "", note: "WTI calendar spread" },
};
const NEW_BROKER = { method: "leverage", leverage: 100, capital: 100000, callRatio: 100, stopRatio: 50, currency: "USD", products: {} };
const DEFAULT_SETTINGS = {
  limits: { minRatio: 200, maxRiskPct: 2, dailyLossPct: 5, maxTrades: 10, includeRealized: true },
  brokers: [
    { id: "orient", name: "Orient", method: "fixed", leverage: 100, capital: 500000, callRatio: 100, stopRatio: 50, currency: "USD", products: ORIENT_PRODUCTS },
    { id: "mt5", name: "MT5", method: "leverage", leverage: 100, capital: 100000, callRatio: 100, stopRatio: 50, currency: "USD", products: {} },
  ],
  marks: {},
  view: "all",
  scenario: { target: "min", defV: 5, defUnit: "%", moves: {}, openOnly: true },
  cash: [],
  statement: {},
  // One row per broker account per day, written live. See lib/history.js.
  history: [],
};
const LEVERAGES = [10, 20, 25, 30, 50, 100, 200, 300, 400, 500];

// Upgrades settings saved by earlier versions (one account) to broker accounts.
function migrate(s) {
  const D = DEFAULT_SETTINGS;
  if (!s) return JSON.parse(JSON.stringify(D));
  // Accounts stored before currencies existed were all in dollars, which is what the
  // figures in them mean — so USD is a statement about the data, not a default.
  const withCurrency = (list) => list.map((b) => ({ ...b, currency: b.currency || "USD" }));
  if (s.brokers) return { limits: { ...D.limits, ...s.limits }, brokers: withCurrency(s.brokers), marks: s.marks || {}, view: s.view || "all", scenario: { ...D.scenario, ...(s.scenario || {}) }, cash: s.cash || [], statement: s.statement || {}, history: s.history || [] };
  const A = s.account || {};
  return {
    limits: { ...D.limits, ...Object.fromEntries(Object.entries(A).filter(([k]) => k in D.limits)) },
    brokers: [{ id: "default", name: A.broker || "Main account", method: A.method || "fixed", leverage: A.leverage || 100, capital: A.capital ?? 500000, callRatio: A.callRatio ?? 100, stopRatio: A.stopRatio ?? 50, currency: "USD", products: s.products || ORIENT_PRODUCTS }],
    marks: Object.fromEntries(Object.entries(s.marks || {}).map(([p, v]) => [`default|${p}`, v])),
    view: "all",
    scenario: { ...D.scenario },
    cash: [],
    statement: {},
    history: [],
  };
}

// ---------- helpers ----------
const n = (v) => (v === "" || v === null || v === undefined || isNaN(+v) ? 0 : +v);
const has = (v) => v !== "" && v !== null && v !== undefined && !isNaN(+v);
/*
 * Money, in the currency of whatever account is on screen.
 *
 * DISPLAY.cur is set once per render by Tracker, from the selected account. It is a module
 * variable rather than a prop because money() is called at 103 sites across 22 components,
 * and threading a currency through all of them is 103 chances to miss one — a missed one
 * shows a rupee figure with a dollar sign on it, silently, which is the exact failure this
 * is here to prevent. There is one Tracker, it writes this in its own body before any
 * child renders, and nothing else ever writes it.
 *
 * Mixing currencies in one figure is not a formatting problem and is not solved here: see
 * `mixedCurrency` below, which removes the combined view rather than mis-labelling it.
 */
const DISPLAY = { cur: "USD" };
const SYMBOLS = { USD: "$", INR: "₹", EUR: "€", GBP: "£", JPY: "¥", AUD: "A$", CAD: "C$", CHF: "CHF ", SGD: "S$", AED: "AED ", HKD: "HK$", CNY: "CN¥" };
const symbolFor = (cur) => SYMBOLS[cur] || (cur ? `${cur} ` : "$");
const money = (v, cur = DISPLAY.cur) =>
  v === null || v === undefined || !isFinite(v)
    ? "—"
    : (v < 0 ? "-" : "") + symbolFor(cur) + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
const signed = (v, cur = DISPLAY.cur) => (v === null || v === undefined || !isFinite(v) ? "—" : (v > 0 ? "+" : "") + money(v, cur));

/*
 * Do these accounts use more than one currency?
 *
 * When they do there is no honest "all brokers" figure: adding rupees to dollars produces
 * a number that looks authoritative and means nothing, and somebody could size a position
 * on it. Rather than suppress that figure in the dozens of places it appears, the combined
 * view itself is withdrawn — one rule instead of dozens of exceptions.
 */
const currenciesOf = (brokers) => [...new Set((brokers || []).map((b) => b.currency || "USD"))];
const mixedCurrency = (brokers) => currenciesOf(brokers).length > 1;
const pct = (v) => (isFinite(v) ? (v * 100).toFixed(1) + "%" : "—");
const ratioTxt = (r) => (isFinite(r) ? (r * 100).toFixed(0) + "%" : "—");
const px = (v) => (isFinite(v) ? (+v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 }) : "—");
const qty = (v) => String(+(+v).toFixed(4));
// Holding time in the unit a trader would say it in: minutes, hours, then days.
const holdTxt = (h) => {
  if (h === null || !isFinite(h)) return "—";
  if (h < 1) return `${Math.round(h * 60)} min`;
  if (h < 24) return `${h.toFixed(1)} h`;
  return `${(h / 24).toFixed(1)} d`;
};
const dt = (s) => new Date(s).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
const isToday = (s) => new Date(s).toDateString() === new Date().toDateString();
const pc = (v) => (v >= 0 ? "ok" : "bad");
const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
const basis = (b) => (b.method === "leverage" ? `Leverage 1:${n(b.leverage)}` : "Broker margin / lot");

// How closing fills are matched: explicit setting, else FIFO for futures brokers, average for leverage (MT5) accounts.
const matchOf = (b) => b?.match || (b?.method === "leverage" ? "average" : "fifo");

// Downloads every fill as CSV (used as a backup before deleting anything).
function downloadBackup(fills, brokers, label = "all") {
  const bname = (id) => brokers.find((b) => b.id === id)?.name || id;
  const esc = (v) => (/[",\n]/.test(String(v ?? "")) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
  const lines = ["Date,Broker,Symbol,Side,Qty,Price,Fee,Fill ID,Position,Account,Source"];
  [...fills].sort((a, b) => new Date(a.ts) - new Date(b.ts)).forEach((x) => lines.push([x.ts, bname(x.broker), x.product, x.side, +x.qty, +x.price, +x.fee || 0, x.ref, x.position || "", x.account || "", x.source || ""].map(esc).join(",")));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `nexus_backup_${label}_${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
}
// Asks once — offering the backup in the same breath — then runs the delete.
async function safeDelete({ fills, brokers, label, what, run, ask }) {
  if (!fills.length) return false;
  const n = fills.length;
  const { ok, checked } = await ask({
    title: `Delete ${what}?`,
    body: `${n} fill${n === 1 ? "" : "s"} will be removed. Positions, closed trades and P&L are worked out from these fills, so they will change.`,
    detail: "This cannot be undone from inside Nexus. The backup is a CSV you can import again.",
    checkbox: { label: "Download a CSV backup first", defaultChecked: true },
    confirmLabel: `Delete ${n} fill${n === 1 ? "" : "s"}`,
    tone: "danger",
  });
  if (!ok) return false;
  if (checked) downloadBackup(fills, brokers, label);
  await run();
  return true;
}

// Funding per account: if the ledger has entries for an account, its equity base is net deposits;
// otherwise the Capital typed in Settings is used (older setups).
export const CHARGE_TYPES = ["Market data", "Platform / technology", "Exchange & clearing fees", "Commission (not in fills)", "Interest", "Other"];
// Number of monthly charges from the start date up to today (or the stop date): the start month counts once.
function monthsCharged(c, now = new Date()) {
  const s = new Date(c.ts), e = c.endTs ? new Date(Math.min(new Date(c.endTs), now)) : now;
  if (e < s) return 0;
  return (e.getFullYear() - s.getFullYear()) * 12 + (e.getMonth() - s.getMonth()) + (e.getDate() >= s.getDate() ? 1 : 0);
}
const chargeTotal = (c, now = new Date()) => n(c.amount) * (c.recurring === "monthly" ? monthsCharged(c, now) : 1);

// Funding per account: deposits − withdrawals is the equity base once the ledger has entries
// (otherwise the Capital typed in Settings). Charges (market data, platform…) reduce equity separately.
function funding(settings, brokerId, now = new Date()) {
  const list = (settings.cash || []).filter((c) => c.broker === brokerId);
  const dep = sum(list.filter((c) => c.type === "deposit"), (c) => n(c.amount));
  const wd = sum(list.filter((c) => c.type === "withdrawal"), (c) => n(c.amount));
  const charges = sum(list.filter((c) => c.type === "charge"), (c) => chargeTotal(c, now));
  const moneyMoves = list.filter((c) => c.type !== "charge").length > 0;
  const b = settings.brokers.find((x) => x.id === brokerId);
  return { list, dep, wd, charges, net: dep - wd, fromLedger: moneyMoves, base: moneyMoves ? dep - wd : n(b?.capital) };
}

function portfolio(fills, settings, now = new Date()) {
  const { limits: L, brokers: B, marks: M } = settings;
  const byId = Object.fromEntries(B.map((b) => [b.id, b]));
  const book = computeBook(withCommission(fills, byId), (b, p) => n(byId[b]?.products?.[p]?.size) || 1000, (b) => matchOf(byId[b]));
  const minR = n(L.minRatio) / 100;

  const rows = book.open.map((p) => {
    const br = byId[p.broker] || { method: "fixed", products: {}, name: p.broker };
    const spec = br.products?.[p.product] || {};
    const key = `${p.broker}|${p.product}`;
    const dir = p.side === "Long" ? 1 : -1;
    const mark = has(M[key]?.price) ? n(M[key].price) : p.avg;
    const stop = M[key]?.stop, hasStop = has(stop);
    const size = n(spec.size) || 1000;
    const lev = n(spec.lev) || n(br.leverage) || 1;
    const im = br.method === "leverage" ? (Math.abs(p.avg) * size * p.lots) / lev : n(spec.margin) * p.lots;
    const upnl = dir * (mark - p.avg) * size * p.lots;
    const risk = hasStop ? Math.max(0, dir * (mark - n(stop))) * size * p.lots : null;
    return { ...p, key, brokerName: br.name, spec, dir, mark, stop, hasStop, size, lev, im, upnl, risk, notional: Math.abs(mark) * size * p.lots, noMargin: br.method === "fixed" && !n(spec.margin), method: br.method };
  });

  const accounts = B.map((b) => {
    const rs = rows.filter((r) => r.broker === b.id);
    const real = book.realized.filter((r) => r.broker === b.id);
    const IM = sum(rs, (r) => r.im), upnl = sum(rs, (r) => r.upnl);
    const realizedAll = sum(real, (r) => r.pnl), realizedToday = sum(real.filter((r) => isToday(r.ts)), (r) => r.pnl);
    const fund = funding(settings, b.id, now);
    const TNE = fund.base + upnl + (L.includeRealized || fund.fromLedger ? realizedAll : 0) - fund.charges;
    const callR = n(b.callRatio) / 100, stopR = n(b.stopRatio) / 100;
    return {
      ...b, capital: fund.base, fund, rows: rs, IM, upnl, realizedAll, realizedToday, TNE, callR, stopR,
      ratio: IM > 0 ? TNE / IM : Infinity,
      lossToCall: IM > 0 ? TNE - IM * callR : TNE,
      freeIM: (minR > 0 ? TNE / minR : TNE) - IM,
      riskCap: fund.base * n(L.maxRiskPct) / 100,
      // This account's own share, in its own currency. Used when there is no honest
      // combined figure to fall back on.
      dailyCap: fund.base * n(L.dailyLossPct) / 100,
      notional: sum(rs, (r) => r.notional),
      totalRisk: sum(rs, (r) => r.risk || 0),
    };
  });
  const acct = (id) => accounts.find((a) => a.id === id);
  const capital = sum(B, (b) => funding(settings, b.id, now).base);
  const withPos = accounts.filter((a) => a.IM > 0);
  const weakest = withPos.length ? withPos.reduce((w, a) => (a.ratio < w.ratio ? a : w)) : null;
  const realizedToday = sum(accounts, (a) => a.realizedToday), upnl = sum(accounts, (a) => a.upnl);
  return {
    book, rows, accounts, acct, weakest, minR, capital,
    total: {
      TNE: sum(accounts, (a) => a.TNE), IM: sum(accounts, (a) => a.IM), upnl, realizedToday,
      realizedAll: sum(accounts, (a) => a.realizedAll), todayPnl: realizedToday + upnl,
      notional: sum(accounts, (a) => a.notional), totalRisk: sum(accounts, (a) => a.totalRisk),
      lossToCall: withPos.length ? Math.min(...withPos.map((a) => a.lossToCall)) : null,
    },
    /*
     * Null when the desk holds more than one currency: this is a percentage of combined
     * capital, and combined capital does not exist across currencies. Every reader below
     * falls back to the selected account's own cap, which does.
     */
    dailyCap: mixedCurrency(B) ? null : capital * n(L.dailyLossPct) / 100,
  };
}

// Builds scenario inputs for one broker account and runs it.
function scenarioFor(pf, settings, b) {
  const S = settings.scenario, M = settings.marks;
  const acc = pf.acct(b.id);
  const target = S.target === "call" ? acc.callR : S.target === "stop" ? acc.stopR : pf.minR;
  const prods = Object.entries(b.products || {}).map(([product, spec]) => {
    const key = `${b.id}|${product}`;
    const row = pf.rows.find((r) => r.key === key);
    const pos = row ? (row.side === "Long" ? row.lots : -row.lots) : 0;
    const mark = row ? row.mark : has(M[key]?.price) ? n(M[key].price) : null;
    const mv = S.moves[key] || { v: S.defV, unit: S.defUnit };
    // On a flat product you can say which way you're thinking of trading, so the
    // stressed price and the loss are worked out for that side rather than both.
    // A plan only counts while its instrument is one of the ones you've picked. Leaving lots
    // typed on something you later deselected must not quietly weigh on the account.
    // A real position always counts, picked or not — you can't untick your way out of risk.
    const picked = Array.isArray(S.pick) ? S.pick : null;
    const considered = picked ? picked.includes(key) : !!pos;
    const plan = !pos && considered && (M[key]?.dir === "long" || M[key]?.dir === "short") ? M[key].dir : null;
    return { key, product, spec, pos, mark, move: mv, plan, planLots: M[key]?.lots, isOption: isOptionSymbol(product) };
  });
  // An option's premium does not move with the underlying one for one, so
  // stressing it the way a future is stressed gives an answer that is not
  // just imprecise but an order of magnitude out. Until it can be repriced
  // properly, options are left out of the stress and named instead.
  const optionsOn = prods.filter((p) => p.isOption && (p.pos || n(p.planLots) > 0));
  const stressed = prods.filter((p) => !p.isOption);
  const res = runScenario(b, acc, stressed, target);
  const st = statusOf(res.ratio, acc, pf.minR);
  return { acc, target, res, st, optionsOn,
    minMove: breakingMove(b, acc, stressed, pf.minR),
    callMove: breakingMove(b, acc, stressed, acc.callR),
    stopMove: breakingMove(b, acc, stressed, acc.stopR) };
}
const moveTxt = (x) => (x === null ? "No open positions"
  : Number.isNaN(x) ? "Enter a current price"
  : !isFinite(x) ? "Not reachable"
  : x === 0 ? "Already there"
  : `${x.toFixed(1)}% against you`);

const statusOf = (ratio, acc, minR) =>
  !isFinite(ratio) || !acc ? { cls: "dim", t: "Flat" } :
  ratio <= acc.stopR ? { cls: "bad", t: "Stop-out" } :
  ratio <= acc.callR ? { cls: "bad", t: "Margin call" } :
  ratio < minR ? { cls: "warn", t: "Below minimum" } : { cls: "ok", t: "Healthy" };

// ---------- icons ----------
const Icon = ({ d }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
const ICONS = {
  dash: <Icon d={<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>} />,
  scen: <Icon d={<><path d="M3 3v18h18" /><path d="M7 15l4-4 3 3 6-7" /><path d="M20 7v4h-4" /></>} />,
  fills: <Icon d={<><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="3.5" cy="6" r="1" /><circle cx="3.5" cy="12" r="1" /><circle cx="3.5" cy="18" r="1" /></>} />,
  closed: <Icon d={<><path d="M3 7h18v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" /><path d="M2 3h20v4H2zM10 12h4" /></>} />,
  analysis: <Icon d={<><path d="M3 3v18h18" /><path d="M7 15l4-5 3 3 5-7" /><circle cx="11" cy="10" r="1.2" /><circle cx="14" cy="13" r="1.2" /></>} />,
  funds: <Icon d={<><rect x="2" y="6" width="20" height="13" rx="2" /><path d="M2 10h20M6 15h4" /><path d="M16 3l3 3-3 3" /></>} />,
  settings: <Icon d={<><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" /></>} />,
};

/*
 * A password field you can look at.
 *
 * Typing a long password blind, into a field that shows only dots, is how people
 * end up locked out of an account whose password they know perfectly well. The
 * eye is a button rather than a decorated span so it is reachable by keyboard,
 * and it says which state it will move you to rather than which state you are in.
 *
 * It starts hidden every time. Remembering "shown" across a page load would leave
 * somebody's password on screen in an office, which is the thing a password field
 * exists to prevent.
 */
function PasswordField({ value, onChange, autoComplete, autoFocus }) {
  const [shown, setShown] = useState(false);
  return (
    <div className="pw-wrap">
      <input className="in" type={shown ? "text" : "password"} required
        autoComplete={autoComplete} autoFocus={autoFocus}
        value={value} onChange={onChange} />
      <button type="button" className="pw-eye" onClick={() => setShown((v) => !v)}
        aria-label={shown ? "Hide password" : "Show password"} title={shown ? "Hide password" : "Show password"}>
        {shown ? (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M3 3l18 18" />
            <path d="M10.6 5.2A9.7 9.7 0 0 1 12 5c5 0 9 4.5 10 7a15 15 0 0 1-3.2 4.1" />
            <path d="M6.2 6.7A15.2 15.2 0 0 0 2 12c1 2.5 5 7 10 7a9.9 9.9 0 0 0 4.3-1" />
            <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2" />
          </svg>
        ) : (
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}

// Google's own mark, in Google's own colours. Drawn rather than fetched: the
// sign-in screen must not depend on a third party's server being up.
const GoogleMark = () => (
  <svg width="17" height="17" viewBox="0 0 18 18" aria-hidden="true">
    <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.91c1.7-1.57 2.69-3.88 2.69-6.62z" />
    <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.91-2.26c-.81.54-1.84.86-3.05.86-2.35 0-4.34-1.58-5.05-3.71H.96v2.33A9 9 0 0 0 9 18z" />
    <path fill="#FBBC05" d="M3.95 10.71a5.41 5.41 0 0 1 0-3.42V4.96H.96a9 9 0 0 0 0 8.08l2.99-2.33z" />
    <path fill="#EA4335" d="M9 3.58c1.32 0 2.51.45 3.44 1.35l2.58-2.59C13.46.89 11.43 0 9 0A9 9 0 0 0 .96 4.96l2.99 2.33C4.66 5.16 6.65 3.58 9 3.58z" />
  </svg>
);

const F = ({ label, hint, children }) => <label className="f">{label}{children}{hint && <small>{hint}</small>}</label>;
const Side = ({ s }) => <span className={`side ${s === "Long" || s === "Buy" ? "long" : "short"}`}>{s}</span>;

// =====================================================================
/*
 * Referral capture: the link, then the claim.
 *
 * Two moments, minutes or weeks apart, and the gap between them is the whole problem. The
 * link is opened by somebody with no account — there is nobody to attribute anything to
 * yet. The account appears later, on a different page, often after a round trip through a
 * confirmation email that drops every query string on the way.
 *
 * So the code is parked in localStorage when the link is opened and claimed once an
 * account exists. Not a cookie: this is one device remembering one click for its own use,
 * it is never sent to anybody but our own endpoint, and it does not need to survive being
 * read by a third party's script.
 */
const REF_STORE = "nexus:ref";

/** The parked code, if there is one and it has not gone stale. */
function storedRef() {
  try {
    const parked = JSON.parse(localStorage.getItem(REF_STORE) || "null");
    if (!parked || !looksLikeRef(parked.code)) return null;
    /*
     * Checked here as well as on the server. The server is the one that decides — this
     * only stops us posting a claim we already know is a month past the window.
     */
    if (!refStillValid(parked.at)) { localStorage.removeItem(REF_STORE); return null; }
    return parked;
  } catch { return null; }
}

function useReferralCapture(user) {
  // Half one: somebody arrived on a link.
  useEffect(() => {
    const code = normaliseRef(new URLSearchParams(window.location.search).get("ref"));
    if (!looksLikeRef(code)) return;

    /*
     * First touch wins here too, before the server ever sees it. Someone who clicked
     * Cameron's link in March and Dale's in April belongs to Cameron, and overwriting the
     * parked code would quietly hand the credit to whoever sent the most recent email.
     */
    if (!storedRef()) {
      try { localStorage.setItem(REF_STORE, JSON.stringify({ code, at: new Date().toISOString() })); } catch { /* private mode; the visit still counts */ }
    }

    // Recorded as a visit. Fire and forget: a referral nobody can count is a small loss,
    // a sign-in page that will not load because an analytics call failed is a large one.
    fetch("/api/ref", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    }).catch(() => {});

    /*
     * Out of the address bar once it is stored.
     *
     * A ?ref= that lingers gets bookmarked, pasted into chat and shared around, and every
     * person who follows that copy is credited to an affiliate who never spoke to them.
     */
    const url = new URL(window.location.href);
    url.searchParams.delete("ref");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }, []);

  // Half two: there is now an account to attach it to.
  useEffect(() => {
    if (!user || !isRemote) return;
    const parked = storedRef();
    if (!parked) return;

    let cancelled = false;
    (async () => {
      try {
        const r = await fetch("/api/ref", {
          method: "POST",
          headers: await authHeader(),
          body: JSON.stringify({ code: parked.code, capturedAt: parked.at }),
        });
        const body = await r.json().catch(() => ({}));
        /*
         * Cleared when the question is settled either way — claimed, or already belonging
         * to somebody else. Left in place only if the request itself failed, so a flaky
         * connection on signup day does not cost the affiliate the sale.
         */
        if (!cancelled && r.ok && (body.claimed || body.reason === "already_attributed" || body.known === false)) {
          localStorage.removeItem(REF_STORE);
        }
      } catch { /* try again next sign-in */ }
    })();
    return () => { cancelled = true; };
  }, [user?.id]);
}

export default function App() {
  const [user, setUser] = useState(undefined);
  // Set when you arrive from a password-reset email: the link has already signed
  // you in, so show "choose a new password" rather than the desk.
  const [recovering, setRecovering] = useState(false);
  /*
   * The address bar is the router.
   *
   * A router library would be four hundred kilobytes to tell two paths apart. This reads
   * which path was asked for, and the back button keeps working.
   *
   * It only works because vercel.json rewrites every path that is not an endpoint to
   * index.html — without that, /admin is a file Vercel does not have and it answers 404.
   * The negative lookahead on api/ in that rewrite is what keeps the serverless functions
   * reachable; swallow those and every endpoint returns this HTML page instead.
   *
   * That file cannot carry a comment of its own: JSON has none, and Vercel rejects a
   * rewrite object with an unknown key — which is exactly how /admin 404'd the first time
   * it shipped. scripts/vercel-check.mjs now fails the build for it instead.
   */
  const [path, setPath] = useState(() => window.location.pathname.replace(/\/+$/, "") || "/");
  useEffect(() => {
    const on = () => setPath(window.location.pathname.replace(/\/+$/, "") || "/");
    window.addEventListener("popstate", on);
    return () => window.removeEventListener("popstate", on);
  }, []);

  useEffect(() => {
    /*
     * A session arriving from the portal is claimed before we ask who is signed in —
     * otherwise the first answer is "nobody" and the sign-in page flashes up over a
     * session that was already valid.
     */
    let cancelled = false;
    auth.adoptSessionFromUrl().then((adopted) => {
      if (adopted && !cancelled) {
        window.history.replaceState(null, "", window.location.pathname + window.location.search);
      }
      if (!cancelled) db.getUser().then(setUser);
    });

    const stop = auth.onAuthChange((u, event) => {
      setUser(u);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });

    return () => { cancelled = true; stop(); };
  }, []);

  // Before any early return: hooks have to run in the same order every render.
  useReferralCapture(user);

  /*
   * Copy the sign-up details into the CRM table, once, after signing in.
   *
   * It cannot happen at sign-up: there is no session then, and `customers` is writable by
   * nobody but the server. So the details wait in user metadata until there is a token to
   * prove who they belong to, which is the first authenticated load — usually straight
   * after the confirmation link.
   *
   * Failure is swallowed on purpose. A name that did not sync is a row to tidy up later;
   * it is never a reason to stand between somebody and their own book.
   */
  useEffect(() => {
    if (!user || !isRemote) return;
    auth.syncProfile().catch(() => {});
  }, [user?.id]);

  if (user === undefined) return <div className="auth dim">Loading Nexus…</div>;
  if (recovering) return <SignInPage><NewPassword onDone={() => setRecovering(false)} /></SignInPage>;
  if (!user) return <SignInPage><SignIn /></SignInPage>;
  /*
   * /admin is checked before the subscription gate, not after.
   *
   * An operator's own subscription is beside the point — somebody has to be able to fix a
   * billing problem while their own trial is expired, and locking the admin screens behind
   * the paywall is how a business locks itself out of its own controls.
   */
  if (path.startsWith("/admin")) return <ConfirmHost><AdminPage key={user.id} user={user} path={path} /></ConfirmHost>;
  return <ConfirmHost><Gate key={user.id} user={user} /></ConfirmHost>;
}

/*
 * The operator's screen, at /admin.
 *
 * Subscriptions only — who signed up, what they hold, and the controls to change it by
 * hand. It shows no fills, no positions and no figure from anybody's book. Running the
 * business does not need that, and helping yourself to a customer's trading because you
 * happen to own the database is the kind of thing that has to be disclosed before it is
 * built, not discovered afterwards.
 */
/*
 * The tabs. Reports and Sections from the research admin have no meaning here — Nexus
 * publishes nothing — and everything else does.
 */
const ADMIN_TABS = [
  { path: "/admin", label: "Overview" },
  { path: "/admin/customers", label: "Customers" },
  { path: "/admin/usage", label: "Usage" },
  { path: "/admin/codes", label: "Codes" },
  { path: "/admin/payments", label: "Payments" },
  { path: "/admin/affiliates", label: "Affiliates" },
];

function AdminPage({ user, path }) {
  const [allowed, setAllowed] = useState(undefined);
  const [rows, setRows] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch("/api/admin/customers", { headers: await authHeader() });
      if (r.status === 403) { setAllowed(false); return; }
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not load the accounts.");
      setAllowed(true);
      setRows(body.customers);
    } catch (e) { setErr(e.message); setAllowed(true); }
  }, []);

  useEffect(() => { db.isAdmin().then((ok) => { if (!ok) setAllowed(false); else load(); }); }, [load]);

  const setSub = async (row, status, endsAt) => {
    setBusy(row.id); setErr(null);
    try {
      const r = await fetch("/api/admin/subscription", {
        method: "POST",
        headers: await authHeader(),
        body: JSON.stringify({ userId: row.id, status, currentPeriodEnd: endsAt || null }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not save that.");
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(null); }
  };

  if (allowed === undefined) return <div className="auth dim">Checking…</div>;

  /*
   * A plain "not found", not "you are not an admin".
   *
   * Telling somebody the page exists and they are not important enough is an invitation to
   * keep trying. It also says nothing about who is.
   */
  if (allowed === false) return (
    <SignInPage>
      <div className="signin-card">
        <h2>Nothing here</h2>
        <p className="lede">That page does not exist for this account.</p>
        <a className="btn full" href="/">Back to the desk</a>
      </div>
    </SignInPage>
  );

  const tab = ADMIN_TABS.find((t) => t.path === path) ?? ADMIN_TABS[0];
  const go = (to) => (e) => {
    e.preventDefault();
    // pushState rather than a reload: the admin data is already in hand, and refetching it
    // to change tab is a spinner nobody asked for. popstate in App puts the back button back.
    window.history.pushState(null, "", to);
    window.dispatchEvent(new PopStateEvent("popstate"));
  };

  return (
    <div className="admin">
      <header className="admin-top">
        <div className="admin-brand">
          {/* The same mark as the sign-in page. An operator moving between the two should
              not have to check which product they are looking at. */}
          <div className="admin-mark" aria-hidden="true">N</div>
          <div className="admin-titles">
            <h1>Nexus admin</h1>
            <p className="dim">Subscriptions, payments, codes and usage. No customer's trading is shown here.</p>
          </div>
        </div>
        <div className="admin-who">
          <span className="dim">{user.email}</span>
          <a className="btn ghost" href="/">Back to the desk</a>
        </div>
      </header>

      <nav className="admin-tabs" aria-label="Admin sections">
        {ADMIN_TABS.map((t) => (
          <a key={t.path} href={t.path} onClick={go(t.path)}
            aria-current={t.path === tab.path ? "page" : undefined}>{t.label}</a>
        ))}
      </nav>

      {err && <div className="signin-err" style={{ margin: "0 0 12px" }}>{err}</div>}

      {/*
        * A failed load is not a slow one.
        *
        * The tab bodies below read `rows === null` as "still loading" and say so. That is
        * right until a load FAILS, at which point rows stays null for good and the screen
        * shows a red error above the word "Loading…" — telling somebody it is broken and
        * still working in the same breath. The tabs stand down while there is nothing to
        * show and something to say instead.
        */}
      {err && !rows ? (
        <section className="panel">
          <div className="pb">
            <p className="dim" style={{ marginTop: 0 }}>
              Nothing could be loaded, so there is nothing to show here. The tabs will fill in
              once the problem above is fixed.
            </p>
            {/* "Server is not configured" has exactly one cause and it is worth naming, because
                the fix is in a dashboard rather than anywhere a person would think to look. */}
            {err.includes("not configured") && (
              <p className="dim" style={{ fontSize: 12 }}>
                This one means the server is missing <b>SUPABASE_URL</b> and{" "}
                <b>SUPABASE_SERVICE_ROLE_KEY</b>. They are set in the hosting dashboard, not in
                this application, and a deploy has to follow before they take effect. Neither
                may carry a <b>VITE_</b> prefix — that would publish the service key to every
                browser.
              </p>
            )}
            <button className="btn" onClick={load}>Try again</button>
          </div>
        </section>
      ) : (
        <>
      {tab.path === "/admin" && <AdminOverview rows={rows} onRefresh={load} />}
      {tab.path === "/admin/customers" && <AdminCustomers rows={rows} busy={busy} onSet={setSub} onSaved={load} onRefresh={load} />}
      {tab.path === "/admin/usage" && <AdminUsage rows={rows} />}
      {tab.path === "/admin/codes" && <AdminCodes />}
      {tab.path === "/admin/payments" && <AdminPayments />}
      {tab.path === "/admin/affiliates" && <AdminAffiliates />}
        </>
      )}
    </div>
  );
}

/*
 * The numbers somebody opens this page to see.
 *
 * All of them come from the one fetch the page already made — a separate endpoint per tile
 * would be four round trips to count rows that are already in the browser.
 */
function AdminOverview({ rows, onRefresh }) {
  if (!rows) return <div className="panel"><div className="pb dim">Loading…</div></div>;

  const live = rows.filter((r) => hasAccess(r.sub));
  const trialing = rows.filter((r) => accessState(r.sub) === "trialing");
  const paying = rows.filter((r) => accessState(r.sub) === "active");
  const cold = trialing.filter((r) => r.fills === 0);
  const lapsed = rows.filter((r) => ["trial_over", "lapsed", "canceled"].includes(accessState(r.sub)));
  const nothing = rows.filter((r) => accessState(r.sub) === "none");
  // Soonest to run out, ignoring the open-ended: a comp with no end date is not "next".
  const ending = live
    .filter((r) => r.sub?.current_period_end)
    .sort((a, b) => new Date(a.sub.current_period_end) - new Date(b.sub.current_period_end))
    .slice(0, 5);
  const day = (v) => new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" });

  return (
    <>
      <section className="panel">
        <div className="ph">
          <h2>Where things stand</h2>
          <button className="btn ghost" onClick={onRefresh}>Refresh</button>
        </div>
        {/*
          * The desk's dense KPI strip is right where screen space is contested. Here there
          * is space, and these figures are the reason somebody opened the page — so they
          * get room, a consistent label, and a line of context underneath where the bare
          * number would otherwise need explaining.
          */}
        <div className="admin-metrics">
          <div className="metric"><label>Accounts</label><b>{rows.length}</b>
            <span className="sub">Every sign-up, ever</span></div>
          <div className="metric"><label>With access</label><b className={live.length ? "ok" : "faint"}>{live.length}</b>
            <span className="sub">Trialing, paying or comped</span></div>
          <div className="metric"><label>Paying</label><b className={paying.length ? "ok" : "faint"}>{paying.length}</b>
            <span className="sub">On a live subscription</span></div>
          <div className="metric"><label>On trial</label><b>{trialing.length}</b>
            <span className="sub">{cold.length > 0 ? `${cold.length} imported nothing yet` : "All have imported fills"}</span></div>
          <div className="metric"><label>Lapsed</label><b className={lapsed.length ? "bad" : "faint"}>{lapsed.length}</b>
            <span className="sub">Had access, no longer do</span></div>
          <div className="metric"><label>Never held</label><b className="faint">{nothing.length}</b>
            <span className="sub">Signed up, took nothing</span></div>
        </div>
      </section>

      {cold.length > 0 && (
        <section className="panel">
          <div className="ph"><h2>Trials that have not started<span className="dim">{cold.length}</span></h2>
            <span className="faint" style={{ fontSize: 11 }}>Live trial, no fills imported — the ones to ring</span></div>
          <div className="tw"><table>
            <thead><tr><th className="txt">Customer</th><th>Days left</th><th>Signed up</th></tr></thead>
            <tbody>{cold.map((r) => (
              <tr key={r.id}>
                <td className="txt">{r.crm?.full_name || r.email}</td>
                <td className="num">{daysLeft(r.sub) ?? "—"}</td>
                <td className="num">{day(r.createdAt)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        </section>
      )}

      <section className="panel">
        <div className="ph"><h2>Running out next</h2><span className="sub">Soonest first</span></div>
        {/* Outside the table for the same reason as the invoices one: .tw scrolls, and a
            centred cell inside it centres on the table rather than the screen. */}
        {ending.length === 0 ? (
          <div className="admin-empty">
            <b>Nothing is running out</b>
            No account has an end date — open-ended access does not appear here.
          </div>
        ) : (
        <div className="tw"><table>
          <thead><tr><th className="txt">Customer</th><th className="txt">Holds</th><th>Runs until</th><th>Days left</th></tr></thead>
          <tbody>
            {ending.map((r) => (
              <tr key={r.id}>
                <td className="txt">{r.crm?.full_name || r.email}</td>
                {/* Trialing and active both mean "has access", but only one of them is
                    revenue. Colouring them the same makes a page of trials read like a
                    page of customers. */}
                <td className="txt"><span className={`pill ${accessState(r.sub) === "active" ? "ok" : "dim"}`}>{accessState(r.sub)}</span></td>
                <td className="num">{day(r.sub.current_period_end)}</td>
                <td className="num">{daysLeft(r.sub) ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
        )}
      </section>
    </>
  );
}

/*
 * How hard each account is using the product. Counts and dates only.
 *
 * The question this answers is "is this one real" — somebody with four thousand fills
 * across three brokers is running their book here and will notice if it breaks; somebody
 * with eleven from a fortnight ago is not, whatever their subscription says.
 */
function AdminUsage({ rows }) {
  if (!rows) return <div className="panel"><div className="pb dim">Loading…</div></div>;
  const day = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" }) : "—");
  const ranked = [...rows].sort((a, b) => b.fills - a.fills);

  return (
    <section className="panel">
      <div className="ph">
        <h2>Usage<span className="dim">counts and dates only</span></h2>
        <span className="faint" style={{ fontSize: 11 }}>No fill, price, size or position is shown</span>
      </div>
      <div className="tw"><table>
        <thead><tr>
          <th className="txt">Customer</th><th>Fills</th><th>Brokers</th><th>Products</th>
          <th>First trade</th><th>Last trade</th><th>Last import</th><th>Last seen</th>
        </tr></thead>
        <tbody>
          {ranked.map((r) => {
            const u = r.usage;
            return (
              <tr key={r.id}>
                <td className="txt">{r.crm?.full_name || r.email}</td>
                <td className="num">{r.fills ? r.fills.toLocaleString() : <span className="faint">none</span>}</td>
                <td className="num">{u ? Number(u.brokers) : "—"}</td>
                <td className="num">{u ? Number(u.products) : "—"}</td>
                <td className="num">{day(u?.first_fill)}</td>
                <td className="num">{day(u?.last_fill)}</td>
                <td className="num">{day(u?.last_import)}</td>
                <td className="num">{day(r.lastSignInAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table></div>
    </section>
  );
}

function AdminCustomers({ rows, busy, onSet, onSaved, onRefresh }) {
  return (
    <section className="panel">
      <div className="ph">
        <h2>Customers<span className="dim">{rows ? rows.length : ""}</span></h2>
        <button className="btn ghost" onClick={onRefresh}>Refresh</button>
      </div>
      <div className="tw">
        <table>
          <thead><tr>
            <th className="txt">Customer</th><th className="txt">Stage</th><th className="txt">Access</th>
            <th>Runs until</th><th>Fills</th><th>Signed up</th><th>Last seen</th><th className="txt">Change</th>
          </tr></thead>
          <tbody>
            {!rows && <tr><td colSpan={8} className="dim">Loading…</td></tr>}
            {rows && rows.length === 0 && <tr><td colSpan={8} className="dim">No accounts yet.</td></tr>}
            {rows?.map((row) => <AdminRow key={row.id} row={row} busy={busy === row.id} onSet={onSet} onSaved={onSaved} />)}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/*
 * Issue and track access codes.
 *
 * A code is a promise of access rather than access itself: the days it grants start when it
 * is redeemed, not when it is issued. So it carries two lifetimes — how long it stays
 * redeemable, and how much it buys — and conflating them is how somebody ends up with a
 * code that expired before they opened the email.
 */
function AdminCodes() {
  const [codes, setCodes] = useState(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);
  const [d, setD] = useState({ count: 1, grantsDays: 365, validityDays: 30, email: "", note: "" });
  const set = (k) => (e) => setD((x) => ({ ...x, [k]: e.target.value }));

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/codes", { headers: await authHeader() });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not read the codes.");
      setCodes(body.codes);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const issue = async () => {
    setBusy(true); setErr(null); setMade(null);
    try {
      const r = await fetch("/api/admin/codes", {
        method: "POST", headers: await authHeader(),
        body: JSON.stringify({
          count: Number(d.count), grantsDays: Number(d.grantsDays),
          // Blank means never expires, and that is a choice rather than an omission —
          // sent as an explicit null so the server does not fill in a default.
          validityDays: String(d.validityDays).trim() === "" ? null : Number(d.validityDays),
          email: d.email, note: d.note,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not issue those codes.");
      setMade(body.codes);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const day = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" }) : "—");
  const live = (codes ?? []).filter((c) => !c.redeemed_at).length;

  return (
    <section className="panel">
      <div className="ph">
        <h2>Access codes<span className="dim">{codes ? `${live} unused of ${codes.length}` : ""}</span></h2>
        <button className="btn ghost" onClick={() => setOpen((v) => !v)}>{open ? "Close" : "Issue codes"}</button>
      </div>

      {open && (
        <div className="pb admin-issue">
          <div className="fg c2">
            <F label="How many" hint="Up to 50 at a time"><input className="in" type="number" min="1" max="50" value={d.count} onChange={set("count")} /></F>
            <F label="Days of access each grants" hint="Starts when redeemed, not now"><input className="in" type="number" min="1" value={d.grantsDays} onChange={set("grantsDays")} /></F>
            <F label="Code expires in (days)" hint="Blank never expires"><input className="in" type="number" min="1" value={d.validityDays} onChange={set("validityDays")} /></F>
            <F label="Issued to (optional)"><input className="in" type="email" value={d.email} onChange={set("email")} placeholder="them@firm.com" /></F>
          </div>
          <F label="Note (optional)" hint="Who it went to and why. Internal."><input className="in" value={d.note} onChange={set("note")} /></F>
          {err && <div className="signin-err">{err}</div>}
          <div className="admin-set">
            <button className="btn" disabled={busy} onClick={issue}>{busy ? "Issuing…" : "Issue"}</button>
          </div>
          {made && (
            <div className="admin-made">
              <p className="dim">Issued. Copy them now — they are listed below too.</p>
              <textarea className="in" readOnly rows={Math.min(6, made.length)} value={made.join("\n")}
                onFocus={(e) => e.target.select()} />
            </div>
          )}
        </div>
      )}

      <div className="tw">
        <table>
          <thead><tr>
            <th className="txt">Code</th><th>Grants</th><th>Expires</th>
            <th className="txt">Issued to</th><th className="txt">Status</th><th>Issued</th>
          </tr></thead>
          <tbody>
            {!codes && <tr><td colSpan={6} className="dim">Loading…</td></tr>}
            {codes?.length === 0 && <tr><td colSpan={6} className="dim">No codes yet.</td></tr>}
            {codes?.map((c) => (
              <tr key={c.code}>
                <td className="txt num">{c.code}</td>
                <td className="num">{c.grants_days}d</td>
                {/* Blank is "never", said in words so nobody reads it as a missing value. */}
                <td className="num">{c.expires_at ? day(c.expires_at) : <span className="faint">never</span>}</td>
                <td className="txt">{c.issued_to_email || <span className="faint">{c.note || "—"}</span>}</td>
                <td className="txt">
                  {c.redeemed_at
                    ? <span className="pill ok">used · {c.redeemed_email || "—"}</span>
                    : <span className="pill dim">unused</span>}
                </td>
                <td className="num">{day(c.created_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

/*
 * The affiliate programme.
 *
 * Three questions on one screen, because they are asked together: who is sending people,
 * whether those people convert, and what is owed as a result. The rewards table underneath
 * is the ledger — it is what somebody gets paid from, so it shows the rate that applied at
 * the time rather than the rate on the affiliate today.
 */
function AdminAffiliates() {
  const [data, setData] = useState(null);
  const [open, setOpen] = useState(false);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState(null);

  /*
   * reward_value starts EMPTY, and stays empty until somebody types a number.
   *
   * Not 20, not 10, not a placeholder that looks like a suggestion. The database refuses a
   * rate it was not given and so does the endpoint; prefilling the form would defeat both
   * of them from the one place a person is actually deciding. A rate nobody typed is a
   * commission nobody agreed to pay.
   */
  const BLANK = { name: "", email: "", reward_kind: "percent", reward_value: "", reward_scope: "first", code: "", note: "" };
  const [d, setD] = useState(BLANK);
  const set = (k) => (e) => setD((x) => ({ ...x, [k]: e.target.value }));

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/admin/affiliates", { headers: await authHeader() });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not read the affiliates.");
      setData(body);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const create = async () => {
    setBusy(true); setErr(null); setMade(null);
    try {
      const r = await fetch("/api/admin/affiliates", {
        method: "POST", headers: await authHeader(),
        body: JSON.stringify({
          name: d.name, email: d.email, reward_kind: d.reward_kind,
          // Sent as typed. Empty stays empty so the server can refuse it rather than
          // receiving a 0 this screen invented on the operator's behalf.
          reward_value: String(d.reward_value).trim(),
          reward_scope: d.reward_scope, code: d.code, note: d.note,
        }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not create that affiliate.");
      setMade(body.code);
      setD(BLANK);
      await load();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  const setStatus = async (patch) => {
    setErr(null);
    try {
      const r = await fetch("/api/admin/affiliates", {
        method: "PATCH", headers: await authHeader(), body: JSON.stringify(patch),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not update that.");
      await load();
    } catch (e) { setErr(e.message); }
  };

  const day = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" }) : "—");

  /*
   * Minor units to something readable, in the currency that was recorded with it.
   *
   * Never the desk's display currency: this is what was actually taken, and restating a
   * euro payment in dollars at today's rate would make the ledger disagree with the
   * invoice it came from.
   */
  const minor = (v, cur) => {
    const n = Number(v) || 0;
    if (!cur) return (n / 100).toFixed(2);
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n / 100); }
    catch { return `${cur} ${(n / 100).toFixed(2)}`; }
  };

  const affiliates = data?.affiliates ?? null;
  const rewards = data?.rewards ?? [];
  const live = (affiliates ?? []).filter((a) => a.status === "active").length;

  return (
    <>
      <section className="panel">
        <div className="ph">
          <h2>Affiliates<span className="dim">{affiliates ? `${live} active of ${affiliates.length}` : ""}</span></h2>
          <button className="btn ghost" onClick={() => { setOpen((v) => !v); setErr(null); }}>{open ? "Close" : "New affiliate"}</button>
        </div>

        {open && (
          <div className="pb admin-issue">
            <div className="fg c2">
              <F label="Name"><input className="in" value={d.name} onChange={set("name")} placeholder="Who they are" /></F>
              <F label="Email (optional)" hint="Used to catch self-referrals"><input className="in" type="email" value={d.email} onChange={set("email")} placeholder="them@firm.com" /></F>
              <F label="Reward type">
                <select className="in" value={d.reward_kind} onChange={set("reward_kind")}>
                  <option value="percent">Percentage of the payment</option>
                  <option value="fixed">Fixed amount per conversion</option>
                  <option value="free_months">Free months on their own account</option>
                </select>
              </F>
              <F
                label={d.reward_kind === "percent" ? "Rate (%)" : d.reward_kind === "free_months" ? "Months" : "Amount (minor units)"}
                hint="Required. There is no default."
              >
                <input className="in" type="number" min="0" step="any" value={d.reward_value}
                  onChange={set("reward_value")} placeholder="" />
              </F>
              <F label="Earned on" hint={d.reward_kind === "free_months" ? "Free months are granted once per conversion" : "Every payment means for as long as they keep paying"}>
                <select className="in" value={d.reward_scope} onChange={set("reward_scope")}>
                  <option value="first">The first payment only</option>
                  <option value="recurring">Every payment</option>
                </select>
              </F>
              <F label="Code (optional)" hint="Blank generates one"><input className="in" value={d.code} onChange={set("code")} placeholder="REF-7K4P" /></F>
            </div>
            <F label="Note (optional)" hint="The deal as agreed. Internal."><input className="in" value={d.note} onChange={set("note")} /></F>
            {err && <div className="signin-err">{err}</div>}
            <div className="admin-set">
              <button className="btn" disabled={busy} onClick={create}>{busy ? "Creating…" : "Create affiliate"}</button>
            </div>
            {made && (
              <div className="admin-made">
                <p className="dim">Created. Their link:</p>
                <textarea className="in" readOnly rows={1} value={`${window.location.origin}/?ref=${made}`}
                  onFocus={(e) => e.target.select()} />
              </div>
            )}
          </div>
        )}

        {err && !open && <div className="pb"><div className="signin-err">{err}</div></div>}

        <div className="tw">
          <table>
            <thead><tr>
              <th className="txt">Code</th><th className="txt">Name</th><th className="txt">Terms</th>
              <th>Visits</th><th>Signed up</th><th>Converted</th><th>Owed</th><th>Paid</th>
              <th className="txt">Status</th><th className="txt"></th>
            </tr></thead>
            <tbody>
              {!affiliates && <tr><td colSpan={10} className="dim">Loading…</td></tr>}
              {affiliates?.length === 0 && (
                <tr><td colSpan={10} className="dim">No affiliates yet. Create one and share its link.</td></tr>
              )}
              {affiliates?.map((a) => (
                <tr key={a.code}>
                  <td className="txt num">{a.code}</td>
                  <td className="txt">{a.name}{a.note && <div className="faint" style={{ fontSize: 11 }}>{a.note}</div>}</td>
                  <td className="txt">{describeTerms(a)}</td>
                  <td className="num">{a.counts.visits}</td>
                  <td className="num">{a.counts.signups}</td>
                  <td className="num">{a.counts.conversions}</td>
                  {/* Free months are not money and are not printed as if they were. */}
                  <td className="num">{a.tally.months ? `${a.tally.months} mo` : minor(a.tally.owed, a.currency)}</td>
                  <td className="num">{a.tally.months ? "—" : minor(a.tally.paid, a.currency)}</td>
                  <td className="txt">
                    <span className={`pill ${a.status === "active" ? "ok" : "dim"}`}>{a.status}</span>
                  </td>
                  <td className="txt">
                    <select className="in" value={a.status} onChange={(e) => setStatus({ code: a.code, status: e.target.value })}>
                      <option value="active">active</option>
                      <option value="paused">paused</option>
                      <option value="closed">closed</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="ph">
          <h2>Commission ledger<span className="dim">{rewards.length ? `${rewards.length} entries` : ""}</span></h2>
        </div>
        <div className="tw">
          <table>
            <thead><tr>
              <th>Earned</th><th className="txt">Affiliate</th><th className="txt">Rate applied</th>
              <th>Paid by customer</th><th>Commission</th><th className="txt">For</th><th className="txt">Status</th><th className="txt"></th>
            </tr></thead>
            <tbody>
              {rewards.length === 0 && (
                <tr><td colSpan={8} className="dim">Nothing earned yet. Entries appear when a referred account pays.</td></tr>
              )}
              {rewards.map((r) => (
                <tr key={r.id}>
                  <td className="num">{day(r.created_at)}</td>
                  <td className="txt num">{r.affiliate_code}</td>
                  {/* The rate AS IT WAS, copied into the ledger when this was earned. Changing
                      an affiliate's terms today does not move this number. */}
                  <td className="txt">
                    {r.kind === "percent" ? `${Number(r.rate)}%` : r.kind === "free_months" ? `${Number(r.rate)} months` : minor(r.rate * 100, r.currency)}
                  </td>
                  <td className="num">{r.basis_minor == null ? "—" : minor(r.basis_minor, r.currency)}</td>
                  <td className="num">{r.kind === "free_months" ? `${r.amount_minor} mo` : minor(r.amount_minor, r.currency)}</td>
                  <td className="txt faint">{r.period_ref === "first" ? "first payment" : day(r.period_ref)}</td>
                  <td className="txt">
                    <span className={`pill ${r.status === "paid" ? "ok" : r.status === "void" ? "dim" : ""}`}>{r.status}</span>
                  </td>
                  <td className="txt">
                    <select className="in" value={r.status} onChange={(e) => setStatus({ rewardId: r.id, status: e.target.value })}>
                      <option value="owed">owed</option>
                      <option value="paid">paid</option>
                      <option value="void">void</option>
                    </select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/*
 * Payments, and whether the machinery that takes them is switched on.
 *
 * Both, on one screen, on purpose. "No payments yet" and "nobody could have paid" look
 * identical from an empty table and call for completely different mornings, so this screen
 * refuses to show the table without also showing the wiring.
 *
 * Two sets of books are shown side by side: Stripe's, which is authoritative, and ours,
 * written by the webhook. When they disagree the webhook is the reason, and that is worth
 * being able to see rather than deduce.
 */
function AdminPayments() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const r = await fetch("/api/admin/payments", { headers: await authHeader() });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not read the payments.");
      setData(body);
    } catch (e) { setErr(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const day = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" }) : "—");
  const minor = (v, cur) => {
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    if (!cur) return (n / 100).toFixed(2);
    try { return new Intl.NumberFormat(undefined, { style: "currency", currency: cur }).format(n / 100); }
    catch { return `${cur} ${(n / 100).toFixed(2)}`; }
  };

  if (err) return (
    <section className="panel"><div className="pb">
      <div className="signin-err" style={{ marginBottom: 10 }}>{err}</div>
      <button className="btn" onClick={load}>Try again</button>
    </div></section>
  );
  if (!data) return <section className="panel"><div className="pb dim">Loading…</div></section>;

  const { config, counts, price, payments, totals, stripeError } = data;
  const sc = config.stripe;

  /*
   * The headline verdict, in one sentence, before any number.
   *
   * A secret key with no price id cannot start a checkout; a price id with no webhook
   * secret takes the money and never writes it down. Both are "half configured" and both
   * are worth naming exactly rather than lumping into a red cross.
   */
  const verdict =
    !sc.secretKey && !sc.priceId ? ["off", "Stripe is not connected. Nobody can pay yet."]
    : !sc.secretKey ? ["off", "No secret key. Checkout cannot start."]
    : !sc.priceId ? ["off", "No price set. Checkout has nothing to sell."]
    : !sc.webhookSecret ? ["warn", "Payments can be taken, but nothing will be recorded."]
    : sc.mode === "test" ? ["test", "Connected to Stripe in test mode. No real money moves."]
    : ["on", "Connected to Stripe and taking live payments."];

  return (
    <>
      <section className="panel">
        <div className="ph">
          <h2>Payment setup</h2>
          <div className="admin-set">
            {sc.mode && <span className={`badge ${sc.mode === "live" ? "live" : sc.mode === "test" ? "test" : "neutral"}`}>{sc.mode}</span>}
            {!sc.configured && <span className="badge off">not connected</span>}
            <button className="btn ghost" onClick={load}>Refresh</button>
          </div>
        </div>
        <div className="pb">
          <p style={{ margin: "0 0 12px", fontSize: 13, fontWeight: 600, color: `var(--${verdict[0] === "on" ? "ok" : verdict[0] === "warn" || verdict[0] === "test" ? "warn" : "bad"})` }}>
            {verdict[1]}
          </p>

          <div className="admin-status">
            <div className="row">
              <span className={`dot ${sc.secretKey ? "on" : "off"}`} />
              <div className="what">
                <b>Secret key {sc.secretKey ? "set" : "missing"}</b>
                <span><code>STRIPE_SECRET_KEY</code> — lets the server create a checkout and read what has been paid.</span>
              </div>
            </div>
            <div className="row">
              <span className={`dot ${sc.priceId ? "on" : "off"}`} />
              <div className="what">
                <b>Price {sc.priceId ? "set" : "missing"}</b>
                <span>
                  <code>STRIPE_PRICE_ID</code> — what a subscription costs.{" "}
                  {price ? <>Currently <b>{minor(price.amount_minor, price.currency)}</b> per {price.intervalCount > 1 ? `${price.intervalCount} ` : ""}{price.interval}{price.product ? ` · ${price.product}` : ""}.</>
                    : "Held on the server so a price cannot be sent from a browser."}
                </span>
              </div>
            </div>
            <div className="row">
              <span className={`dot ${sc.webhookSecret ? "on" : "warn"}`} />
              <div className="what">
                <b>Webhook secret {sc.webhookSecret ? "set" : "missing"}</b>
                <span>
                  <code>STRIPE_WEBHOOK_SECRET</code> — how we verify Stripe is really Stripe.
                  {!sc.webhookSecret && " Without it every delivery is refused, so a customer could pay and still not be given access."}
                </span>
              </div>
            </div>
            <div className="row">
              <span className={`dot ${config.email.configured ? "on" : "warn"}`} />
              <div className="what">
                <b>Email {config.email.configured ? "set up" : "not set up"}</b>
                <span>
                  <code>RESEND_API_KEY</code> and <code>NEXUS_EMAIL_FROM</code> — receipts, trial reminders and payment-failure notices.
                  {!config.email.configured && " Nothing is being sent."}
                </span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="panel">
        <div className="ph"><h2>Money<span className="sub">Stripe's record, not ours</span></h2></div>
        <div className="admin-metrics">
          <div className="metric"><label>Recurring / month</label>
            <b className={totals?.mrr_minor ? "ok" : "faint"}>{totals?.mrr_minor != null ? minor(totals.mrr_minor, totals.mrrCurrency) : "—"}</b>
            <span className="sub">{counts.active} active × the plan price. Not a forecast.</span></div>
          <div className="metric"><label>Collected</label>
            <b className={totals?.collected_minor ? "" : "faint"}>
              {totals?.mixedCurrencies ? "mixed" : totals?.collected_minor != null ? minor(totals.collected_minor, totals.collectedCurrency) : "—"}
            </b>
            <span className="sub">{totals?.shown ? `Across the last ${totals.shown} invoices` : "No invoices yet"}</span></div>
          <div className="metric"><label>Active subs</label><b className={counts.active ? "ok" : "faint"}>{counts.active}</b>
            <span className="sub">{counts.onStripe} linked to Stripe</span></div>
          <div className="metric"><label>Past due</label><b className={counts.past_due ? "bad" : "faint"}>{counts.past_due}</b>
            <span className="sub">Payment failed, still in retry</span></div>
          <div className="metric"><label>Trialing</label><b>{counts.trialing}</b>
            <span className="sub">Not yet paying</span></div>
          <div className="metric"><label>Cancelled</label><b className="faint">{counts.canceled}</b>
            <span className="sub">Were paying, stopped</span></div>
        </div>
      </section>

      <section className="panel">
        <div className="ph">
          <h2>Recent invoices<span className="sub">{payments.length ? `${payments.length} most recent` : ""}</span></h2>
        </div>
        {stripeError && <div className="pb"><div className="signin-err" style={{ margin: 0 }}>{stripeError}</div></div>}

        {/*
          * The empty state sits OUTSIDE the table, not in a cell spanning it.
          *
          * .tw scrolls horizontally so a wide table survives a phone, and anything inside
          * it inherits that width — a centred message in a colspan cell ends up centred on
          * the TABLE and half off the screen. Measured at 390px, where it was clipped.
          */}
        {payments.length === 0 ? (
          <div className="admin-empty">
            {!sc.configured
              ? <><b>No payments, because payment is not switched on</b>
                  The code is all here — checkout, the billing portal and the webhook.
                  It needs the keys above before anybody can pay.</>
              : <><b>No invoices yet</b>
                  Stripe is connected and working. Nobody has been billed so far.</>}
          </div>
        ) : (
        <div className="tw">
          <table>
            <thead><tr>
              <th>Date</th><th className="txt">Invoice</th><th className="txt">Customer</th>
              <th>Amount</th><th>Paid</th><th className="txt">For</th><th className="txt">Status</th><th className="txt"></th>
            </tr></thead>
            <tbody>
              {payments.map((r) => (
                <tr key={r.id}>
                  <td className="num">{day(r.created)}</td>
                  <td className="txt num">{r.number || "—"}</td>
                  <td className="txt">{r.email || <span className="faint">—</span>}</td>
                  <td className="num">{minor(r.amount_due_minor, r.currency)}</td>
                  <td className="num">{minor(r.amount_paid_minor, r.currency)}</td>
                  <td className="txt faint">{r.reason === "subscription_create" ? "first payment" : r.reason === "subscription_cycle" ? "renewal" : r.reason || "—"}</td>
                  <td className="txt">
                    <span className={`pill ${r.status === "paid" ? "ok" : r.status === "open" ? "warn" : r.status === "uncollectible" || r.status === "void" ? "bad" : "dim"}`}>{r.status || "—"}</span>
                  </td>
                  <td className="txt">
                    {/* Stripe's own hosted invoice. Opening the real thing beats reproducing it badly. */}
                    {r.url ? <a href={r.url} target="_blank" rel="noreferrer noopener">View</a> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        )}
      </section>
    </>
  );
}

function AdminRow({ row, busy, onSet, onSaved }) {
  const [open, setOpen] = useState(false);
  const sub = row.sub;
  const state = accessState(sub);
  const live = hasAccess(sub);
  const [status, setStatus] = useState(sub?.status ?? "none");
  const [ends, setEnds] = useState(sub?.current_period_end ? sub.current_period_end.slice(0, 10) : "");
  const day = (v) => (v ? new Date(v).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "2-digit" }) : "—");
  const left = daysLeft(sub);

  /*
   * A trial with nothing imported is the one to ring.
   *
   * Eleven days into fourteen with no fills is somebody who never got started, and no
   * subscription row shows that. It is the single most useful thing on this screen.
   */
  const cold = state === "trialing" && row.fills === 0;

  return (
    <>
      <tr className={cold ? "admin-cold" : undefined}>
        <td className="txt">
          <button className="linklike admin-name" onClick={() => setOpen((v) => !v)}>
            {row.crm?.full_name || row.email}
          </button>
          {row.crm?.firm && <div className="faint">{row.crm.firm}</div>}
          {row.crm?.full_name && <div className="faint">{row.email}</div>}
        </td>
        <td className="txt"><span className="pill dim">{(row.crm?.stage ?? "new").replace("_", " ")}</span></td>
        <td className="txt">
          <span className={`pill ${live ? "ok" : state === "none" ? "dim" : "bad"}`}>{state.replace("_", " ")}</span>
        </td>
        <td className="num">
          {/* Blank is open-ended, not missing. Said in words so nobody reads it as a gap. */}
          {sub?.current_period_end ? day(sub.current_period_end) : (live ? "Open-ended" : "—")}
          {left !== null && <span className="faint"> · {left}d</span>}
        </td>
        <td className="num">
          {row.fills === 0 ? <span className={cold ? "bad" : "faint"}>none</span> : row.fills.toLocaleString()}
        </td>
        <td className="num">{day(row.createdAt)}</td>
        <td className="num">{day(row.lastSignInAt)}</td>
        <td className="txt">
          <div className="admin-set">
            <select className="cell" value={status} onChange={(e) => setStatus(e.target.value)} aria-label={`Access for ${row.email}`}>
              {["none", "trialing", "active", "past_due", "canceled"].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
            <input className="cell" type="date" value={ends} onChange={(e) => setEnds(e.target.value)}
              title="Leave blank for open-ended" aria-label={`Runs until, for ${row.email}`} />
            <button className="btn" disabled={busy} onClick={() => onSet(row, status, ends ? `${ends}T23:59:59Z` : null)}>
              {busy ? "…" : "Save"}
            </button>
          </div>
        </td>
      </tr>
      {open && <AdminNotes row={row} onSaved={onSaved} onClose={() => setOpen(false)} />}
    </>
  );
}

/*
 * The desk's own notes on somebody. Internal, and the customer has no way to read them:
 * the table has no row level security policy at all, so nothing but the server reaches it.
 */
function AdminNotes({ row, onSaved, onClose }) {
  const crm = row.crm ?? {};
  const [d, setD] = useState({
    fullName: crm.full_name ?? "", firm: crm.firm ?? "", phone: crm.phone ?? "",
    stage: crm.stage ?? "new", notes: crm.notes ?? "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const set = (k) => (e) => setD((x) => ({ ...x, [k]: e.target.value }));

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/admin/customer", {
        method: "POST", headers: await authHeader(),
        body: JSON.stringify({ userId: row.id, ...d }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not save that.");
      await onSaved();
      onClose();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <tr className="admin-notes">
      <td colSpan={8}>
        <div className="admin-notes-in">
          <div className="fg c2">
            <F label="Name"><input className="in" value={d.fullName} onChange={set("fullName")} placeholder="Who you deal with" /></F>
            <F label="Firm"><input className="in" value={d.firm} onChange={set("firm")} /></F>
            <F label="Phone"><input className="in" value={d.phone} onChange={set("phone")} placeholder="+44 …" /></F>
            <F label="Stage" hint="Where they are with you — not the same as whether their subscription is live">
              <select className="in" value={d.stage} onChange={set("stage")}>
                {STAGES.map((v) => <option key={v} value={v}>{v.replace("_", " ")}</option>)}
              </select>
            </F>
          </div>
          <F label="Notes" hint="Internal. The customer cannot see this.">
            <textarea className="in" rows={4} value={d.notes} onChange={set("notes")}
              placeholder="What they trade, what they asked for, what you promised." />
          </F>
          {err && <div className="signin-err">{err}</div>}
          <div className="admin-set">
            <button className="btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save notes"}</button>
            <button className="btn ghost" onClick={onClose}>Close</button>
          </div>
        </div>
      </td>
    </tr>
  );
}

/*
 * Signed in is not the same as subscribed.
 *
 * Nexus decides its own access now, rather than only existing for people NordStar Pro had
 * already vetted. Anyone can hold an account here; what an account holds is a separate
 * question, and this is where it is asked.
 *
 * A refusal never touches the data. Somebody whose trial ran out still owns every fill
 * they imported — they cannot open the desk until they subscribe, and the moment they do
 * it is all exactly where they left it. Saying so on the screen is the difference between
 * a payment prompt and a threat.
 */
function Gate({ user }) {
  const [sub, setSub] = useState(undefined);
  const [err, setErr] = useState(null);

  const reload = useCallback(() => {
    setErr(null);
    db.loadSubscription().then(setSub).catch((e) => { setErr(e.message); setSub(null); });
  }, []);
  useEffect(reload, [reload]);

  if (sub === undefined && !err) return <div className="auth dim">Checking your subscription…</div>;

  /*
   * A failed lookup is not a refusal.
   *
   * If the database cannot be reached, the honest answer is "we could not check", not "you
   * do not have access" — locking a paying customer out of their own book because of a
   * network blip is the worse of the two mistakes by a distance.
   */
  if (err) return (
    <SignInPage>
      <div className="signin-card">
        <h2>Couldn't check your subscription</h2>
        <p className="lede">This is on us, not on your account. Nothing has changed and your data is untouched.</p>
        <div className="signin-err">{err}</div>
        <button className="btn full" onClick={reload}>Try again</button>
        <button type="button" className="linklike" onClick={() => auth.signOut()}>Sign out</button>
      </div>
    </SignInPage>
  );

  if (!hasAccess(sub)) return <Locked user={user} sub={sub} onChanged={reload} />;
  return <Tracker user={user} sub={sub} />;
}

// What somebody sees when they are signed in but hold nothing.
function Locked({ user, sub, onChanged }) {
  const state = accessState(sub);
  const copy = LOCKED_COPY[state] ?? LOCKED_COPY.none;
  const offerTrial = canStartTrial(sub);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const startTrial = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/trial", { method: "POST", headers: await authHeader() });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "That did not work. Please try again.");
      onChanged();
    } catch (e) { setErr(e.message); } finally { setBusy(false); }
  };

  return (
    <SignInPage>
      <div className="signin-card">
        <h2>{copy.title}</h2>
        <p className="lede">{copy.body}</p>
        {err && <div className="signin-err">{err}</div>}

        {offerTrial && (
          <button className="btn full" onClick={startTrial} disabled={busy}>
            {busy ? "Setting it up…" : "Start my 14-day free trial"}
          </button>
        )}
        <Subscribe />

        <div className="signin-or"><span>or use a code</span></div>
        <RedeemCode onDone={onChanged} />

        <p className="note">
          Signed in as {user.email}. Your data is safe either way — nothing here deletes anything.
        </p>
        <button type="button" className="linklike" onClick={() => auth.signOut()}>Sign out</button>
      </div>
    </SignInPage>
  );
}

/*
 * Pay by card.
 *
 * Falls back to an address rather than a dead button: until Stripe is configured the
 * endpoint says so, and somebody who wants to pay gets a way to, instead of a control that
 * does nothing and teaches them the product is half-finished.
 */
function Subscribe() {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const go = async () => {
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/checkout", { method: "POST", headers: await authHeader() });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not start checkout.");
      // Stripe's page, not ours. Card details never touch this application.
      window.location.href = body.url;
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <>
      <button type="button" className="btn full portal-sso" onClick={go} disabled={busy} style={{ marginTop: 8 }}>
        {busy ? "Opening…" : "Subscribe by card"}
      </button>
      {err && <div className="signin-err">{err}</div>}
    </>
  );
}

/*
 * Redeem an access code.
 *
 * The same door whether somebody bought a code, was given one at a meeting, or is coming
 * back after a lapse. Deliberately on this screen and not buried in settings: the person
 * holding a code is by definition somebody who cannot get in yet.
 */
function RedeemCode({ onDone }) {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [ok, setOk] = useState(null);

  const submit = async (e) => {
    e.preventDefault();
    const tidy = normaliseCode(code);
    // Checked here as well as on the server, so an obvious typo costs a glance rather
    // than a round trip. The server checks it again regardless; this is courtesy.
    if (!looksLikeCode(tidy)) { setErr(CODE_REFUSAL_COPY.bad_shape); return; }
    setBusy(true); setErr(null);
    try {
      const r = await fetch("/api/redeem", {
        method: "POST", headers: await authHeader(), body: JSON.stringify({ code: tidy }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "That did not work. Please try again.");
      setOk(body.days);
      await onDone();
    } catch (e2) { setErr(e2.message); } finally { setBusy(false); }
  };

  if (ok) return <p className="note ok">Code accepted — {ok} days of access added.</p>;

  return (
    <form onSubmit={submit} className="redeem">
      <F label="Access code">
        <input className="in" value={code} placeholder="NXS-4KFP-9TQX" autoComplete="off"
          spellCheck={false} onChange={(e) => { setCode(e.target.value); setErr(null); }} />
      </F>
      {err && <div className="signin-err">{err}</div>}
      <button className="btn full" disabled={busy || !code.trim()}>
        {busy ? "Checking…" : "Redeem code"}
      </button>
    </form>
  );
}

/*
 * Proof of who is asking, for our own endpoints.
 *
 * The access token, not a cookie: the browser talks to a serverless function on this
 * domain, which verifies the token with Supabase before writing anything. The row is not
 * writable from here at all, which is the point — the server is the only thing that can
 * grant a trial, so it is the only thing that can be wrong about one.
 */
async function authHeader() {
  const token = await auth.accessToken();
  return { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}

// The desk's front door: navy brand panel beside the form, stacking on a phone.
function SignInPage({ children }) {
  return (
    <div className="signin">
      <aside className="signin-brand">
        <div className="brand-top">
          <div className="mark">N</div>
          <div>
            <h1>Nexus <span>RAMP</span></h1>
            <p className="desk">Risk and Margin Platform</p>
          </div>
        </div>
        <p className="tagline">Know what a move against you costs before you put the trade on.</p>
        <div className="rule" />
        <p className="foot">
          {/* "By invitation" and "start a free trial" cannot both be true on the
              same screen, so the invitation line stands down while the offer is
              open. Both are driven by the one variable. */}
          {/* Fincoursa, not NordStar Pro. They are two products of one company, not one
              product inside the other — which is the whole point of the split. */}
          A Fincoursa product.
        </p>
      </aside>
      <main className="signin-form">{children}</main>
    </div>
  );
}

// Sign-in only: accounts are created by invitation, so there is no sign-up here.
function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [whatsapp, setWhatsapp] = useState("");
  const [mode, setMode] = useState("in");     // "in" | "up" | "forgot"
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (mode === "forgot") { await auth.sendReset(email); setSent(true); }
      else if (mode === "up") { await auth.signUp(email, password, { firstName, lastName, whatsapp }); setSent("up"); }
      else await auth.signIn(email, password);
    } catch (e2) {
      /*
       * Translated rather than passed through. Supabase writes for whoever is building the
       * thing; this is read by somebody trying to get to their book before the open.
       */
      setErr(authErrorCopy(e2.message, mode));
    } finally { setBusy(false); }
  };

  const withGoogle = async () => {
    setBusy(true); setErr(null);
    try { await auth.signInWithGoogle(); }
    // Through the same translator as the email path: `err` is copy here, not a raw string,
    // and a bare message would render an empty red box.
    catch (e2) { setErr(authErrorCopy(e2.message, mode)); setBusy(false); }
  };

  if (sent) return (
    <form className="signin-card" onSubmit={(e) => e.preventDefault()}>
      <h2>Check your email</h2>
      <p className="lede">
        {sent === "up"
          ? <>We've sent a confirmation link to <b>{email}</b>. Open it and you're in.</>
          : <>If an account exists for <b>{email}</b>, a reset link is on its way.</>}
      </p>
      <p className="note">Look in spam if it doesn't arrive within a few minutes.</p>
      <button type="button" className="btn full" onClick={() => { setSent(false); setMode("in"); }}>Back to sign in</button>
    </form>
  );

  return (
    <form className="signin-card" onSubmit={submit}>
      <h2>{mode === "in" ? "Sign in" : mode === "up" ? "Create your account" : "Reset your password"}</h2>
      <p className="lede">
        {mode === "in" ? "Your Nexus RAMP account — nothing else needed."
          : mode === "up" ? "Fourteen days free. No card, and nothing to cancel."
          : "We'll email you a link to set a new password."}
      </p>

      {/* On sign-up as well as sign-in: with Google there is no difference between the
          two — the first time you use it, it makes the account. Offering it only to
          people who already have one is offering it only to people who do not need it.
          Google through Supabase, incidentally, not a hop through another product. */}
      {mode !== "forgot" && (
        <>
          <button type="button" className="btn full google-sso" onClick={withGoogle} disabled={busy}>
            <GoogleMark />Continue with Google
          </button>
          <div className="signin-or"><span>or use your email</span></div>
        </>
      )}

      <F label="Email">
        <input className="in" type="email" autoComplete="username" required autoFocus
          placeholder="you@firm.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </F>
      {mode === "up" && (
        <>
          {/* Two columns: a first and last name are one question, not two, and stacking
              them makes the form look longer than it is. */}
          <div className="fg c2">
            <F label="First name">
              <input className="in" autoComplete="given-name" required
                value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="Dale" />
            </F>
            <F label="Last name">
              <input className="in" autoComplete="family-name" required
                value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Carver" />
            </F>
          </div>
          {/*
            * Optional, and it says why it is being asked rather than just "(optional)".
            * A number given without a reason is a number somebody regrets giving.
            */}
          <F label="WhatsApp number" hint="Optional. Only for account updates — never for marketing, and you can remove it any time.">
            <input className="in" type="tel" autoComplete="tel" inputMode="tel"
              value={whatsapp} onChange={(e) => setWhatsapp(e.target.value)} placeholder="+44 7700 900000" />
          </F>
        </>
      )}
      {mode !== "forgot" && (
        <F label={mode === "up" ? "Choose a password" : "Password"} hint={mode === "up" ? "At least 8 characters." : null}>
          <PasswordField autoComplete={mode === "up" ? "new-password" : "current-password"}
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </F>
      )}
      {/*
        * An error we caused reads differently from one they caused. Same box, different
        * opening — being told to check your details when the fault is at our end is how a
        * customer concludes the product is blaming them for its own outage.
        */}
      {err && (
        <div className="signin-err">
          {err.ours && <b style={{ display: "block", marginBottom: 2 }}>This one is on us.</b>}
          {err.text}
        </div>
      )}
      <button className="btn full" disabled={busy}>
        {busy ? "Please wait…" : mode === "in" ? "Sign in" : mode === "up" ? "Create my account" : "Email me a reset link"}
      </button>
      {mode !== "up" && (
        <button type="button" className="linklike" onClick={() => { setMode(mode === "in" ? "forgot" : "in"); setErr(null); }}>
          {mode === "in" ? "Forgotten your password?" : "Back to sign in"}
        </button>
      )}

      {/*
        Sign-up is here now, not somewhere else.
        ---------------------------------------
        An account used to be something NordStar Pro created for you once you held the
        product, which is why this screen had no way to make one. Nexus owns its own
        accounts, so the door is on the door.
      */}
      {mode === "in" && (
        <p className="signin-trial">
          New to Nexus RAMP?{" "}
          <button type="button" className="linklike signin-inline" onClick={() => { setMode("up"); setErr(null); }}>
            Create an account
          </button>
          {" "}— 14 days free, no card.
        </p>
      )}
      {mode === "up" && (
        <p className="signin-trial">
          Already have one?{" "}
          <button type="button" className="linklike signin-inline" onClick={() => { setMode("in"); setErr(null); }}>
            Sign in instead
          </button>
        </p>
      )}
    </form>
  );
}

/*
 * Nexus signs its own people in.
 *
 * What used to be here: the portal's address, a "Continue with NordStar Pro" button, a
 * Google button that went to NordStar Pro's Google flow rather than ours, and a fetch
 * asking the portal whether a trial was open. All of it existed because identity lived
 * somewhere else and had to be carried across. It does not any more.
 *
 * Nothing on this screen now knows NordStar Pro exists.
 */

// Shown after following a reset link.
function NewPassword({ onDone }) {
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const tooShort = password.length > 0 && password.length < 8;
  const mismatch = again.length > 0 && password !== again;

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try { await auth.setPassword(password); onDone(); }
    catch (e2) { setErr(e2.message); }
    finally { setBusy(false); }
  };

  return (
    <form className="signin-card" onSubmit={submit}>
      <h2>Choose a new password</h2>
      <p className="lede">At least 8 characters.</p>
      <F label="New password">
        <PasswordField autoComplete="new-password" autoFocus
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </F>
      <F label="Repeat it">
        <PasswordField autoComplete="new-password"
          value={again} onChange={(e) => setAgain(e.target.value)} />
      </F>
      {tooShort && <div className="signin-err warn">Too short — use at least 8 characters.</div>}
      {mismatch && <div className="signin-err warn">The two passwords don't match.</div>}
      {err && <div className="signin-err">{err}</div>}
      <button className="btn full" disabled={busy || tooShort || mismatch || !password}>
        {busy ? "Saving…" : "Save password"}
      </button>
    </form>
  );
}

// ---------- phone layout ----------
// On a phone a twelve-column table can't stay a table, so each row becomes a
// card (see .tw in the stylesheet). A figure on its own card means nothing
// without its heading, so every cell borrows the text of the column above it.
// Doing it here rather than in the markup gives it to every table at once,
// including any added later.
function useCardLabels() {
  useEffect(() => {
    for (const t of document.querySelectorAll(".tw table")) {
      const head = t.tHead?.rows[t.tHead.rows.length - 1];
      if (!head) continue;
      const names = [...head.cells].map((c) => c.textContent.trim());
      // Which column names the card. The product is what a trader looks for;
      // where a table has none, the account or instrument does the job.
      let title = names.findIndex((h) => /^product$/i.test(h));
      if (title < 0) title = names.findIndex((h) => /^(broker|instrument|symbol|name|account)$/i.test(h));
      for (const body of t.tBodies) {
        for (const r of body.rows) {
          // Rows that span columns (totals, notes, a spread's legs) have no
          // one heading per cell, so they are left as they are.
          if ([...r.cells].some((c) => c.colSpan > 1)) continue;
          [...r.cells].forEach((c, i) => {
            if (names[i]) c.setAttribute("data-l", names[i]);
            if (i === title) c.setAttribute("data-card-title", "");
          });
        }
      }
    }
  });
}

// ---------- edit, then save ----------
// Settings panels hold what you type until you press Save. A margin on its way
// to 3000 passes through "3", and a figure like that reaching the risk engine
// would show a margin call that isn't real. Save also gives you something to
// press when you are done, and Discard a way back.
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function useDraft(source) {
  const [draft, setDraft] = useState(source);
  const dirty = !same(draft, source);
  const dirtyNow = useRef(dirty);
  dirtyNow.current = dirty;
  // Adopt changes made elsewhere (an import adding products) only while this
  // panel has nothing unsaved of its own.
  useEffect(() => { if (!dirtyNow.current) setDraft(source); }, [source]);
  return [draft, setDraft, dirty, () => setDraft(source)];
}

// Panels with unsaved edits register here so leaving the tab can warn first.
const DirtyCtx = createContext({ mark: () => {} });
function useDirtyFlag(id, dirty) {
  const { mark } = useContext(DirtyCtx);
  useEffect(() => { mark(id, dirty); return () => mark(id, false); }, [id, dirty, mark]);
}

function SaveBar({ dirty, onSave, onDiscard, savedNote }) {
  return (
    <div className={`savebar ${dirty ? "dirty" : ""}`}>
      <span className="state">{dirty ? "Unsaved changes" : savedNote || "No changes to save"}</span>
      <span className="gap" />
      <button type="button" className="btn ghost" disabled={!dirty} onClick={onDiscard}>Discard</button>
      <button type="button" className="btn" disabled={!dirty} onClick={onSave}>Save changes</button>
    </div>
  );
}

// ---------- dialogs ----------
// One place for "are you sure". The browser's own confirm box can't show what is
// about to go, can't offer the backup alongside the question, and looks like a
// script error; this asks properly and returns { ok, checked }.
const ConfirmCtx = createContext(async () => ({ ok: false, checked: false }));
const useConfirm = () => useContext(ConfirmCtx);

function ConfirmHost({ children }) {
  const [q, setQ] = useState(null);
  const ask = useCallback((opts) => new Promise((resolve) => setQ({ ...opts, resolve })), []);
  const close = useCallback((val) => setQ((cur) => { cur?.resolve(val); return null; }), []);
  return (
    <ConfirmCtx.Provider value={ask}>
      {children}
      {q && <ConfirmDialog q={q} close={close} />}
    </ConfirmCtx.Provider>
  );
}

function ConfirmDialog({ q, close }) {
  const [checked, setChecked] = useState(!!q.checkbox?.defaultChecked);
  const go = useRef(null);
  const cancel = () => close({ ok: false, checked: false });
  useEffect(() => { go.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") { e.preventDefault(); close({ ok: false, checked: false }); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);
  return (
    <div className="modal-back" onMouseDown={(e) => { if (e.target === e.currentTarget) cancel(); }}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="dlg-title">
        <div className={`modal-h ${q.tone === "danger" ? "danger" : ""}`}>
          <h3 id="dlg-title">{q.title}</h3>
        </div>
        <div className="modal-b">
          {q.body && <p>{q.body}</p>}
          {q.detail && <p className="detail">{q.detail}</p>}
          {q.checkbox && (
            <label className="check">
              <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} />
              <span>{q.checkbox.label}</span>
            </label>
          )}
        </div>
        <div className="modal-f">
          <button type="button" className="btn ghost" onClick={cancel}>{q.cancelLabel || "Cancel"}</button>
          <button type="button" ref={go} className={`btn ${q.tone === "danger" ? "danger" : ""}`}
            onClick={() => close({ ok: true, checked })}>{q.confirmLabel || "Confirm"}</button>
        </div>
      </div>
    </div>
  );
}

function Tracker({ user }) {
  const [settings, setSettings] = useState(null);
  const [fills, setFills] = useState([]);
  const [tab, setTab] = useState("dash");
  const ask = useConfirm();
  useCardLabels();
  // Which settings panels have edits that haven't been saved.
  const unsaved = useRef(new Set());
  const mark = useCallback((id, on) => { if (on) unsaved.current.add(id); else unsaved.current.delete(id); }, []);
  const dirtyApi = useMemo(() => ({ mark }), [mark]);
  // Switching tabs unmounts the panel, so ask before the edits go with it.
  const goTab = async (next) => {
    if (next !== tab && unsaved.current.size) {
      const n2 = unsaved.current.size;
      const { ok } = await ask({
        title: "Leave without saving?",
        body: `${n2} panel${n2 === 1 ? " has" : "s have"} changes you haven't saved. Leaving this tab discards ${n2 === 1 ? "them" : "them all"}.`,
        detail: "Nothing has reached your positions or risk figures yet.",
        confirmLabel: "Discard and leave", tone: "danger",
      });
      if (!ok) return;
      unsaved.current.clear();
    }
    setTab(next);
  };
  const [saveState, setSaveState] = useState("saved");
  const [loadErr, setLoadErr] = useState(null);
  const firstSave = useRef(true);
  const reloadFills = async () => setFills((await db.loadFills()).map((f) => ({ ...f, broker: f.broker || "default" })));

  useEffect(() => {
    (async () => {
      try { setSettings(migrate(await db.loadSettings())); await reloadFills(); }
      catch (e) { setLoadErr(e.message); }
    })();
  }, [user?.id]);

  useEffect(() => {
    if (!settings) return;
    if (firstSave.current) { firstSave.current = false; return; }
    setSaveState("saving");
    const t = setTimeout(async () => {
      try { await db.saveSettings(settings); setSaveState("saved"); } catch (e) { setSaveState("error"); console.error(e); }
    }, 700);
    return () => clearTimeout(t);
  }, [settings]);

  // Every broker and product seen in fills gets a settings entry.
  useEffect(() => {
    if (!settings) return;
    const ids = new Set(settings.brokers.map((b) => b.id));
    const traded = fills.filter((f) => !f.is_leg);   // spread legs aren't products in their own right
    const newBrokers = [...new Set(traded.map((f) => f.broker))].filter((id) => !ids.has(id));
    const missing = traded.filter((f) => { const b = settings.brokers.find((x) => x.id === f.broker); return b && !b.products?.[f.product]; });
    if (!newBrokers.length && !missing.length) return;
    setSettings((s) => {
      const brokers = [...s.brokers, ...newBrokers.map((id) => ({ ...NEW_BROKER, method: "fixed", id, name: id === "default" ? "Main account" : id }))].map((b) => {
        const add = [...new Set(traded.filter((f) => f.broker === b.id && !b.products?.[f.product]).map((f) => f.product))];
        return add.length ? { ...b, products: { ...b.products, ...Object.fromEntries(add.map((p) => [p, { size: b.method === "leverage" ? 100 : 1000, margin: 0, lev: "", note: "" }])) } } : b;
      });
      return { ...s, brokers };
    });
  }, [fills, settings]);

  const pf = useMemo(() => (settings ? portfolio(fills, settings) : null), [fills, settings]);

  /*
   * Writes today's equity, margin and lots for each account into settings, so
   * that tomorrow the chart can show what today actually looked like rather
   * than a rebuild of it.
   *
   * This deliberately runs on every recompute, not once a day: the figure that
   * matters is where the account ended up, so a later change today overwrites
   * this morning's row. mergeSnapshot hands back the same array when nothing
   * moved, which is what stops the write → recompute → write circle.
   */
  useEffect(() => {
    if (!pf || !settings) return;
    const rows = snapshotRows(pf);
    setSettings((s) => {
      const next = mergeSnapshot(s.history, rows);
      return next === s.history ? s : { ...s, history: next };
    });
  }, [pf, settings]);

  if (loadErr) return <div className="auth"><div className="panel"><div className="ph"><h2 className="bad">Couldn't load your data</h2></div><div className="pb"><p>{loadErr}</p><p className="dim">Please reload the page.</p></div></div></div>;
  if (!settings || !pf) return <div className="auth dim">Loading your data…</div>;

  const L = settings.limits;
  /*
   * With more than one currency in play there is no "all brokers" to show, so the view
   * falls to a single account whatever was stored. Everything below — the top strip, every
   * table, every chart — then describes one account in one currency, and the figures on it
   * are true.
   */
  const mixed = mixedCurrency(settings.brokers);
  const stored = settings.brokers.some((b) => b.id === settings.view) ? settings.view : "all";
  const view = mixed && stored === "all" ? (settings.brokers[0]?.id ?? "all") : stored;
  const setView = (v) => setSettings((s) => ({ ...s, view: v }));
  const setBroker = (id, k, v) => setSettings((s) => ({ ...s, brokers: s.brokers.map((b) => (b.id === id ? { ...b, [k]: v } : b)) }));
  const setMark = (key, k, v) => setSettings((s) => ({ ...s, marks: { ...s.marks, [key]: { ...s.marks[key], [k]: v } } }));
  const addFills = async (rows) => { const added = await db.addFills(rows); await reloadFills(); return added; };
  const setScen = (patch) => setSettings((s) => ({ ...s, scenario: { ...s.scenario, ...patch } }));

  // scope for the top bar
  const scoped = view === "all" ? null : pf.acct(view);
  /*
   * The currency every figure below will be printed in. Written here, in Tracker's own
   * body, before a single child renders — see the note on DISPLAY. With one currency
   * across the desk the combined view keeps working and uses it; with several, `view` can
   * no longer be "all", so there is always exactly one account to take it from.
   */
  DISPLAY.cur = scoped?.currency || currenciesOf(settings.brokers)[0] || "USD";
  const focus = scoped || pf.weakest;           // account whose TNE/IM is shown
  const ratio = focus ? focus.ratio : Infinity;
  const st = statusOf(ratio, focus, pf.minR);
  const k = scoped
    ? { TNE: scoped.TNE, IM: scoped.IM, upnl: scoped.upnl, today: scoped.realizedToday + scoped.upnl, room: scoped.IM > 0 ? scoped.lossToCall : null, lev: scoped.TNE > 0 && scoped.notional ? scoped.notional / scoped.TNE : null }
    : { TNE: pf.total.TNE, IM: pf.total.IM, upnl: pf.total.upnl, today: pf.total.todayPnl, room: pf.total.lossToCall, lev: pf.total.TNE > 0 && pf.total.notional ? pf.total.notional / pf.total.TNE : null };
  const slotsLeft = Math.max(0, n(L.maxTrades) - pf.rows.length);
  const callR = focus?.callR ?? 1;
  const scaleMax = Math.max(pf.minR * 2, 3, isFinite(ratio) ? Math.min(ratio, pf.minR * 4) : 0);
  const pos = (r) => Math.min(100, Math.max(0, (r / scaleMax) * 100));
  const save = { saved: [isRemote ? "Saved" : "Saved locally", "var(--ok)"], saving: ["Saving…", "var(--warn)"], error: ["Save failed", "var(--bad)"] }[saveState];
  const nav = [["dash", "Positions"], ["scen", "Scenarios"], ["fills", "Fills", fills.length], ["closed", "Closed", pf.book.closed.length], ["analysis", "Analysis"], ["funds", "Funds"], ["settings", "Settings"]];

  return (
    <DirtyCtx.Provider value={dirtyApi}>
    <div className="app">
      <nav className="rail" aria-label="Main">
        <div className="logo" title="Nexus RAMP - Risk and Margin Platform">N</div>
        {nav.map(([key, l, c]) => (
          <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => goTab(key)}>
            {ICONS[key]}{l}{c ? <span className="badge">{c > 999 ? "999+" : c}</span> : null}
          </button>
        ))}
        <div className="spacer" />
      </nav>

      <header className="top">
        <div className="brand"><b>Nexus</b><span>RAMP · Risk and Margin Platform</span></div>
        <div className="scope">
          <label className="f" style={{ gap: 2 }}>Account
            <select className="in" value={view} onChange={(e) => setView(e.target.value)} aria-label="Account shown">
              {/* Offered only while every account is in the same currency. Adding rupees
                  to dollars gives a number that looks right and is meaningless. */}
              {!mixed && <option value="all">All brokers</option>}
              {settings.brokers.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}{mixed ? ` · ${b.currency || "USD"}` : ""}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="kpis">
          <div className="kpi ratio" title="Total net equity ÷ initial margin, per broker account">
            <div className="rv">
              <label>TNE / IM{!scoped && focus ? ` · weakest: ${focus.name}` : ""}</label>
              <b className={st.cls === "dim" ? "" : st.cls}>{ratioTxt(ratio)}</b>
            </div>
            <div className="meter" aria-hidden="true">
              <div className="bar">
                <span style={{ width: `${pos(callR)}%`, background: "#E7A1A5", borderRadius: "3px 0 0 3px" }} />
                <span style={{ width: `${Math.max(0, pos(pf.minR) - pos(callR))}%`, background: "#EDCF93" }} />
                <span style={{ flex: 1, background: "#9FD4BD", borderRadius: "0 3px 3px 0" }} />
                {isFinite(ratio) && <div className="needle" style={{ left: `${pos(ratio)}%` }} />}
              </div>
              <div className="ticks">
                <i style={{ left: `${pos(callR)}%` }}>{Math.round(callR * 100)}%</i>
                <i style={{ left: `${pos(pf.minR)}%` }}>{L.minRatio}%</i>
              </div>
            </div>
            <span className={`pill ${st.cls}`}><span className={st.cls}>{st.t}</span></span>
          </div>
          <div className="kpi"><label>Total net equity</label><b>{money(k.TNE)}</b></div>
          <div className="kpi"><label>Initial margin</label><b>{money(k.IM)}</b></div>
          <div className="kpi"><label>Open P&L</label><b className={pc(k.upnl)}>{signed(k.upnl)}</b></div>
          <div className="kpi"><label>Today</label><b className={pc(k.today)}>{signed(k.today)}</b></div>
          <div className="kpi"><label>{scoped ? "Room to margin call" : "Least room to call"}</label><b className={k.room !== null && k.room <= 0 ? "bad" : ""}>{k.room !== null ? money(k.room) : "—"}</b></div>
          <div className="kpi hide-m"><label>Leverage used</label><b>{k.lev ? `${k.lev.toFixed(1)}×` : "—"}</b></div>
          <div className="kpi"><label>Slots left</label><b className={slotsLeft === 0 ? "bad" : slotsLeft <= 2 ? "warn" : ""}>{slotsLeft}<span className="faint" style={{ fontSize: 13 }}> / {L.maxTrades}</span></b></div>
        </div>
        <div className="topright">
          <span title={save[0]}><span className="dot" style={{ background: save[1] }} /><span className="savetxt">{save[0]}</span></span>
          {auth.enabled && (
            <>
              <span className="who" title={user.email}>{user.email}</span>
              <button className="btn ghost" onClick={() => auth.signOut()}>Sign out</button>
            </>
          )}
        </div>
      </header>

      <main className="main">
        {!isRemote && <div className="banner">No database connected — data is saved in this browser only.</div>}
        {tab === "dash" && <Dashboard pf={pf} settings={settings} view={view} setView={setView} fills={fills} setMark={setMark} goFills={() => goTab("fills")} goSettings={() => goTab("settings")} goScen={() => goTab("scen")} />}
        {tab === "scen" && <ScenarioTab pf={pf} settings={settings} view={view} setScen={setScen} setMark={setMark} />}
        {tab === "fills" && <FillsTab settings={settings} setSettings={setSettings} view={view} fills={fills} addFills={addFills} reloadFills={reloadFills} setBroker={setBroker} />}
        {tab === "closed" && <ClosedTab pf={pf} settings={settings} view={view} fills={fills} />}
        {tab === "analysis" && <AnalysisTab pf={pf} settings={settings} view={view} fills={fills} />}
        {tab === "funds" && <FundsTab pf={pf} settings={settings} setSettings={setSettings} view={view} />}
        {tab === "settings" && <SettingsTab settings={settings} setSettings={setSettings} pf={pf} fills={fills} reloadFills={reloadFills} />}
      </main>
    </div>
    </DirtyCtx.Provider>
  );
}

// ---------- dashboard ----------
// ---------- trader's book: open + closed per product ----------
function bookRows(pf, view) {
  const by = {};
  const get = (broker, product) => (by[`${broker}|${product}`] ||= { key: `${broker}|${product}`, broker, product, open: null, trades: 0, lots: 0, buyQ: 0, buyV: 0, sellQ: 0, sellV: 0, pnl: 0, fees: 0 });
  pf.rows.forEach((r) => { if (view === "all" || r.broker === view) get(r.broker, r.product).open = r; });
  pf.book.closed.forEach((c) => {
    if (view !== "all" && c.broker !== view) return;
    const g = get(c.broker, c.product);
    const q = +c.qty;
    const entryV = c.avgEntry * q, exitV = c.avgExit * q;
    if (c.side === "Long") { g.buyQ += q; g.buyV += entryV; g.sellQ += q; g.sellV += exitV; }
    else { g.sellQ += q; g.sellV += entryV; g.buyQ += q; g.buyV += exitV; }
    g.trades++; g.lots += q; g.pnl += c.pnl; g.fees += c.fees || 0;
  });
  return Object.values(by).sort((a, b) => (!!b.open - !!a.open) || a.product.localeCompare(b.product));
}

function Book({ pf, settings, view }) {
  const [openKey, setOpenKey] = useState(null);
  const rows = bookRows(pf, view);
  const bname = (id) => settings.brokers.find((b) => b.id === id)?.name || id;
  const open = rows.filter((r) => r.open);
  const longLots = sum(open.filter((r) => r.open.side === "Long"), (r) => r.open.lots);
  const shortLots = sum(open.filter((r) => r.open.side === "Short"), (r) => r.open.lots);
  const trades = sum(rows, (r) => r.trades), realized = sum(rows, (r) => r.pnl), upnl = sum(open, (r) => r.open.upnl);
  const all = view === "all";
  const avg = (v, q) => (q ? px(v / q) : "—");

  return (
    <section className="panel o0b book">
      <div className="booktiles">
        <div className="tile"><label>Open positions</label><b>{open.length}</b><small>{open.length ? `${qty(longLots)} lots long · ${qty(shortLots)} lots short` : "You're flat"}</small></div>
        <div className="tile"><label>Open P&amp;L</label><b className={pc(upnl)}>{signed(upnl)}</b><small>At the current prices you've entered</small></div>
        <div className="tile"><label>Closed trades</label><b>{trades}</b><small>{qty(sum(rows, (r) => r.lots))} lots squared off</small></div>
        <div className="tile"><label>Realized P&amp;L</label><b className={pc(realized)}>{signed(realized)}</b><small>After fees</small></div>
      </div>
      <div className="ph"><h2>Book by product<span className="dim">Open position and closed trades, side by side. Click an open position to see its lots.</span></h2></div>
      {rows.length === 0 ? <div className="empty">Nothing traded yet. Upload a fills file to get started.</div> : (
        <div className="tw">
          <table className="booktable">
            <thead>
              <tr className="grp"><th colSpan={all ? 2 : 1}></th><th colSpan={4} className="gOpen">Open now</th><th colSpan={5} className="gClosed">Closed trades</th></tr>
              <tr>
                {all && <th className="txt">Broker</th>}<th className="txt">Product</th>
                <th className="gOpen">Position</th><th className="gOpen">Avg price</th><th className="gOpen">Current</th><th className="gOpen">Open P&amp;L</th>
                <th className="gClosed">Avg buy</th><th className="gClosed">Avg sell</th><th className="gClosed">Realized</th><th className="gClosed">Trades</th><th className="gClosed">Lots</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const o = r.open, isOpen = openKey === r.key;
                return [
                  <tr key={r.key} className={o ? "clickable" : ""} onClick={() => o && setOpenKey(isOpen ? null : r.key)} aria-expanded={o ? isOpen : undefined}>
                    {all && <td className="txt dim">{bname(r.broker)}</td>}
                    <td className="txt"><b>{r.product}</b>{o && <span className="faint" style={{ marginLeft: 6 }}>{isOpen ? "▾" : "▸"}</span>}</td>
                    <td>{o ? <><Side s={o.side} /> <b>{qty(o.lots)}</b></> : <span className="faint">Flat</span>}</td>
                    <td>{o ? <b>{px(o.avg)}</b> : <span className="faint">—</span>}</td>
                    <td className="dim">{o ? px(o.mark) : "—"}</td>
                    <td className={o ? pc(o.upnl) : "faint"}>{o ? signed(o.upnl) : "—"}</td>
                    <td>{avg(r.buyV, r.buyQ)}</td>
                    <td>{avg(r.sellV, r.sellQ)}</td>
                    <td className={r.trades ? pc(r.pnl) : "faint"}>{r.trades ? <b>{signed(r.pnl)}</b> : "—"}</td>
                    <td className="dim">{r.trades || "—"}</td>
                    <td className="dim">{r.lots ? qty(r.lots) : "—"}</td>
                  </tr>,
                  isOpen && o && (
                    <tr key={r.key + "-lots"} className="lotsrow">
                      <td colSpan={all ? 11 : 10}>
                        <div className="lots">
                          <div className="faint" style={{ marginBottom: 4 }}>Open lots, oldest first{settings.brokers.find((b) => b.id === r.broker)?.method === "leverage" ? "" : " (these close first under FIFO)"}</div>
                          <table>
                            <thead><tr><th className="txt">Opened</th><th>Side</th><th>Lots</th><th>Price</th><th>Open P&amp;L</th><th className="txt">Ticket</th></tr></thead>
                            <tbody>
                              {(o.lotsOpen || []).map((l, i) => (
                                <tr key={i}>
                                  <td className="txt dim">{dt(l.ts)}</td><td><Side s={l.q > 0 ? "Long" : "Short"} /></td><td>{qty(Math.abs(l.q))}</td><td>{px(l.price)}</td>
                                  <td className={pc(Math.sign(l.q) * (o.mark - l.price))}>{signed(Math.sign(l.q) * (o.mark - l.price) * o.size * Math.abs(l.q))}</td>
                                  <td className="txt faint">{l.id || "—"}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ),
                ];
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Dashboard({ pf, settings, view, setView, fills, setMark, goFills, goSettings, goScen }) {
  const L = settings.limits;
  const all = view === "all";
  const rows = all ? pf.rows : pf.rows.filter((r) => r.broker === view);
  const accts = all ? pf.accounts : pf.accounts.filter((a) => a.id === view);
  const scen = settings.brokers.filter((b) => all || b.id === view).map((b) => ({ b, ...scenarioFor(pf, settings, b) }));
  const tName = { min: `your ${L.minRatio}% minimum`, call: "the margin call level", stop: "the stop-out level" }[settings.scenario.target];


  const warnings = [];
  for (const a of accts) {
    if (!isFinite(a.ratio)) continue;
    const nm = all ? `${a.name}: ` : "";
    if (a.ratio <= a.stopR) warnings.push(["bad", `${nm}TNE/IM ${ratioTxt(a.ratio)} is at or below the ${a.stopRatio}% stop-out level.`]);
    else if (a.ratio <= a.callR) warnings.push(["bad", `${nm}TNE/IM ${ratioTxt(a.ratio)} is at or below the ${a.callRatio}% margin call level.`]);
    else if (a.ratio < pf.minR) warnings.push(["warn", `${nm}TNE/IM ${ratioTxt(a.ratio)} is under your ${L.minRatio}% minimum. Don't add positions.`]);
    else if (a.ratio < pf.minR * 1.2) warnings.push(["warn", `${nm}TNE/IM ${ratioTxt(a.ratio)} is close to your ${L.minRatio}% minimum.`]);
  }
  /*
   * Against the combined limit where there is one, and against this account's own where
   * there is not — never against a limit denominated in a currency the loss is not in.
   */
  /*
   * Said once, plainly, because a missing option is otherwise a mystery: the combined
   * view is gone because it would have to add two currencies together.
   */
  if (mixedCurrency(settings.brokers)) {
    warnings.push(["dim", `Your accounts are in ${currenciesOf(settings.brokers).join(" and ")}. RAMP does not convert between currencies, so there is no combined view — each account is shown on its own, in its own money.`]);
  }

  const capNow = pf.dailyCap ?? focus?.dailyCap ?? null;
  const lossNow = pf.dailyCap !== null ? pf.total.todayPnl : (focus ? focus.realizedToday + focus.upnl : null);
  const capScope = pf.dailyCap !== null ? " across all brokers" : ` on ${focus?.name ?? "this account"}`;
  if (capNow > 0 && lossNow !== null && lossNow <= -capNow) warnings.push(["bad", `Daily loss limit hit (${money(lossNow)}${capScope}). Stop trading today.`]);
  else if (capNow > 0 && lossNow !== null && lossNow <= -0.7 * capNow) warnings.push(["warn", `Today's loss is ${pct(-lossNow / capNow)} of your daily limit.`]);
  if (pf.rows.length >= n(L.maxTrades)) warnings.push(["bad", `Maximum of ${L.maxTrades} open positions reached.`]);
  // Say it on the dashboard too: a scenario that quietly leaves something out
  // is worse than one that admits it.
  const optsOn = [...new Set(scen.flatMap((x) => x.optionsOn.map((o) => o.product)))];
  if (optsOn.length) warnings.push(["warn", `${optsOn.join(", ")}: an option isn't stressed by the scenario yet, so its risk isn't in these figures. P&L and positions are unaffected.`]);
  accts.forEach((a) => { if (!n(a.capital) && a.rows.length) warnings.unshift(["warn", `${a.name}: no funds recorded. Add its deposits in Funds, or TNE/IM and the scenario are wrong.`]); });
  rows.forEach((r) => {
    const nm = all ? `${r.brokerName} ${r.product}` : r.product;
    if (r.noMargin) warnings.push(["warn", `${nm}: broker margin per lot not set (Settings). TNE/IM is understated.`]);
    if (!r.hasStop) warnings.push(["warn", `${nm}: no stop — risk is unlimited.`]);
    else if (r.risk > (pf.acct(r.broker)?.riskCap ?? Infinity)) warnings.push(["bad", `${nm}: risk ${money(r.risk)} exceeds per-trade limit ${money(pf.acct(r.broker).riskCap)}.`]);
  });
  scen.forEach(({ b, res, acc, callMove }) => {
    if (!isFinite(res.ratio)) return;
    const nm = all ? `${b.name}: ` : "";
    if (res.ratio <= acc.stopR) warnings.unshift(["bad", `${nm}your scenario takes this account to stop-out (${ratioTxt(res.ratio)}).`]);
    else if (res.ratio <= acc.callR) warnings.unshift(["bad", `${nm}your scenario triggers a margin call (${ratioTxt(res.ratio)}).`]);
    if (callMove !== null && isFinite(callMove) && callMove < 5) warnings.unshift(["bad", `${nm}a ${callMove.toFixed(1)}% move against your positions triggers a margin call.`]);
  });
  const bad = warnings.some((w) => w[0] === "bad");

  // stress: same adverse move on every position in scope; report the worst account afterwards
  const recent = pf.book.closed.filter((c) => all || c.broker === view).slice(0, 6);
  const bname = (id) => settings.brokers.find((b) => b.id === id)?.name || id;

  return (
    <div className="grid-dash">
      <div className="col">
        <Book pf={pf} settings={settings} view={view} />
        {all && (
          <section className="panel o0">
            <div className="ph"><h2>Broker accounts<span className="dim">{pf.accounts.length}</span></h2><button className="btn ghost" onClick={goSettings}>Manage</button></div>
            <div className="tw">
              <table>
                <thead><tr><th className="txt">Broker</th><th className="txt">Margin basis</th><th>Capital</th><th>TNE</th><th>Initial margin</th><th>TNE / IM</th><th>Room to call</th><th>Open P&L</th><th>Positions</th></tr></thead>
                <tbody>
                  {pf.accounts.map((a) => {
                    const s = statusOf(a.ratio, a, pf.minR);
                    return (
                      <tr key={a.id} className="clickable" onClick={() => setView(a.id)} title={`Show ${a.name} only`}>
                        <td className="txt"><b>{a.name}</b></td>
                        <td className="txt dim">{basis(a)}</td>
                        <td>{money(n(a.capital))}</td><td>{money(a.TNE)}</td><td>{money(a.IM)}</td>
                        <td><b className={s.cls === "dim" ? "faint" : s.cls}>{ratioTxt(a.ratio)}</b>{isFinite(a.ratio) && <span className={`pill ${s.cls}`} style={{ marginLeft: 6 }}><span className={s.cls}>{s.t}</span></span>}</td>
                        <td className={a.IM > 0 && a.lossToCall <= 0 ? "bad" : ""}>{a.IM > 0 ? money(a.lossToCall) : "—"}</td>
                        <td className={pc(a.upnl)}>{signed(a.upnl)}</td><td>{a.rows.length}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}

        <section className="panel o1">
          <div className="ph">
            <h2>Open positions<span className="dim">{rows.length}{!all && ` · ${bname(view)}`}</span></h2>
            <div className="actions"><span className="faint hide-m" style={{ fontSize: 11 }}>Edit current price and stop in the table</span></div>
          </div>
          {rows.length === 0 ? (
            <div className="empty">No open positions{all ? "" : ` at ${bname(view)}`}. <button className="btn ghost" onClick={goFills}>Upload fills</button> to bring in your trades.</div>
          ) : (
            <div className="tw">
              <table>
                <thead><tr>{all && <th className="txt">Broker</th>}<th className="txt">Product</th><th>Side</th><th>Lots</th><th>Avg price</th><th>Current</th><th>Stop</th><th>Open P&L</th><th>Init. margin</th><th>Risk to stop</th><th>Opened</th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.key}>
                      {all && <td className="txt dim">{r.brokerName}</td>}
                      <td className="txt"><b>{r.product}</b></td>
                      <td><Side s={r.side} /></td>
                      <td>{qty(r.lots)}</td>
                      <td><b>{px(r.avg)}</b></td>
                      <td><input className="cell" type="number" step="0.01" placeholder={px(r.avg)} value={settings.marks[r.key]?.price ?? ""} onChange={(e) => setMark(r.key, "price", e.target.value)} aria-label={`Current price ${r.product} ${r.brokerName}`} /></td>
                      <td><input className={`cell ${r.hasStop ? "" : "need"}`} type="number" step="0.01" placeholder="Set" value={settings.marks[r.key]?.stop ?? ""} onChange={(e) => setMark(r.key, "stop", e.target.value)} aria-label={`Stop ${r.product} ${r.brokerName}`} /></td>
                      <td className={pc(r.upnl)}><b>{signed(r.upnl)}</b></td>
                      <td className={r.noMargin ? "warn" : ""} title={r.method === "leverage" ? `${qty(r.lots)} × ${r.size} × ${px(r.avg)} ÷ ${r.lev}` : `${qty(r.lots)} × ${money(n(r.spec.margin))}`}>{r.noMargin ? "Not set" : money(r.im)}</td>
                      <td className={!r.hasStop || r.risk > (pf.acct(r.broker)?.riskCap ?? Infinity) ? "bad" : ""}>{r.hasStop ? money(r.risk) : "—"}</td>
                      <td className="dim">{dt(r.openTs)}</td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td className="txt" colSpan={all ? 2 : 1}>Total</td><td colSpan={5}></td>
                    <td className={pc(sum(rows, (r) => r.upnl))}>{signed(sum(rows, (r) => r.upnl))}</td><td>{money(sum(rows, (r) => r.im))}</td><td>{money(sum(rows, (r) => r.risk || 0))}</td><td></td>
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel o5">
          <div className="ph"><h2>Recently closed</h2><span className="dim">Realized today <b className={`num ${pc(sum(accts, (a) => a.realizedToday))}`}>{signed(sum(accts, (a) => a.realizedToday))}</b></span></div>
          {recent.length === 0 ? <div className="empty">Closed trades appear here once they're squared off.</div> : (
            <div className="tw">
              <table>
                <thead><tr>{all && <th className="txt">Broker</th>}<th className="txt">Product</th><th>Side</th><th>Lots</th><th>Entry</th><th>Exit</th><th>Closed</th><th>Realized</th></tr></thead>
                <tbody>
                  {recent.map((c, i) => (
                    <tr key={i}>{all && <td className="txt dim">{bname(c.broker)}</td>}<td className="txt">{c.product}</td><td><Side s={c.side} /></td><td>{qty(c.qty)}</td><td>{px(c.avgEntry)}</td><td>{px(c.avgExit)}</td><td className="dim">{dt(c.closeTs)}</td><td className={pc(c.pnl)}><b>{signed(c.pnl)}</b></td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <div className="col">
        <section className="panel o2" style={{ borderColor: warnings.length ? (bad ? "#E7A1A5" : "#E8CD99") : undefined, borderTop: warnings.length ? `3px solid var(--${bad ? "bad" : "warn"})` : undefined }}>
          <div className="ph"><h2>Warnings<span className="dim">{warnings.length || ""}</span></h2>{warnings.length === 0 && <span className="ok" style={{ fontSize: 12 }}>All clear</span>}</div>
          {warnings.length > 0 && <ul className="warns">{warnings.map(([lvl, m], i) => <li key={i}><span className="dot" style={{ background: `var(--${lvl})` }} />{m}</li>)}</ul>}
        </section>


        <section className="panel o4">
          <div className="ph"><h2>Scenario check</h2><button className="btn ghost" onClick={goScen}>Open analysis</button></div>
          <div className="pb" style={{ display: "grid", gap: 10 }}>
            {scen.map(({ b, res, st, callMove }) => (
              <div key={b.id} className="preview" style={{ marginTop: 0 }}>
                <span><b style={{ color: "var(--text)" }}>{b.name}</b></span><span className={st.cls}>{isFinite(res.ratio) ? `${ratioTxt(res.ratio)} · ${st.t}` : "Flat"}</span>
                <span>Scenario loss</span><span className={res.loss ? "bad" : "faint"}>{money(-res.loss)}</span>
                <span>Margin call if</span><span className={callMove !== null && isFinite(callMove) && callMove < 10 ? "bad" : ""}>{moveTxt(callMove)}</span>
              </div>
            ))}
            <div className="faint" style={{ fontSize: 11 }}>Moves are set per product in Scenarios. Capacity keeps you above {tName}.</div>
          </div>
        </section>
      </div>
    </div>
  );
}

// ---------- scenarios ----------
function ScenarioTab({ pf, settings, view, setScen, setMark }) {
  const S = settings.scenario, L = settings.limits;
  const brokers = settings.brokers.filter((b) => view === "all" || b.id === view);
  const setMove = (key, patch) => setScen({ moves: { ...S.moves, [key]: { ...(S.moves[key] || { v: S.defV, unit: S.defUnit }), ...patch } } });
  const applyAll = () => {
    const moves = { ...S.moves };
    settings.brokers.forEach((b) => Object.keys(b.products || {}).forEach((p) => { moves[`${b.id}|${p}`] = { v: S.defV, unit: S.defUnit }; }));
    setScen({ moves });
  };
  // A capacity number is only meaningful once the product has a price and a margin.
  // Which instruments are on the table. Untouched, it follows what you hold; once you
  // pick, it is exactly what you picked — including nothing.
  // What is left of today's allowance: the limit, less whatever today has already lost.
  // Same fallback as the warnings: the combined limit, or this account's own.
  const dayCap = pf.dailyCap ?? scoped?.dailyCap ?? null;
  const dayLoss = pf.dailyCap !== null ? pf.total.todayPnl : (scoped ? scoped.realizedToday + scoped.upnl : 0);
  const dailyLeft = dayCap > 0 ? Math.max(0, dayCap - Math.max(0, -dayLoss)) : Infinity;
  const picked = Array.isArray(S.pick) ? S.pick : null;
  const isOn = (line) => (picked ? picked.includes(line.key) : !!line.pos);
  const toggle = (line, lines) => {
    const now = picked || lines.filter((l) => l.pos).map((l) => l.key);
    setScen({ pick: now.includes(line.key) ? now.filter((k) => k !== line.key) : [...now, line.key] });
  };
  const cap = (l, x) => (x === null ? (l.reason === "margin" ? "Set margin" : "Set price")
    : !isFinite(x) ? "No limit" : x <= 0 ? "0" : qty(x));

  return (
    <>
      <section className="panel">
        <div className="ph"><h2>Scenario settings</h2><span className="faint" style={{ fontSize: 11 }}>Every position is moved against you by its product's move</span></div>
        <div className="pb">
          <div className="fg" style={{ gridTemplateColumns: "repeat(auto-fit, minmax(170px, 1fr))", alignItems: "end" }}>
            <F label="Size capacity to stay above">
              <select className="in" value={S.target} onChange={(e) => setScen({ target: e.target.value })}>
                <option value="min">Your minimum ({L.minRatio}%)</option>
                <option value="call">Broker margin call</option>
                <option value="stop">Broker stop-out</option>
              </select>
            </F>
            <F label="Default move">
              <div style={{ display: "flex", gap: 6 }}>
                <input className="in" type="number" step="0.1" value={S.defV} onChange={(e) => setScen({ defV: e.target.value })} />
                <select className="in" style={{ width: 80 }} value={S.defUnit} onChange={(e) => setScen({ defUnit: e.target.value })}><option value="%">%</option><option value="pts">pts</option></select>
              </div>
            </F>
            <button className="btn" onClick={applyAll}>Apply to all products</button>
          </div>
        </div>
      </section>

      {brokers.map((b) => {
        const { acc, target, res, st, minMove, callMove, stopMove, optionsOn } = scenarioFor(pf, settings, b);
        const verdict = !isFinite(res.ratio) ? ["dim", "No open positions. Capacity shows what you could put on under this scenario."]
          : res.ratio <= acc.stopR ? ["bad", "This scenario takes the account to stop-out. Positions would be liquidated."]
          : res.ratio <= acc.callR ? ["bad", "This scenario triggers a margin call. Reduce positions or add funds."]
          : res.ratio < pf.minR ? ["warn", `Survives, but falls below your ${L.minRatio}% minimum. No room to add risk.`]
          : ["ok", "Survives this scenario above your minimum."];
        return (
          <section className="panel" key={b.id} style={{ marginTop: 12, borderTop: `3px solid var(--${verdict[0] === "dim" ? "line2" : verdict[0]})` }}>
            <div className="ph"><h2>{b.name}<span className="dim">{basis(b)}</span></h2>
              {res.lines.some((l) => l.planned)
                ? <span className="warn" style={{ fontSize: 12, fontWeight: 600 }}>
                    Includes a trade you haven't put on — clear the lots to see the account as it stands
                  </span>
                : <span className={verdict[0]} style={{ fontSize: 12, fontWeight: 600 }}>{verdict[1]}</span>}
            </div>
            <div className="strip">
              <div className="kpi"><label>TNE now → after</label><b>{money(acc.TNE)} <span className="faint">→</span> <span className={res.loss ? "bad" : ""}>{money(res.TNE)}</span></b></div>
              <div className="kpi"><label>TNE / IM now → after</label><b><span className={statusOf(acc.ratio, acc, pf.minR).cls}>{ratioTxt(acc.ratio)}</span> <span className="faint">→</span> <span className={st.cls}>{ratioTxt(res.ratio)}</span></b></div>
              <div className="kpi"><label>Initial margin after</label><b>{money(res.IM)}</b></div>
              <div className="kpi"><label>Margin call ({b.callRatio}%) if all move</label><b className={callMove !== null && isFinite(callMove) && callMove < 10 ? "bad" : ""}>{moveTxt(callMove)}</b></div>
              <div className="kpi"><label>Stop-out ({b.stopRatio}%) if all move</label><b>{moveTxt(stopMove)}</b></div>
              <div className="kpi"><label>Max risk per trade</label><b>{acc.riskCap > 0 ? money(acc.riskCap) : "—"}</b>
                <span className="faint" style={{ fontSize: 11 }}>{L.maxRiskPct}% of {b.name} capital</span></div>
              <div className="kpi"><label>Daily loss limit</label><b>{dayCap > 0 ? money(dayCap) : "—"}</b>
                <span className="faint" style={{ fontSize: 11 }}>{L.dailyLossPct}% of all capital{pf.total.todayPnl < 0 ? ` · ${money(-pf.total.todayPnl)} used today` : ""}</span></div>
            </div>
            {res.lines.length === 0 ? <div className="empty">{b.name} has no products yet. Upload its fills, or add products under Settings → {b.name}, and each will get its own row here.</div> : <>
            <div className="chips">
              <span className="chips-label">Instruments</span>
              {res.lines.map((l) => (
                <button key={l.key} type="button" className={`chip ${isOn(l) ? "on" : ""}`}
                  aria-pressed={isOn(l)} onClick={() => toggle(l, res.lines)}>
                  {l.product}{l.pos ? <span className="chip-tag">open</span> : null}
                </button>
              ))}
              <span className="chips-gap" />
              <button type="button" className="btn ghost" onClick={() => setScen({ pick: res.lines.map((l) => l.key) })}>All</button>
              <button type="button" className="btn ghost" onClick={() => setScen({ pick: res.lines.filter((l) => l.pos).map((l) => l.key) })}>Only open</button>
              <button type="button" className="btn ghost" onClick={() => setScen({ pick: [] })}>None</button>
              {res.lines.some((l) => settings.marks[l.key]?.dir || settings.marks[l.key]?.lots) && (
                <button type="button" className="btn ghost red"
                  title="Forget every direction and lot count typed on this account"
                  onClick={() => res.lines.forEach((l) => { setMark(l.key, "dir", ""); setMark(l.key, "lots", ""); })}>
                  Clear plans
                </button>
              )}
            </div>
            {!res.lines.some(isOn) ? (
              <div className="empty">
                {picked ? "Nothing picked." : `${b.name} is flat.`}{" "}
                Choose the instruments you're thinking of trading{picked ? "" : ", or press All"}.
              </div>
            ) : <>
            <div className="tw">
              <table>
                <thead><tr>
                  <th className="txt">Product</th><th>Position</th><th>Current price</th><th>Move against you</th><th title="Where the price ends up after the move. Flat products show it both ways: if you bought / if you sold.">Stressed price</th><th>Scenario P&L</th><th>Margin after</th>
                  <th>Can buy</th><th>Can sell</th><th className="txt">Status</th>
                </tr></thead>
                <tbody>
                  {res.lines.filter(isOn).map((l) => {
                    const mv = S.moves[l.key] || { v: S.defV, unit: S.defUnit };
                    const status = l.reason === "price" ? ["warn", "Enter a price"]
                      : l.reason === "margin" ? ["warn", "Set margin per lot"]
                      : l.cut > 0 ? ["bad", `Too big: cut ${qty(l.cut)} lots`]
                      : (l.canBuy !== null && l.canBuy <= 0 && l.canSell <= 0) ? ["bad", "No room"]
                      : l.pos ? ["ok", "Within limit"]
                      : l.planned && acc.riskCap > 0 && l.loss > acc.riskCap && l.loss > dailyLeft
                        ? ["bad", `Risks ${money(l.loss)} — over your ${money(acc.riskCap)} per-trade limit and past ${money(dailyLeft)} left today`]
                      : l.planned && acc.riskCap > 0 && l.loss > acc.riskCap
                        ? ["bad", `Risks ${money(l.loss)} — over your ${money(acc.riskCap)} per-trade limit`]
                      : l.planned && l.loss > dailyLeft
                        ? ["bad", `Risks ${money(l.loss)} — only ${money(dailyLeft)} left under today's limit`]
                      : l.planned ? ["warn", `Planned: ${l.effPos > 0 ? "buy" : "sell"} ${qty(Math.abs(l.effPos))}`]
                      : l.dir ? ["dim", l.dir > 0 ? "Flat · sizing a buy" : "Flat · sizing a sell"]
                      : ["dim", "Flat"];
                    return (
                      <tr key={l.key}>
                        <td className="txt"><b>{l.product}</b></td>
                        <td>{l.pos
                          ? <><Side s={l.pos > 0 ? "Long" : "Short"} /> {qty(Math.abs(l.pos))}</>
                          : <span style={{ display: "inline-flex", gap: 4, alignItems: "center" }}>
                              <select className="cell" style={{ width: 86, textAlign: "left" }}
                                value={settings.marks[l.key]?.dir || ""}
                                onChange={(e) => setMark(l.key, "dir", e.target.value)}
                                aria-label={`Direction you're considering for ${l.product}`}
                                title="Flat. Pick the side you're thinking of trading.">
                                <option value="">Either way</option>
                                <option value="long">If long</option>
                                <option value="short">If short</option>
                              </select>
                              {settings.marks[l.key]?.dir && (
                                <input className={`cell ${l.planned ? "planning" : ""}`} style={{ width: 52 }} type="number" min="0" step="any"
                                  placeholder="lots" value={settings.marks[l.key]?.lots ?? ""}
                                  onChange={(e) => setMark(l.key, "lots", e.target.value)}
                                  aria-label={`Lots you're considering for ${l.product}`}
                                  title="Lots you're thinking of trading. The scenario treats them as if they were already on." />
                              )}
                            </span>}</td>
                        <td>{l.pos ? px(l.mark) : <input className="cell" type="number" step="0.01" placeholder="Price" value={settings.marks[l.key]?.price ?? ""} onChange={(e) => setMark(l.key, "price", e.target.value)} aria-label={`Reference price ${l.product}`} />}</td>
                        <td>
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <input className="cell" style={{ width: 64 }} type="number" step="0.1" value={mv.v} onChange={(e) => setMove(l.key, { v: e.target.value })} aria-label={`Move ${l.product}`} />
                            <select className="cell" style={{ width: 58, textAlign: "left" }} value={mv.unit} onChange={(e) => setMove(l.key, { unit: e.target.value })} aria-label={`Unit ${l.product}`}><option value="%">%</option><option value="pts">pts</option></select>
                          </span>
                        </td>
                        <td className="dim">
                          {l.stressed !== null ? px(l.stressed)
                            : l.stressedIfLong !== null
                              ? <span title={`If you bought it: ${px(l.stressedIfLong)}. If you sold it: ${px(l.stressedIfShort)}.`}>
                                  {px(l.stressedIfLong)}<span className="faint"> / </span>{px(l.stressedIfShort)}
                                </span>
                              : "—"}
                        </td>
                        <td className={l.loss ? "bad" : "faint"}>{l.effPos ? money(-l.loss) : "—"}</td>
                        <td>{l.effPos ? money(l.im) : <span className="faint">—</span>}</td>
                        <td className={`${l.canBuy === null ? "warn" : l.canBuy <= 0 ? "bad" : "ok"}${!l.pos && l.dir < 0 ? " faded" : ""}`}><b>{cap(l, l.canBuy)}</b></td>
                        <td className={`${l.canSell === null ? "warn" : l.canSell <= 0 ? "bad" : "ok"}${!l.pos && l.dir > 0 ? " faded" : ""}`}><b>{cap(l, l.canSell)}</b></td>
                        <td className="txt"><span className={`pill ${status[0]}`}><span className={status[0]}>{status[1]}</span></span></td>
                      </tr>
                    );
                  })}
                  <tr className="total"><td className="txt">Account</td><td colSpan={4}></td>
                    <td className={res.loss ? "bad" : ""} title="Every row's loss added up: lots x contract size x the price distance of its move">{money(-res.loss)}</td>
                    <td title="Every row's margin added up, worked out at the stressed price on a leverage account">{money(res.IM)}</td>
                    <td colSpan={3} className="txt dim">Lots you can add and still stay above {ratioTxt(target)} after the scenario</td></tr>
                </tbody>
              </table>
            </div>
            {optionsOn.length > 0 && (
              <div className="pb" style={{ fontSize: 11, paddingBottom: 0 }}>
                <div className="warn" style={{ background: "var(--warn-soft)", border: "1px solid #E8CD99", borderRadius: 3, padding: "7px 9px", lineHeight: 1.5 }}>
                  <b>{optionsOn.length === 1 ? "An option is" : `${optionsOn.length} options are`} not stressed here:</b>{" "}
                  {optionsOn.map((o) => o.product).join(", ")}.{" "}
                  An option's premium doesn't move with the underlying one for one, so moving it like a
                  future would be badly wrong — a long call can lose ten times what that arithmetic
                  suggests. Its risk is not in the figures above. Positions, margin and realized P&L
                  are unaffected; only this stress leaves it out.
                </div>
              </div>
            )}
            {res.lines.some((l) => l.effPos) && (
              <div className="pb faint" style={{ fontSize: 11 }}>
                <b className="dim">What stops you first.</b>{" "}
                {(() => {
                  const steps = [
                    [minMove, `your own ${L.minRatio}% minimum`],
                    [callMove, `${b.name}'s margin call at ${b.callRatio}%`],
                    [stopMove, `stop-out at ${b.stopRatio}%`],
                  ].filter(([m]) => typeof m === "number" && !Number.isNaN(m) && isFinite(m));
                  if (!steps.length) return `Nothing on this account is reachable within a 100% move. Your ${money(acc.riskCap)} per-trade and ${money(pf.dailyCap ?? acc.dailyCap)} daily limits still cap the size.`;
                  return <>
                    {steps.map(([m, what], i) => (
                      <span key={what}>{i ? ", then " : "Moving against you, "}<b className={i === 0 ? "warn" : ""}>{m.toFixed(1)}%</b> hits {what}</span>
                    ))}
                    . Size is capped before any of that by your {money(acc.riskCap)} per-trade limit and {money(pf.dailyCap ?? acc.dailyCap)} daily limit — whichever bites first is the one that stops you.
                  </>;
                })()}
              </div>
            )}
            {res.lines.some((l) => l.pos && !isOn(l)) && (
              <div className="pb warn" style={{ fontSize: 11 }}>
                The Account row also covers {res.lines.filter((l) => l.pos && !isOn(l)).length} open position
                {res.lines.filter((l) => l.pos && !isOn(l)).length === 1 ? "" : "s"} the chips are hiding
                ({res.lines.filter((l) => l.pos && !isOn(l)).map((l) => l.product).join(", ")}).
                A position you hold counts whether or not it's shown.
              </div>
            )}
            {res.lines.some((l) => l.planned) && isFinite(dailyLeft) && (
              <div className={`pb ${res.loss > dailyLeft ? "bad" : "faint"}`} style={{ fontSize: 11 }}>
                {res.loss > dailyLeft
                  ? `This plan loses ${money(res.loss)} in the scenario, past the ${money(dailyLeft)} left under today's ${money(pf.dailyCap ?? acc.dailyCap)} daily limit.`
                  : `This plan loses ${money(res.loss)} in the scenario, within the ${money(dailyLeft)} left under today's ${money(pf.dailyCap ?? acc.dailyCap)} daily limit.`}
              </div>
            )}</>}</>}
          </section>
        );
      })}
      <p className="faint" style={{ fontSize: 11, margin: "10px 2px" }}>
        Can buy / Can sell = the most lots you can trade in that product, on top of what you hold, so that after every position moves against you by its scenario move the account stays above the chosen level.
        Selling a long (or buying back a short) reduces risk first. Leverage accounts recalculate margin at the stressed price.
      </p>
    </>
  );
}

// ---------- fills ----------
function FillsTab({ settings, setSettings, view, fills, addFills, reloadFills, setBroker }) {
  const ask = useConfirm();
  const brokers = settings.brokers;
  const [target, setTarget] = useState(view !== "all" ? view : brokers[0]?.id);
  const [csv, setCsv] = useState(null);
  const [map, setMap] = useState({});
  const [dateFormat, setDateFormat] = useState("auto");
  const [savedLayout, setSavedLayout] = useState(false);
  /*
   * Column help, off by default and never automatic.
   *
   * Ticking it sends the column headers and three sample rows to our own server, which asks
   * Claude which column is which. It never sends the book and it never lets a model touch a
   * number — the fills are parsed here afterwards, the same way they always were.
   */
  const [aiHelp, setAiHelp] = useState(false);
  const [aiState, setAiState] = useState(null);   // null | "asking" | {notes, confidence, dropped} | ["bad", msg]
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [paste, setPaste] = useState(null);   // null = not pasting; string = the pasted text
  const [includeManual, setIncludeManual] = useState(false);
  const [split, setSplit] = useState(true);
  const [spreadMode, setSpreadMode] = useState("spread");
  const [applySizes, setApplySizes] = useState(true);
  const [importCash, setImportCash] = useState(true);
  const [filter, setFilter] = useState({ broker: view !== "all" ? view : "", product: "", side: "", from: "", to: "" });
  const [openLegs, setOpenLegs] = useState(null);   // order_id whose legs are shown
  const [limit, setLimit] = useState(200);
  const fileRef = useRef();
  const tb = brokers.find((b) => b.id === target);
  const bname = (id) => brokers.find((b) => b.id === id)?.name || id;

  const applyLayout = (headers, brokerId) => {
    const b = brokers.find((x) => x.id === brokerId);
    const saved = b?.csv?.map;
    if (saved && Object.values(saved).every((h) => headers.includes(h))) { setMap(saved); setDateFormat(b.csv.dateFormat || "auto"); setSavedLayout(true); }
    else { setMap(guessMapping(headers)); setDateFormat("auto"); setSavedLayout(false); }
  };
  /*
   * Ask the server to propose a mapping.
   *
   * Proposes — it does not import. The selects below are filled in and the trader looks at
   * them before anything is read, which is the point: a wrong guess costs a click rather
   * than a wrong margin figure.
   */
  const askForMapping = async (headers, rows) => {
    setAiState("asking");
    try {
      // Three rows. Enough to tell a price from a quantity; nothing like a position history.
      const samples = rows.slice(0, 3).map((r) => headers.map((h) => r[h]));
      const res = await fetch("/api/parse-statement", {
        method: "POST", headers: await authHeader(), body: JSON.stringify({ headers, samples }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || "Could not work out the columns.");
      if (!body.map || !Object.keys(body.map).length) throw new Error("Nothing recognisable came back. Map the columns by hand.");
      setMap(body.map);
      setDateFormat(body.dateFormat || "auto");
      setSavedLayout(false);
      setAiState({ notes: body.notes, confidence: body.confidence, dropped: body.dropped });
    } catch (e) {
      // Never fatal. The manual mapping below is untouched and still works.
      setAiState(["bad", e.message]);
    }
  };

  const load = async (file) => {
    if (!file) return;
    setResult(null);
    setAiState(null);
    try {
      const { headers, rows } = await parseCsvFile(file);
      setCsv({ name: file.name, headers, rows });
      applyLayout(headers, target);
      // Only when asked, and only when the regexes have not already found a saved layout.
      if (aiHelp) await askForMapping(headers, rows);
    }
    catch (err) { setResult(["bad", `Couldn't read the file: ${err.message}`]); }
  };
  // Rows pasted from the TT Fills grid go through exactly the same reader as a file.
  const loadPasted = () => {
    setResult(null);
    try {
      const { headers, rows } = parsePastedText(paste);
      setCsv({ name: `${rows.length} pasted row${rows.length === 1 ? "" : "s"}`, headers, rows });
      applyLayout(headers, target);
      setPaste(null);
      if (aiHelp) askForMapping(headers, rows);
    } catch (err) { setResult(["bad", `Couldn't read those rows: ${err.message}`]); }
  };
  const reset = () => { setCsv(null); setAiState(null); setIncludeManual(false); setSplit(true); setApplySizes(true); setSpreadMode("spread"); setImportCash(true); if (fileRef.current) fileRef.current.value = ""; };
  const resolveBroker = (raw) => { const v = raw.toLowerCase(); return brokers.find((b) => b.id.toLowerCase() === v || b.name.toLowerCase() === v)?.id || null; };
  // A file holding several broker accounts (e.g. two MT5 logins) is split into separate portal accounts,
  // because each account has its own margin level.
  const acctVals = useMemo(() => (csv && map.account && !map.broker ? [...new Set(csv.rows.map((r) => String(r[map.account] ?? "").trim()).filter(Boolean))] : []), [csv, map]);
  const splitting = split && acctVals.length > 1;
  const effMap = splitting ? { ...map, broker: map.account } : map;
  const parsed = useMemo(() => {
    if (!csv || !tb) return null;
    const p = rowsToFills(csv.rows, effMap, { dateFormat, defaultBroker: tb.id, resolveBroker, spreadMode });
    const c = classifyFills(p.fills, fills);
    return { ...p, rows: c.rows, counts: c.counts, sizes: estimateSizes(p.fills) };
  }, [csv, map, dateFormat, fills, target, splitting, spreadMode]);
  const sizeRows = parsed ? Object.entries(parsed.sizes).map(([k, v]) => {
    const [bid, prod] = k.split("|");
    const cur = brokers.find((b) => b.id === bid)?.products?.[prod]?.size;
    return { bid, prod, size: v.size, samples: v.samples, cur, differs: cur !== undefined && Math.abs(n(cur) - v.size) / v.size > 0.02 };
  }) : [];
  const toImport = parsed ? parsed.rows.filter((r) => r.status === "new" || (includeManual && r.status === "manual")) : [];
  // Deposits/withdrawals found in the file that aren't in the ledger yet (same account, amount, type and minute)
  const cashKey = (c) => `${c.broker}|${c.type}|${(+c.amount).toFixed(2)}|${String(c.ts).slice(0, 16)}`;
  const cashNew = parsed ? (() => { const have = new Set((settings.cash || []).map(cashKey)); return parsed.cash.filter((c) => !have.has(cashKey(c))); })() : [];
  const missingReq = FIELDS.filter((x) => x.required && !map[x.key]);

  const doImport = async () => {
    setBusy(true);
    try {
      const payload = toImport.map(({ key, status, matchTs, _profit, ...f }) => f);
      const ids = new Set(brokers.map((b) => b.id));
      const newIds = [...new Set(payload.map((f) => f.broker))].filter((id) => !ids.has(id));
      setSettings((st) => {
        const add = newIds.map((id) => ({ method: tb.method, leverage: tb.leverage, callRatio: tb.callRatio, stopRatio: tb.stopRatio, match: tb.match, capital: 0, id, name: id, products: {} }));
        const all = [...st.brokers, ...add].map((b) => {
          const prods = { ...b.products };
          // Legs are stored for reference only, so they don't get a product of their own.
          payload.filter((f) => f.broker === b.id && !f.is_leg).forEach((f) => {
            const est = parsed.sizes[`${b.id}|${f.product}`]?.size;
            if (!prods[f.product]) {
              // Spreads: start from the margin of the matching house product (BZ_CL, HO_CL, CL_CL) if the broker has it.
              const code = /inter-?product/i.test(f.product) && /BZ/.test(f.product) ? "BZ_CL" : /crack/i.test(f.product) ? "HO_CL" : /calendar/i.test(f.product) && /^CL/.test(f.product) ? "CL_CL" : null;
              const ref = code && b.products?.[code];
              prods[f.product] = { size: est || (b.method === "leverage" ? 100 : 1000), margin: ref ? n(ref.margin) : 0, lev: "",
                note: est ? "Size from broker P&L" : ref ? `Margin copied from ${code}. Confirm with the broker.` : "" };
            }
            else if (applySizes && est && Math.abs(n(prods[f.product].size) - est) / est > 0.02) prods[f.product] = { ...prods[f.product], size: est, note: "Size from broker P&L" };
          });
          return { ...b, products: prods };
        });
        return { ...st, brokers: all };
      });
      const newCash = importCash ? cashNew : [];
      if (newCash.length) setSettings((st) => ({ ...st, cash: [...(st.cash || []), ...newCash.map((c) => ({ ...c, id: crypto.randomUUID(), source: "csv" }))] }));
      const added = payload.length ? await addFills(payload) : 0;
      setBroker(tb.id, "csv", { map, dateFormat });
      const skipped = parsed.rows.length - added;
      setResult(["ok", `${newCash.length ? `Added ${newCash.length} deposit/withdrawal${newCash.length === 1 ? "" : "s"} to Funds · ` : ""}Imported ${added} new fill${added === 1 ? "" : "s"} to ${newIds.length || splitting ? acctVals.join(" & ") : tb.name}${newIds.length ? ` · created ${newIds.length} account${newIds.length === 1 ? "" : "s"} — record their deposits in Funds` : ""}${skipped ? ` · ${skipped} duplicate${skipped === 1 ? "" : "s"} skipped` : ""}${parsed.nonTrade ? ` · ${parsed.nonTrade} non-trade rows ignored` : ""}${parsed.errors.length ? ` · ${parsed.errors.length} unreadable rows` : ""}`]);
      reset();
    } catch (e) { setResult(["bad", `Import failed: ${e.message}`]); }
    setBusy(false);
  };
  const download = (text, name) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" })); a.download = name; a.click(); };


  // Dates are compared on the local calendar day, so "from 10 Sep to 10 Sep" keeps that whole day.
  const dayOf = (ts) => {
    const d = new Date(ts);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  // Legs hang under their spread rather than listing separately.
  const legsByOrder = {};
  fills.forEach((f) => { if (f.is_leg && f.order_id) (legsByOrder[`${f.broker}|${f.order_id}`] ||= []).push(f); });
  const shown = fills.filter((x) =>
    !x.is_leg &&
    (!filter.broker || x.broker === filter.broker) &&
    (!filter.product || x.product === filter.product) &&
    (!filter.side || x.side === filter.side) &&
    (!filter.from || dayOf(x.ts) >= filter.from) &&
    (!filter.to || dayOf(x.ts) <= filter.to)
  ).sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const filtered = !!(filter.broker || filter.product || filter.side || filter.from || filter.to);
  // Deleting acts on a whole broker, never on a filtered view, so the button is held back
  // while a narrowing filter is on — otherwise "Delete all" would bin far more than is on screen.
  const narrowed = !!(filter.product || filter.side || filter.from || filter.to);
  const productsInFills = [...new Set(fills.filter((x) => !x.is_leg && (!filter.broker || x.broker === filter.broker)).map((x) => x.product))].sort();
  const previewing = csv && parsed && !missingReq.length;
  const shortRef = (r) => (/^(fp|m):/.test(r) ? "auto" : String(r).split("|")[0]);

  return (
    <div className="grid-fills">
      <section className="panel">
        <div className="ph">
          <h2>Upload fills</h2>
          <div className="actions">
            <button className="btn ghost" onClick={() => download(ORIENT_TEMPLATE_CSV, "orient_fills_template.csv")} title="Orient (TT) fills export layout: spread fill plus its legs under one ID">Orient template</button>
            <button className="btn ghost" onClick={() => download(MT5_TEMPLATE_CSV, "mt5_deals_example.csv")} title="MT5 deals report layout">MT5 example</button>
          </div>
        </div>
        <div className="pb fg">
          <F label="Broker these fills belong to" hint={tb ? `${basis(tb)} · ${matchOf(tb) === "fifo" ? "FIFO" : "average price"}${tb.csv?.map ? " · saved column layout" : ""}` : null}>
            <select className="in" value={target} onChange={(e) => { setTarget(e.target.value); if (csv) applyLayout(csv.headers, e.target.value); }}>
              {brokers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </F>
          {!csv && paste === null ? (
            <>
              <div className={`drop ${over ? "over" : ""}`} role="button" tabIndex={0}
                onClick={() => fileRef.current?.click()} onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && fileRef.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setOver(true); }} onDragLeave={() => setOver(false)}
                onDrop={(e) => { e.preventDefault(); setOver(false); load(e.dataTransfer.files?.[0]); }}>
                <b>Drop a file here</b> or click to choose<br /><span className="faint" style={{ fontSize: 11 }}>Orient / TT exports or MT5 deal reports · CSV or Excel · duplicates are skipped</span>
              </div>
              <button className="btn ghost" style={{ marginTop: 8, width: "100%" }} onClick={() => setPaste("")}>Or paste rows from the Fills grid</button>
            </>
          ) : !csv ? (
            <>
              <F label="Paste rows" hint="In TT: select the fills, copy, then paste here. No header row needed.">
                <textarea className="in" rows={8} autoFocus value={paste} onChange={(e) => setPaste(e.target.value)}
                  style={{ fontFamily: "var(--num)", fontSize: 11, whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto" }}
                  placeholder={"11Sep26\t11:56:49.536\tCME\tCL Nov26\tB\t1\t95.29\tF\t…"} />
              </F>
              <div className="fg c2" style={{ marginTop: 8 }}>
                <button className="btn" disabled={!paste.trim()} onClick={loadPasted}>Read rows</button>
                <button className="btn ghost" onClick={() => { setPaste(null); setResult(null); }}>Cancel</button>
              </div>
            </>
          ) : (
            <>
              <div><b>{csv.name}</b> <span className="dim">· {csv.rows.length} rows</span>{savedLayout && <span className="ok" style={{ fontSize: 11, marginLeft: 6 }}>Using {tb.name}'s saved layout</span>}</div>

              {/*
                * Opt-in, and it says exactly what leaves the desk before it leaves.
                *
                * "Data is sent to a third party" buried in a policy is not consent; the
                * sentence belongs next to the tick box, in the moment somebody decides.
                */}
              <label className="check">
                <input type="checkbox" checked={aiHelp}
                  onChange={(e) => {
                    setAiHelp(e.target.checked);
                    // Ticking it with a file already open runs it now rather than on the next import.
                    if (e.target.checked && csv) askForMapping(csv.headers, csv.rows);
                    if (!e.target.checked) setAiState(null);
                  }} />
                <span>Help AI understand the schema or format<br />
                  <span className="faint">
                    Sends the column headings and three sample rows to Anthropic to work out which
                    column is which. Your fills, prices and positions are not sent, and nothing is
                    imported until you have checked the columns below.
                  </span>
                </span>
              </label>

              {aiState === "asking" && <div className="dim" style={{ fontSize: 12 }}>Reading the columns…</div>}
              {Array.isArray(aiState) && <div className="bad" style={{ fontSize: 12 }}>{aiState[1]} The columns below still work as they always did.</div>}
              {aiState && !Array.isArray(aiState) && aiState !== "asking" && (
                <div className={aiState.confidence === "high" ? "ok" : "warn"} style={{ fontSize: 12 }}>
                  Columns suggested ({aiState.confidence} confidence). Check them before importing.
                  {aiState.notes ? ` ${aiState.notes}` : ""}
                  {/* A dropped column means a suggested heading was not in the file. Said out
                      loud, because it is a reason to read the rest more carefully. */}
                  {aiState.dropped > 0 && ` ${aiState.dropped} suggestion${aiState.dropped === 1 ? " was" : "s were"} discarded for naming a column this file does not have.`}
                </div>
              )}

              <div className="fg c2">
                {FIELDS.map((fd) => (
                  <F key={fd.key} label={fd.label + (fd.required ? "" : " (opt.)")}>
                    <select className="in" style={{ borderColor: fd.required && !map[fd.key] ? "var(--bad)" : undefined }} value={map[fd.key] || ""} onChange={(e) => { setMap((m) => ({ ...m, [fd.key]: e.target.value || undefined })); setSavedLayout(false); }}>
                      <option value="">—</option>{csv.headers.map((h) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </F>
                ))}
                <F label="Date format"><select className="in" value={dateFormat} onChange={(e) => setDateFormat(e.target.value)}><option value="auto">Auto</option><option value="DMY">DD/MM/YYYY</option><option value="MDY">MM/DD/YYYY</option></select></F>
              </div>
              {map.broker && <small className="dim">Rows use the file's broker column; blank rows go to {tb.name}.</small>}
              {parsed?.spreadOrders > 0 && (
                <F label={`Spread trades found: ${parsed.spreadOrders} orders with a spread fill and its legs`} hint="Legs and spread are the same trade, so only one side is kept. Brokers like Orient margin the spread.">
                  <select className="in" value={spreadMode} onChange={(e) => setSpreadMode(e.target.value)}>
                    <option value="spread">Track the spread fills (recommended)</option>
                    <option value="legs">Track the leg fills instead</option>
                    <option value="all">Keep both (counts each trade twice)</option>
                  </select>
                </F>
              )}
              {acctVals.length > 1 && (
                <label className="check">
                  <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
                  <span>Track each account separately ({acctVals.join(", ")})<br /><span className="faint">Each broker account has its own margin level. New accounts copy {tb.name}'s margin method, leverage and levels.</span></span>
                </label>
              )}
              {sizeRows.length > 0 && (
                <div className="preview" style={{ marginTop: 0 }}>
                  <span style={{ gridColumn: "1 / -1", color: "var(--text)", fontWeight: 600 }}>Contract size worked out from the broker's P&L</span>
                  {sizeRows.flatMap((r) => [<span key={`${r.bid}|${r.prod}|n`}>{r.prod}{splitting ? ` · ${r.bid}` : ""}</span>, <span key={`${r.bid}|${r.prod}|v`} className={r.differs ? "warn" : ""}>{r.size.toLocaleString()}{r.differs ? ` (you have ${n(r.cur).toLocaleString()})` : ""}</span>])}
                  {sizeRows.some((r) => r.differs) && (
                    <label className="check" style={{ gridColumn: "1 / -1", marginTop: 4 }}>
                      <input type="checkbox" checked={applySizes} onChange={(e) => setApplySizes(e.target.checked)} />
                      <span>Update the sizes that differ</span>
                    </label>
                  )}
                </div>
              )}
              {cashNew.length > 0 && (
                <label className="check">
                  <input type="checkbox" checked={importCash} onChange={(e) => setImportCash(e.target.checked)} />
                  <span>Also add {cashNew.length} deposit/withdrawal{cashNew.length === 1 ? "" : "s"} found in this report to Funds<br /><span className="faint">{cashNew.slice(0, 3).map((c) => `${c.type === "deposit" ? "+" : "−"}${money(c.amount)} on ${dt(c.ts)}`).join(" · ")}{cashNew.length > 3 ? " …" : ""}</span></span>
                </label>
              )}
              {missingReq.length > 0 ? <div className="bad">Choose a column for: {missingReq.map((x) => x.label).join(", ")}</div> : parsed && (
                <div>
                  <div className="preview" style={{ marginTop: 0 }}>
                    <span>New fills</span><span className="ok">{parsed.counts.new}</span>
                    <span>Already in portal</span><span className="dim">{parsed.counts.stored}</span>
                    <span>Repeated in this file</span><span className="dim">{parsed.counts.fileDup}</span>
                    <span>Match trades recorded manually</span><span className={parsed.counts.manual ? "warn" : "dim"}>{parsed.counts.manual}</span>
                    {parsed.nonTrade > 0 && <><span>Non-trade rows (deposits etc.)</span><span className="dim">{parsed.nonTrade}</span></>}
                    {(parsed.legsSkipped > 0 || parsed.spreadsSkipped > 0) && <><span>{parsed.legsSkipped ? "Leg rows set aside (part of spread trades)" : "Spread rows set aside (legs kept)"}</span><span className="dim">{parsed.legsSkipped || parsed.spreadsSkipped}</span></>}
                    {parsed.errors.length > 0 && <><span>Unreadable rows</span><span className="warn">{parsed.errors.length}</span></>}
                  </div>
                  {parsed.counts.manual > 0 && (
                    <label className="check" style={{ marginTop: 8 }}>
                      <input type="checkbox" checked={includeManual} onChange={(e) => setIncludeManual(e.target.checked)} />
                      <span>Import the {parsed.counts.manual} manual match{parsed.counts.manual === 1 ? "" : "es"} too<br /><span className="faint">Same broker, product, side, quantity and price within 15 minutes of a ticket entry.</span></span>
                    </label>
                  )}
                  {parsed.errors.length > 0 && <div className="msgs warn">{parsed.errors.slice(0, 4).map((e) => <div key={e}>{e}</div>)}{parsed.errors.length > 4 && <div>…and {parsed.errors.length - 4} more</div>}</div>}
                </div>
              )}
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn" style={{ flex: 1 }} disabled={busy || missingReq.length > 0 || (!toImport.length && !(importCash && cashNew.length))} onClick={doImport}>{busy ? "Importing…" : !toImport.length && importCash && cashNew.length ? `Add ${cashNew.length} to Funds` : toImport.length ? `Import ${toImport.length} to ${splitting ? `${acctVals.length} accounts` : effMap.broker ? "brokers" : tb.name}` : "Nothing new to import"}</button>
                <button className="btn ghost" onClick={reset}>Cancel</button>
              </div>
            </>
          )}
          <input ref={fileRef} type="file" accept=".csv,.txt,.tsv,.xlsx,.xlsm,.xlsb,.xls,.ods,text/csv" hidden onChange={(e) => load(e.target.files?.[0])} />
          {result && <div className={result[0]}>{result[1]}</div>}
        </div>
      </section>

      <section className="panel">
        <div className="ph">
          <h2>{previewing ? "Preview" : "All fills"}<span className="dim">{previewing ? `${toImport.length} of ${parsed.rows.length} will be imported` : shown.length}</span></h2>
          {!csv && (
            <div className="actions">
              <select className="in" style={{ width: "auto", padding: "4px 8px" }} value={filter.broker} onChange={(e) => setFilter((x) => ({ ...x, broker: e.target.value, product: "" }))} aria-label="Filter by broker">
                <option value="">All brokers</option>{brokers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </select>
              <select className="in" style={{ width: "auto", padding: "4px 8px" }} value={filter.product} onChange={(e) => setFilter((x) => ({ ...x, product: e.target.value }))} aria-label="Filter by product">
                <option value="">All products</option>{productsInFills.map((p) => <option key={p}>{p}</option>)}
              </select>
              <select className="in" style={{ width: "auto", padding: "4px 8px" }} value={filter.side} onChange={(e) => setFilter((x) => ({ ...x, side: e.target.value }))} aria-label="Filter by buy or sell">
                <option value="">Buy &amp; sell</option><option value="Buy">Buy only</option><option value="Sell">Sell only</option>
              </select>
              <input className="in" style={{ width: "auto", padding: "4px 8px" }} type="date" value={filter.from}
                onChange={(e) => setFilter((x) => ({ ...x, from: e.target.value }))} aria-label="Fills from this date" title="From this date" />
              <input className="in" style={{ width: "auto", padding: "4px 8px" }} type="date" value={filter.to}
                onChange={(e) => setFilter((x) => ({ ...x, to: e.target.value }))} aria-label="Fills up to this date" title="Up to this date" />
              {filtered && <button className="btn ghost" onClick={() => setFilter({ broker: "", product: "", side: "", from: "", to: "" })}>Clear filters</button>}
              <button className="btn ghost" disabled={!fills.length} onClick={() => downloadBackup(fills, brokers)}>Export CSV</button>
              <button className="btn ghost red" disabled={!shown.length || narrowed}
                title={narrowed ? "Clear the product, side and date filters first — deleting only works on a whole broker" : undefined}
                onClick={async () => {
                const one = filter.broker;
                const list = one ? fills.filter((x) => x.broker === filter.broker) : fills;
                const ok = await safeDelete({ fills: list, brokers, label: one ? filter.broker : "all", what: one ? `all ${list.length} ${bname(filter.broker)} fills` : `all ${list.length} fills across every broker`, run: () => (one ? db.deleteBrokerFills(filter.broker) : db.deleteAllFills()) });
                if (ok) await reloadFills();
              }}>{filter.broker && !filter.product ? `Delete ${bname(filter.broker)} fills` : "Delete all"}</button>
            </div>
          )}
        </div>
        {previewing ? (
          <div className="tw tall">
            <table>
              <thead><tr><th className="txt">Status</th><th>Time</th><th className="txt">Broker</th><th className="txt">Product</th><th>Side</th><th>Qty</th><th>Price</th><th>Fee</th><th>Fill ID</th></tr></thead>
              <tbody>{parsed.rows.slice(0, 300).map((x, i) => {
                const willImport = x.status === "new" || (includeManual && x.status === "manual");
                const label = { new: "New", stored: "Already in portal", "file-dup": "Repeated in file", manual: includeManual ? "New (manual match)" : "Matches manual trade" }[x.status];
                const c = willImport ? "ok" : x.status === "manual" ? "warn" : "dim";
                return (
                  <tr key={i} style={willImport ? undefined : { opacity: 0.55 }}>
                    <td className="txt"><span className={`pill ${c}`}><span className={c}>{label}</span></span></td>
                    <td className="dim">{dt(x.ts)}</td><td className="txt dim">{bname(x.broker)}</td><td className="txt">{x.product}</td><td><Side s={x.side} /></td><td>{qty(x.qty)}</td><td>{px(x.price)}</td><td className={x.fee ? "bad" : "faint"}>{x.fee ? x.fee.toFixed(2) : "—"}</td><td className="faint">{shortRef(x.ref)}</td>
                  </tr>
                );
              })}</tbody>
            </table>
          </div>
        ) : fills.length === 0 ? (
          <div className="empty">No fills stored yet. Choose a broker, then upload its CSV, or record a trade from the ticket.</div>
        ) : (
          <div className="tw tall">
            <table>
              <thead><tr><th>Time</th><th className="txt">Broker</th><th className="txt">Account</th><th className="txt">Product</th><th>Side</th><th>Qty</th><th>Price</th><th>Fee</th><th>Fill ID</th><th className="txt">Source</th><th></th></tr></thead>
              <tbody>
                {shown.slice(0, limit).map((x) => {
                  const key = `${x.broker}|${x.order_id}`;
                  const legs = x.order_id ? legsByOrder[key] : null;
                  const open = legs && openLegs === key;
                  return (
                  <React.Fragment key={x.id}>
                  <tr className={legs ? "clickable" : undefined} onClick={legs ? () => setOpenLegs(open ? null : key) : undefined}>
                    <td className="dim">{dt(x.ts)}</td><td className="txt dim">{bname(x.broker)}</td>
                    <td className="txt faint" title="The broker's own account number, as it appears in the file">{x.account || "—"}</td>
                    <td className="txt">
                      {legs && <span className="faint" style={{ marginRight: 5 }} aria-hidden="true">{open ? "▾" : "▸"}</span>}
                      {x.product}
                      {legs && <span className="tag" style={{ marginLeft: 6 }}>{legs.length} legs</span>}
                    </td>
                    <td><Side s={x.side} /></td><td>{qty(x.qty)}</td><td>{px(x.price)}</td>
                    <td className={+x.fee ? "bad" : "faint"}>{+x.fee ? (+x.fee).toFixed(2) : "—"}</td>
                    <td className="faint">{shortRef(x.ref)}</td><td className="faint txt">{x.source === "csv" ? "CSV" : "Manual"}</td>
                    <td><button className="btn ghost" onClick={async (e) => {
                      e.stopPropagation();
                      const { ok } = await ask({
                        title: "Delete this fill?",
                        body: `${x.side} ${qty(x.qty)} ${x.product} at ${px(x.price)} on ${dt(x.ts)}.`,
                        detail: "Positions and P&L are worked out from the fills, so they will change. Re-importing the file will bring it back.",
                        confirmLabel: "Delete fill", tone: "danger",
                      });
                      if (ok) { await db.deleteFill(x.id); await reloadFills(); }
                    }} aria-label="Delete fill">✕</button></td>
                  </tr>
                  {open && legs.map((g) => (
                    <tr key={g.id} className="leg">
                      <td className="faint">{dt(g.ts)}</td><td></td><td></td>
                      <td className="txt faint" style={{ paddingLeft: 28 }}>{g.product}</td>
                      <td><Side s={g.side} /></td><td className="faint">{qty(g.qty)}</td><td className="faint">{px(g.price)}</td>
                      <td colSpan={4} className="txt faint" style={{ fontSize: 11 }}>leg of this spread · not counted in the position</td>
                    </tr>
                  ))}
                  </React.Fragment>
                  );
                })}
              </tbody>
            </table>
            {shown.length > limit && <div className="pb"><button className="btn ghost" onClick={() => setLimit(limit + 500)}>Show {Math.min(500, shown.length - limit)} more</button></div>}
          </div>
        )}
      </section>
    </div>
  );
}

// ---------- closed ----------
function ClosedTab({ pf, settings, view, fills }) {
  const [filter, setFilter] = useState({ broker: view !== "all" ? view : "", product: "" });
  const [open, setOpen] = useState(null);
  // Spread legs, keyed by the broker order they belong to, so a closed trade can show
  // what its two instruments actually filled at going in and coming out.
  const legsByOrder = useMemo(() => {
    const m = {};
    (fills || []).forEach((f) => { if (f.is_leg && f.order_id) (m[`${f.broker}|${f.order_id}`] ||= []).push(f); });
    return m;
  }, [fills]);
  const legsFor = (broker, orders) => (orders || []).flatMap((o) => legsByOrder[`${broker}|${o}`] || []);
  const bname = (id) => settings.brokers.find((b) => b.id === id)?.name || id;
  const closed = pf.book.closed.filter((c) => (!filter.broker || c.broker === filter.broker) && (!filter.product || c.product === filter.product));
  const total = sum(closed, (c) => c.pnl);
  const wins = closed.filter((c) => c.pnl > 0), losses = closed.filter((c) => c.pnl < 0);
  const today = sum(pf.book.realized.filter((r) => isToday(r.ts) && (!filter.broker || r.broker === filter.broker)), (r) => r.pnl);
  const products = [...new Set(pf.book.closed.filter((c) => !filter.broker || c.broker === filter.broker).map((c) => c.product))].sort();
  return (
    <section className="panel">
      <div className="strip">
        <div className="kpi"><label>Realized P&L</label><b className={pc(total)}>{signed(total)}</b></div>
        <div className="kpi"><label>Today</label><b className={pc(today)}>{signed(today)}</b></div>
        <div className="kpi"><label>Closed trades</label><b>{closed.length}</b></div>
        <div className="kpi"><label>Win rate</label><b>{closed.length ? pct(wins.length / closed.length) : "—"}</b></div>
        <div className="kpi"><label>Avg win</label><b className="ok">{wins.length ? money(sum(wins, (c) => c.pnl) / wins.length) : "—"}</b></div>
        <div className="kpi"><label>Avg loss</label><b className="bad">{losses.length ? money(sum(losses, (c) => c.pnl) / losses.length) : "—"}</b></div>
      </div>
      <div className="ph">
        <h2>Closed trades<span className="dim">FIFO-matched for futures brokers, per ticket for MT5 hedging</span></h2>
        <div className="actions">
          <select className="in" style={{ width: "auto", padding: "4px 8px" }} value={filter.broker} onChange={(e) => setFilter({ broker: e.target.value, product: "" })} aria-label="Filter by broker">
            <option value="">All brokers</option>{settings.brokers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <select className="in" style={{ width: "auto", padding: "4px 8px" }} value={filter.product} onChange={(e) => setFilter((x) => ({ ...x, product: e.target.value }))} aria-label="Filter by product">
            <option value="">All products</option>{products.map((p) => <option key={p}>{p}</option>)}
          </select>
        </div>
      </div>
      {closed.length === 0 ? <div className="empty">No closed trades yet.</div> : (
        <div className="tw tall">
          <table>
            <thead><tr><th className="txt">Broker</th><th className="txt">Product</th><th>Side</th><th>Lots</th><th>Entry</th><th>Exit</th><th>Opened</th><th>Closed</th><th>Fees</th><th>Realized P&L</th></tr></thead>
            <tbody>
              {closed.map((c, i) => {
                const inLegs = legsFor(c.broker, c.openOrders), outLegs = legsFor(c.broker, c.closeOrders);
                // A count here would render as a stray "0" beside every product that has no legs.
                const hasLegs = inLegs.length > 0 || outLegs.length > 0;
                const isOpen = open === i;
                return (
                <React.Fragment key={i}>
                <tr className={hasLegs ? "clickable" : undefined} onClick={hasLegs ? () => setOpen(isOpen ? null : i) : undefined}>
                  <td className="txt dim">{bname(c.broker)}</td>
                  <td className="txt">
                    {hasLegs && <span className="faint" style={{ marginRight: 5 }} aria-hidden="true">{isOpen ? "▾" : "▸"}</span>}
                    <b>{c.product}</b>
                  </td>
                  <td><Side s={c.side} /></td><td>{qty(c.qty)}</td>
                  <td>{px(c.avgEntry)}</td><td>{px(c.avgExit)}</td><td className="dim">{dt(c.openTs)}</td><td className="dim">{dt(c.closeTs)}</td>
                  <td className={c.fees ? "bad" : "faint"}>{c.fees ? money(c.fees) : "—"}</td><td className={pc(c.pnl)}><b>{signed(c.pnl)}</b></td>
                </tr>
                {isOpen && [["Entry", inLegs], ["Exit", outLegs]].map(([lab, ls]) =>
                  ls.length ? ls.map((g) => (
                    <tr key={`${lab}-${g.id}`} className="leg">
                      <td className="txt faint">{lab} leg</td>
                      <td className="txt faint" style={{ paddingLeft: 28 }}>{g.product}</td>
                      <td><Side s={g.side} /></td><td className="faint">{qty(g.qty)}</td>
                      <td className="faint" colSpan={2}>{px(g.price)}</td>
                      <td className="faint" colSpan={2}>{dt(g.ts)}</td>
                      <td colSpan={2} className="txt faint" style={{ fontSize: 11 }}>
                        {lab === "Entry" ? "filled when the spread was opened" : "filled when the spread was closed"}
                      </td>
                    </tr>
                  )) : (
                    <tr key={lab} className="leg">
                      <td className="txt faint">{lab} leg</td>
                      <td colSpan={9} className="txt faint" style={{ fontSize: 11 }}>No legs recorded for this side — re-import the fills to capture them.</td>
                    </tr>
                  )
                )}
                </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// ---------- settings ----------
function SettingsTab({ settings, setSettings, pf, fills, reloadFills }) {
  const addBroker = () => {
    const id = `b${Date.now().toString(36)}`;
    setSettings((s) => ({ ...s, brokers: [...s.brokers, { ...NEW_BROKER, id, name: `Broker ${s.brokers.length + 1}` }] }));
  };
  return (
    <div className="grid-settings">
      <LimitsPanel settings={settings} setSettings={setSettings} pf={pf} addBroker={addBroker} />

      <ResetPanel settings={settings} setSettings={setSettings} fills={fills} reloadFills={reloadFills} />

      {/* Only where there is an account to close. In browser-storage mode there is no
          server, no subscription and nobody to ask — "delete all fills" above is already
          the whole of it. */}
      {isRemote && <CloseAccountPanel fills={fills} brokers={settings.brokers} />}

      {settings.brokers.map((b) => (
        <BrokerCard key={b.id} b={b} acc={pf.acct(b.id)} minRatio={settings.limits.minRatio} used={fills.some((f) => f.broker === b.id)} inUse={new Set(pf.rows.filter((r) => r.broker === b.id).map((r) => r.product))}
          setSettings={setSettings} />
      ))}
    </div>
  );
}

function LimitsPanel({ settings, setSettings, pf, addBroker }) {
  const [d, setD, dirty, discard] = useDraft(settings.limits);
  useDirtyFlag("limits", dirty);
  const set = (k, v) => setD((x) => ({ ...x, [k]: v }));
  const lnum = (k, props = {}) => <input className="in" type="number" value={d[k]} onChange={(e) => set(k, e.target.value)} {...props} />;
  const save = () => setSettings((s) => ({ ...s, limits: { ...s.limits, ...d } }));
  return (
    <section className="panel">
      <div className="ph"><h2>Your limits</h2><span className="faint" style={{ fontSize: 11 }}>Apply to every broker</span></div>
      <div className="pb">
        <div className="fg c2">
          <F label="Minimum TNE/IM (%)" hint="Per broker account; new trades below it are flagged">{lnum("minRatio")}</F>
          <F label="Max open positions" hint="Across all brokers">{lnum("maxTrades")}</F>
          <F label="Max risk per trade (% of that broker's capital)">{lnum("maxRiskPct", { step: 0.1 })}</F>
          {/* Across the desk where that means something; per account where it does not. */}
          <F label={`Daily loss limit (% of ${pf.dailyCap === null ? "each account's" : "total"} capital)`}
            hint={pf.dailyCap === null ? "Applied per account — your accounts are in different currencies" : (dirty ? "Saved figure: " + money(pf.dailyCap) : money(pf.dailyCap))}>{lnum("dailyLossPct", { step: 0.1 })}</F>
        </div>
        <div className="sep" />
        <label className="check">
          <input type="checkbox" checked={!!d.includeRealized} onChange={(e) => set("includeRealized", e.target.checked)} />
          {/* The total is only meaningful while every account is in the same money; with
              several it would add rupees to dollars, so it is named per account instead. */}
          <span>Add realized P&L (after fees) to each account's equity{pf.dailyCap === null
            ? <> (<span className="faint">{pf.accounts.map((a) => `${a.name} ${signed(a.realizedAll, a.currency)}`).join(" · ")}</span>)</>
            : <> (<span className={`num ${pc(pf.total.realizedAll)}`}>{signed(pf.total.realizedAll)}</span> in total)</>}<br /><span className="faint">Untick if you update each broker's capital yourself after closing trades.</span></span>
        </label>
      </div>
      <SaveBar dirty={dirty} onSave={save} onDiscard={discard} savedNote="Limits are up to date" />
      <div className="pb"><button className="btn full" onClick={addBroker}>Add broker account</button></div>
    </section>
  );
}

function BrokerCard({ b, acc, used, inUse, setSettings, minRatio }) {
  const ask = useConfirm();
  const [newP, setNewP] = useState("");
  const [d, setD, dirty, discard] = useDraft(b);
  useDirtyFlag(`broker:${b.id}`, dirty);
  // Products the trader took out here, so an import re-adding them on save can't undo it.
  const dropped = useRef(new Set());
  const set = (k) => (e) => setD((x) => ({ ...x, [k]: e.target.value }));
  const setP = (p, k, v) => setD((x) => ({ ...x, products: { ...x.products, [p]: { ...x.products?.[p], [k]: v } } }));
  const lev = d.method === "leverage";
  const addProduct = () => {
    const p = newP.trim();
    if (!p || d.products?.[p]) return;
    dropped.current.delete(p);
    setP(p, "size", lev ? 100 : 1000);
    setNewP("");
  };
  const dropProduct = (p) => {
    dropped.current.add(p);
    setD((x) => { const { [p]: _gone, ...rest } = x.products || {}; return { ...x, products: rest }; });
  };
  const save = () => setSettings((s) => ({
    ...s,
    brokers: s.brokers.map((x) => {
      if (x.id !== b.id) return x;
      // A product an import added while this card was open is kept, unless it was removed here.
      const added = Object.fromEntries(Object.entries(x.products || {}).filter(([p]) => !(p in (d.products || {})) && !dropped.current.has(p)));
      return { ...d, products: { ...d.products, ...added } };
    }),
  }));
  const remove = async () => {
    if (used) return;
    const { ok } = await ask({
      title: `Remove ${b.name}?`,
      body: "Its capital, margins, contract sizes and commission settings will be removed.",
      detail: "It has no fills, so no trade history is lost. Uploading a file for this account again recreates it with default settings.",
      confirmLabel: "Remove account", tone: "danger",
    });
    if (ok) setSettings((s) => ({ ...s, brokers: s.brokers.filter((x) => x.id !== b.id), view: s.view === b.id ? "all" : s.view }));
  };
  return (
    <section className="panel">
      <div className="ph">
        <h2>{d.name}<span className="dim">{basis(d)}</span></h2>
        <div className="actions">
          {acc && isFinite(acc.ratio) && <span className="num" style={{ fontSize: 12 }}>TNE/IM <b>{ratioTxt(acc.ratio)}</b></span>}
          <button className="btn ghost" disabled={used} title={used ? "This broker has fills. Delete them first to remove it." : "Remove broker"} onClick={remove}>Remove</button>
        </div>
      </div>
      <div className="pb">
        <div className="fg c2">
          <F label="Broker / account name"><input className="in" value={d.name} onChange={set("name")} /></F>
          {/*
            The currency this account is denominated in — capital, margin per lot, prices
            and P&L all in it. RAMP does not convert between currencies and will not: a
            converted P&L carries an exchange gain your broker statement does not have, and
            the statement is what you reconcile against. What it does instead is stop
            offering a combined view once your accounts disagree. See mixedCurrency.
          */}
          <F label="Currency" hint="Everything on this account is in it. No conversion is ever applied.">
            <select className="in" value={d.currency || "USD"} onChange={set("currency")}>
              {["USD","INR","EUR","GBP","JPY","AUD","CAD","CHF","SGD","AED","HKD","CNY"].map((c) => (
                <option key={c} value={c}>{c} {symbolFor(c).trim()}</option>
              ))}
            </select>
          </F>
          {acc?.fund?.fromLedger
            ? <F label={`Capital in this account (${symbolFor(d.currency).trim()})`} hint="Net deposits from the Funds tab"><div className="in num" style={{ background: "var(--panel2)" }}>{money(acc.fund.net, d.currency)}</div></F>
            : <F label={`Capital in this account (${symbolFor(d.currency).trim()})`} hint="Or record deposits in the Funds tab"><input className="in" type="number" value={d.capital} onChange={set("capital")} /></F>}
          <F label="How margin is set">
            <select className="in" value={d.method} onChange={set("method")}>
              <option value="fixed">Broker gives margin per lot (e.g. Orient)</option>
              <option value="leverage">Leverage, e.g. 1:100 (e.g. MT5)</option>
            </select>
          </F>
          {lev ? (
            <F label="Account leverage (1 : X)" hint={`Margin = lots × contract size × price ÷ ${n(d.leverage) || "X"}`}>
              <select className="in" value={LEVERAGES.includes(+d.leverage) ? d.leverage : "custom"} onChange={(e) => e.target.value !== "custom" && setD((x) => ({ ...x, leverage: +e.target.value }))}>
                {LEVERAGES.map((l) => <option key={l} value={l}>1:{l}</option>)}
                {!LEVERAGES.includes(+d.leverage) && <option value="custom">1:{d.leverage}</option>}
              </select>
            </F>
          ) : <F label="Margin per lot" hint="Set per product below"><div className="in dim" style={{ background: "var(--panel2)" }}>From broker</div></F>}
          <F label="Closing trades are matched" hint={d.match ? null : "Default for this margin method"}>
            <select className="in" value={matchOf(d)} onChange={set("match")}>
              <option value="fifo">FIFO: oldest lots first (e.g. Orient)</option>
              <option value="average">Average price (e.g. MT5 netting)</option>
            </select>
          </F>
          <F label={`Commission per lot (${symbolFor(d.currency).trim()})`} hint="Per side. Only used where the fill carries no commission of its own.">
            <input className="in" type="number" step="0.01" placeholder="0" value={d.commission ?? ""} onChange={set("commission")} />
          </F>
          <F label="Margin call level (TNE/IM %)" hint={lev ? "MT5: 'Margin call' level" : null}><input className="in" type="number" value={d.callRatio} onChange={set("callRatio")} /></F>
          <F label="Stop-out level (TNE/IM %)" hint={lev ? "MT5: 'Stop out' level" : null}><input className="in" type="number" value={d.stopRatio} onChange={set("stopRatio")} /></F>
          <F label="Your own minimum (TNE/IM %)" hint="Set once in Your limits — it applies to every account">
            <div className="in dim" style={{ background: "var(--panel2)" }}>{minRatio}%</div>
          </F>
        </div>
      </div>
      <div className="tw">
        <table>
          <thead><tr><th className="txt">Product</th><th>Contract size</th><th>{lev ? "Leverage override" : `Margin / lot (${symbolFor(d.currency).trim()})`}</th><th>Commission / lot</th><th></th></tr></thead>
          <tbody>
            {Object.keys(d.products || {}).length === 0 && <tr><td colSpan={5} className="txt faint">No products yet. They're added automatically when you upload fills, or add one below.</td></tr>}
            {Object.entries(d.products || {}).sort(([x], [y]) => x.localeCompare(y)).map(([p, sp]) => (
              <tr key={p}>
                <td className="txt"><b>{p}</b>{sp.note && <div className="faint" style={{ fontSize: 11 }}>{sp.note}</div>}</td>
                <td><input className="cell" type="number" value={sp.size ?? ""} onChange={(e) => setP(p, "size", e.target.value)} aria-label={`${p} contract size`} /></td>
                <td>{lev
                  ? <input className="cell" type="number" placeholder={`1:${d.leverage}`} value={sp.lev ?? ""} onChange={(e) => setP(p, "lev", e.target.value)} aria-label={`${p} leverage override`} />
                  : <input className={`cell ${n(sp.margin) ? "" : "need"}`} style={{ width: 96 }} type="number" placeholder="Set" value={sp.margin ?? ""} onChange={(e) => setP(p, "margin", e.target.value)} aria-label={`${p} margin per lot`} />}</td>
                <td><input className="cell" type="number" step="0.01" placeholder={n(d.commission) ? money(n(d.commission), d.currency) : "0"}
                  value={sp.comm ?? ""} onChange={(e) => setP(p, "comm", e.target.value)}
                  aria-label={`${p} commission per lot`} title="Overrides the account rate. A spread billed per leg costs twice the leg rate." /></td>
                <td>{!inUse.has(p) && <button className="btn ghost" aria-label={`Remove ${p}`} onClick={() => dropProduct(p)}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pb faint" style={{ fontSize: 11, paddingBottom: 0 }}>
        Products appear here on their own when you import fills. Add one by hand only to trade something
        before its first fill — and spell it exactly as {d.name} does, or the import will treat it as a
        second product and split the position.
      </div>
      <div className="pb" style={{ display: "flex", gap: 8 }}>
        <input className="in" placeholder={lev ? "Add symbol, e.g. XBRUSD" : "Add product, e.g. CL Dec26 - BZ Dec26 Inter-Product"}
          value={newP} onChange={(e) => setNewP(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addProduct()}
          aria-label={`Add a product to ${d.name}`} />
        <button className="btn" disabled={!newP.trim() || !!d.products?.[newP.trim()]} onClick={addProduct}>Add</button>
      </div>
      <SaveBar dirty={dirty} onSave={save} onDiscard={discard} savedNote="This account is up to date" />
    </section>
  );
}

// ---------- reset / delete data ----------
/*
 * Closing the account for good.
 *
 * Kept apart from "delete or reset data" above, and deliberately not a tidy little button
 * beside it. Those controls clear a bad upload and you carry on trading; this one ends the
 * relationship, and the two should never be one mis-click apart.
 *
 * Three gates before anything happens: read what goes and what stays, type the word, then
 * confirm. That is more friction than a delete usually deserves — which is the point, for
 * the one action in Nexus that cannot be walked back.
 */
function CloseAccountPanel({ fills, brokers }) {
  const ask = useConfirm();
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const armed = typed.trim().toUpperCase() === "DELETE";

  const close = async () => {
    if (!armed) return;
    setErr(null);

    const { ok, checked } = await ask({
      title: "Delete your account and everything in it?",
      body: `Your ${fills.length} fill${fills.length === 1 ? "" : "s"}, every broker account, your limits, your funds ledger and your settings will be deleted. Any subscription is cancelled straight away.`,
      detail: "We keep the record of payments you have made, because tax law requires it. Everything else goes. This cannot be undone, and we cannot recover it for you afterwards.",
      checkbox: { label: "Download a CSV backup of my fills first", defaultChecked: true },
      confirmLabel: "Delete my account",
      tone: "danger",
    });
    if (!ok) return;

    /*
     * The backup is written before the request goes, not after it comes back. Afterwards
     * there is no session left to fetch anything with, and a backup that depends on the
     * deletion succeeding is not a backup.
     */
    if (checked && fills.length) downloadBackup(fills, brokers, "all");

    setBusy(true);
    try {
      const r = await fetch("/api/account", {
        method: "DELETE", headers: await authHeader(), body: JSON.stringify({ confirm: "DELETE" }),
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(body.error || "Could not delete your account.");

      /*
       * Signed out from this browser too. The account is banned server-side so the token
       * is already worthless, but leaving a dead session in localStorage means the next
       * page load spends a moment pretending to be signed in to nothing.
       */
      await auth.signOut();
      window.location.href = "/";
    } catch (e) { setErr(e.message); setBusy(false); }
  };

  return (
    <section className="panel reset">
      <div className="ph">
        <h2>Close your account</h2>
        <span className="faint" style={{ fontSize: 11 }}>Permanent. Not the same as cancelling.</span>
      </div>
      <div className="pb fg">
        <p className="dim" style={{ fontSize: 12, margin: 0 }}>
          <b>Deleted:</b> every fill, every broker account, your limits, prices, scenario settings
          and funds ledger, any notes we hold about you, and the record of emails we have sent you.
        </p>
        <p className="dim" style={{ fontSize: 12, margin: 0 }}>
          {/* Said plainly and up front rather than buried in a policy. Somebody asking to be
              erased is entitled to know what survives and why, before they decide. */}
          <b>Kept:</b> the record of payments you have made. Tax rules require us to hold it,
          and it is what lets us answer your bank if a charge is ever disputed. It contains
          what you paid and when — no trades, and nothing from your book.
        </p>
        <p className="dim" style={{ fontSize: 12, margin: 0 }}>
          If you only want to stop paying, cancel your subscription instead — your data stays
          and you can come back to it.
        </p>
        <div className="sep" style={{ margin: "4px 0" }} />
        <F label="Type DELETE to confirm" hint="Case-insensitive. Nothing happens until you press the button.">
          <input className="in" value={typed} onChange={(e) => { setTyped(e.target.value); setErr(null); }}
            placeholder="DELETE" autoComplete="off" spellCheck={false} />
        </F>
        {err && <div className="signin-err">{err}</div>}
        <button className="btn danger" disabled={!armed || busy} onClick={close}>
          {busy ? "Deleting…" : "Delete my account"}
        </button>
      </div>
    </section>
  );
}

function ResetPanel({ settings, setSettings, fills, reloadFills }) {
  const ask = useConfirm();
  const brokers = settings.brokers;
  const [bid, setBid] = useState(brokers[0]?.id || "");
  const [msg, setMsg] = useState(null);
  const b = brokers.find((x) => x.id === bid);
  const mine = fills.filter((f) => f.broker === bid);
  const done = (t) => setMsg(["ok", t]);
  const delBroker = async () => {
    if (await safeDelete({ fills: mine, brokers, label: bid, what: `all ${mine.length} ${b?.name} fills`, run: () => db.deleteBrokerFills(bid), ask })) { await reloadFills(); done(`Deleted ${b?.name}'s fills. Its settings are kept, so you can re-upload.`); }
  };
  const delAll = async () => {
    if (await safeDelete({ fills, brokers, label: "all", what: `all ${fills.length} fills across every broker`, run: () => db.deleteAllFills(), ask })) { await reloadFills(); done("Deleted all fills. Broker settings are kept."); }
  };
  const resetSettings = async () => {
    if (fills.length) { setMsg(["bad", "Delete the fills first. Otherwise accounts would be recreated from them with default settings."]); return; }
    const { ok } = await ask({
      title: "Reset every setting to the defaults?",
      body: "Broker accounts, capital, margins per lot, contract sizes, your limits, prices, scenario moves and the funds ledger all go back to how they started.",
      detail: "There are no fills stored, so no trade history is affected. This cannot be undone.",
      confirmLabel: "Reset everything", tone: "danger",
    });
    if (!ok) return;
    setSettings(migrate(null)); done("Settings reset to defaults.");
  };
  return (
    <section className="panel reset">
      <div className="ph"><h2>Delete or reset data</h2><span className="faint" style={{ fontSize: 11 }}>For a wrong upload. A backup download is offered first.</span></div>
      <div className="pb fg">
        <F label="Delete one broker's fills" hint={`${mine.length} fill${mine.length === 1 ? "" : "s"} stored. Settings and funds for this broker are kept.`}>
          <div style={{ display: "flex", gap: 6 }}>
            <select className="in" value={bid} onChange={(e) => { setBid(e.target.value); setMsg(null); }}>{brokers.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select>
            <button className="btn danger" style={{ whiteSpace: "nowrap" }} disabled={!mine.length} onClick={delBroker}>Delete fills</button>
          </div>
        </F>
        <div className="sep" style={{ margin: "4px 0" }} />
        <button className="btn ghost red" disabled={!fills.length} onClick={delAll}>Delete all fills ({fills.length})</button>
        <button className="btn ghost red" onClick={resetSettings}>Reset settings to defaults</button>
        {msg && <div className={msg[0]} style={{ fontSize: 12 }}>{msg[1]}</div>}
      </div>
    </section>
  );
}

// ---------- funds: deposits, withdrawals and equity tally ----------
function FundsTab({ pf, settings, setSettings, view }) {
  const ask = useConfirm();
  const brokers = settings.brokers;
  const today = new Date(); today.setMinutes(today.getMinutes() - today.getTimezoneOffset());
  const [f, setF] = useState({ broker: view !== "all" ? view : brokers[0]?.id, type: "deposit", amount: "", date: today.toISOString().slice(0, 10), note: "", category: CHARGE_TYPES[0], monthly: false });
  const [msg, setMsg] = useState(null);
  const bname = (id) => brokers.find((b) => b.id === id)?.name || id;
  const cash = [...(settings.cash || [])].filter((c) => view === "all" || c.broker === view).sort((a, b) => new Date(b.ts) - new Date(a.ts));
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setMsg(null); };
  const add = () => {
    if (!(n(f.amount) > 0) || !f.broker || !f.date) return;
    const entry = { id: crypto.randomUUID(), broker: f.broker, type: f.type, amount: n(f.amount), ts: new Date(`${f.date}T12:00:00`).toISOString(), note: f.note.trim(), source: "manual" };
    if (f.type === "charge") { entry.category = f.category; if (f.monthly) entry.recurring = "monthly"; }
    setSettings((s) => ({ ...s, cash: [...(s.cash || []), entry] }));
    setMsg(["ok", f.type === "charge" ? `Recorded ${f.category} charge of ${money(entry.amount)}${f.monthly ? " a month" : ""} for ${bname(f.broker)}.` : `Recorded ${f.type} of ${money(entry.amount)} for ${bname(f.broker)}.`]);
    setF((x) => ({ ...x, amount: "", note: "" }));
  };
  const remove = async (id) => {
    const c = (settings.cash || []).find((x) => x.id === id);
    const { ok } = await ask({
      title: "Delete this entry?",
      body: c ? `${c.type === "charge" ? c.category || "Charge" : c.type === "deposit" ? "Deposit" : "Withdrawal"} of ${money(n(c.amount))} on ${new Date(c.ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}.` : null,
      detail: "Account equity is worked out from this ledger, so your capital and TNE/IM will change.",
      confirmLabel: "Delete entry", tone: "danger",
    });
    if (ok) setSettings((s) => ({ ...s, cash: s.cash.filter((c2) => c2.id !== id) }));
  };
  const stopMonthly = async (id) => {
    const { ok } = await ask({
      title: "Stop this monthly charge?",
      body: "It stops from today. The months already charged stay on the ledger.",
      detail: "Use this when a subscription ends — it keeps the history honest rather than deleting the charge.",
      confirmLabel: "Stop from today",
    });
    if (ok) setSettings((s) => ({ ...s, cash: s.cash.map((c) => (c.id === id ? { ...c, endTs: new Date().toISOString() } : c)) }));
  };
  const setStmt = (id, v) => setSettings((s) => ({ ...s, statement: { ...(s.statement || {}), [id]: v } }));
  const accts = pf.accounts.filter((a) => view === "all" || a.id === view);

  return (
    <div className="grid-fills">
      <section className="panel">
        <div className="ph"><h2>Record money in, out or charged</h2></div>
        <div className="pb fg">
          <div className="seg seg3" role="group" aria-label="Type">
            <button className={f.type === "deposit" ? "on-buy" : ""} aria-pressed={f.type === "deposit"} onClick={() => set("type", "deposit")}>Deposit</button>
            <button className={f.type === "withdrawal" ? "on-sell" : ""} aria-pressed={f.type === "withdrawal"} onClick={() => set("type", "withdrawal")}>Withdrawal</button>
            <button className={f.type === "charge" ? "on-charge" : ""} aria-pressed={f.type === "charge"} onClick={() => set("type", "charge")}>Charge</button>
          </div>
          {f.type === "charge" && (
            <div className="fg">
              <F label="Type of charge"><select className="in" value={f.category} onChange={(e) => set("category", e.target.value)}>{CHARGE_TYPES.map((c) => <option key={c}>{c}</option>)}</select></F>
              <label className="check"><input type="checkbox" checked={f.monthly} onChange={(e) => set("monthly", e.target.checked)} /><span>Repeats every month from this date<br /><span className="faint">For subscriptions like market data or platform fees. Added automatically each month until you stop it.</span></span></label>
            </div>
          )}
          <div className="fg c2">
            <F label="Account"><select className="in" value={f.broker} onChange={(e) => set("broker", e.target.value)}>{brokers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></F>
            {/* The account above decides the currency — a deposit into an INR account is
                in rupees whatever else is on screen. */}
            <F label={`Amount (${symbolFor(brokers.find((b) => b.id === f.broker)?.currency).trim()})`}><input className="in" type="number" min="0" step="0.01" value={f.amount} onChange={(e) => set("amount", e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} /></F>
            <F label="Date"><input className="in" type="date" value={f.date} onChange={(e) => set("date", e.target.value)} /></F>
            <F label="Note (optional)"><input className="in" value={f.note} placeholder="e.g. Wire ref 4471" onChange={(e) => set("note", e.target.value)} /></F>
          </div>
          <button className={`btn full ${f.type === "deposit" ? "buy" : f.type === "charge" ? "charge" : "sell"}`} disabled={!(n(f.amount) > 0)} onClick={add}>Record {f.type}{n(f.amount) > 0 ? ` of ${money(n(f.amount), brokers.find((b) => b.id === f.broker)?.currency)}${f.type === "charge" && f.monthly ? " a month" : ""}` : ""}</button>
          {msg && <div className={msg[0]} style={{ fontSize: 12 }}>{msg[1]}</div>}
          <small className="faint">Once an account has deposits or withdrawals here, its equity starts from net deposits instead of the Capital typed in Settings. Charges reduce equity. MT5 deal reports that include balance rows can add deposits automatically on upload.</small>
        </div>
      </section>

      <div>
        <section className="panel">
          <div className="ph"><h2>Equity tally<span className="dim">How Nexus arrives at each account's net equity. Enter the broker's figure to check it.</span></h2></div>
          <div className="tw">
            <table>
              <thead><tr><th className="txt">Account</th><th>Deposits</th><th>Withdrawals</th><th>Net funded</th><th>Realized P&amp;L</th><th>Charges</th><th>Open P&amp;L</th><th>Nexus equity</th><th>Broker statement</th><th>Difference</th></tr></thead>
              <tbody>
                {accts.map((a) => {
                  const st = settings.statement?.[a.id];
                  const diff = has(st) ? n(st) - a.TNE : null;
                  const ok = diff !== null && Math.abs(diff) < 1;
                  return (
                    <tr key={a.id}>
                      <td className="txt"><b>{a.name}</b>{!a.fund.fromLedger && <div className="faint" style={{ fontSize: 11 }}>No ledger yet: using Capital {money(n(settings.brokers.find((b) => b.id === a.id)?.capital))}</div>}</td>
                      <td className="ok">{a.fund.dep ? money(a.fund.dep) : "—"}</td>
                      <td className="bad">{a.fund.wd ? money(-a.fund.wd) : "—"}</td>
                      <td><b>{money(a.fund.base)}</b></td>
                      <td className={pc(a.realizedAll)}>{signed(a.realizedAll)}{!a.fund.fromLedger && !settings.limits.includeRealized && <div className="faint" style={{ fontSize: 10 }}>not added</div>}</td>
                      <td className={a.fund.charges ? "bad" : "faint"}>{a.fund.charges ? money(-a.fund.charges) : "—"}</td>
                      <td className={pc(a.upnl)}>{signed(a.upnl)}</td>
                      <td><b>{money(a.TNE)}</b></td>
                      <td><input className="cell" style={{ width: 110 }} type="number" step="0.01" placeholder="Enter" value={st ?? ""} onChange={(e) => setStmt(a.id, e.target.value)} aria-label={`Broker statement equity ${a.name}`} /></td>
                      <td className={diff === null ? "faint" : ok ? "ok" : "bad"}>{diff === null ? "—" : ok ? "✓ Matches" : signed(diff)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="pb faint" style={{ fontSize: 11 }}>Nexus equity = deposits − withdrawals + realized P&amp;L (after commission and swap) − charges + open P&amp;L at the current prices you've entered. A difference usually means a missing deposit or withdrawal, fees the broker charged outside the fills, or a current price that isn't up to date.</div>
        </section>

        {(() => {
          const ch = (settings.cash || []).filter((c) => c.type === "charge" && (view === "all" || c.broker === view));
          if (!ch.length) return null;
          const cats = CHARGE_TYPES.filter((t) => ch.some((c) => c.category === t));
          const accIds = [...new Set(ch.map((c) => c.broker))];
          return (
            <section className="panel">
              <div className="ph"><h2>Charges to date<span className="dim">by type and account</span></h2></div>
              <div className="tw">
                <table>
                  <thead><tr><th className="txt">Type</th>{accIds.map((id) => <th key={id}>{bname(id)}</th>)}<th>Total</th></tr></thead>
                  <tbody>
                    {cats.map((t) => (
                      <tr key={t}><td className="txt">{t}</td>{accIds.map((id) => { const v = sum(ch.filter((c) => c.category === t && c.broker === id), chargeTotal); return <td key={id} className={v ? "bad" : "faint"}>{v ? money(-v) : "—"}</td>; })}<td className="bad"><b>{money(-sum(ch.filter((c) => c.category === t), chargeTotal))}</b></td></tr>
                    ))}
                    <tr className="total"><td className="txt">Total</td>{accIds.map((id) => <td key={id}>{money(-sum(ch.filter((c) => c.broker === id), chargeTotal))}</td>)}<td>{money(-sum(ch, chargeTotal))}</td></tr>
                  </tbody>
                </table>
              </div>
            </section>
          );
        })()}

        <section className="panel">
          <div className="ph"><h2>Ledger<span className="dim">{cash.length}</span></h2></div>
          {cash.length === 0 ? <div className="empty">No deposits, withdrawals or charges recorded yet.</div> : (
            <div className="tw tall">
              <table>
                <thead><tr><th className="txt">Date</th><th className="txt">Account</th><th className="txt">Type</th><th>Amount</th><th className="txt">Note</th><th className="txt">Source</th><th></th></tr></thead>
                <tbody>
                  {cash.map((c) => (
                    <tr key={c.id}>
                      <td className="txt dim">{new Date(c.ts).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}</td>
                      <td className="txt">{bname(c.broker)}</td>
                      <td className="txt"><span className={`side ${c.type === "deposit" ? "long" : c.type === "charge" ? "chg" : "short"}`}>{c.type === "deposit" ? "Deposit" : c.type === "charge" ? "Charge" : "Withdrawal"}</span></td>
                      <td className={c.type === "deposit" ? "ok" : "bad"}><b>{c.type === "deposit" ? "+" : "−"}{money(n(c.amount))}</b>{c.recurring === "monthly" && <div className="faint" style={{ fontSize: 10 }}>a month · {monthsCharged(c)}× = {money(chargeTotal(c))}</div>}</td>
                      <td className="txt dim">{c.type === "charge" && <b style={{ color: "var(--text)", fontWeight: 500 }}>{c.category}{c.recurring === "monthly" ? (c.endTs ? ` (monthly, stopped ${new Date(c.endTs).toLocaleDateString(undefined, { day: "numeric", month: "short" })})` : " (monthly)") : ""}{c.note ? " · " : ""}</b>}{c.note || (c.type === "charge" ? "" : "—")}</td>
                      <td className="txt faint">{c.source === "csv" ? "Upload" : "Manual"}</td>
                      <td style={{ whiteSpace: "nowrap" }}>{c.recurring === "monthly" && !c.endTs && <button className="btn ghost" style={{ marginRight: 4 }} onClick={() => stopMonthly(c.id)}>Stop</button>}<button className="btn ghost" onClick={() => remove(c.id)} aria-label="Delete entry">✕</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

// =====================================================================
// Analysis: how the book has actually done. Everything here is built from
// closed trades, so it is realized money — open positions are excluded.
// P&L colour is backed up by a signed number and by which side of zero a
// bar sits on, so the sign never depends on telling red from green.
const HOUR = 3600e3;
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const monthName = (ym) => `${MONTHS[+ym.slice(5, 7) - 1]} ${ym.slice(0, 4)}`;

function analyse(closed) {
  const t = [...closed].sort((a, b) => new Date(a.closeTs) - new Date(b.closeTs));
  const wins = t.filter((x) => x.pnl > 0), losses = t.filter((x) => x.pnl < 0);
  const grossWin = sum(wins, (x) => x.pnl), grossLoss = Math.abs(sum(losses, (x) => x.pnl));
  const net = sum(t, (x) => x.pnl);

  // Equity curve and the deepest fall from a peak along the way.
  let run = 0, peak = 0, maxDD = 0, ddAt = null;
  const curve = t.map((x) => {
    run += x.pnl;
    if (run > peak) peak = run;
    const dd = peak - run;
    if (dd > maxDD) { maxDD = dd; ddAt = x.closeTs; }
    return { ts: x.closeTs, equity: run, pnl: x.pnl, product: x.product };
  });

  // Longest run of winners and of losers, in a single pass.
  let winStreak = 0, lossStreak = 0, cw = 0, cl = 0;
  t.forEach((x) => {
    if (x.pnl > 0) { cw++; cl = 0; } else if (x.pnl < 0) { cl++; cw = 0; } else { cw = 0; cl = 0; }
    winStreak = Math.max(winStreak, cw); lossStreak = Math.max(lossStreak, cl);
  });

  const group = (keyOf) => {
    const m = {};
    t.forEach((x) => {
      const k = keyOf(x);
      const g = (m[k] ||= { key: k, trades: 0, lots: 0, wins: 0, net: 0, gw: 0, gl: 0 });
      g.trades++; g.lots += x.qty; g.net += x.pnl;
      if (x.pnl > 0) { g.wins++; g.gw += x.pnl; } else if (x.pnl < 0) g.gl += Math.abs(x.pnl);
    });
    return Object.values(m).sort((a, b) => b.net - a.net);
  };

  const held = t.map((x) => (new Date(x.closeTs) - new Date(x.openTs)) / HOUR).filter((h) => isFinite(h) && h >= 0);
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const i = s.length >> 1;
    return s.length % 2 ? s[i] : (s[i - 1] + s[i]) / 2; };

  return {
    trades: t, n: t.length, net, wins: wins.length, losses: losses.length,
    winRate: t.length ? wins.length / t.length : null,
    grossWin, grossLoss,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : null),
    expectancy: t.length ? net / t.length : null,
    avgWin: wins.length ? grossWin / wins.length : 0,
    avgLoss: losses.length ? grossLoss / losses.length : 0,
    topWins: [...t].filter((x) => x.pnl > 0).sort((a, b) => b.pnl - a.pnl).slice(0, 5),
    topLosses: [...t].filter((x) => x.pnl < 0).sort((a, b) => a.pnl - b.pnl).slice(0, 5),
    curve, peak, maxDD, ddAt, winStreak, lossStreak,
    byProduct: group((x) => x.product),
    byMonth: group((x) => new Date(x.closeTs).toISOString().slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    lots: sum(t, (x) => x.qty),
    medianHours: median(held),
  };
}

// Cumulative realized P&L. One series, so it needs no legend — the title names it.
// Magnitude with polarity: bars run left for a loss and right for a profit, and
// every bar is labelled with its signed value, so colour is never the only cue.
function DivergingBars({ rows, label = "row" }) {
  if (!rows.length) return <div className="empty">Nothing to show yet.</div>;
  const max = Math.max(...rows.map((r) => Math.abs(r.value)), 1);
  return (
    <div className="dbars">
      {rows.map((r) => {
        const w = (Math.abs(r.value) / max) * 50;
        const neg = r.value < 0;
        return (
          <div className="dbar" key={r.key} title={`${r.key}: ${signed(r.value)}`}>
            <span className="dbar-label txt" title={r.key}>{r.key}</span>
            <span className="dbar-track">
              <i className="dbar-zero" />
              <i className={`dbar-fill ${neg ? "neg" : "pos"}`}
                 style={neg ? { right: "50%", width: `${w}%` } : { left: "50%", width: `${w}%` }} />
            </span>
            <span className={`dbar-val ${pc(r.value)}`}>{signed(r.value)}</span>
            <span className="dbar-sub faint">{r.sub}</span>
          </div>
        );
      })}
    </div>
  );
}

const BigTrade = ({ x }) => (
  <tr>
    <td className="txt"><b>{x.product}</b></td>
    <td><Side s={x.side} /></td><td>{qty(x.qty)}</td>
    <td>{px(x.avgEntry)}</td><td>{px(x.avgExit)}</td>
    <td className="dim">{dt(x.openTs)}</td><td className="dim">{dt(x.closeTs)}</td>
    <td className={pc(x.pnl)}><b>{signed(x.pnl)}</b></td>
  </tr>
);

/*
 * Re-runs the book as it stood at the close of each day in `days`.
 *
 * Two deliberate substitutions, both of them about prices nobody wrote down:
 *   marks: {} — an open position is carried at its entry price, so equity here
 *     is funding plus realized money and carries no open profit or loss.
 *   cash filtered to the date — money that had not been paid in yet must not
 *     be counted as if it had.
 * Everything else is the live margin engine, so a reconstructed margin figure
 * is worked out exactly the way today's is.
 */
function reconstruct(fills, settings, days) {
  if (!days.length) return [];
  const traded = [...fills].sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const cash = settings.cash || [];
  return days.map((d) => {
    const at = endOfDay(d);
    const scoped = { ...settings, marks: {}, cash: cash.filter((c) => new Date(c.ts) <= at) };
    const pf = portfolio(traded.filter((f) => new Date(f.ts) <= at), scoped, at);
    return {
      d,
      byBroker: Object.fromEntries(pf.accounts.map((a) => {
        const prod = {};
        for (const r of a.rows) {
          const lots = Math.abs(r.lots);
          if (lots && r.product) prod[r.product] = (prod[r.product] || 0) + lots;
        }
        return [a.id, {
          tne: Math.round(a.TNE),
          im: Math.round(a.IM),
          lots: Math.round(a.rows.reduce((t, r) => t + Math.abs(r.lots), 0) * 1e4) / 1e4,
          prod,
        }];
      })),
    };
  });
}


/*
 * Evenly spaced date labels along the foot of a chart.
 *
 * Two dates at the ends told you the range and nothing about the middle — no way to read
 * when a drawdown started without counting pixels. Six or so, thinned to whatever fits the
 * width, and always including the last day so the right edge is dated.
 */
function dateTicks(days, want = 6) {
  if (days.length <= want) return days;
  const step = Math.ceil(days.length / want);
  const out = [];
  for (let i = 0; i < days.length; i += step) out.push(days[i]);
  const last = days[days.length - 1];
  if (out[out.length - 1] !== last) {
    // Replace rather than append when the last tick would collide with the end.
    if ((days.length - 1) - days.indexOf(out[out.length - 1]) < step / 2) out.pop();
    out.push(last);
  }
  return out;
}

const shortDay = (d) =>
  new Date(endOfDay(d)).toLocaleDateString(undefined, { month: "short", day: "numeric" });
const longDay = (d) =>
  new Date(endOfDay(d)).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });

// Enough hues to tell four or five accounts apart, all of them at home next to
// navy. Colour is never the only cue: every line is named in the legend and
// again in the tooltip.
const LINE_COLOURS = ["#1F4E8C", "#0E7A53", "#A86A0C", "#6B4FA8", "#C0313A"];
// For stacked products, which need more of them and no red — red reads as a loss
// everywhere else on this screen and a product is not a loss.
const STACK_COLOURS = ["#1F4E8C", "#0E7A53", "#A86A0C", "#6B4FA8", "#2B7C9E", "#7A6A2E", "#4A5568", "#8C4F7A"];

function MarginHistory({ pf, fills, settings, view, history }) {
  const [metric, setMetric] = useState("ratio");
  const [hover, setHover] = useState(null);

  const days = useMemo(() => reconstructionDays(fills, history), [fills, history]);
  const rebuilt = useMemo(() => reconstruct(fills, settings, days), [fills, settings, days]);
  const brokers = settings.brokers.filter((b) => view === "all" || b.id === view);
  const { days: axis, lines, join } = useMemo(
    () => buildSeries({ reconstructed: rebuilt, history, brokers }),
    [rebuilt, history, brokers],
  );

  /*
   * Realized money is worked out here rather than read off the record.
   *
   * Closed trades are permanent and carry both the money and the moment, so this is exact
   * for every day there has ever been — no reconstruction, no join, no caveat. It is the
   * one series on this chart with nothing to apologise for.
   */
  const closed = useMemo(
    () => pf.book.closed.filter((c) => view === "all" || c.broker === view),
    [pf.book.closed, view],
  );
  const realized = useMemo(() => realizedByDay(closed, axis), [closed, axis]);

  const M = METRICS.find((m) => m.key === metric);
  const fmt = (v) => v === null || v === undefined || !isFinite(v) ? "—"
    : M.fmt === "money" ? money(v) : M.fmt === "ratio" ? ratioTxt(v) : qty(v);

  const W = 760, H = 240, pad = { l: 56, r: 12, t: 14, b: 40 };
  const ticks3 = (lo, hi) => [lo, lo + (hi - lo) / 2, hi];
  const xOf = (d, i0) => pad.l + (i0 * (W - pad.l - pad.r)) / Math.max(1, axis.length - 1);
  const xi = Object.fromEntries(axis.map((d, i) => [d, i]));
  const x = (d) => xOf(d, xi[d]);

  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round((((e.clientX - r.left) / r.width) * W - pad.l) / ((W - pad.l - pad.r) / Math.max(1, axis.length - 1)));
    setHover(axis[Math.max(0, Math.min(axis.length - 1, i))]);
  };

  const controls = (
    <div className="hist-head">
      <div className="hist-metrics" role="tablist" aria-label="What to plot">
        {METRICS.map((m) => (
          <button key={m.key} type="button" role="tab" aria-selected={m.key === metric}
            className={m.key === metric ? "on" : undefined} onClick={() => { setMetric(m.key); setHover(null); }}>{m.label}</button>
        ))}
      </div>
    </div>
  );

  if (axis.length < 2) return (
    <div>
      {controls}
      <div className="empty">
        Not enough history yet. This chart needs at least two days with something on the
        book — either from fills you have already loaded, or from the daily record, which
        starts the first time you open RAMP after today.
      </div>
    </div>
  );

  const axisFoot = (
    <>
      {dateTicks(axis).map((d) => (
        <text key={d} x={x(d)} y={H - 22} fontSize="10" fill="var(--faint)"
          textAnchor={d === axis[0] ? "start" : d === axis[axis.length - 1] ? "end" : "middle"}>
          {shortDay(d)}
        </text>
      ))}
      {/* The year, once, under the right-hand end — the ticks carry day and month and a
          chart spanning a year boundary would otherwise never say which year it is in. */}
      <text x={W - pad.r} y={H - 7} fontSize="9" textAnchor="end" fill="var(--faint)">
        {new Date(endOfDay(axis[axis.length - 1])).getFullYear()}
      </text>
    </>
  );

  const joinMark = join && xi[join] !== undefined ? (
    <g>
      <line x1={x(join)} x2={x(join)} y1={pad.t - 4} y2={H - pad.b} stroke="var(--warn)" strokeWidth="1" strokeDasharray="3 3" />
      <text x={x(join) + 4} y={pad.t + 4} fontSize="10" fill="var(--warn)">Daily record starts</text>
    </g>
  ) : null;

  // ---------- lots: stacked by product ----------
  if (M.stacked) {
    /*
     * Volume comes straight off the fills, not off the day-by-day series.
     *
     * A fill is a permanent record of something that happened at a moment, so this is
     * exact for every day there has ever been — there is nothing to rebuild and no join to
     * mark, the same as realized money. The series above exists to answer what the book
     * looked like; this answers what went through it.
     */
    const traded = M.fromFills ? tradedByDay(fills, brokers.map((b) => b.id)) : null;

    const lotsAt = (d) => {
      const out = {};
      for (const l of lines) {
        const p = l.points.find((q) => q.d === d);
        if (!p) continue;
        const prod = p.prod && Object.keys(p.prod).length ? p.prod : null;
        if (prod) for (const [k, v] of Object.entries(prod)) out[k] = (out[k] || 0) + v;
        // A day recorded before products were broken out still knows its total, so it is
        // drawn as one block and named for what it is rather than dropped.
        else if (p.lots) out["Not broken down"] = (out["Not broken down"] || 0) + p.lots;
      }
      return out;
    };
    const perDay = axis.map((d) => ({ d, prod: traded ? (traded.get(d)?.prod ?? {}) : lotsAt(d) }));
    const products = [...new Set(perDay.flatMap((r) => Object.keys(r.prod)))].sort();
    const totalAt = (r) => Object.values(r.prod).reduce((t, v) => t + v, 0);
    const hi = Math.max(1, ...perDay.map(totalAt));
    const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - v / hi);
    const bw = Math.max(1.5, ((W - pad.l - pad.r) / Math.max(1, axis.length)) * 0.75);
    const h = hover ? perDay.find((r) => r.d === hover) : null;

    if (!products.length) return (
      <div>{controls}<div className="empty">
        {M.fromFills ? "Nothing was traded on any day in this range." : "No lots were held on any day in this range."}
      </div></div>
    );

    return (
      <div>
        {controls}
        <div className="hist-legend stack">
          {products.map((name, i) => (
            <span key={name}><i style={{ background: STACK_COLOURS[i % STACK_COLOURS.length] }} />{name}</span>
          ))}
        </div>
        <div style={{ position: "relative" }}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" className="chart-svg"
            aria-label={`${M.label} per day by product, ${longDay(axis[0])} to ${longDay(axis[axis.length - 1])}`}
            onMouseMove={pick} onMouseLeave={() => setHover(null)} style={{ cursor: "crosshair" }}>
            {ticks3(0, hi).map((t, i) => (
              <g key={i}>
                <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
                <text x={pad.l - 7} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--faint)">{qty(Math.round(t * 100) / 100)}</text>
              </g>
            ))}
            {!M.fromFills && joinMark}
            {perDay.map((r) => {
              let acc = 0;
              return (
                <g key={r.d}>
                  {products.map((name, i) => {
                    const v = r.prod[name] || 0;
                    if (!v) return null;
                    const y0 = y(acc + v), y1 = y(acc);
                    acc += v;
                    return <rect key={name} x={x(r.d) - bw / 2} y={y0} width={bw} height={Math.max(0.5, y1 - y0)}
                      fill={STACK_COLOURS[i % STACK_COLOURS.length]} opacity={hover && hover !== r.d ? 0.45 : 1} />;
                  })}
                </g>
              );
            })}
            {axisFoot}
          </svg>
          {/* A flat day still answers the question. Showing nothing where the bar has no
              height reads as the chart having stopped working. */}
          {h && (
            <div className="chart-tip" style={{ left: `${(x(h.d) / W) * 100}%` }}>
              <b>{longDay(h.d)}</b>
              {totalAt(h) > 0 ? (
                <>
                  {products.filter((n) => h.prod[n]).map((n) => (
                    <span key={n} className="tip-row"><i>{n}</i><b>{qty(h.prod[n])}</b></span>
                  ))}
                  <span className="tip-row tip-total"><i>Total</i><b>{qty(totalAt(h))} lots</b></span>
                </>
              ) : (
                <span>{M.fromFills ? "Nothing traded" : "Flat — nothing on the book"}</span>
              )}
            </div>
          )}
        </div>
        <p className="hist-note">
          {M.fromFills ? (
            <>Lots that changed hands each day, stacked by product. <b>Every fill counts,
            both sides</b> — buying five and selling them again is ten, which is what the
            exchange reports and what commission is charged on. Spread legs are skipped;
            the spread is the trade. Exact for every day: a fill is a record of something
            that happened, so there is nothing here that had to be rebuilt.</>
          ) : (
            <>Lots on the book at the close of each day, stacked by product — what you
            carried overnight. A position opened and closed inside one session never
            appears here, so a busy day that ended flat reads as nothing at all; the
            <b> Lots traded</b> tab is where that day shows up. Broken down exactly: what
            was on the book is a fact about your fills, not something that depended on a
            price nobody saved.</>
          )}
        </p>
      </div>
    );
  }

  // ---------- everything else: one line per broker ----------
  const valueAt = (l, d) => {
    if (metric === "realized") {
      const r = realized.get(d);
      return r && r[l.id] !== undefined ? r[l.id] : null;
    }
    const p = l.points.find((q) => q.d === d);
    return p ? valueOf(p, metric) : null;
  };
  const recordedAt = (l, d) => {
    if (metric === "realized") return true;   // exact everywhere; see realizedByDay
    const p = l.points.find((q) => q.d === d);
    return p ? p.recorded : false;
  };

  const drawn = lines
    .map((l) => ({ ...l, vals: axis.map((d) => ({ d, v: valueAt(l, d), recorded: recordedAt(l, d) })).filter((p) => p.v !== null) }))
    .filter((l) => l.vals.length > 1);

  if (!drawn.length) return (
    <div>{controls}<div className="empty">Nothing to plot for this yet.</div></div>
  );

  const all = drawn.flatMap((l) => l.vals.map((p) => p.v));
  let lo = Math.min(...all, metric === "ratio" ? Math.min(...all) : 0);
  let hi = Math.max(...all);
  if (hi === lo) { hi = lo + 1; lo -= 1; }
  const span = hi - lo;
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / span);
  const path = (pts) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.d).toFixed(1)},${y(p.v).toFixed(1)}`).join(" ");

  return (
    <div>
      {controls}
      <div className="hist-legend">
        {drawn.map((l, i) => (
          <span key={l.id}><i style={{ background: LINE_COLOURS[i % LINE_COLOURS.length] }} />{l.name}</span>
        ))}
      </div>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" className="chart-svg"
          aria-label={`${M.label} per broker account, ${longDay(axis[0])} to ${longDay(axis[axis.length - 1])}`}
          onMouseMove={pick} onMouseLeave={() => setHover(null)} style={{ cursor: "crosshair" }}>
          {ticks3(lo, hi).map((t, i) => (
            <g key={i}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke="var(--line)" strokeWidth="1" />
              <text x={pad.l - 7} y={y(t) + 3.5} textAnchor="end" fontSize="10" fill="var(--faint)">{fmt(t)}</text>
            </g>
          ))}
          {metric !== "ratio" && lo < 0 && hi > 0 && (
            <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--line2)" strokeWidth="1" />
          )}
          {metric !== "realized" && joinMark}

          {drawn.map((l, i) => {
            const c = LINE_COLOURS[i % LINE_COLOURS.length];
            const back = l.vals.filter((p) => !p.recorded);
            const fwd = l.vals.filter((p) => p.recorded);
            const bridge = back.length && fwd.length ? [back[back.length - 1], fwd[0]] : [];
            return (
              <g key={l.id}>
                {back.length > 1 && <path d={path(back)} fill="none" stroke={c} strokeWidth="1.6" strokeDasharray="5 4" opacity=".75" strokeLinejoin="round" />}
                {bridge.length === 2 && <path d={path(bridge)} fill="none" stroke={c} strokeWidth="1.6" strokeDasharray="5 4" opacity=".75" />}
                {fwd.length > 1 && <path d={path(fwd)} fill="none" stroke={c} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />}
                {fwd.length === 1 && <circle cx={x(fwd[0].d)} cy={y(fwd[0].v)} r="3" fill={c} />}
              </g>
            );
          })}

          {hover && (
            <g>
              <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--line2)" strokeWidth="1" />
              {drawn.map((l, i) => {
                const p = l.vals.find((q) => q.d === hover);
                return p ? <circle key={l.id} cx={x(hover)} cy={y(p.v)} r="3.5" fill={LINE_COLOURS[i % LINE_COLOURS.length]} stroke="#fff" strokeWidth="1.5" /> : null;
              })}
            </g>
          )}
          {axisFoot}
        </svg>

        {hover && (
          <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
            <b>{longDay(hover)}</b>
            {drawn.map((l) => {
              const p = l.vals.find((q) => q.d === hover);
              return p ? (
                <span key={l.id} className="tip-row">
                  <i>{l.name}{p.recorded ? "" : " · rebuilt"}</i><b>{fmt(p.v)}</b>
                </span>
              ) : null;
            })}
          </div>
        )}
      </div>

      <p className="hist-note">
        {metric === "realized" ? (
          <>Money actually taken, running total, by the day each trade closed. Exact for
          every day on the chart — a closed trade carries its result and its timestamp, so
          there is nothing here that had to be reconstructed.</>
        ) : (
          <><b>Solid</b> is the daily record, written from your live figures, equity included.
          {" "}<b>Dashed</b> is rebuilt from your fills: lots and margin come out exact, but equity
          there is funding plus realized money only — nobody saved the prices you were marking
          open positions at, so RAMP will not invent them. A step at the marker is the method
          changing, not the account.</>
        )}
      </p>
    </div>
  );
}

/*
 * Winners and losers, per day.
 *
 * Counts, not money — the money is on the chart above. This answers a different question:
 * was that a day of one bad trade, or a day when nothing worked? Two days with the same
 * loss read very differently depending on the answer, and only one of them is a reason to
 * stop trading.
 *
 * Diverging rather than truly stacked: wins up, losses down, off a shared zero. Stacking
 * them in one column would make a 3-1 day and a 1-3 day the same height, which is exactly
 * the comparison somebody is here to make.
 */
function WinLossDays({ pf, view }) {
  const [hover, setHover] = useState(null);
  const closed = pf.book.closed.filter((c) => view === "all" || c.broker === view);
  const rows = useMemo(() => winLossByDay(closed), [closed]);

  if (!rows.length) return <div className="empty">No trades have been closed yet.</div>;

  const W = 760, H = 190, pad = { l: 34, r: 12, t: 14, b: 40 };
  const maxW = Math.max(1, ...rows.map((r) => r.wins));
  const maxL = Math.max(1, ...rows.map((r) => r.losses));
  const top = pad.t, bottom = H - pad.b;
  // Zero sits proportionally, so one bad day does not squash every winning one flat.
  const zero = top + (bottom - top) * (maxW / (maxW + maxL));
  const yUp = (n) => zero - (zero - top) * (n / maxW);
  const yDn = (n) => zero + (bottom - zero) * (n / maxL);
  const days = rows.map((r) => r.d);
  const x = (d) => pad.l + (days.indexOf(d) * (W - pad.l - pad.r)) / Math.max(1, days.length - 1);
  const bw = Math.max(2, ((W - pad.l - pad.r) / Math.max(1, days.length)) * 0.6);

  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round((((e.clientX - r.left) / r.width) * W - pad.l) / ((W - pad.l - pad.r) / Math.max(1, days.length - 1)));
    setHover(days[Math.max(0, Math.min(days.length - 1, i))]);
  };
  const h = hover ? rows.find((r) => r.d === hover) : null;

  return (
    <div>
      <div className="hist-legend">
        <span><i style={{ background: "var(--ok)" }} />Winners</span>
        <span><i style={{ background: "var(--bad)" }} />Losers</span>
      </div>
      <div style={{ position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" className="chart-svg"
          aria-label={`Winning and losing trades per day, ${longDay(days[0])} to ${longDay(days[days.length - 1])}`}
          onMouseMove={pick} onMouseLeave={() => setHover(null)} style={{ cursor: "crosshair" }}>
          <line x1={pad.l} x2={W - pad.r} y1={zero} y2={zero} stroke="var(--line2)" strokeWidth="1" />
          <text x={pad.l - 7} y={yUp(maxW) + 3.5} textAnchor="end" fontSize="10" fill="var(--faint)">{maxW}</text>
          <text x={pad.l - 7} y={zero + 3.5} textAnchor="end" fontSize="10" fill="var(--faint)">0</text>
          <text x={pad.l - 7} y={yDn(maxL) + 3.5} textAnchor="end" fontSize="10" fill="var(--faint)">{maxL}</text>

          {rows.map((r) => (
            <g key={r.d} opacity={hover && hover !== r.d ? 0.45 : 1}>
              {r.wins > 0 && <rect x={x(r.d) - bw / 2} y={yUp(r.wins)} width={bw} height={Math.max(1, zero - yUp(r.wins))} fill="var(--ok)" />}
              {r.losses > 0 && <rect x={x(r.d) - bw / 2} y={zero} width={bw} height={Math.max(1, yDn(r.losses) - zero)} fill="var(--bad)" />}
            </g>
          ))}

          {hover && <line x1={x(hover)} x2={x(hover)} y1={top} y2={bottom} stroke="var(--line2)" strokeWidth="1" />}

          {dateTicks(days).map((d) => (
            <text key={d} x={x(d)} y={H - 22} fontSize="10" fill="var(--faint)"
              textAnchor={d === days[0] ? "start" : d === days[days.length - 1] ? "end" : "middle"}>{shortDay(d)}</text>
          ))}
          <text x={W - pad.r} y={H - 7} fontSize="9" textAnchor="end" fill="var(--faint)">
            {new Date(endOfDay(days[days.length - 1])).getFullYear()}
          </text>
        </svg>

        {h && (
          <div className="chart-tip" style={{ left: `${(x(h.d) / W) * 100}%` }}>
            <b>{longDay(h.d)}</b>
            <span className="tip-row ok"><i>Won</i><b>{h.wins}</b></span>
            <span className="tip-row bad"><i>Lost</i><b>{h.losses}</b></span>
            {h.flat > 0 && <span className="tip-row"><i>Scratched</i><b>{h.flat}</b></span>}
            <span className="tip-row tip-total"><i>On the day</i><b>{signed(h.net)}</b></span>
          </div>
        )}
      </div>
      <p className="hist-note">
        Every trade counted on the day it closed — that is the day the money was decided.
        Only closed trades appear; an open position is not yet a winner or a loser.
      </p>
    </div>
  );
}

function AnalysisTab({ pf, settings, view, fills }) {
  const brokers = settings.brokers;
  const bname = (id) => brokers.find((b) => b.id === id)?.name || id;
  const closed = pf.book.closed.filter((c) => view === "all" || c.broker === view);
  const a = useMemo(() => analyse(closed), [closed]);
  const pct = (x) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  const ratio = (x) => (x === null ? "—" : !isFinite(x) ? "No losses" : x.toFixed(2));

  // Worth drawing before a single trade is closed: it answers "how much margin
  // was I carrying then", which is a question about open positions.
  const history = (
    <section className="panel">
      <div className="ph">
        <h2>Day by day<span className="dim">equity, margin, realized money and lots</span></h2>
        <span className="faint" style={{ fontSize: 11 }}>Recorded daily from today; earlier days rebuilt from your fills</span>
      </div>
      <div className="pb">
        <MarginHistory pf={pf} fills={fills} settings={settings} view={view} history={settings.history} />
      </div>
    </section>
  );

  const winLoss = (
    <section className="panel">
      <div className="ph">
        <h2>Winners and losers<span className="dim">per day</span></h2>
        <span className="faint" style={{ fontSize: 11 }}>Counted on the day each trade closed</span>
      </div>
      <div className="pb"><WinLossDays pf={pf} view={view} /></div>
    </section>
  );

  if (!a.n) return (
    <>
      {history}
      <section className="panel"><div className="ph"><h2>Analysis</h2></div>
        <div className="empty">No closed trades yet. Once trades are squared off, this page shows how the book has performed.</div>
      </section>
    </>
  );

  return (
    <>
      <section className="panel">
        <div className="ph">
          <h2>Performance<span className="dim">{a.n} closed trades · {qty(a.lots)} lots</span></h2>
          <span className="faint" style={{ fontSize: 11 }}>Realized money only — open positions are not counted</span>
        </div>
        <div className="strip">
          <div className="kpi"><label>Net realized P&amp;L</label><b className={pc(a.net)}>{signed(a.net)}</b></div>
          <div className="kpi"><label>Win rate</label><b>{pct(a.winRate)}</b><span className="faint" style={{ fontSize: 11 }}>{a.wins} won · {a.losses} lost</span></div>
          <div className="kpi"><label>Profit factor</label><b className={a.profitFactor !== null && a.profitFactor < 1 ? "bad" : a.profitFactor >= 1.5 ? "ok" : ""}>{ratio(a.profitFactor)}</b><span className="faint" style={{ fontSize: 11 }}>won ÷ lost</span></div>
          <div className="kpi"><label>Expectancy / trade</label><b className={pc(a.expectancy)}>{signed(a.expectancy || 0)}</b></div>
          <div className="kpi"><label>Average win</label><b className="ok">{money(a.avgWin)}</b></div>
          <div className="kpi"><label>Average loss</label><b className="bad">{money(-a.avgLoss)}</b></div>
          <div className="kpi"><label>Largest drawdown</label><b className={a.maxDD ? "bad" : ""}>{a.maxDD ? money(-a.maxDD) : "—"}</b><span className="faint" style={{ fontSize: 11 }}>peak to trough</span></div>
          <div className="kpi"><label>Typical hold</label><b>{holdTxt(a.medianHours)}</b><span className="faint" style={{ fontSize: 11 }}>median, open to close</span></div>
          <div className="kpi hide-m"><label>Longest streak</label><b><span className="ok">{a.winStreak}W</span> <span className="faint">/</span> <span className="bad">{a.lossStreak}L</span></b></div>
        </div>
      </section>

      {/*
        One chart, one date axis.
        ------------------------
        The cumulative realized curve used to be its own panel plotted trade by trade,
        which meant two pictures of the same fortnight that could not be read against each
        other: a drawdown on one and the margin that caused it on the other, with no shared
        x to line them up. It is a metric on the chart above now, by date like everything
        else, and the peak and drawdown it used to caption are in the strip at the top.
      */}
      <div className="grid-charts">
        {history}
        {winLoss}
      </div>

      <div className="grid-settings">
        <section className="panel">
          <div className="ph"><h2>By product</h2></div>
          <div className="pb"><DivergingBars rows={a.byProduct.map((g) => ({ key: g.key, value: g.net, sub: `${g.trades} ${g.trades === 1 ? "trade" : "trades"} · ${pct(g.trades ? g.wins / g.trades : null)} won` }))} /></div>
        </section>
        <section className="panel">
          <div className="ph"><h2>By month<span className="dim">closed</span></h2></div>
          <div className="pb"><DivergingBars rows={a.byMonth.map((g) => ({ key: monthName(g.key), value: g.net, sub: `${g.trades} ${g.trades === 1 ? "trade" : "trades"}` }))} /></div>
        </section>
      </div>

      <section className="panel">
        <div className="ph"><h2>Product detail</h2></div>
        <div className="tw">
          <table>
            <thead><tr><th className="txt">Product</th><th>Trades</th><th>Lots</th><th>Won</th><th>Win rate</th><th>Gross won</th><th>Gross lost</th><th>Profit factor</th><th>Net</th></tr></thead>
            <tbody>
              {a.byProduct.map((g) => (
                <tr key={g.key}>
                  <td className="txt"><b>{g.key}</b></td><td>{g.trades}</td><td>{qty(g.lots)}</td><td>{g.wins}</td>
                  <td>{pct(g.trades ? g.wins / g.trades : null)}</td>
                  <td className="ok">{money(g.gw)}</td><td className="bad">{money(-g.gl)}</td>
                  <td className={g.gl > 0 && g.gw / g.gl < 1 ? "bad" : ""}>{ratio(g.gl > 0 ? g.gw / g.gl : (g.gw > 0 ? Infinity : null))}</td>
                  <td className={pc(g.net)}><b>{signed(g.net)}</b></td>
                </tr>
              ))}
              <tr className="total"><td className="txt">All products</td><td>{a.n}</td><td>{qty(a.lots)}</td><td>{a.wins}</td><td>{pct(a.winRate)}</td>
                <td className="ok">{money(a.grossWin)}</td><td className="bad">{money(-a.grossLoss)}</td><td>{ratio(a.profitFactor)}</td>
                <td className={pc(a.net)}><b>{signed(a.net)}</b></td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <div className="ph"><h2>Biggest wins and losses</h2>
          <span className="faint" style={{ fontSize: 11 }}>up to five each way</span></div>
        <div className="tw">
          <table>
            <thead><tr><th className="txt">Product</th><th>Side</th><th>Lots</th><th>Entry</th><th>Exit</th><th>Opened</th><th>Closed</th><th>P&amp;L</th></tr></thead>
            <tbody>
              {a.topWins.map((x, i) => <BigTrade key={`w${i}`} x={x} />)}
              {a.topWins.length > 0 && a.topLosses.length > 0 && <tr className="sep-row"><td colSpan={8}></td></tr>}
              {a.topLosses.map((x, i) => <BigTrade key={`l${i}`} x={x} />)}
              {!a.topWins.length && !a.topLosses.length && <tr><td colSpan={8} className="txt faint">No closed trades yet.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
