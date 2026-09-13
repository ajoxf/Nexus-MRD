import { sanitiseMapping, FIELDS } from '../src/lib/csv.js';

/*
 * The guard between a suggested column mapping and somebody's margin figures.
 *
 * A schema-validated answer is well formed, not true. Everything here is a way the answer
 * can be well formed and wrong, and every one of them ends with a wrong number on a screen
 * a trader is making decisions from — so each is refused by name.
 */
let pass = 0, fail = 0;
const ok = (label) => { pass++; console.log('ok  ', label); };
const bad = (label, got) => { fail++; console.log('FAIL', label, '->', JSON.stringify(got)); };
const is = (label, got, want) => (JSON.stringify(got) === JSON.stringify(want) ? ok(label) : bad(`${label} (wanted ${JSON.stringify(want)})`, got));

const HEADERS = ['Date', 'Symbol', 'Side', 'Lots', 'Price', 'Commission', 'Deal'];

// --- the ordinary case ---
const good = sanitiseMapping({
  date: 'Date', product: 'Symbol', side: 'Side', qty: 'Lots', price: 'Price', fee: 'Commission', ref: 'Deal',
  dateFormat: 'DMY', confidence: 'high',
}, HEADERS);
is('a clean mapping survives intact', good.map,
  { date: 'Date', product: 'Symbol', side: 'Side', qty: 'Lots', price: 'Price', ref: 'Deal', fee: 'Commission' });
is('date format is carried through', good.dateFormat, 'DMY');
is('nothing dropped', good.dropped.length, 0);

// --- a header that is not in the file ---
const ghost = sanitiseMapping({ date: 'Date', product: 'Symbol', qty: 'Lots', price: 'Fill Price' }, HEADERS);
is('an invented column is refused', ghost.map.price, undefined);
is('and the rest is kept', ghost.map.qty, 'Lots');
is('and the drop is reported', ghost.dropped.length, 1);
is('with the reason', ghost.dropped[0].why, 'absent');

// --- one column claimed twice ---
const twice = sanitiseMapping({ date: 'Date', qty: 'Price', price: 'Price', product: 'Symbol' }, HEADERS);
is('a column cannot fill two fields', Object.values(twice.map).filter((h) => h === 'Price').length, 1);
is('the earlier field keeps it', twice.map.qty, 'Price');
is('and the later one is dropped', twice.map.price, undefined);
is('reported as taken', twice.dropped[0].why, 'taken');

// --- rubbish in ---
is('null proposal yields an empty map', sanitiseMapping(null, HEADERS).map, {});
is('undefined headers yield an empty map', sanitiseMapping({ price: 'Price' }, undefined).map, {});
is('a non-string header is ignored', sanitiseMapping({ price: 42, qty: 'Lots' }, HEADERS).map, { qty: 'Lots' });
is('an empty string is ignored', sanitiseMapping({ price: '', qty: 'Lots' }, HEADERS).map, { qty: 'Lots' });

// --- the date format is never invented ---
is('an unknown date format falls back to auto', sanitiseMapping({ dateFormat: 'YMD' }, HEADERS).dateFormat, 'auto');
is('a missing date format falls back to auto', sanitiseMapping({}, HEADERS).dateFormat, 'auto');
is('an unknown confidence reads as low', sanitiseMapping({ confidence: 'certain' }, HEADERS).confidence, 'low');

// --- no field outside the known set can be smuggled in ---
const extra = sanitiseMapping({ qty: 'Lots', evil: 'Price', __proto__: 'Price' }, HEADERS);
is('an unknown field key is not carried through', Object.keys(extra.map), ['qty']);
is('every key that survives is a known field', Object.keys(extra.map).every((k) => FIELDS.some((f) => f.key === k)), true);

// --- case and whitespace are NOT normalised away ---
// Deliberate: rowsToFills looks the header up verbatim, so a mapping that differs by a
// space would read an empty column and silently import nothing for that field.
is('a header differing by case is refused', sanitiseMapping({ price: 'price' }, HEADERS).map.price, undefined);
is('a header differing by a space is refused', sanitiseMapping({ price: ' Price' }, HEADERS).map.price, undefined);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
