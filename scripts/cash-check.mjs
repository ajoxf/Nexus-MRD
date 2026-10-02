import { contentKey, fileKeys, classifyCash, addToLedger, fromLegacy, accepted, toRow, fromRow, NEAR_DAYS }
  from '../src/lib/cash.js';
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
};

let seq = 0;
const id = () => `id${++seq}`;
const now = () => '2026-10-02T00:00:00.000Z';

/*
 * The whole path a file takes into the ledger: key it, sort it against what is there,
 * store only the new ones. Returns the new ledger and what the trader would be told.
 */
const ingest = (ledger, entries, source = 'csv') => {
  const keys = fileKeys(entries);
  const { rows, counts } = classifyCash(entries.map((c, i) => ({ ...c, source, key: keys[i] })), ledger);
  const fresh = rows.filter((r) => r.status === 'new').map(({ status, match, ...c }) => c);
  const { ledger: next, added } = addToLedger(ledger, fresh, id, now);
  return { ledger: next, added, counts };
};

// A day's statement: one deposit, one fee, each with the broker's own reference.
const statement = [
  { broker: 'orient', type: 'deposit', amount: 25000, ts: '2026-10-01T09:00:00.000Z', note: 'Wire in', ref: 'ORI-DEP-0001' },
  { broker: 'orient', type: 'charge', amount: 12.5, ts: '2026-10-01T16:00:00.000Z', note: 'Exchange fee', ref: 'ORI-FEE-0002' },
];

// ---------- the non-negotiable: the same statement twice changes nothing ----------
{
  const once = ingest([], statement, 'statement');
  eq('a statement adds its entries the first time', once.added, 2);
  const twice = ingest(once.ledger, statement, 'statement');
  eq('the same statement again adds nothing', twice.added, 0);
  eq('...and leaves the ledger exactly as it was', twice.ledger, once.ledger);
  eq('...and says both were already there', twice.counts, { new: 0, stored: 2, fileDup: 0, possible: 0 });
}

// Next day's statement repeats yesterday's deposit (month-to-date style) and adds one fee.
{
  const day1 = ingest([], statement, 'statement').ledger;
  const day2 = [...statement, { broker: 'orient', type: 'charge', amount: 12.5, ts: '2026-10-02T16:00:00.000Z', note: 'Exchange fee', ref: 'ORI-FEE-0003' }];
  const r = ingest(day1, day2, 'statement');
  eq('an overlapping statement adds only what is new', r.added, 1);
  eq('...a second identical fee on another day is a real fee, not a duplicate', accepted(r.ledger).filter((c) => c.type === 'charge').length, 2);
}

// ---------- reports without references ----------
const mt5 = [
  { broker: 'mt5', type: 'deposit', amount: 1000, ts: '2026-09-10T08:00:00.000Z', note: 'Deposit' },
  { broker: 'mt5', type: 'deposit', amount: 1000, ts: '2026-09-10T08:00:00.000Z', note: 'Deposit' },
];
{
  const once = ingest([], mt5);
  eq('two identical rows in one file are two deposits, not one', once.added, 2);
  eq('...keyed by occurrence', fileKeys(mt5), ['csv:mt5|deposit|100000|2026-09-10T08:00|1', 'csv:mt5|deposit|100000|2026-09-10T08:00|2']);
  eq('re-reading that file adds neither again', ingest(once.ledger, mt5).added, 0);
}

// The same deal number twice in one file is one deposit.
{
  const rows = [{ ...mt5[0], ref: '1000' }, { ...mt5[0], ref: '1000' }];
  const r = ingest([], rows);
  eq('a deal number repeated in one file is stored once', r.added, 1);
  eq('...and the repeat is reported as such', r.counts.fileDup, 1);
}

// ---------- different keys, same money ----------
// Copied from the old list by the migration, then the same report imported again — now
// with deal numbers the old import did not keep. Different keys; must still be one entry.
{
  const legacy = fromLegacy([{ id: 'old-1', broker: 'mt5', type: 'deposit', amount: 1000, ts: '2026-09-10T08:00:00.000Z', note: 'Deposit', source: 'csv' }]);
  eq('a migrated entry is keyed by its old id', legacy[0].key, 'legacy:old-1');
  const r = ingest(legacy, [{ ...mt5[0], ref: '1000' }]);
  eq('the same deposit under a new key is recognised by its content', r.counts.stored, 1);
  eq('...and not added', r.added, 0);
  eq('...and names the entry it matched, so the trader can see why', classifyCash([{ ...mt5[0], ref: '1000', key: 'deal:1000' }], legacy).rows[0].match.key, 'legacy:old-1');
}

// Typed by hand at noon on the day; the statement has it at 09:00. Not identical, so not
// decided — put to the trader.
{
  const typed = addToLedger([], [{ broker: 'orient', type: 'deposit', amount: 25000, ts: '2026-10-01T12:00:00.000Z', source: 'manual', key: 'manual:abc' }], id, now).ledger;
  const r = ingest(typed, statement, 'statement');
  eq('a statement deposit near one typed by hand is a possible match', r.counts.possible, 1);
  eq('...which is not added automatically', accepted(r.ledger).filter((c) => c.type === 'deposit').length, 1);
  const { rows } = classifyCash([{ ...statement[0], key: 'deal:ORI-DEP-0001' }], typed);
  eq('...and names the entry it resembles', rows[0].match.key, 'manual:abc');
}

