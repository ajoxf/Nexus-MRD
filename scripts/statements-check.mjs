import fs from 'fs';
import { statementDate, statementAccount, kindOf, mergeStatements, openStatementZip } from '../src/lib/statements.js';
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
};

eq('date from Orient\'s zip name', statementDate('Client_Group_Daily_Statement_-_20261001.zip'), '2026-10-01');
eq('date from a file inside', statementDate('Financial Summary - 100305 - 20261001.csv'), '2026-10-01');
eq('an account number is not mistaken for a date', statementDate('Financial Summary - 12345678 - 20261001.csv'), '2026-10-01');
eq('no date is null, not a guess', statementDate('Open Position.csv'), null);
eq('an impossible date is not a date', statementDate('x - 20261341.zip'), null);
eq('account from the summary file name', statementAccount(['Open Position.csv', 'Financial Summary - 100305 - 20261001.csv']), '100305');
eq('no account named is null', statementAccount(['Open Position.csv']), null);
eq('kinds', ['a.CSV', 'b.pdf', 'c.txt'].map(kindOf), ['csv', 'pdf', 'other']);

const s = (checksum, date, zipName = `${date}.zip`) => ({ checksum, date, zipName, files: [] });
{
  const first = mergeStatements([], [s('a', '2026-10-01'), s('b', '2026-10-02')]);
  eq('newest first', first.all.map((x) => x.date), ['2026-10-02', '2026-10-01']);
  const again = mergeStatements(first.all, [s('a', '2026-10-01', 'renamed.zip'), s('c', '2026-09-30')]);
  eq('the same file twice is one statement, whatever it is called', [again.added.length, again.repeated.length, again.all.length], [1, 1, 3]);
  eq('the same file twice in one batch is one statement', mergeStatements([], [s('a', 'x'), s('a', 'x')]).all.length, 1);
}

// A fake statement (made-up figures) protected the way Orient's are: ZipCrypto, password "testpass".
const bytes = fs.readFileSync(new URL('./fixtures/fake-statement-20261001.zip', import.meta.url));
const file = new File([bytes], 'Client_Group_Daily_Statement_-_20261001.zip');
const code = async (pw) => { try { await openStatementZip(file, pw); return 'opened'; } catch (e) { return e.code; } };
eq('no password asks for one', await code(''), 'NEEDS_PASSWORD');
eq('a wrong password asks again', await code('wrong'), 'BAD_PASSWORD');
const st = await openStatementZip(file, 'testpass');
eq('the right password opens every file', st.files.map((f) => [f.name, f.kind]).sort(),
   [['Client Group Daily Statement - 20261001.pdf', 'pdf'], ['Financial Summary - 999999 - 20261001.csv', 'csv'], ['Open Position.csv', 'csv']]);
eq('CSV text comes back exactly', st.files.find((f) => f.name === 'Open Position.csv').text, 'Contract,Qty\nCL,9\n');
eq('date and account read from the names', [st.date, st.account], ['2026-10-01', '999999']);
eq('the checksum is the file\'s, so a re-upload is recognised', st.checksum, (await openStatementZip(file, 'testpass')).checksum);
const notZip = new File([Buffer.from('hello')], 'x.zip');
eq('not a zip says so', await openStatementZip(notZip, 'p').then(() => 'opened', (e) => e.code), 'NOT_A_ZIP');

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
