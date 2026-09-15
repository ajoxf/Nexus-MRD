import { cregisSign, signaturesMatch, cregisNonce, unwrapCallbackOrder, isPaidStatus, isUnderpaid, CHECKOUT_VALID_MINUTES } from '../api/_cregis.js';
import { createHash } from 'node:crypto';

/*
 * The crypto payment protocol, checked on plain Node with no keys and no network.
 *
 * This is the code standing between a POST from the internet and a free subscription, so
 * every case below is one where being wrong costs money in one direction or the other:
 * a signature we compute differently rejects REAL payments silently, and one we do not
 * check at all lets anybody who finds the URL grant themselves access.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got, want) => { fail++; console.log('FAIL', l, `-> got ${JSON.stringify(got)}, wanted ${JSON.stringify(want)}`); };
const is = (l, got, want) => (got === want ? ok(l) : bad(l, got, want));

const KEY = 'test-api-key';

// --- the signature, worked by hand ---
// Sorted non-empty pairs: a1 b2 -> "a1b2"; prefixed with the key; MD5 of the lot.
const byHand = createHash('md5').update(`${KEY}a1b2`, 'utf8').digest('hex');
is('signs key + sorted key/value pairs', cregisSign({ b: 2, a: 1 }, KEY), byHand);
is('key order does not matter', cregisSign({ a: 1, b: 2 }, KEY), cregisSign({ b: 2, a: 1 }, KEY));
is('sign itself is excluded', cregisSign({ a: 1, b: 2, sign: 'whatever' }, KEY), byHand);
is('empty values are excluded', cregisSign({ a: 1, b: 2, c: '', d: null, e: undefined }, KEY), byHand);
is('zero is NOT empty and is signed', cregisSign({ a: 0 }, KEY) !== cregisSign({}, KEY), true);
is('objects are signed as JSON',
  cregisSign({ a: { x: 1 } }, KEY),
  createHash('md5').update(`${KEY}a${JSON.stringify({ x: 1 })}`, 'utf8').digest('hex'));
is('a different key gives a different signature', cregisSign({ a: 1 }, 'other') !== cregisSign({ a: 1 }, KEY), true);
is('a changed value gives a different signature', cregisSign({ a: 2 }, KEY) !== cregisSign({ a: 1 }, KEY), true);

// --- comparison ---
is('identical signatures match', signaturesMatch('abc123', 'abc123'), true);
is('different signatures do not', signaturesMatch('abc123', 'abc124'), false);
is('a shorter string does not match', signaturesMatch('abc123', 'abc12'), false);
is('a longer string does not match', signaturesMatch('abc123', 'abc1234'), false);
is('a non-string never matches', signaturesMatch('abc123', undefined), false);
is('null never matches', signaturesMatch('abc123', null), false);

// --- the nonce: six characters, not a timestamp ---
// A 13-digit epoch here is rejected by Cregis and fails every checkout with an error that
// does not mention the nonce.
is('nonce is six characters', cregisNonce().length, 6);
is('nonce is lowercase alphanumeric', /^[a-z0-9]{6}$/.test(cregisNonce()), true);
is('nonce is not a timestamp', /^\d{13}$/.test(cregisNonce()), false);
is('checkout window is inside the 10-1440 Cregis allows', CHECKOUT_VALID_MINUTES >= 10 && CHECKOUT_VALID_MINUTES <= 1440, true);

// --- unwrapping the callback ---
// Cregis nests the order under `data` and keeps sign/nonce on the envelope. Reading the
// envelope finds nothing, so no order matches and a buyer who paid is never let in.
const nested = { pid: 1, nonce: 'abc123', sign: 'x', data: { order_id: 'ord-1', status: 'paid', cregis_id: 'CG-9' } };
is('reads the order id from data', unwrapCallbackOrder(nested).orderId, 'ord-1');
is('reads the status from data', unwrapCallbackOrder(nested).status, 'paid');
is('reads the Cregis id from data', unwrapCallbackOrder(nested).cregisOrderId, 'CG-9');
const flat = { order_id: 'ord-2', status: 'PAID' };
is('falls back to a flat payload', unwrapCallbackOrder(flat).orderId, 'ord-2');
is('status is lowercased', unwrapCallbackOrder(flat).status, 'paid');
is('a payload with nothing in it does not throw', unwrapCallbackOrder({}).orderId, '');

// --- which statuses open the door ---
for (const s of ['paid', 'success', 'succeeded', 'completed', 'confirmed']) is(`"${s}" grants access`, isPaidStatus(s), true);
// An overpayment is a refund conversation, never a reason to withhold what was bought.
is('"paid_over" (overpayment) grants access', isPaidStatus('paid_over'), true);
is('case does not matter', isPaidStatus('PAID'), true);
// The one that must never open the door.
is('"paid_partial" (underpayment) does NOT grant access', isPaidStatus('paid_partial'), false);
is('"paid_partial" is reported as underpaid', isUnderpaid('paid_partial'), true);
for (const s of ['pending', 'cancelled', 'expired', '', 'anything']) is(`"${s}" does not grant access`, isPaidStatus(s), false);

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
