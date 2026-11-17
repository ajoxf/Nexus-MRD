import { buildBackup, readBackup, backupSummary, restorePlan, rowsToCsv, backupName, readmeText, BACKUP_VERSION } from '../src/lib/backup.js';
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
};

const fill = (ref, over = {}) => ({ id: 'row-' + ref, user_id: 'me', created_at: 't', broker: 'orient', ref, ts: '2026-10-02T11:03:36Z', product: 'CL Dec26', side: 'B', qty: 1, price: 87.75, fee: -0.35, ...over });
const stmt = (checksum, over = {}) => ({ checksum, zip_name: `Client Group Daily Statement - ${checksum}.zip`, statement_date: '2026-10-02', account: '100305', files: [{ name: 'Financial Summary.csv', text: 'a,b\n1,2' }], ...over });
const settings = { brokers: [{ id: 'orient', name: 'Orient' }], limits: { maxTrades: 10 }, cash: [] };

/* --------------------------------------------------------------------
 * What goes in, and what deliberately does not
 * ------------------------------------------------------------------ */
{
  const b = buildBackup({ settings, fills: [fill('A')], statements: [stmt('x1')], now: new Date('2026-11-17T09:00:00Z') });
  eq('it says what it is', b.format, 'nexus-ramp-backup');
  eq('it says when it was taken', b.takenAt, '2026-11-17T09:00:00.000Z');
  eq('the counts are written down, not just implied', b.counts, { fills: 1, statements: 1, settings: 1 });
  eq('the account\'s own row id is not carried', b.fills[0].id, undefined);
  eq('nor its user id — a backup restores into a NEW account too', b.fills[0].user_id, undefined);
  eq('nor the row\'s insert time', b.fills[0].created_at, undefined);
  eq('but the fill itself is whole', [b.fills[0].broker, b.fills[0].ref, b.fills[0].price], ['orient', 'A', 87.75]);
  eq('the statement keeps its checksum, which is its identity', b.statements[0].checksum, 'x1');
  eq('and the CSV text inside it', b.statements[0].files[0].text, 'a,b\n1,2');
  eq('settings are carried whole', b.settings.brokers[0].id, 'orient');
}

// Nothing in a backup should be a password. The statement passwords are never stored at
// all; this guards against a future field quietly carrying one in.
{
  const b = buildBackup({ settings, fills: [fill('A')], statements: [stmt('x1')] });
  eq('no password anywhere in the file', /"(password|passwd|secret|token|api[_-]?key)"/i.test(JSON.stringify(b)), false);
}

