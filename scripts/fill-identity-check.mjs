import { tableFromRows, guessMapping, rowsToFills, classifyFills } from '../src/lib/csv.js';
import { fromExecutionReport, planFeed } from '../src/lib/ttfeed.js';

/*
 * A fill must never be stored twice — and never lost.
 *
 * The same trade can reach the database by CSV upload, pasted rows, a feed, and a feed replayed
 * after a disconnect. Each route below goes through what the app really does: rowsToFills to read
 * a TT Fills export, classifyFills to compare with what is stored, then an insert that behaves like
 * the database's unique (user_id, broker, ref) with ignoreDuplicates.
 *
 * Times: a TT Fills export carries no time zone, so the importer reads it in the computer's own
 * zone. Imports here are run "on a computer in" London or Singapore by shifting how the clock
 * reading is turned into an instant, which is exactly what a different TZ setting does.
 */
let pass = 0, fail = 0;
const is = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) { pass++; console.log('ok  ', name); }
  else { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
};

// ---- a store that behaves like the fills table -------------------------------------------------
const store = () => {
  const rows = [];
  return {
    rows,
    // upsert(..., { onConflict: "user_id,broker,ref", ignoreDuplicates: true })
    insert(user, fills) {
      let added = 0;
      for (const f of fills) {
        if (rows.some((r) => r.user === user && r.broker === f.broker && r.ref === f.ref)) continue;
        rows.push({ ...f, user, id: `id${rows.length}` });
        added++;
      }
      return added;
    },
    mine(user) { return rows.filter((r) => r.user === user); },
    remove(user, refs) { for (const ref of refs) { const i = rows.findIndex((r) => r.user === user && r.ref === ref); if (i >= 0) rows.splice(i, 1); } },
  };
};

// ---- the CSV route, as the Fills tab runs it ---------------------------------------------------
// The clock reading in the file is the same everywhere; what changes is the zone it is read in.
const ZONE_HOURS = { London: 1, Singapore: 8 }; // September: BST is UTC+1, SGT is UTC+8
const readIn = (zone, fills) => {
  // rowsToFills read the clock in THIS process's zone; move each instant to the one the same
  // clock reading means in `zone`. Refs carry the instant too, so they move with it.
  return fills.map((f) => {
    const local = new Date(f.ts);
    const wall = Date.UTC(local.getFullYear(), local.getMonth(), local.getDate(), local.getHours(), local.getMinutes(), local.getSeconds(), local.getMilliseconds());
    const ms = wall - ZONE_HOURS[zone] * 3600e3;
    const parts = f.ref.split('|');
    if (/^\d{12,}$/.test(parts[4] ?? '')) parts[4] = String(ms);
    const ref = parts.join('|');
    return { ...f, ts: new Date(ms).toISOString(), ref };
  });
};
const csvFills = (lines, zone = 'London') => {
  const t = tableFromRows(lines.map((l) => l.split(',')));
  const p = rowsToFills(t.rows, guessMapping(t.headers), { defaultBroker: 'orient' });
  return readIn(zone, p.fills);
};
const importCsv = (db, user, lines, zone) => {
  const c = classifyFills(csvFills(lines, zone), db.mine(user));
  return db.insert(user, c.rows.filter((r) => r.status === 'new').map(({ key, status, matchTs, ...f }) => f));
};

// ---- the feed route ----------------------------------------------------------------------------
const feed = (db, user, msgs) => {
  const events = msgs.map((m) => fromExecutionReport(m, { broker: 'orient' }));
  const plan = planFeed(events, db.mine(user), classifyFills);
  db.remove(user, plan.remove);
  return db.insert(user, plan.add);
};
// An Execution Report for one fill. 55 carries RAMP's product name here; the real feed needs a
// translation from TT's instrument to that name (memo, section 4).
const er = (o) => ({ 35: '8', 150: 'F', 1: 'ACC', ...o });

const lots = (db, user) => db.mine(user).filter((r) => !r.is_leg).reduce((s, r) => s + (r.side === 'Buy' ? 1 : -1) * r.qty, 0);

// The same trade, as TT's Fills grid exports it (09:15:02.114 London = 08:15:02.114 UTC).
const ONE = ['10Sep26,09:15:02.114 ,CME,CL Nov26,S,1,97.78,F,Direct,ACC,T,T,ORD-1,,'];
const ONE_FIX = er({ 17: 'EX-1', 37: 'ORD-1', 55: 'CL Nov26', 54: '2', 32: '1', 14: '1', 31: '97.78', 60: '20260910-08:15:02.114' });

