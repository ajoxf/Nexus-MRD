import { grantTrial, TRIAL_DAYS } from '../api/trial.js';

let fail = 0;
const eq = (name, got, want) => {
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want));
  } else console.log('ok  ', name);
};

// A stub that records what was written, so the rules can be proved without a network.
const stub = (row, { readFails = false, writeFails = false } = {}) => {
  const wrote = [];
  return {
    wrote,
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle: async () => ({ data: row, error: readFails ? new Error('boom') : null }),
        upsert: async (values) => { wrote.push(values); return { error: writeFails ? new Error('boom') : null }; },
      };
    },
  };
};

const now = new Date('2026-09-13T12:00:00Z');

let db = stub(null);
let r = await grantTrial(db, 'u1', now);
eq('a fresh account gets a trial', r.status, 200);
eq('for the stated number of days', r.body.days, TRIAL_DAYS);
eq('ending 14 days out', db.wrote[0].current_period_end, '2026-09-27T12:00:00.000Z');
eq('recorded as trialing', db.wrote[0].status, 'trialing');
eq('and stamped, so it can never be had twice', db.wrote[0].trial_started_at, now.toISOString());
eq('written against the caller, not anyone named in a body', db.wrote[0].user_id, 'u1');

db = stub({ status: 'canceled', trial_started_at: '2026-08-01T00:00:00Z' });
r = await grantTrial(db, 'u1', now);
eq('an expired trial cannot be had again', r.status, 409);
eq('and nothing was written', db.wrote.length, 0);

db = stub({ status: 'active', current_period_end: null });
r = await grantTrial(db, 'u1', now);
eq('a paying customer is refused a trial', r.status, 409);
eq('and nothing was written', db.wrote.length, 0);

db = stub({ status: 'trialing', trial_started_at: '2026-09-13T00:00:00Z' });
r = await grantTrial(db, 'u1', now);
eq('somebody mid-trial cannot restart it', r.status, 409);
eq('and nothing was written', db.wrote.length, 0);

db = stub(null, { readFails: true });
r = await grantTrial(db, 'u1', now);
eq('a failed read refuses rather than granting blind', r.status, 500);
eq('and writes nothing', db.wrote.length, 0);

db = stub(null, { writeFails: true });
r = await grantTrial(db, 'u1', now);
eq('a failed write is reported, not claimed as success', r.status, 500);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