// The edges of "close".
{
  const typed = [{ id: 'm1', broker: 'orient', type: 'deposit', amount: 25000, ts: '2026-10-01T12:00:00.000Z', key: 'manual:m1', status: 'accepted' }];
  const at = (days) => new Date(Date.parse('2026-10-01T12:00:00.000Z') + days * 864e5).toISOString();
  const status = (c) => classifyCash([{ ...c, key: 'x' }], typed).rows[0].status;
  eq(`${NEAR_DAYS} days apart is still worth asking about`, status({ broker: 'orient', type: 'deposit', amount: 25000, ts: at(NEAR_DAYS) }), 'possible');
  eq('a day further is a separate deposit', status({ broker: 'orient', type: 'deposit', amount: 25000, ts: at(NEAR_DAYS + 1) }), 'new');
  eq('a different account is never a match', status({ broker: 'mt5', type: 'deposit', amount: 25000, ts: at(0) }), 'new');
  eq('a withdrawal never matches a deposit', status({ broker: 'orient', type: 'withdrawal', amount: 25000, ts: at(0) }), 'new');
  eq('a cent apart is a different amount', status({ broker: 'orient', type: 'deposit', amount: 25000.01, ts: at(0) }), 'new');
  eq('the same amount written differently is the same amount', status({ broker: 'orient', type: 'deposit', amount: '25000.00', ts: '2026-10-01T12:00:30.000Z' }), 'stored');
}

// One hand-typed entry can explain one incoming deposit, not two.
{
  const typed = [{ id: 'm1', broker: 'orient', type: 'deposit', amount: 500, ts: '2026-10-01T12:00:00.000Z', key: 'manual:m1', status: 'accepted' }];
  const two = [
    { broker: 'orient', type: 'deposit', amount: 500, ts: '2026-10-01T09:00:00.000Z', key: 'a' },
    { broker: 'orient', type: 'deposit', amount: 500, ts: '2026-10-02T09:00:00.000Z', key: 'b' },
  ];
  eq('one entry matches at most one incoming deposit', classifyCash(two, typed).rows.map((r) => r.status), ['possible', 'new']);
}

// Turned down once, not offered again.
{
  const r1 = ingest([], [statement[1]], 'statement');
  const rejected = r1.ledger.map((c) => ({ ...c, status: 'rejected' }));
  const r2 = ingest(rejected, [statement[1]], 'statement');
  eq('a rejected entry is not offered again on the next upload', r2.added, 0);
  eq('...and does not count toward equity', accepted(r2.ledger).length, 0);
}

// ---------- the hard rule, without the sorting in front of it ----------
// classifyCash is the courtesy; the key is the guarantee. Bypassing the first must not
// get past the second — the database's unique constraint, mirrored for browser storage.
{
  const e = { broker: 'orient', type: 'deposit', amount: 1, ts: '2026-10-01T00:00:00.000Z', key: 'deal:X' };
  const a = addToLedger([], [e, e], id, now);
  eq('the same key twice in one write is stored once', a.added, 1);
  eq('...and again on a second write', addToLedger(a.ledger, [e], id, now).added, 0);
  eq('the same key on a different account is a different entry', addToLedger(a.ledger, [{ ...e, broker: 'mt5' }], id, now).added, 1);
}

// ---------- the migration's copy ----------
{
  const old = [
    { id: 'a1', broker: 'orient', type: 'deposit', amount: 50000, ts: '2026-09-10T12:00:00.000Z', note: 'wire', source: 'manual' },
    { id: 'a3', broker: 'orient', type: 'charge', amount: '110', ts: '2026-08-01T12:00:00.000Z', category: 'Market data', recurring: 'monthly', endTs: '2026-09-15T08:00:00.000Z', source: 'manual' },
  ];
  const first = addToLedger([], fromLegacy(old), id, now);
  eq('copying the old list twice still copies each entry once', addToLedger(first.ledger, fromLegacy(old), id, now).added, 0);
  const total = (l) => l.reduce((a, c) => a + +c.amount, 0);
  eq('the copy keeps the count and the total to the cent', [first.ledger.length, total(first.ledger)], [old.length, 50110]);
  eq('a monthly charge keeps its schedule and stop date', [first.ledger[1].recurring, first.ledger[1].endTs, first.ledger[1].category], ['monthly', '2026-09-15T08:00:00.000Z', 'Market data']);
  eq('a missing list is an empty ledger, not an error', fromLegacy(undefined), []);
  eq('a broken list is an empty ledger, not an error', fromLegacy('not a list'), []);
}

// ---------- the database row ----------
{
  const c = { id: 'u1', broker: 'orient', type: 'charge', amount: 110, ts: '2026-08-01T12:00:00.000Z', note: '', source: 'manual',
    key: 'manual:u1', status: 'accepted', created_at: now(), category: 'Market data', recurring: 'monthly', endTs: '2026-09-15T08:00:00.000Z' };
  const row = { ...toRow(c), id: c.id, created_at: c.created_at, amount: '110' };   // Postgres numeric arrives as text
  eq('an entry survives the trip to the database and back', fromRow(row), c);
  eq('the key is what the unique constraint sees', toRow(c).source_key, 'manual:u1');
}

eq('equity counts accepted entries, and old entries with no status are accepted',
   accepted([{ status: 'accepted' }, { status: 'proposed' }, { status: 'rejected' }, {}]).length, 2);
eq('content key: account, type, cents, minute', contentKey({ broker: 'o', type: 'deposit', amount: 12.345, ts: '2026-10-01T09:00:59.999Z' }), 'o|deposit|1235|2026-10-01T09:00');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
