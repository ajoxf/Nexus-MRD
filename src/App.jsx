import React, { useState, useEffect, useMemo, useRef } from "react";
import { db, isRemote, auth } from "./lib/db.js";
import { computeBook, withCommission } from "./lib/positions.js";
import { runScenario, breakingMove } from "./lib/scenario.js";
import { FIELDS, parseCsvFile, parsePastedText, guessMapping, rowsToFills, classifyFills, estimateSizes, ORIENT_TEMPLATE_CSV, MT5_TEMPLATE_CSV } from "./lib/csv.js";

// ---------- defaults ----------
const ORIENT_PRODUCTS = {
  BZ_CL: { size: 1000, margin: 2500, lev: "", note: "Brent/WTI spread" },
  HO_CL: { size: 1000, margin: 35700, lev: "", note: "Heating oil crack" },
  CL_CL: { size: 1000, margin: 3483, lev: "", note: "WTI calendar spread" },
};
const NEW_BROKER = { method: "leverage", leverage: 100, capital: 100000, callRatio: 100, stopRatio: 50, products: {} };
const DEFAULT_SETTINGS = {
  limits: { minRatio: 200, maxRiskPct: 2, dailyLossPct: 5, maxTrades: 10, includeRealized: true },
  brokers: [
    { id: "orient", name: "Orient", method: "fixed", leverage: 100, capital: 500000, callRatio: 100, stopRatio: 50, products: ORIENT_PRODUCTS },
    { id: "mt5", name: "MT5", method: "leverage", leverage: 100, capital: 100000, callRatio: 100, stopRatio: 50, products: {} },
  ],
  marks: {},
  view: "all",
  scenario: { target: "min", defV: 5, defUnit: "%", moves: {}, openOnly: true },
  cash: [],
  statement: {},
};
const LEVERAGES = [10, 20, 25, 30, 50, 100, 200, 300, 400, 500];

// Upgrades settings saved by earlier versions (one account) to broker accounts.
function migrate(s) {
  const D = DEFAULT_SETTINGS;
  if (!s) return JSON.parse(JSON.stringify(D));
  if (s.brokers) return { limits: { ...D.limits, ...s.limits }, brokers: s.brokers, marks: s.marks || {}, view: s.view || "all", scenario: { ...D.scenario, ...(s.scenario || {}) }, cash: s.cash || [], statement: s.statement || {} };
  const A = s.account || {};
  return {
    limits: { ...D.limits, ...Object.fromEntries(Object.entries(A).filter(([k]) => k in D.limits)) },
    brokers: [{ id: "default", name: A.broker || "Main account", method: A.method || "fixed", leverage: A.leverage || 100, capital: A.capital ?? 500000, callRatio: A.callRatio ?? 100, stopRatio: A.stopRatio ?? 50, products: s.products || ORIENT_PRODUCTS }],
    marks: Object.fromEntries(Object.entries(s.marks || {}).map(([p, v]) => [`default|${p}`, v])),
    view: "all",
    scenario: { ...D.scenario },
    cash: [],
    statement: {},
  };
}

// ---------- helpers ----------
const n = (v) => (v === "" || v === null || v === undefined || isNaN(+v) ? 0 : +v);
const has = (v) => v !== "" && v !== null && v !== undefined && !isNaN(+v);
const money = (v) => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 0 });
const signed = (v) => (v > 0 ? "+" : "") + money(v);
const pct = (v) => (isFinite(v) ? (v * 100).toFixed(1) + "%" : "—");
const ratioTxt = (r) => (isFinite(r) ? (r * 100).toFixed(0) + "%" : "—");
const px = (v) => (isFinite(v) ? (+v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 5 }) : "—");
const qty = (v) => String(+(+v).toFixed(4));
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
// Asks for a backup, then confirmation, then runs the delete.
async function safeDelete({ fills, brokers, label, what, run }) {
  if (!fills.length) return false;
  if (window.confirm(`Download a backup of the ${fills.length} fill${fills.length === 1 ? "" : "s"} first?\n\nOK = download backup, Cancel = skip`)) downloadBackup(fills, brokers, label);
  if (!window.confirm(`Delete ${what}? This can't be undone (except by re-uploading the backup).`)) return false;
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
const chargeTotal = (c) => n(c.amount) * (c.recurring === "monthly" ? monthsCharged(c) : 1);

// Funding per account: deposits − withdrawals is the equity base once the ledger has entries
// (otherwise the Capital typed in Settings). Charges (market data, platform…) reduce equity separately.
function funding(settings, brokerId) {
  const list = (settings.cash || []).filter((c) => c.broker === brokerId);
  const dep = sum(list.filter((c) => c.type === "deposit"), (c) => n(c.amount));
  const wd = sum(list.filter((c) => c.type === "withdrawal"), (c) => n(c.amount));
  const charges = sum(list.filter((c) => c.type === "charge"), chargeTotal);
  const moneyMoves = list.filter((c) => c.type !== "charge").length > 0;
  const b = settings.brokers.find((x) => x.id === brokerId);
  return { list, dep, wd, charges, net: dep - wd, fromLedger: moneyMoves, base: moneyMoves ? dep - wd : n(b?.capital) };
}

function portfolio(fills, settings) {
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
    const fund = funding(settings, b.id);
    const TNE = fund.base + upnl + (L.includeRealized || fund.fromLedger ? realizedAll : 0) - fund.charges;
    const callR = n(b.callRatio) / 100, stopR = n(b.stopRatio) / 100;
    return {
      ...b, capital: fund.base, fund, rows: rs, IM, upnl, realizedAll, realizedToday, TNE, callR, stopR,
      ratio: IM > 0 ? TNE / IM : Infinity,
      lossToCall: IM > 0 ? TNE - IM * callR : TNE,
      freeIM: (minR > 0 ? TNE / minR : TNE) - IM,
      riskCap: fund.base * n(L.maxRiskPct) / 100,
      notional: sum(rs, (r) => r.notional),
      totalRisk: sum(rs, (r) => r.risk || 0),
    };
  });
  const acct = (id) => accounts.find((a) => a.id === id);
  const capital = sum(B, (b) => funding(settings, b.id).base);
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
    dailyCap: capital * n(L.dailyLossPct) / 100,
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
    return { key, product, spec, pos, mark, move: mv };
  });
  const res = runScenario(b, acc, prods, target);
  const st = statusOf(res.ratio, acc, pf.minR);
  return { acc, target, res, st, callMove: breakingMove(b, acc, prods, acc.callR), stopMove: breakingMove(b, acc, prods, acc.stopR) };
}
const moveTxt = (x) => (x === null ? "No open positions" : !isFinite(x) ? "Not reachable" : x === 0 ? "Already there" : `${x.toFixed(1)}% against you`);

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

