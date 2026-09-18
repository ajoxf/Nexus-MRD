import { parseDate, tableFromRows, guessMapping, rowsToFills } from '../src/lib/csv.js';

/*
 * Timestamps, and the one way they go wrong silently.
 *
 * A fill's time decides which day it lands on and where it sits in the queue FIFO matches from.
 * Get it wrong and nothing errors: the P&L simply comes out different. The specific trap is that
 * new Date(2026, 7, 17, 41, 28) is not an error in JavaScript - it rolls 41 hours forward and
 * quietly returns 18 August. Excel produces exactly that input, by reformatting TT's
 * "17:41:28.936" as "41:28.9" when an export is opened and saved. So a damaged column has to be
 * refused, loudly, rather than parsed into a plausible-looking wrong answer.
 */
let pass = 0, fail = 0;
const ok = (label) => { pass++; console.log('ok  ', label); };
const bad = (label, got) => { fail++; console.log('FAIL', label, '->', JSON.stringify(got)); };
const is = (label, got, want) => (String(got) === String(want) ? ok(label) : bad(`${label} (wanted ${want})`, got));

const day = (d) => (d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : 'REJECTED');

// --- formats that must keep working ---
is('TT native',            day(parseDate('11Sep26', '11:56:49.536')), '2026-09-11 11:56');
is('Excel month name',     day(parseDate('11-Sep-26', '20:24.8')),    '2026-09-11 20:24');
is('spaced month name',    day(parseDate('11 Sep 2026', '09:05')),    '2026-09-11 09:05');
is('MT5 year first',       day(parseDate('2026.09.11', '03:29:55')),  '2026-09-11 03:29');
is('12-hour clock',        day(parseDate('9/11/26', '1:05:00 pm')),   '2026-09-11 13:05');
is('midnight',             day(parseDate('11Sep26', '00:00:00')),     '2026-09-11 00:00');
is('last minute of a day', day(parseDate('11Sep26', '23:59:59')),     '2026-09-11 23:59');
is('date with no time',    day(parseDate('11Sep26', '')),             '2026-09-11 00:00');

// --- an impossible clock is refused, never rolled into the next day ---
is('hour 41 refused',      day(parseDate('17-Aug-26', '41:28.9')),    'REJECTED');
is('hour 56 refused',      day(parseDate('11-Sep-26', '56:49.5')),    'REJECTED');
is('hour 26 refused',      day(parseDate('18-Aug-26', '26:48.9')),    'REJECTED');
is('hour 24 refused',      day(parseDate('11Sep26', '24:00:00')),     'REJECTED');
is('minute 61 refused',    day(parseDate('2026.09.11', '10:61:00')),  'REJECTED');
is('second 61 refused',    day(parseDate('9/11/26', '10:30:61')),     'REJECTED');

// --- a TT fills grid re-saved by Excel: read the file, then refuse it with a reason ---
const ROWS = [
  ['11-Sep-26', '56:49.5', 'CME', 'BZ Nov26',  'S', '1', '104.01', 'F', 'Direct', '1003050011-GHF', 'U', 'U', 'ord-1', ''],
  ['11-Sep-26', '43:16.3', 'CME', 'CL Oct26',  'S', '1', '99.42',  'F', 'Direct', '1003050011-GHF', 'U', 'U', 'ord-2', ''],
  ['11-Sep-26', '20:24.8', 'CME', 'HO Oct26',  'B', '1', '5.0345', 'F', 'Direct', '1003050011-GHF', 'U', 'U', 'ord-3', ''],
];
const table = tableFromRows(ROWS);
is('hyphenated dates still read as a TT fills grid', table.headers[0] + '/' + table.rows.length, 'Date/3');
const map = guessMapping(table.headers);
const out = rowsToFills(table.rows, map, {});
is('nothing is imported from a file with no hours', out.fills.length, 0);
ok(/lost its hour/.test(out.errors[0] || '') ? 'the error says what is wrong and how to fix it' : bad('error message', out.errors));

// The third row above has an in-range "hour", so it would have parsed. It is still wrong - 20:24.8
// is minutes and seconds - which is why the whole file goes, not just the rows that overflow.
is('a plausible row in a damaged file is not kept', out.fills.length, 0);

// --- a clean TT export of the same shape imports normally ---
const CLEAN = ROWS.map((r, i) => [r[0], ['17:56:49.536', '14:43:16.300', '09:20:24.800'][i], ...r.slice(2)]);
const clean = rowsToFills(tableFromRows(CLEAN).rows, guessMapping(tableFromRows(CLEAN).headers), {});
is('a clean export of the same layout imports', clean.fills.length, 3);
is('and keeps its times', new Date(clean.fills[0].ts).getHours() + ':' + new Date(clean.fills[0].ts).getMinutes(), '17:56');

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