// 1. CSV and feed: the same trade by two routes ------------------------------------------------
{
  const db = store();
  importCsv(db, 'u1', ONE, 'London');
  feed(db, 'u1', [ONE_FIX]);
  is('1a  CSV, then feed: stored once', db.mine('u1').length, 1);
}
{
  const db = store();
  feed(db, 'u1', [ONE_FIX]);
  importCsv(db, 'u1', ONE, 'London');
  is('1b  feed, then CSV: stored once', db.mine('u1').length, 1);
}
{
  const db = store();
  importCsv(db, 'u1', ONE, 'Singapore'); // a laptop still set to Singapore time
  feed(db, 'u1', [ONE_FIX]);
  is('1c  CSV read in the wrong zone, then feed: stored once', db.mine('u1').length, 1);
}

// 2. One feed fill, three deliveries ------------------------------------------------------------
{
  const db = store();
  feed(db, 'u1', [ONE_FIX]);
  feed(db, 'u1', [{ ...ONE_FIX, 43: 'Y' }]);           // resend after a sequence gap (PossDupFlag)
  feed(db, 'u1', [ONE_FIX, { ...ONE_FIX, 43: 'Y' }]); // recovery replay, the resend inside it too
  is('2   live + resend + replay: stored once', db.mine('u1').length, 1);
}

// 3. Two genuine fills of one order, same price, same millisecond -------------------------------
const PARTIALS = [
  '10Sep26,09:15:02.114 ,CME,CL Nov26,S,1,97.78,P,Direct,ACC,T,T,ORD-2,,',
  '10Sep26,09:15:02.114 ,CME,CL Nov26,S,2,97.78,F,Direct,ACC,T,T,ORD-2,,',
];
{
  const db = store();
  importCsv(db, 'u1', PARTIALS, 'London');
  is('3a  partial fills: both stored', db.mine('u1').map((r) => r.qty).sort(), [1, 2]);
  is('3b  partial fills: position is -3', lots(db, 'u1'), -3);
  importCsv(db, 'u1', PARTIALS, 'London');
  is('3c  partial fills: re-import adds nothing', db.mine('u1').length, 2);
  importCsv(db, 'u1', [...PARTIALS].reverse(), 'London');
  is('3d  partial fills: same file in another order adds nothing', db.mine('u1').length, 2);
}
{
  // A book imported before the fix: the 2-lot fill was dropped and only the 1-lot one stored,
  // under the old ref. Re-importing the file must put back exactly the missing fill.
  const db = store();
  const t = tableFromRows(PARTIALS.map((l) => l.split(',')));
  const [first] = readIn('London', rowsToFills(t.rows, guessMapping(t.headers), { defaultBroker: 'orient' }).fills);
  db.insert('u1', [{ ...first, qty: 1, ref: first.ref.replace(/\|q[\d.]+$/, '') }]);
  importCsv(db, 'u1', [...PARTIALS].reverse(), 'London');
  is('3e  a fill dropped by an older import is put back, once', db.mine('u1').map((r) => r.qty).sort(), [1, 2]);
  importCsv(db, 'u1', PARTIALS, 'London');
  is('3f  …and stays put back on the next re-import', db.mine('u1').length, 2);
}

// 4. The same file from two computers in two time zones -----------------------------------------
{
  const db = store();
  importCsv(db, 'u1', ONE, 'London');
  importCsv(db, 'u1', ONE, 'Singapore');
  is('4a  London, then Singapore: stored once', db.mine('u1').length, 1);
  is('4b  …and the position is still -1', lots(db, 'u1'), -1);
}
{
  // The guard is narrow: a different fill of the same order an hour later is a different fill.
  const db = store();
  importCsv(db, 'u1', ONE, 'London');
  importCsv(db, 'u1', ['10Sep26,10:15:02.115 ,CME,CL Nov26,S,1,97.78,F,Direct,ACC,T,T,ORD-1,,'], 'London');
  is('4c  same order, same price, a real later fill: both stored', db.mine('u1').length, 2);
}

