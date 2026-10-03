import fs from 'fs';
import { statementDate, statementAccount, kindOf, mergeStatements, openStatementZip, filesFromEntries, toStored, fromStored } from '../src/lib/statements.js';
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

// A folder per day, dropped as one parent folder. The directory reader hands entries back in
// batches and then an empty one; every batch has to be read.
{
  const file = (name) => ({ isFile: true, file: (ok) => ok({ name }) });
  const dir = (kids, batch = 2) => ({ isDirectory: true, createReader: () => { let i = 0; return { readEntries: (ok) => { ok(kids.slice(i, i + batch)); i += batch; } }; } });
  const days = Array.from({ length: 45 }, (_, k) => dir([file(`Client_Group_Daily_Statement_-_202608${String(k).padStart(2, '0')}.zip`), file('notes.txt')]));
  const got = await filesFromEntries([dir(days, 7), file('loose.zip')]);
  eq('45 day-folders inside one folder: every zip found', got.filter((f) => f.name.endsWith('.zip')).length, 46);
  eq('...other files are returned too, for the caller to pass over', got.length, 91);
}

// ---------- Kept between visits ----------
// What is saved is the CSVs' text; a saved statement must read back as the same statement.
{
  const opened = {
    zipName: 'Client Daily Statement - 0011 - 20260819.zip', date: '2026-08-19', account: '0011', checksum: 'abc123',
    files: [
      { name: 'Financial Summary - 0011 - 20260819.csv', kind: 'csv', text: 'Acct No.,CCY\n1003050011,Base:USD' },
      { name: 'Open Position.csv', kind: 'csv', text: 'SettlementDate\n20260819' },
      { name: 'Client Daily Statement - 0011 - 20260819.pdf', kind: 'pdf', blob: { size: 1 } },
    ],
  };
  const row = toStored(opened);
  eq('only the CSVs are kept, as text', row.files.map((f) => f.name), ['Financial Summary - 0011 - 20260819.csv', 'Open Position.csv']);
  eq('no PDF content goes to the database', JSON.stringify(row).includes('blob'), false);
  eq('the row carries the checksum that stops a zip being kept twice', [row.checksum, row.zip_name, row.statement_date, row.account], ['abc123', opened.zipName, '2026-08-19', '0011']);
  const back = fromStored(row);
  eq('a kept statement reads back as the same statement, CSVs and all',
     [back.zipName, back.date, back.account, back.checksum, back.files.map((f) => [f.name, f.kind, f.text])],
     [opened.zipName, opened.date, opened.account, opened.checksum, opened.files.filter((f) => f.kind === 'csv').map((f) => [f.name, f.kind, f.text])]);
  eq('…and is marked as kept, so the page can say its PDFs are not here', back.stored, true);
  const { all, added, repeated } = mergeStatements([back], [opened]);
  eq('opening a zip that is already kept adds nothing', [all.length, added.length, repeated.length], [1, 0, 1]);
  eq('a statement with no date in its name keeps none', toStored({ ...opened, date: null }).statement_date, null);
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
