import { generateCode, normaliseCode, looksLikeCode, codeRefusal, periodEndAfterRedeeming } from '../src/lib/codes.js';
let fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};

const codes = Array.from({ length: 400 }, () => generateCode());
eq('every generated code is the right shape', codes.every(looksLikeCode), true);
eq('no confusable characters anywhere', /[01OIL]/.test(codes.join('')), false);
eq('400 codes, 400 distinct', new Set(codes).size, 400);

eq('lower case is still the code', normaliseCode('nxs-4kfp-9tqx'), 'NXS-4KFP-9TQX');
eq('spaces are not a wrong code', normaliseCode(' NXS 4KFP 9TQX '), 'NXS-4KFP-9TQX');
eq('missing dashes are not either', normaliseCode('NXS4KFP9TQX'), 'NXS-4KFP-9TQX');
eq('nor is leaving the prefix off', normaliseCode('4kfp9tqx'), 'NXS-4KFP-9TQX');
eq('nothing in, nothing out', normaliseCode(''), '');
eq('junk does not become a valid code', looksLikeCode(normaliseCode('hello there')), false);

const now = new Date('2026-09-13T12:00:00Z');
eq('an unknown code is refused', codeRefusal(null, now), 'not_found');
eq('a used code is refused', codeRefusal({ redeemed_at: '2026-09-01T00:00:00Z' }, now), 'already_redeemed');
eq('an expired code is refused', codeRefusal({ expires_at: '2026-09-01T00:00:00Z' }, now), 'expired');
eq('a live code is accepted', codeRefusal({ expires_at: '2026-10-01T00:00:00Z' }, now), null);
eq('a code with no expiry never expires', codeRefusal({ expires_at: null }, now), null);
eq('used beats expired: a used code reads as used', 
   codeRefusal({ redeemed_at: '2026-09-02T00:00:00Z', expires_at: '2026-09-01T00:00:00Z' }, now), 'already_redeemed');

eq('a fresh account gets the full period',
   periodEndAfterRedeeming(null, 365, now).toISOString(), '2027-09-13T12:00:00.000Z');
eq('days already held are ADDED to, never taken away',
   periodEndAfterRedeeming('2026-09-20T12:00:00Z', 365, now).toISOString(), '2027-09-20T12:00:00.000Z');
eq('an expired period does not shorten the grant',
   periodEndAfterRedeeming('2026-08-01T00:00:00Z', 30, now).toISOString(), '2026-10-13T12:00:00.000Z');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
