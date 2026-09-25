import { parseExpiry, daysUntil, expiryState, formatExpiry, expiringRows, contractExpiry } from '../src/lib/expiry.js';

/*
 * Expiry dates, and the two ways a date feature goes wrong: it accepts something that is not a
 * date, or it moves by a day because of a clock. Both put the wrong deadline in front of a
 * trader deciding whether to roll today.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got) => { fail++; console.log('FAIL', l, '->', JSON.stringify(got)); };
const is = (l, got, want) => (String(got) === String(want) ? ok(l) : bad(`${l} (wanted ${want})`, got));

const TODAY = new Date(2026, 8, 24);   // 24 September 2026, local

// --- counting days ------------------------------------------------------------------------------
is('a month out', daysUntil('2026-10-20', TODAY), 26);
is('today is zero', daysUntil('2026-09-24', TODAY), 0);
is('tomorrow is one', daysUntil('2026-09-25', TODAY), 1);
is('yesterday is minus one', daysUntil('2026-09-23', TODAY), -1);
is('across a month end', daysUntil('2026-10-01', TODAY), 7);
is('across a year end', daysUntil('2027-01-01', TODAY), 99);

// --- what it refuses ----------------------------------------------------------------------------
for (const v of ['', null, undefined, 'rubbish', '2026-9-4', '20/10/2026', '2026-13-01', '2026-02-31', '2026-00-10'])
  is(`${JSON.stringify(v)} is not a date`, parseExpiry(v), null);
is('a leap day in a leap year is fine', JSON.stringify(parseExpiry('2028-02-29')), '{"y":2028,"m":1,"d":29}');
is('and is not in a common year', parseExpiry('2026-02-29'), null);

/*
 * The one that matters most. An earlier defect in this app moved trades a day because a time was
 * read in the wrong frame; an expiry must not repeat it. "Expires on the 20th" is true all day on
 * the 20th, in Houston and in Singapore, whatever the hour.
 */
const sameEverywhere = [];
for (const h of [0, 1, 6, 12, 18, 23]) {
  const at = new Date(2026, 8, 24, h, 30);
  sameEverywhere.push(daysUntil('2026-10-20', at));
}
is('the count does not move with the hour of the day', new Set(sameEverywhere).size, 1);
// Across a daylight-saving change, where a naive 86,400,000ms subtraction slips an hour.
is('nor across a daylight-saving boundary', daysUntil('2026-11-05', new Date(2026, 9, 25, 12)), 11);

// --- how loud ------------------------------------------------------------------------------------
const lvl = (v) => expiryState(v, TODAY, 7).level;
is('far out is quiet', lvl('2026-12-01'), 'ok');
is('inside the roll window warns', lvl('2026-09-30'), 'warn');
is('the last day is red', lvl('2026-09-24'), 'bad');
is('past is red', lvl('2026-09-20'), 'bad');
is('the edge of the window warns', lvl('2026-10-01'), 'warn');
is('one day beyond it does not', lvl('2026-10-02'), 'ok');
is('an unset expiry has no state at all', expiryState('', TODAY), null);

is('it reads like a date a trader would write', formatExpiry('2026-10-20'), '20 Oct 26');
is('an unset one prints nothing', formatExpiry(''), '');
is('today reads "today"', expiryState('2026-09-24', TODAY).label, 'today');
is('tomorrow reads "tomorrow"', expiryState('2026-09-25', TODAY).label, 'tomorrow');
is('yesterday reads "1 day ago"', expiryState('2026-09-23', TODAY).label, '1 day ago');

// --- which rows the dashboard shouts about --------------------------------------------------------
const rows = [
  { product: 'CL Oct26', spec: { expiry: '2026-09-22' } },   // gone
  { product: 'CL Nov26', spec: { expiry: '2026-10-20' } },   // far
  { product: 'BZ Nov26', spec: { expiry: '2026-09-29' } },   // due
  { product: 'HO Oct26', spec: { expiry: '2026-09-25' } },   // due, sooner
  { product: 'CL Jan27', spec: {} },                         // unknown
];
const due = expiringRows(rows, TODAY, 7);
is('only the ones in the window', due.map((x) => x.row.product).join(), 'CL Oct26,HO Oct26,BZ Nov26');
is('nearest first, expired at the top', due[0].row.product, 'CL Oct26');
/*
 * A position with no expiry recorded is UNKNOWN, not safe. It is left out of the warnings rather
 * than reported as fine — silence about a missing date is better than a false all-clear.
 */
is('a product with no expiry is not called safe, it is left out', due.some((x) => x.row.product === 'CL Jan27'), false);

/*
 * A spread has two legs and two last trading days, and it stops being a spread when the NEARER
 * one goes. Which box the date was typed into says nothing about which leg is nearer — somebody
 * filling in a crack has no reason to know — so the earlier of the two always wins.
 */
const near = (spec) => contractExpiry(spec)?.near ?? null;
is('one date is an outright', JSON.stringify(contractExpiry({ expiry: '2026-10-20' })),
   JSON.stringify({ near: '2026-10-20', far: null, both: ['2026-10-20'] }));
is('two dates in order: the first governs', near({ expiry: '2026-10-20', expiry2: '2026-12-31' }), '2026-10-20');
is('two dates out of order: the earlier still governs', near({ expiry: '2026-12-31', expiry2: '2026-10-20' }), '2026-10-20');
is('the far leg is reported too', contractExpiry({ expiry: '2026-12-31', expiry2: '2026-10-20' }).far, '2026-12-31');
is('only a second leg filled in still works', near({ expiry2: '2026-11-30' }), '2026-11-30');
is('a junk first leg does not shadow a real second', near({ expiry: 'rubbish', expiry2: '2026-11-30' }), '2026-11-30');
is('two identical dates report no far leg', contractExpiry({ expiry: '2026-10-20', expiry2: '2026-10-20' }).far, '2026-10-20');
is('no dates at all is nothing, not today', contractExpiry({}), null);
is('no spec at all is nothing', contractExpiry(undefined), null);

// A calendar spread whose far leg is months out is still due when the front month goes.
const CAL = { product: 'CL Nov26-Jan27 Calendar', spec: { expiry: '2026-12-21', expiry2: '2026-09-29' } };
const OUTRIGHT = { product: 'CL Jan27', spec: { expiry: '2026-12-21' } };
const dueSpread = expiringRows([CAL, OUTRIGHT], TODAY, 7);
is('the spread is due on its front leg', dueSpread.map((x) => x.row.product).join(), 'CL Nov26-Jan27 Calendar');
is('and the state is read off the near leg', dueSpread[0].state.days, 5);
is('the far leg rides along for display', dueSpread[0].contract.far, '2026-12-21');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
