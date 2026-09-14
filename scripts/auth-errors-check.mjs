import { authErrorCopy } from '../src/lib/auth-errors.js';

/*
 * Every line somebody could be shown at the door.
 *
 * The bar for each: does it say whose fault it is, whether their account exists, and
 * whether doing the same thing again could work. A message failing any of those sends
 * somebody to sign up a second time, or to email asking which account is theirs.
 */
let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log('ok  ', l); };
const bad = (l, got) => { fail++; console.log('FAIL', l, '->', JSON.stringify(got)); };
const has = (l, msg, sub) => (authErrorCopy(msg).text.toLowerCase().includes(sub.toLowerCase()) ? ok(l) : bad(l, authErrorCopy(msg).text));
const is = (l, got, want) => (got === want ? ok(l) : bad(`${l} (wanted ${want})`, got));

// --- the one that actually happened ---
const smtp = authErrorCopy('Error sending confirmation email', 'up');
has('SMTP failure says the account was NOT created', 'Error sending confirmation email', 'has not been created');
is('SMTP failure is owned as ours', smtp.ours, true);
is('SMTP failure invites a retry', smtp.retry, true);
has('SMTP failure absolves the typist', 'Error sending confirmation email', 'not with anything you typed');

// The same fault wearing its other name — the built-in service refusing a non-team address.
is('"Email address not authorized" is the same fault', authErrorCopy('Email address not authorized').ours, true);
has('and gets the same reassurance', 'Email address not authorized', 'has not been created');
is('a recovery email failure is the same family', authErrorCopy('Error sending recovery email').ours, true);

// --- rate limits ---
is('an email rate limit is ours, not theirs', authErrorCopy('email rate limit exceeded').ours, true);
has('and says nothing is wrong with their details', 'email rate limit exceeded', 'nothing is wrong');
has('a timed lockout keeps the exact wait', 'For security purposes, you can only request this after 47 seconds', '47 seconds');

// --- their end ---
is('wrong password is not our fault', authErrorCopy('Invalid login credentials').ours, false);
has('and says so plainly', 'Invalid login credentials', "don't match");
has('an existing account points at signing in', 'User already registered', 'sign in instead');
is('an existing account does not invite a retry', authErrorCopy('User already registered').retry, false);
has('an unconfirmed account explains the link', 'Email not confirmed', 'needs confirming');
has('a short password states the real minimum', 'Password should be at least 8 characters', 'at least 8');
has('a malformed address is named as such', 'Unable to validate email address: invalid format', "doesn't look right");
has('closed signups give somebody to contact', 'Signups not allowed for this instance', 'team@fincoursa.com');

// --- the unknown ---
has('an unrecognised message is passed through, not swallowed', 'Kaboom at the gate', 'Kaboom at the gate');
is('an empty message still says something on sign-up', authErrorCopy('', 'up').text, "We couldn't create that account.");
is('an empty message still says something on sign-in', authErrorCopy('', 'in').text, "We couldn't sign you in.");
is('null does not throw', typeof authErrorCopy(null).text, 'string');
is('an Error object does not throw', typeof authErrorCopy(new Error('Error sending confirmation email').message).text, 'string');

console.log(fail ? `\n${fail} FAILED of ${pass + fail}` : `\nall ${pass} passed`);
process.exit(fail ? 1 : 0);