const F = ({ label, hint, children }) => <label className="f">{label}{children}{hint && <small>{hint}</small>}</label>;
const Side = ({ s }) => <span className={`side ${s === "Long" || s === "Buy" ? "long" : "short"}`}>{s}</span>;

// =====================================================================
export default function App() {
  const [user, setUser] = useState(undefined);
  // Set when you arrive from a password-reset email: the link has already signed
  // you in, so show "choose a new password" rather than the desk.
  const [recovering, setRecovering] = useState(false);

  useEffect(() => {
    db.getUser().then(setUser);
    return auth.onAuthChange((u, event) => {
      setUser(u);
      if (event === "PASSWORD_RECOVERY") setRecovering(true);
    });
  }, []);

  if (user === undefined) return <div className="auth dim">Loading Nexus…</div>;
  if (recovering) return <SignInPage><NewPassword onDone={() => setRecovering(false)} /></SignInPage>;
  if (!user) return <SignInPage><SignIn /></SignInPage>;
  return <Tracker key={user.id} user={user} />;
}

// The desk's front door: navy brand panel beside the form, stacking on a phone.
function SignInPage({ children }) {
  return (
    <div className="signin">
      <aside className="signin-brand">
        <div className="mark">N</div>
        <h1>Nexus <span>· MRD</span></h1>
        <p className="desk">Margin &amp; Risk Desk</p>
        <div className="rule" />
        <ul>
          <li>Positions and margin across every broker account</li>
          <li>Stress a move against you before you put it on</li>
          <li>Fills, closed trades and funding in one book</li>
        </ul>
        <p className="foot">Access is by invitation. Speak to your desk administrator.</p>
      </aside>
      <main className="signin-form">{children}</main>
    </div>
  );
}

// Sign-in only: accounts are created by invitation, so there is no sign-up here.
function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [mode, setMode] = useState("in");     // "in" | "forgot"
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [sent, setSent] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr(null);
    try {
      if (mode === "forgot") { await auth.sendReset(email); setSent(true); }
      else await auth.signIn(email, password);
    } catch (e2) {
      setErr(e2.message === "Invalid login credentials" ? "That email and password don't match." : e2.message);
    } finally { setBusy(false); }
  };

  if (sent) return (
    <form className="signin-card" onSubmit={(e) => e.preventDefault()}>
      <h2>Check your email</h2>
      <p className="lede">If an account exists for <b>{email}</b>, a reset link is on its way.</p>
      <p className="note">The link signs you in and asks for a new password. Look in spam if it doesn't arrive within a few minutes.</p>
      <button type="button" className="btn full" onClick={() => { setSent(false); setMode("in"); }}>Back to sign in</button>
    </form>
  );

  return (
    <form className="signin-card" onSubmit={submit}>
      <h2>{mode === "in" ? "Sign in" : "Reset your password"}</h2>
      <p className="lede">{mode === "in" ? "Use the email address your desk account was opened with." : "We'll email you a link to set a new password."}</p>
      <F label="Email">
        <input className="in" type="email" autoComplete="username" required autoFocus
          placeholder="you@firm.com" value={email} onChange={(e) => setEmail(e.target.value)} />
      </F>
      {mode === "in" && (
        <F label="Password">
          <input className="in" type="password" autoComplete="current-password" required
            value={password} onChange={(e) => setPassword(e.target.value)} />
        </F>
      )}
      {err && <div className="signin-err">{err}</div>}
      <button className="btn full" disabled={busy}>
        {busy ? "Please wait…" : mode === "in" ? "Sign in" : "Email me a reset link"}
      </button>
      <button type="button" className="linklike" onClick={() => { setMode(mode === "in" ? "forgot" : "in"); setErr(null); }}>
        {mode === "in" ? "Forgotten your password?" : "Back to sign in"}
      </button>
    </form>
  );
}

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
        <input className="in" type="password" autoComplete="new-password" required autoFocus
          value={password} onChange={(e) => setPassword(e.target.value)} />
      </F>
      <F label="Repeat it">
        <input className="in" type="password" autoComplete="new-password" required
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

