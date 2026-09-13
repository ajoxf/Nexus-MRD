import { accessState, hasAccess, canStartTrial, daysLeft } from '../src/lib/access.js';
let fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};
const now = new Date('2026-09-13T12:00:00Z');
const future = '2026-09-27T00:00:00Z';
const past = '2026-09-01T00:00:00Z';

eq('no row at all is no access', hasAccess(null, now), false);
eq('a brand new account holds nothing', accessState({ status: 'none' }, now), 'none');

eq('a running trial is in', accessState({ status: 'trialing', current_period_end: future }, now), 'trialing');
eq('a paid subscription is in', accessState({ status: 'active', current_period_end: future }, now), 'active');

// The expensive one.
eq('an open-ended grant does NOT read as expired',
   accessState({ status: 'active', current_period_end: null }, now), 'active');
eq('and it gets in', hasAccess({ status: 'active', current_period_end: null }, now), true);

eq('a trial past its date is over', accessState({ status: 'trialing', current_period_end: past }, now), 'trial_over');
eq('a subscription past its date has lapsed', accessState({ status: 'active', current_period_end: past }, now), 'lapsed');
eq('neither gets in',
   [hasAccess({ status: 'trialing', current_period_end: past }, now),
    hasAccess({ status: 'active', current_period_end: past }, now)], [false, false]);

eq('a failed payment is not a lock-out', hasAccess({ status: 'past_due', current_period_end: future }, now), true);
eq('but it is not a free pass past the date either',
   hasAccess({ status: 'past_due', current_period_end: past }, now), false);
eq('cancelled is out', hasAccess({ status: 'canceled', current_period_end: future }, now), false);
eq('an unknown status is out, not in', hasAccess({ status: 'wat', current_period_end: future }, now), false);

eq('the period ending exactly now is over',
   hasAccess({ status: 'active', current_period_end: '2026-09-13T12:00:00Z' }, now), false);

// One trial, ever.
eq('a fresh account may trial', canStartTrial({ status: 'none' }), true);
eq('no row at all may trial', canStartTrial(null), true);
eq('an expired trial may NOT trial again',
   canStartTrial({ status: 'canceled', trial_started_at: past }), false);
eq('somebody mid-trial is not offered another',
   canStartTrial({ status: 'trialing', trial_started_at: past }), false);
eq('a paying customer is not offered one', canStartTrial({ status: 'active' }), false);
eq('a lapsed payer may resubscribe but not trial',
   canStartTrial({ status: 'canceled', trial_started_at: past }), false);

eq('days left counts up, not down', daysLeft({ status: 'trialing', current_period_end: future }, now), 14);
eq('open-ended has no days left to show', daysLeft({ status: 'active', current_period_end: null }, now), null);
eq('nor does an account already out', daysLeft({ status: 'active', current_period_end: past }, now), null);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
