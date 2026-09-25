import { applyOrder, moveTo, moveBy, isCustomised } from '../src/lib/layout.js';

/*
 * Panel order, and the thing that actually breaks it: the set of panels changing underneath a
 * saved layout. A panel added in a release, or one that only exists on the hosted build, must
 * not be able to blank a panel or leave a hole.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got) => { fail++; console.log('FAIL', l, '->', JSON.stringify(got)); };
const is = (l, got, want) => (String(got) === String(want) ? ok(l) : bad(`${l} (wanted ${want})`, got));

const IDS = ['limits', 'reset', 'close', 'version'];

// --- reconciling a saved order ------------------------------------------------------------------
is('nothing saved keeps the natural order', applyOrder(IDS, null).join(), 'limits,reset,close,version');
is('an empty list too', applyOrder(IDS, []).join(), 'limits,reset,close,version');
is('rubbish too', applyOrder(IDS, 'nonsense').join(), 'limits,reset,close,version');
is('a full saved order is honoured', applyOrder(IDS, ['version', 'close', 'reset', 'limits']).join(), 'version,close,reset,limits');
is('a panel that no longer exists is dropped', applyOrder(IDS, ['version', 'gone', 'limits']).join(), 'version,limits,reset,close');
is('a panel added since is appended, never lost', applyOrder([...IDS, 'brandnew'], ['version', 'close', 'reset', 'limits']).join(),
   'version,close,reset,limits,brandnew');
is('a duplicate in storage appears once', applyOrder(IDS, ['reset', 'reset', 'limits']).join(), 'reset,limits,close,version');
is('every panel is present exactly once, whatever was saved', new Set(applyOrder(IDS, ['reset', 'gone', 'reset'])).size, 4);
/*
 * The hosted build has a Close account panel and the browser-storage build does not. A layout
 * saved on one must not misbehave on the other.
 */
is('a layout saved with an extra panel works without it', applyOrder(['limits', 'reset', 'version'], ['close', 'version', 'limits', 'reset']).join(),
   'version,limits,reset');

// --- moving --------------------------------------------------------------------------------------
is('to the front', moveTo(IDS, 'version', 0).join(), 'version,limits,reset,close');
is('to the back', moveTo(IDS, 'limits', 3).join(), 'reset,close,version,limits');
is('into the middle', moveTo(IDS, 'version', 1).join(), 'limits,version,reset,close');
is('onto itself changes nothing', moveTo(IDS, 'reset', 1).join(), 'limits,reset,close,version');
is('past the end clamps', moveTo(IDS, 'limits', 99).join(), 'reset,close,version,limits');
is('before the start clamps', moveTo(IDS, 'version', -5).join(), 'version,limits,reset,close');
is('an unknown id is left alone', moveTo(IDS, 'ghost', 0).join(), 'limits,reset,close,version');

is('one step left', moveBy(IDS, 'close', -1).join(), 'limits,close,reset,version');
is('one step right', moveBy(IDS, 'reset', 1).join(), 'limits,close,reset,version');
/*
 * Stopping at the ends rather than wrapping. A panel that leapt from last place to first when
 * nudged once more would read as a bug, not a feature.
 */
is('left from the first does nothing', moveBy(IDS, 'limits', -1).join(), 'limits,reset,close,version');
is('right from the last does nothing', moveBy(IDS, 'version', 1).join(), 'limits,reset,close,version');

// --- is it worth offering a reset? ---------------------------------------------------------------
is('nothing saved is not a customisation', isCustomised(IDS, null), false);
is('an order equal to the natural one is not either', isCustomised(IDS, [...IDS]), false);
is('a real rearrangement is', isCustomised(IDS, ['version', ...IDS.slice(0, 3)]), true);
is('a saved order missing a panel is not, once reconciled', isCustomised(IDS, ['limits', 'reset']), false);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
