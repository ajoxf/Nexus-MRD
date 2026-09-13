import { statusFromStripe, rowFromStripe, fromStripeTime, HANDLED_EVENTS } from '../src/lib/billing.js';
import { hasAccess } from '../src/lib/access.js';
let fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};

eq('active is active', statusFromStripe('active'), 'active');
eq('a Stripe-side trial is a trial', statusFromStripe('trialing'), 'trialing');
eq('canceled is canceled', statusFromStripe('canceled'), 'canceled');

// The one with a customer on the other end of it.
eq('a failed renewal is past_due, not cancelled', statusFromStripe('past_due'), 'past_due');
const future = Math.floor(new Date('2026-10-13T00:00:00Z').getTime() / 1000);
eq('and past_due KEEPS ACCESS while Stripe retries',
   hasAccess({ status: 'past_due', current_period_end: new Date(future * 1000).toISOString() },
             new Date('2026-09-13T12:00:00Z')), true);
eq('but unpaid — retries exhausted — does not', statusFromStripe('unpaid'), 'canceled');

// Never had it vs had it and lost it. Only one of those may be offered a trial.
eq('an incomplete first payment is nothing, not cancelled', statusFromStripe('incomplete'), 'none');
eq('and an expired one too', statusFromStripe('incomplete_expired'), 'none');
eq('a paused subscription stops access', statusFromStripe('paused'), 'canceled');

eq('a status Stripe invents later fails CLOSED, not open', statusFromStripe('some_new_thing'), 'none');
eq('so does a missing one', statusFromStripe(undefined), 'none');

eq('seconds become a date', fromStripeTime(future).toISOString(), '2026-10-13T00:00:00.000Z');
eq('a missing time is null, not 1970', fromStripeTime(undefined), null);
eq('and so is nonsense', fromStripeTime('soon'), null);

eq('a live subscription maps whole', rowFromStripe({
  id: 'sub_1', customer: 'cus_1', status: 'active',
  current_period_end: future, cancel_at_period_end: false,
}), {
  status: 'active', current_period_end: '2026-10-13T00:00:00.000Z', cancel_at_period_end: false,
  provider: 'stripe', provider_customer_id: 'cus_1', provider_subscription_id: 'sub_1',
});

eq('cancel-at-period-end is carried, not collapsed into cancelled',
   rowFromStripe({ id: 's', customer: 'c', status: 'active', current_period_end: future, cancel_at_period_end: true }),
   { status: 'active', current_period_end: '2026-10-13T00:00:00.000Z', cancel_at_period_end: true,
     provider: 'stripe', provider_customer_id: 'c', provider_subscription_id: 's' });

eq('a subscription Stripe cannot date is left open-ended, not cut off today',
   rowFromStripe({ id: 's', customer: 'c', status: 'active' }).current_period_end, null);

eq('an expanded customer object is not stored as an id',
   rowFromStripe({ id: 's', customer: { id: 'c' }, status: 'active' }).provider_customer_id, null);

eq('the events we act on', [...HANDLED_EVENTS].sort(), [
  'checkout.session.completed', 'customer.subscription.created', 'customer.subscription.deleted',
  'customer.subscription.updated', 'invoice.payment_failed', 'invoice.payment_succeeded',
]);
eq('and noise is not one of them', HANDLED_EVENTS.has('charge.succeeded'), false);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