{
  // Exports timed only to the second can't tell a zone shift from a later fill on a quarter-hour:
  // two real fills, exactly 15 minutes apart, must both stay — with an order ID and without one.
  const withId = ['Date,Time,Symbol,Side,Qty,Price,Order ID', '2026-09-10,09:15:00,CL Nov26,Sell,1,97.78,ORD-9', '2026-09-10,09:30:00,CL Nov26,Sell,1,97.78,ORD-9'];
  const noId = ['Date,Time,Symbol,Side,Qty,Price', '2026-09-10,09:15:00,CL Nov26,Sell,1,97.78', '2026-09-10,09:30:00,CL Nov26,Sell,1,97.78'];
  for (const [name, lines] of [['with an order ID', withId], ['without an ID', noId]]) {
    const db = store();
    importCsv(db, 'u1', [lines[0], lines[1]], 'London');
    importCsv(db, 'u1', [lines[0], lines[2]], 'London');
    is(`4d  to-the-second fills 15 min apart, ${name}: both stored`, db.mine('u1').length, 2);
  }
}

// 5. A spread: the trade plus both legs, by both routes ------------------------------------------
const SPREAD = [
  '10Sep26,09:20:00.500 ,CME,CL Nov26,S,1,97.78,F,Direct,ACC,T,T,ORD-3,,',
  '10Sep26,09:20:00.500 ,CME,BZ Nov26,B,1,107.08,F,Direct,ACC,T,T,ORD-3,,',
  '10Sep26,09:20:00.500 ,CME,CL Nov26 - BZ Nov26 Inter-Product,S,1,-9.30,F,Direct,ACC,T,T,ORD-3,,',
];
const SPREAD_FIX = [
  er({ 17: 'EX-31', 37: 'ORD-3', 442: '2', 55: 'CL Nov26', 54: '2', 32: '1', 31: '97.78', 60: '20260910-08:20:00.500' }),
  er({ 17: 'EX-32', 37: 'ORD-3', 442: '2', 55: 'BZ Nov26', 54: '1', 32: '1', 31: '107.08', 60: '20260910-08:20:00.500' }),
  er({ 17: 'EX-33', 37: 'ORD-3', 442: '3', 55: 'CL Nov26 - BZ Nov26 Inter-Product', 54: '2', 32: '1', 31: '-9.30', 60: '20260910-08:20:00.500' }),
];
{
  const db = store();
  feed(db, 'u1', SPREAD_FIX);
  is('5a  spread by feed: three rows, one of them the trade', [db.mine('u1').length, db.mine('u1').filter((r) => !r.is_leg).map((r) => r.product)],
     [3, ['CL Nov26 - BZ Nov26 Inter-Product']]);
  importCsv(db, 'u1', SPREAD, 'London');
  is('5b  …then the same spread by CSV adds nothing', db.mine('u1').length, 3);
  is('5c  …and counts as one short spread', lots(db, 'u1'), -1);
}

// 6. Busts -------------------------------------------------------------------------------------
{
  const db = store();
  feed(db, 'u1', [ONE_FIX]);
  feed(db, 'u1', [er({ 150: 'H', 17: 'EX-1B', 19: 'EX-1' })]);
  is('6a  a bust removes the fill', db.mine('u1').length, 0);
}
{
  const db = store();
  feed(db, 'u1', [er({ 150: 'H', 17: 'EX-1B', 19: 'EX-1' }), ONE_FIX]); // replayed out of order
  is('6b  a bust ahead of its fill: nothing stored', db.mine('u1').length, 0);
}
{
  const db = store();
  feed(db, 'u1', [ONE_FIX]);
  feed(db, 'u1', [er({ ...ONE_FIX, 150: 'G', 17: 'EX-1C', 19: 'EX-1', 31: '97.80' })]);
  is('6c  a correction replaces the fill', db.mine('u1').map((r) => [r.ref, r.price]), [['tt:EX-1C', 97.8]]);
}

// 7. The fill's own quantity, never the order's running total -----------------------------------
is('7   LastQty, not CumQty', fromExecutionReport(er({ ...ONE_FIX, 32: '1', 14: '3' }), { broker: 'orient' }).fill.qty, 1);

// 8. Rows identical in every field inside one file -------------------------------------------------
{
  /*
   * Unchanged behaviour, on purpose: two rows identical in EVERY field (order, contract, side,
   * price, quantity, millisecond) are treated as one fill shown twice. Whether TT ever exports two
   * genuine same-quantity fills like that is an open question (memo, Y4); if it does, this is the
   * line to change.
   */
  const db = store();
  importCsv(db, 'u1', [ONE[0], ONE[0]], 'London');
  is('8   identical rows in one file: stored once (pending Y4)', db.mine('u1').length, 1);
}

// 9. One trader's fills never satisfy another's ---------------------------------------------------
{
  const db = store();
  importCsv(db, 'u1', ONE, 'London');
  importCsv(db, 'u2', ONE, 'London');
  is('9   the same file for two users: one row each', [db.mine('u1').length, db.mine('u2').length], [1, 1]);
}

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