function Tracker({ user }) {
  const [settings, setSettings] = useState(null);
  const [fills, setFills] = useState([]);
  const [tab, setTab] = useState("dash");
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

  if (loadErr) return <div className="auth"><div className="panel"><div className="ph"><h2 className="bad">Couldn't load your data</h2></div><div className="pb"><p>{loadErr}</p><p className="dim">Please reload the page.</p></div></div></div>;
  if (!settings || !pf) return <div className="auth dim">Loading your data…</div>;

  const L = settings.limits;
  const view = settings.brokers.some((b) => b.id === settings.view) ? settings.view : "all";
  const setView = (v) => setSettings((s) => ({ ...s, view: v }));
  const setLimit = (k, v) => setSettings((s) => ({ ...s, limits: { ...s.limits, [k]: v } }));
  const setBroker = (id, k, v) => setSettings((s) => ({ ...s, brokers: s.brokers.map((b) => (b.id === id ? { ...b, [k]: v } : b)) }));
  const setProduct = (id, p, k, v) => setSettings((s) => ({ ...s, brokers: s.brokers.map((b) => (b.id === id ? { ...b, products: { ...b.products, [p]: { ...b.products?.[p], [k]: v } } } : b)) }));
  const setMark = (key, k, v) => setSettings((s) => ({ ...s, marks: { ...s.marks, [key]: { ...s.marks[key], [k]: v } } }));
  const addFills = async (rows) => { const added = await db.addFills(rows); await reloadFills(); return added; };
  const setScen = (patch) => setSettings((s) => ({ ...s, scenario: { ...s.scenario, ...patch } }));

  // scope for the top bar
  const scoped = view === "all" ? null : pf.acct(view);
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
    <div className="app">
      <nav className="rail" aria-label="Main">
        <div className="logo" title="Nexus: MRD - Margin & Risk Desk">N</div>
        {nav.map(([key, l, c]) => (
          <button key={key} aria-current={tab === key ? "page" : undefined} onClick={() => setTab(key)}>
            {ICONS[key]}{l}{c ? <span className="badge">{c > 999 ? "999+" : c}</span> : null}
          </button>
        ))}
        <div className="spacer" />
      </nav>

      <header className="top">
        <div className="brand"><b>Nexus</b><span>MRD · Margin &amp; Risk Desk</span></div>
        <div className="scope">
          <label className="f" style={{ gap: 2 }}>Account
            <select className="in" value={view} onChange={(e) => setView(e.target.value)} aria-label="Account shown">
              <option value="all">All brokers</option>
              {settings.brokers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
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
        {tab === "dash" && <Dashboard pf={pf} settings={settings} view={view} setView={setView} fills={fills} setMark={setMark} addFills={addFills} goFills={() => setTab("fills")} goSettings={() => setTab("settings")} goScen={() => setTab("scen")} />}
        {tab === "scen" && <ScenarioTab pf={pf} settings={settings} view={view} setScen={setScen} setMark={setMark} />}
        {tab === "fills" && <FillsTab settings={settings} setSettings={setSettings} view={view} fills={fills} addFills={addFills} reloadFills={reloadFills} setBroker={setBroker} />}
        {tab === "closed" && <ClosedTab pf={pf} settings={settings} view={view} fills={fills} />}
        {tab === "analysis" && <AnalysisTab pf={pf} settings={settings} view={view} />}
        {tab === "funds" && <FundsTab pf={pf} settings={settings} setSettings={setSettings} view={view} />}
        {tab === "settings" && <SettingsTab settings={settings} setSettings={setSettings} setLimit={setLimit} setBroker={setBroker} setProduct={setProduct} pf={pf} fills={fills} reloadFills={reloadFills} />}
      </main>
    </div>
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
      {rows.length === 0 ? <div className="empty">Nothing traded yet. Upload fills or record a trade.</div> : (
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

function Dashboard({ pf, settings, view, setView, fills, setMark, addFills, goFills, goSettings, goScen }) {
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
  if (pf.dailyCap > 0 && pf.total.todayPnl <= -pf.dailyCap) warnings.push(["bad", `Daily loss limit hit (${money(pf.total.todayPnl)} across all brokers). Stop trading today.`]);
  else if (pf.dailyCap > 0 && pf.total.todayPnl <= -0.7 * pf.dailyCap) warnings.push(["warn", `Today's loss is ${pct(-pf.total.todayPnl / pf.dailyCap)} of your daily limit.`]);
  if (pf.rows.length >= n(L.maxTrades)) warnings.push(["bad", `Maximum of ${L.maxTrades} open positions reached.`]);
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
  const closeAtMark = async (r) => {
    if (!window.confirm(`Record a ${r.side === "Long" ? "sell" : "buy"} of ${qty(r.lots)} ${r.product} at ${px(r.mark)} on ${r.brokerName} to close this position?`)) return;
    await addFills([{ ts: new Date().toISOString(), broker: r.broker, product: r.product, side: r.side === "Long" ? "Sell" : "Buy", qty: r.lots, price: r.mark, ref: `m:${crypto.randomUUID()}`, source: "manual" }]);
  };
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
            <div className="empty">No open positions{all ? "" : ` at ${bname(view)}`}. <button className="btn ghost" onClick={goFills}>Upload fills</button> or use the trade ticket.</div>
          ) : (
            <div className="tw">
              <table>
                <thead><tr>{all && <th className="txt">Broker</th>}<th className="txt">Product</th><th>Side</th><th>Lots</th><th>Avg price</th><th>Current</th><th>Stop</th><th>Open P&L</th><th>Init. margin</th><th>Risk to stop</th><th>Opened</th><th></th></tr></thead>
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
                      <td><button className="btn ghost" onClick={() => closeAtMark(r)} title="Record an offsetting fill at the current price">Close</button></td>
                    </tr>
                  ))}
                  <tr className="total">
                    <td className="txt" colSpan={all ? 2 : 1}>Total</td><td colSpan={5}></td>
                    <td className={pc(sum(rows, (r) => r.upnl))}>{signed(sum(rows, (r) => r.upnl))}</td><td>{money(sum(rows, (r) => r.im))}</td><td>{money(sum(rows, (r) => r.risk || 0))}</td><td colSpan={2}></td>
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

        <TradeTicket key={view} cls="o3" pf={pf} settings={settings} view={view} fills={fills} addFills={addFills} setMark={setMark} goSettings={goSettings} />

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
  const cap = (x) => (x === null ? "Set price" : !isFinite(x) ? "No limit" : x <= 0 ? "0" : qty(x));

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
            <F label="Products shown" hint="Flat products are only useful when you're sizing a new trade.">
              <select className="in" value={S.openOnly === false ? "all" : "open"} onChange={(e) => setScen({ openOnly: e.target.value === "open" })}>
                <option value="open">Open positions only</option>
                <option value="all">Every product</option>
              </select>
            </F>
            <button className="btn" onClick={applyAll}>Apply to all products</button>
          </div>
        </div>
      </section>

      {brokers.map((b) => {
        const { acc, target, res, st, callMove, stopMove } = scenarioFor(pf, settings, b);
        const verdict = !isFinite(res.ratio) ? ["dim", "No open positions. Capacity shows what you could put on under this scenario."]
          : res.ratio <= acc.stopR ? ["bad", "This scenario takes the account to stop-out. Positions would be liquidated."]
          : res.ratio <= acc.callR ? ["bad", "This scenario triggers a margin call. Reduce positions or add funds."]
          : res.ratio < pf.minR ? ["warn", `Survives, but falls below your ${L.minRatio}% minimum. No room to add risk.`]
          : ["ok", "Survives this scenario above your minimum."];
        return (
          <section className="panel" key={b.id} style={{ marginTop: 12, borderTop: `3px solid var(--${verdict[0] === "dim" ? "line2" : verdict[0]})` }}>
            <div className="ph"><h2>{b.name}<span className="dim">{basis(b)}</span></h2><span className={verdict[0]} style={{ fontSize: 12, fontWeight: 600 }}>{verdict[1]}</span></div>
            <div className="strip">
              <div className="kpi"><label>TNE now → after</label><b>{money(acc.TNE)} <span className="faint">→</span> <span className={res.loss ? "bad" : ""}>{money(res.TNE)}</span></b></div>
              <div className="kpi"><label>TNE / IM now → after</label><b><span className={statusOf(acc.ratio, acc, pf.minR).cls}>{ratioTxt(acc.ratio)}</span> <span className="faint">→</span> <span className={st.cls}>{ratioTxt(res.ratio)}</span></b></div>
              <div className="kpi"><label>Initial margin after</label><b>{money(res.IM)}</b></div>
              <div className="kpi"><label>Margin call ({b.callRatio}%) if all move</label><b className={callMove !== null && isFinite(callMove) && callMove < 10 ? "bad" : ""}>{moveTxt(callMove)}</b></div>
              <div className="kpi"><label>Stop-out ({b.stopRatio}%) if all move</label><b>{moveTxt(stopMove)}</b></div>
            </div>
            {res.lines.length === 0 ? <div className="empty">{b.name} has no products yet. Upload its fills, or add products under Settings → {b.name}, and each will get its own row here.</div>
             : S.openOnly !== false && !res.lines.some((l) => l.pos) ? <div className="empty">{b.name} is flat. <button className="btn ghost" onClick={() => setScen({ openOnly: false })}>Show every product</button> to size a new trade.</div>
             : <div className="tw">
              <table>
                <thead><tr>
                  <th className="txt">Product</th><th>Position</th><th>Current price</th><th>Move against you</th><th>Stressed price</th><th>Scenario P&L</th><th>Margin after</th>
                  <th>Can buy</th><th>Can sell</th><th className="txt">Status</th>
                </tr></thead>
                <tbody>
                  {(S.openOnly === false ? res.lines : res.lines.filter((l) => l.pos)).map((l) => {
                    const mv = S.moves[l.key] || { v: S.defV, unit: S.defUnit };
                    const status = l.reason === "price" ? ["warn", "Enter a price"]
                      : l.cut > 0 ? ["bad", `Too big: cut ${qty(l.cut)} lots`]
                      : (l.canBuy !== null && l.canBuy <= 0 && l.canSell <= 0) ? ["bad", "No room"]
                      : l.pos ? ["ok", "Within limit"] : ["dim", "Flat"];
                    return (
                      <tr key={l.key}>
                        <td className="txt"><b>{l.product}</b></td>
                        <td>{l.pos ? <><Side s={l.pos > 0 ? "Long" : "Short"} /> {qty(Math.abs(l.pos))}</> : <span className="faint">—</span>}</td>
                        <td>{l.pos ? px(l.mark) : <input className="cell" type="number" step="0.01" placeholder="Price" value={settings.marks[l.key]?.price ?? ""} onChange={(e) => setMark(l.key, "price", e.target.value)} aria-label={`Reference price ${l.product}`} />}</td>
                        <td>
                          <span style={{ display: "inline-flex", gap: 4 }}>
                            <input className="cell" style={{ width: 64 }} type="number" step="0.1" value={mv.v} onChange={(e) => setMove(l.key, { v: e.target.value })} aria-label={`Move ${l.product}`} />
                            <select className="cell" style={{ width: 58, textAlign: "left" }} value={mv.unit} onChange={(e) => setMove(l.key, { unit: e.target.value })} aria-label={`Unit ${l.product}`}><option value="%">%</option><option value="pts">pts</option></select>
                          </span>
                        </td>
                        <td className="dim">{l.stressed !== null ? px(l.stressed) : "—"}</td>
                        <td className={l.loss ? "bad" : "faint"}>{l.pos ? money(-l.loss) : "—"}</td>
                        <td>{l.pos ? money(l.im) : <span className="faint">—</span>}</td>
                        <td className={l.canBuy === null ? "warn" : l.canBuy <= 0 ? "bad" : "ok"}><b>{cap(l.canBuy)}</b></td>
                        <td className={l.canSell === null ? "warn" : l.canSell <= 0 ? "bad" : "ok"}><b>{cap(l.canSell)}</b></td>
                        <td className="txt"><span className={`pill ${status[0]}`}><span className={status[0]}>{status[1]}</span></span></td>
                      </tr>
                    );
                  })}
                  <tr className="total"><td className="txt">Account</td><td colSpan={4}></td><td className={res.loss ? "bad" : ""}>{money(-res.loss)}</td><td>{money(res.IM)}</td><td colSpan={3} className="txt dim">Lots you can add and still stay above {ratioTxt(target)} after the scenario</td></tr>
                </tbody>
              </table>
              {S.openOnly !== false && res.lines.some((l) => !l.pos) && (
                <div className="pb faint" style={{ fontSize: 11 }}>
                  {res.lines.filter((l) => !l.pos).length} flat product{res.lines.filter((l) => !l.pos).length === 1 ? "" : "s"} hidden.{" "}
                  <button className="btn ghost" onClick={() => setScen({ openOnly: false })}>Show every product</button>
                </div>
              )}
            </div>}
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

// ---------- trade ticket ----------
function TradeTicket({ cls = "", pf, settings, view, fills, addFills, setMark, goSettings }) {
  const brokers = settings.brokers;
  const [brokerId, setBrokerId] = useState(view !== "all" ? view : brokers[0]?.id);
  const broker = brokers.find((b) => b.id === brokerId) || brokers[0];
  const products = Object.keys(broker?.products || {}).sort();
  const [f, setF] = useState({ product: products[0] || "", side: "Buy", lots: 1, price: "", stop: "" });
  const [msg, setMsg] = useState(null);
  useEffect(() => { if (!products.includes(f.product)) setF((x) => ({ ...x, product: products[0] || "" })); }, [brokerId, products.join()]);
  const set = (k, v) => { setF((x) => ({ ...x, [k]: v })); setMsg(null); };
  const valid = broker && f.product && n(f.lots) > 0 && has(f.price);
  const acc = pf.acct(broker?.id);

  const hyp = valid ? { ts: new Date().toISOString(), broker: broker.id, product: f.product, side: f.side, qty: n(f.lots), price: n(f.price), ref: "hyp" } : null;
  const after = useMemo(() => (hyp ? portfolio([...fills, hyp], settings) : null), [fills, settings, broker?.id, f.product, f.side, f.lots, f.price]);
  const accAfter = after?.acct(broker.id);
  const spec = broker?.products?.[f.product] || {};
  const size = n(spec.size) || 1000;
  const lev = n(spec.lev) || n(broker?.leverage) || 1;
  const dir = f.side === "Buy" ? 1 : -1;
  const risk = has(f.stop) && has(f.price) ? Math.max(0, dir * (n(f.price) - n(f.stop))) * size * n(f.lots) : null;
  const imDelta = accAfter && acc ? accAfter.IM - acc.IM : 0;
  const perLotIM = broker?.method === "leverage" ? (Math.abs(n(f.price)) * size) / lev : n(spec.margin);
  const lotsByMargin = perLotIM > 0 && acc ? Math.floor(Math.max(0, acc.freeIM) / perLotIM * 100) / 100 : Infinity;
  const riskPerLot = risk !== null && n(f.lots) > 0 ? risk / n(f.lots) : 0;
  const lotsByRisk = riskPerLot > 0 && acc ? Math.floor(acc.riskCap / riskPerLot * 100) / 100 : Infinity;
  const maxLots = Math.min(lotsByMargin, lotsByRisk);
  const existing = pf.rows.find((r) => r.broker === broker?.id && r.product === f.product);
  const reduces = existing && ((existing.side === "Long" && f.side === "Sell") || (existing.side === "Short" && f.side === "Buy"));

  const issues = [];
  if (accAfter) {
    if (!reduces && after.rows.length > n(settings.limits.maxTrades)) issues.push(["bad", "Exceeds your maximum open positions."]);
    if (imDelta > 0 && accAfter.ratio < pf.minR) issues.push(["bad", `${broker.name} TNE/IM would fall to ${ratioTxt(accAfter.ratio)}, under your ${settings.limits.minRatio}% minimum.`]);
    if (!reduces && risk !== null && risk > acc.riskCap) issues.push(["bad", `Risk ${money(risk)} exceeds per-trade limit ${money(acc.riskCap)}.`]);
    if (!reduces && has(f.stop) && dir * (n(f.price) - n(f.stop)) <= 0) issues.push(["bad", "Stop is on the wrong side of the price."]);
    if (!reduces && pf.dailyCap > 0 && pf.total.todayPnl <= -pf.dailyCap) issues.push(["bad", "Daily loss limit already hit."]);
    if (broker.method === "fixed" && !n(spec.margin)) issues.push(["warn", `Set ${broker.name}'s margin per lot for ${f.product} in Settings.`]);
    if (!reduces && !has(f.stop)) issues.push(["warn", "Add a stop to measure risk."]);
  }
  const blocked = issues.some((i) => i[0] === "bad");
  const ast = accAfter ? statusOf(accAfter.ratio, accAfter, pf.minR) : null;

  const record = async () => {
    try {
      await addFills([{ ...hyp, ts: new Date().toISOString(), ref: `m:${crypto.randomUUID()}`, source: "manual" }]);
      if (has(f.stop) && !reduces) setMark(`${broker.id}|${f.product}`, "stop", f.stop);
      setMsg(["ok", `Recorded ${f.side.toLowerCase()} ${f.lots} ${f.product} @ ${f.price} on ${broker.name}`]);
      setF((x) => ({ ...x, price: "" }));
    } catch (e) { setMsg(["bad", e.message]); }
  };

  return (
    <section className={`panel ${cls}`}>
      <div className="ph"><h2>Trade ticket</h2>{existing && <span className="dim" style={{ fontSize: 11 }}>Holding {existing.side.toLowerCase()} {qty(existing.lots)} @ {px(existing.avg)}</span>}</div>
      <div className="pb fg">
        <div className="seg" role="group" aria-label="Side">
          <button className={f.side === "Buy" ? "on-buy" : ""} aria-pressed={f.side === "Buy"} onClick={() => set("side", "Buy")}>Buy</button>
          <button className={f.side === "Sell" ? "on-sell" : ""} aria-pressed={f.side === "Sell"} onClick={() => set("side", "Sell")}>Sell</button>
        </div>
        <div className="fg c2">
          <F label="Broker" hint={broker ? basis(broker) : null}>
            <select className="in" value={broker?.id || ""} onChange={(e) => { setBrokerId(e.target.value); setMsg(null); }}>{brokers.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
          </F>
          <F label="Product">
            {products.length ? <select className="in" value={f.product} onChange={(e) => set("product", e.target.value)}>{products.map((p) => <option key={p}>{p}</option>)}</select>
              : <button className="btn ghost" style={{ padding: "7px" }} onClick={goSettings}>Add a product</button>}
          </F>
          <F label="Lots"><input className="in" type="number" step="0.01" min="0" value={f.lots} onChange={(e) => set("lots", e.target.value)} /></F>
          <F label="Price"><input className="in" type="number" step="0.01" value={f.price} onChange={(e) => set("price", e.target.value)} /></F>
          <F label="Stop"><input className="in" type="number" step="0.01" value={f.stop} onChange={(e) => set("stop", e.target.value)} disabled={reduces} /></F>
          <F label={broker?.method === "leverage" ? "Margin / lot" : "Broker margin / lot"}>
            <div className="in num" style={{ background: "var(--panel2)" }} title={broker?.method === "leverage" ? `${size} × price ÷ ${lev}` : ""}>{perLotIM ? money(perLotIM) : "—"}</div>
          </F>
        </div>
        {accAfter && (
          <>
            <div className="preview" style={{ marginTop: 0 }}>
              {reduces && <><span>Effect</span><span style={{ color: "var(--accent)" }}>Reduces position</span></>}
              <span>Margin change</span><span>{imDelta >= 0 ? "+" : ""}{money(imDelta)}</span>
              {!reduces && <><span>Risk to stop</span><span>{risk === null ? "—" : money(risk)}</span></>}
              <span>{broker.name} TNE/IM after</span><span className={ast.cls}>{ratioTxt(accAfter.ratio)}</span>
              {!reduces && <><span>Max lots allowed</span><span className={maxLots < n(f.lots) ? "bad" : "ok"}>{isFinite(maxLots) ? qty(maxLots) : "—"}</span></>}
              {existing && !reduces && <><span>New average</span><span>{px(after.rows.find((r) => r.broker === broker.id && r.product === f.product)?.avg)}</span></>}
            </div>
            {issues.length > 0 && <div className="msgs">{issues.map(([l, m], i) => <div key={i} className={l}>{m}</div>)}</div>}
          </>
        )}
        <button className={`btn full ${blocked ? "danger" : f.side === "Buy" ? "buy" : "sell"}`} disabled={!valid} onClick={record}>
          {blocked ? "Record anyway — breaks a limit" : `Record ${f.side.toLowerCase()}${valid ? ` ${f.lots} ${f.product}` : ""}`}
        </button>
        {msg && <div className={msg[0]} style={{ fontSize: 12 }}>{msg[1]}</div>}
      </div>
    </section>
  );
}

// ---------- fills ----------
function FillsTab({ settings, setSettings, view, fills, addFills, reloadFills, setBroker }) {
  const brokers = settings.brokers;
  const [target, setTarget] = useState(view !== "all" ? view : brokers[0]?.id);
  const [csv, setCsv] = useState(null);
  const [map, setMap] = useState({});
  const [dateFormat, setDateFormat] = useState("auto");
  const [savedLayout, setSavedLayout] = useState(false);
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
  const load = async (file) => {
    if (!file) return;
    setResult(null);
    try { const { headers, rows } = await parseCsvFile(file); setCsv({ name: file.name, headers, rows }); applyLayout(headers, target); }
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
    } catch (err) { setResult(["bad", `Couldn't read those rows: ${err.message}`]); }
  };
  const reset = () => { setCsv(null); setIncludeManual(false); setSplit(true); setApplySizes(true); setSpreadMode("spread"); setImportCash(true); if (fileRef.current) fileRef.current.value = ""; };
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
                    <td><button className="btn ghost" onClick={async (e) => { e.stopPropagation(); if (window.confirm("Delete this fill?")) { await db.deleteFill(x.id); await reloadFills(); } }} aria-label="Delete fill">✕</button></td>
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
                const hasLegs = inLegs.length || outLegs.length;
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
function SettingsTab({ settings, setSettings, setLimit, setBroker, setProduct, pf, fills, reloadFills }) {
  const L = settings.limits;
  const lnum = (k, props = {}) => <input className="in" type="number" value={L[k]} onChange={(e) => setLimit(k, e.target.value)} {...props} />;
  const addBroker = () => {
    const id = `b${Date.now().toString(36)}`;
    setSettings((s) => ({ ...s, brokers: [...s.brokers, { ...NEW_BROKER, id, name: `Broker ${s.brokers.length + 1}` }] }));
  };
  return (
    <div className="grid-settings">
      <section className="panel">
        <div className="ph"><h2>Your limits</h2><span className="faint" style={{ fontSize: 11 }}>Apply to every broker</span></div>
        <div className="pb">
          <div className="fg c2">
            <F label="Minimum TNE/IM (%)" hint="Per broker account; new trades below it are flagged">{lnum("minRatio")}</F>
            <F label="Max open positions" hint="Across all brokers">{lnum("maxTrades")}</F>
            <F label="Max risk per trade (% of that broker's capital)">{lnum("maxRiskPct", { step: 0.1 })}</F>
            <F label="Daily loss limit (% of total capital)" hint={money(pf.dailyCap)}>{lnum("dailyLossPct", { step: 0.1 })}</F>
          </div>
          <div className="sep" />
          <label className="check">
            <input type="checkbox" checked={!!L.includeRealized} onChange={(e) => setLimit("includeRealized", e.target.checked)} />
            <span>Add realized P&L (after fees) to each account's equity (<span className={`num ${pc(pf.total.realizedAll)}`}>{signed(pf.total.realizedAll)}</span> in total)<br /><span className="faint">Untick if you update each broker's capital yourself after closing trades.</span></span>
          </label>
          <div className="sep" />
          <button className="btn full" onClick={addBroker}>Add broker account</button>
        </div>
      </section>

      <ResetPanel settings={settings} setSettings={setSettings} fills={fills} reloadFills={reloadFills} />

      {settings.brokers.map((b) => (
        <BrokerCard key={b.id} b={b} acc={pf.acct(b.id)} used={fills.some((f) => f.broker === b.id)} inUse={new Set(pf.rows.filter((r) => r.broker === b.id).map((r) => r.product))}
          setBroker={setBroker} setProduct={setProduct} setSettings={setSettings} />
      ))}
    </div>
  );
}

function BrokerCard({ b, acc, used, inUse, setBroker, setProduct, setSettings }) {
  const [newP, setNewP] = useState("");
  const set = (k) => (e) => setBroker(b.id, k, e.target.value);
  const lev = b.method === "leverage";
  const addProduct = () => { const p = newP.trim(); if (!p || b.products?.[p]) return; setProduct(b.id, p, "size", lev ? 100 : 1000); setNewP(""); };
  const remove = () => {
    if (used) return;
    if (window.confirm(`Remove ${b.name}?`)) setSettings((s) => ({ ...s, brokers: s.brokers.filter((x) => x.id !== b.id), view: s.view === b.id ? "all" : s.view }));
  };
  return (
    <section className="panel">
      <div className="ph">
        <h2>{b.name}<span className="dim">{basis(b)}</span></h2>
        <div className="actions">
          {acc && isFinite(acc.ratio) && <span className="num" style={{ fontSize: 12 }}>TNE/IM <b>{ratioTxt(acc.ratio)}</b></span>}
          <button className="btn ghost" disabled={used} title={used ? "This broker has fills. Delete them first to remove it." : "Remove broker"} onClick={remove}>Remove</button>
        </div>
      </div>
      <div className="pb">
        <div className="fg c2">
          <F label="Broker / account name"><input className="in" value={b.name} onChange={set("name")} /></F>
          {acc?.fund?.fromLedger
            ? <F label="Capital in this account ($)" hint="Net deposits from the Funds tab"><div className="in num" style={{ background: "var(--panel2)" }}>{money(acc.fund.net)}</div></F>
            : <F label="Capital in this account ($)" hint="Or record deposits in the Funds tab"><input className="in" type="number" value={b.capital} onChange={set("capital")} /></F>}
          <F label="How margin is set">
            <select className="in" value={b.method} onChange={set("method")}>
              <option value="fixed">Broker gives margin per lot (e.g. Orient)</option>
              <option value="leverage">Leverage, e.g. 1:100 (e.g. MT5)</option>
            </select>
          </F>
          {lev ? (
            <F label="Account leverage (1 : X)" hint={`Margin = lots × contract size × price ÷ ${n(b.leverage) || "X"}`}>
              <select className="in" value={LEVERAGES.includes(+b.leverage) ? b.leverage : "custom"} onChange={(e) => e.target.value !== "custom" && setBroker(b.id, "leverage", +e.target.value)}>
                {LEVERAGES.map((l) => <option key={l} value={l}>1:{l}</option>)}
                {!LEVERAGES.includes(+b.leverage) && <option value="custom">1:{b.leverage}</option>}
              </select>
            </F>
          ) : <F label="Margin per lot" hint="Set per product below"><div className="in dim" style={{ background: "var(--panel2)" }}>From broker</div></F>}
          <F label="Closing trades are matched" hint={b.match ? null : "Default for this margin method"}>
            <select className="in" value={matchOf(b)} onChange={set("match")}>
              <option value="fifo">FIFO: oldest lots first (e.g. Orient)</option>
              <option value="average">Average price (e.g. MT5 netting)</option>
            </select>
          </F>
          <F label="Commission per lot ($)" hint="Per side. Only used where the fill carries no commission of its own.">
            <input className="in" type="number" step="0.01" placeholder="0" value={b.commission ?? ""} onChange={set("commission")} />
          </F>
          <F label="Margin call level (TNE/IM %)" hint={lev ? "MT5: 'Margin call' level" : null}><input className="in" type="number" value={b.callRatio} onChange={set("callRatio")} /></F>
          <F label="Stop-out level (TNE/IM %)" hint={lev ? "MT5: 'Stop out' level" : null}><input className="in" type="number" value={b.stopRatio} onChange={set("stopRatio")} /></F>
        </div>
      </div>
      <div className="tw">
        <table>
          <thead><tr><th className="txt">Product</th><th>Contract size</th><th>{lev ? "Leverage override" : "Margin / lot ($)"}</th><th>Commission / lot</th><th></th></tr></thead>
          <tbody>
            {Object.keys(b.products || {}).length === 0 && <tr><td colSpan={5} className="txt faint">No products yet. They're added automatically when you upload fills, or add one below.</td></tr>}
            {Object.entries(b.products || {}).sort(([x], [y]) => x.localeCompare(y)).map(([p, s]) => (
              <tr key={p}>
                <td className="txt"><b>{p}</b>{s.note && <div className="faint" style={{ fontSize: 11 }}>{s.note}</div>}</td>
                <td><input className="cell" type="number" value={s.size ?? ""} onChange={(e) => setProduct(b.id, p, "size", e.target.value)} aria-label={`${p} contract size`} /></td>
                <td>{lev
                  ? <input className="cell" type="number" placeholder={`1:${b.leverage}`} value={s.lev ?? ""} onChange={(e) => setProduct(b.id, p, "lev", e.target.value)} aria-label={`${p} leverage override`} />
                  : <input className={`cell ${n(s.margin) ? "" : "need"}`} style={{ width: 96 }} type="number" placeholder="Set" value={s.margin ?? ""} onChange={(e) => setProduct(b.id, p, "margin", e.target.value)} aria-label={`${p} margin per lot`} />}</td>
                <td><input className="cell" type="number" step="0.01" placeholder={n(b.commission) ? money(n(b.commission)) : "0"}
                  value={s.comm ?? ""} onChange={(e) => setProduct(b.id, p, "comm", e.target.value)}
                  aria-label={`${p} commission per lot`} title="Overrides the account rate. A spread billed per leg costs twice the leg rate." /></td>
                <td>{!inUse.has(p) && <button className="btn ghost" aria-label={`Remove ${p}`} onClick={() => setSettings((st) => ({ ...st, brokers: st.brokers.map((x) => { if (x.id !== b.id) return x; const { [p]: _, ...rest } = x.products; return { ...x, products: rest }; }) }))}>✕</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="pb" style={{ display: "flex", gap: 8 }}>
        <input className="in" placeholder={lev ? "Add symbol, e.g. XBRUSD" : "Add product, e.g. RB_CL"} value={newP} onChange={(e) => setNewP(e.target.value.toUpperCase())} onKeyDown={(e) => e.key === "Enter" && addProduct()} />
        <button className="btn" disabled={!newP.trim() || !!b.products?.[newP.trim()]} onClick={addProduct}>Add</button>
      </div>
    </section>
  );
}

// ---------- reset / delete data ----------
function ResetPanel({ settings, setSettings, fills, reloadFills }) {
  const brokers = settings.brokers;
  const [bid, setBid] = useState(brokers[0]?.id || "");
  const [msg, setMsg] = useState(null);
  const b = brokers.find((x) => x.id === bid);
  const mine = fills.filter((f) => f.broker === bid);
  const done = (t) => setMsg(["ok", t]);
  const delBroker = async () => {
    if (await safeDelete({ fills: mine, brokers, label: bid, what: `all ${mine.length} ${b?.name} fills`, run: () => db.deleteBrokerFills(bid) })) { await reloadFills(); done(`Deleted ${b?.name}'s fills. Its settings are kept, so you can re-upload.`); }
  };
  const delAll = async () => {
    if (await safeDelete({ fills, brokers, label: "all", what: `all ${fills.length} fills across every broker`, run: () => db.deleteAllFills() })) { await reloadFills(); done("Deleted all fills. Broker settings are kept."); }
  };
  const resetSettings = () => {
    if (fills.length) { setMsg(["bad", "Delete the fills first. Otherwise accounts would be recreated from them with default settings."]); return; }
    if (!window.confirm("Reset all settings (brokers, capital, margins, limits, prices, scenario moves, funds ledger) to the defaults?")) return;
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
  const remove = (id) => { if (window.confirm("Delete this entry?")) setSettings((s) => ({ ...s, cash: s.cash.filter((c) => c.id !== id) })); };
  const stopMonthly = (id) => { if (window.confirm("Stop this monthly charge from today? Months already charged stay.")) setSettings((s) => ({ ...s, cash: s.cash.map((c) => (c.id === id ? { ...c, endTs: new Date().toISOString() } : c)) })); };
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
            <F label="Amount ($)"><input className="in" type="number" min="0" step="0.01" value={f.amount} onChange={(e) => set("amount", e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} /></F>
            <F label="Date"><input className="in" type="date" value={f.date} onChange={(e) => set("date", e.target.value)} /></F>
            <F label="Note (optional)"><input className="in" value={f.note} placeholder="e.g. Wire ref 4471" onChange={(e) => set("note", e.target.value)} /></F>
          </div>
          <button className={`btn full ${f.type === "deposit" ? "buy" : f.type === "charge" ? "charge" : "sell"}`} disabled={!(n(f.amount) > 0)} onClick={add}>Record {f.type}{n(f.amount) > 0 ? ` of ${money(n(f.amount))}${f.type === "charge" && f.monthly ? " a month" : ""}` : ""}</button>
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
    best: t.reduce((a, x) => (!a || x.pnl > a.pnl ? x : a), null),
    worst: t.reduce((a, x) => (!a || x.pnl < a.pnl ? x : a), null),
    curve, peak, maxDD, ddAt, winStreak, lossStreak,
    byProduct: group((x) => x.product),
    bySide: group((x) => x.side),
    byMonth: group((x) => new Date(x.closeTs).toISOString().slice(0, 7)).sort((a, b) => a.key.localeCompare(b.key)),
    lots: sum(t, (x) => x.qty),
    medianHours: median(held),
  };
}

// Cumulative realized P&L. One series, so it needs no legend — the title names it.
function EquityCurve({ curve }) {
  const [hover, setHover] = useState(null);
  const W = 760, H = 200, pad = { l: 8, r: 8, t: 12, b: 18 };
  if (curve.length < 2) return <div className="empty">At least two closed trades are needed to draw a curve.</div>;
  const ys = curve.map((p) => p.equity).concat(0);
  const lo = Math.min(...ys), hi = Math.max(...ys), span = hi - lo || 1;
  const x = (i) => pad.l + (i * (W - pad.l - pad.r)) / (curve.length - 1);
  const y = (v) => pad.t + (H - pad.t - pad.b) * (1 - (v - lo) / span);
  const line = curve.map((p, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.equity).toFixed(1)}`).join(" ");
  const area = `${line} L${x(curve.length - 1).toFixed(1)},${y(Math.max(lo, 0)).toFixed(1)} L${x(0).toFixed(1)},${y(Math.max(lo, 0)).toFixed(1)} Z`;
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.round((((e.clientX - r.left) / r.width) * W - pad.l) / ((W - pad.l - pad.r) / (curve.length - 1)));
    setHover(Math.max(0, Math.min(curve.length - 1, i)));
  };
  const h = hover !== null ? curve[hover] : null;
  return (
    <div style={{ position: "relative" }}>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img"
        aria-label={`Cumulative realized P&L over ${curve.length} closed trades, ending at ${money(curve[curve.length - 1].equity)}`}
        onMouseMove={pick} onMouseLeave={() => setHover(null)} style={{ display: "block", cursor: "crosshair" }}>
        <line x1={pad.l} x2={W - pad.r} y1={y(0)} y2={y(0)} stroke="var(--line2)" strokeWidth="1" />
        <path d={area} fill="var(--accent-soft)" />
        <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
        {h && <>
          <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={H - pad.b} stroke="var(--line2)" strokeWidth="1" />
          <circle cx={x(hover)} cy={y(h.equity)} r="4" fill="var(--accent)" stroke="#fff" strokeWidth="2" />
        </>}
      </svg>
      {h && (
        <div className="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
          <b>{money(h.equity)}</b>
          <span>{h.product}</span>
          <span className={pc(h.pnl)}>{signed(h.pnl)} · {dt(h.ts)}</span>
        </div>
      )}
      <div className="chart-foot">
        <span>Oldest closed trade</span><span>Most recent</span>
      </div>
    </div>
  );
}

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

function AnalysisTab({ pf, settings, view }) {
  const brokers = settings.brokers;
  const bname = (id) => brokers.find((b) => b.id === id)?.name || id;
  const closed = pf.book.closed.filter((c) => view === "all" || c.broker === view);
  const a = useMemo(() => analyse(closed), [closed]);
  const pct = (x) => (x === null ? "—" : `${(x * 100).toFixed(1)}%`);
  const ratio = (x) => (x === null ? "—" : !isFinite(x) ? "No losses" : x.toFixed(2));

  if (!a.n) return (
    <section className="panel"><div className="ph"><h2>Analysis</h2></div>
      <div className="empty">No closed trades yet. Once trades are squared off, this page shows how the book has performed.</div>
    </section>
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
          <div className="kpi hide-m"><label>Longest streak</label><b><span className="ok">{a.winStreak}W</span> <span className="faint">/</span> <span className="bad">{a.lossStreak}L</span></b></div>
        </div>
      </section>

      <section className="panel">
        <div className="ph"><h2>Cumulative realized P&amp;L<span className="dim">trade by trade</span></h2>
          <span className="faint" style={{ fontSize: 11 }}>Peak {money(a.peak)}{a.maxDD ? ` · deepest fall from a peak ${money(-a.maxDD)}` : ""}</span></div>
        <div className="pb"><EquityCurve curve={a.curve} /></div>
      </section>

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

      <div className="grid-settings">
        <section className="panel">
          <div className="ph"><h2>Long against short</h2></div>
          <div className="tw">
            <table>
              <thead><tr><th className="txt">Side</th><th>Trades</th><th>Win rate</th><th>Net</th></tr></thead>
              <tbody>
                {a.bySide.map((g) => (
                  <tr key={g.key}><td className="txt"><Side s={g.key} /></td><td>{g.trades}</td>
                    <td>{pct(g.trades ? g.wins / g.trades : null)}</td><td className={pc(g.net)}><b>{signed(g.net)}</b></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pb faint" style={{ fontSize: 11 }}>
            Typical holding time {a.medianHours === null ? "—" : a.medianHours < 24 ? `${a.medianHours.toFixed(1)} hours` : `${(a.medianHours / 24).toFixed(1)} days`} (median).
          </div>
        </section>

        <section className="panel">
          <div className="ph"><h2>Biggest trades</h2></div>
          <div className="tw">
            <table>
              <thead><tr><th className="txt"></th><th className="txt">Product</th><th>Side</th><th>Lots</th><th>Closed</th><th>P&amp;L</th></tr></thead>
              <tbody>
                {[["Best", a.best], ["Worst", a.worst]].map(([lab, x]) => x && (
                  <tr key={lab}><td className="txt faint">{lab}</td><td className="txt">{x.product}</td><td><Side s={x.side} /></td>
                    <td>{qty(x.qty)}</td><td className="dim">{dt(x.closeTs)}</td><td className={pc(x.pnl)}><b>{signed(x.pnl)}</b></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="pb faint" style={{ fontSize: 11 }}>
            {view === "all" && brokers.length > 1 ? "Across every broker account. Pick one in the top bar to narrow it." : `${bname(view === "all" ? brokers[0]?.id : view)} only.`}
          </div>
        </section>
      </div>
    </>
  );
}
