import { dayKey, endOfDay, addDays, snapshotRows, mergeSnapshot, joinDay, reconstructionDays, buildSeries, valueOf }
  from '../src/lib/history.js';
let fail = 0;
const eq = (name, got, want) => {
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (!ok) { fail++; console.log('FAIL', name, '\n  got ', JSON.stringify(got), '\n  want', JSON.stringify(want)); }
  else console.log('ok  ', name);
};

eq('dayKey pads', dayKey(new Date(2026, 2, 3, 9, 5)), '2026-03-03');
eq('endOfDay is the last instant', endOfDay('2026-03-03').getHours()*100+endOfDay('2026-03-03').getMinutes(), 2359);
eq('addDays crosses a month', addDays('2026-02-27', 3), '2026-03-02');
eq('addDays goes back over a year', addDays('2026-01-02', -3), '2025-12-30');

const pf = { accounts: [
  { id: 'orient', TNE: 606970.4, IM: 18900, rows: [{ lots: 3 }, { lots: 6 }, { lots: -3 }] },
  { id: 'mt5',    TNE: 150000,   IM: 0,     rows: [] },
]};
const rows = snapshotRows(pf, new Date(2026, 8, 12));
eq('snapshot rounds and sums absolute lots', rows,
   [{ d: '2026-09-12', b: 'orient', tne: 606970, im: 18900, lots: 12 },
    { d: '2026-09-12', b: 'mt5',    tne: 150000, im: 0,     lots: 0 }]);

// The loop guard: an unchanged day must come back as the very same array.
const h1 = mergeSnapshot([], rows);
eq('first merge stores both rows', h1.length, 2);
const h2 = mergeSnapshot(h1, rows);
eq('unchanged day returns the SAME array (no re-save loop)', h2 === h1, true);
const moved = rows.map(r => r.b === 'orient' ? { ...r, tne: 600000 } : r);
const h3 = mergeSnapshot(h1, moved);
eq('a changed figure does write', h3 === h1, false);
eq('today is replaced, not appended', h3.length, 2);
eq('replaced value', h3.find(r => r.b === 'orient').tne, 600000);

const older = [{ d: '2026-09-10', b: 'orient', tne: 1, im: 1, lots: 1 }];
const h4 = mergeSnapshot(older, rows);
eq('older days are kept', h4.length, 3);
eq('history stays in date order', h4.map(r => r.d), ['2026-09-10', '2026-09-12', '2026-09-12']);
eq('joinDay is the earliest recorded day', joinDay(h4), '2026-09-10');
const aged = [{ d: '2020-01-01', b: 'orient', tne: 1, im: 1, lots: 1 }];
eq('rows past the keep window are dropped', mergeSnapshot(aged, rows).length, 2);

const fills = [
  { ts: '2026-09-01T10:00:00Z', is_leg: false },
  { ts: '2026-09-04T10:00:00Z', is_leg: false },
  { ts: '2026-09-02T10:00:00Z', is_leg: true },   // a spread leg is not a trade
];
eq('reconstruction runs first fill → day before the record starts',
   reconstructionDays(fills, [{ d: '2026-09-04', b: 'a', tne: 0, im: 0, lots: 0 }], '2026-09-06'),
   ['2026-09-01', '2026-09-02', '2026-09-03']);
eq('with nothing recorded it runs to today',
   reconstructionDays(fills, [], '2026-09-03'), ['2026-09-01', '2026-09-02', '2026-09-03']);
eq('no fills, no reconstruction', reconstructionDays([], [], '2026-09-03'), []);
eq('record already covers everything', reconstructionDays(fills, [{ d: '2026-09-01', b: 'a' }], '2026-09-06'), []);

// 400 days of span, capped at 180 points, must still end exactly on the last day.
const long = [{ ts: new Date(2025, 0, 1).toISOString(), is_leg: false }];
const days = reconstructionDays(long, [], '2026-02-04', 180);
eq('long span is capped', days.length <= 181, true);
eq('and still ends on the last day', days[days.length - 1], '2026-02-04');
eq('and still starts on the first', days[0], '2025-01-01');

const built = buildSeries({
  reconstructed: [{ d: '2026-09-01', byBroker: { orient: { tne: 100, im: 50, lots: 2 } } }],
  history: [{ d: '2026-09-02', b: 'orient', tne: 120, im: 60, lots: 3 }],
  brokers: [{ id: 'orient', name: 'Orient' }, { id: 'mt5', name: 'MT5' }],
});
eq('both halves land on one axis', built.days, ['2026-09-01', '2026-09-02']);
eq('the join is the first recorded day', built.join, '2026-09-02');
eq('rebuilt points are flagged', built.lines[0].points.map(p => p.recorded), [false, true]);
eq('an account with no data draws nothing', built.lines[1].points.length, 0);
eq('ratio is derived, not stored', valueOf({ tne: 120, im: 60 }, 'ratio'), 2);
eq('a flat account has no ratio at all', valueOf({ tne: 120, im: 0 }, 'ratio'), null);

console.log(fail ? `\n${fail} FAILED` : '\nall passed');
process.exit(fail ? 1 : 0);