/* --------------------------------------------------------------------
 * Reading it back
 * ------------------------------------------------------------------ */
{
  const b = buildBackup({ settings, fills: [fill('A'), fill('B')], statements: [stmt('x1')] });
  const { backup, problems } = readBackup(JSON.stringify(b));
  eq('a backup reads back cleanly', problems, []);
  eq('with everything still in it', [backup.fills.length, backup.statements.length, !!backup.settings], [2, 1, true]);
}
eq('a file that is not JSON is refused', readBackup('not json at all').backup, null);
eq('…and says so readably', /isn't readable as a backup/.test(readBackup('not json').problems[0]), true);
eq('some other JSON file is refused', readBackup('{"hello":"world"}').backup, null);
eq('…by the missing marker', /isn't a RAMP backup/.test(readBackup('{"hello":"world"}').problems[0]), true);
eq('an empty file is refused', readBackup('').backup, null);

// A newer backup in an older RAMP: refuse, and say what to do.
{
  const b = { ...buildBackup({ fills: [], statements: [] }), version: BACKUP_VERSION + 1 };
  const r = readBackup(JSON.stringify(b));
  eq('a backup from a newer RAMP is not guessed at', r.backup, null);
  eq('…and the message says to update first', /newer version of RAMP/.test(r.problems[0]), true);
}

// A truncated file is the dangerous case: it reads as valid JSON and restores as though whole.
{
  const b = buildBackup({ settings, fills: [fill('A'), fill('B'), fill('C')], statements: [] });
  b.fills.pop();
  const r = readBackup(JSON.stringify(b));
  eq('a truncated backup is caught by its own counts', r.backup, null);
  eq('…and nothing is restored from it', /looks incomplete, so nothing has been restored/.test(r.problems[0]), true);
}
{
  const b = buildBackup({ settings, fills: [], statements: [stmt('x1'), stmt('x2')] });
  b.statements.pop();
  eq('the same for statements', readBackup(JSON.stringify(b)).backup, null);
}
{
  const b = buildBackup({ fills: [], statements: [] });
  delete b.fills;
  eq('a backup missing a whole section is refused', readBackup(JSON.stringify(b)).backup, null);
}

/* --------------------------------------------------------------------
 * What a restore would do — counted the way the database counts
 * ------------------------------------------------------------------ */
{
  const b = readBackup(JSON.stringify(buildBackup({ settings, fills: [fill('A'), fill('B')], statements: [stmt('x1'), stmt('x2')] }))).backup;

  const intoEmpty = restorePlan(b, { fills: [], statements: [], settings: null });
  eq('into an empty account, everything is new', [intoEmpty.newFills, intoEmpty.newStatements], [2, 2]);
  eq('and there is something to do', intoEmpty.nothingToDo, false);

  // A fill is the same fill on (broker, ref) — the database's own unique key — so a
  // different row id, or a changed price, is still the same fill and is NOT re-added.
  const same = restorePlan(b, { fills: [fill('A', { id: 'different', price: 99 }), fill('B')], statements: [stmt('x1'), stmt('x2')], settings });
  eq('restoring the same backup twice adds nothing', [same.newFills, same.newStatements], [0, 0]);
  eq('…and says so', same.nothingToDo, true);
  eq('…and the figures match what is already held', [same.sameFills, same.sameStatements], [2, 2]);

  // The case that matters: an OLD backup restored over newer work must not threaten it.
  const newer = restorePlan(b, { fills: [fill('A'), fill('B'), fill('Z')], statements: [stmt('x1'), stmt('x2'), stmt('x9')], settings });
  eq('an old backup adds nothing to newer work', [newer.newFills, newer.newStatements], [0, 0]);

  const partial = restorePlan(b, { fills: [fill('A')], statements: [], settings: null });
  eq('only what is missing is counted as new', [partial.newFills, partial.newStatements], [1, 2]);
  eq('…and what is already here is counted too', partial.sameFills, 1);
}

// Settings replace rather than merge, so whether they differ is reported before the act.
{
  const b = readBackup(JSON.stringify(buildBackup({ settings, fills: [], statements: [] }))).backup;
  eq('identical settings are not flagged as a change', restorePlan(b, { settings }).settingsDiffer, false);
  eq('different settings are flagged', restorePlan(b, { settings: { brokers: [] } }).settingsDiffer, true);
  eq('no settings here at all is a change', restorePlan(b, { settings: null }).settingsDiffer, true);
  const none = readBackup(JSON.stringify(buildBackup({ settings: null, fills: [], statements: [] }))).backup;
  eq('a backup without settings never claims one', restorePlan(none, { settings }).hasSettings, false);
  eq('…and is not flagged as a settings change', restorePlan(none, { settings }).settingsDiffer, false);
}

/* --------------------------------------------------------------------
 * The summary, the readable copies and the file name
 * ------------------------------------------------------------------ */
{
  const b = readBackup(JSON.stringify(buildBackup({
    settings,
    fills: [fill('A', { ts: '2026-08-14T10:00:00Z' }), fill('B', { ts: '2026-11-10T10:00:00Z', broker: 'mt5' })],
    statements: [stmt('x1', { statement_date: '2026-08-14' }), stmt('x2', { statement_date: '2026-11-10' })],
    now: new Date('2026-11-17T09:00:00Z'),
  }))).backup;
  const s = backupSummary(b);
  eq('the summary counts', [s.fills, s.statements, s.settings], [2, 2, true]);
  eq('the statement range', s.statementDates, { from: '2026-08-14', to: '2026-11-10' });
  eq('the fill range', s.fillDates, { from: '2026-08-14', to: '2026-11-10' });
  eq('and the brokers in it', s.brokers, ['mt5', 'orient']);
  eq('the README says how to restore', /Restore from backup/.test(readmeText(s)), true);
  eq('…and warns not to unzip first', /do not unzip it first/i.test(readmeText(s)), true);
  eq('…and is honest that the original zips are not in there', /not in here/.test(readmeText(s)), true);
}
eq('an empty account still makes a valid backup', readBackup(JSON.stringify(buildBackup({}))).problems, []);
eq('…with nothing in it', backupSummary(readBackup(JSON.stringify(buildBackup({}))).backup).fills, 0);

eq('the file name sorts by date', backupName(new Date('2026-11-17T09:00:00Z')), 'nexus-backup-2026-11-17.zip');
eq('a label is made safe for a file name', backupName(new Date('2026-11-17T09:00:00Z'), 'before wipe'), 'nexus-backup-2026-11-17-before-wipe.zip');

// The readable CSV is for a human; it must survive a comma or a quote in a product name.
{
  const csv = rowsToCsv([{ a: 'CL Dec26, Jan27', b: 'say "hi"' }, { a: 1, b: null }]);
  eq('commas and quotes are escaped', csv, 'a,b\n"CL Dec26, Jan27","say ""hi"""\n1,');
  eq('no rows is an empty file, not a crash', rowsToCsv([]), '');
}

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
