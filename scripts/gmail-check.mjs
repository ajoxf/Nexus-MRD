import { classifySubject, subjectDate, statementQuery, wantedMessages, isStatementAttachment, KINDS, WANTED, GMAIL_SCOPE, ORIENT_SENDER } from '../src/lib/gmail.js';
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
};

// Subjects copied from the mailbox, not invented, so a change at Orient's end shows up here.
const P = 'Orient Futures International (Singapore) Pte. Ltd. - ';

eq('the scope asked for is read only', GMAIL_SCOPE, 'https://www.googleapis.com/auth/gmail.readonly');
eq('this module cannot write: no modify scope anywhere', /modify|compose|send/.test(GMAIL_SCOPE), false);

eq('daily group statement',
  classifySubject(`${P}Client Group Daily Statement - 20261110`),
  { kind: KINDS.DAILY_GROUP, account: null, date: '2026-11-10' });
eq('daily per-account statement',
  classifySubject(`${P}Client Daily Statement - 0011 - 20261110`),
  { kind: KINDS.DAILY_ACCOUNT, account: '0011', date: '2026-11-10' });
eq('an account number of all zeroes is still an account',
  classifySubject(`${P}Client Daily Statement - 0000 - 20261110`).account, '0000');
eq('monthly group statement',
  classifySubject(`${P}Client Group Monthly Statement - 20261030`),
  { kind: KINDS.MONTHLY_GROUP, account: null, date: '2026-10-30' });
eq('monthly per-account statement',
  classifySubject(`${P}Client Monthly Statement - 0011 - 20261030`),
  { kind: KINDS.MONTHLY_ACCOUNT, account: '0011', date: '2026-10-30' });
eq('the GST invoice is its own kind, not a monthly statement',
  classifySubject(`${P}Client Group Monthly GST Statement - 20261030`).kind, KINDS.MONTHLY_GST);

// Orient reissues corrections. Same day, same account, different file — and it must come through,
// because rejecting it would keep the wrong figures.
eq('a reissued statement is the same day and account',
  classifySubject(`${P}Client Monthly Statement - 0000 - 20260930 version 2`),
  { kind: KINDS.MONTHLY_ACCOUNT, account: '0000', date: '2026-09-30' });

// Orient's other four senders write about other things. None of them is a statement.
eq('a market wrap is not a statement', classifySubject('Market Update: Gold Prices Retreat | Weekly Market Wrap (26 October - 1 November 2026)'), null);
eq('a portal code is not a statement', classifySubject('Your authentication code'), null);
eq('a margin notice is not a statement', classifySubject('Important Notice: Enhanced Margin Buffer Requirements Ahead of US Midterm Elections'), null);
eq('a statement with no date is not taken on trust', classifySubject(`${P}Client Group Daily Statement`), null);
eq('an impossible date is not a date', subjectDate('x - 20261341'), null);
eq('the last real date wins', subjectDate('0011 - 20261110'), '2026-11-10');

eq('the query names one sender exactly', statementQuery(), `from:${ORIENT_SENDER} has:attachment`);
eq('the sender is the statements address, not the others', ORIENT_SENDER, 'no-reply@mail.orientfutures.com.sg');
eq('since becomes Gmail\'s date form', statementQuery({ since: '2026-11-01' }), `from:${ORIENT_SENDER} has:attachment after:2026/11/01`);

eq('zips only', ['a.zip', 'b.ZIP', 'c.pdf', 'd'].map(isStatementAttachment), [true, true, false, false]);

// The day's three mails. Taking the per-account pair as well as the group file would be the same
// money twice: the group's Financial Summary already holds a row for every account in the family.
{
  const day = [
    { id: '1', subject: `${P}Client Group Daily Statement - 20261110` },
    { id: '2', subject: `${P}Client Daily Statement - 0011 - 20261110` },
    { id: '3', subject: `${P}Client Daily Statement - 0000 - 20261110` },
  ];
  eq('one of the day\'s three daily mails is taken', wantedMessages(day).map((m) => m.id), ['1']);
  eq('…and it is the group one', wantedMessages(day)[0].meta.kind, KINDS.DAILY_GROUP);
  eq('asking for the per-account ones instead is possible, and gives two',
    wantedMessages(day, { wanted: new Set([KINDS.DAILY_ACCOUNT]) }).map((m) => m.id), ['2', '3']);
}

// Month end brings four. All of them are wanted: a monthly statement is a different statement,
// not a restatement of the dailies.
{
  const monthEnd = [
    { id: 'g', subject: `${P}Client Group Monthly Statement - 20261030` },
    { id: 'a', subject: `${P}Client Monthly Statement - 0000 - 20261030` },
    { id: 'b', subject: `${P}Client Monthly Statement - 0011 - 20261030` },
    { id: 'v', subject: `${P}Client Group Monthly GST Statement - 20261030` },
  ];
  eq('all four month-end mails are taken', wantedMessages(monthEnd).map((m) => m.id).sort(), ['a', 'b', 'g', 'v']);
}

{
  const mixed = [
    { id: 'old', subject: `${P}Client Group Daily Statement - 20261001` },
    { id: 'new', subject: `${P}Client Group Daily Statement - 20261110` },
    { id: 'junk', subject: 'Market Update: anything' },
  ];
  eq('newest first', wantedMessages(mixed).map((m) => m.id), ['new', 'old']);
  eq('since narrows by the day covered', wantedMessages(mixed, { since: '2026-11-01' }).map((m) => m.id), ['new']);
  eq('nothing unrecognised slips through', wantedMessages(mixed).every((m) => m.meta), true);
  eq('an empty list is not an error', wantedMessages([]), []);
  eq('no list at all is not an error', wantedMessages(undefined), []);
}

eq('the default set takes the daily group file and every monthly one',
  [...WANTED].sort(),
  [KINDS.DAILY_GROUP, KINDS.MONTHLY_ACCOUNT, KINDS.MONTHLY_GROUP, KINDS.MONTHLY_GST].sort());

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
