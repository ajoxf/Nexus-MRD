import { readFileSync } from 'node:fs';
import { tableFromRows, guessMapping, mappingFor, rowsToFills } from '../src/lib/csv.js';
import { computeBook } from '../src/lib/positions.js';

/*
 * A real MT5 hedging report, and the broker's own figures to check ours against.
 *
 * A hedging account does not net: each position is its own ticket with its own entry, and the
 * broker matches a close against THAT ticket. Match it against a running average or the oldest
 * lot instead and the P&L is not slightly off, it is a different number with a different sign —
 * on this very report, +$155.58 where the statement says -$0.04.
 *
 * The fixture is the report as the importer receives it, with the account holder's name
 * replaced. Every expected figure below is copied from the report's own Positions table, which
 * is what the customer sees in their terminal and what they will hold us to.
 */
const sheets = JSON.parse(readFileSync(new URL('./fixtures/mt5-hedge-report.json', import.meta.url), 'utf8'));

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got, want) => { fail++; console.log('FAIL', l, `-> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
const is = (l, got, want) => (got === want ? ok(l) : bad(l, got, want));
const near = (l, got, want) => (Math.abs(got - want) < 0.005 ? ok(l) : bad(l, got, want));

// From the report's Positions section: ticket -> the broker's own profit for that round trip.
const EXPECTED = {
  'MT-100030':  { side: 'Long',  lots: 0.13, avg: 91.74962, tickets: { 3970: -0.47, 4020: 12.17, 4079: -6.09, 4095: -5.65 } },
  'MT5-100031': { side: 'Short', lots: 0.13, avg: 99.85408, tickets: { 3971: 2.32, 4021: -9.93, 4080: 9.22, 4096: 6.17 } },
};

for (const [acct, rows] of Object.entries(sheets)) {
  console.log(`\n-- ${acct} --`);
  const want = EXPECTED[acct];

  const t = tableFromRows(rows);
  is(`${acct}: recognised as an MT5 report`, t.layout, 'MT5 report · position tickets recovered');
  is(`${acct}: every trade deal got a position ticket`, t.mt5, 12);

  // The ticket column has to be picked up without the trader doing anything.
  const map = guessMapping(t.headers);
  is(`${acct}: Position column auto-mapped`, map.position, 'Position');

  const { fills } = rowsToFills(t.rows, map, { dateFormat: 'auto', defaultBroker: acct, resolveBroker: () => null, spreadMode: 'spread' });
  const book = computeBook(fills, () => 1000, () => 'average');

  // Open side: the lots still open, each still its own ticket, at the broker's own average.
  is(`${acct}: one product open`, book.open.length, 1);
  is(`${acct}: side`, book.open[0].side, want.side);
  near(`${acct}: lots open`, book.open[0].lots, want.lots);
  near(`${acct}: open average matches the broker`, book.open[0].avg, want.avg);
  is(`${acct}: open lots kept separate, not merged`, book.open[0].lotsOpen.length, 4);
  is(`${acct}: every open lot carries its ticket`, book.open[0].lotsOpen.every((l) => !!l.id), true);

  // Closed side: one round trip per ticket, each agreeing with the statement.
  is(`${acct}: closed trades found`, book.closed.length, 4);
  let total = 0;
  for (const [ticket, profit] of Object.entries(want.tickets)) {
    const c = book.closed.find((x) => String(x.ticket) === ticket);
    if (!c) { bad(`${acct}: ticket ${ticket} present`, undefined, ticket); continue; }
    near(`${acct}: ticket ${ticket} P&L matches the broker`, c.pnl, profit);
    total += profit;
  }
  near(`${acct}: realized total matches the statement`, book.closed.reduce((a, c) => a + c.pnl, 0), total);

  /*
   * The regression that started this: matched any other way, these same deals produce a
   * number with the wrong sign. If ticket matching ever silently stops, this catches it.
   */
  const blind = computeBook(fills.map(({ position, ...f }) => f), () => 1000, () => 'average');
  is(`${acct}: without tickets there are no closed trades at all`, blind.closed.length, 0);

  /*
   * And the way it actually reached a customer: not missing tickets, wrong ones.
   *
   * His broker carried a column layout saved before the app could read MT5 tickets, with
   * `position` pointed at the Comment column. Comment on this very report holds
   * "LADDER0004-130a" on an open and the word "CLOSE" on a close — so every close carried
   * the ticket "CLOSE", matched no open lot, and he saw 26 fills and not one round trip.
   * The saved layout survives a re-import, which is why shipping the ticket reader alone
   * changed nothing for him.
   */
  const stale = { ...guessMapping(t.headers), position: 'Comment' };
  const commentFills = rowsToFills(t.rows, stale, { dateFormat: 'auto', defaultBroker: acct, resolveBroker: () => null, spreadMode: 'spread' }).fills;
  is(`${acct}: a stale layout aimed at Comment closes nothing`, computeBook(commentFills, () => 1000, () => 'average').closed.length, 0);

  // What the fix does about it: the recovered column overrules the saved layout.
  const fixed = mappingFor(t.headers, stale, t.mt5);
  is(`${acct}: the recovered column overrules the stale layout`, fixed.map.position, 'Position');
  const repaired = rowsToFills(t.rows, fixed.map, { dateFormat: 'auto', defaultBroker: acct, resolveBroker: () => null, spreadMode: 'spread' }).fills;
  is(`${acct}: and the round trips come back`, computeBook(repaired, () => 1000, () => 'average').closed.length, 4);
}

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
